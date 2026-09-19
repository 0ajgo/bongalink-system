/* =====================================================================
   api.js — shared fetch helper for all pages
   Include this BEFORE Homepage.js / login.js / register.js in each
   HTML file.

   THIS is the one line that changes when you move from your local
   machine to Hostinger/AWS — nothing else in the frontend needs to
   change:
     - while developing locally:  http://localhost:4000/api
     - once hosted:                https://api.yourdomain.com/api
   ===================================================================== */

const API_BASE_URL = "http://localhost:4000/api";

/**
 * Wraps fetch() with the API base URL, JSON handling, and the
 * logged-in user's auth token (if any). Throws an Error with the
 * server's message on non-2xx responses so callers can catch() it.
 */
async function apiFetch(path, options = {}) {
  const token = sessionStorage.getItem("bongalink_token");

  const headers = { ...(options.headers || {}) };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  // Only set Content-Type: JSON when we're not sending a file (FormData
  // sets its own multipart boundary header automatically).
  if (!(options.body instanceof FormData) && options.body) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });

  // .catch(() => ({})) guards against a body that isn't valid JSON (an
  // empty 204 response, or a proxy/500 page instead of Express's own
  // JSON error) — without it, a bad response would throw *inside* the
  // error-handling below and hide the real HTTP status from callers.
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    // Every route in Backend/routes/*.js responds with { error: "..." }
    // on failure, so this is what callers' catch(err) => err.message
    // blocks are usually showing the user.
    throw new Error(data.error || "Something went wrong.");
  }
  return data;
}

/* Shared auth-check helpers — used by Homepage.js and by the checkout.html
   inline script, since both need to gate actions on being logged in. */
function isLoggedIn() {
  return sessionStorage.getItem("bongalink_logged_in") === "true";
}

// UI hint only — the server enforces the real admin check on every
// admin-only request via the requireAdmin middleware.
function isAdmin() {
  return isLoggedIn() && sessionStorage.getItem("bongalink_role") === "admin";
}
