// Payment API (REQ03, REQ024) - PayMongo hosted checkout for GCash and bank transfer.
// Mounted at /api/v1/payments. The webhook handler is exported separately because it needs the raw body.
const router = require('express').Router();
const pool = require('../db');
const ah = require('../lib/asyncHandler');
const { decryptAddress, addressLine, orderEmail, logError } = require('../lib/pii');
const paymongo = require('../services/paymongo');
const { mail } = require('../services/mailer');
const notifications = require('../services/notifications');
const { COURIER_LABEL } = require('../services/shippingRates');
const { requireAuth, requireAdmin, requireRole, requireVerifiedEmail } = require('../middleware/auth');

const toCentavos = (php) => Math.round(Number(php) * 100);

// PayMongo sends the customer back to the checkout page, which polls GET /orders/:id.
// APP_URL is the URL of the Frontend/ folder itself: http://localhost:5500/Frontend
// with VS Code Live Server opened on the repo, http://localhost:5500 with Docker.
const returnUrl = (orderId, result) =>
  `${String(process.env.APP_URL || '').replace(/\/+$/, '')}/Pages/COpage/checkout.html?order=${orderId}&payment=${result}`;

// POST /checkout  { order_id }  -> { checkout_url }
// Amounts always come from the database, never from the browser.
// One payable link per order: "Pay now" again (a double click, or a retry after the page
// timed out) gets the order's open PayMongo session back instead of a second one, so the
// customer can't pay twice. A new session is only made when the last one expired.
router.post('/checkout', requireAuth, requireRole('user'), requireVerifiedEmail, ah(async (req, res) => {
  const orderId = Number(req.body.order_id);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Locks the order row: a second request for the same order waits here until this one
    // has stored its session, then finds it below.
    const [[order]] = await conn.query(
      `SELECT o.order_id, o.status, o.shipping_fee, u.username AS name,
              o.contact_email, u.email AS account_email, a.recipient_name, a.recipient_phone
         FROM orders o
         JOIN users u ON u.user_id = o.user_id
         LEFT JOIN delivery_addresses a ON a.address_id = o.address_id
        WHERE o.order_id = ? AND o.user_id = ?
          FOR UPDATE OF o`,
      [orderId, req.user.userId]
    );
    const done = async (status, body) => { await conn.commit(); return res.status(status).json(body); };
    if (!order) return done(404, { error: 'Order not found' });
    const recipient = decryptAddress(order);   // name and phone are stored encrypted
    if (order.status !== 'pending_payment') return done(409, { error: `Order is already ${order.status}` });

    const [[open]] = await conn.query(
      "SELECT checkout_session_id FROM payments WHERE order_id = ? AND status = 'pending' ORDER BY payment_id DESC LIMIT 1",
      [orderId]
    );
    if (open) {
      const existing = await paymongo.getCheckoutSession(open.checkout_session_id);
      if (existing.status === 'active') return done(200, { checkout_url: existing.checkoutUrl });
      if (existing.status === 'paid') {
        return done(409, { error: "This order is already paid. We're confirming the payment, check My Orders in a minute.",
          code: 'PAYMENT_CONFIRMING' });
      }
      // expired: open a new session below
    }

    const [items] = await conn.query(
      `SELECT p.name, oi.quantity, oi.unit_price
         FROM order_items oi JOIN products p ON p.product_id = oi.product_id WHERE oi.order_id = ?`,
      [orderId]
    );
    if (!items.length) return done(400, { error: 'Order has no items' });

    const lineItems = items.map((i) => ({
      name: i.name.slice(0, 255), quantity: i.quantity, amount: toCentavos(i.unit_price), currency: 'PHP',
    }));
    if (Number(order.shipping_fee) > 0) {
      lineItems.push({ name: 'Shipping fee', quantity: 1, amount: toCentavos(order.shipping_fee), currency: 'PHP' });
    }
    const total = lineItems.reduce((sum, l) => sum + l.amount * l.quantity, 0);

    const session = await paymongo.createCheckoutSession({
      referenceNumber: `BL-${order.order_id}`,
      description: `Bongalink order #${order.order_id}`,
      lineItems,
      customer: { name: recipient.recipient_name || order.name, email: orderEmail(order), phone: recipient.recipient_phone },
      successUrl: returnUrl(order.order_id, 'success'),
      cancelUrl: returnUrl(order.order_id, 'cancelled'),
    });

    await conn.query(
      `INSERT INTO payments (order_id, provider, checkout_session_id, amount_centavos, status)
       VALUES (?, 'paymongo', ?, ?, 'pending')`,
      [order.order_id, session.id, total]
    );
    return done(200, { checkout_url: session.checkoutUrl });
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}));

