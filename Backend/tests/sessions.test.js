// "Remember me" and logging out: login lifetimes, logging out one device, and the events
// that end every login whatever was chosen (suspension, role change, password change).
jest.mock("../services/mailer", () => require("./mailerMock")());

const request = require("supertest");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const app = require("../server");
const { mail } = require("../services/mailer");
const { pool, resetDb, createUser } = require("./helpers");

const raw = async (sql, params = []) => (await pool.query(sql, params))[0];
const login = (username, remember) => request(app).post("/api/auth/login").send({ username, password: "secret123", ...(remember === undefined ? {} : { remember }) });
const me = (token) => request(app).get("/api/v1/account/me").set("Authorization", `Bearer ${token}`);
const lifetimeDays = (token) => { const { iat, exp } = jwt.decode(token); return (exp - iat) / 86400; };

async function userWithPassword(opts = {}) {
  const u = await createUser(opts);
  await pool.query("UPDATE users SET password_hash = ? WHERE user_id = ?", [await bcrypt.hash("secret123", 4), u.id]);
  return u;
}

beforeEach(async () => {
  await resetDb();
  jest.clearAllMocks();
});
afterAll(() => pool.end());

describe("login lifetime", () => {
  test("Remember me: a 30-day login, recorded as its own session", async () => {
    const juan = await userWithPassword();
    const res = await login(juan.username, true);
    expect(res.body).toMatchObject({ remember: true, user: { username: juan.username, role: "user" } });
    expect(lifetimeDays(res.body.token)).toBe(30);
    expect(new Date(res.body.expires_at).getTime()).toBe(jwt.decode(res.body.token).exp * 1000);
    const [session] = await raw("SELECT session_id, user_id, remember, UNIX_TIMESTAMP(expires_at) AS exp, revoked_at FROM user_sessions");
    expect(session).toMatchObject({ session_id: jwt.decode(res.body.token).sid, user_id: juan.id, remember: 1, revoked_at: null });
    expect(Number(session.exp)).toBe(jwt.decode(res.body.token).exp);
    expect((await me(res.body.token)).status).toBe(200);
  });

  test("without Remember me: the usual lifetime (JWT_EXPIRES_IN); only remember: true counts", async () => {
    const juan = await userWithPassword();
    const res = await login(juan.username);
    expect(res.body.remember).toBe(false);
    const expected = (s) => { const n = parseInt(s, 10); return /d$/.test(s) ? n : /h$/.test(s) ? n / 24 : n / 86400; };
    expect(lifetimeDays(res.body.token)).toBe(expected(process.env.JWT_EXPIRES_IN || "7d"));
    expect((await login(juan.username, "yes")).body.remember).toBe(false);
    expect((await raw("SELECT remember FROM user_sessions")).map((s) => s.remember)).toEqual([0, 0]);
  });

  test("a session past its lifetime stops working even if the token were still valid", async () => {
    const juan = await userWithPassword();
    const { token } = (await login(juan.username, true)).body;
    await pool.query("UPDATE user_sessions SET expires_at = NOW() - INTERVAL 1 SECOND");
    const res = await me(token);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SESSION_ENDED");
  });

  test("logins from before sessions existed (no session id) keep working until they expire", async () => {
    const juan = await createUser();
    expect((await me(juan.token)).status).toBe(200);
  });
});

describe("log out", () => {
  test("ends that device's session at once, even a 30-day one; the other device stays logged in", async () => {
    const juan = await userWithPassword();
    const phone = (await login(juan.username, true)).body.token;
    const laptop = (await login(juan.username, false)).body.token;
    const out = await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${phone}`);
    expect(out.body).toEqual({ ok: true });
    const after = await me(phone);
    expect(after.status).toBe(401);
    expect(after.body.code).toBe("SESSION_ENDED");
    expect((await me(laptop)).status).toBe(200);
    expect((await raw("SELECT remember, revoked_at IS NOT NULL AS revoked FROM user_sessions ORDER BY created_at, remember DESC")).map((s) => s.revoked).sort())
      .toEqual([0, 1]);
  });

  test("always answers OK (no token, a bad token, already logged out), so the browser can finish", async () => {
    const juan = await userWithPassword();
    const { token } = (await login(juan.username)).body;
    expect((await request(app).post("/api/auth/logout")).status).toBe(200);
    expect((await request(app).post("/api/auth/logout").set("Authorization", "Bearer nonsense")).status).toBe(200);
    await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${token}`);
    expect((await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${token}`)).status).toBe(200);
  });
});

describe("events that end every login, Remember me or not", () => {
  test("suspension and role changes end 30-day logins at once", async () => {
    const admin = await createUser({ role: "admin" });
    const juan = await userWithPassword();
    const maria = await userWithPassword();
    const juanToken = (await login(juan.username, true)).body.token;
    const mariaToken = (await login(maria.username, true)).body.token;

    await request(app).post(`/api/v1/admin/accounts/${juan.id}/suspend`).set("Authorization", admin.auth).send({ reason: "Testing" });
    expect((await me(juanToken)).body.code).toBe("ACCOUNT_SUSPENDED");
    await request(app).post(`/api/v1/admin/accounts/${maria.id}/role`).set("Authorization", admin.auth).send({ role: "admin" });
    expect((await me(mariaToken)).body.code).toBe("SESSION_ENDED");
  });

  test("a password change ends every other login; this device gets a new one kept the same way", async () => {
    const juan = await userWithPassword({ email: "juan@example.com" });
    const here = (await login(juan.username, true)).body.token;
    const elsewhere = (await login(juan.username, false)).body.token;
    const res = await request(app).post("/api/v1/account/password").set("Authorization", `Bearer ${here}`)
      .send({ current_password: "secret123", new_password: "brandnew9" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ message: "Password changed. Every other device was logged out.", remember: true });
    expect(lifetimeDays(res.body.token)).toBe(30);
    expect((await me(res.body.token)).status).toBe(200);
    expect((await me(here)).body.code).toBe("SESSION_ENDED");
    expect((await me(elsewhere)).body.code).toBe("SESSION_ENDED");
    expect(mail.passwordChanged).toHaveBeenCalledWith("juan@example.com", juan.username);
  });

  test("a password reset ends Remember-me logins too", async () => {
    const juan = await userWithPassword({ email: "juan@example.com" });
    const remembered = (await login(juan.username, true)).body.token;
    await request(app).post("/api/auth/forgot-password").send({ email: "juan@example.com" });
    for (let i = 0; i < 100 && !mail.passwordReset.mock.calls.length; i++) await new Promise((r) => setTimeout(r, 10));
    const token = mail.passwordReset.mock.calls[0][2].split("token=")[1];
    await request(app).post("/api/auth/reset-password").send({ token, password: "brandnew9" });
    expect((await me(remembered)).body.code).toBe("SESSION_ENDED");
    expect(await raw("SELECT COUNT(*) AS n FROM user_sessions WHERE revoked_at IS NULL")).toEqual([{ n: 0 }]);
  });
});

describe("housekeeping", () => {
  test("old ended sessions are removed when the account logs in again", async () => {
    const juan = await userWithPassword();
    await login(juan.username);
    await pool.query("UPDATE user_sessions SET expires_at = NOW() - INTERVAL 2 DAY");
    await login(juan.username);
    expect((await raw("SELECT COUNT(*) AS n FROM user_sessions"))[0].n).toBe(1);
  });
});
