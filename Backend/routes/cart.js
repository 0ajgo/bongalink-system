/* =====================================================================
   routes/cart.js
   Powers: the "Shopping Cart" sidebar on homepage.html.
   Backing tables: carts, cart_items
   All routes require login (requireAuth) — the cart is per-user.
   ===================================================================== */

const express = require("express");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// Ensures a cart row exists for this user, returns its cart_id
async function getOrCreateCartId(userId) {
  const [rows] = await pool.query("SELECT cart_id FROM carts WHERE user_id = ?", [userId]);
  if (rows.length > 0) return rows[0].cart_id;

  const [result] = await pool.query("INSERT INTO carts (user_id) VALUES (?)", [userId]);
  return result.insertId;
}

/* ---------------------------------------------------------------------
   GET /api/cart — this user's cart lines, joined with product info
   --------------------------------------------------------------------- */
router.get("/", requireAuth, async (req, res) => {
  const cartId = await getOrCreateCartId(req.user.userId);

  const [rows] = await pool.query(
    `SELECT ci.product_id AS id, ci.quantity, p.name, p.price,
            p.image_path AS image, p.stock_quantity AS stock
     FROM cart_items ci
     JOIN products p ON p.product_id = ci.product_id
     WHERE ci.cart_id = ?`,
    [cartId]
  );

  res.json(rows);
});

/* ---------------------------------------------------------------------
   POST /api/cart — add (or increment) a product in the cart
   Body: { productId, quantity }  -- quantity defaults to 1
   --------------------------------------------------------------------- */
router.post("/", requireAuth, async (req, res) => {
  const { productId } = req.body;
  const quantity = Number(req.body.quantity) || 1;

  if (!productId) return res.status(400).json({ error: "productId is required." });

  const [productRows] = await pool.query(
    "SELECT stock_quantity FROM products WHERE product_id = ? AND is_active = 1", [productId]
  );
  if (productRows.length === 0) return res.status(404).json({ error: "Product not found." });
  if (productRows[0].stock_quantity <= 0) {
    return res.status(400).json({ error: "This product is out of stock." });
  }

  const cartId = await getOrCreateCartId(req.user.userId);

  await pool.query(
    `INSERT INTO cart_items (cart_id, product_id, quantity)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE quantity = LEAST(quantity + VALUES(quantity), ?)`,
    [cartId, productId, quantity, productRows[0].stock_quantity]
  );

  res.json({ message: "Product added to cart." });
});

/* ---------------------------------------------------------------------
   DELETE /api/cart/:productId — remove a line item
   --------------------------------------------------------------------- */
router.delete("/:productId", requireAuth, async (req, res) => {
  const cartId = await getOrCreateCartId(req.user.userId);
  await pool.query(
    "DELETE FROM cart_items WHERE cart_id = ? AND product_id = ?",
    [cartId, req.params.productId]
  );
  res.json({ message: "Removed from cart." });
});

module.exports = router;
