/* =====================================================================
   scripts/demo-pay.js — DEV ONLY. Plays PayMongo's "checkout_session.payment.paid"
   webhook for one order, for when the real one can't reach this computer.

     npm run demo:pay -- <order_id>
       --url <webhook url>   default http://localhost:<PORT or 4000>/api/v1/webhooks/paymongo

   Reads the order's latest payments row (checkout_session_id, amount_centavos) from
   DB_NAME, signs the event with PAYMONGO_WEBHOOK_SECRET exactly like PayMongo does in
   test mode (Paymongo-Signature: t=...,te=...), and posts it to the running API, which
   then marks the order paid the normal way (routes/payments.js): status, stock, the
   inventory_movements "sale" row and the admin "New sale" alert. Running it twice is
   safe: the API processes a paid order once.

   Refuses to run with a live PayMongo key or NODE_ENV=production. Prints no secrets.
   ===================================================================== */
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const mysql = require('mysql2/promise');

const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const orderId = Number(args.find((a) => /^\d+$/.test(a)));
const url = arg('--url', `http://localhost:${process.env.PORT || 4000}/api/v1/webhooks/paymongo`);

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function main() {
  if (!orderId) fail('Usage: npm run demo:pay -- <order_id> [--url <webhook url>]');
  if (process.env.NODE_ENV === 'production') fail('demo:pay is for development only (NODE_ENV=production).');
  if (!String(process.env.PAYMONGO_SECRET_KEY || '').startsWith('sk_test_')) fail('demo:pay needs a PayMongo TEST key (sk_test_...) in .env.');
  if (!process.env.PAYMONGO_WEBHOOK_SECRET) fail('PAYMONGO_WEBHOOK_SECRET is not set in .env.');

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  let order, payment;
  try {
    [[order]] = await conn.query('SELECT order_id, status FROM orders WHERE order_id = ?', [orderId]);
    [[payment]] = await conn.query(
      'SELECT checkout_session_id, amount_centavos, status FROM payments WHERE order_id = ? ORDER BY payment_id DESC LIMIT 1', [orderId]);
  } finally {
    await conn.end();
  }
  if (!order) fail(`Order ${orderId} not found in ${process.env.DB_NAME}.`);
  if (!payment) fail(`Order ${orderId} has no payment yet: open its checkout ("Pay now") first.`);
  console.log(`Order ${orderId}: ${order.status}; payment ${payment.status}, session ${payment.checkout_session_id}, ${payment.amount_centavos} centavos`);
  if (order.status !== 'pending_payment') console.log('The order is not pending payment: the API will leave it as it is (or flag a late payment for review).');

  const eventId = `evt_demo_${orderId}_${Date.now()}`;
  const body = JSON.stringify({
    data: {
      id: eventId,
      type: 'event',
      attributes: {
        type: 'checkout_session.payment.paid',
        livemode: false,
        data: {
          id: payment.checkout_session_id,
          attributes: { payment_method_used: 'gcash', payments: [{ id: `pay_demo_${orderId}`, attributes: { amount: payment.amount_centavos } }] },
        },
      },
    },
  });
  const t = Math.floor(Date.now() / 1000);
  const te = crypto.createHmac('sha256', process.env.PAYMONGO_WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex');

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Paymongo-Signature': `t=${t},te=${te},li=` },
    body,
  });
  console.log(`POST ${url} (${eventId}) -> HTTP ${res.status} ${await res.text()}`);
  if (!res.ok) fail('The API refused the webhook; its log says why.');
}

main().catch((err) => fail(err.message));
