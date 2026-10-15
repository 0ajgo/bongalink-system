/* =====================================================================
   routes/adminAccounts.js — admin account management
   (REQ010, REQ018, REQ019, REQ029). Mounted at /api/v1/admin/accounts.

     GET    /summary              totals for the Accounts page and Dashboard
     GET    /                     list: q, role, status, verified, sort, dir, page, per_page
     GET    /audit-log            admin actions on accounts (target, action, page)
     GET    /:id                  profile, saved addresses, orders, activity, what's allowed
     POST   /                     create { username, email, role } -> emails a set-password link
     POST   /:id/resend-invite    new set-password link (accounts not set up yet)
     POST   /:id/suspend          { reason }    logs the user out at once
     POST   /:id/unsuspend        { reason }
     POST   /:id/role             { role: "admin" | "user", reason? }
     DELETE /:id                  { confirm_username, reason? }  delete, or anonymize if the
                                  account has orders or shop records

   Safeguards, checked here inside a transaction (not just hidden in the UI):
   - an admin can't suspend, demote or delete their own account;
   - the last active admin can't be suspended, demoted or deleted;
   - every action is written to admin_audit_log (who, when, action, target,
     reason, old -> new).

   Emails, reasons and addresses are stored encrypted (lib/pii.js). The list
   shows masked emails; search matches usernames, or an exact email through
   the blind index (users.email_bidx).
   ===================================================================== */

const express = require("express");
const pool = require("../db");
const ah = require("../lib/asyncHandler");
const { requireAdmin } = require("../middleware/auth");
const { sendSetupLink, unusablePasswordHash } = require("../services/accountSetup");
const { enc, dec, emailColumns, decryptAddress, maskEmail, logError } = require("../lib/pii");
const { blindIndex } = require("../lib/dataProtection");

const router = express.Router();
router.use(requireAdmin);

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,50}$/;   // same rules as Account settings
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PER_PAGE = 20;

const fail = (status, error, code) => Object.assign(new Error(error), { status, code });

// Shown status: deleted, suspended, invited (password not set yet) or active.
const displayStatus = (u) =>
  u.status === "deleted" ? "deleted" : u.status === "suspended" ? "suspended" : u.must_set_password ? "invited" : "active";

// List rows show a masked email; the details view shows it whole.
const accountRow = (u, { fullEmail = false } = {}) => ({
  user_id: u.user_id, username: u.username,
  email: fullEmail ? dec("users", "email", u.email) : maskEmail(dec("users", "email", u.email)), role: u.role, status: displayStatus(u),
  verified: Boolean(u.email_verified_at), created_at: u.created_at, last_login_at: u.last_login_at,
  order_count: Number(u.order_count || 0),
});

// Account actions run one at a time (a named MySQL lock), so two admins acting at the
// same moment - e.g. demoting each other - can't both pass the safeguards, and can't
// deadlock on the users table's role/status index.
const ACTION_LOCK = "bongalink_admin_accounts";

