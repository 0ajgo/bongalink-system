// The chatbot's tools (Gemini function calling). Answers about products, stock,
// shipping and orders come from these database lookups, never from the model.
//   - Only active products; stock is always AVAILABLE stock (on hand minus units
//     reserved by unpaid orders), the same number the shop pages show.
//   - get_order_status only sees the logged-in customer's own orders; another
//     customer's order number gets the same "not found" as a made-up one.
//   - mark_unanswered is how the bot reports a question it couldn't answer, so the
//     admin can review it and add an FAQ (the "progressively improve" loop).
const pool = require('../db');
const { quoteOptions, REGIONS, ZONE_LABEL, zoneFor, inLalamoveArea, COURIER_LABEL } = require('./shippingRates');
const { HOLD_HOURS } = require('../jobs/expireOrders');

const LOW_STOCK = 3;   // same threshold as the shop's "Only N left" badge (Frontend/JS/ui.js)
const AVAILABLE = 'p.stock_quantity - LEAST(p.reserved, p.stock_quantity)';
const MAX_RESULTS = 8;

const stockStatus = (n) => (n <= 0 ? 'out_of_stock' : n <= LOW_STOCK ? 'low_stock' : 'in_stock');

const productRow = (r) => ({
  product_id: r.id, name: r.name, category: r.category, brand: r.brand || null,
  price_php: Number(r.price), available: Number(r.available), stock_status: stockStatus(Number(r.available)),
});

const PRODUCT_SELECT = `
  SELECT p.product_id AS id, p.name, c.name AS category, p.brand, p.price, ${AVAILABLE} AS available
    FROM products p JOIN categories c ON c.category_id = p.category_id
   WHERE p.is_active = 1`;

async function categoryNames() {
  const [rows] = await pool.query(
    `SELECT c.name, COUNT(p.product_id) AS products FROM categories c
       JOIN products p ON p.category_id = c.category_id AND p.is_active = 1
      GROUP BY c.category_id ORDER BY c.name`);
  return rows.map((r) => r.name);
}

// ------------------------------------------------------------- search_products
async function searchProducts({ query, category } = {}) {
  const words = String(query || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2).slice(0, 6);
  const cat = String(category || '').trim();
  if (!words.length && !cat) {
    return { results: [], categories: await categoryNames(), note: 'No search words given. Ask what part they need.' };
  }
  if (cat) {
    const [[known]] = await pool.query('SELECT name FROM categories WHERE name = ?', [cat]);
    if (!known) return { results: [], categories: await categoryNames(), note: `There is no category "${cat}".` };
  }

  const run = async (mode) => {
    let sql = PRODUCT_SELECT;
    const params = [];
    if (cat) { sql += ' AND c.name = ?'; params.push(cat); }
    if (words.length) {
      const one = '(p.name LIKE ? OR p.brand LIKE ? OR p.description LIKE ? OR c.name LIKE ?)';
      sql += ` AND (${words.map(() => one).join(mode === 'all' ? ' AND ' : ' OR ')})`;
      words.forEach((w) => params.push(...Array(4).fill(`%${w}%`)));
    }
    sql += ` ORDER BY (${AVAILABLE}) > 0 DESC, p.name LIMIT ${MAX_RESULTS + 1}`;
    const [rows] = await pool.query(sql, params);
    return rows;
  };

  let match = 'all_words';
  let rows = await run('all');
  if (!rows.length && words.length > 1) { match = 'any_word'; rows = await run('any'); }
  return {
    match,
    results: rows.slice(0, MAX_RESULTS).map(productRow),
    more_results: rows.length > MAX_RESULTS,
    ...(rows.length ? {} : { note: 'No matching products. Do not suggest parts that are not in results.' }),
  };
}

// ----------------------------------------------------------------- get_product
async function getProduct({ product_id } = {}) {
  const id = Number(product_id);
  if (!Number.isInteger(id) || id < 1) return { error: 'invalid_product_id' };
  const [[r]] = await pool.query(
    `SELECT p.product_id AS id, p.name, c.name AS category, p.brand, p.price, ${AVAILABLE} AS available,
            p.description, p.weight_kg
       FROM products p JOIN categories c ON c.category_id = p.category_id
      WHERE p.is_active = 1 AND p.product_id = ?`, [id]);
  if (!r) return { error: 'not_found', message: 'No product with that id is for sale.' };
  const description = r.description ? String(r.description).slice(0, 800) : null;
  return { ...productRow(r), parcel_weight_kg: Number(r.weight_kg), description };
}

