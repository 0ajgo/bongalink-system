/* =====================================================================
   routes/orders.js
   Powers: the "Place order" button on checkout.html (Frontend/Pages/COpage).
   Backing tables: orders, order_items, delivery_addresses, deliveries,
   consent_records, products.reserved.
   Runs as a transaction: stores the delivery address, creates the
   order + order_items, reserves product stock, records consent,
   opens a delivery record, and clears the cart — all or nothing.

   Stock is RESERVED here, not deducted. The order starts as
   'pending_payment'; the PayMongo webhook (routes/payments.js) turns
   the reservation into a real stock_quantity deduction, and
   jobs/expireOrders.js releases it if nobody pays within 24 hours.
   ===================================================================== */

const express = require("express");
const pool = require("../db");
const { requireAuth, requireVerifiedEmail } = require("../middleware/auth");
const { quoteOptions, REGIONS } = require("../services/shippingRates");
const { encryptAddress, enc, logError } = require("../lib/pii");

const router = express.Router();

const COURIERS = ["JNT", "LBC", "LALAMOVE"];

// Optional map pin: both or neither, inside the Philippines' rough bounds.
function parsePin(address) {
  if (address.lat == null && address.lng == null) return { lat: null, lng: null };
  const lat = Number(address.lat), lng = Number(address.lng);
  if (!(lat >= 4 && lat <= 22 && lng >= 116 && lng <= 127)) return null;
  return { lat, lng };
}

const sameCart = (a, b) =>
  a.length === b.length &&
  a.every((item, i) => item.product_id === b[i].product_id && item.quantity === b[i].quantity);

/* ---------------------------------------------------------------------
   POST /api/orders — checkout the current user's cart
   Body: { contact: { email, phone }, recipient: { firstName, lastName },
           address: { street, barangay, city, province, postalCode,
                      landmark, region, lat?, lng? },
           courier: "JNT" | "LBC" | "LALAMOVE", expected_shipping_fee?,
           payment: { method }, consent: { marketing, policyVersion } }
   The shipping fee is always recomputed here with quoteOptions(); any fee
   the browser sends is ignored. With a map pin, the zone comes from where the
   pin is. expected_shipping_fee is the fee the customer was shown: if the
   recomputed fee differs, the order is refused (409 SHIPPING_FEE_CHANGED).
   --------------------------------------------------------------------- */
