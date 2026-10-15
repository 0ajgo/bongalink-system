/* =====================================================================
   middleware/auth.js
   - requireAuth  : any logged-in user (user or admin)
   - optionalAuth : the logged-in user if a valid token is sent, else a guest
   - requireAdmin : must be logged in AND role === "admin"
   - requireRole  : after requireAuth, allow only the listed roles
   - requireVerifiedEmail : after requireAuth, block unverified emails
     (this is the server-side version of isAdmin() that used to only
     live in Homepage.js — the real gate now lives here, since a
     frontend-only check can be bypassed in devtools)

   Every request also checks the account in the database (migration 008):
   - suspended accounts get 403 ACCOUNT_SUSPENDED, so a suspension works
     at once, even with a token issued before it;
   - deleted (anonymized) accounts, and tokens older than the account's
     token_version (bumped on suspend and role change), get 401
     SESSION_ENDED: the user is logged out;
   - the role comes from the database, never from the token;
   - a token from a login (migration 011) names its session in
     user_sessions: once that session is logged out or expired, the
     token stops working (SESSION_ENDED), even a 30-day "Remember me" one.
   ===================================================================== */

const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const pool = require("../db");

const REMEMBER_DAYS = 30;

const SUSPENDED = { error: "Your account is suspended. Contact the shop.", code: "ACCOUNT_SUSPENDED" };
const ENDED = { error: "Your session has ended. Please log in again.", code: "SESSION_ENDED" };

const bearer = (req) => {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
};

// -> { user } for a usable token, or { status, body } saying why not.
async function checkToken(token) {
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return { status: 401, body: { error: "Session expired or invalid. Please log in again." } };
  }
  const [[account]] = await pool.query(
    `SELECT u.username, u.role, u.status, u.token_version,
            s.session_id, s.remember, s.revoked_at, (s.expires_at <= NOW()) AS session_expired
       FROM users u LEFT JOIN user_sessions s ON s.session_id = ? AND s.user_id = u.user_id
      WHERE u.user_id = ?`, [payload.sid ?? null, payload.userId]);
  if (!account || account.status === "deleted") return { status: 401, body: ENDED };
  if (account.status === "suspended") return { status: 403, body: SUSPENDED };
  // Tokens from before migration 008 carry no version: they count as version 0.
  if ((payload.tv ?? 0) !== account.token_version) return { status: 401, body: ENDED };
  // Logged out on this device, or past its lifetime. (Tokens from before 011 have no session.)
  if (payload.sid && (!account.session_id || account.revoked_at || account.session_expired)) return { status: 401, body: ENDED };
  return { user: { userId: payload.userId, username: account.username, role: account.role,
                   sessionId: payload.sid || null, remember: Boolean(account.remember) } };
}

async function requireAuth(req, res, next) {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: "Not logged in." });
  try {
    const result = await checkToken(token);
    if (!result.user) return res.status(result.status).json(result.body);
    req.user = result.user; // { userId, username, role }
    next();
  } catch (err) {
    next(err);
  }
}

// For routes that also serve visitors (the chat): sets req.user when a usable token
// is sent, otherwise carries on as a guest (expired, suspended or logged-out tokens too).
async function optionalAuth(req, res, next) {
  req.user = null;
  const token = bearer(req);
  if (token) {
    try {
      req.user = (await checkToken(token)).user || null;
    } catch (err) {
      req.user = null;
    }
  }
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, (err) => {
    if (err) return next(err);
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Admin account required." });
    }
    next();
  });
}

// Use after requireAuth. Roles are "user" (customer) and "admin".
const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user?.role) ? next() : res.status(403).json({ error: "You don't have access to this." });

// Use after requireAuth. Blocks checkout until the customer has verified
// their email (POST /api/v1/auth/verify-email/confirm).
async function requireVerifiedEmail(req, res, next) {
  try {
    const [[user]] = await pool.query("SELECT email_verified_at FROM users WHERE user_id = ?", [req.user.userId]);
    if (!user?.email_verified_at) {
      return res.status(403).json({ error: "Please verify your email first.", code: "EMAIL_NOT_VERIFIED" });
    }
    next();
  } catch (err) {
    next(err);
  }
}

// A login on one device: a user_sessions row and a token naming it. "Remember me" lasts
// REMEMBER_DAYS (the browser keeps it after closing); otherwise JWT_EXPIRES_IN, and the
// browser forgets it when the tab closes. -> { token, expiresAt, remember }
async function startSession(user, { remember = false, conn = pool } = {}) {
  const sessionId = crypto.randomBytes(16).toString("hex");
  const token = jwt.sign(
    { userId: user.user_id, username: user.username, role: user.role, tv: user.token_version || 0, sid: sessionId },
    process.env.JWT_SECRET,
    { expiresIn: remember ? `${REMEMBER_DAYS}d` : process.env.JWT_EXPIRES_IN || "7d" }
  );
  const { exp } = jwt.decode(token);
  // Tidy up this account's old sessions while we're here.
  await conn.query(
    "DELETE FROM user_sessions WHERE user_id = ? AND (expires_at < NOW() - INTERVAL 1 DAY OR revoked_at < NOW() - INTERVAL 1 DAY)",
    [user.user_id]);
  await conn.query("INSERT INTO user_sessions (session_id, user_id, remember, expires_at) VALUES (?, ?, ?, FROM_UNIXTIME(?))",
    [sessionId, user.user_id, remember ? 1 : 0, exp]);
  return { token, expiresAt: new Date(exp * 1000), remember: Boolean(remember) };
}

// Logs out one device: its session stops working at once. A bad or expired token is ignored.
async function endSession(token) {
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true });
  } catch (err) {
    return false;
  }
  if (!payload.sid) return false;
  const [r] = await pool.query("UPDATE user_sessions SET revoked_at = NOW() WHERE session_id = ? AND user_id = ? AND revoked_at IS NULL",
    [payload.sid, payload.userId]);
  return r.affectedRows > 0;
}

// Ends every session of an account (password change, reset).
const endAllSessions = (userId, conn = pool) =>
  conn.query("UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL", [userId]);

// A token without a session (scripts, tests): carries token_version as `tv` (see requireAuth).
function signToken(user) {
  return jwt.sign(
    { userId: user.user_id, username: user.username, role: user.role, tv: user.token_version || 0 },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );
}

module.exports = { requireAuth, optionalAuth, requireAdmin, requireRole, requireVerifiedEmail, signToken,
                   startSession, endSession, endAllSessions, bearer, REMEMBER_DAYS, SUSPENDED };
