/* =====================================================================
   routes/account.js — the logged-in user's own account (REQ05, REQ06, REQ09)
   Mounted at /api/v1/account. Every route uses req.user.userId from the
   JWT, so a user can only ever read or change their own data.

     GET    /me                    profile (username, email, role, dates)
     PATCH  /me                    { username?, email?, current_password }
     POST   /password              { current_password, new_password }
     GET    /addresses             saved delivery addresses
     POST   /addresses             add one   { recipient_name, recipient_phone, street, lat?, lng?,
     PATCH  /addresses/:id         edit one    barangay, city, province?, region,
     DELETE /addresses/:id         delete      postal_code, landmark?, is_default? }
     POST   /addresses/:id/default make it the default

   The email and the personal address fields are stored encrypted
   (lib/pii.js); they are decrypted here for the owner only.

   Saved addresses live in delivery_addresses. Checkout always stores its
   own copy of the address with the order, so a "saved" address is one
   no order points to — editing or deleting it never changes an order.
   ===================================================================== */

const router = require("express").Router();
const bcrypt = require("bcryptjs");
const pool = require("../db");
const ah = require("../lib/asyncHandler");
const { requireAuth, startSession, endAllSessions } = require("../middleware/auth");
const { mail } = require("../services/mailer");
const { issueVerificationCode } = require("./emailVerification");
const { REGIONS, zoneFor } = require("../services/shippingRates");
const geocode = require("../services/geocode");
const { encryptAddress, decryptAddress, dec, emailColumns, logError } = require("../lib/pii");
const { blindIndex } = require("../lib/dataProtection");

router.use(requireAuth);

const { newPasswordProblem } = require("../lib/passwordRule");   // same rule as POST /api/auth/register
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,50}$/;
const PHONE_RE = /^(09\d{9}|639\d{9})$/;
const MAX_ADDRESSES = 10;

async function profile(userId) {
  const [[u]] = await pool.query(
    "SELECT user_id, username, email, role, created_at, email_verified_at FROM users WHERE user_id = ?",
    [userId]
  );
  return u && { ...u, email: dec("users", "email", u.email) };
}

/* ---------------------------------------------------------------- profile */
router.get("/me", ah(async (req, res) => {
  const u = await profile(req.user.userId);
  if (!u) return res.status(404).json({ error: "Account not found." });
  res.json(u);
}));

// Changing the email needs the current password, marks the new address
// unverified and emails it a fresh code.
router.patch("/me", ah(async (req, res) => {
  const current = await profile(req.user.userId);
  if (!current) return res.status(404).json({ error: "Account not found." });

  const username = req.body.username === undefined ? current.username : String(req.body.username).trim();
  const email = req.body.email === undefined ? current.email : String(req.body.email).trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: "Username must be 3–50 letters, numbers, dots, dashes or underscores." });
  }
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Enter a valid email address." });

  const emailChanged = email !== current.email.toLowerCase();
  if (emailChanged) {
    const [[row]] = await pool.query("SELECT password_hash FROM users WHERE user_id = ?", [req.user.userId]);
    const ok = req.body.current_password && await bcrypt.compare(String(req.body.current_password), row.password_hash);
    if (!ok) return res.status(400).json({ error: "Enter your current password to change your email." });
  }

  const [taken] = await pool.query(
    "SELECT username FROM users WHERE (username = ? OR email_bidx = ?) AND user_id <> ?",
    [username, blindIndex(email), req.user.userId]
  );
  if (taken.length) {
    const what = taken.some(t => t.username.toLowerCase() === username.toLowerCase()) ? "That username" : "That email";
    return res.status(409).json({ error: `${what} is already in use.` });
  }

  const stored = emailColumns(email);
  await pool.query(
    `UPDATE users SET username = ?, email = ?, email_bidx = ?, email_verified_at = IF(?, NULL, email_verified_at) WHERE user_id = ?`,
    [username, stored.email, stored.email_bidx, emailChanged, req.user.userId]
  );

  let emailSent = null;
  if (emailChanged) {
    try {
      await issueVerificationCode({ id: req.user.userId, name: username, email });
      emailSent = true;
    } catch (err) {
      emailSent = false;
      logError("Verification email failed", err);
    }
  }
  res.json({ ...(await profile(req.user.userId)), email_changed: emailChanged, email_sent: emailSent });
}));