router.post("/", requireAuth, requireVerifiedEmail, async (req, res) => {
  const { contact, recipient, address, courier, payment, consent } = req.body || {};

  if (!contact?.email || !contact?.phone || !recipient?.firstName || !recipient?.lastName ||
      !address?.street || !address?.barangay || !address?.city || !address?.postalCode) {
    return res.status(400).json({ error: "Please complete all required checkout fields." });
  }

  const region = String(address.region || "").toUpperCase().trim();
  if (!REGIONS.includes(region)) {
    return res.status(400).json({ error: "Choose a delivery region so shipping can be calculated." });
  }
  if (!COURIERS.includes(courier)) {
    return res.status(400).json({ error: "Choose a courier." });
  }
  const pin = parsePin(address);
  if (!pin) {
    return res.status(400).json({ error: "The map pin is not a valid location in the Philippines." });
  }

  const paymentMethod = payment?.method === "GCASH" ? "GCASH" : "BANK_TRANSFER";
  const recipientName = `${recipient.firstName} ${recipient.lastName}`.trim();
  const userId = req.user.userId;
  const cartItemsSql = "SELECT product_id, quantity FROM cart_items WHERE cart_id = ? ORDER BY product_id";

  // --- Step 1: read the cart and quote shipping BEFORE locking anything.
  // A Lalamove quote is a network call; it must not hold product row locks.
  let cartId, quotedItems, quote;
  try {
    const [cartRows] = await pool.query("SELECT cart_id FROM carts WHERE user_id = ?", [userId]);
    cartId = cartRows[0]?.cart_id;
    [quotedItems] = cartId ? await pool.query(cartItemsSql, [cartId]) : [[]];
    if (quotedItems.length === 0) {
      return res.status(400).json({ error: "Your cart is empty." });
    }

    quote = await quoteOptions(quotedItems, {
      region,
      province: address.province,
      city: address.city,
      line: [address.street, address.barangay, address.city, address.province].filter(Boolean).join(", "),
      lat: pin.lat,
      lng: pin.lng
    });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    logError("Checkout quote failed", err);
    return res.status(500).json({ error: "Checkout failed." });
  }

  const option = quote.options.find(o => o.courier === courier);
  if (!option) {
    return res.status(400).json({ error: "That courier isn't available for this address. Please choose another." });
  }
  const shippingFee = option.fee;

  // The fee shown at checkout must be the fee charged. If it changed since the
  // customer's quote (rate table edited, live Lalamove price moved), stop and say so.
  const expected = req.body.expected_shipping_fee;
  if (expected !== undefined && expected !== null && Math.abs(Number(expected) - shippingFee) > 0.004) {
    return res.status(409).json({
      error: `The shipping fee for this courier is now ₱${shippingFee.toFixed(2)}. Please review it and place the order again.`,
      code: "SHIPPING_FEE_CHANGED",
      shippingFee
    });
  }

  let connection;
  try {
    connection = await pool.getConnection();
  } catch (err) {
    logError("Checkout failed (no database connection)", err);
    return res.status(500).json({ error: "Checkout failed." });
  }

  try {
    // Tags stock changes in ml_events (see migrations/003_ml_sync.sql).
    await connection.query("SET @app_user_id = ?", [userId]);
    await connection.beginTransaction();

    // --- Step 2: lock the cart lines, then the product rows (in
    // product_id order so two checkouts can't deadlock). Anyone else
    // reserving the same products waits here until we commit, so the
    // last unit can't be sold twice.
    const [items] = await connection.query(cartItemsSql + " FOR UPDATE", [cartId]);
    if (!sameCart(items, quotedItems)) {
      await connection.rollback();
      return res.status(409).json({ error: "Your cart changed while checking out. Please review it and try again." });
    }

    const [products] = await connection.query(
      `SELECT product_id, price, stock_quantity, reserved, is_active
       FROM products WHERE product_id IN (?) ORDER BY product_id FOR UPDATE`,
      [items.map(i => i.product_id)]
    );
    const byId = new Map(products.map(p => [p.product_id, p]));

    // --- Step 3: available = on hand minus what unpaid orders hold.
    for (const item of items) {
      const product = byId.get(item.product_id);
      if (!product || !product.is_active) {
        await connection.rollback();
        return res.status(409).json({ error: "A product in your cart is no longer available. Please review your cart." });
      }
      if (product.stock_quantity - product.reserved < item.quantity) {
        await connection.rollback();
        return res.status(409).json({ error: "Some items no longer have enough stock. Please review your cart." });
      }
    }

    // Prices always come from the database.
    const subtotal = Math.round(
      items.reduce((sum, item) => sum + Number(byId.get(item.product_id).price) * item.quantity, 0) * 100
    ) / 100;
    const totalAmount = Math.round((subtotal + shippingFee) * 100) / 100;

    // --- Step 4: save the delivery address as its own row (personal fields encrypted).
    const e = encryptAddress({
      recipient_name: recipientName, recipient_phone: contact.phone, street: address.street, barangay: address.barangay,
      city: address.city, postal_code: address.postalCode, landmark: address.landmark || null, lat: pin.lat, lng: pin.lng
    });
    const [addressResult] = await connection.query(
      `INSERT INTO delivery_addresses
        (user_id, recipient_name, recipient_phone, street, barangay, city, province, region,
         postal_code, landmark, lat, lng, shipping_zone)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId, e.recipient_name, e.recipient_phone, e.street, e.barangay,
        e.city, (quote.location.source === "pin" ? quote.location.province : address.province) || null,
        quote.location.region, e.postal_code, e.landmark,
        e.lat, e.lng, quote.zone
      ]
    );
    const addressId = addressResult.insertId;

    // --- Step 5: create the order header, waiting for payment.
    const [orderResult] = await connection.query(
      `INSERT INTO orders
        (user_id, address_id, contact_email, status, total_amount, payment_method, shipping_fee, courier)
       VALUES (?, ?, ?, 'pending_payment', ?, ?, ?, ?)`,
      [userId, addressId, enc("orders", "contact_email", String(contact.email).trim()), totalAmount, paymentMethod, shippingFee, courier]
    );
    const orderId = orderResult.insertId;

    // --- Step 6: snapshot each line into order_items (price changes later
    // don't rewrite history) and reserve the units.
    for (const item of items) {
      await connection.query(
        "INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)",
        [orderId, item.product_id, item.quantity, byId.get(item.product_id).price]
      );
      await connection.query(
        "UPDATE products SET reserved = reserved + ? WHERE product_id = ?",
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
      [userId, policyVersion]
    );
    await connection.query(
      `INSERT INTO consent_records (user_id, consent_type, granted, policy_version, source)
       VALUES (?, 'MARKETING', ?, ?, 'checkout')`,
      [userId, consent?.marketing ? 1 : 0, policyVersion]
    );

    // --- Step 9: open the delivery record. It stays PENDING until the
    // admin books the courier (routes/logistics.js).
    await connection.query(
      "INSERT INTO deliveries (order_id, courier, status, fee_charged) VALUES (?, ?, 'PENDING', ?)",
      [orderId, courier, shippingFee]
    );

    await connection.commit();
    res.status(201).json({
      orderId, status: "pending_payment", subtotal, shippingFee, totalAmount, courier,
      message: "Order placed. Complete payment within 24 hours to keep your items."
    });
  } catch (err) {
    await connection.rollback();
    logError("Checkout failed", err);
    res.status(500).json({ error: "Checkout failed." });
  } finally {
    await connection.query("SET @app_user_id = NULL").catch(() => {});
    connection.release();
  }
});

/* ---------------------------------------------------------------------
   GET /api/orders — this user's order history, newest first, each with
   its items. Powers Pages/COpage/orders.html; the tracking timeline of a
   shipped order comes from GET /api/v1/orders/:id/tracking.
   --------------------------------------------------------------------- */
router.get("/", requireAuth, async (req, res) => {
  try {
    const [orders] = await pool.query(
      `SELECT order_id, status, total_amount, shipping_fee, courier, paid_at, created_at
       FROM orders WHERE user_id = ? ORDER BY created_at DESC, order_id DESC LIMIT 100`,
      [req.user.userId]
    );
    if (orders.length) {
      const [items] = await pool.query(
        `SELECT oi.order_id, p.name, oi.quantity, oi.unit_price
         FROM order_items oi JOIN products p ON p.product_id = oi.product_id
         WHERE oi.order_id IN (?) ORDER BY oi.order_item_id`,
        [orders.map(o => o.order_id)]
      );
      for (const order of orders) {
        order.items = items.filter(i => i.order_id === order.order_id)
          .map(({ name, quantity, unit_price }) => ({ name, quantity, unit_price }));
      }
    }
    res.json(orders);
  } catch (err) {
    logError("Loading orders failed", err);
    res.status(500).json({ error: "Could not load your orders." });
  }
});

module.exports = router;
