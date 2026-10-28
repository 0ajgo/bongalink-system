// "Forgot password": an emailed link to choose a new password.
// Same token rules as the account-setup links (services/accountSetup.js): a random token
// in the link, only its SHA-256 hash stored (password_setup_tokens, purpose 'reset'),
// single use, and here it expires after RESET_MINUTES. Asking again cancels older links.
//
// After a reset: every existing login for the account stops working (token_version + 1),
// the account holder gets a "your password was changed" email, and the reset is recorded
// in admin_audit_log. A suspended account never gets a link (it gets an email saying it's
// suspended instead), and a link can't be used once the account is suspended.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { mail } = require('./mailer');
const { hashToken } = require('./accountSetup');
const { newPasswordProblem } = require('../lib/passwordRule');
const { blindIndex } = require('../lib/dataProtection');
const { dec, logError } = require('../lib/pii');
const { endAllSessions } = require('../middleware/auth');

const RESET_MINUTES = 30;

const resetLink = (token) =>
  `${String(process.env.APP_URL || '').replace(/\/+$/, '')}/Pages/Homepage/reset-password.html?token=${token}`;

// Called for every request, whether or not the email has an account; the caller always
// gives the same answer. Never throws for an unknown email.
async function requestReset(email) {
  const index = blindIndex(email);
  if (!index) return;
  const [[user]] = await pool.query(
    'SELECT user_id, username, email, status FROM users WHERE email_bidx = ?', [index]);
  if (!user || user.status === 'deleted') return;
  const to = dec('users', 'email', user.email);
  if (user.status === 'suspended') {
    await mail.resetBlockedSuspended(to, user.username);
    return;
  }
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query("UPDATE password_setup_tokens SET used_at = NOW() WHERE user_id = ? AND purpose = 'reset' AND used_at IS NULL",
    [user.user_id]);
  await pool.query(
    "INSERT INTO password_setup_tokens (user_id, purpose, token_hash, expires_at) VALUES (?, 'reset', ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))",
    [user.user_id, hashToken(token), RESET_MINUTES]);
  await mail.passwordReset(to, user.username, resetLink(token), RESET_MINUTES);
}

// The account a reset link belongs to, if the link can still be used.
async function findReset(token, conn = pool, lock = false) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ''))) return null;
  const [[row]] = await conn.query(
    `SELECT t.token_id, u.user_id, u.username, u.email, u.status
       FROM password_setup_tokens t JOIN users u ON u.user_id = t.user_id
      WHERE t.token_hash = ? AND t.purpose = 'reset' AND t.used_at IS NULL AND t.expires_at > NOW()
        AND u.status <> 'deleted'${lock ? ' FOR UPDATE' : ''}`,
    [hashToken(token)]);
  return row || null;
}

// -> { username } | { error, code? }
async function completeReset(token, password) {
  const weak = newPasswordProblem(password);
  if (weak) return weak;
  const passwordHash = await bcrypt.hash(password, 10);
  const conn = await pool.getConnection();
  let reset;
  try {
    await conn.beginTransaction();
    reset = await findReset(token, conn, true);
    if (!reset) {
      await conn.rollback();
      return { error: 'This link is invalid, already used or expired. Ask for a new one from the login page.' };
    }
    if (reset.status === 'suspended') {
      await conn.rollback();
      return { error: 'Your account is suspended. Contact the shop.', code: 'ACCOUNT_SUSPENDED' };
    }
    // Now that the account is known: not its username or email name inside the password.
    const personal = newPasswordProblem(password, { username: reset.username, email: dec('users', 'email', reset.email) });
    if (personal) {
      await conn.rollback();
      return personal;
    }
    // token_version + 1 ends every existing login on every device.
    await conn.query(
      `UPDATE users SET password_hash = ?, token_version = token_version + 1, must_set_password = 0,
              email_verified_at = COALESCE(email_verified_at, NOW())
        WHERE user_id = ?`, [passwordHash, reset.user_id]);
    await conn.query('UPDATE password_setup_tokens SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL', [reset.user_id]);
    await endAllSessions(reset.user_id, conn);
    await conn.query(
      `INSERT INTO admin_audit_log (admin_id, admin_label, action, target_user_id, target_label, new_value)
       VALUES (?, ?, 'password_reset', ?, ?, ?)`,
      [reset.user_id, reset.username, reset.user_id, reset.username, JSON.stringify({ via: 'emailed reset link' })]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  // The reset is done either way; a failed notice is only logged.
  mail.passwordChanged(dec('users', 'email', reset.email), reset.username)
    .catch((err) => logError('Password-changed email failed', err));
  return { username: reset.username };
}

module.exports = { requestReset, findReset, completeReset, RESET_MINUTES };
