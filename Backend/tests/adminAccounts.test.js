// Admin account management: list, details, create + set-password link, suspend,
// role changes, delete/anonymize, safeguards, the audit log, and the account
// check that requireAuth now does on every request.
jest.mock("../services/mailer", () => require("./mailerMock")());

const request = require("supertest");
const jwt = require("jsonwebtoken");
const app = require("../server");
const { mail } = require("../services/mailer");
const { pool, resetDb, createUser, createProduct } = require("./helpers");

const API = "/api/v1/admin/accounts";
const as = (who) => ({ get: (u) => request(app).get(u).set("Authorization", who.auth),
  post: (u, b = {}) => request(app).post(u).set("Authorization", who.auth).send(b),
  del: (u, b = {}) => request(app).delete(u).set("Authorization", who.auth).send(b) });
const login = (username, password = "secret123") => request(app).post("/api/auth/login").send({ username, password });
const userRow = async (id) => (await pool.query("SELECT * FROM users WHERE user_id = ?", [id]))[0][0];
const auditRows = async () => (await pool.query("SELECT * FROM admin_audit_log ORDER BY audit_id"))[0];

// A user with a real password, so login can be tested.
async function userWithPassword(opts = {}) {
  const u = await createUser(opts);
  await pool.query("UPDATE users SET password_hash = ? WHERE user_id = ?", [await require("bcryptjs").hash("secret123", 4), u.id]);
  return u;
}

// seller: the admin who listed the product (createProduct would otherwise make a new admin).
async function orderFor(user, seller, { status = "delivered", total = 1950 } = {}) {
  const productId = await createProduct({ stock: 20, createdBy: seller.id });
  const [a] = await pool.query(
    `INSERT INTO delivery_addresses (user_id, recipient_name, recipient_phone, street, barangay, city, province, region, postal_code, landmark, lat, lng, shipping_zone)
     VALUES (?, 'Juan Dela Cruz', '09171234567', '123 Mabini St', 'Pembo', 'Makati', NULL, 'NCR', '1218', 'Near the church', 14.55, 121.02, 'NCR')`, [user.id]);
  const [o] = await pool.query(
    "INSERT INTO orders (user_id, address_id, contact_email, status, total_amount, shipping_fee) VALUES (?, ?, ?, ?, ?, 100)",
    [user.id, a.insertId, user.email, status, total]);
  await pool.query("INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?, ?, 2, 925)", [o.insertId, productId]);
  return { orderId: o.insertId, addressId: a.insertId, productId };
}

beforeEach(async () => {
  await resetDb();
  jest.clearAllMocks();
});
afterAll(() => pool.end());

