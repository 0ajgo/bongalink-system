/* =====================================================================
   services/notifications.js — the admin notification bell
   (REQ020 instant alert, REQ021 product monitoring). Migration 012.

   Each event is one admin_notifications row, shared by every admin; who
   has read what is per admin (admin_notification_reads, plus
   users.notifications_read_through for "Mark all as read").

   The helpers below are called where the event already happens, with the
   same connection, so inside that flow's transaction when it has one (a
   rolled-back payment leaves no "New sale"). Writing a notification must
   never break the order, payment or shipping flow: every helper catches
   its own errors, logs them and carries on.

   The text never holds the personal data migration 009 encrypts (emails,
   addresses, phone numbers): only order numbers, product names, amounts,
   couriers, waybill numbers and usernames.

   Live delivery: routes/notifications.js streams new rows to connected
   admins (Server-Sent Events). The hub checks the table for rows newer
   than each stream has seen: at once when a notification is written
   outside a transaction, and every POLL_MS while any stream is open, so a
   notification written inside a transaction goes out right after its
   commit, and rolled-back ones never do.
   ===================================================================== */

const pool = require("../db");
const { logError } = require("../lib/pii");
const { LOW_STOCK } = require("../lib/stock");
const { COURIER_LABEL } = require("./shippingRates");

const PESO = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });
const peso = (value) => PESO.format(Number(value) || 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const courierName = (code) => COURIER_LABEL[code] || code || "Courier";

// Links are frontend pages under Pages/ (the bell adds the right prefix).
const LINK = {
  deliveries: "Admin/deliveries.html",
  inventory: "Admin/inventory.html",
  product: (id) => `Admin/inventory.html?edit=${id}`,
  accounts: "Admin/accounts.html",
  chat: "Admin/chat.html#unanswered"
};

// Runs a notification helper; any error is logged, never thrown.
const safely = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (err) {
    logError("Admin notification not saved", err);
    return null;
  }
};

// One row. conn: the flow's connection (transaction) or the pool. -> notification_id | null
const notify = safely(async (conn, { type, title, body = null, link = null, orderId = null, productId = null,
                                     shipmentId = null, userId = null, chatId = null }) => {
  const [r] = await conn.query(
    `INSERT INTO admin_notifications (type, title, body, link, order_id, product_id, shipment_id, user_id, chat_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [type, String(title).slice(0, 120), body === null ? null : String(body).slice(0, 255), link,
     orderId, productId, shipmentId, userId, chatId]
  );
  if (conn === pool) hub.nudge();   // already committed; inside a transaction the poll picks it up after the commit
  return r.insertId;
});

/* ---------------------------------------------------------------------
   Events
   --------------------------------------------------------------------- */

// PayMongo webhook: the order is paid (routes/payments.js).
const orderPaid = safely(async (conn, orderId) => {
  const [[o]] = await conn.query(
    `SELECT o.total_amount, COALESCE(SUM(oi.quantity), 0) AS items
       FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.order_id
      WHERE o.order_id = ? GROUP BY o.order_id`, [orderId]);
  if (!o) return null;
  return notify(conn, { type: "sale", title: `New sale: order #${orderId}`,
    body: `${peso(o.total_amount)} · ${plural(Number(o.items), "item")}`, link: LINK.deliveries, orderId });
});

// PayMongo webhook: a payment was flagged for review instead of marking the order paid.
// kind: "amount" (paid a different amount) or "late" (the order had expired or was cancelled).
const paymentNeedsReview = safely(async (conn, { orderId, kind, expectedCentavos, paidCentavos }) => {
  const body = kind === "amount"
    ? `Paid ${peso((Number(paidCentavos) || 0) / 100)}, expected ${peso(expectedCentavos / 100)}. Check it in PayMongo before shipping.`
    : "Paid after the order expired or was cancelled. Refund it or restore the order by hand.";
  return notify(conn, { type: "payment_review", title: `Payment needs review: order #${orderId}`, body,
    link: LINK.deliveries, orderId });
});

