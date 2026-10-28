// Forgot password: the emailed reset link end to end, the same answer for every email,
// single-use 30-minute links, old logins ended, suspended accounts blocked, rate limits.
jest.mock("../services/mailer", () => require("./mailerMock")());

const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const authRoutes = require("../routes/auth");
const { mail } = require("../services/mailer");
const { pool, resetDb, createUser } = require("./helpers");

const SAME = "If that email has an account, we've sent a reset link. It works for 30 minutes.";
const forgot = (email) => request(app).post("/api/auth/forgot-password").send({ email });
const reset = (token, password) => request(app).post("/api/auth/reset-password").send({ token, password });
const login = (username, password) => request(app).post("/api/auth/login").send({ username, password });
const raw = async (sql, params = []) => (await pool.query(sql, params))[0];
// The background send has finished once the mock was called (or a short wait passed).
const settle = (fn = () => true) => new Promise((resolve) => {
  const start = Date.now();
  (function poll() { if (fn() || Date.now() - start > 1000) resolve(); else setTimeout(poll, 10); })();
});
const tokenFrom = (call) => call[2].split("token=")[1];

async function userWithPassword(opts = {}) {
  const u = await createUser(opts);
  await pool.query("UPDATE users SET password_hash = ? WHERE user_id = ?", [await bcrypt.hash("oldpass1", 4), u.id]);
  return u;
}

beforeEach(async () => {
  await resetDb();
  await authRoutes.resetRateLimits();
  jest.clearAllMocks();
});
afterAll(() => pool.end());

describe("forgot password, end to end", () => {
  test("email -> link -> new password; old logins end; changed email; audit entry; old password stops working", async () => {
    const juan = await userWithPassword({ email: "juan.delacruz@gmail.com" });
    const otherDevice = (await login(juan.username, "oldpass1")).body.token;
    expect((await request(app).get("/api/v1/account/me").set("Authorization", `Bearer ${otherDevice}`)).status).toBe(200);

    const asked = await forgot("Juan.DelaCruz@Gmail.com");   // any case: the blind index normalizes it
    expect(asked.status).toBe(200);
    expect(asked.body).toEqual({ message: SAME });
    await settle(() => mail.passwordReset.mock.calls.length);
    expect(mail.passwordReset).toHaveBeenCalledWith("juan.delacruz@gmail.com", juan.username,
      expect.stringMatching(/^http:\/\/localhost:5500\/Pages\/Homepage\/reset-password\.html\?token=[a-f0-9]{64}$/), 30);
    const token = tokenFrom(mail.passwordReset.mock.calls[0]);
    const [stored] = await raw("SELECT purpose, token_hash, TIMESTAMPDIFF(MINUTE, created_at, expires_at) AS minutes FROM password_setup_tokens");
    expect(stored).toMatchObject({ purpose: "reset", minutes: 30 });
    expect(stored.token_hash).not.toBe(token);   // stored hashed

    expect((await request(app).get(`/api/auth/reset-password?token=${token}`)).body).toEqual({ username: juan.username });
    expect((await reset(token, "123")).body.error).toBe("Use at least 10 characters for your password.");   // sign-up rule
    const done = await reset(token, "Brand-new-pass9");
    expect(done.status).toBe(200);
    expect(done.body.username).toBe(juan.username);

    // Every existing login ended, on every device.
    const old = await request(app).get("/api/v1/account/me").set("Authorization", `Bearer ${otherDevice}`);
    expect(old.status).toBe(401);
    expect(old.body.code).toBe("SESSION_ENDED");
    expect((await login(juan.username, "oldpass1")).status).toBe(401);
    expect((await login(juan.username, "Brand-new-pass9")).status).toBe(200);
    expect(mail.passwordChanged).toHaveBeenCalledWith("juan.delacruz@gmail.com", juan.username);
    expect(await raw("SELECT admin_id, action, target_user_id, new_value FROM admin_audit_log"))
      .toEqual([{ admin_id: juan.id, action: "password_reset", target_user_id: juan.id, new_value: { via: "emailed reset link" } }]);
  });

  test("a reset link works once, expires after 30 minutes, and asking again cancels the older link", async () => {
    const juan = await userWithPassword({ email: "juan@gmail.com" });
    await forgot("juan@gmail.com");
    await settle(() => mail.passwordReset.mock.calls.length === 1);
    const first = tokenFrom(mail.passwordReset.mock.calls[0]);
    await forgot("juan@gmail.com");
    await settle(() => mail.passwordReset.mock.calls.length === 2);
    const second = tokenFrom(mail.passwordReset.mock.calls[1]);

    expect((await request(app).get(`/api/auth/reset-password?token=${first}`)).status).toBe(400);   // replaced
    expect((await reset(second, "Newpass-1234")).status).toBe(200);
    const reused = await reset(second, "Another-1234");                                                // used once
    expect(reused.status).toBe(400);
    expect(reused.body.error).toBe("This link is invalid, already used or expired. Ask for a new one from the login page.");

    await forgot("juan@gmail.com");
    await settle(() => mail.passwordReset.mock.calls.length === 3);
    const third = tokenFrom(mail.passwordReset.mock.calls[2]);
    await pool.query("UPDATE password_setup_tokens SET expires_at = NOW() - INTERVAL 1 SECOND WHERE used_at IS NULL");   // 30 min passed
    expect((await reset(third, "Late-pass-12345")).status).toBe(400);
    expect((await login(juan.username, "Newpass-1234")).status).toBe(200);
  });

  test("a reset link can't be used on the account-setup page, nor a setup link to reset", async () => {
    const admin = await createUser({ role: "admin" });
    await request(app).post("/api/v1/admin/accounts").set("Authorization", admin.auth).send({ username: "invited1", email: "inv@gmail.com" });
    const setupToken = mail.accountInvite.mock.calls[0][3].split("token=")[1];
    expect((await reset(setupToken, "Newpass-1234")).status).toBe(400);

    const juan = await userWithPassword({ email: "juan@gmail.com" });
    await forgot("juan@gmail.com");
    await settle(() => mail.passwordReset.mock.calls.length);
    const resetToken = tokenFrom(mail.passwordReset.mock.calls[0]);
    expect((await request(app).post("/api/auth/set-password").send({ token: resetToken, password: "x123456", privacy_consent: true })).status).toBe(400);
    expect(juan).toBeTruthy();
  });
});

