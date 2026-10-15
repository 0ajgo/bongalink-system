// Personal information at rest (REQ027, REQ030; RA 10173): AES-256-GCM field encryption,
// the email blind index, what's stored raw in the database, masking, logs without
// personal data, the startup check, and the one-time encryption script.
jest.mock("../services/mailer", () => require("./mailerMock")());

const path = require("path");
const { spawn, execFile } = require("child_process");
const request = require("supertest");
const app = require("../server");
const { mail } = require("../services/mailer");
const dp = require("../lib/dataProtection");
const { dec, enc, maskEmail, maskPhone, maskText, redactForLog } = require("../lib/pii");
const { pool, resetDb, createUser, createProduct, fillCart, orderBody, insertAddress } = require("./helpers");

const BACKEND = path.join(__dirname, "..");
const raw = async (sql, params = []) => (await pool.query(sql, params))[0];
const ENC = /^enc:v1:[A-Za-z0-9+/]+={0,2}$/;

beforeEach(async () => {
  await resetDb();
  jest.clearAllMocks();
});
afterAll(() => pool.end());

/* ------------------------------------------------------------ the cipher */
describe("AES-256-GCM field encryption", () => {
  test("round trip; a fresh IV every time; versioned format", () => {
    const a = dp.encrypt("Juan Dela Cruz", "delivery_addresses.recipient_name");
    const b = dp.encrypt("Juan Dela Cruz", "delivery_addresses.recipient_name");
    expect(a).toMatch(ENC);
    expect(a).not.toBe(b);
    expect(a).not.toContain("Juan");
    expect(dp.decrypt(a, "delivery_addresses.recipient_name")).toBe("Juan Dela Cruz");
    expect(dp.decrypt(dp.encrypt("Ñiño — ₱1,250 📦", "chat_logs.message"), "chat_logs.message")).toBe("Ñiño — ₱1,250 📦");
    expect(dp.encrypt(null, "x.y")).toBeNull();
    expect(dp.encrypt("", "x.y")).toBe("");
    expect(dp.keyVersionOf(a)).toBe(1);
  });

  test("a tampered value, a value moved to another column, or a plain value is rejected", () => {
    const stored = dp.encrypt("09171234567", "delivery_addresses.recipient_phone");
    const bytes = Buffer.from(stored.slice("enc:v1:".length), "base64");
    bytes[bytes.length - 1] ^= 1;   // flip one bit of the ciphertext
    const tampered = `enc:v1:${bytes.toString("base64")}`;
    expect(() => dp.decrypt(tampered, "delivery_addresses.recipient_phone")).toThrow(/could not be decrypted/);
    expect(() => dp.decrypt(stored, "delivery_addresses.street")).toThrow(/could not be decrypted/);   // bound to its column
    expect(() => dp.decrypt("09171234567", "delivery_addresses.recipient_phone")).toThrow(/not encrypted/);
    expect(() => dp.decrypt("enc:v7:AAAA", "users.email")).toThrow(/no key for version 7/);
    try { dp.decrypt(tampered, "users.email"); } catch (err) { expect(err.message).not.toContain("0917"); }
  });

  test("key rotation: new values use the new version, old values still decrypt", () => {
    const saved = { ...process.env };
    const old = dp.encrypt("old value", "users.email");
    try {
      process.env.DATA_ENCRYPTION_KEY_V1 = saved.DATA_ENCRYPTION_KEY;
      process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");
      process.env.DATA_ENCRYPTION_KEY_VERSION = "2";
      const fresh = dp.encrypt("new value", "users.email");
      expect(fresh.startsWith("enc:v2:")).toBe(true);
      expect(dp.decrypt(old, "users.email")).toBe("old value");
      expect(dp.decrypt(fresh, "users.email")).toBe("new value");
      expect(dp.status()).toEqual({ algorithm: "AES-256-GCM", version: 2, readable: [1, 2] });
    } finally {
      process.env = saved;
    }
  });

  test("blind index: same for the same email in any case or spacing, different for others, keyed", () => {
    const i = dp.blindIndex("Juan@Example.com");
    expect(i).toMatch(/^[0-9a-f]{64}$/);
    expect(dp.blindIndex("  juan@example.com ")).toBe(i);
    expect(dp.blindIndex("juan2@example.com")).not.toBe(i);
    expect(i).not.toBe(require("crypto").createHash("sha256").update("email:juan@example.com").digest("hex"));
    expect(dp.blindIndex("")).toBeNull();
  });

  test("missing or wrong-size keys are reported by name, never by value", () => {
    const saved = { ...process.env };
    try {
      delete process.env.DATA_INDEX_KEY;
      expect(() => dp.assertReady()).toThrow("Encryption keys not set: DATA_INDEX_KEY");
      process.env.DATA_INDEX_KEY = Buffer.alloc(16, 1).toString("base64");
      expect(() => dp.assertReady()).toThrow(/DATA_INDEX_KEY must be 32 bytes/);
    } finally {
      process.env = saved;
    }
    expect(() => dp.assertReady()).not.toThrow();
  });
});

