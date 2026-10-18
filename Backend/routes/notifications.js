/* =====================================================================
   routes/notifications.js — the admin notification bell (migration 012).
   Mounted at /api/v1/admin/notifications. Every route is admin-only.

     GET  /                  newest first, paginated (?page=1&per_page=20),
                             each with `read` for this admin, + unread
     GET  /unread-count      { unread }
     POST /:id/read          marks one read for this admin -> { unread }
     POST /read-all          marks everything up to now read -> { unread }
     POST /stream-ticket     a single-use ticket for the stream, valid 60 s
     GET  /stream?ticket=    Server-Sent Events: "ready" { unread }, then a
                             "notification" per new notification, a ping
                             comment every HEARTBEAT_MS, and "end" { code }
                             when the login stops working

   EventSource can't send the Authorization header, and the login token
   must never go in a URL (it would end up in logs and history). So the
   page asks for a ticket with its token (POST, requireAdmin), then opens
   the stream with that: random, only its SHA-256 stored, single use,
   60 seconds. The stream re-checks the login on every heartbeat the way
   requireAuth does (suspension, deletion, token_version, the 011 session
   being logged out or expired) and ends when it no longer works.

   Notifications are shared by all admins; read state is per admin.
   ===================================================================== */

const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const router = require("express").Router();
const pool = require("../db");
const ah = require("../lib/asyncHandler");
const { requireAdmin, checkAccount, bearer } = require("../middleware/auth");
const { unreadCount, shape, hub, COLUMNS } = require("../services/notifications");

const TICKET_SECONDS = 60;
// Keeps proxies (nginx, ngrok) from closing an idle stream, and re-checks the login.
const stream = { heartbeatMs: 25000 };

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

router.get("/", requireAdmin, ah(async (req, res) => {
  const perPage = Math.min(Math.max(parseInt(req.query.per_page, 10) || 20, 1), 50);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const [[me]] = await pool.query("SELECT notifications_read_through AS through FROM users WHERE user_id = ?", [req.user.userId]);
  const [rows] = await pool.query(
    `SELECT ${COLUMNS}, (n.notification_id <= ? OR r.notification_id IS NOT NULL) AS is_read
       FROM admin_notifications n
       LEFT JOIN admin_notification_reads r ON r.notification_id = n.notification_id AND r.admin_id = ?
      ORDER BY n.notification_id DESC
      LIMIT ? OFFSET ?`,
    [me.through, req.user.userId, perPage + 1, (page - 1) * perPage]);
  res.json({
    items: rows.slice(0, perPage).map((r) => shape(r, r.is_read)),
    page, per_page: perPage, has_more: rows.length > perPage,
    unread: await unreadCount(req.user.userId)
  });
}));

router.get("/unread-count", requireAdmin, ah(async (req, res) => {
  res.json({ unread: await unreadCount(req.user.userId) });
}));

router.post("/read-all", requireAdmin, ah(async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `UPDATE users SET notifications_read_through =
              GREATEST(notifications_read_through, (SELECT COALESCE(MAX(notification_id), 0) FROM admin_notifications))
        WHERE user_id = ?`, [req.user.userId]);
    // Rows now covered by read_through are no longer needed.
    await conn.query(
      `DELETE r FROM admin_notification_reads r JOIN users u ON u.user_id = r.admin_id
        WHERE r.admin_id = ? AND r.notification_id <= u.notifications_read_through`, [req.user.userId]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  res.json({ unread: await unreadCount(req.user.userId) });
}));

router.post("/:id(\\d+)/read", requireAdmin, ah(async (req, res) => {
  const [r] = await pool.query(
    `INSERT IGNORE INTO admin_notification_reads (admin_id, notification_id)
     SELECT ?, notification_id FROM admin_notifications WHERE notification_id = ?`, [req.user.userId, req.params.id]);
  if (!r.affectedRows) {
    const [[exists]] = await pool.query("SELECT 1 AS ok FROM admin_notifications WHERE notification_id = ?", [req.params.id]);
    if (!exists) return res.status(404).json({ error: "Notification not found." });
  }
  res.json({ unread: await unreadCount(req.user.userId) });
}));

