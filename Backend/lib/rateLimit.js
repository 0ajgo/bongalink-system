/* =====================================================================
   lib/rateLimit.js — the API's rate limits (express-rate-limit, counted
   in memory per process; a restart starts them from zero).
   Most limits are raisable in .env: during a test session where many
   people share one public IP (a school lab, one Wi-Fi) raise the per-IP
   ones, and put them back afterwards (DEPLOYMENT.md). Failed logins per
   username + IP, per email and per chat stay fixed in code.
   ===================================================================== */
const { rateLimit, MemoryStore } = require("express-rate-limit");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// The .env limits and their defaults (what a blank value means). The startup log warns while
// any is set above its default, so a raised test-session limit isn't forgotten.
const RATE_LIMIT_DEFAULTS = {
  RATE_LIMIT_LOGIN_PER_IP: 50,              // failed logins per IP, 15 min
  RATE_LIMIT_REGISTER_PER_IP_HOUR: 5,       // new accounts per IP
  RATE_LIMIT_REGISTER_PER_IP_DAY: 20,
  RATE_LIMIT_VERIFY_EMAIL_PER_IP: 20,       // email-code requests and guesses per IP, 15 min
  RATE_LIMIT_FORGOT_PASSWORD_PER_IP: 10,    // per IP, 15 min
  RATE_LIMIT_CHAT_PER_IP_MINUTE: 20,
  RATE_LIMIT_CHAT_PER_IP_DAY: 300,
  RATE_LIMIT_ACCOUNT_PER_USER: 10,          // failed email/password changes per account, 15 min
};

// -> [{ name, value, default }] for every limit set above its default.
const raisedLimits = (env = process.env) => Object.entries(RATE_LIMIT_DEFAULTS)
  .map(([name, fallback]) => ({ name, value: envLimit(env[name], fallback), default: fallback }))
  .filter((l) => l.value > l.default);

// A positive whole number from .env, or the default (blank or invalid).
function envLimit(value, fallback) {
  const n = Number(String(value ?? "").trim());
  return String(value ?? "").trim() !== "" && Number.isInteger(n) && n > 0 ? n : fallback;
}

// Every limiter made here keeps its counts in a store tests can empty.
const stores = [];
function limiter({ windowMs, limit, message, ...extra }) {
  const store = new MemoryStore();
  stores.push(store);
  return rateLimit({ windowMs, limit, store, standardHeaders: "draft-7", legacyHeaders: false,
    message: { code: "RATE_LIMITED", ...message }, ...extra });
}

// Tests: start from empty counters.
const resetAll = () => Promise.all(stores.map((s) => s.resetAll()));

module.exports = { MINUTE, HOUR, RATE_LIMIT_DEFAULTS, raisedLimits, envLimit, limiter, resetAll };