// ---------------------------------------------------------- get_shipping_quote
async function shippingQuote({ region, province, city, lat, lng, items } = {}) {
  const list = Array.isArray(items) ? items.slice(0, 10) : [];
  const parsed = list.map((i) => ({ product_id: Number(i?.product_id), quantity: Number(i?.quantity ?? 1) }));
  if (parsed.some((i) => !Number.isInteger(i.product_id) || !Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 50)) {
    return { error: 'invalid_items', message: 'Each item needs a product_id and a quantity from 1 to 50.' };
  }
  if (parsed.length) {
    const [rows] = await pool.query('SELECT product_id FROM products WHERE is_active = 1 AND product_id IN (?)', [parsed.map((i) => i.product_id)]);
    const active = new Set(rows.map((r) => r.product_id));
    const missing = parsed.filter((i) => !active.has(i.product_id)).map((i) => i.product_id);
    if (missing.length) return { error: 'unknown_products', product_ids: missing, message: 'These products are not for sale.' };
  }

  const reg = String(region || '').toUpperCase().trim();
  const hasPin = Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) && lat !== null && lng !== null && lat !== undefined && lng !== undefined;
  if (!hasPin && !zoneFor(reg, province)) {
    return { error: 'unknown_region', message: `Ask which province or city. region must be one of ${REGIONS.join(', ')}.` };
  }

  // Fees by parcel weight when no part is chosen yet: the J&T/LBC rate card for that zone.
  if (!parsed.length) {
    const zone = zoneFor(reg, province);
    const [rates] = await pool.query(
      'SELECT courier, max_weight_kg, fee FROM shipping_rates WHERE zone = ? ORDER BY courier, max_weight_kg', [zone]);
    return {
      destination: { region: reg, province: province || null, zone: ZONE_LABEL[zone] },
      note: 'No parts chosen, so these are fees by parcel weight. The exact fee is shown at checkout.',
      rates: rates.map((r) => ({ courier: COURIER_LABEL[r.courier], up_to_kg: Number(r.max_weight_kg), fee_php: Number(r.fee) })),
      lalamove: inLalamoveArea({ region: reg, province })
        ? 'Lalamove same-day may be offered at checkout with a live quote when the customer pins their location.'
        : 'Lalamove is not available for this area.',
    };
  }

  try {
    const q = await quoteOptions(parsed, {
      region: reg, province: province || null, city: city || null,
      line: city || province || reg, lat: hasPin ? Number(lat) : null, lng: hasPin ? Number(lng) : null,
    });
    return {
      destination: { region: q.location.region, province: q.location.province, city: q.location.city, zone: ZONE_LABEL[q.zone] },
      parcel_weight_kg: q.weight_kg,
      options: q.options.map((o) => ({ courier: o.label, fee_php: o.fee, delivery_time: o.eta, basis: o.basis })),
      ...(q.options.length ? {} : { note: 'No courier rate covers this parcel. The shop must quote it.' }),
    };
  } catch (e) {
    if (e.status === 400) return { error: 'quote_failed', message: e.message };
    throw e;
  }
}

// ------------------------------------------------------------ get_order_status
const ORDER_STATUS = {
  pending_payment: 'Waiting for payment', paid: 'Paid, being prepared', packed: 'Packed, waiting for the courier',
  shipped: 'Shipped', delivered: 'Delivered', expired: 'Expired (not paid in time)', cancelled: 'Cancelled',
  pending: 'Pending', processing: 'Processing', completed: 'Completed',
};

