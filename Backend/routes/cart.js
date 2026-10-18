/* =====================================================================
   routes/cart.js
   Powers: the "Shopping Cart" sidebar on homepage.html.
   Backing tables: carts, cart_items
   All routes require login (requireAuth) — the cart is per-user.

   Quantities are whole numbers from 1 to MAX_QUANTITY, and a cart line
   never holds more than the product's AVAILABLE stock (on hand minus what
   unpaid orders hold). Anything else is a 400 and the cart is unchanged.
   Checkout checks the stock again (routes/orders.js), since it can change
   while the part sits in the cart.
   ===================================================================== */

const express = require("express");
const pool = require("../db");
const ah = require("../lib/asyncHandler");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const MAX_QUANTITY = 999;

// Ensures a cart row exists for this user, returns its cart_id
async function getOrCreateCartId(userId) {
  const [rows] = await pool.query("SELECT cart_id FROM carts WHERE user_id = ?", [userId]);
  if (rows.length > 0) return rows[0].cart_id;

  const [result] = await pool.query("INSERT INTO carts (user_id) VALUES (?)", [userId]);
  return result.insertId;
}

// A JSON number or a string of digits: 2 or "2", never 0, -1, 1.5, "2abc", 1e9 or true.
// -> { quantity } or { error }
function parseQuantity(raw) {
  const ok = (typeof raw === "number" && Number.isInteger(raw)) || (typeof raw === "string" && /^\d+$/.test(raw.trim()));
  const quantity = ok ? Number(raw) : NaN;
  if (!(quantity >= 1 && quantity <= MAX_QUANTITY)) {
    return { error: `Quantity must be a whole number from 1 to ${MAX_QUANTITY}.` };
  }
  return { quantity };
}

const parseProductId = (raw) => (/^\d{1,10}$/.test(String(raw ?? "").trim()) ? Number(raw) : null);

const moreThanAvailable = (available, inCart) => ({
  error: `Only ${available} available${inCart ? ` (you already have ${inCart} in your cart)` : ""}.`,
  available
});

// Runs work(conn, cartId) in a transaction, with the product checked first.
// -> { status, body }
async function withCartLine(userId, productId, work) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[product]] = await conn.query(
      `SELECT stock_quantity - LEAST(reserved, stock_quantity) AS available
         FROM products WHERE product_id = ? AND is_active = 1`, [productId]);
    if (!product) { await conn.rollback(); return { status: 404, body: { error: "Product not found." } }; }
    // Units held by unpaid orders (products.reserved) can't go into another cart.
    if (product.available <= 0) { await conn.rollback(); return { status: 400, body: { error: "This product is out of stock." } }; }
    // Locks this user's cart row (made if it's missing), so two quick adds run one after
    // the other and can't both pass the stock check.
    await conn.query("INSERT INTO carts (user_id) VALUES (?) ON DUPLICATE KEY UPDATE user_id = user_id", [userId]);
    const [[{ cart_id: cartId }]] = await conn.query("SELECT cart_id FROM carts WHERE user_id = ? FOR UPDATE", [userId]);
    // A locking read sees the other request's committed line (a plain read would use this
    // transaction's older snapshot).
    const [[line]] = await conn.query(
      "SELECT quantity FROM cart_items WHERE cart_id = ? AND product_id = ? FOR UPDATE", [cartId, productId]);
    const result = await work(conn, cartId, Number(product.available), line ? line.quantity : 0);
    await (result.status < 400 ? conn.commit() : conn.rollback());
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/* ---------------------------------------------------------------------
   GET /api/cart — this user's cart lines, joined with product info
   --------------------------------------------------------------------- */
router.get("/", requireAuth, ah(async (req, res) => {
  const cartId = await getOrCreateCartId(req.user.userId);

  const [rows] = await pool.query(
    `SELECT ci.product_id AS id, ci.quantity, p.name, p.price,
            p.image_path AS image, p.stock_quantity - LEAST(p.reserved, p.stock_quantity) AS stock
     FROM cart_items ci
     JOIN products p ON p.product_id = ci.product_id
     WHERE ci.cart_id = ?`,
    [cartId]
  );

  res.json(rows);
}));

/* ---------------------------------------------------------------------
   POST /api/cart — add a product to the cart (on top of what's there)
   Body: { productId, quantity }  -- quantity defaults to 1
   --------------------------------------------------------------------- */
router.post("/", requireAuth, ah(async (req, res) => {
  const productId = parseProductId(req.body?.productId);
  if (!productId) return res.status(400).json({ error: "productId is required." });
  const { quantity, error } = req.body?.quantity === undefined ? { quantity: 1 } : parseQuantity(req.body.quantity);
  if (error) return res.status(400).json({ error });

  const { status, body } = await withCartLine(req.user.userId, productId, async (conn, cartId, available, inCart) => {
    if (inCart + quantity > available) return { status: 400, body: moreThanAvailable(available, inCart) };
    await conn.query(
      `INSERT INTO cart_items (cart_id, product_id, quantity) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity)`,
      [cartId, productId, quantity]);
    return { status: 200, body: { message: "Product added to cart.", quantity: inCart + quantity } };
  });
  res.status(status).json(body);
}));

/* ---------------------------------------------------------------------
   PUT /api/cart/:productId — set the quantity of a line (adds it if new)
   Body: { quantity }  -- 1 or more; DELETE removes the line
   --------------------------------------------------------------------- */
router.put("/:productId", requireAuth, ah(async (req, res) => {
  const productId = parseProductId(req.params.productId);
  if (!productId) return res.status(400).json({ error: "productId is required." });
  const { quantity, error } = parseQuantity(req.body?.quantity);
  if (error) return res.status(400).json({ error });

  const { status, body } = await withCartLine(req.user.userId, productId, async (conn, cartId, available) => {
    if (quantity > available) return { status: 400, body: moreThanAvailable(available) };
    await conn.query(
      `INSERT INTO cart_items (cart_id, product_id, quantity) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE quantity = VALUES(quantity)`,
      [cartId, productId, quantity]);
    return { status: 200, body: { message: "Cart updated.", quantity } };
  });
  res.status(status).json(body);
}));

/* ---------------------------------------------------------------------
   DELETE /api/cart/:productId — remove a line item
   --------------------------------------------------------------------- */
router.delete("/:productId", requireAuth, ah(async (req, res) => {
  const cartId = await getOrCreateCartId(req.user.userId);
  await pool.query(
    "DELETE FROM cart_items WHERE cart_id = ? AND product_id = ?",
    [cartId, req.params.productId]
  );
  res.json({ message: "Removed from cart." });
}));

module.exports = router;
module.exports.MAX_QUANTITY = MAX_QUANTITY;