// Order expiry job: one notification per run, not one per order (jobs/expireOrders.js).
const ordersExpired = safely(async (count, holdHours) => {
  if (!count) return null;
  return notify(pool, { type: "orders_expired", title: `${plural(count, "unpaid order")} expired`,
    body: `Not paid within ${holdHours} hours. The units they held are back on sale.`, link: LINK.inventory });
});

// A courier was booked: a J&T/LBC waybill or a Lalamove rider (routes/logistics.js).
const shipmentBooked = safely(async (conn, { orderId, shipmentId, courier, trackingNumber = null }) =>
  notify(conn, { type: "shipment_booked", title: `Shipment booked: order #${orderId}`,
    body: `${courierName(courier)} · ${trackingNumber ? `waybill ${trackingNumber}` : "rider requested"}`,
    link: LINK.deliveries, orderId, shipmentId }));

// A shipment reached DELIVERED or FAILED (admin update or Lalamove webhook). Other statuses are skipped.
const SHIPMENT_OUTCOME = {
  DELIVERED: { type: "shipment_delivered", title: (id) => `Delivered: order #${id}`, note: "" },
  FAILED: { type: "shipment_failed", title: (id) => `Delivery failed: order #${id}`, note: ". Contact the courier and the customer." }
};
const shipmentStatusChanged = safely(async (conn, { orderId, shipmentId, status }) => {
  const outcome = SHIPMENT_OUTCOME[status];
  if (!outcome) return null;
  const [[d]] = await conn.query("SELECT courier, tracking_number FROM deliveries WHERE delivery_id = ?", [shipmentId]);
  const waybill = d?.tracking_number ? ` · waybill ${d.tracking_number}` : "";
  return notify(conn, { type: outcome.type, title: outcome.title(orderId),
    body: `${courierName(d?.courier)}${waybill}${outcome.note}`, link: LINK.deliveries, orderId, shipmentId });
});

// Stock monitoring. Call before changing stock; it reads the products' AVAILABLE stock
// (on hand minus what unpaid orders hold, as on the storefront and the dashboard). The
// returned function, called after the change in the same transaction, notifies only on
// a crossing: into low stock (above LOW_STOCK -> 1..LOW_STOCK) or out of stock (above
// 0 -> 0). A product that is already low gets nothing more until it goes out of stock.
// Hidden products are skipped. what: [product_id, ...] or { orderId } (that order's products).
async function availableStock(conn, ids) {
  const [rows] = await conn.query(
    `SELECT product_id, name, is_active, stock_quantity - LEAST(reserved, stock_quantity) AS available
       FROM products WHERE product_id IN (?)`, [ids]);
  return new Map(rows.map((r) => [r.product_id, r]));
}

async function watchStock(conn, what) {
  let before;
  try {
    let ids = Array.isArray(what) ? what : [];
    if (what?.orderId) {
      const [lines] = await conn.query("SELECT product_id FROM order_items WHERE order_id = ?", [what.orderId]);
      ids = lines.map((l) => l.product_id);
    }
    ids = [...new Set(ids.map(Number))].filter(Boolean);
    before = ids.length ? await availableStock(conn, ids) : new Map();
  } catch (err) {
    logError("Admin notification not saved", err);
    return async () => {};
  }
  return safely(async () => {
    if (!before.size) return;
    const after = await availableStock(conn, [...before.keys()]);
    for (const [id, now] of after) {
      const was = Number(before.get(id).available);
      const left = Number(now.available);
      if (!now.is_active || left >= was) continue;
      if (left === 0) {
        await notify(conn, { type: "out_of_stock", title: `Out of stock: ${now.name}`,
          body: "0 available to sell. Restock it in Inventory.", link: LINK.product(id), productId: id });
      } else if (left <= LOW_STOCK && was > LOW_STOCK) {
        await notify(conn, { type: "low_stock", title: `Low stock: ${now.name}`,
          body: `${left} available to sell (low stock is ${LOW_STOCK} or fewer).`, link: LINK.product(id), productId: id });
      }
    }
  });
}