async function withTransaction(fn) {
  const conn = await pool.getConnection();
  let locked = false;
  try {
    const [[{ ok }]] = await conn.query("SELECT GET_LOCK(?, 10) AS ok", [ACTION_LOCK]);
    if (ok !== 1) throw fail(503, "Another account change is in progress. Please try again.");
    locked = true;
    await conn.beginTransaction();
    try {
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  } finally {
    if (locked) await conn.query("DO RELEASE_LOCK(?)", [ACTION_LOCK]).catch(() => {});
    conn.release();
  }
}

async function audit(conn, admin, action, target, { reason = null, oldValue = null, newValue = null } = {}) {
  await conn.query(
    `INSERT INTO admin_audit_log (admin_id, admin_label, action, target_user_id, target_label, reason, old_value, new_value)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [admin.userId, admin.username, action, target.user_id, target.username, enc("admin_audit_log", "reason", reason),
     oldValue ? JSON.stringify(oldValue) : null, newValue ? JSON.stringify(newValue) : null]);
}

/* ---------------------------------------------------------------------
   SAFEGUARDS
   --------------------------------------------------------------------- */
const ACTIONS_THAT_REMOVE_AN_ADMIN = ["suspend", "demote", "delete"];
const VERB = { suspend: "suspend", demote: "remove admin access from", delete: "delete" };

// Locks the active admins (always in the same order) and then the target, so two admins
// acting at the same moment - e.g. suspending each other - run one after the other and
// the second one sees the first one's change. -> { target, others } (other active admins)
async function lockForAction(conn, id, actor) {
  const [admins] = await conn.query(
    "SELECT user_id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY user_id FOR UPDATE");
  // The acting admin may have been suspended or demoted a moment ago by someone else.
  if (!admins.some((a) => a.user_id === actor.userId)) {
    throw fail(403, "Your admin access changed. Please log in again.", "SESSION_ENDED");
  }
  const [[target]] = await conn.query(
    `SELECT user_id, username, email, role, status, must_set_password, token_version
       FROM users WHERE user_id = ? FOR UPDATE`, [id]);
  if (!target) throw fail(404, "Account not found.");
  target.email = dec("users", "email", target.email);
  return { target, others: admins.filter((a) => a.user_id !== target.user_id).length };
}
const otherActiveAdmins = async (conn, targetId) =>
  (await conn.query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND user_id <> ?", [targetId]))[0][0].n;

// -> null if allowed, else the reason it isn't (same text the page shows).
function blockedReason(actor, target, action, othersActive) {
  if (target.status === "deleted") return "This account was deleted.";
  if (ACTIONS_THAT_REMOVE_AN_ADMIN.includes(action)) {
    if (target.user_id === actor.userId) return `You can't ${VERB[action]} your own account.`;
    if (target.role === "admin" && target.status === "active" && othersActive === 0) {
      return `${target.username} is the last active admin. Make another account an admin first.`;
    }
  }
  if (action === "suspend" && target.status === "suspended") return "This account is already suspended.";
  if (action === "unsuspend" && target.status !== "suspended") return "This account isn't suspended.";
  if (action === "promote" && target.role === "admin") return "This account is already an admin.";
  if (action === "demote" && target.role !== "admin") return "This account is already a customer.";
  if (action === "resend_invite" && !(target.must_set_password && target.status === "active")) {
    return "This account has already set its password.";
  }
  return null;
}

function guard(actor, { target, others }, action) {
  const reason = blockedReason(actor, target, action, others);
  if (!reason) return;
  const self = ACTIONS_THAT_REMOVE_AN_ADMIN.includes(action) && target.user_id === actor.userId;
  throw fail(self ? 403 : 409, reason, self ? "OWN_ACCOUNT" : reason.includes("last active admin") ? "LAST_ADMIN" : "NOT_ALLOWED");
}

function requiredReason(body) {
  const reason = String(body?.reason ?? "").trim();
  if (reason.length < 3) throw fail(400, "Write a reason (at least 3 characters).");
  if (reason.length > 255) throw fail(400, "Keep the reason under 255 characters.");
  return reason;
}
function optionalReason(body) {
  const reason = String(body?.reason ?? "").trim();
  if (reason.length > 255) throw fail(400, "Keep the reason under 255 characters.");
  return reason || null;
}

// Records that keep an account from being deleted outright: orders (sales history,
// ML) and anything the account did as staff (listed products, stock and shipping changes).
async function recordCounts(conn, id) {
  const [[c]] = await conn.query(
    `SELECT (SELECT COUNT(*) FROM orders WHERE user_id = ?) AS orders,
            (SELECT COUNT(*) FROM products WHERE created_by = ?) AS products_listed,
            (SELECT COUNT(*) FROM inventory_movements WHERE created_by = ?)
          + (SELECT COUNT(*) FROM shipment_events WHERE created_by = ?)
          + (SELECT COUNT(*) FROM product_changes WHERE changed_by = ?) AS staff_records`,
    [id, id, id, id, id]);
  return { orders: Number(c.orders), products_listed: Number(c.products_listed), staff_records: Number(c.staff_records) };
}
const mustAnonymize = (c) => c.orders + c.products_listed + c.staff_records > 0;

/* ---------------------------------------------------------------------
   READ
   --------------------------------------------------------------------- */
router.get("/summary", ah(async (req, res) => {
  const [[s]] = await pool.query(
    `SELECT COALESCE(SUM(status <> 'deleted'), 0) AS total,
            COALESCE(SUM(status = 'active' AND role = 'admin'), 0) AS admins,
            COALESCE(SUM(status <> 'deleted' AND created_at >= NOW() - INTERVAL 7 DAY), 0) AS new_this_week,
            COALESCE(SUM(status = 'suspended'), 0) AS suspended,
            COALESCE(SUM(status = 'active' AND must_set_password = 1), 0) AS invited
       FROM users`);
  res.json(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Number(v)])));
}));

