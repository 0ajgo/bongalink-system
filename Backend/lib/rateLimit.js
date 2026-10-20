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

module.exports = { MINUTE, HOUR, envLimit, limiter, resetAll };