/* ------------------------------------------------------------ list & detail */
describe("list and details", () => {
  test("search, filters, sorting and paging; order counts; deleted accounts hidden unless asked for", async () => {
    const admin = await createUser({ role: "admin", email: "owner@shop.ph" });
    const maria = await createUser({ email: "maria@example.com" });
    const pedro = await createUser({ email: "pedro@example.com", verified: false });
    await orderFor(maria, admin); await orderFor(maria, admin);
    await pool.query("UPDATE users SET status = 'suspended' WHERE user_id = ?", [pedro.id]);
    const gone = await createUser();
    await pool.query("UPDATE users SET status = 'deleted' WHERE user_id = ?", [gone.id]);
    const get = (q) => as(admin).get(`${API}?${q}`);

    const all = (await get("sort=username&dir=asc")).body;
    expect(all.total).toBe(3);
    expect(all.accounts.map((a) => a.username)).toEqual([admin.username, maria.username, pedro.username].sort());
    expect(all.accounts.find((a) => a.user_id === maria.id)).toMatchObject({ email: "maria@example.com", role: "user",
      status: "active", verified: true, order_count: 2 });
    expect((await get("q=maria")).body.accounts.map((a) => a.user_id)).toEqual([maria.id]);
    expect((await get("q=@shop.ph")).body.accounts.map((a) => a.user_id)).toEqual([admin.id]);
    expect((await get("role=admin")).body.accounts.map((a) => a.user_id)).toEqual([admin.id]);
    expect((await get("status=suspended")).body.accounts.map((a) => a.user_id)).toEqual([pedro.id]);
    expect((await get("verified=no")).body.accounts.map((a) => a.user_id)).toEqual([pedro.id]);
    expect((await get("status=deleted")).body.accounts.map((a) => a.user_id)).toEqual([gone.id]);
    expect((await get("sort=order_count&dir=desc")).body.accounts[0].user_id).toBe(maria.id);
    const page2 = (await get("sort=username&dir=asc&per_page=2&page=2")).body;
    expect(page2).toMatchObject({ total: 3, page: 2, per_page: 2 });
    expect(page2.accounts).toHaveLength(1);
    expect((await get("sort=password_hash")).status).toBe(400);
    expect(JSON.stringify(all)).not.toContain("password");
  });

  test("details: profile, saved addresses (not order copies), orders, activity and what's allowed", async () => {
    const admin = await createUser({ role: "admin" });
    const juan = await createUser();
    const { orderId } = await orderFor(juan, admin);
    await pool.query(`INSERT INTO delivery_addresses (user_id, recipient_name, recipient_phone, street, barangay, city, region, postal_code, shipping_zone, is_default)
      VALUES (?, 'Juan', '09171234567', 'Saved St', 'Poblacion', 'Taguig', 'NCR', '1630', 'NCR', 1)`, [juan.id]);
    await as(admin).post(`${API}/${juan.id}/suspend`, { reason: "Chargeback dispute" });

    const { body } = await as(admin).get(`${API}/${juan.id}`);
    expect(body.account).toMatchObject({ user_id: juan.id, status: "suspended", suspended_reason: "Chargeback dispute", is_you: false });
    expect(body.addresses.map((a) => a.street)).toEqual(["Saved St"]);
    expect(body.orders).toEqual([expect.objectContaining({ order_id: orderId, status: "delivered", total_amount: 1950, units: 2 })]);
    expect(body.order_summary).toEqual({ orders: 1, paid_total: 1950 });
    expect(body.activity).toEqual([expect.objectContaining({ action: "suspend", admin: admin.username, reason: "Chargeback dispute" })]);
    expect(body.can.suspend).toEqual({ allowed: false, reason: "This account is already suspended." });
    expect(body.can.unsuspend.allowed).toBe(true);
    expect(body.delete_mode).toBe("anonymize");

    const self = (await as(admin).get(`${API}/${admin.id}`)).body;
    expect(self.account.is_you).toBe(true);
    expect(self.can.delete).toEqual({ allowed: false, reason: "You can't delete your own account." });
    expect((await as(admin).get(`${API}/999999`)).status).toBe(404);
  });

  test("summary: total, admins, new this week, suspended, invited", async () => {
    const admin = await createUser({ role: "admin" });
    const old = await createUser();
    await pool.query("UPDATE users SET created_at = NOW() - INTERVAL 30 DAY WHERE user_id = ?", [old.id]);
    const s = await createUser();
    await pool.query("UPDATE users SET status = 'suspended' WHERE user_id = ?", [s.id]);
    await as(admin).post(API, { username: "newstaff", email: "staff@example.com", role: "admin" });
    expect((await as(admin).get(`${API}/summary`)).body).toEqual({ total: 4, admins: 2, new_this_week: 3, suspended: 1, invited: 1 });
  });
});

