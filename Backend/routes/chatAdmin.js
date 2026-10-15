// Admin "Chat & FAQs" (REQ026, "progressively improve"): review what customers asked,
// see which questions the bot couldn't answer, and turn them into FAQs. Active FAQs
// are read by the chatbot on every message, so changes apply to the next answer.
//   GET    /api/v1/admin/chat/summary            counts for the page and the Dashboard
//   GET    /api/v1/admin/chat/logs               exchanges, filtered (view, q, days, customer)
//   GET    /api/v1/admin/chat/sessions/:id       one whole conversation
//   PATCH  /api/v1/admin/chat/logs/:id           { resolved: true|false }
//   GET    /api/v1/admin/faqs                    all FAQs
//   POST   /api/v1/admin/faqs                    { question, answer, category, is_active, is_placeholder, source_chat_id? }
//   PATCH  /api/v1/admin/faqs/:id                any of those fields
//   DELETE /api/v1/admin/faqs/:id
const express = require('express');
const pool = require('../db');
const ah = require('../lib/asyncHandler');
const { requireAdmin } = require('../middleware/auth');
const { dec, maskText } = require('../lib/pii');

const router = express.Router();

// Waiting for the admin: not answered, not handled yet. Off-topic questions are
// in the history but not in the queue (there is nothing to add for them).
const OPEN = "l.answered = 0 AND l.resolved_at IS NULL AND (l.unanswered_reason IS NULL OR l.unanswered_reason <> 'off_topic')";

router.get('/admin/chat/summary', requireAdmin, ah(async (req, res) => {
  const [[open]] = await pool.query(`SELECT COUNT(*) AS n FROM chat_logs l WHERE ${OPEN}`);
  const [[month]] = await pool.query(
    `SELECT COUNT(*) AS messages, COALESCE(SUM(answered), 0) AS answered, COUNT(DISTINCT session_id) AS conversations
       FROM chat_logs WHERE created_at > NOW() - INTERVAL 30 DAY`);
  const [[faqs]] = await pool.query(
    'SELECT COALESCE(SUM(is_active), 0) AS active, COALESCE(SUM(is_active AND is_placeholder), 0) AS placeholders FROM faqs');
  res.json({
    unanswered_open: open.n,
    last_30_days: { messages: month.messages, answered: Number(month.answered), conversations: month.conversations },
    faqs: { active: Number(faqs.active), placeholders: Number(faqs.placeholders) },
  });
}));

const VIEWS = {
  unanswered: OPEN,
  answered: 'l.answered = 1',
  not_answered: 'l.answered = 0',
  all: '1 = 1',
};

const toolNames = (json) => {
  if (!json) return [];
  const list = typeof json === 'string' ? JSON.parse(json) : json;
  return [...new Set(list.map((t) => t.name))];
};

// Messages are stored encrypted. Lists show them with emails and phone numbers masked;
// the full text is only in the one-conversation view.
const decryptLog = (r) => ({ ...r, message: dec('chat_logs', 'message', r.message), reply: dec('chat_logs', 'reply', r.reply) });
const logRow = (r, { masked = false } = {}) => ({
  chat_id: r.chat_id, session_id: r.session_id, user_id: r.user_id, username: r.username,
  product_id: r.product_id, product_name: r.product_name,
  message: masked ? maskText(r.message) : r.message, reply: masked ? maskText(r.reply) : r.reply,
  tools: toolNames(r.tools_used), answered: Boolean(r.answered), unanswered_reason: r.unanswered_reason,
  resolved_at: r.resolved_at, faq_id: r.faq_id, model: r.model, response_ms: r.response_ms, created_at: r.created_at,
  ...(r.session_messages !== undefined ? { session_messages: r.session_messages } : {}),
});

const SEARCH_SCAN = 2000;
const LOG_SELECT = `
  SELECT l.*, u.username, p.name AS product_name
    FROM chat_logs l
    LEFT JOIN users u ON u.user_id = l.user_id
    LEFT JOIN products p ON p.product_id = l.product_id`;

router.get('/admin/chat/logs', requireAdmin, ah(async (req, res) => {
  const { view = 'all', q = '', days = '30', customer = 'all', reason = '' } = req.query;
  if (!VIEWS[view]) return res.status(400).json({ error: 'Unknown view.' });
  const where = [VIEWS[view]];
  const params = [];
  if (days !== 'all') {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > 3650) return res.status(400).json({ error: 'Choose a period.' });
    where.push('l.created_at > NOW() - INTERVAL ? DAY');
    params.push(n);
  }
  if (customer === 'guest') where.push('l.user_id IS NULL');
  else if (customer === 'registered') where.push('l.user_id IS NOT NULL');
  if (reason) {
    if (!['no_information', 'needs_staff', 'off_topic', 'service_down'].includes(reason)) return res.status(400).json({ error: 'Unknown reason.' });
    where.push('l.unanswered_reason = ?');
    params.push(reason);
  }
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const before = Number(req.query.before);
  if (Number.isInteger(before) && before > 0) { where.push('l.chat_id < ?'); params.push(before); }

  // Text search can't run in the database (the text is encrypted): it decrypts up to
  // SEARCH_SCAN of the newest rows matching the other filters and searches those.
  const search = q.trim().toLowerCase();
  const take = search ? SEARCH_SCAN : limit + 1;
  const [found] = await pool.query(
    `SELECT x.*, (SELECT COUNT(*) FROM chat_logs s WHERE s.session_id = x.session_id) AS session_messages
       FROM (${LOG_SELECT} WHERE ${where.join(' AND ')} ORDER BY l.chat_id DESC LIMIT ${take}) x
      ORDER BY x.chat_id DESC`, params);
  let rows = found.map(decryptLog);
  if (search) rows = rows.filter((r) => r.message.toLowerCase().includes(search) || r.reply.toLowerCase().includes(search));
  res.json({ logs: rows.slice(0, limit).map((r) => logRow(r, { masked: true })), has_more: rows.length > limit,
             ...(search && found.length === SEARCH_SCAN ? { searched_newest: SEARCH_SCAN } : {}) });
}));