/* ------------------------------------------------------------ stored encrypted */
describe("stored encrypted in the database (raw check)", () => {
  test("registration: email encrypted with its blind index; privacy consent required and recorded", async () => {
    const missing = await request(app).post("/api/auth/register").send({ username: "ana", email: "Ana.Reyes@example.com", password: "secret123" });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("PRIVACY_CONSENT_REQUIRED");

    const res = await request(app).post("/api/auth/register")
      .send({ username: "ana", email: "Ana.Reyes@example.com", password: "secret123", privacy_consent: true });
    expect(res.status).toBe(201);
    const [user] = await raw("SELECT user_id, email, email_bidx FROM users WHERE username = 'ana'");
    expect(user.email).toMatch(ENC);
    expect(user.email.toLowerCase()).not.toContain("ana.reyes");
    expect(dec("users", "email", user.email)).toBe("Ana.Reyes@example.com");
    expect(user.email_bidx).toBe(dp.blindIndex("ana.reyes@example.com"));
    expect(await raw("SELECT consent_type, granted, policy_version, source FROM consent_records WHERE user_id = ?", [user.user_id]))
      .toEqual([{ consent_type: "PRIVACY_NOTICE", granted: 1, policy_version: "2026-10-16", source: "registration" }]);

    // Duplicates are found through the index, whatever the case.
    const dup = await request(app).post("/api/auth/register")
      .send({ username: "ana2", email: "ANA.REYES@example.com", password: "secret123", privacy_consent: true });
    expect(dup.status).toBe(409);
    // Verification looks the email up by its index, and mails the decrypted address.
    expect(mail.verificationCode).toHaveBeenCalledWith("Ana.Reyes@example.com", "ana", expect.stringMatching(/^\d{6}$/), 15);
    const code = mail.verificationCode.mock.calls[0][2];
    expect((await request(app).post("/api/v1/auth/verify-email/confirm").send({ email: "ana.reyes@EXAMPLE.com", code })).status).toBe(200);
    // Login (by username) still works.
    expect((await request(app).post("/api/auth/login").send({ username: "ana", password: "secret123" })).status).toBe(200);
  });

  test("checkout: every personal address field and the contact email are encrypted; areas stay plain", async () => {
    const user = await createUser();
    await fillCart(user.id, [{ productId: await createProduct({ price: 500 }), quantity: 1 }]);
    const body = orderBody({ courier: "LALAMOVE" });
    body.address = { ...body.address, lat: 14.548, lng: 121.057, landmark: "Near the church" };
    const lalamove = require("../services/lalamove");
    jest.spyOn(lalamove, "getQuotation").mockResolvedValue({ total: 187, distanceKm: 3 });
    jest.spyOn(require("../services/geocode"), "reverse").mockResolvedValue({ region: "NCR", province: null, city: "Makati", zone: "NCR" });
    const res = await request(app).post("/api/orders").set("Authorization", user.auth).send(body);
    expect(res.status).toBe(201);

    const [a] = await raw("SELECT * FROM delivery_addresses");
    for (const f of ["recipient_name", "recipient_phone", "street", "barangay", "city", "postal_code", "landmark", "lat", "lng"]) {
      expect([f, a[f]]).toEqual([f, expect.stringMatching(ENC)]);
    }
    expect(JSON.stringify(a)).not.toMatch(/Juan|Dela Cruz|0917|123 Street|Pembo|Makati|1218|church|14\.548|121\.057/);
    expect(a).toMatchObject({ region: "NCR", shipping_zone: "NCR" });   // plain on purpose
    const [o] = await raw("SELECT contact_email FROM orders");
    expect(o.contact_email).toMatch(ENC);
    expect(dec("orders", "contact_email", o.contact_email)).toBe("buyer@example.com");

    // The customer's own pages and the admin's Deliveries page get it back decrypted.
    const admin = await createUser({ role: "admin" });
    await pool.query("UPDATE orders SET status = 'paid', paid_at = NOW()");
    const list = (await request(app).get("/api/v1/admin/orders/awaiting-shipment").set("Authorization", admin.auth)).body;
    expect(list[0]).toMatchObject({ ship_name: "Juan Dela Cruz", ship_phone: "09171234567", ship_landmark: "Near the church",
      ship_address: "123 Street, Pembo, Makati, 1218", customer_email: "b***@example.com" });
  });

  test("saved addresses, chat messages, suspension and audit reasons are encrypted too", async () => {
    const user = await createUser();
    jest.spyOn(require("../services/geocode"), "reverse").mockRejectedValue(Object.assign(new Error("down"), { status: 503 }));
    const saved = await request(app).post("/api/v1/account/addresses").set("Authorization", user.auth).send({
      recipient_name: "Maria Santos", recipient_phone: "09181234567", street: "1 Rizal St", barangay: "San Antonio",
      city: "Pasig", region: "NCR", postal_code: "1600" });
    expect(saved.status).toBe(201);
    expect(saved.body).toMatchObject({ recipient_name: "Maria Santos", street: "1 Rizal St", city: "Pasig" });
    const [a] = await raw("SELECT recipient_name, street, city FROM delivery_addresses");
    expect(Object.values(a).every((v) => ENC.test(v))).toBe(true);

    const admin = await createUser({ role: "admin" });
    await request(app).post(`/api/v1/admin/accounts/${user.id}/suspend`).set("Authorization", admin.auth).send({ reason: "Called 09171112222 about fraud" });
    const [u] = await raw("SELECT suspended_reason FROM users WHERE user_id = ?", [user.id]);
    expect(u.suspended_reason).toMatch(ENC);
    const [log] = await raw("SELECT reason FROM admin_audit_log");
    expect(log.reason).toMatch(ENC);
    const detail = (await request(app).get(`/api/v1/admin/accounts/${user.id}`).set("Authorization", admin.auth)).body;
    expect(detail.account.suspended_reason).toBe("Called 09171112222 about fraud");
    expect(detail.activity[0].reason).toBe("Called 09171112222 about fraud");

    await pool.query("INSERT INTO chat_logs (session_id, message, reply, answered) VALUES ('s-12345678', ?, ?, 1)",
      [enc("chat_logs", "message", "Send to juan@example.com or 0917 123 4567"), enc("chat_logs", "reply", "Okay")]);
    const chat = (await request(app).get("/api/v1/admin/chat/logs?days=all").set("Authorization", admin.auth)).body.logs[0];
    expect(chat.message).toBe("Send to j***@example.com or 0917****567");   // masked in the list
    expect((await request(app).get("/api/v1/admin/chat/logs?days=all&q=juan@example").set("Authorization", admin.auth)).body.logs).toHaveLength(1);
    const convo = (await request(app).get("/api/v1/admin/chat/sessions/s-12345678").set("Authorization", admin.auth)).body;
    expect(convo.messages[0].message).toBe("Send to juan@example.com or 0917 123 4567");   // whole in the conversation view
  });

  test("account search by email uses the blind index; the list shows masked emails", async () => {
    const admin = await createUser({ role: "admin" });
    const maria = await createUser({ email: "maria.santos@example.com" });
    const find = async (q) => (await request(app).get(`/api/v1/admin/accounts?q=${encodeURIComponent(q)}`).set("Authorization", admin.auth)).body.accounts;
    expect((await find("Maria.Santos@example.com")).map((a) => [a.user_id, a.email])).toEqual([[maria.id, "m***@example.com"]]);
    expect(await find("santos@example")).toEqual([]);   // partial emails can't match encrypted data
  });
});

