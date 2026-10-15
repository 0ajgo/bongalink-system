// Accounts created by an admin (REQ010): the user gets an emailed link to confirm
// their email and choose a password. Until then the account has no usable password
// (users.must_set_password = 1) and can't log in.
//   - The link carries a random token; only its SHA-256 hash is stored.
//   - Single use, expires after SETUP_HOURS; sending a new link cancels older ones.
//   - Setting the password also marks the email as verified (opening the link proves it).
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { mail } = require('./mailer');
const { PRIVACY_POLICY_VERSION } = require('../lib/privacy');

const SETUP_HOURS = 72;
const MIN_PASSWORD = 6;   // same rule as POST /api/auth/register

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const setupLink = (token) =>
  `${String(process.env.APP_URL || '').replace(/\/+$/, '')}/Pages/Homepage/set-password.html?token=${token}`;

// A password nobody knows, for accounts waiting for setup.
const unusablePasswordHash = () => bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);

// user = { user_id, username, email (decrypted), role }. Throws if the email can't be sent.
async function sendSetupLink(user, adminId) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query('UPDATE password_setup_tokens SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL', [user.user_id]);
  await pool.query(
    'INSERT INTO password_setup_tokens (user_id, token_hash, expires_at, created_by) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR), ?)',
    [user.user_id, hashToken(token), SETUP_HOURS, adminId ?? null]);
  await mail.accountInvite(user.email, user.username, user.role, setupLink(token), SETUP_HOURS);
}

// The account a link belongs to, if the link can still be used.
async function findSetup(token, conn = pool, lock = false) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ''))) return null;
  const [[row]] = await conn.query(
    `SELECT t.token_id, u.user_id, u.username, u.role
       FROM password_setup_tokens t JOIN users u ON u.user_id = t.user_id
      WHERE t.token_hash = ? AND t.used_at IS NULL AND t.expires_at > NOW()
        AND u.must_set_password = 1 AND u.status = 'active'${lock ? ' FOR UPDATE' : ''}`,
    [hashToken(token)]);
  return row || null;
}

// -> { username } or { error }
async function completeSetup(token, password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    return { error: `Password must be at least ${MIN_PASSWORD} characters.` };
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const setup = await findSetup(token, conn, true);
    if (!setup) {
      await conn.rollback();
      return { error: 'This link is invalid, already used or expired. Ask the shop to send a new one.' };
    }
    await conn.query(
      `UPDATE users SET password_hash = ?, must_set_password = 0, email_verified_at = COALESCE(email_verified_at, NOW())
        WHERE user_id = ?`, [passwordHash, setup.user_id]);
    await conn.query('UPDATE password_setup_tokens SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL', [setup.user_id]);
    // The set-password page requires accepting the privacy notice (checked by the route).
    await conn.query(
      `INSERT INTO consent_records (user_id, consent_type, granted, policy_version, source)
       VALUES (?, 'PRIVACY_NOTICE', 1, ?, 'account_setup')`, [setup.user_id, PRIVACY_POLICY_VERSION]);
    await conn.commit();
    return { username: setup.username };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { sendSetupLink, findSetup, completeSetup, unusablePasswordHash, SETUP_HOURS, MIN_PASSWORD };
