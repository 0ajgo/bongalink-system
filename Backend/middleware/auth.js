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
   - the role comes from the database, never from the token.
   ===================================================================== */

const jwt = require("jsonwebtoken");
const pool = require("../db");

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
    "SELECT username, role, status, token_version FROM users WHERE user_id = ?", [payload.userId]);
  if (!account || account.status === "deleted") return { status: 401, body: ENDED };
  if (account.status === "suspended") return { status: 403, body: SUSPENDED };
  // Tokens from before migration 008 carry no version: they count as version 0.
  if ((payload.tv ?? 0) !== account.token_version) return { status: 401, body: ENDED };
  return { user: { userId: payload.userId, username: account.username, role: account.role } };
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

// The token for a user: carries token_version as `tv` (see requireAuth).
function signToken(user) {
  return jwt.sign(
    { userId: user.user_id, username: user.username, role: user.role, tv: user.token_version || 0 },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );
}

module.exports = { requireAuth, optionalAuth, requireAdmin, requireRole, requireVerifiedEmail, signToken, SUSPENDED };
