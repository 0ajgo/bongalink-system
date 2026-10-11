/* =====================================================================
   routes/products.js
   Powers: the product grid + search/filter on homepage.html, the
   admin "List a Product" / delete (×) actions, and the stock/price
   edits on the admin inventory page (Pages/Admin/inventory.html).
   Backing table: products (this IS the inventory table)

   Removing a product is a soft delete (is_active = 0): order_items
   and the sales history the ML trends are built from keep pointing at
   a real row. Every add/remove/stock/price change is written to
   ml_events by database triggers (migrations/003_ml_sync.sql); the
   ML worker picks those up on its own, so nothing here waits on it.

   Images: uploaded files are saved to /uploads and served statically
   from server.js as /uploads/<filename>. The DB stores image_path as
   that relative URL, not a base64 blob.
   ===================================================================== */

const express = require("express");
const multer = require("multer");
const path = require("path");
const pool = require("../db");
const { requireAdmin } = require("../middleware/auth");

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, "..", "uploads")),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed."));
    }
    cb(null, true);
  }
});

/* ---------------------------------------------------------------------
   GET /api/products?category=Accessories&search=epson
   Public — populates the catalog grid. Joins categories for the
   readable category name (matches product.category in the old
   localStorage shape, so the frontend rendering logic barely changes).
   --------------------------------------------------------------------- */
router.get("/", async (req, res) => {
  const { category, search } = req.query;

  let sql = `
    SELECT p.product_id AS id, p.name, c.name AS category, p.brand,
           p.price, p.stock_quantity AS stock, p.image_path AS image,
           p.description, p.created_by, p.created_at
    FROM products p
    JOIN categories c ON c.category_id = p.category_id
    WHERE p.is_active = 1
  `;
  const params = [];

  if (category && category !== "All") {
    sql += " AND c.name = ?";
    params.push(category);
  }
  if (search) {
    sql += " AND (p.name LIKE ? OR p.brand LIKE ? OR p.description LIKE ?)";
    const like = `%${search}%`;
    params.push(like, like, like);
  }

  sql += " ORDER BY p.created_at DESC";

  const [rows] = await pool.query(sql, params);
  res.json(rows);
});

/* ---------------------------------------------------------------------
   POST /api/products — admin only (requireAdmin checks the JWT role
   server-side; this is the real enforcement, not just a frontend
   isAdmin() check). Accepts multipart/form-data because of the image.
   --------------------------------------------------------------------- */
router.post("/", requireAdmin, upload.single("image"), async (req, res) => {
  try {
    const { name, category, brand, price, stock, description } = req.body;

    if (!name || !category || price === undefined || stock === undefined) {
      return res.status(400).json({ error: "Please complete all required fields." });
    }

    const [catRows] = await pool.query("SELECT category_id FROM categories WHERE name = ?", [category]);
    if (catRows.length === 0) {
      return res.status(400).json({ error: "Unknown category." });
    }

    const imagePath = req.file ? `/uploads/${req.file.filename}` : null;

    const [result] = await pool.query(
      `INSERT INTO products
        (name, category_id, brand, price, stock_quantity, image_path, description, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, catRows[0].category_id, brand || null, Number(price), Number(stock), imagePath, description || null, req.user.userId]
    );

    res.status(201).json({ productId: result.insertId, message: "Product successfully added." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to add product." });
  }
});

/* ---------------------------------------------------------------------
   Runs fn(connection) on a dedicated connection with @app_user_id set,
   so the ml_events triggers record which admin made the change. The
   variable is cleared before the connection goes back to the pool.
   --------------------------------------------------------------------- */
async function asUser(userId, fn) {
  const connection = await pool.getConnection();
  try {
    await connection.query("SET @app_user_id = ?", [userId]);
    return await fn(connection);
  } finally {
    await connection.query("SET @app_user_id = NULL").catch(() => {});
    connection.release();
  }
}

/* ---------------------------------------------------------------------
   PATCH /api/products/:id — admin only. JSON body, every field optional:
   { name, brand, description, category, price, stock }
   --------------------------------------------------------------------- */
const EDITABLE_TEXT = { name: "name", brand: "brand", description: "description" };

router.patch("/:id", requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const sets = [];
    const params = [];

    for (const [field, column] of Object.entries(EDITABLE_TEXT)) {
      if (body[field] === undefined) continue;
      const value = body[field] === null ? null : String(body[field]).trim();
      if (field === "name" && !value) {
        return res.status(400).json({ error: "Product name cannot be empty." });
      }
      sets.push(`${column} = ?`);
      params.push(value || null);
    }

    if (body.price !== undefined) {
      const price = Number(body.price);
      if (body.price === "" || !Number.isFinite(price) || price < 0) {
        return res.status(400).json({ error: "Price must be a number of 0 or more." });
      }
      sets.push("price = ?");
      params.push(price);
    }

    if (body.stock !== undefined) {
      const stock = Number(body.stock);
      if (body.stock === "" || !Number.isInteger(stock) || stock < 0) {
        return res.status(400).json({ error: "Stock must be a whole number of 0 or more." });
      }
      sets.push("stock_quantity = ?");
      params.push(stock);
    }

    if (body.category !== undefined) {
      const [catRows] = await pool.query("SELECT category_id FROM categories WHERE name = ?", [body.category]);
      if (catRows.length === 0) {
        return res.status(400).json({ error: "Unknown category." });
      }
      sets.push("category_id = ?");
      params.push(catRows[0].category_id);
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: "Nothing to update." });
    }

    // Column names come only from the fixed lists above; values are bound.
    const [result] = await asUser(req.user.userId, connection =>
      connection.query(
        `UPDATE products SET ${sets.join(", ")} WHERE product_id = ? AND is_active = 1`,
        [...params, req.params.id]
      )
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Product not found." });
    }
    res.json({ message: "Product updated." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update product." });
  }
});

/* ---------------------------------------------------------------------
   DELETE /api/products/:id — admin only. Soft delete: hides the product
   from the catalog, carts and new predictions, but keeps the row for
   order history and historical trend charts.
   --------------------------------------------------------------------- */
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const removed = await asUser(req.user.userId, async connection => {
      await connection.beginTransaction();
      try {
        const [result] = await connection.query(
          "UPDATE products SET is_active = 0 WHERE product_id = ? AND is_active = 1",
          [req.params.id]
        );
        if (result.affectedRows > 0) {
          await connection.query("DELETE FROM cart_items WHERE product_id = ?", [req.params.id]);
        }
        await connection.commit();
        return result.affectedRows > 0;
      } catch (err) {
        await connection.rollback();
        throw err;
      }
    });

    if (!removed) {
      return res.status(404).json({ error: "Product not found." });
    }
    res.json({ message: "Product deleted." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete product." });
  }
});

module.exports = router;