async function orderStatus({ order_id } = {}, { user } = {}) {
  if (!user) return { error: 'login_required', message: 'The customer must log in to check their orders.' };

  let orders;
  if (order_id !== undefined && order_id !== null && order_id !== '') {
    const id = Number(String(order_id).replace(/^#/, ''));
    if (!Number.isInteger(id) || id < 1) return { error: 'not_found', message: 'No order with that number on this account.' };
    [orders] = await pool.query(
      `SELECT order_id, status, total_amount, shipping_fee, courier, paid_at, created_at
         FROM orders WHERE order_id = ? AND user_id = ?`, [id, user.userId]);
    if (!orders.length) return { error: 'not_found', message: 'No order with that number on this account.' };
  } else {
    [orders] = await pool.query(
      `SELECT order_id, status, total_amount, shipping_fee, courier, paid_at, created_at
         FROM orders WHERE user_id = ? ORDER BY created_at DESC, order_id DESC LIMIT 5`, [user.userId]);
    if (!orders.length) return { orders: [], note: 'This customer has no orders yet.' };
  }

  const ids = orders.map((o) => o.order_id);
  const [items] = await pool.query(
    `SELECT oi.order_id, p.name, oi.quantity FROM order_items oi JOIN products p ON p.product_id = oi.product_id
      WHERE oi.order_id IN (?) ORDER BY oi.order_item_id`, [ids]);
  const [shipments] = await pool.query(
    `SELECT d.order_id, d.delivery_id, d.courier, d.status, d.tracking_number, d.tracking_url,
            (SELECT CONCAT_WS(' | ', e.status, e.note, DATE_FORMAT(e.created_at, '%Y-%m-%d %H:%i'))
               FROM shipment_events e WHERE e.delivery_id = d.delivery_id ORDER BY e.created_at DESC, e.event_id DESC LIMIT 1) AS last_update
       FROM deliveries d WHERE d.order_id IN (?) AND d.status <> 'PENDING'`, [ids]);

  const result = orders.map((o) => {
    const s = shipments.find((d) => d.order_id === o.order_id);
    return {
      order_id: o.order_id,
      status: ORDER_STATUS[o.status] || o.status,
      placed_at: o.created_at,
      ...(o.status === 'pending_payment'
        ? { pay_before: new Date(new Date(o.created_at).getTime() + HOLD_HOURS * 3600 * 1000) } : {}),
      paid_at: o.paid_at,
      total_php: Number(o.total_amount),
      shipping_fee_php: Number(o.shipping_fee),
      courier: o.courier ? COURIER_LABEL[o.courier] : null,
      items: items.filter((i) => i.order_id === o.order_id).map((i) => ({ name: i.name, quantity: i.quantity })),
      shipment: s ? { status: s.status, tracking_number: s.tracking_number, tracking_url: s.tracking_url, last_update: s.last_update } : null,
    };
  });
  return { orders: result, note: 'Order details are also on the My orders page.' };
}

// ------------------------------------------------------------ declarations
const DECLARATIONS = [
  {
    name: 'search_products',
    description: 'Search the parts Bongalink sells right now, with price and available stock. Use for any question about what we sell, prices, or whether something is in stock.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search words, e.g. "epson l3110 printhead" or "laptop battery".' },
        category: { type: 'string', description: 'Exact category name, only if the customer named one.' },
      },
    },
  },
  {
    name: 'get_product',
    description: 'Full details of one product (price, available stock, weight, description).',
    parametersJsonSchema: {
      type: 'object',
      properties: { product_id: { type: 'integer' } },
      required: ['product_id'],
    },
  },
  {
    name: 'get_shipping_quote',
    description: 'Shipping fees and delivery times to a place in the Philippines. With items: the exact J&T/LBC fees for those parts. Without items: the fee table by parcel weight.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        region: { type: 'string', enum: REGIONS, description: 'PSGC region code of the destination, e.g. VII for Cebu, NCR for Metro Manila, IV-A for Cavite/Laguna.' },
        province: { type: 'string', description: 'Province name, e.g. "Cebu" (needed for island provinces such as Palawan).' },
        city: { type: 'string' },
        lat: { type: 'number' },
        lng: { type: 'number' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { product_id: { type: 'integer' }, quantity: { type: 'integer' } },
            required: ['product_id'],
          },
        },
      },
      required: ['region'],
    },
  },
  {
    name: 'get_order_status',
    description: "Status, items and tracking of the logged-in customer's own orders. Without order_id: their latest orders.",
    parametersJsonSchema: {
      type: 'object',
      properties: { order_id: { type: 'integer', description: 'Order number, e.g. 1024 for "#1024".' } },
    },
  },
  {
    name: 'mark_unanswered',
    description: "Call this when you could not answer the customer's question from the tools or the FAQs (or it is not about the shop), before replying.",
    parametersJsonSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string', enum: ['no_information', 'needs_staff', 'off_topic'],
          description: 'no_information: shop info we do not have. needs_staff: a person must handle it (complaint, refund, payment problem, damaged parcel). off_topic: not about the shop.',
        },
        topic: { type: 'string', description: 'A few words on what was asked.' },
      },
      required: ['reason'],
    },
  },
];

// Runs one tool call. ctx = { user, state } (state collects mark_unanswered).
async function runTool(name, args = {}, ctx = {}) {
  switch (name) {
    case 'search_products': return searchProducts(args);
    case 'get_product': return getProduct(args);
    case 'get_shipping_quote': return shippingQuote(args);
    case 'get_order_status': return orderStatus(args, ctx);
    case 'mark_unanswered': {
      const reason = ['no_information', 'needs_staff', 'off_topic'].includes(args.reason) ? args.reason : 'no_information';
      if (ctx.state) ctx.state.unanswered = reason;
      return { ok: true };
    }
    default: return { error: 'unknown_tool' };
  }
}

module.exports = { DECLARATIONS, runTool, searchProducts, getProduct, shippingQuote, orderStatus };
