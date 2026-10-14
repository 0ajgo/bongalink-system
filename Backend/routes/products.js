/* =====================================================================
   routes/products.js
   Backing table: products (this IS the inventory table), plus
   product_images (gallery) and product_changes (history, migration 005).

   Public:
     GET    /api/products                 catalog (stock = available)
     GET    /api/products/:id             product page; hidden products are 404
   Admin (requireAdmin):
     GET    /api/products/:id/admin       everything the edit form needs
     GET    /api/products/:id/history     who changed what, when, old -> new
     POST   /api/products                 create (multipart: optional "image")
     PATCH  /api/products/:id             edit details / hide / restore (JSON)
     POST   /api/products/:id/stock       adjust stock with a reason
     POST   /api/products/:id/image       replace the cover photo (multipart)
     POST   /api/products/:id/images      add a gallery photo (multipart)
     DELETE /api/products/:id/images/:imageId
     DELETE /api/products/:id             hide (soft delete)

   Removing a product is a soft delete (is_active = 0): order_items and
   the sales history keep pointing at a real row. Every change to product
   data is recorded by database triggers: ml_events for the ML worker
   (003) and product_changes for the history (005). Writes run on a
   connection with @app_user_id (and @app_change_reason for stock
   adjustments) set, so the triggers know who did it and why.

   Images are saved to /uploads (served by server.js) and checked by their
   actual bytes: JPEG, PNG, WebP or GIF up to 5 MB. SVG is not accepted
   (it can carry scripts).
   ===================================================================== */

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const pool = require("../db");
const { requireAdmin } = require("../middleware/auth");

const router = express.Router();

/* ---------------------------------------------------------------------
   Image uploads
   --------------------------------------------------------------------- */
// UPLOAD_DIR is overridable so tests can use a temporary folder.
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads");
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_GALLERY = 8;
const IMAGE_TYPES = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    // Random name + an extension from the allowed type, never from the uploader's file name.
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${IMAGE_TYPES[file.mimetype] || ""}`)
  }),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!IMAGE_TYPES[file.mimetype]) {
      return cb(Object.assign(new Error("Photos must be JPEG, PNG, WebP or GIF."), { status: 400 }));
    }
    cb(null, true);
  }
});

// What the file really is, from its first bytes (the browser's type can lie).
function sniffImageType(file) {
  const fd = fs.openSync(file, "r");
  const b = Buffer.alloc(12);
  fs.readSync(fd, b, 0, 12, 0);
  fs.closeSync(fd);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.slice(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (b.slice(0, 4).toString("ascii") === "RIFF" && b.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

// multer for one optional field, with friendly errors and a content check.
function photoUpload(field) {
  return (req, res, next) => {
    upload.single(field)(req, res, (err) => {
      if (err) {
        const message = err.code === "LIMIT_FILE_SIZE" ? "Photos must be 5 MB or smaller."
          : err.code === "LIMIT_UNEXPECTED_FILE" || err.code === "LIMIT_FILE_COUNT" ? "Upload one photo at a time."
          : err.message;
        return res.status(400).json({ error: message });
      }
      if (req.file && sniffImageType(req.file.path) !== req.file.mimetype) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: "That file isn't a valid JPEG, PNG, WebP or GIF image." });
      }
      next();
    });
  };
}

const discardUpload = (req) => { if (req.file) fs.unlink(req.file.path, () => {}); };
const uploadedPath = (req) => `/uploads/${req.file.filename}`;

/* ---------------------------------------------------------------------
   Runs fn(connection) on a dedicated connection with @app_user_id (and
   optionally @app_change_reason) set, so the triggers record who made
   the change and why. Cleared before the connection goes back to the pool.
   --------------------------------------------------------------------- */
async function asUser(userId, fn, reason = null) {
  const connection = await pool.getConnection();
  try {
    await connection.query("SET @app_user_id = ?, @app_change_reason = ?", [userId, reason]);
    return await fn(connection);
  } finally {
    await connection.query("SET @app_user_id = NULL, @app_change_reason = NULL").catch(() => {});
    connection.release();
  }
}

async function inTransaction(connection, work) {
  await connection.beginTransaction();
  try {
    const result = await work();
    await connection.commit();
    return result;
  } catch (err) {
    await connection.rollback();
    throw err;
  }
}

/* ---------------------------------------------------------------------
   Validation shared by create and edit. Returns { values } (column -> value)
   or { error }. `partial` = only validate the fields that were sent.
   --------------------------------------------------------------------- */
async function readProductFields(body, { partial }) {
  const values = {};
  const has = (k) => body[k] !== undefined;
  const text = (v) => (v === null || v === undefined ? "" : String(v).trim());

  if (!partial || has("name")) {
    const name = text(body.name);
    if (!name) return { error: "Product name is required." };
    if (name.length > 150) return { error: "Product name must be 150 characters or fewer." };
    values.name = name;
  }
  if (has("brand")) {
    const brand = text(body.brand);
    if (brand.length > 100) return { error: "Brand must be 100 characters or fewer." };
    values.brand = brand || null;
  }
  if (has("description")) {
    const description = text(body.description);
    if (description.length > 5000) return { error: "Description must be 5,000 characters or fewer." };
    values.description = description || null;
  }
  if (!partial || has("category")) {
    const [[cat]] = await pool.query("SELECT category_id FROM categories WHERE name = ?", [text(body.category)]);
    if (!cat) return { error: "Choose a category." };
    values.category_id = cat.category_id;
  }
  if (!partial || has("price")) {
    const price = Number(body.price);
    if (text(body.price) === "" || !Number.isFinite(price) || price <= 0 || price > 10000000) {
      return { error: "Price must be more than ₱0." };
    }
    values.price = Math.round(price * 100) / 100;
  }
  if (has("weight_kg") || !partial) {
    const raw = has("weight_kg") && text(body.weight_kg) !== "" ? body.weight_kg : (partial ? undefined : 0.5);
    const weight = Number(raw);
    if (!(weight > 0 && weight <= 999)) return { error: "Weight must be more than 0 and at most 999 kg." };
    values.weight_kg = Math.round(weight * 1000) / 1000;
  }
  if (has("is_active")) {
    if (![true, false, 1, 0, "1", "0", "true", "false"].includes(body.is_active)) return { error: "Choose shown or hidden." };
    values.is_active = [true, 1, "1", "true"].includes(body.is_active) ? 1 : 0;
  }
  return { values };
}

/* ---------------------------------------------------------------------
   GET /api/products?category=Accessories&search=epson — public catalog.
   `stock` is AVAILABLE stock: on hand minus units reserved by unpaid
   orders (anti ghost stock). 0 means out of stock.
   --------------------------------------------------------------------- */
router.get("/", async (req, res) => {
  const { category, search } = req.query;

  let sql = `
    SELECT p.product_id AS id, p.name, c.name AS category, p.brand,
           p.price, p.stock_quantity - LEAST(p.reserved, p.stock_quantity) AS stock,
           p.image_path AS image,
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

