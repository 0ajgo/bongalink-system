/* =====================================================================
   middleware/auth.js
   - requireAuth  : any logged-in user (user or admin)
   - requireAdmin : must be logged in AND role === "admin"
     (this is the server-side version of isAdmin() that used to only
     live in Homepage.js — the real gate now lives here, since a
     frontend-only check can be bypassed in devtools)
   ===================================================================== */

const jwt = require("jsonwebtoken");

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

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Admin account required." });
    }
    next();
  });
}

module.exports = { requireAuth, requireAdmin };