// No sorting by email: it's encrypted, so the database can't order it.
const SORTS = { username: "u.username", role: "u.role", status: "u.status", created_at: "u.created_at",
                last_login_at: "u.last_login_at", order_count: "order_count" };

router.get("/", ah(async (req, res) => {
  const { q = "", role = "all", status = "all", verified = "all", sort = "created_at", dir = "desc" } = req.query;
  const where = [];
  const params = [];
  if (q.trim()) {
    // Partial match on the username; an email only matches exactly (blind index).
    where.push("(u.username LIKE ? OR u.email_bidx = ?)");
    params.push(`%${q.trim()}%`, blindIndex(q));
  }
  if (role !== "all") {
    if (!["user", "admin"].includes(role)) throw fail(400, "Unknown role.");
    where.push("u.role = ?");
    params.push(role);
  }
  const STATUS = {
    all: "u.status <> 'deleted'", active: "u.status = 'active' AND u.must_set_password = 0",
    invited: "u.status = 'active' AND u.must_set_password = 1", suspended: "u.status = 'suspended'", deleted: "u.status = 'deleted'",
  };
  if (!STATUS[status]) throw fail(400, "Unknown status.");
  where.push(STATUS[status]);
  if (verified === "yes") where.push("u.email_verified_at IS NOT NULL");
  else if (verified === "no") where.push("u.email_verified_at IS NULL");
  else if (verified !== "all") throw fail(400, "Unknown verified filter.");
  if (!SORTS[sort]) throw fail(400, "Unknown sort.");
  const direction = dir === "asc" ? "ASC" : "DESC";
  const perPage = Math.min(Math.max(Number(req.query.per_page) || PER_PAGE, 1), 100);
  const page = Math.max(Number(req.query.page) || 1, 1);

  const from = `FROM users u LEFT JOIN (SELECT user_id, COUNT(*) AS n FROM orders GROUP BY user_id) o ON o.user_id = u.user_id
                WHERE ${where.join(" AND ")}`;
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from}`, params);
  const [rows] = await pool.query(
    `SELECT u.user_id, u.username, u.email, u.role, u.status, u.must_set_password, u.email_verified_at,
            u.created_at, u.last_login_at, COALESCE(o.n, 0) AS order_count
       ${from}
      ORDER BY ${SORTS[sort]} IS NULL, ${SORTS[sort]} ${direction}, u.user_id ${direction}
      LIMIT ? OFFSET ?`, [...params, perPage, (page - 1) * perPage]);
  res.json({ accounts: rows.map((u) => accountRow(u)), total: Number(total), page, per_page: perPage });
}));

const auditRow = (a) => ({
  audit_id: a.audit_id, admin_id: a.admin_id, admin: a.admin_label, action: a.action, target_user_id: a.target_user_id,
  target: a.target_label, reason: dec("admin_audit_log", "reason", a.reason), old_value: a.old_value, new_value: a.new_value, created_at: a.created_at,
});

router.get("/audit-log", ah(async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.target) { where.push("target_user_id = ?"); params.push(Number(req.query.target)); }
  if (req.query.action) { where.push("action = ?"); params.push(String(req.query.action)); }
  const perPage = Math.min(Math.max(Number(req.query.per_page) || 20, 1), 100);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM admin_audit_log ${filter}`, params);
  const [rows] = await pool.query(
    `SELECT * FROM admin_audit_log ${filter} ORDER BY audit_id DESC LIMIT ? OFFSET ?`, [...params, perPage, (page - 1) * perPage]);
  res.json({ entries: rows.map(auditRow), total: Number(total), page, per_page: perPage });
}));

