// Logistics API (REQ012-REQ016, REQ025, REQ034). Mounted at /api/v1
// Shipments live in the existing `deliveries` table: POST /api/orders creates one
// PENDING row per order, and booking a courier fills it in.
const router = require('express').Router();
const pool = require('../db');
const ah = require('../lib/asyncHandler');
const lalamove = require('../services/lalamove');
const { quoteOptions, storeLocation, COURIER_LABEL } = require('../services/shippingRates');
const { mail } = require('../services/mailer');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const SHIPMENT_STATUSES = ['BOOKED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED', 'RETURNED'];
const READY_TO_SHIP = ['paid', 'packed'];

// Tracking page templates, e.g. TRACKING_URL_JNT=https://.../?waybill={tn}
const trackingUrlFor = (courier, tn) => {
  const tpl = process.env[`TRACKING_URL_${courier}`];
  return tpl ? tpl.replace('{tn}', encodeURIComponent(tn)) : null;
};

async function loadOrderForShipping(orderId) {
  const [[o]] = await pool.query(
    `SELECT o.order_id, o.status, o.shipping_fee, o.courier,
            u.username AS customer_name, COALESCE(o.contact_email, u.email) AS customer_email,
            a.recipient_name AS ship_name, a.recipient_phone AS ship_phone,
            CONCAT_WS(', ', a.street, a.barangay, a.city, a.province, a.postal_code) AS ship_address,
            a.lat AS ship_lat, a.lng AS ship_lng
       FROM orders o
       JOIN users u ON u.user_id = o.user_id
       LEFT JOIN delivery_addresses a ON a.address_id = o.address_id
      WHERE o.order_id = ?`,
    [orderId]
  );
  return o;
}

// The order's delivery row, if it has been booked already.
async function bookedDelivery(conn, orderId, lock = false) {
  const [[d]] = await conn.query(
    `SELECT delivery_id, status FROM deliveries WHERE order_id = ?${lock ? ' FOR UPDATE' : ''}`,
    [orderId]
  );
  return d && d.status !== 'PENDING' ? d : null;
}

// Creates or fills in the order's delivery row; returns its delivery_id.
async function upsertDelivery(conn, orderId, fields) {
  const cols = Object.keys(fields);
  const [ins] = await conn.query(
    `INSERT INTO deliveries (order_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
     ON DUPLICATE KEY UPDATE delivery_id = LAST_INSERT_ID(delivery_id), ${cols.map((c) => `${c} = VALUES(${c})`).join(', ')}`,
    [orderId, ...Object.values(fields)]
  );
  return ins.insertId;
}

// Writes a timeline entry and keeps delivery/order status in sync.
async function addShipmentEvent(conn, delivery, status, { note = null, source = 'admin', userId = null } = {}) {
  await conn.query('INSERT INTO shipment_events (delivery_id, status, note, source, created_by) VALUES (?, ?, ?, ?, ?)', [
    delivery.delivery_id, status, note, source, userId,
  ]);
  await conn.query(
    `UPDATE deliveries SET status = ?,
            dispatched_at = IF(? IN ('PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY') AND dispatched_at IS NULL, NOW(), dispatched_at),
            delivered_at  = IF(? = 'DELIVERED', NOW(), delivered_at)
      WHERE delivery_id = ?`,
    [status, status, status, delivery.delivery_id]
  );
  if (status === 'DELIVERED') {
    await conn.query(`UPDATE orders SET status = 'delivered' WHERE order_id = ?`, [delivery.order_id]);
  }
}

async function inTransaction(work) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function notifyDelivered(orderId) {
  const o = await loadOrderForShipping(orderId);
  mail.delivered(o.customer_email, o.customer_name, o.order_id).catch((e) => console.error('Mail failed:', e.message));
}

// ---------------------------------------------------------------- customer

// POST /shipping/quote  { items: [{product_id, quantity}], address: {region, province?, line, lat?, lng?} }
router.post('/shipping/quote', requireAuth, ah(async (req, res) => {
  const { items, address } = req.body || {};
  if (!Array.isArray(items) || !items.length || items.length > 50) return res.status(400).json({ error: 'Cart is empty or invalid' });
  if (items.some((i) => !Number.isInteger(i.quantity) || i.quantity < 1)) return res.status(400).json({ error: 'Invalid quantity' });
  if (!address?.region || !address?.line) return res.status(400).json({ error: 'Address region and street are required' });
  try {
    res.json(await quoteOptions(items, address));
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    throw e;
  }
}));