async function productImages(productId) {
  const [rows] = await pool.query(
    "SELECT image_id, image_path FROM product_images WHERE product_id = ? ORDER BY sort_order, image_id", [productId]);
  return rows;
}

/* ---------------------------------------------------------------------
   GET /api/products/:id — public product page. Hidden products are 404.
   images: the cover first, then gallery photos.
   --------------------------------------------------------------------- */
router.get("/:id(\\d+)", async (req, res) => {
  try {
    const [[p]] = await pool.query(
      `SELECT p.product_id AS id, p.name, c.name AS category, p.brand, p.price,
              p.stock_quantity - LEAST(p.reserved, p.stock_quantity) AS stock,
              p.image_path AS image, p.description, p.weight_kg, p.created_at
       FROM products p JOIN categories c ON c.category_id = p.category_id
       WHERE p.product_id = ? AND p.is_active = 1`,
      [req.params.id]
    );
    if (!p) return res.status(404).json({ error: "Product not found." });
    const gallery = (await productImages(p.id)).map(i => i.image_path);
    res.json({ ...p, images: [p.image, ...gallery].filter(Boolean) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the product." });
  }
});

/* ---------------------------------------------------------------------
   GET /api/products/:id/admin — the edit form: hidden products too,
   with on-hand, reserved and available stock.
   --------------------------------------------------------------------- */
router.get("/:id(\\d+)/admin", requireAdmin, async (req, res) => {
  try {
    const [[p]] = await pool.query(
      `SELECT p.product_id AS id, p.name, c.name AS category, p.brand, p.price, p.description, p.weight_kg,
              p.image_path AS image, p.is_active, p.stock_quantity, p.reserved,
              p.stock_quantity - LEAST(p.reserved, p.stock_quantity) AS available, p.created_at, p.updated_at
       FROM products p JOIN categories c ON c.category_id = p.category_id WHERE p.product_id = ?`,
      [req.params.id]
    );
    if (!p) return res.status(404).json({ error: "Product not found." });
    res.json({ ...p, is_active: Boolean(p.is_active), gallery: await productImages(p.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the product." });
  }
});

/* ---------------------------------------------------------------------
   GET /api/products/:id/history — product_changes, newest first.
   --------------------------------------------------------------------- */
router.get("/:id(\\d+)/history", requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT h.change_id, h.field, h.old_value, h.new_value, h.reason, h.changed_at,
              COALESCE(u.username, 'system') AS changed_by
       FROM product_changes h LEFT JOIN users u ON u.user_id = h.changed_by
       WHERE h.product_id = ? ORDER BY h.changed_at DESC, h.change_id DESC LIMIT 200`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the history." });
  }
});

/* ---------------------------------------------------------------------
   POST /api/products — create. multipart/form-data: name, category,
   brand?, price, stock, description?, weight_kg?, image?
   --------------------------------------------------------------------- */
router.post("/", requireAdmin, photoUpload("image"), async (req, res) => {
  try {
    const { values, error } = await readProductFields(req.body, { partial: false });
    const stock = Number(req.body.stock);
    const stockError = String(req.body.stock ?? "").trim() === "" || !Number.isInteger(stock) || stock < 0 || stock > 1000000
      ? "Stock must be a whole number of 0 or more." : null;
    if (error || stockError) {
      discardUpload(req);
      return res.status(400).json({ error: error || stockError });
    }

    const [result] = await asUser(req.user.userId, connection => connection.query(
      `INSERT INTO products
        (name, category_id, brand, price, stock_quantity, weight_kg, image_path, description, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [values.name, values.category_id, values.brand ?? null, values.price, stock, values.weight_kg,
       req.file ? uploadedPath(req) : null, values.description ?? null, req.user.userId]
    ));
    res.status(201).json({ productId: result.insertId, message: "Product successfully added." });
  } catch (err) {
    discardUpload(req);
    console.error(err);
    res.status(500).json({ error: "Failed to add product." });
  }
});

/* ---------------------------------------------------------------------
   PATCH /api/products/:id — JSON, every field optional:
   { name, brand, description, category, price, weight_kg, is_active }
   Stock is NOT edited here: use POST /:id/stock, which needs a reason.
   Works on hidden products too (to edit or restore them).
   --------------------------------------------------------------------- */
router.patch("/:id(\\d+)", requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    if (body.stock !== undefined || body.stock_quantity !== undefined) {
      return res.status(400).json({ error: "Change stock with Adjust stock, which records a reason." });
    }
    const { values, error } = await readProductFields(body, { partial: true });
    if (error) return res.status(400).json({ error });
    const cols = Object.keys(values);   // only column names from readProductFields()
    if (!cols.length) return res.status(400).json({ error: "Nothing to update." });

    const found = await asUser(req.user.userId, connection => inTransaction(connection, async () => {
      const [[row]] = await connection.query("SELECT product_id FROM products WHERE product_id = ? FOR UPDATE", [req.params.id]);
      if (!row) return false;
      await connection.query(`UPDATE products SET ${cols.map(c => `${c} = ?`).join(", ")} WHERE product_id = ?`,
        [...Object.values(values), req.params.id]);
      // Hidden products can't be bought: take them out of carts, like DELETE does.
      if (values.is_active === 0) await connection.query("DELETE FROM cart_items WHERE product_id = ?", [req.params.id]);
      return true;
    }));
    if (!found) return res.status(404).json({ error: "Product not found." });
    res.json({ message: "Product updated." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update product." });
  }
});

/* ---------------------------------------------------------------------
   POST /api/products/:id/stock — { change, reason, note? }
   change is the number of units added (+) or removed (-).
   restock and return add stock, damaged removes it, correction is either.
   On-hand stock can never drop below what unpaid orders have reserved.
   Writes an inventory_movements row; the triggers log the stock change
   to product_changes (with the reason) and ml_events.
   --------------------------------------------------------------------- */
const STOCK_REASONS = { restock: 1, return: 1, damaged: -1, correction: 0 };

router.post("/:id(\\d+)/stock", requireAdmin, async (req, res) => {
  try {
    const { change: rawChange, reason, note } = req.body || {};
    const change = Number(rawChange);
    if (!(reason in STOCK_REASONS)) {
      return res.status(400).json({ error: "Choose a reason: restock, damaged, correction or return." });
    }
    if (!Number.isInteger(change) || change === 0 || Math.abs(change) > 1000000) {
      return res.status(400).json({ error: "Enter how many units to add or remove (a whole number, not 0)." });
    }
    const sign = STOCK_REASONS[reason];
    if (sign !== 0 && Math.sign(change) !== sign) {
      return res.status(400).json({ error: sign > 0 ? `A ${reason} adds stock: enter a positive number.` : "Damaged stock is removed: enter a negative number." });
    }
    const cleanNote = String(note ?? "").trim().slice(0, 255) || null;

    const result = await asUser(req.user.userId, connection => inTransaction(connection, async () => {
      const [[p]] = await connection.query(
        "SELECT stock_quantity, reserved FROM products WHERE product_id = ? FOR UPDATE", [req.params.id]);
      if (!p) return { status: 404, body: { error: "Product not found." } };
      const next = p.stock_quantity + change;
      if (next < p.reserved) {
        const removable = Math.max(p.stock_quantity - p.reserved, 0);
        return { status: 409, body: {
          error: `You can remove at most ${removable} unit${removable === 1 ? "" : "s"}: ${p.reserved} ${p.reserved === 1 ? "is" : "are"} held by unpaid orders.` } };
      }
      await connection.query("UPDATE products SET stock_quantity = ? WHERE product_id = ?", [next, req.params.id]);
      await connection.query(
        `INSERT INTO inventory_movements (product_id, change_qty, reason, reference, note, created_by)
         VALUES (?, ?, ?, 'adjustment', ?, ?)`,
        [req.params.id, change, reason, cleanNote, req.user.userId]);
      return { status: 200, body: { stock_quantity: next, reserved: p.reserved, available: next - p.reserved } };
    }), cleanNote ? `${reason}: ${cleanNote}` : reason);

    res.status(result.status).json(result.body);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to adjust stock." });
  }
});

/* ---------------------------------------------------------------------
   Photos: replace the cover, add / remove gallery photos.
   Old files stay on disk: the history still points at them.
   --------------------------------------------------------------------- */
router.post("/:id(\\d+)/image", requireAdmin, photoUpload("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Choose a photo to upload." });
  try {
    const [result] = await asUser(req.user.userId, connection =>
      connection.query("UPDATE products SET image_path = ? WHERE product_id = ?", [uploadedPath(req), req.params.id]));
    if (!result.affectedRows) {
      discardUpload(req);
      return res.status(404).json({ error: "Product not found." });
    }
    res.json({ image: uploadedPath(req) });
  } catch (err) {
    discardUpload(req);
    console.error(err);
    res.status(500).json({ error: "Failed to save the photo." });
  }
});