/* ------------------------------------------------------------ masking and logs */
describe("masking and logs", () => {
  test("masking helpers", () => {
    expect(maskEmail("juan.delacruz@gmail.com")).toBe("j***@gmail.com");
    expect(maskPhone("09171234567")).toBe("0917****567");
    expect(maskText("Email me at ana@x.ph or call +63 917 123 4567")).toBe("Email me at a***@x.ph or call +639****567");
  });

  test("errors are logged without personal data (mail errors, SQL errors with values)", async () => {
    const logged = [];
    const spies = ["log", "warn", "error"].map((m) => jest.spyOn(console, m).mockImplementation((...a) => logged.push(a.join(" "))));
    try {
      // A mail server that echoes the recipient.
      mail.verificationCode.mockRejectedValueOnce(new Error("550 5.1.1 <leak.me@example.com>: Recipient address rejected"));
      await request(app).post("/api/auth/register").send({ username: "leaky", email: "leak.me@example.com", password: "secret123", privacy_consent: true });

      // A database error carrying the SQL and its values, through the global error handler.
      const user = await createUser();
      const sqlError = Object.assign(new Error("Duplicate entry 'leak.me@example.com' for key 'x'"),
        { code: "ER_DUP_ENTRY", sql: "INSERT INTO t VALUES ('Juan Dela Cruz', '09171234567')" });
      const spy = jest.spyOn(pool, "query").mockRejectedValueOnce(sqlError);
      await request(app).get("/api/v1/account/addresses").set("Authorization", user.auth);
      spy.mockRestore();

      // Checkout losing its database connection after reading the cart.
      await fillCart(user.id, [{ productId: await createProduct(), quantity: 1 }]);
      const failing = jest.spyOn(pool, "getConnection").mockRejectedValueOnce(
        Object.assign(new Error("Lost connection while writing '09171234567'"), { code: "PROTOCOL_CONNECTION_LOST" }));
      const checkout = await request(app).post("/api/orders").set("Authorization", user.auth).send(orderBody());
      failing.mockRestore();
      expect(checkout.status).toBe(500);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    const text = logged.join("\n");
    expect(logged.length).toBeGreaterThan(2);
    for (const secret of ["leak.me@example.com", "leak.me", "Juan Dela Cruz", "09171234567", "INSERT INTO"]) expect(text).not.toContain(secret);
    expect(text).toMatch(/Verification email failed .*\[email\]/);
  });

  test("redactForLog scrubs emails, phones, quoted SQL values and ciphertext", () => {
    expect(redactForLog(`Duplicate 'x@y.com' and 0917 123 4567 and ${enc("users", "email", "a@b.co")}`))
      .toBe("Duplicate '…' and [phone] and [encrypted]");
  });
});

/* ------------------------------------------------------------ startup */
describe("startup", () => {
  test("the server refuses to start without the keys, naming them but printing no value", async () => {
    const env = { ...process.env, PORT: "0", DATA_ENCRYPTION_KEY: "", DATA_INDEX_KEY: "" };
    const out = await new Promise((resolve) => {
      let text = "";
      const child = spawn(process.execPath, ["server.js"], { cwd: BACKEND, env });
      child.stdout.on("data", (d) => { text += d; });
      child.stderr.on("data", (d) => { text += d; });
      const timer = setTimeout(() => child.kill(), 15000);
      child.on("exit", (code) => { clearTimeout(timer); resolve({ code, text }); });
    });
    expect(out.code).toBe(1);
    expect(out.text).toContain("Encryption: off, keys not set (DATA_ENCRYPTION_KEY, DATA_INDEX_KEY)");
    expect(out.text).toContain("The server will not start without it");
    expect(out.text).not.toContain("Bongalink API running");
  }, 20000);
});

/* ------------------------------------------------------------ one-time script */
describe("scripts/encrypt-personal-data.js", () => {
  const run = (...args) => new Promise((resolve) => {
    execFile(process.execPath, ["scripts/encrypt-personal-data.js", ...args], { cwd: BACKEND, env: process.env },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr }));
  });

  // Rows as they are before encryption (the state right after migration 009).
  async function plainRows() {
    const [u] = await pool.query("INSERT INTO users (username, email, password_hash, role) VALUES ('legacy', 'Legacy.User@Example.com', 'x', 'user')");
    const [a] = await pool.query(
      `INSERT INTO delivery_addresses (user_id, recipient_name, recipient_phone, street, barangay, city, province, region, postal_code, landmark, lat, lng, shipping_zone)
       VALUES (?, 'Pedro Penduko', '09991234567', '7 Luna St', 'Malate', 'Manila', NULL, 'NCR', '1004', NULL, '14.5700000', '120.9900000', 'NCR')`, [u.insertId]);
    await pool.query("INSERT INTO orders (user_id, address_id, contact_email, status, total_amount) VALUES (?, ?, 'pedro@example.com', 'completed', 100)", [u.insertId, a.insertId]);
    await pool.query("INSERT INTO chat_logs (session_id, user_id, message, reply, answered) VALUES ('s-legacy-01', ?, 'Call me at 09991234567', 'Sure', 1)", [u.insertId]);
    await pool.query(`INSERT INTO admin_audit_log (admin_label, action, target_user_id, target_label, reason, new_value)
                      VALUES ('owner', 'create_account', ?, 'legacy', 'Walk-in customer', '{"email":"Legacy.User@Example.com","role":"user"}')`, [u.insertId]);
    // One value already encrypted (a re-run must leave it alone).
    await pool.query("UPDATE users SET suspended_reason = ? WHERE user_id = ?", [enc("users", "suspended_reason", "already encrypted"), u.insertId]);
    return u.insertId;
  }

  test("plan writes nothing; apply encrypts and verifies; a second run changes nothing; no values printed", async () => {
    const id = await plainRows();
    const plan = await run();
    expect(plan.code).toBe(0);
    expect(plan.out).toContain("PLAN (nothing is written)");
    expect((await raw("SELECT email FROM users WHERE user_id = ?", [id]))[0].email).toBe("Legacy.User@Example.com");

    expect((await run("--apply")).out).toContain("--apply needs --database bongalink_test");
    const apply = await run("--apply", "--database", "bongalink_test");
    expect(apply.code).toBe(0);
    expect(apply.out).toContain("Verified: every encrypted value decrypts, every email has its index.");
    for (const secret of ["Legacy.User", "Pedro", "0999", "Luna", "pedro@example.com", "Walk-in"]) expect(apply.out).not.toContain(secret);

    const [u] = await raw("SELECT email, email_bidx, suspended_reason FROM users WHERE user_id = ?", [id]);
    expect(dec("users", "email", u.email)).toBe("Legacy.User@Example.com");
    expect(u.email_bidx).toBe(dp.blindIndex("legacy.user@example.com"));
    expect(dec("users", "suspended_reason", u.suspended_reason)).toBe("already encrypted");
    const [a] = await raw("SELECT * FROM delivery_addresses");
    expect([dec("delivery_addresses", "recipient_name", a.recipient_name), dec("delivery_addresses", "lat", a.lat)]).toEqual(["Pedro Penduko", "14.5700000"]);
    expect(a.region).toBe("NCR");
    expect(dec("orders", "contact_email", (await raw("SELECT contact_email FROM orders"))[0].contact_email)).toBe("pedro@example.com");
    expect(dec("chat_logs", "message", (await raw("SELECT message FROM chat_logs"))[0].message)).toBe("Call me at 09991234567");
    const [log] = await raw("SELECT reason, new_value FROM admin_audit_log");
    expect(dec("admin_audit_log", "reason", log.reason)).toBe("Walk-in customer");
    expect(log.new_value).toEqual({ email: "L***@Example.com", role: "user" });

    // The app can log in and find the converted account by its email.
    expect((await request(app).post("/api/v1/auth/verify-email/send").send({ email: "legacy.user@example.com" })).status).toBe(200);
    expect(mail.verificationCode).toHaveBeenCalledWith("Legacy.User@Example.com", "legacy", expect.any(String), 15);

    const again = await run("--apply", "--database", "bongalink_test");
    expect(again.out).toMatch(/users: 0 value\(s\) in 0 of \d+ row\(s\) encrypted/);
  }, 30000);

  test("verify catches a tampered or plain value", async () => {
    const user = await createUser();
    await insertAddress(user.id);
    expect((await run("--verify")).code).toBe(0);
    const [a] = await raw("SELECT address_id, street FROM delivery_addresses");
    await pool.query("UPDATE delivery_addresses SET street = ? WHERE address_id = ?", [a.street.slice(0, -4) + "AAA=", a.address_id]);
    await pool.query("UPDATE users SET email = 'plain@example.com' WHERE user_id = ?", [user.id]);
    const v = await run("--verify");
    expect(v.code).toBe(1);
    expect(v.out).toContain(`delivery_addresses.street address_id=${a.address_id}: does not decrypt`);
    expect(v.out).toContain(`users.email user_id=${user.id}: not encrypted`);
    expect(v.out).not.toContain("plain@example.com");
  }, 30000);
});