router.get("/:id(\\d+)", ah(async (req, res) => {
  const id = Number(req.params.id);
  const [[u]] = await pool.query(
    `SELECT u.*, c.username AS created_by_username FROM users u LEFT JOIN users c ON c.user_id = u.created_by WHERE u.user_id = ?`, [id]);
  if (!u) throw fail(404, "Account not found.");

  const [savedRows] = await pool.query(
    `SELECT address_id, recipient_name, recipient_phone, street, barangay, city, province, region, postal_code, landmark, is_default
       FROM delivery_addresses a
      WHERE a.user_id = ? AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.address_id = a.address_id)
      ORDER BY is_default DESC, address_id`, [id]);
  const addresses = savedRows.map((a) => decryptAddress(a));
  const [orders] = await pool.query(
    `SELECT o.order_id, o.status, o.total_amount, o.shipping_fee, o.courier, o.created_at, o.paid_at,
            (SELECT COALESCE(SUM(quantity), 0) FROM order_items i WHERE i.order_id = o.order_id) AS units
       FROM orders o WHERE o.user_id = ? ORDER BY o.created_at DESC, o.order_id DESC LIMIT 50`, [id]);
  const [[spend]] = await pool.query(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(CASE WHEN status IN ('paid','packed','shipped','delivered','completed')
            THEN total_amount END), 0) AS paid_total FROM orders WHERE user_id = ?`, [id]);
  const [activity] = await pool.query(
    "SELECT * FROM admin_audit_log WHERE target_user_id = ? ORDER BY audit_id DESC LIMIT 50", [id]);

  // What this admin may do here (the same checks the actions run).
  const others = await otherActiveAdmins(pool, id);
  const can = {};
  for (const action of ["suspend", "unsuspend", "promote", "demote", "delete", "resend_invite"]) {
    const reason = blockedReason(req.user, u, action, others);
    can[action] = { allowed: !reason, reason };
  }
  const records = await recordCounts(pool, id);

  res.json({
    account: {
      ...accountRow({ ...u, order_count: spend.orders }, { fullEmail: true }),
      email_verified_at: u.email_verified_at, suspended_at: u.suspended_at, suspended_reason: dec("users", "suspended_reason", u.suspended_reason),
      created_by: u.created_by_username || null, anonymized_at: u.anonymized_at, is_you: u.user_id === req.user.userId,
    },
    addresses,
    orders: orders.map((o) => ({ ...o, total_amount: Number(o.total_amount), shipping_fee: Number(o.shipping_fee), units: Number(o.units) })),
    order_summary: { orders: Number(spend.orders), paid_total: Number(spend.paid_total) },
    activity: activity.map(auditRow),
    can,
    delete_mode: mustAnonymize(records) ? "anonymize" : "delete",
    records,
  });
}));

/* ---------------------------------------------------------------------
   CREATE
   --------------------------------------------------------------------- */
router.post("/", ah(async (req, res) => {
  const username = String(req.body?.username ?? "").trim();
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const role = req.body?.role ?? "user";
  if (!USERNAME_RE.test(username)) throw fail(400, "Username: 3 to 50 letters, numbers, dots, dashes or underscores.");
  if (!EMAIL_RE.test(email) || email.length > 150) throw fail(400, "Enter a valid email address.");
  if (!["user", "admin"].includes(role)) throw fail(400, "Choose Customer or Admin.");

  const passwordHash = await unusablePasswordHash();
  const account = await withTransaction(async (conn) => {
    const [taken] = await conn.query("SELECT username FROM users WHERE username = ? OR email_bidx = ?", [username, blindIndex(email)]);
    if (taken.length) {
      throw fail(409, taken.some((t) => t.username.toLowerCase() === username.toLowerCase())
        ? "That username is already taken." : "An account with that email already exists.");
    }
    const stored = emailColumns(email);
    const [r] = await conn.query(
      `INSERT INTO users (username, email, email_bidx, password_hash, role, must_set_password, created_by) VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [username, stored.email, stored.email_bidx, passwordHash, role, req.user.userId]);
    const created = { user_id: r.insertId, username, email, role };
    // The log keeps a masked email only.
    await audit(conn, req.user, "create_account", created, { newValue: { username, email: maskEmail(email), role } });
    return created;
  });

  // The account exists either way; if the email fails, the admin can resend it.
  let emailSent = true;
  try {
    await sendSetupLink(account, req.user.userId);
  } catch (err) {
    emailSent = false;
    logError("Account invite email failed", err);
  }
  res.status(201).json({ account: { ...account, status: "invited", verified: false }, email_sent: emailSent });
}));

