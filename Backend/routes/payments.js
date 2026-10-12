// Payment API (REQ03, REQ024) - PayMongo hosted checkout for GCash and bank transfer.
// Mounted at /api/v1/payments. The webhook handler is exported separately because it needs the raw body.
const router = require('express').Router();
const pool = require('../db');
const ah = require('../lib/asyncHandler');
const paymongo = require('../services/paymongo');
const { mail } = require('../services/mailer');
const { requireAuth, requireAdmin, requireRole, requireVerifiedEmail } = require('../middleware/auth');

const toCentavos = (php) => Math.round(Number(php) * 100);

// PayMongo sends the customer back to the checkout page, which polls GET /orders/:id.
// APP_URL is where the Frontend/ folder is served, e.g. http://localhost:5500
const returnUrl = (orderId, result) =>
  `${process.env.APP_URL}/Pages/COpage/checkout.html?order=${orderId}&payment=${result}`;

// POST /checkout  { order_id }  -> { checkout_url }
// Amounts always come from the database, never from the browser.
router.post('/checkout', requireAuth, requireRole('user'), requireVerifiedEmail, ah(async (req, res) => {
  const orderId = Number(req.body.order_id);
  const [[order]] = await pool.query(
    `SELECT o.order_id, o.status, o.shipping_fee, u.username AS name,
            COALESCE(o.contact_email, u.email) AS email, a.recipient_name, a.recipient_phone
       FROM orders o
       JOIN users u ON u.user_id = o.user_id
       LEFT JOIN delivery_addresses a ON a.address_id = o.address_id
      WHERE o.order_id = ? AND o.user_id = ?`,
    [orderId, req.user.userId]
  );
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'pending_payment') return res.status(409).json({ error: `Order is already ${order.status}` });

  const [items] = await pool.query(
    `SELECT p.name, oi.quantity, oi.unit_price
       FROM order_items oi JOIN products p ON p.product_id = oi.product_id WHERE oi.order_id = ?`,
    [orderId]
  );
  if (!items.length) return res.status(400).json({ error: 'Order has no items' });

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
    customer: { name: order.recipient_name || order.name, email: order.email, phone: order.recipient_phone },
    successUrl: returnUrl(order.order_id, 'success'),
    cancelUrl: returnUrl(order.order_id, 'cancelled'),
  });

  await pool.query(
    `INSERT INTO payments (order_id, provider, checkout_session_id, amount_centavos, status)
     VALUES (?, 'paymongo', ?, ?, 'pending')`,
    [order.order_id, session.id, total]
  );
  res.json({ checkout_url: session.checkoutUrl });
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
  if (!p || p.status === 'paid') return null;

  const flag = (reason) =>
    conn.query(
      `UPDATE payments SET status = 'review', review_reason = ?, provider_payment_id = ?, method_used = ?, paid_at = NOW()
        WHERE payment_id = ?`,
      [reason, paid?.id, attrs.payment_method_used, p.payment_id]
    );

  if (paid?.attributes?.amount !== p.amount_centavos) {
    await flag(`Amount mismatch: expected ${p.amount_centavos}, got ${paid?.attributes?.amount}`);
    return null;
  }

  const [upd] = await conn.query(
    `UPDATE orders SET status = 'paid', paid_at = NOW() WHERE order_id = ? AND status = 'pending_payment'`,
    [p.order_id]
  );
  if (!upd.affectedRows) {
    // e.g. order expired and its stock was released before the customer finished paying
    await flag('Paid after order left pending_payment (expired/cancelled) - refund or restore manually');
    return null;
  }

  await conn.query(
    `UPDATE payments SET status = 'paid', provider_payment_id = ?, method_used = ?, paid_at = NOW() WHERE payment_id = ?`,
    [paid?.id, attrs.payment_method_used, p.payment_id]
  );
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
  const livemode = !!event?.data?.attributes?.livemode;
  if (!paymongo.verifyWebhookSignature(raw, req.get('Paymongo-Signature'), process.env.PAYMONGO_WEBHOOK_SECRET, livemode)) {
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
    console.error('PayMongo webhook failed:', err.message);
    return res.status(500).end();
  } finally {
    conn.release();
  }

  if (result) {
    const [[c]] = await pool.query(
      `SELECT u.username AS name, COALESCE(o.contact_email, u.email) AS email
         FROM orders o JOIN users u ON u.user_id = o.user_id WHERE o.order_id = ?`,
      [result.orderId]
    );
    mail.paymentReceived(c.email, c.name, result.orderId, result.amount).catch((e) => console.error('Mail failed:', e.message));
  }
  res.status(200).json({ received: true });
}

module.exports = { router, paymongoWebhook };
