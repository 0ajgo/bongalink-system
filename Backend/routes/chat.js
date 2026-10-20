// Customer chat (REQ04): POST /api/v1/chat/messages { session_id, message, product_id? } -> { reply, products }
// Open to visitors; a logged-in customer's token adds order lookups for their own orders.
// The chatbot itself is services/chatbot.js; the admin side is routes/chatAdmin.js.
const express = require('express');
const { rateLimit, MemoryStore } = require('express-rate-limit');
const ah = require('../lib/asyncHandler');
const { optionalAuth } = require('../middleware/auth');
const { envLimit, RATE_LIMIT_DEFAULTS } = require('../lib/rateLimit');
const { handleMessage, MAX_MESSAGE } = require('../services/chatbot');

const router = express.Router();

// The browser makes a random id per tab (crypto.randomUUID) and keeps it in sessionStorage.
const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;

// Gemini costs money per message, so: per browser tab, per IP per minute, and per IP per day.
const tooFast = { error: "You're sending messages too quickly. Please wait a minute and try again.", code: 'RATE_LIMITED' };
const stores = [new MemoryStore(), new MemoryStore(), new MemoryStore()];
const limiter = (windowMs, limit, store, extra = {}) =>
  rateLimit({ windowMs, limit, store, standardHeaders: 'draft-7', legacyHeaders: false, message: tooFast, ...extra });
const perSession = limiter(60 * 1000, 8, stores[0], { keyGenerator: (req) => `session:${req.body?.session_id}` });
// The per-IP ones are raisable in .env for a test session on one shared IP.
const perIp = limiter(60 * 1000, envLimit(process.env.RATE_LIMIT_CHAT_PER_IP_MINUTE, RATE_LIMIT_DEFAULTS.RATE_LIMIT_CHAT_PER_IP_MINUTE), stores[1]);
const perIpDaily = limiter(24 * 60 * 60 * 1000, envLimit(process.env.RATE_LIMIT_CHAT_PER_IP_DAY, RATE_LIMIT_DEFAULTS.RATE_LIMIT_CHAT_PER_IP_DAY), stores[2], {
  message: { error: "You've reached today's chat limit. Please contact the shop directly.", code: 'RATE_LIMITED' },
});

// Plain text only: no control characters, at most two blank lines in a row.
const cleanMessage = (text) => text
  .replace(/\r\n?/g, '\n')
  .replace(/\t/g, ' ')
  .replace(/[\u0000-\u0008\u000B-\u001F\u007F​-‏‪-‮⁠-⁯]/g, '')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

router.post('/chat/messages', perIp, perIpDaily, perSession, optionalAuth, ah(async (req, res) => {
  const { session_id: sessionId, message, product_id: productId } = req.body || {};
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    return res.status(400).json({ error: 'This chat session is not valid. Please reload the page.' });
  }
  const text = typeof message === 'string' ? cleanMessage(message) : '';
  if (!text) return res.status(400).json({ error: 'Type a message first.' });
  if (text.length > MAX_MESSAGE) {
    return res.status(400).json({ error: `Please keep messages under ${MAX_MESSAGE} characters.` });
  }
  const product = Number.isInteger(Number(productId)) && Number(productId) > 0 ? Number(productId) : null;

  const { reply, products } = await handleMessage({
    sessionId, message: text, user: req.user ? { userId: req.user.userId, role: req.user.role } : null, productId: product,
  });
  res.json({ reply, products });
}));

// Tests: start every test from empty rate-limit counters.
router.resetRateLimits = () => Promise.all(stores.map((s) => s.resetAll()));

module.exports = router;