/* ------------------------------------------------------------ create + set password */
describe("create account", () => {
  test("creates an invited account and emails a single-use set-password link; setting it verifies the email", async () => {
    const admin = await createUser({ role: "admin" });
    const res = await as(admin).post(API, { username: "ana.reyes", email: "Ana@Example.com", role: "user" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ account: { username: "ana.reyes", email: "ana@example.com", role: "user", status: "invited" }, email_sent: true });
    const id = res.body.account.user_id;
    expect(await userRow(id)).toMatchObject({ must_set_password: 1, email_verified_at: null, created_by: admin.id, status: "active" });

    expect(mail.accountInvite).toHaveBeenCalledWith("ana@example.com", "ana.reyes", "user",
      expect.stringMatching(/^http:\/\/localhost:5500\/Pages\/Homepage\/set-password\.html\?token=[a-f0-9]{64}$/), 72);
    const token = mail.accountInvite.mock.calls[0][3].split("token=")[1];
    const [[stored]] = await pool.query("SELECT token_hash FROM password_setup_tokens WHERE user_id = ?", [id]);
    expect(stored.token_hash).not.toBe(token);   // only the hash is kept

    // Can't log in before setting a password.
    const early = await login("ana.reyes", "anything");
    expect(early.status).toBe(403);
    expect(early.body.code).toBe("PASSWORD_NOT_SET");

    expect((await request(app).get(`/api/auth/set-password?token=${token}`)).body).toEqual({ username: "ana.reyes" });
    expect((await request(app).post("/api/auth/set-password").send({ token, password: "123" })).status).toBe(400);
    const set = await request(app).post("/api/auth/set-password").send({ token, password: "newpass123" });
    expect(set.body).toMatchObject({ username: "ana.reyes" });
    expect((await userRow(id)).email_verified_at).not.toBeNull();
    expect((await login("ana.reyes", "newpass123")).status).toBe(200);
    // Single use.
    expect((await request(app).post("/api/auth/set-password").send({ token, password: "another123" })).status).toBe(400);

    expect((await auditRows()).map((a) => [a.action, a.target_user_id, a.new_value])).toEqual(
      [["create_account", id, { username: "ana.reyes", email: "ana@example.com", role: "user" }]]);
  });

  test("validation, duplicates, expired links and resend (which cancels the old link)", async () => {
    const admin = await createUser({ role: "admin" });
    const juan = await createUser();
    expect((await as(admin).post(API, { username: "x", email: "a@b.co" })).status).toBe(400);
    expect((await as(admin).post(API, { username: "valid_name", email: "nope" })).status).toBe(400);
    expect((await as(admin).post(API, { username: "valid_name", email: "a@b.co", role: "owner" })).status).toBe(400);
    expect((await as(admin).post(API, { username: juan.username, email: "new@b.co" })).body.error).toBe("That username is already taken.");
    expect((await as(admin).post(API, { username: "fresh", email: juan.email })).body.error).toBe("An account with that email already exists.");

    const { body } = await as(admin).post(API, { username: "staff2", email: "staff2@example.com", role: "admin" });
    const first = mail.accountInvite.mock.calls[0][3].split("token=")[1];
    expect((await as(admin).post(`${API}/${body.account.user_id}/resend-invite`)).status).toBe(200);
    const second = mail.accountInvite.mock.calls[1][3].split("token=")[1];
    expect((await request(app).get(`/api/auth/set-password?token=${first}`)).status).toBe(400);
    await pool.query("UPDATE password_setup_tokens SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE used_at IS NULL");
    expect((await request(app).post("/api/auth/set-password").send({ token: second, password: "newpass123" })).status).toBe(400);
    expect((await as(admin).post(`${API}/${juan.id}/resend-invite`)).body.error).toBe("This account has already set its password.");
  });

  test("if the email can't be sent, the account still exists and the admin is told", async () => {
    const admin = await createUser({ role: "admin" });
    mail.accountInvite.mockRejectedValueOnce(new Error("SMTP down"));
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await as(admin).post(API, { username: "noemail", email: "noemail@example.com" });
    spy.mockRestore();
    expect(res.status).toBe(201);
    expect(res.body.email_sent).toBe(false);
  });
});

