// Which columns hold personal information, and helpers to read and write them
// (encryption itself is in lib/dataProtection.js). Also masking for admin lists and
// a logger that never prints personal data.
//
// Encrypted:  users.email (+ email_bidx blind index), users.suspended_reason,
//             orders.contact_email,
//             delivery_addresses.recipient_name, recipient_phone, street, barangay, city,
//               postal_code, landmark, lat, lng,
//             chat_logs.message, chat_logs.reply, admin_audit_log.reason
// Plain:      delivery_addresses.province, region, shipping_zone (coarse areas, kept for
//             delivery-area reports and on anonymized orders); usernames (login lookup).
const { encrypt, decrypt, blindIndex } = require('./dataProtection');

const ADDRESS_FIELDS = ['recipient_name', 'recipient_phone', 'street', 'barangay', 'city', 'postal_code', 'landmark', 'lat', 'lng'];
const ENCRYPTED_COLUMNS = {
  users: ['email', 'suspended_reason'],
  orders: ['contact_email'],
  delivery_addresses: ADDRESS_FIELDS,
  chat_logs: ['message', 'reply'],
  admin_audit_log: ['reason'],
};

// --- addresses ---------------------------------------------------------------
// address = { recipient_name, recipient_phone, street, ... lat, lng } (any subset)
function encryptAddress(address) {
  const out = {};
  for (const f of ADDRESS_FIELDS) if (f in address) out[f] = encrypt(address[f], `delivery_addresses.${f}`);
  return out;
}

// Decrypts address columns of a row. `alias` maps field -> the row's column name
// when the query renamed them (e.g. { recipient_name: 'ship_name' }).
function decryptAddress(row, alias = {}) {
  if (!row) return row;
  const out = { ...row };
  for (const f of ADDRESS_FIELDS) {
    const col = alias[f] || f;
    if (!(col in out)) continue;
    const value = decrypt(out[col], `delivery_addresses.${f}`);
    out[col] = (f === 'lat' || f === 'lng') ? (value === null || value === '' ? null : Number(value)) : value;
  }
  return out;
}

// "123 Street, Barangay, City, Province, 1234" from a decrypted address.
const addressLine = (a) => [a.street, a.barangay, a.city, a.province, a.postal_code].filter(Boolean).join(', ');

// --- single columns -------------------------------------------------------------
const enc = (table, column, value) => encrypt(value, `${table}.${column}`);
const dec = (table, column, value) => decrypt(value, `${table}.${column}`);

// The email to write to about an order: the checkout contact email, else the account's.
// Queries select them as contact_email and account_email.
const orderEmail = (row) => dec('orders', 'contact_email', row.contact_email) || dec('users', 'email', row.account_email);

// The two columns a stored email needs.
const emailColumns = (email) => ({ email: enc('users', 'email', email), email_bidx: blindIndex(email) });

// --- masking (admin lists) ---------------------------------------------------------
function maskEmail(email) {
  const text = String(email || '');
  const at = text.lastIndexOf('@');
  if (at < 1) return text ? '***' : '';
  return `${text[0]}***${text.slice(at)}`;
}
function maskPhone(phone) {
  const digits = String(phone || '');
  if (digits.length < 7) return digits ? '***' : '';
  return `${digits.slice(0, 4)}****${digits.slice(-3)}`;
}

// Emails and phone numbers inside free text (chat messages in admin lists, logs).
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_IN_TEXT = /(?:\+?63[\s-]?|\b0)9\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/g;
const maskText = (text) => String(text ?? '')
  .replace(EMAIL_IN_TEXT, (m) => maskEmail(m))
  .replace(PHONE_IN_TEXT, (m) => maskPhone(m.replace(/[\s-]/g, '')));

// --- logging ------------------------------------------------------------------------
// Error messages can carry personal data (a mail server echoing the recipient, a SQL
// error quoting a value). Log only a short, scrubbed message and the error code;
// never the error object (mysql2 errors include the full SQL with its values).
function redactForLog(text) {
  return String(text ?? '')
    .replace(EMAIL_IN_TEXT, '[email]')
    .replace(PHONE_IN_TEXT, '[phone]')
    .replace(/enc:v\d+:[A-Za-z0-9+/=]+/g, '[encrypted]')
    .replace(/'[^']{0,500}'/g, "'…'")       // quoted values in SQL errors
    .slice(0, 300);
}
function logError(context, err) {
  const code = err && (err.code || err.status || err.name);
  console.error(`${context}${code ? ` (${code})` : ''}: ${redactForLog(err && err.message)}`);
}

module.exports = {
  ADDRESS_FIELDS, ENCRYPTED_COLUMNS, encryptAddress, decryptAddress, addressLine, enc, dec, emailColumns, orderEmail,
  maskEmail, maskPhone, maskText, redactForLog, logError,
};
