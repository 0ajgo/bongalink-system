/* =====================================================================
   routes/orders.js
   Powers: the "Proceed to Checkout" button on homepage.html, and the
   "Place order" button on checkout.html (Frontend/Pages/COpage).
   Backing tables: orders, order_items, delivery_addresses, deliveries,
   consent_records.
   Runs as a transaction: stores the delivery address, creates the
   order + order_items, decrements product stock, records consent,
   opens a delivery record, and clears the cart — all or nothing.
   ===================================================================== */

const express = require("express");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Mirrors Frontend/JS/cart.js SHIPPING_ZONES — kept server-side too so
// the total is computed from a trusted fee, not whatever the client sent.
const SHIPPING_FEES = {
  NCR: 120,
  LUZON: 180,
  VISAYAS: 250,
  MINDANAO: 280,
  ISLAND_PROVINCE: 340
};

/* ---------------------------------------------------------------------
   POST /api/orders — checkout the current user's cart
   Body: { contact: { email, phone }, recipient: { firstName, lastName },
           address: { street, barangay, city, province, postalCode,
                      landmark, shippingZone },
           payment: { method }, consent: { marketing, policyVersion } }
   --------------------------------------------------------------------- */
router.post("/", requireAuth, async (req, res) => {
  const { contact, recipient, address, payment, consent } = req.body || {};

  if (!contact?.email || !contact?.phone || !recipient?.firstName || !recipient?.lastName ||
      !address?.street || !address?.barangay || !address?.city || !address?.postalCode) {
    return res.status(400).json({ error: "Please complete all required checkout fields." });
  }

  const shippingFee = SHIPPING_FEES[address.shippingZone];
  if (shippingFee === undefined) {
    return res.status(400).json({ error: "Choose a delivery region so shipping can be calculated." });
  }

  const paymentMethod = payment?.method === "GCASH" ? "GCASH" : "BANK_TRANSFER";
  const recipientName = `${recipient.firstName} ${recipient.lastName}`.trim();

  const connection = await pool.getConnection();

  try {
    // Tags the stock decrements below in ml_events (see migrations/003_ml_sync.sql).
    await connection.query("SET @app_user_id = ?", [req.user.userId]);
    await connection.beginTransaction();

    // --- Step 1: find the user's cart row -------------------------------
    const [cartRows] = await connection.query("SELECT cart_id FROM carts WHERE user_id = ?", [req.user.userId]);
    if (cartRows.length === 0) {
      await connection.rollback();
      return res.status(400).json({ error: "Your cart is empty." });
    }
    const cartId = cartRows[0].cart_id;

    // --- Step 2: lock the cart's line items for the rest of this
    // transaction. FOR UPDATE takes a row lock on the matching products
    // too, so a second checkout racing this one can't read the same
    // stock_quantity and oversell the same last unit.
    const [items] = await connection.query(
      `SELECT ci.product_id, ci.quantity, p.price, p.stock_quantity, p.is_active
       FROM cart_items ci
       JOIN products p ON p.product_id = ci.product_id
       WHERE ci.cart_id = ? FOR UPDATE`,
      [cartId]
    );

    if (items.length === 0) {
      await connection.rollback();
      return res.status(400).json({ error: "Your cart is empty." });
    }

    // --- Step 3: re-validate stock right before committing the order.
    // The cart could have been sitting untouched for a while, and
    // someone else may have bought the last units in the meantime.
    for (const item of items) {
      if (!item.is_active) {
        await connection.rollback();
        return res.status(409).json({ error: "A product in your cart is no longer available. Please review your cart." });
      }
      if (item.quantity > item.stock_quantity) {
        await connection.rollback();
        return res.status(409).json({ error: "Some items no longer have enough stock. Please review your cart." });
      }
    }

    const subtotal = items.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0);
    const totalAmount = subtotal + shippingFee;

    // --- Step 4: save the delivery address as its own row. Every order
    // gets a fresh row here rather than reusing a previous one — there's
    // no "saved addresses" picker in the UI yet, so this is always new.
    const [addressResult] = await connection.query(
      `INSERT INTO delivery_addresses
        (user_id, recipient_name, recipient_phone, street, barangay, city, province, postal_code, landmark, shipping_zone)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.userId, recipientName, contact.phone, address.street, address.barangay,
        address.city, address.province || null, address.postalCode, address.landmark || null,
        address.shippingZone
      ]
    );
    const addressId = addressResult.insertId;

    // --- Step 5: create the order header, pointing at that address.
    const [orderResult] = await connection.query(
      `INSERT INTO orders (user_id, address_id, contact_email, status, total_amount, payment_method, shipping_fee)
       VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      [req.user.userId, addressId, contact.email, totalAmount, paymentMethod, shippingFee]
    );
    const orderId = orderResult.insertId;

    // --- Step 6: snapshot each cart line into order_items (so later
    // price changes on the product don't rewrite history) and decrement
    // the live stock count by the same amount.
    for (const item of items) {
      await connection.query(
        "INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)",
        [orderId, item.product_id, item.quantity, item.price]
      );
      await connection.query(
        "UPDATE products SET stock_quantity = stock_quantity - ? WHERE product_id = ?",
        [item.quantity, item.product_id]
      );
    }

    // --- Step 7: the order is placed, so empty the cart it came from.
    await connection.query("DELETE FROM cart_items WHERE cart_id = ?", [cartId]);

    // --- Step 8: log consent. Processing consent is always granted here
    // (the form's required checkbox already blocked submission if it
    // wasn't ticked); marketing consent records whichever way the
    // optional checkbox was left.
    const policyVersion = consent?.policyVersion || "unspecified";
    await connection.query(
      `INSERT INTO consent_records (user_id, consent_type, granted, policy_version, source)
       VALUES (?, 'ORDER_PROCESSING', 1, ?, 'checkout')`,
      [req.user.userId, policyVersion]
    );
    await connection.query(
      `INSERT INTO consent_records (user_id, consent_type, granted, policy_version, source)
       VALUES (?, 'MARKETING', ?, ?, 'checkout')`,
      [req.user.userId, consent?.marketing ? 1 : 0, policyVersion]
    );

    // --- Step 9: open a shell delivery record for this order. Courier
    // and tracking number stay NULL until someone (an admin dashboard,
    // not yet built) actually dispatches it.
    await connection.query("INSERT INTO deliveries (order_id, status) VALUES (?, 'PENDING')", [orderId]);

    // --- Step 10: everything above succeeded — make it permanent.
    // If anything from Step 1 onward threw, the catch block below
    // rolls all of it back instead, so an order is never half-written.
    await connection.commit();
    res.status(201).json({ orderId, totalAmount, message: "Order placed." });
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).json({ error: "Checkout failed." });
  } finally {
    await connection.query("SET @app_user_id = NULL").catch(() => {});
    connection.release();
  }
});

/* ---------------------------------------------------------------------
   GET /api/orders — this user's order history
   --------------------------------------------------------------------- */
router.get("/", requireAuth, async (req, res) => {
  const [orders] = await pool.query(
    "SELECT order_id, status, total_amount, created_at FROM orders WHERE user_id = ? ORDER BY created_at DESC",
    [req.user.userId]
  );
  res.json(orders);
});

module.exports = router;
