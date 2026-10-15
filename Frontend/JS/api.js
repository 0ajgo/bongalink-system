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

/* --- The stored login -------------------------------------------------
   A normal login lives in sessionStorage: this tab only, gone when it
   closes. "Remember me" puts it in localStorage instead, so it survives
   closing the browser, for the 30 days the server allows. The server
   still decides: suspension, a role or password change, or logging out
   ends the login on the next request, whichever kind it is. */
const AUTH_KEYS = ["bongalink_token", "bongalink_logged_in", "bongalink_role", "bongalink_username"];
const authStore = {
  get(key) {
    try { return sessionStorage.getItem(key) ?? localStorage.getItem(key); } catch (e) { return null; }
  },
  // data = { token, user: { role, username } } from POST /auth/login
  save(data, remember) {
    this.clear();
    const area = remember ? localStorage : sessionStorage;
    try {
      area.setItem("bongalink_token", data.token);
      area.setItem("bongalink_logged_in", "true");
      area.setItem("bongalink_role", data.user.role);
      area.setItem("bongalink_username", data.user.username);
    } catch (e) { /* storage blocked: this page stays logged out */ }
  },
  // Change one value wherever the login is kept (e.g. a new token after a password change).
  update(key, value) {
    try {
      const area = sessionStorage.getItem("bongalink_token") ? sessionStorage : localStorage;
      area.setItem(key, value);
    } catch (e) { /* ignore */ }
  },
  get remembered() {
    try { return !sessionStorage.getItem("bongalink_token") && Boolean(localStorage.getItem("bongalink_token")); } catch (e) { return false; }
  },
  clear() {
    for (const area of [sessionStorage, localStorage]) {
      try { AUTH_KEYS.forEach(k => area.removeItem(k)); } catch (e) { /* ignore */ }
    }
  }
};

// A remembered login past its 30 days is dropped before the page uses it.
(function dropExpiredLogin() {
  try {
    const token = localStorage.getItem("bongalink_token");
    if (!token) return;
    const { exp } = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (exp && exp * 1000 <= Date.now()) AUTH_KEYS.forEach(k => localStorage.removeItem(k));
  } catch (e) { /* not a token we can read: leave it to the server */ }
})();

// Log out: end this device's session on the server, then forget the login here.
// The local part always happens, even offline.
async function logOut() {
  const token = authStore.get("bongalink_token");
  authStore.clear();
  if (!token) return;
  try {
    await fetch(`${API_BASE_URL}/auth/logout`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, keepalive: true });
  } catch (e) { /* offline: the token is gone from this device anyway */ }
}

/**
 * Wraps fetch() with the API base URL, JSON handling, and the
 * logged-in user's auth token (if any). Throws an Error with the
 * server's message on non-2xx responses so callers can catch() it.
 */
async function apiFetch(path, options = {}) {
  const token = authStore.get("bongalink_token");

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
    // status/code let callers react to specific cases, e.g.
    // code "EMAIL_NOT_VERIFIED" on checkout.
    const error = new Error(data.error || "Something went wrong.");
    error.status = response.status;
    error.code = data.code;
    // Suspended by the shop, or logged out by an account change (e.g. a new role):
    // the token no longer works anywhere, so end the session and go to the login page.
    if (token && SESSION_ENDED_CODES[data.code] && !path.startsWith("/auth/")) endSession(SESSION_ENDED_CODES[data.code]);
    throw error;
  }
  return data;
}

const SESSION_ENDED_CODES = { ACCOUNT_SUSPENDED: "suspended", SESSION_ENDED: "ended" };

// Clears the login and sends the user to the login page, which explains why
// (?ended=suspended|ended) and brings them back here after logging in.
function endSession(reason) {
  authStore.clear();
  const here = location.pathname.split("/Pages/")[1];
  const next = here && !here.startsWith("Homepage/login.html") ? `&next=${encodeURIComponent(here + location.search)}` : "";
  location.href = `../Homepage/login.html?ended=${reason}${next}`;
}

/* Shared auth-check helpers — used by Homepage.js and by the checkout.html
   inline script, since both need to gate actions on being logged in. */
function isLoggedIn() {
  return authStore.get("bongalink_logged_in") === "true";
}

// UI hint only — the server enforces the real admin check on every
// admin-only request via the requireAdmin middleware.
function isAdmin() {
  return isLoggedIn() && authStore.get("bongalink_role") === "admin";
}