// GET /orders/:id/tracking  - customer's tracking timeline
router.get('/orders/:id/tracking', requireAuth, ah(async (req, res) => {
  const [[d]] = await pool.query(
    `SELECT d.* FROM deliveries d JOIN orders o ON o.order_id = d.order_id
      WHERE o.order_id = ? AND o.user_id = ? AND d.status <> 'PENDING'`,
    [req.params.id, req.user.userId]
  );
  if (!d) return res.status(404).json({ error: 'No shipment yet for this order' });
  const [events] = await pool.query(
    'SELECT status, note, created_at FROM shipment_events WHERE delivery_id = ? ORDER BY created_at ASC, event_id ASC',
    [d.delivery_id]
  );
  res.json({
    courier: d.courier, courier_label: COURIER_LABEL[d.courier], status: d.status,
    tracking_number: d.tracking_number, tracking_url: d.tracking_url, events,
  });
}));

// ---------------------------------------------------------------- admin

// GET /admin/shipments?status=IN_TRANSIT  (REQ012, REQ016) - booked deliveries only
router.get('/admin/shipments', requireAdmin, ah(async (req, res) => {
  const params = [];
  let where = `WHERE d.status <> 'PENDING'`;
  if (req.query.status) {
    if (!SHIPMENT_STATUSES.includes(req.query.status)) return res.status(400).json({ error: 'Invalid status' });
    where = 'WHERE d.status = ?';
    params.push(req.query.status);
  }
  const [rows] = await pool.query(
    `SELECT d.*, o.status AS order_status, a.recipient_name AS ship_name,
            CONCAT_WS(', ', a.street, a.barangay, a.city, a.province, a.postal_code) AS ship_address
       FROM deliveries d
       JOIN orders o ON o.order_id = d.order_id
       LEFT JOIN delivery_addresses a ON a.address_id = o.address_id
      ${where} ORDER BY d.updated_at DESC LIMIT 200`,
    params
  );
  res.json(rows);
}));

// POST /admin/shipments/:orderId/lalamove  - books a Lalamove rider (Metro Manila)
router.post('/admin/shipments/:orderId/lalamove', requireAdmin, ah(async (req, res) => {
  if (!lalamove.enabled()) return res.status(400).json({ error: 'Lalamove is not configured' });
  const o = await loadOrderForShipping(req.params.orderId);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (!READY_TO_SHIP.includes(o.status)) return res.status(409).json({ error: `Order is ${o.status}, not ready to ship` });
  if (!o.ship_lat || !o.ship_lng) return res.status(400).json({ error: 'Order has no map pin (lat/lng) for Lalamove' });
  if (await bookedDelivery(pool, o.order_id)) return res.status(409).json({ error: 'This order already has a shipment' });

  const quotation = await lalamove.getQuotation({
    pickup: storeLocation(),
    dropoff: { lat: o.ship_lat, lng: o.ship_lng, address: o.ship_address },
  });
  const booked = await lalamove.placeOrder({
    quotation,
    sender: { name: process.env.STORE_CONTACT_NAME, phone: process.env.STORE_PHONE },
    recipient: { name: o.ship_name, phone: o.ship_phone },
    remarks: `Bongalink order #${o.order_id}`,
  });

  let deliveryId;
  try {
    deliveryId = await inTransaction(async (conn) => {
      if (await bookedDelivery(conn, o.order_id, true)) throw Object.assign(new Error('already booked'), { code: 'ALREADY_BOOKED' });
      const id = await upsertDelivery(conn, o.order_id, {
        courier: 'LALAMOVE', external_order_id: booked.orderId, tracking_url: booked.shareLink,
        fee_charged: o.shipping_fee, fee_actual: quotation.total, status: 'BOOKED',
      });
      await addShipmentEvent(conn, { delivery_id: id, order_id: o.order_id }, 'BOOKED', {
        note: 'Lalamove rider requested', userId: req.user.userId,
      });
      await conn.query(`UPDATE orders SET status = 'shipped', courier = 'LALAMOVE' WHERE order_id = ?`, [o.order_id]);
      return id;
    });
  } catch (e) {
    await lalamove.cancelOrder(booked.orderId).catch(() => {}); // don't leave an orphan booking
    if (e.code === 'ALREADY_BOOKED') return res.status(409).json({ error: 'This order already has a shipment' });
    throw e;
  }

  mail.shipmentBooked(o.customer_email, o.customer_name, o.order_id, COURIER_LABEL.LALAMOVE, null, booked.shareLink)
    .catch((e) => console.error('Mail failed:', e.message));
  res.status(201).json({
    delivery_id: deliveryId,
    lalamove_order_id: booked.orderId,
    tracking_url: booked.shareLink,
    fee_charged: Number(o.shipping_fee),
    fee_actual: quotation.total,
    fee_difference: Math.round((quotation.total - Number(o.shipping_fee)) * 100) / 100,
  });
}));