/* ------------------------------------------------------------ suspend */
// Every route behind requireAuth / requireAdmin, found from the app itself.
function protectedRoutes() {
  const rows = [];
  const prefixOf = (l) => l.regexp.source.replace(/^\^/, "").replace(/\\\/\?\(\?=\\\/\|\$\)$/, "").replace(/\\\//g, "/");
  (function walk(stack, prefix, inherited) {
    const mw = [];
    for (const l of stack) {
      if (l.route) {
        const names = [...inherited, ...mw, ...l.route.stack.map((s) => s.name)];
        const guard = names.includes("requireAdmin") ? "admin" : names.includes("requireAuth") ? "auth" : null;
        const path = (prefix + l.route.path).replace(/:(\w+)\([^)]*\)/g, "1").replace(/:\w+/g, "1").replace(/\/$/, "");
        if (guard) Object.keys(l.route.methods).forEach((m) => rows.push({ method: m, path, guard }));
      } else if (l.name === "router") walk(l.handle.stack, prefix + prefixOf(l), [...inherited, ...mw]);
      else if (prefix) mw.push(l.name);
    }
  })(app._router.stack, "", []);
  return rows;
}

describe("suspend and unsuspend", () => {
  test("a suspended customer is blocked on every protected route, at once, with the suspended message", async () => {
    const admin = await createUser({ role: "admin" });
    const juan = await userWithPassword();
    expect((await request(app).get("/api/v1/account/me").set("Authorization", juan.auth)).status).toBe(200);
    expect((await as(admin).post(`${API}/${juan.id}/suspend`, { reason: "Repeated fake orders" })).status).toBe(200);

    const routes = protectedRoutes();
    expect(routes.length).toBeGreaterThan(50);
    for (const r of routes) {
      const res = await request(app)[r.method](r.path).set("Authorization", juan.auth).send({});
      expect([r.method, r.path, res.status, res.body]).toEqual(
        [r.method, r.path, 403, { error: "Your account is suspended. Contact the shop.", code: "ACCOUNT_SUSPENDED" }]);
    }
    const again = await login(juan.username);
    expect(again.status).toBe(403);
    expect(again.body).toEqual({ error: "Your account is suspended. Contact the shop.", code: "ACCOUNT_SUSPENDED" });
    expect((await login(juan.username, "wrong")).body.error).toBe("Invalid username or password.");   // no status leak
  });

  test("a suspended admin loses admin access too; the chat treats them as a guest", async () => {
    const admin = await createUser({ role: "admin" });
    const other = await createUser({ role: "admin" });
    await as(admin).post(`${API}/${other.id}/suspend`, { reason: "Left the company" });
    for (const r of protectedRoutes().filter((x) => x.guard === "admin").slice(0, 15)) {
      const res = await request(app)[r.method](r.path).set("Authorization", other.auth).send({});
      expect([r.path, res.status, res.body.code]).toEqual([r.path, 403, "ACCOUNT_SUSPENDED"]);
    }
  });

  test("unsuspending lets them log in again, but old tokens stay logged out", async () => {
    const admin = await createUser({ role: "admin" });
    const juan = await userWithPassword();
    await as(admin).post(`${API}/${juan.id}/suspend`, { reason: "Checking a payment" });
    expect((await as(admin).post(`${API}/${juan.id}/unsuspend`, { reason: "Payment cleared" })).status).toBe(200);
    const old = await request(app).get("/api/v1/account/me").set("Authorization", juan.auth);
    expect(old.status).toBe(401);
    expect(old.body.code).toBe("SESSION_ENDED");
    const fresh = await login(juan.username);
    expect(fresh.status).toBe(200);
    expect((await request(app).get("/api/v1/account/me").set("Authorization", `Bearer ${fresh.body.token}`)).status).toBe(200);
    expect((await userRow(juan.id)).last_login_at).not.toBeNull();
    expect((await auditRows()).map((a) => [a.action, a.reason, a.old_value, a.new_value])).toEqual([
      ["suspend", "Checking a payment", { status: "active" }, { status: "suspended" }],
      ["unsuspend", "Payment cleared", { status: "suspended" }, { status: "active" }]]);
  });

  test("a reason is required, both ways", async () => {
    const admin = await createUser({ role: "admin" });
    const juan = await createUser();
    expect((await as(admin).post(`${API}/${juan.id}/suspend`, {})).body.error).toBe("Write a reason (at least 3 characters).");
    expect((await as(admin).post(`${API}/${juan.id}/suspend`, { reason: "  " })).status).toBe(400);
    await as(admin).post(`${API}/${juan.id}/suspend`, { reason: "Spam" });
    expect((await as(admin).post(`${API}/${juan.id}/unsuspend`, { reason: "" })).status).toBe(400);
    expect((await as(admin).post(`${API}/${juan.id}/suspend`, { reason: "Again" })).status).toBe(409);
  });

  test("tokens issued before migration 008 (no version) keep working", async () => {
    const juan = await createUser();
    const legacy = jwt.sign({ userId: juan.id, username: juan.username, role: "user" }, process.env.JWT_SECRET);
    expect((await request(app).get("/api/v1/account/me").set("Authorization", `Bearer ${legacy}`)).status).toBe(200);
  });
});