// GET /orders/:id  - the return page polls this. The redirect alone is NOT proof of payment;
// only the webhook marks an order as paid.
router.get('/orders/:id', requireAuth, ah(async (req, res) => {
  const [[order]] = await pool.query(
    'SELECT order_id, status, paid_at FROM orders WHERE order_id = ? AND user_id = ?',
    [req.params.id, req.user.userId]
  );
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const [[payment]] = await pool.query(
    'SELECT status, method_used, paid_at FROM payments WHERE order_id = ? ORDER BY payment_id DESC LIMIT 1',
    [order.order_id]
  );
  res.json({ order_status: order.status, payment: payment || null });
}));

// Admin: payments that need a human decision (paid after expiry, amount mismatch).
router.get('/admin/review', requireAdmin, ah(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT payment_id, order_id, amount_centavos / 100 AS amount, method_used, review_reason, paid_at
       FROM payments WHERE status = 'review' ORDER BY paid_at DESC`
  );
  res.json(rows);
}));

// ---------------------------------------------------------------------------
// Webhook: POST /api/v1/webhooks/paymongo  (event: checkout_session.payment.paid)
// ---------------------------------------------------------------------------
async function handleCheckoutPaid(conn, session) {
  const attrs = session.attributes;
  const paid = attrs.payments?.[0];
  const [[p]] = await conn.query(
    'SELECT payment_id, order_id, amount_centavos, status FROM payments WHERE checkout_session_id = ? FOR UPDATE',
    [session.id]
  );
  if (!p) {
    // Signed and accepted, but no payment has this checkout session: nothing to mark paid.
    console.warn(`PayMongo webhook: no payment for checkout session ${session.id}; no order changed`);
    return null;
  }
  if (p.status === 'paid') return null;

  const flag = (reason) =>
    conn.query(
      `UPDATE payments SET status = 'review', review_reason = ?, provider_payment_id = ?, method_used = ?, paid_at = NOW()
        WHERE payment_id = ?`,
      [reason, paid?.id, attrs.payment_method_used, p.payment_id]
    );

  if (paid?.attributes?.amount !== p.amount_centavos) {
    console.warn(`PayMongo webhook: order ${p.order_id} amount mismatch (expected ${p.amount_centavos}, got ${paid?.attributes?.amount}); flagged for review`);
    await flag(`Amount mismatch: expected ${p.amount_centavos}, got ${paid?.attributes?.amount}`);
    await notifications.paymentNeedsReview(conn, {
      orderId: p.order_id, kind: 'amount', expectedCentavos: p.amount_centavos, paidCentavos: paid?.attributes?.amount,
    });
    return null;
  }

  const [upd] = await conn.query(
    `UPDATE orders SET status = 'paid', paid_at = NOW() WHERE order_id = ? AND status = 'pending_payment'`,
    [p.order_id]
  );
  if (!upd.affectedRows) {
    console.warn(`PayMongo webhook: order ${p.order_id} is no longer pending_payment; payment flagged for review`);
    // e.g. order expired and its stock was released before the customer finished paying
    await flag('Paid after order left pending_payment (expired/cancelled) - refund or restore manually');
    await notifications.paymentNeedsReview(conn, { orderId: p.order_id, kind: 'late' });
    return null;
  }

  await conn.query(
    `UPDATE payments SET status = 'paid', provider_payment_id = ?, method_used = ?, paid_at = NOW() WHERE payment_id = ?`,
    [paid?.id, attrs.payment_method_used, p.payment_id]
  );
  const stockAlerts = await notifications.watchStock(conn, { orderId: p.order_id });
  // Ghost-stock fix: the reservation made at checkout becomes a real deduction.
  // LEAST() keeps the UNSIGNED columns from underflowing if an admin lowered stock meanwhile.
  // The 003 trigger logs this stock_quantity change to ml_events.
  await conn.query(
    `UPDATE products pr JOIN order_items oi ON oi.product_id = pr.product_id
        SET pr.stock_quantity = pr.stock_quantity - LEAST(pr.stock_quantity, oi.quantity),
            pr.reserved = pr.reserved - LEAST(pr.reserved, oi.quantity)
      WHERE oi.order_id = ?`,
    [p.order_id]
  );
  await conn.query(
    `INSERT INTO inventory_movements (product_id, change_qty, reason, reference)
     SELECT product_id, -quantity, 'sale', CONCAT('order:', order_id) FROM order_items WHERE order_id = ?`,
    [p.order_id]
  );
  // The admin bell, in this transaction: a rolled-back payment leaves no "New sale".
  // (Available stock usually doesn't move here, the checkout already held it; it can if an admin lowered stock meanwhile.)
  await stockAlerts();
  await notifications.orderPaid(conn, p.order_id);
  return { orderId: p.order_id, amount: p.amount_centavos / 100 };
}

async function paymongoWebhook(req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return res.status(400).end();
  }
  // The secret key decides the mode: a live shop checks the live signature and accepts only
  // live events; with a test key, only test events. The event's own livemode flag is not trusted.
  const live = paymongo.isLiveKey();
  const toleranceSeconds = Number(process.env.PAYMONGO_WEBHOOK_TOLERANCE_SECONDS) || 0;
  const signed = paymongo.verifyWebhookSignature(raw, req.get('Paymongo-Signature'), process.env.PAYMONGO_WEBHOOK_SECRET, live, { toleranceSeconds });
  if (!signed || event?.data?.attributes?.livemode !== live) {
    console.warn(`PayMongo webhook refused (401): ${signed ? `livemode is ${event?.data?.attributes?.livemode}, but the secret key is ${live ? 'live' : 'test'}` : 'bad or missing signature'}`);
    return res.status(401).end();
  }

  const eventId = event.data?.id;
  const type = event.data?.attributes?.type;
  if (!eventId || !type) return res.status(400).end();

  const conn = await pool.getConnection();
  let result = null;
  try {
    await conn.beginTransaction();
    // Event row + order update commit together, so a failure lets PayMongo retry safely.
    const [ins] = await conn.query('INSERT IGNORE INTO payment_events (event_id, type) VALUES (?, ?)', [eventId, type]);
    if (ins.affectedRows && type === 'checkout_session.payment.paid') {
      result = await handleCheckoutPaid(conn, event.data.attributes.data);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    logError('PayMongo webhook failed', err);
    return res.status(500).end();
  } finally {
    conn.release();
  }

  if (result) {
    const [[c]] = await pool.query(
      `SELECT u.username AS name, o.contact_email, u.email AS account_email
         FROM orders o JOIN users u ON u.user_id = o.user_id WHERE o.order_id = ?`,
      [result.orderId]
    );
    mail.paymentReceived(orderEmail(c), c.name, result.orderId, result.amount).catch((e) => logError('Mail failed', e));
    await alertShop(result).catch((e) => logError('Shop alert failed', e));
  }
  res.status(200).json({ received: true });
}

// Emails the shop (ADMIN_ALERT_EMAIL) what to pack and where to send it.
// The admin dashboard also polls GET /api/v1/admin/orders/to-ship for a badge, and the
// admin bell got a "New sale" notification inside the webhook transaction (handleCheckoutPaid).
// Only the lookups are awaited; a slow SMTP server never delays the webhook reply.
async function alertShop({ orderId, amount }) {
  const to = process.env.ADMIN_ALERT_EMAIL;
  if (!to) return;
  const [[row]] = await pool.query(
    `SELECT o.courier, a.recipient_name, a.recipient_phone, a.street, a.barangay, a.city, a.province, a.postal_code
       FROM orders o LEFT JOIN delivery_addresses a ON a.address_id = o.address_id
      WHERE o.order_id = ?`,
    [orderId]
  );
  const o = decryptAddress(row);
  const [items] = await pool.query(
    `SELECT p.name, oi.quantity FROM order_items oi JOIN products p ON p.product_id = oi.product_id
      WHERE oi.order_id = ? ORDER BY oi.order_item_id`,
    [orderId]
  );
  mail.orderPaidAlert(to, {
    orderId, amount, items,
    courierLabel: COURIER_LABEL[o.courier] || o.courier || 'Not chosen',
    shipName: o.recipient_name, shipPhone: o.recipient_phone, shipAddress: addressLine(o),
  }).catch((e) => logError('Shop alert failed', e));
}

module.exports = { router, paymongoWebhook };
