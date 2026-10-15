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
   ===================================================================== */

const jwt = require("jsonwebtoken");
const pool = require("../db");

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Not logged in." });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { userId, username, role }
    next();
  } catch (err) {
    return res.status(401).json({ error: "Session expired or invalid. Please log in again." });
  }
}

// For routes that also serve visitors (the chat): sets req.user when a valid token
// is sent, otherwise carries on as a guest. An expired token is treated as a guest.
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  req.user = null;
  if (token) {
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      req.user = null;
    }
  }
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
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

module.exports = { requireAuth, optionalAuth, requireAdmin, requireRole, requireVerifiedEmail };