/* ------------------------------------------------------------ roles */
describe("promote and demote", () => {
  test("promoting gives admin access after the next login; the role comes from the database, not the token", async () => {
    const admin = await createUser({ role: "admin" });
    const maria = await userWithPassword();
    expect((await as(admin).post(`${API}/${maria.id}/role`, { role: "admin", reason: "New staff" })).body).toEqual({ ok: true, role: "admin" });
    expect((await request(app).get("/api/v1/account/me").set("Authorization", maria.auth)).body.code).toBe("SESSION_ENDED");
    const fresh = await login(maria.username);
    expect(fresh.body.user.role).toBe("admin");
    expect((await request(app).get(`${API}/summary`).set("Authorization", `Bearer ${fresh.body.token}`)).status).toBe(200);
    expect((await auditRows()).at(-1)).toMatchObject({ action: "promote", reason: "New staff", old_value: { role: "user" }, new_value: { role: "admin" } });
  });

  test("a demoted admin's admin access ends at once, even with a token that says admin", async () => {
    const admin = await createUser({ role: "admin" });
    const other = await createUser({ role: "admin" });
    await as(admin).post(`${API}/${other.id}/role`, { role: "user" });
    // Even a token minted with the new version but claiming "admin" is not trusted.
    const forged = jwt.sign({ userId: other.id, username: other.username, role: "admin", tv: 1 }, process.env.JWT_SECRET);
    const res = await request(app).get(`${API}/summary`).set("Authorization", `Bearer ${forged}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Admin account required.");
    expect((await as(admin).post(`${API}/${other.id}/role`, { role: "user" })).body.error).toBe("This account is already a customer.");
    expect((await as(admin).post(`${API}/${other.id}/role`, { role: "owner" })).status).toBe(400);
  });
});

/* ------------------------------------------------------------ delete / anonymize */
describe("delete and anonymize", () => {
  test("no orders: the account is deleted, with its cart and saved addresses; the username must be typed", async () => {
    const admin = await createUser({ role: "admin" });
    const temp = await createUser();
    await pool.query(`INSERT INTO delivery_addresses (user_id, recipient_name, recipient_phone, street, barangay, city, region, postal_code, shipping_zone)
      VALUES (?, 'Temp', '09170000000', 'St', 'Brgy', 'City', 'NCR', '1000', 'NCR')`, [temp.id]);
    expect((await as(admin).del(`${API}/${temp.id}`, { confirm_username: "wrong" })).body.error).toBe(`Type the username "${temp.username}" to confirm.`);
    const res = await as(admin).del(`${API}/${temp.id}`, { confirm_username: temp.username, reason: "Duplicate account" });
    expect(res.body).toMatchObject({ ok: true, result: "deleted" });
    expect(await userRow(temp.id)).toBeUndefined();
    expect((await pool.query("SELECT COUNT(*) n FROM delivery_addresses WHERE user_id = ?", [temp.id]))[0][0].n).toBe(0);
    const [entry] = await auditRows();
    expect(entry).toMatchObject({ action: "delete", target_user_id: temp.id, target_label: `deleted-user-${temp.id}`, reason: "Duplicate account" });
  });

  test("with orders: anonymized; orders, items and sales totals are kept, personal info is gone everywhere", async () => {
    const admin = await createUser({ role: "admin" });
    const juan = await userWithPassword({ email: "juan.delacruz@example.com" });
    const { orderId, addressId, productId } = await orderFor(juan, admin);
    await pool.query(`INSERT INTO delivery_addresses (user_id, recipient_name, recipient_phone, street, barangay, city, region, postal_code, shipping_zone)
      VALUES (?, 'Juan', '09171234567', 'Saved St', 'Poblacion', 'Taguig', 'NCR', '1630', 'NCR')`, [juan.id]);
    await pool.query("INSERT INTO chat_logs (session_id, user_id, message, reply, answered) VALUES ('s-12345678', ?, 'hi', 'hello', 1)", [juan.id]);
    await as(admin).post(`${API}/${juan.id}/suspend`, { reason: "Asked to close the account" });
    const salesBefore = (await pool.query("SELECT SUM(quantity * unit_price) s FROM order_items"))[0][0].s;

    const res = await as(admin).del(`${API}/${juan.id}`, { confirm_username: juan.username, reason: "Customer request" });
    expect(res.body).toEqual({ ok: true, result: "anonymized", kept: { orders: 1, products_listed: 0, staff_records: 0 } });

    const u = await userRow(juan.id);
    expect(u).toMatchObject({ username: `deleted-user-${juan.id}`, email: `deleted-user-${juan.id}@anonymized.invalid`, status: "deleted",
      email_verified_at: null, last_login_at: null, suspended_reason: null });
    expect(u.anonymized_at).not.toBeNull();
    // Orders and sales history stay.
    const [[order]] = await pool.query("SELECT user_id, status, total_amount, contact_email FROM orders WHERE order_id = ?", [orderId]);
    expect(order).toEqual({ user_id: juan.id, status: "delivered", total_amount: "1950.00", contact_email: null });
    expect((await pool.query("SELECT SUM(quantity * unit_price) s FROM order_items"))[0][0].s).toBe(salesBefore);
    expect((await pool.query("SELECT product_id FROM order_items WHERE order_id = ?", [orderId]))[0]).toEqual([{ product_id: productId }]);
    // The order's address keeps only the area; the saved address is gone.
    const [addresses] = await pool.query("SELECT * FROM delivery_addresses WHERE user_id = ?", [juan.id]);
    expect(addresses).toHaveLength(1);
    expect(addresses[0]).toMatchObject({ address_id: addressId, recipient_name: "Deleted customer", recipient_phone: "", street: "",
      barangay: "", landmark: null, lat: null, lng: null, city: "Makati", region: "NCR" });
    expect((await pool.query("SELECT user_id FROM chat_logs"))[0]).toEqual([{ user_id: null }]);
    // Nothing personal is left in the audit log either.
    const log = JSON.stringify(await auditRows());
    expect(log).not.toContain(juan.username);
    expect(log).not.toContain("juan.delacruz");
    expect((await auditRows()).map((a) => a.action)).toEqual(["suspend", "anonymize"]);
    // Can't log in, and the old token is dead.
    expect((await login(`deleted-user-${juan.id}`, "secret123")).status).toBe(401);
    expect((await request(app).get("/api/orders").set("Authorization", juan.auth)).body.code).toBe("SESSION_ENDED");
    // Listed as deleted only when asked for.
    expect((await as(admin).get(API)).body.accounts.map((a) => a.user_id)).not.toContain(juan.id);
    expect((await as(admin).post(`${API}/${juan.id}/unsuspend`, { reason: "oops" })).body.error).toBe("This account was deleted.");
  });

  test("an admin who listed products is anonymized, not deleted, so the product history stays", async () => {
    const admin = await createUser({ role: "admin" });
    const staff = await createUser({ role: "admin" });
    await createProduct({ createdBy: staff.id });
    const res = await as(admin).del(`${API}/${staff.id}`, { confirm_username: staff.username });
    expect(res.body).toMatchObject({ result: "anonymized", kept: { orders: 0, products_listed: 1 } });
    expect((await userRow(staff.id)).role).toBe("user");
  });
});

/* ------------------------------------------------------------ safeguards */
describe("safeguards (enforced by the server)", () => {
  test("an admin can't suspend, demote or delete their own account", async () => {
    const me = await createUser({ role: "admin" });
    await createUser({ role: "admin" });   // not the last admin, so only the self rule applies
    const suspend = await as(me).post(`${API}/${me.id}/suspend`, { reason: "test" });
    expect(suspend.status).toBe(403);
    expect(suspend.body).toEqual({ error: "You can't suspend your own account.", code: "OWN_ACCOUNT" });
    expect((await as(me).post(`${API}/${me.id}/role`, { role: "user" })).body.error).toBe("You can't remove admin access from your own account.");
    expect((await as(me).del(`${API}/${me.id}`, { confirm_username: me.username })).body.error).toBe("You can't delete your own account.");
    expect(await userRow(me.id)).toMatchObject({ role: "admin", status: "active" });
    expect(await auditRows()).toEqual([]);
  });

  test("the last active admin can't be suspended, demoted or deleted (the rule itself)", () => {
    const { blockedReason } = require("../routes/adminAccounts");
    const actor = { userId: 1 };
    const lastAdmin = { user_id: 2, username: "owner", role: "admin", status: "active" };
    for (const action of ["suspend", "demote", "delete"]) {
      expect(blockedReason(actor, lastAdmin, action, 0)).toBe("owner is the last active admin. Make another account an admin first.");
      expect(blockedReason(actor, lastAdmin, action, 1)).toBeNull();
    }
    // A suspended admin isn't an active one, so removing them is fine.
    expect(blockedReason(actor, { ...lastAdmin, status: "suspended" }, "delete", 0)).toBeNull();
  });

  test.each([
    ["suspend", (who, target) => as(who).post(`${API}/${target.id}/suspend`, { reason: "Removing access" })],
    ["demote", (who, target) => as(who).post(`${API}/${target.id}/role`, { role: "user" })],
    ["delete", (who, target) => as(who).del(`${API}/${target.id}`, { confirm_username: target.username })],
  ])("two admins who %s each other at the same moment: exactly one wins, one active admin is always left", async (action, act) => {
    for (let round = 0; round < 3; round++) {
      await resetDb();
      const a = await createUser({ role: "admin" });
      const b = await createUser({ role: "admin" });
      const results = await Promise.all([act(a, b), act(b, a)]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses[0]).toBe(200);
      expect(statuses[1]).not.toBe(200);
      expect([401, 403, 409]).toContain(statuses[1]);
      const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'");
      expect(n).toBe(1);
    }
  });

});

/* ------------------------------------------------------------ non-admins */
describe("non-admins are blocked", () => {
  test("customers get 403 and guests 401 on every account route; nothing changes", async () => {
    const customer = await createUser();
    const victim = await createUser();
    const routes = protectedRoutes().filter((r) => r.path.startsWith(API));
    expect(routes.length).toBe(10);
    for (const r of routes) {
      const path = r.path.replace(/\/1(\/|$)/, `/${victim.id}$1`);
      const asCustomer = await request(app)[r.method](path).set("Authorization", customer.auth).send({ reason: "x", role: "admin", confirm_username: victim.username, username: "hacker", email: "h@x.co" });
      expect([r.method, path, asCustomer.status, asCustomer.body.error]).toEqual([r.method, path, 403, "Admin account required."]);
      expect((await request(app)[r.method](path).send({})).status).toBe(401);
    }
    expect(await userRow(victim.id)).toMatchObject({ role: "user", status: "active" });
    expect((await pool.query("SELECT COUNT(*) n FROM users"))[0][0].n).toBe(2);
    expect(await auditRows()).toEqual([]);
  });
});
