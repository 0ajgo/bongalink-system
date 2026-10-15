/* =====================================================================
   jobs/expireOrders.js
   Orders hold stock (products.reserved) while they wait for payment.
   Every few minutes this expires orders still unpaid after 24 hours,
   gives their reserved units back and logs a 'reservation_release'
   row per product in inventory_movements.

   If the customer pays after expiry, the PayMongo webhook sees the order
   is no longer pending_payment and flags the payment for admin review.
   ===================================================================== */

const pool = require("../db");
const { logError } = require("../lib/pii");

const HOLD_HOURS = 24;
const RUN_EVERY_MS = 5 * 60 * 1000;
const BATCH_SIZE = 100;

async function expireOrder(orderId) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Re-check inside the transaction: the webhook may have just marked it paid.
    const [upd] = await connection.query(
      "UPDATE orders SET status = 'expired' WHERE order_id = ? AND status = 'pending_payment'",
      [orderId]
    );
    if (!upd.affectedRows) {
      await connection.rollback();
      return false;
    }

    const [items] = await connection.query(
      "SELECT product_id, quantity FROM order_items WHERE order_id = ? ORDER BY product_id",
      [orderId]
    );
    for (const item of items) {
      await connection.query(
        "UPDATE products SET reserved = reserved - LEAST(reserved, ?) WHERE product_id = ?",
        [item.quantity, item.product_id]
      );
      await connection.query(
        `INSERT INTO inventory_movements (product_id, change_qty, reason, reference)
         VALUES (?, ?, 'reservation_release', ?)`,
        [item.product_id, item.quantity, `order:${orderId}`]
      );
    }

    await connection.commit();
    return true;
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

// Returns how many orders were expired.
async function expireStaleOrders() {
  const [rows] = await pool.query(
    `SELECT order_id FROM orders
      WHERE status = 'pending_payment' AND created_at < NOW() - INTERVAL ? HOUR
      ORDER BY order_id LIMIT ?`,
    [HOLD_HOURS, BATCH_SIZE]
  );
  let expired = 0;
  for (const { order_id } of rows) {
    if (await expireOrder(order_id)) expired++;
  }
  return expired;
}

function startOrderExpiryJob() {
  const run = () =>
    expireStaleOrders()
      .then((n) => { if (n) console.log(`Expired ${n} unpaid order(s) and released their stock.`); })
      .catch((err) => logError("Order expiry job failed", err));
  run();
  return setInterval(run, RUN_EVERY_MS);
}

module.exports = { expireStaleOrders, startOrderExpiryJob, HOLD_HOURS };