router.post("/:id(\\d+)/resend-invite", ah(async (req, res) => {
  const target = await withTransaction(async (conn) => {
    const locked = await lockForAction(conn, Number(req.params.id), req.user);
    guard(req.user, locked, "resend_invite");
    const t = locked.target;
    await audit(conn, req.user, "resend_invite", t);
    return t;
  });
  try {
    await sendSetupLink(target, req.user.userId);
  } catch (err) {
    logError("Account invite email failed", err);
    throw fail(502, "The email could not be sent. Check the email settings and try again.");
  }
  res.json({ ok: true });
}));

/* ---------------------------------------------------------------------
   SUSPEND / UNSUSPEND / ROLE
   --------------------------------------------------------------------- */
router.post("/:id(\\d+)/suspend", ah(async (req, res) => {
  const reason = requiredReason(req.body);
  await withTransaction(async (conn) => {
    const locked = await lockForAction(conn, Number(req.params.id), req.user);
    guard(req.user, locked, "suspend");
    const t = locked.target;
    // token_version + 1: every token the user holds stops working now.
    await conn.query(
      `UPDATE users SET status = 'suspended', suspended_at = NOW(), suspended_reason = ?, token_version = token_version + 1
        WHERE user_id = ?`, [enc("users", "suspended_reason", reason), t.user_id]);
    await audit(conn, req.user, "suspend", t, { reason, oldValue: { status: t.status }, newValue: { status: "suspended" } });
  });
  res.json({ ok: true });
}));

router.post("/:id(\\d+)/unsuspend", ah(async (req, res) => {
  const reason = requiredReason(req.body);
  await withTransaction(async (conn) => {
    const locked = await lockForAction(conn, Number(req.params.id), req.user);
    guard(req.user, locked, "unsuspend");
    const t = locked.target;
    await conn.query("UPDATE users SET status = 'active', suspended_at = NULL, suspended_reason = NULL WHERE user_id = ?", [t.user_id]);
    await audit(conn, req.user, "unsuspend", t, { reason, oldValue: { status: "suspended" }, newValue: { status: "active" } });
  });
  res.json({ ok: true });
}));

router.post("/:id(\\d+)/role", ah(async (req, res) => {
  const role = req.body?.role;
  if (!["user", "admin"].includes(role)) throw fail(400, "Choose Customer or Admin.");
  const reason = optionalReason(req.body);
  const action = role === "admin" ? "promote" : "demote";
  await withTransaction(async (conn) => {
    const locked = await lockForAction(conn, Number(req.params.id), req.user);
    guard(req.user, locked, action);
    const t = locked.target;
    // The user is logged out so their next login shows the right pages.
    await conn.query("UPDATE users SET role = ?, token_version = token_version + 1 WHERE user_id = ?", [role, t.user_id]);
    await audit(conn, req.user, action, t, { reason, oldValue: { role: t.role }, newValue: { role } });
  });
  res.json({ ok: true, role });
}));

/* ---------------------------------------------------------------------
   DELETE / ANONYMIZE
   No records: the account is deleted (its cart, saved addresses, consents and
   codes go with it; chat logs keep the messages without the account).
   With orders or shop records: the account is anonymized instead. Orders, order
   items, payments and sales history stay (so totals and the ML forecasts don't
   change), but nothing personal is left: name, email and password are replaced,
   saved addresses are deleted, the addresses on orders keep only city/province/
   region (for delivery stats), order contact emails are cleared, and the account's
   old usernames/emails in the audit log are replaced too.
   --------------------------------------------------------------------- */
