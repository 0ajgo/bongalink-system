/* =====================================================================
   routes/ml.js
   Powers: the admin inventory dashboard (Pages/Admin/inventory.html).
   Backing tables: ml_predictions, ml_status, ml_model_versions,
   ml_events (written by the Python worker in ml/worker and by the
   product triggers), plus products/orders/order_items for history.

   These routes never call the ML worker, so a slow or stopped worker
   can't block the dashboard or product CRUD. They show whatever the
   worker last wrote, and how fresh it is. The one write is queueing a
   retrain (POST /training), which the worker picks up on its next poll.
   ===================================================================== */

const express = require("express");
const pool = require("../db");
const { logError } = require("../lib/pii");
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
    logError("Forecasts request failed", err);
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
              p.reserved, p.stock_quantity - LEAST(p.reserved, p.stock_quantity) AS available, p.weight_kg,
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
    logError("Forecasts request failed", err);
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
    logError("Forecasts request failed", err);
    res.status(500).json({ error: "Could not load products." });
  }
});

/* ---------------------------------------------------------------------
   GET /api/admin/ml/dashboard?days=30 — read-only numbers for the admin
   Dashboard page (Pages/Admin/dashboard.html):
     stock        active products, low (1..LOW_STOCK available) and out
                  of stock, using AVAILABLE stock (on hand - reserved)
     month        sales this calendar month: orders, units, item revenue
     trend        item revenue + units per day for the last `days` days
                  (oldest first, zero-filled, today excluded like /history)
     top_products best sellers by units over the same window
   Sales = orders in SOLD_STATUSES, the same definition the forecasts use.
   --------------------------------------------------------------------- */
const LOW_STOCK = 3;   // same threshold as the storefront's "Low stock" badge (Frontend/JS/ui.js)

const dayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

router.get("/dashboard", async (req, res) => {
  try {
    const days = [30, 90, 180].includes(Number(req.query.days)) ? Number(req.query.days) : 30;

    const [[stock]] = await pool.query(
      `SELECT COUNT(*) AS active_products,
              SUM(available = 0) AS out_of_stock,
              SUM(available BETWEEN 1 AND ?) AS low_stock
       FROM (SELECT stock_quantity - LEAST(reserved, stock_quantity) AS available
             FROM products WHERE is_active = 1) p`,
      [LOW_STOCK]
    );

    const [[month]] = await pool.query(
      `SELECT COUNT(DISTINCT o.order_id) AS orders,
              COALESCE(SUM(oi.quantity), 0) AS units,
              COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS revenue
       FROM orders o JOIN order_items oi ON oi.order_id = o.order_id
       WHERE o.status IN (?) AND o.created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`,
      [SOLD_STATUSES]
    );

    const [daily] = await pool.query(
      `SELECT DATE_FORMAT(DATE(o.created_at), '%Y-%m-%d') AS day,
              SUM(oi.quantity) AS units, SUM(oi.quantity * oi.unit_price) AS revenue
       FROM orders o JOIN order_items oi ON oi.order_id = o.order_id
       WHERE o.status IN (?) AND o.created_at >= CURDATE() - INTERVAL ? DAY AND o.created_at < CURDATE()
       GROUP BY day`,
      [SOLD_STATUSES, days]
    );
    const byDay = new Map(daily.map(r => [r.day, r]));
    const trend = [];
    const today = new Date();
    for (let i = days; i >= 1; i--) {
      const key = dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i));
      const r = byDay.get(key);
      trend.push({ day: key, units: r ? Number(r.units) : 0, revenue: r ? Number(r.revenue) : 0 });
    }

    const [top] = await pool.query(
      `SELECT p.product_id, p.name, c.name AS category,
              SUM(oi.quantity) AS units, SUM(oi.quantity * oi.unit_price) AS revenue
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.order_id
       JOIN products p ON p.product_id = oi.product_id
       JOIN categories c ON c.category_id = p.category_id
       WHERE o.status IN (?) AND o.created_at >= CURDATE() - INTERVAL ? DAY AND o.created_at < CURDATE()
       GROUP BY p.product_id, p.name, c.name
       ORDER BY units DESC, revenue DESC
       LIMIT 5`,
      [SOLD_STATUSES, days]
    );

    res.json({
      days,
      low_stock_threshold: LOW_STOCK,
      stock: {
        active_products: Number(stock.active_products),
        low_stock: Number(stock.low_stock) || 0,
        out_of_stock: Number(stock.out_of_stock) || 0
      },
      month: { orders: Number(month.orders), units: Number(month.units), revenue: Number(month.revenue) },
      trend,
      top_products: top.map(t => ({ ...t, units: Number(t.units), revenue: Number(t.revenue) }))
    });
  } catch (err) {
    logError("Forecasts request failed", err);
    res.status(500).json({ error: "Could not load the dashboard." });
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
    logError("Forecasts request failed", err);
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
    logError("Forecasts request failed", err);
    res.status(500).json({ error: "Could not load change log." });
  }
});

