/* =====================================================================
   routes/categories.js
   Powers: the category dropdown in "List a Product" and the sidebar
   category list on homepage.html.
   Backing table: categories
   ===================================================================== */

const express = require("express");
const pool = require("../db");
const { requireAdmin } = require("../middleware/auth");

const router = express.Router();

// GET /api/categories — public, used to populate the dropdown/sidebar
router.get("/", async (req, res) => {
  const [rows] = await pool.query("SELECT category_id, name FROM categories ORDER BY name");
  res.json(rows);
});

// POST /api/categories — admin only, in case new categories are needed later
router.post("/", requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Category name is required." });
  }

  try {
    const [result] = await pool.query("INSERT INTO categories (name) VALUES (?)", [name.trim()]);
    res.status(201).json({ categoryId: result.insertId, name: name.trim() });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "That category already exists." });
    }
    console.error(err);
    res.status(500).json({ error: "Failed to create category." });
  }
});

module.exports = router;