async function scrubAuditLabels(conn, id, label) {
  await conn.query(
    `UPDATE admin_audit_log SET target_label = ?,
            old_value = IF(old_value IS NULL, NULL, JSON_REMOVE(old_value, '$.email')),
            new_value = IF(new_value IS NULL, NULL, JSON_REMOVE(new_value, '$.email')),
            old_value = IF(old_value IS NULL OR JSON_EXTRACT(old_value, '$.username') IS NULL, old_value, JSON_SET(old_value, '$.username', ?)),
            new_value = IF(new_value IS NULL OR JSON_EXTRACT(new_value, '$.username') IS NULL, new_value, JSON_SET(new_value, '$.username', ?))
      WHERE target_user_id = ?`, [label, label, label, id]);
  await conn.query("UPDATE admin_audit_log SET admin_label = ? WHERE admin_id = ?", [label, id]);
}

async function anonymize(conn, id, label) {
  await conn.query(
    `UPDATE users SET username = ?, email = ?, email_bidx = ?, password_hash = '!', role = 'user', status = 'deleted',
            suspended_at = NULL, suspended_reason = NULL, token_version = token_version + 1, must_set_password = 0,
            email_verified_at = NULL, last_login_at = NULL, anonymized_at = NOW()
      WHERE user_id = ?`, [label, ...Object.values(emailColumns(`${label}@anonymized.invalid`)), id]);
  await conn.query("UPDATE orders SET contact_email = NULL WHERE user_id = ?", [id]);
  await conn.query(
    `UPDATE delivery_addresses a SET recipient_name = ?, recipient_phone = '', street = '', barangay = '',
            landmark = NULL, lat = NULL, lng = NULL, is_default = 0
      WHERE a.user_id = ? AND EXISTS (SELECT 1 FROM orders o WHERE o.address_id = a.address_id)`,
    [enc("delivery_addresses", "recipient_name", "Deleted customer"), id]);
  await conn.query(
    "DELETE a FROM delivery_addresses a WHERE a.user_id = ? AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.address_id = a.address_id)", [id]);
  await conn.query("DELETE FROM carts WHERE user_id = ?", [id]);
  await conn.query("DELETE FROM email_verifications WHERE user_id = ?", [id]);
  await conn.query("DELETE FROM password_setup_tokens WHERE user_id = ?", [id]);
  await conn.query("UPDATE chat_logs SET user_id = NULL WHERE user_id = ?", [id]);
}

router.delete("/:id(\\d+)", ah(async (req, res) => {
  const reason = optionalReason(req.body);
  const result = await withTransaction(async (conn) => {
    const locked = await lockForAction(conn, Number(req.params.id), req.user);
    guard(req.user, locked, "delete");
    const t = locked.target;
    if (String(req.body?.confirm_username ?? "") !== t.username) {
      throw fail(400, `Type the username "${t.username}" to confirm.`);
    }
    const records = await recordCounts(conn, t.user_id);
    const label = `deleted-user-${t.user_id}`;
    const mode = mustAnonymize(records) ? "anonymize" : "delete";
    // The entry is written under the old name, then scrubbed with the rest.
    await audit(conn, req.user, mode, t, { reason, oldValue: { role: t.role, status: displayStatus(t) },
      newValue: mode === "anonymize" ? { status: "deleted", kept: records } : { status: "deleted" } });
    if (mode === "anonymize") await anonymize(conn, t.user_id, label);
    else await conn.query("DELETE FROM users WHERE user_id = ?", [t.user_id]);
    await scrubAuditLabels(conn, t.user_id, label);
    return { mode, records };
  });
  res.json({ ok: true, result: result.mode === "anonymize" ? "anonymized" : "deleted", kept: result.records });
}));

module.exports = router;
module.exports.blockedReason = blockedReason;   // for tests
