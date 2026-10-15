// Shared fixtures for the API tests. Every test file starts from empty tables.
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const { emailColumns, encryptAddress, decryptAddress, enc } = require("../lib/pii");

const TABLES = [
  "user_sessions", "ml_training_runs", "admin_audit_log", "password_setup_tokens", "chat_logs", "faqs", "product_changes", "product_images", "shipment_events", "payment_events", "payments", "inventory_movements", "email_verifications",
  "deliveries", "consent_records", "order_items", "orders", "delivery_addresses",
  "cart_items", "carts", "ml_events", "products", "categories", "users"
];

async function resetDb() {
  if (process.env.DB_NAME !== "bongalink_test") throw new Error("Refusing to reset a non-test database");
  const conn = await pool.getConnection();
  try {
    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const t of TABLES) await conn.query(`TRUNCATE TABLE ${t}`);
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    conn.release();
  }
}

let seq = 0;

async function createUser({ role = "user", verified = true, email } = {}) {
  seq++;
  const username = `${role}${seq}`;
  // Stored the way the app stores it: encrypted, with the blind index.
  const stored = emailColumns(email || `${username}@example.com`);
  const [r] = await pool.query(
    "INSERT INTO users (username, email, email_bidx, password_hash, role, email_verified_at) VALUES (?, ?, ?, 'x', ?, ?)",
    [username, stored.email, stored.email_bidx, role, verified ? new Date() : null]
  );
  const token = jwt.sign({ userId: r.insertId, username, role }, process.env.JWT_SECRET);
  return { id: r.insertId, username, email: email || `${username}@example.com`, token, auth: `Bearer ${token}` };
}

async function createProduct({ price = 500, stock = 10, reserved = 0, weightKg = 0.5, createdBy } = {}) {
  const [[cat]] = await pool.query("SELECT category_id FROM categories LIMIT 1");
  let categoryId = cat?.category_id;
  if (!categoryId) {
    [{ insertId: categoryId }] = await pool.query("INSERT INTO categories (name) VALUES ('Parts')");
  }
  const owner = createdBy || (await createUser({ role: "admin" })).id;
  const [r] = await pool.query(
    `INSERT INTO products (name, category_id, price, stock_quantity, reserved, weight_kg, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [`Product ${++seq}`, categoryId, price, stock, reserved, weightKg, owner]
  );
  return r.insertId;
}

// A delivery address row, encrypted like the app writes it. -> address_id
async function insertAddress(userId, overrides = {}) {
  const a = { recipient_name: "Juan Dela Cruz", recipient_phone: "09171234567", street: "123 Mabini St", barangay: "Pembo",
    city: "Makati", postal_code: "1218", landmark: null, lat: null, lng: null, province: null, region: "NCR", shipping_zone: "NCR",
    is_default: 0, ...overrides };
  const e = encryptAddress(a);
  const [r] = await pool.query(
    `INSERT INTO delivery_addresses (user_id, recipient_name, recipient_phone, street, barangay, city, province, region,
       postal_code, landmark, lat, lng, shipping_zone, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, e.recipient_name, e.recipient_phone, e.street, e.barangay, e.city, a.province, a.region,
     e.postal_code, e.landmark, e.lat, e.lng, a.shipping_zone, a.is_default]);
  return r.insertId;
}

// Reads delivery_addresses rows back decrypted.
async function addressRows(where = "1 = 1", params = []) {
  const [rows] = await pool.query(`SELECT * FROM delivery_addresses WHERE ${where} ORDER BY address_id`, params);
  return rows.map((r) => decryptAddress(r));
}

async function fillCart(userId, items) {
  const [r] = await pool.query("INSERT INTO carts (user_id) VALUES (?) ON DUPLICATE KEY UPDATE cart_id = LAST_INSERT_ID(cart_id)", [userId]);
  for (const { productId, quantity } of items) {
    await pool.query("INSERT INTO cart_items (cart_id, product_id, quantity) VALUES (?, ?, ?)", [r.insertId, productId, quantity]);
  }
}

// A valid checkout body; override parts per test.
function orderBody(overrides = {}) {
  return {
    contact: { email: "buyer@example.com", phone: "09171234567" },
    recipient: { firstName: "Juan", lastName: "Dela Cruz" },
    address: {
      street: "123 Street", barangay: "Pembo", city: "Makati", province: null,
      postalCode: "1218", landmark: null, region: "NCR"
    },
    courier: "JNT",
    payment: { method: "GCASH" },
    consent: { marketing: false, policyVersion: "test" },
    ...overrides
  };
}

async function product(productId) {
  const [[p]] = await pool.query("SELECT stock_quantity, reserved FROM products WHERE product_id = ?", [productId]);
  return p;
}

// PayMongo webhook payload + Paymongo-Signature header (test mode signature).
function paymongoEvent({ eventId = "evt_1", sessionId = "cs_test_1", amount, method = "gcash" }) {
  const body = JSON.stringify({
    data: {
      id: eventId,
      type: "event",
      attributes: {
        type: "checkout_session.payment.paid",
        livemode: false,
        data: {
          id: sessionId,
          attributes: { payment_method_used: method, payments: [{ id: "pay_1", attributes: { amount } }] }
        }
      }
    }
  });
  return { body, signature: signPaymongo(body) };
}

function signPaymongo(body, secret = process.env.PAYMONGO_WEBHOOK_SECRET) {
  const t = Math.floor(Date.now() / 1000);
  const te = crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},te=${te},li=`;
}

module.exports = { pool, resetDb, createUser, createProduct, fillCart, orderBody, product, paymongoEvent, signPaymongo,
                   insertAddress, addressRows, enc };