/* ---------------------------------------------------------------------
   RETRAINING (REQ028) — the "Update forecasts & trends" button.
   The API never trains: it queues a run in ml_training_runs and the ML
   worker (ml/worker) picks it up on its next poll, trains, and records
   the result there. The worker also starts runs on its own: nightly, and
   when enough new paid orders or stock changes have come in.
   Only one run at a time: while a run is queued or training, the
   database's unique key on active_slot refuses another one.
   --------------------------------------------------------------------- */

// A queued/training run whose worker has been silent this long is treated as dead.
const STALE_RUN_SECONDS = 10 * 60;

const runRow = (r) => r && ({
  run_id: r.run_id, trigger_type: r.trigger_type, trigger_detail: r.trigger_detail,
  requested_by: r.requested_by_label, status: r.status, outcome: r.outcome, model_version: r.model_version,
  sales_records: r.sales_records, orders_used: r.orders_used, products_used: r.products_used,
  train_rows: r.train_rows, val_rows: r.val_rows, data_from: r.data_from, data_to: r.data_to,
  val_mae: r.val_mae, baseline_val_mae: r.baseline_val_mae, naive_val_mae: r.naive_val_mae,
  message: r.message, queued_at: r.queued_at, started_at: r.started_at, finished_at: r.finished_at,
});

async function workerHeartbeatAge(conn = pool) {
  const [[s]] = await conn.query("SELECT TIMESTAMPDIFF(SECOND, heartbeat_at, NOW()) AS age FROM ml_status WHERE id = 1");
  return s?.age ?? null;
}

// GET /api/admin/ml/training — the current run, recent runs, model accuracy, automatic triggers.
router.get("/training", async (req, res) => {
  try {
    const [[current]] = await pool.query("SELECT * FROM ml_training_runs WHERE active_slot = 1");
    const [runs] = await pool.query("SELECT * FROM ml_training_runs ORDER BY run_id DESC LIMIT 10");
    const [[lastDone]] = await pool.query(
      "SELECT * FROM ml_training_runs WHERE status = 'done' AND outcome IN ('promoted','rejected') ORDER BY run_id DESC LIMIT 1");
    const [[status]] = await pool.query(
      `SELECT last_train_at, last_train_status, last_train_message, auto_retrain_hour, auto_retrain_orders,
              auto_retrain_stock_changes, sold_orders_at_last_train, event_id_at_last_train FROM ml_status WHERE id = 1`);
    const [[model]] = await pool.query(
      `SELECT version, trained_with, trained_at, train_rows, val_rows, val_mae, baseline_val_mae
         FROM ml_model_versions WHERE status = 'active' ORDER BY version_id DESC LIMIT 1`);
    const [[orders]] = await pool.query("SELECT COUNT(*) AS n FROM orders WHERE status IN (?)", [SOLD_STATUSES]);
    const [[changes]] = await pool.query(
      "SELECT COUNT(*) AS n FROM ml_events WHERE event_type = 'STOCK_CHANGED' AND event_id > ?", [status?.event_id_at_last_train || 0]);
    const age = await workerHeartbeatAge();

    res.json({
      current: runRow(current) || null,
      runs: runs.map(runRow),
      last_completed: runRow(lastDone) || null,
      last_trained_at: status?.last_train_at || null,
      last_result: status?.last_train_status ? { status: status.last_train_status, message: status.last_train_message } : null,
      model: model || null,
      worker_online: age !== null && age <= WORKER_TIMEOUT_SECONDS,
      auto: {
        nightly_hour: status?.auto_retrain_hour ?? null,
        new_orders: { threshold: status?.auto_retrain_orders ?? null, since_last: Math.max(orders.n - (status?.sold_orders_at_last_train || 0), 0) },
        stock_changes: { threshold: status?.auto_retrain_stock_changes ?? null, since_last: changes.n },
      },
    });
  } catch (err) {
    logError("Forecasts request failed", err);
    res.status(500).json({ error: "Could not load the training status." });
  }
});

