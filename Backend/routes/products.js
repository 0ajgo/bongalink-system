/* =====================================================================
   routes/products.js
   Powers: the product grid + search/filter on homepage.html, and the
   admin "List a Product" / delete (×) actions.
   Backing table: products (this IS the inventory table)

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
    WHERE 1=1
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
   DELETE /api/products/:id — admin only
   --------------------------------------------------------------------- */
router.delete("/:id", requireAdmin, async (req, res) => {
  const [result] = await pool.query("DELETE FROM products WHERE product_id = ?", [req.params.id]);
  if (result.affectedRows === 0) {
    return res.status(404).json({ error: "Product not found." });
  }
  res.json({ message: "Product deleted." });
});

module.exports = router;
