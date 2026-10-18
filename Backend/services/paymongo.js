// PayMongo client: Checkout Sessions + webhook signature verification.
// Test keys (sk_test_...) move no real money; the key prefix decides the mode.
const crypto = require('crypto');

const BASE = 'https://api.paymongo.com/v1';
const TIMEOUT_MS = 15000;   // per PayMongo request

class PaymentError extends Error {}

const authHeader = () => 'Basic ' + Buffer.from(`${process.env.PAYMONGO_SECRET_KEY}:`).toString('base64');

// fetch to PayMongo that gives up after TIMEOUT_MS -> parsed JSON body, or a PaymentError.
async function call(path, options = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: authHeader() },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new PaymentError(err.name === 'TimeoutError' ? "PayMongo didn't answer in time. Please try again."
      : "PayMongo can't be reached right now. Please try again.");
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new PaymentError(json.errors?.[0]?.detail || `PayMongo error ${res.status}`);
  return json;
}

// REQ03: GCash + bank transfer. Bank options in PayMongo:
//   qrph (pay from any bank/e-wallet app), dob (BPI online), dob_ubp (UnionBank online),
//   brankas_bdo, brankas_landbank, brankas_metrobank.
// Only methods activated on your PayMongo account will work.
const methods = () =>
  (process.env.PAYMONGO_METHODS || 'gcash,qrph,dob,dob_ubp').split(',').map((m) => m.trim()).filter(Boolean);

async function createCheckoutSession({ referenceNumber, description, lineItems, customer, successUrl, cancelUrl }) {
  const billing = { name: customer.name, email: customer.email };
  if (customer.phone) billing.phone = customer.phone;

  const json = await call('/checkout_sessions', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        attributes: {
          line_items: lineItems, // [{ name, quantity, amount (centavos), currency: 'PHP' }]
          payment_method_types: methods(),
          reference_number: referenceNumber,
          description,
          billing,
          success_url: successUrl,
          cancel_url: cancelUrl,
          send_email_receipt: true,
          show_description: true,
          show_line_items: true,
        },
      },
    }),
  });
  return { id: json.data.id, checkoutUrl: json.data.attributes.checkout_url };
}

// An existing session: still payable ('active', nothing paid), already paid, or expired.
// -> { id, checkoutUrl, status: 'active' | 'paid' | 'expired' }
async function getCheckoutSession(id) {
  const json = await call(`/checkout_sessions/${encodeURIComponent(id)}`);
  const a = json.data.attributes;
  const paid = Boolean(a.paid_at) || (a.payments || []).length > 0;
  return { id: json.data.id, checkoutUrl: a.checkout_url, status: paid ? 'paid' : a.status === 'active' ? 'active' : 'expired' };
}

// Header format: "t=<timestamp>,te=<test signature>,li=<live signature>"
// Signature = HMAC-SHA256(webhook secret, `${t}.${rawBody}`)
function verifyWebhookSignature(rawBody, header, secret, livemode) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    })
  );
  const provided = livemode ? parts.li : parts.te;
  if (!parts.t || !provided) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { createCheckoutSession, getCheckoutSession, verifyWebhookSignature, PaymentError };