router.post("/:id(\\d+)/images", requireAdmin, photoUpload("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Choose a photo to upload." });
  try {
    const result = await asUser(req.user.userId, connection => inTransaction(connection, async () => {
      const [[p]] = await connection.query("SELECT product_id FROM products WHERE product_id = ? FOR UPDATE", [req.params.id]);
      if (!p) return { status: 404, body: { error: "Product not found." } };
      const [[{ n }]] = await connection.query("SELECT COUNT(*) AS n FROM product_images WHERE product_id = ?", [req.params.id]);
      if (n >= MAX_GALLERY) return { status: 400, body: { error: `A product can have up to ${MAX_GALLERY} extra photos.` } };
      const [r] = await connection.query(
        "INSERT INTO product_images (product_id, image_path, sort_order) VALUES (?, ?, ?)", [req.params.id, uploadedPath(req), n]);
      return { status: 201, body: { image_id: r.insertId, image_path: uploadedPath(req) } };
    }));
    if (result.status !== 201) discardUpload(req);
    res.status(result.status).json(result.body);
  } catch (err) {
    discardUpload(req);
    console.error(err);
    res.status(500).json({ error: "Failed to save the photo." });
  }
});

router.delete("/:id(\\d+)/images/:imageId(\\d+)", requireAdmin, async (req, res) => {
  try {
    const [result] = await asUser(req.user.userId, connection =>
      connection.query("DELETE FROM product_images WHERE image_id = ? AND product_id = ?", [req.params.imageId, req.params.id]));
    if (!result.affectedRows) return res.status(404).json({ error: "Photo not found." });
    res.json({ message: "Photo removed." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to remove the photo." });
  }
});

/* ---------------------------------------------------------------------
   DELETE /api/products/:id — hide (soft delete): out of the catalog,
   carts and new predictions, but kept for order history and trends.
   Restore it from the edit form (PATCH is_active).
   --------------------------------------------------------------------- */
router.delete("/:id(\\d+)", requireAdmin, async (req, res) => {
  try {
    const removed = await asUser(req.user.userId, connection => inTransaction(connection, async () => {
      const [result] = await connection.query(
        "UPDATE products SET is_active = 0 WHERE product_id = ? AND is_active = 1", [req.params.id]);
      if (result.affectedRows > 0) {
        await connection.query("DELETE FROM cart_items WHERE product_id = ?", [req.params.id]);
      }
      return result.affectedRows > 0;
    }));
    if (!removed) return res.status(404).json({ error: "Product not found." });
    res.json({ message: "Product deleted." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete product." });
  }
});

module.exports = router;