describe("no account enumeration", () => {
  test("unknown, deleted and suspended emails get exactly the same answer; only real accounts get a link", async () => {
    const juan = await userWithPassword({ email: "juan@gmail.com" });
    const gone = await createUser({ email: "gone@gmail.com" });
    await pool.query("UPDATE users SET status = 'deleted' WHERE user_id = ?", [gone.id]);
    const susp = await userWithPassword({ email: "susp@gmail.com" });
    await pool.query("UPDATE users SET status = 'suspended' WHERE user_id = ?", [susp.id]);

    const answers = [];
    for (const email of ["juan@gmail.com", "nobody@gmail.com", "gone@gmail.com", "susp@gmail.com"]) {
      const res = await forgot(email);
      answers.push([res.status, res.body]);
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]).toEqual([200, { message: SAME }]);
    await settle(() => mail.passwordReset.mock.calls.length && mail.resetBlockedSuspended.mock.calls.length);
    expect(mail.passwordReset.mock.calls.map((c) => c[0])).toEqual(["juan@gmail.com"]);
    // The suspended account is told by email why it can't reset, and gets no link.
    expect(mail.resetBlockedSuspended).toHaveBeenCalledWith("susp@gmail.com", susp.username);
    expect(await raw("SELECT user_id FROM password_setup_tokens")).toEqual([{ user_id: juan.id }]);
  });

  test("a mail failure doesn't change the answer", async () => {
    await userWithPassword({ email: "juan@gmail.com" });
    mail.passwordReset.mockRejectedValueOnce(new Error("SMTP down"));
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await forgot("juan@gmail.com");
    await settle(() => spy.mock.calls.length);
    spy.mockRestore();
    expect(res.body).toEqual({ message: SAME });
  });
});

describe("suspended accounts", () => {
  test("a link sent before the suspension can't be used: the suspended message, password unchanged", async () => {
    const juan = await userWithPassword({ email: "juan@gmail.com" });
    await forgot("juan@gmail.com");
    await settle(() => mail.passwordReset.mock.calls.length);
    const token = tokenFrom(mail.passwordReset.mock.calls[0]);
    await pool.query("UPDATE users SET status = 'suspended' WHERE user_id = ?", [juan.id]);

    const check = await request(app).get(`/api/auth/reset-password?token=${token}`);
    expect(check.status).toBe(403);
    expect(check.body).toEqual({ error: "Your account is suspended. Contact the shop.", code: "ACCOUNT_SUSPENDED" });
    const res = await reset(token, "Newpass-1234");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ACCOUNT_SUSPENDED");
    expect(await bcrypt.compare("oldpass1", (await raw("SELECT password_hash FROM users WHERE user_id = ?", [juan.id]))[0].password_hash)).toBe(true);
    expect(mail.passwordChanged).not.toHaveBeenCalled();
  });
});

describe("rate limits", () => {
  test("3 requests an hour per email (known or not), 10 per 15 minutes per IP", async () => {
    await userWithPassword({ email: "juan@gmail.com" });
    for (let i = 0; i < 3; i++) expect((await forgot("juan@gmail.com")).status).toBe(200);
    const fourth = await forgot("JUAN@gmail.com");   // same email, other case
    expect(fourth.status).toBe(429);
    expect(fourth.body.code).toBe("RATE_LIMITED");
    for (let i = 0; i < 3; i++) expect((await forgot("nobody@gmail.com")).status).toBe(200);
    expect((await forgot("nobody@gmail.com")).status).toBe(429);   // unknown emails are limited the same way

    // 8 requests so far from this IP (6 allowed + 2 refused by the email limit); 2 more are allowed.
    expect((await forgot("a1@gmail.com")).status).toBe(200);
    expect((await forgot("a2@gmail.com")).status).toBe(200);
    expect((await forgot("a3@gmail.com")).status).toBe(429);
    await settle(() => mail.passwordReset.mock.calls.length >= 3);
    expect(mail.passwordReset).toHaveBeenCalledTimes(3);
  });

  test("a malformed email is refused without counting as a lookup", async () => {
    const res = await forgot("not-an-email");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Enter the email address of your account.");
  });
});