/* ---------------------------------------------------------------- password */
router.post("/password", ah(async (req, res) => {
  const { current_password, new_password } = req.body || {};
  const weak = newPasswordProblem(new_password);
  if (weak) return res.status(400).json(weak);
  const [[row]] = await pool.query("SELECT password_hash FROM users WHERE user_id = ?", [req.user.userId]);
  if (!row || !current_password || !(await bcrypt.compare(String(current_password), row.password_hash))) {
    return res.status(400).json({ error: "Your current password is incorrect." });
  }
  if (await bcrypt.compare(String(new_password), row.password_hash)) {
    return res.status(400).json({ error: "Choose a password different from your current one." });
  }
  // A new password logs out every other device (token_version + 1 and their sessions ended);
  // this device gets a fresh login, kept the same way it was ("Remember me" or not).
  await pool.query("UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE user_id = ?",
    [await bcrypt.hash(String(new_password), 10), req.user.userId]);
  await endAllSessions(req.user.userId);
  const [[user]] = await pool.query(
    "SELECT user_id, username, role, token_version, email FROM users WHERE user_id = ?", [req.user.userId]);
  const session = await startSession(user, { remember: req.user.remember });
  mail.passwordChanged(dec("users", "email", user.email), user.username)
    .catch((err) => logError("Password-changed email failed", err));
  res.json({ message: "Password changed. Every other device was logged out.", token: session.token,
             remember: session.remember, expires_at: session.expiresAt });
}));

/* ---------------------------------------------------------------- addresses */
const ADDRESS_COLUMNS = `address_id, recipient_name, recipient_phone, street, barangay, city, province,
                         region, postal_code, landmark, lat, lng, shipping_zone, is_default, created_at`;
const NOT_USED_BY_ORDER = "NOT EXISTS (SELECT 1 FROM orders o WHERE o.address_id = a.address_id)";

async function savedAddresses(userId) {
  const [rows] = await pool.query(
    `SELECT ${ADDRESS_COLUMNS} FROM delivery_addresses a
     WHERE a.user_id = ? AND ${NOT_USED_BY_ORDER}
     ORDER BY a.is_default DESC, a.address_id DESC`,
    [userId]
  );
  return rows.map(r => ({ ...decryptAddress(r), is_default: Boolean(r.is_default) }));
}

async function ownSavedAddress(userId, id) {
  const [[row]] = await pool.query(
    `SELECT address_id FROM delivery_addresses a WHERE a.address_id = ? AND a.user_id = ? AND ${NOT_USED_BY_ORDER}`,
    [id, userId]
  );
  return row;
}

// Returns { values } or { error }. With a map pin (lat + lng), the region and the
// shipping zone come from where the pin is; the typed region is the fallback when
// the map lookup is unavailable.
async function readAddress(body = {}) {
  const s = (v) => (v === undefined || v === null ? "" : String(v).trim());
  const a = {
    recipient_name: s(body.recipient_name), recipient_phone: s(body.recipient_phone).replace(/[\s-]/g, ""),
    street: s(body.street), barangay: s(body.barangay), city: s(body.city), province: s(body.province) || null,
    region: s(body.region).toUpperCase(), postal_code: s(body.postal_code), landmark: s(body.landmark) || null
  };
  if (!a.recipient_name || !a.street || !a.barangay || !a.city) return { error: "Please complete all required address fields." };
  if (!PHONE_RE.test(a.recipient_phone)) return { error: "Enter an 11-digit mobile number starting with 09." };
  if (!REGIONS.includes(a.region)) return { error: "Choose a region." };
  if (!/^\d{4}$/.test(a.postal_code)) return { error: "Philippine postal codes are 4 digits." };
  if ([a.recipient_name, a.street, a.barangay, a.city, a.province, a.landmark].some(v => v && v.length > 255)) {
    return { error: "One of the fields is too long." };
  }
  const hasPin = body.lat !== undefined && body.lat !== null && body.lat !== "" &&
                 body.lng !== undefined && body.lng !== null && body.lng !== "";
  a.lat = hasPin ? Number(body.lat) : null;
  a.lng = hasPin ? Number(body.lng) : null;
  if (hasPin && !(a.lat >= 4 && a.lat <= 22 && a.lng >= 116 && a.lng <= 127)) {
    return { error: "The map pin is not a valid location in the Philippines." };
  }
  a.shipping_zone = zoneFor(a.region, a.province);
  if (hasPin) {
    try {
      const g = await geocode.reverse(a.lat, a.lng);
      a.region = g.region;
      a.province = g.province || a.province;
      a.shipping_zone = g.zone;
    } catch (e) {
      if (e.status === 400) return { error: e.message };
      logError("Pin lookup failed, using the typed region", e);
    }
  }
  return { values: a };
}