// POST /admin/shipments/:orderId/manual  { courier: 'JNT'|'LBC', tracking_number, fee_actual? }
// Admin books at the J&T/LBC branch or app, then encodes the waybill here (REQ013, REQ014).
router.post('/admin/shipments/:orderId/manual', requireAdmin, ah(async (req, res) => {
  const { courier, tracking_number, fee_actual } = req.body || {};
  if (!['JNT', 'LBC'].includes(courier)) return res.status(400).json({ error: 'Courier must be JNT or LBC' });
  const tn = String(tracking_number || '').trim();
  if (!/^[A-Za-z0-9-]{6,40}$/.test(tn)) return res.status(400).json({ error: 'Invalid tracking number' });
  const feeActual = fee_actual === undefined || fee_actual === null || fee_actual === '' ? null : Number(fee_actual);
  if (feeActual !== null && !(feeActual >= 0)) return res.status(400).json({ error: 'Invalid courier fee' });

  const o = await loadOrderForShipping(req.params.orderId);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (!READY_TO_SHIP.includes(o.status)) return res.status(409).json({ error: `Order is ${o.status}, not ready to ship` });

  const url = trackingUrlFor(courier, tn);
  const deliveryId = await inTransaction(async (conn) => {
    if (await bookedDelivery(conn, o.order_id, true)) return null;
    const id = await upsertDelivery(conn, o.order_id, {
      courier, tracking_number: tn, tracking_url: url, fee_charged: o.shipping_fee, fee_actual: feeActual, status: 'PICKED_UP',
    });
    await addShipmentEvent(conn, { delivery_id: id, order_id: o.order_id }, 'PICKED_UP', {
      note: `Dropped off at ${COURIER_LABEL[courier]}`, userId: req.user.userId,
    });
    await conn.query(`UPDATE orders SET status = 'shipped', courier = ? WHERE order_id = ?`, [courier, o.order_id]);
    return id;
  });
  if (!deliveryId) return res.status(409).json({ error: 'This order already has a shipment' });

  mail.shipmentBooked(o.customer_email, o.customer_name, o.order_id, COURIER_LABEL[courier], tn, url)
    .catch((e) => console.error('Mail failed:', e.message));
  res.status(201).json({ delivery_id: deliveryId, tracking_url: url });
}));

// PATCH /admin/shipments/:id/status  { status, note? }  - manual timeline updates for J&T/LBC (:id = delivery_id)
router.patch('/admin/shipments/:id/status', requireAdmin, ah(async (req, res) => {
  const { status, note } = req.body || {};
  if (!SHIPMENT_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const [[d]] = await pool.query('SELECT delivery_id, order_id, status FROM deliveries WHERE delivery_id = ?', [req.params.id]);
  if (!d) return res.status(404).json({ error: 'Shipment not found' });
  if (d.status === 'PENDING') return res.status(409).json({ error: 'Shipment has not been booked yet' });
  if (d.status === 'DELIVERED') return res.status(409).json({ error: 'Shipment is already delivered' });

  await inTransaction((conn) =>
    addShipmentEvent(conn, d, status, { note: note ? String(note).slice(0, 255) : null, userId: req.user.userId })
  );
  if (status === 'DELIVERED') notifyDelivered(d.order_id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- courier webhook

// POST /webhooks/lalamove  - set this URL in the Lalamove Partner Portal.
// The payload is not trusted: we only take the orderId and re-fetch the real status from Lalamove.
router.post('/webhooks/lalamove', ah(async (req, res) => {
  const body = req.body || {};
  if (body.apiKey && body.apiKey !== process.env.LALAMOVE_API_KEY) return res.status(401).end();
  const llmOrderId = body.data?.order?.orderId;
  if (!llmOrderId) return res.status(200).end(); // portal test ping

  const [[d]] = await pool.query('SELECT delivery_id, order_id, status FROM deliveries WHERE external_order_id = ?', [llmOrderId]);
  if (!d) return res.status(200).end();

  const live = await lalamove.getOrder(llmOrderId);
  const mapped = lalamove.STATUS_MAP[live?.status];
  if (mapped && mapped !== d.status && d.status !== 'DELIVERED') {
    await inTransaction((conn) =>
      addShipmentEvent(conn, d, mapped, { note: `Lalamove: ${live.status}`, source: 'courier_webhook' })
    );
    if (mapped === 'DELIVERED') notifyDelivered(d.order_id);
  }
  res.status(200).end();
}));

module.exports = router;