// Registration (routes/auth.js). Admin-created accounts aren't announced: an admin made them.
const customerRegistered = safely(async (conn, { userId, username }) =>
  notify(conn, { type: "new_customer", title: `New customer: ${username}`, body: "Signed up for an account.",
    link: LINK.accounts, userId }));

// The chat assistant couldn't answer (services/chatbot.js). Off-topic questions aren't the
// shop's to answer, so they're skipped, as on the Chat & FAQs review queue. The customer's
// message isn't copied here (it's stored encrypted and may hold personal details).
const CHAT_REASON = {
  no_information: "The assistant had no answer. Add an FAQ for it.",
  needs_staff: "The customer needs the shop to reply.",
  service_down: "The assistant was down, so the customer got the fallback reply."
};
const chatUnanswered = safely(async ({ chatId, reason }) => {
  if (!CHAT_REASON[reason]) return null;
  return notify(pool, { type: "chat_unanswered", title: "Chat question the assistant couldn't answer",
    body: CHAT_REASON[reason], link: LINK.chat, chatId });
});

/* ---------------------------------------------------------------------
   Reading (routes/notifications.js)
   --------------------------------------------------------------------- */
const COLUMNS = "n.notification_id, n.type, n.title, n.body, n.link, n.order_id, n.product_id, n.shipment_id, n.user_id, n.created_at";

const shape = (row, read = false) => ({
  id: Number(row.notification_id), type: row.type, title: row.title, body: row.body, link: row.link,
  order_id: row.order_id, product_id: row.product_id, shipment_id: row.shipment_id, user_id: row.user_id,
  created_at: row.created_at, read: Boolean(read)
});

async function unreadCount(adminId, conn = pool) {
  const [[r]] = await conn.query(
    `SELECT COUNT(*) AS n FROM admin_notifications n
      WHERE n.notification_id > (SELECT notifications_read_through FROM users WHERE user_id = ?)
        AND NOT EXISTS (SELECT 1 FROM admin_notification_reads r WHERE r.admin_id = ? AND r.notification_id = n.notification_id)`,
    [adminId, adminId]);
  return Number(r.n);
}

/* ---------------------------------------------------------------------
   Hub: pushes new rows to the open streams. A client is
   { since: last notification_id it has, send(notification) }.
   --------------------------------------------------------------------- */
const POLL_MS = 1000;

const hub = {
  clients: new Set(),
  timer: null,
  checking: false,
  again: false,

  subscribe(client) {
    this.clients.add(client);
    if (!this.timer) {
      this.timer = setInterval(() => this.check(), POLL_MS);
      this.timer.unref();
    }
  },

  unsubscribe(client) {
    this.clients.delete(client);
    if (!this.clients.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  nudge() {
    if (this.clients.size) setImmediate(() => this.check());
  },

  async check() {
    if (this.checking) { this.again = true; return; }
    this.checking = true;
    try {
      do {
        this.again = false;
        if (!this.clients.size) break;
        const from = Math.min(...[...this.clients].map((c) => c.since));
        const [rows] = await pool.query(
          `SELECT ${COLUMNS} FROM admin_notifications n WHERE n.notification_id > ? ORDER BY n.notification_id LIMIT 100`, [from]);
        for (const row of rows) {
          const n = shape(row, false);
          for (const client of this.clients) {
            if (n.id > client.since) {
              client.since = n.id;
              client.send(n);
            }
          }
        }
        if (rows.length === 100) this.again = true;
      } while (this.again);
    } catch (err) {
      logError("Notification stream check failed", err);
    } finally {
      this.checking = false;
    }
  }
};

module.exports = {
  notify, orderPaid, paymentNeedsReview, ordersExpired, shipmentBooked, shipmentStatusChanged, watchStock,
  customerRegistered, chatUnanswered, unreadCount, shape, hub, COLUMNS, LINK
};