async function setDefault(conn, userId, id) {
  await conn.query("UPDATE delivery_addresses SET is_default = (address_id = ?) WHERE user_id = ?", [id, userId]);
}

router.get("/addresses", ah(async (req, res) => {
  res.json(await savedAddresses(req.user.userId));
}));

router.post("/addresses", ah(async (req, res) => {
  const { values, error } = await readAddress(req.body);
  if (error) return res.status(400).json({ error });
  const existing = await savedAddresses(req.user.userId);
  if (existing.length >= MAX_ADDRESSES) return res.status(400).json({ error: `You can save up to ${MAX_ADDRESSES} addresses.` });

  const e = encryptAddress(values);
  const [r] = await pool.query(
    `INSERT INTO delivery_addresses
       (user_id, recipient_name, recipient_phone, street, barangay, city, province, region,
        postal_code, landmark, lat, lng, shipping_zone, is_default)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [req.user.userId, e.recipient_name, e.recipient_phone, e.street, e.barangay, e.city,
     values.province, values.region, e.postal_code, e.landmark, e.lat, e.lng, values.shipping_zone]
  );
  if (req.body.is_default || existing.length === 0) await setDefault(pool, req.user.userId, r.insertId);
  res.status(201).json((await savedAddresses(req.user.userId)).find(a => a.address_id === r.insertId));
}));

router.patch("/addresses/:id", ah(async (req, res) => {
  if (!(await ownSavedAddress(req.user.userId, req.params.id))) return res.status(404).json({ error: "Address not found." });
  const { values, error } = await readAddress(req.body);
  if (error) return res.status(400).json({ error });
  const e = encryptAddress(values);
  await pool.query(
    `UPDATE delivery_addresses SET recipient_name = ?, recipient_phone = ?, street = ?, barangay = ?, city = ?,
            province = ?, region = ?, postal_code = ?, landmark = ?, lat = ?, lng = ?, shipping_zone = ?
     WHERE address_id = ? AND user_id = ?`,
    [e.recipient_name, e.recipient_phone, e.street, e.barangay, e.city, values.province,
     values.region, e.postal_code, e.landmark, e.lat, e.lng, values.shipping_zone, req.params.id, req.user.userId]
  );
  if (req.body.is_default) await setDefault(pool, req.user.userId, Number(req.params.id));
  res.json((await savedAddresses(req.user.userId)).find(a => a.address_id === Number(req.params.id)));
}));

router.post("/addresses/:id/default", ah(async (req, res) => {
  if (!(await ownSavedAddress(req.user.userId, req.params.id))) return res.status(404).json({ error: "Address not found." });
  await setDefault(pool, req.user.userId, Number(req.params.id));
  res.json(await savedAddresses(req.user.userId));
}));

router.delete("/addresses/:id", ah(async (req, res) => {
  if (!(await ownSavedAddress(req.user.userId, req.params.id))) return res.status(404).json({ error: "Address not found." });
  await pool.query("DELETE FROM delivery_addresses WHERE address_id = ? AND user_id = ?", [req.params.id, req.user.userId]);
  // Keep a default if any saved address is left.
  const left = await savedAddresses(req.user.userId);
  if (left.length && !left.some(a => a.is_default)) await setDefault(pool, req.user.userId, left[0].address_id);
  res.json(await savedAddresses(req.user.userId));
}));

module.exports = router;