router.post("/stream-ticket", requireAdmin, ah(async (req, res) => {
  const ticket = crypto.randomBytes(32).toString("base64url");
  const [[me]] = await pool.query("SELECT token_version FROM users WHERE user_id = ?", [req.user.userId]);
  const exp = jwt.decode(bearer(req))?.exp ?? null;
  await pool.query(
    "DELETE FROM admin_stream_tickets WHERE user_id = ? AND (used_at IS NOT NULL OR expires_at < NOW())", [req.user.userId]);
  await pool.query(
    `INSERT INTO admin_stream_tickets (ticket_hash, user_id, session_id, token_version, token_expires_at, expires_at)
     VALUES (?, ?, ?, ?, FROM_UNIXTIME(?), NOW() + INTERVAL ? SECOND)`,
    [sha256(ticket), req.user.userId, req.user.sessionId, me.token_version, exp, TICKET_SECONDS]);
  res.json({ ticket, expires_in: TICKET_SECONDS });
}));

const TICKET_REFUSED = { error: "This stream link is missing, expired or already used. Reload the page.", code: "STREAM_TICKET_INVALID" };

// -> { user } while the login the ticket came from still works and is an admin's, else { status, body }.
async function checkStreamLogin(t) {
  if (t.token_exp && t.token_exp * 1000 <= Date.now()) {
    return { status: 401, body: { error: "Your session has ended. Please log in again.", code: "SESSION_ENDED" } };
  }
  const result = await checkAccount({ userId: t.user_id, tv: t.token_version, sid: t.session_id });
  if (result.user && result.user.role !== "admin") return { status: 403, body: { error: "Admin account required." } };
  return result;
}

router.get("/stream", ah(async (req, res) => {
  const ticket = typeof req.query.ticket === "string" ? req.query.ticket : "";
  if (!ticket) return res.status(401).json(TICKET_REFUSED);
  const hash = sha256(ticket);
  // Single use: only the first request can claim it.
  const [claimed] = await pool.query(
    "UPDATE admin_stream_tickets SET used_at = NOW() WHERE ticket_hash = ? AND used_at IS NULL AND expires_at > NOW()", [hash]);
  if (!claimed.affectedRows) return res.status(401).json(TICKET_REFUSED);
  const [[t]] = await pool.query(
    "SELECT user_id, session_id, token_version, UNIX_TIMESTAMP(token_expires_at) AS token_exp FROM admin_stream_tickets WHERE ticket_hash = ?", [hash]);
  const login = await checkStreamLogin(t);
  if (!login.user) return res.status(login.status).json(login.body);

  const [[{ since }]] = await pool.query("SELECT COALESCE(MAX(notification_id), 0) AS since FROM admin_notifications");
  const unread = await unreadCount(t.user_id);

  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"          // nginx: don't buffer the stream
  });
  res.flushHeaders();
  req.socket.setNoDelay(true);

  let open = true;
  const send = (event, data, id) => {
    if (open) res.write(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const client = { since: Number(since), send: (n) => send("notification", n, n.id) };
  const close = () => {
    if (!open) return;
    open = false;
    clearInterval(beat);
    hub.unsubscribe(client);
    res.end();
  };

  res.write("retry: 5000\n\n");
  send("ready", { unread });
  hub.subscribe(client);

  const beat = setInterval(async () => {
    if (!open) return;
    res.write(": ping\n\n");
    let now;
    try {
      now = await checkStreamLogin(t);
    } catch (err) {
      return;   // database hiccup: keep the stream, check again next time
    }
    if (!now.user) {
      send("end", { code: now.body.code || "FORBIDDEN" });
      close();
    }
  }, stream.heartbeatMs);

  req.on("close", close);
}));

module.exports = router;
module.exports.stream = stream;