router.get('/admin/chat/sessions/:sessionId', requireAdmin, ah(async (req, res) => {
  const [rows] = await pool.query(`${LOG_SELECT} WHERE l.session_id = ? ORDER BY l.chat_id ASC LIMIT 200`, [req.params.sessionId]);
  if (!rows.length) return res.status(404).json({ error: 'Conversation not found.' });
  res.json({ session_id: req.params.sessionId, messages: rows.map((r) => logRow(decryptLog(r))) });
}));

router.patch('/admin/chat/logs/:id(\\d+)', requireAdmin, ah(async (req, res) => {
  const { resolved } = req.body || {};
  if (typeof resolved !== 'boolean') return res.status(400).json({ error: 'Send resolved: true or false.' });
  const [r] = await pool.query(
    'UPDATE chat_logs SET resolved_at = ?, resolved_by = ? WHERE chat_id = ?',
    resolved ? [new Date(), req.user.userId, req.params.id] : [null, null, req.params.id]);
  if (!r.affectedRows) return res.status(404).json({ error: 'Message not found.' });
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ FAQs */
const FLAG = [true, false, 1, 0];

function faqValues(body = {}, partial = false) {
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const values = {};
  if (!partial || has('question')) {
    const q = String(body.question ?? '').trim();
    if (q.length < 5 || q.length > 255) return { error: 'Write the question (5 to 255 characters).' };
    values.question = q;
  }
  if (!partial || has('answer')) {
    const a = String(body.answer ?? '').trim();
    if (a.length < 5 || a.length > 2000) return { error: 'Write the answer (5 to 2,000 characters).' };
    values.answer = a;
  }
  if (!partial || has('category')) {
    const c = String(body.category ?? '').trim() || 'General';
    if (c.length > 40) return { error: 'Category must be 40 characters or fewer.' };
    values.category = c;
  }
  for (const key of ['is_active', 'is_placeholder']) {
    if (has(key)) {
      if (!FLAG.includes(body[key])) return { error: `${key} must be true or false.` };
      values[key] = body[key] ? 1 : 0;
    } else if (!partial) {
      values[key] = key === 'is_active' ? 1 : 0;
    }
  }
  return { values };
}

const faqRow = (f) => ({ ...f, is_active: Boolean(f.is_active), is_placeholder: Boolean(f.is_placeholder), from_questions: Number(f.from_questions || 0) });

async function loadFaq(id) {
  const [[f]] = await pool.query(
    `SELECT f.*, (SELECT COUNT(*) FROM chat_logs l WHERE l.faq_id = f.faq_id) AS from_questions FROM faqs f WHERE f.faq_id = ?`, [id]);
  return f ? faqRow(f) : null;
}

router.get('/admin/faqs', requireAdmin, ah(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT f.*, (SELECT COUNT(*) FROM chat_logs l WHERE l.faq_id = f.faq_id) AS from_questions
       FROM faqs f ORDER BY f.is_active DESC, f.category, f.faq_id`);
  res.json(rows.map(faqRow));
}));

router.post('/admin/faqs', requireAdmin, ah(async (req, res) => {
  const { values, error } = faqValues(req.body);
  if (error) return res.status(400).json({ error });
  const source = req.body.source_chat_id;
  if (source !== undefined && source !== null && !(Number.isInteger(source) && source > 0)) {
    return res.status(400).json({ error: 'source_chat_id must be a message id.' });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query('INSERT INTO faqs SET ?', [{ ...values, created_by: req.user.userId, updated_by: req.user.userId }]);
    // "Turn into FAQ": the question it came from is now handled.
    if (source) {
      const [u] = await conn.query(
        'UPDATE chat_logs SET faq_id = ?, resolved_at = COALESCE(resolved_at, NOW()), resolved_by = COALESCE(resolved_by, ?) WHERE chat_id = ?',
        [r.insertId, req.user.userId, source]);
      if (!u.affectedRows) { await conn.rollback(); return res.status(400).json({ error: 'That chat message no longer exists.' }); }
    }
    await conn.commit();
    res.status(201).json(await loadFaq(r.insertId));
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));

router.patch('/admin/faqs/:id(\\d+)', requireAdmin, ah(async (req, res) => {
  const { values, error } = faqValues(req.body, true);
  if (error) return res.status(400).json({ error });
  if (!Object.keys(values).length) return res.status(400).json({ error: 'Nothing to change.' });
  const [r] = await pool.query('UPDATE faqs SET ? WHERE faq_id = ?', [{ ...values, updated_by: req.user.userId }, req.params.id]);
  if (!r.affectedRows) return res.status(404).json({ error: 'FAQ not found.' });
  res.json(await loadFaq(req.params.id));
}));

router.delete('/admin/faqs/:id(\\d+)', requireAdmin, ah(async (req, res) => {
  const [r] = await pool.query('DELETE FROM faqs WHERE faq_id = ?', [req.params.id]);
  if (!r.affectedRows) return res.status(404).json({ error: 'FAQ not found.' });
  res.json({ ok: true });
}));

module.exports = router;
