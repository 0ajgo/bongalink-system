/* =====================================================================
   api.js — shared fetch helper for all pages
   Include this BEFORE Homepage.js / login.js / register.js in each
   HTML file, after config.js.

   Where the API is: config.js (window.BONGALINK_API_BASE_URL), or when
   that is blank, http://localhost:4000/api for a page opened from a
   development server (port 5500), and /api on the same site anywhere else.
   ===================================================================== */

const DEV_API_BASE_URL = "http://localhost:4000/api";
const API_BASE_URL = (() => {
  const configured = String(window.BONGALINK_API_BASE_URL || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  const { protocol, port, origin } = window.location;
  return protocol === "file:" || port === "5500" ? DEV_API_BASE_URL : `${origin}/api`;
})();

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
  // data: the answer to a successful login
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

/* A request that gets no answer fails after this long, so a page shows an
   error instead of loading forever. Slower calls pass a longer `timeout`. */
const API_TIMEOUT_MS = 20000;
const API_TIMEOUT_LONG_MS = 45000;
const API_TIMEOUT_CHAT_MS = 60000;
const API_UPLOAD_TIMEOUT_MS = 120000;

// fetch() that gives up after `ms`. The elapsed time is checked when the
// timer fires, so a timer that runs early never cuts a request short.
function fetchWithTimeout(url, options, ms) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const started = Date.now();
  let timer;
  const timedOut = new Promise((_, reject) => {
    const check = () => {
      const left = ms - (Date.now() - started);
      if (left > 0) { timer = setTimeout(check, left); return; }
      controller?.abort();
      const error = new Error("The server took too long to answer. Please try again.");
      error.code = "TIMEOUT";
      reject(error);
    };
    timer = setTimeout(check, ms);
  });
  const request = fetch(url, controller ? { ...options, signal: controller.signal } : options);
  return Promise.race([request, timedOut]).finally(() => clearTimeout(timer));
}

/**
 * Wraps fetch() with the API base URL, JSON handling, and the
 * logged-in user's auth token (if any). Throws an Error with the
 * server's message on non-2xx responses so callers can catch() it.
 * No answer within API_TIMEOUT_MS (or options.timeout), or no connection
 * at all, also throws, with a readable message and no `status`.
 */
async function apiFetch(path, { timeout, ...options } = {}) {
  const token = authStore.get("bongalink_token");

  const headers = { ...(options.headers || {}) };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  // Only set Content-Type: JSON when we're not sending a file (FormData
  // sets its own multipart boundary header automatically).
  const upload = options.body instanceof FormData;
  if (!upload && options.body) {
    headers["Content-Type"] = "application/json";
  }

  let response;
  try {
    response = await fetchWithTimeout(`${API_BASE_URL}${path}`, { ...options, headers },
      timeout ?? (upload ? API_UPLOAD_TIMEOUT_MS : API_TIMEOUT_MS));
  } catch (err) {
    if (err.code === "TIMEOUT") throw err;
    throw new Error("Can't reach the server. Check your connection and try again.");
  }

  // .catch(() => ({})) guards against a body that isn't valid JSON (an
  // empty 204 response, or a proxy/500 page instead of Express's own
  // JSON error) — without it, a bad response would throw *inside* the
  // error-handling below and hide the real HTTP status from callers.
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    // err.message is the server's own explanation, shown to the user;
    // status/code let callers react to specific cases.
    const error = new Error(data.error || "Something went wrong.");
    error.status = response.status;
    error.code = data.code;
    error.data = data;
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

// UI hint only — the server checks the admin role on every admin request.
function isAdmin() {
  return isLoggedIn() && authStore.get("bongalink_role") === "admin";
}
