// Email Verification API - 6-digit code sent on registration (supports REQ01, REQ027, REQ030).
// Mounted at /api/v1/auth/verify-email
const router = require('express').Router();
const crypto = require('crypto');
const pool = require('../db');
const ah = require('../lib/asyncHandler');
const { mail } = require('../services/mailer');
const { blindIndex } = require('../lib/dataProtection');
const { dec } = require('../lib/pii');

const CODE_TTL_MIN = 15;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SEC = 60;

// Codes are stored as an HMAC, never in plain text.
const hashCode = (userId, code) =>
  crypto.createHmac('sha256', process.env.VERIFICATION_SECRET).update(`${userId}:${code}`).digest('hex');

// Called by POST /api/auth/register right after inserting the user.
// user = { id, name, email }
async function issueVerificationCode(user) {
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  await pool.query('DELETE FROM email_verifications WHERE user_id = ? AND used_at IS NULL', [user.id]);
  await pool.query(
    'INSERT INTO email_verifications (user_id, code_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))',
    [user.id, hashCode(user.id, code), CODE_TTL_MIN]
  );
  await mail.verificationCode(user.email, user.name, code, CODE_TTL_MIN);
}

const normEmail = (e) => String(e || '').trim().toLowerCase();

// POST /send  { email }  - send or resend a code
router.post('/send', ah(async (req, res) => {
  const email = normEmail(req.body.email);
  if (!email) return res.status(400).json({ error: 'Email is required' });
  // Same reply whether or not the account exists, so emails can't be probed.
  const generic = { message: 'If that email is registered and not yet verified, a code has been sent.' };

  // Emails are stored encrypted; the blind index finds the account by exact email.
  const [[row]] = await pool.query(
    'SELECT user_id AS id, username AS name, email, email_verified_at FROM users WHERE email_bidx = ?',
    [blindIndex(email)]
  );
  if (!row || row.email_verified_at) return res.json(generic);
  const user = { ...row, email: dec('users', 'email', row.email) };

  const [[last]] = await pool.query(
    `SELECT TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age FROM email_verifications
      WHERE user_id = ? ORDER BY verification_id DESC LIMIT 1`,
    [user.id]
  );
  if (last && last.age < RESEND_COOLDOWN_SEC) {
    return res.status(429).json({ error: `Please wait ${RESEND_COOLDOWN_SEC - last.age}s before requesting a new code` });
  }

  await issueVerificationCode(user);
  res.json(generic);
}));

// POST /confirm  { email, code }
router.post('/confirm', ah(async (req, res) => {
  const email = normEmail(req.body.email);
  const code = String(req.body.code || '').trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code' });

  const [[user]] = await pool.query('SELECT user_id AS id, email_verified_at FROM users WHERE email_bidx = ?', [blindIndex(email)]);
  if (!user) return res.status(400).json({ error: 'Invalid or expired code' });
  if (user.email_verified_at) return res.json({ message: 'Email already verified' });

  const [[row]] = await pool.query(
    `SELECT verification_id AS id, code_hash, attempts, (expires_at < NOW()) AS expired
       FROM email_verifications WHERE user_id = ? AND used_at IS NULL ORDER BY verification_id DESC LIMIT 1`,
    [user.id]
  );
  if (!row || row.expired) return res.status(400).json({ error: 'Code expired. Request a new one.' });
  if (row.attempts >= MAX_ATTEMPTS) return res.status(429).json({ error: 'Too many wrong attempts. Request a new code.' });

  const ok = crypto.timingSafeEqual(Buffer.from(row.code_hash, 'hex'), Buffer.from(hashCode(user.id, code), 'hex'));
  if (!ok) {
    await pool.query('UPDATE email_verifications SET attempts = attempts + 1 WHERE verification_id = ?', [row.id]);
    return res.status(400).json({ error: 'Incorrect code', attemptsLeft: MAX_ATTEMPTS - row.attempts - 1 });
  }

  await pool.query('UPDATE email_verifications SET used_at = NOW() WHERE verification_id = ?', [row.id]);
  await pool.query('UPDATE users SET email_verified_at = NOW() WHERE user_id = ?', [user.id]);
  res.json({ message: 'Email verified' });
}));

module.exports = { router, issueVerificationCode };
