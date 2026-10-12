/* =====================================================================
   routes/ml.js
   Powers: the admin inventory dashboard (Pages/Admin/inventory.html).
   Backing tables: ml_predictions, ml_status, ml_model_versions,
   ml_events (written by the Python worker in ml/worker and by the
   product triggers), plus products/orders/order_items for history.

   Read-only: these routes never call the ML worker, so a slow or
   stopped worker can't block the dashboard or product CRUD. They just
   show whatever the worker last wrote, and how fresh it is.
   ===================================================================== */

const express = require("express");
const pool = require("../db");
const { requireAdmin } = require("../middleware/auth");

const router = express.Router();
router.use(requireAdmin);

// Same definition of a sale the worker uses (ml/worker/bongalink_ml/db.py).
const SOLD_STATUSES = ["processing", "completed", "paid", "packed", "shipped", "delivered"];

// The worker updates heartbeat_at every poll; older than this = not running.
const WORKER_TIMEOUT_SECONDS = 120;

/* ---------------------------------------------------------------------
   GET /api/admin/ml/status — banner: last model update + state
   --------------------------------------------------------------------- */
router.get("/status", async (req, res) => {
  try {
    const [[status]] = await pool.query(
      `SELECT state, last_update_at, last_error, last_train_at, last_train_status,
              last_train_message, heartbeat_at,
              TIMESTAMPDIFF(SECOND, heartbeat_at, NOW()) AS heartbeat_age_seconds
       FROM ml_status WHERE id = 1`
    );
    const [[pending]] = await pool.query("SELECT COUNT(*) AS pending_events FROM ml_events WHERE processed = 0");
    const [[model]] = await pool.query(
      `SELECT version, trained_with, data_source, val_mae, trained_at
       FROM ml_model_versions WHERE status = 'active' ORDER BY version_id DESC LIMIT 1`
    );

    const workerOnline = status?.heartbeat_age_seconds !== null && status?.heartbeat_age_seconds !== undefined &&
      status.heartbeat_age_seconds <= WORKER_TIMEOUT_SECONDS;

    res.json({
      ...(status || { state: "updating" }),
      pending_events: pending.pending_events,
      worker_online: workerOnline,
      active_model: model || null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load model status." });
  }
});

/* ---------------------------------------------------------------------
   GET /api/admin/ml/predictions — one row per ACTIVE product. Products
   the worker hasn't scored yet come back with prediction fields null.
   --------------------------------------------------------------------- */
router.get("/predictions", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.product_id, p.name, c.name AS category, p.price, p.stock_quantity,
              mp.predicted_demand_7d, mp.avg_daily_demand, mp.days_until_stockout,
              mp.reorder_recommended, mp.suggested_reorder_qty, mp.forecast_source,
              mp.data_status, mp.history_days, mp.trend_status, mp.trend_direction,
              mp.trend_relative_change, mp.trend_days_since_breakpoint,
              mp.model_version, mp.computed_at,
              mp.current_stock AS predicted_for_stock
       FROM products p
       JOIN categories c ON c.category_id = p.category_id
       LEFT JOIN ml_predictions mp ON mp.product_id = p.product_id
       WHERE p.is_active = 1
       ORDER BY mp.reorder_recommended DESC,
                mp.days_until_stockout IS NULL, mp.days_until_stockout,
                p.name`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load predictions." });
  }
});

/* ---------------------------------------------------------------------
   GET /api/admin/ml/products — every product INCLUDING removed ones,
   for the history chart picker (removed products keep their history).
   --------------------------------------------------------------------- */
router.get("/products", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.product_id, p.name, c.name AS category, p.is_active
       FROM products p JOIN categories c ON c.category_id = p.category_id
       ORDER BY p.is_active DESC, p.name`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load products." });
  }
});

/* ---------------------------------------------------------------------
   GET /api/admin/ml/history/:id?days=84 — units sold per day (oldest
   first, zero-filled), for active and removed products alike.
   --------------------------------------------------------------------- */
router.get("/history/:id", async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 84, 7), 365);

    const [[product]] = await pool.query(
      "SELECT product_id, name, is_active FROM products WHERE product_id = ?",
      [req.params.id]
    );
    if (!product) {
      return res.status(404).json({ error: "Product not found." });
    }

    const [rows] = await pool.query(
      `SELECT DATE_FORMAT(DATE(o.created_at), '%Y-%m-%d') AS day, CAST(SUM(oi.quantity) AS SIGNED) AS units
       FROM order_items oi
       JOIN orders o ON o.order_id = oi.order_id
       WHERE oi.product_id = ?
         AND o.status IN (?)
         AND o.created_at >= CURDATE() - INTERVAL ? DAY
         AND o.created_at < CURDATE()
       GROUP BY day`,
      [req.params.id, SOLD_STATUSES, days]
    );

    const byDay = new Map(rows.map(r => [r.day, Number(r.units)]));
    const series = [];
    const today = new Date();
    for (let i = days; i >= 1; i--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      series.push({ day: key, units: byDay.get(key) || 0 });
    }

    res.json({ product, days, series });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load sales history." });
  }
});

/* ---------------------------------------------------------------------
   GET /api/admin/ml/events?limit=25 — recent audit-trail entries
   --------------------------------------------------------------------- */
router.get("/events", async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 200);
    const [rows] = await pool.query(
      `SELECT e.event_id, e.product_id, p.name AS product_name, e.event_type, e.old_value,
              e.new_value, u.username AS changed_by, e.created_at, e.processed, e.processed_at
       FROM ml_events e
       LEFT JOIN products p ON p.product_id = e.product_id
       LEFT JOIN users u ON u.user_id = e.changed_by
       ORDER BY e.event_id DESC
       LIMIT ?`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load change log." });
  }
});

module.exports = router;