// POST /api/admin/ml/training — queue a retrain (the button). 202 with the run; 409 if one is running.
// Requests to queue a retrain run one at a time (a named lock), so two admins clicking at
// the same moment get one run and one "already queued", never a database deadlock.
const QUEUE_LOCK = "bongalink_ml_retrain";

router.post("/training", async (req, res) => {
  const conn = await pool.getConnection();
  let locked = false;
  try {
    const [[{ ok }]] = await conn.query("SELECT GET_LOCK(?, 10) AS ok", [QUEUE_LOCK]);
    if (ok !== 1) return res.status(503).json({ error: "Busy, please try again." });
    locked = true;
    await conn.beginTransaction();
    const [[active]] = await conn.query("SELECT * FROM ml_training_runs WHERE active_slot = 1 FOR UPDATE");
    if (active) {
      const age = await workerHeartbeatAge(conn);
      const workerGone = age === null || age > STALE_RUN_SECONDS;
      if (!workerGone) {
        await conn.rollback();
        const who = active.requested_by_label ? `by ${active.requested_by_label}` : `automatically (${active.trigger_detail || active.trigger_type})`;
        return res.status(409).json({
          error: `A retrain is already ${active.status === "queued" ? "queued" : "running"}, started ${who}. Wait for it to finish.`,
          code: "RETRAIN_IN_PROGRESS", run: runRow(active),
        });
      }
      // Its worker has been silent for a long time: free the slot so training can be requested again.
      await conn.query(
        `UPDATE ml_training_runs SET status = 'failed', outcome = 'failed', finished_at = NOW(3),
                message = 'The ML worker stopped before finishing this run. The model in use was kept.'
          WHERE run_id = ?`, [active.run_id]);
    }
    const [r] = await conn.query(
      `INSERT INTO ml_training_runs (trigger_type, trigger_detail, requested_by, requested_by_label)
       VALUES ('manual', 'Update forecasts & trends button', ?, ?)`, [req.user.userId, req.user.username]);
    await conn.query(
      `INSERT INTO admin_audit_log (admin_id, admin_label, action, target_user_id, target_label, new_value)
       VALUES (?, ?, 'ml_retrain', NULL, 'Stock forecasts', ?)`,
      [req.user.userId, req.user.username, JSON.stringify({ run_id: r.insertId })]);
    await conn.commit();
    const [[run]] = await pool.query("SELECT * FROM ml_training_runs WHERE run_id = ?", [r.insertId]);
    const age = await workerHeartbeatAge();
    res.status(202).json({ run: runRow(run), worker_online: age !== null && age <= WORKER_TIMEOUT_SECONDS });
  } catch (err) {
    await conn.rollback().catch(() => {});
    if (err.code === "ER_DUP_ENTRY") {   // another admin queued one at the same moment
      return res.status(409).json({ error: "A retrain was just started. Wait for it to finish.", code: "RETRAIN_IN_PROGRESS" });
    }
    logError("Queueing a retrain failed", err);
    res.status(500).json({ error: "Could not start the update." });
  } finally {
    if (locked) await conn.query("DO RELEASE_LOCK(?)", [QUEUE_LOCK]).catch(() => {});
    conn.release();
  }
});

module.exports = router;
