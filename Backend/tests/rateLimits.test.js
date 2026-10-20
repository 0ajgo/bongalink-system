// Rate limits on login (and register, account changes): failed logins per username from one
// IP (fixed), per IP (RATE_LIMIT_LOGIN_PER_IP), and how a shared-IP test session raises them.
jest.mock("../services/mailer", () => require("./mailerMock")());

const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const authRoutes = require("../routes/auth");
const { pool, resetDb, createUser } = require("./helpers");

const PASSWORD = "right-password-1";
const login = (server, username, password, ip) => {
  const req = request(server).post("/api/auth/login");
  if (ip) req.set("X-Forwarded-For", ip);
  return req.send({ username, password });
};
async function userWithPassword() {
  const u = await createUser();
  await pool.query("UPDATE users SET password_hash = ? WHERE user_id = ?", [await bcrypt.hash(PASSWORD, 4), u.id]);
  return u;
}
// A fresh copy of the API with these .env values (limits are read when the routes load).
function appWith(env) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  let fresh;
  try {
    jest.isolateModules(() => { fresh = { app: require("../server"), pool: require("../db") }; });
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  return fresh;
}

beforeEach(async () => {
  await resetDb();
  await authRoutes.resetRateLimits();
});
afterAll(() => pool.end());

describe("login", () => {
  test("after 10 failed logins for one username from one IP, even the right password waits 15 minutes", async () => {
    const juan = await userWithPassword();
    for (let i = 0; i < 10; i++) expect((await login(app, juan.username, "wrong")).status).toBe(401);
    const blocked = await login(app, juan.username, PASSWORD);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: expect.stringMatching(/Too many failed logins.*15 minutes/), code: "RATE_LIMITED" });
    expect(blocked.headers["retry-after"]).toBeDefined();
    // The username is matched the way MySQL matches it, ignoring case and spaces.
    expect((await login(app, ` ${juan.username.toUpperCase()} `, PASSWORD)).status).toBe(429);
  });

  test("another account on the same IP can still log in", async () => {
    const juan = await userWithPassword();
    const ana = await userWithPassword();
    for (let i = 0; i < 10; i++) await login(app, juan.username, "wrong");
    expect((await login(app, ana.username, PASSWORD)).status).toBe(200);
  });

  test("successful logins are not counted", async () => {
    const juan = await userWithPassword();
    for (let i = 0; i < 12; i++) expect((await login(app, juan.username, PASSWORD)).status).toBe(200);
  });

  test("RATE_LIMIT_LOGIN_PER_IP caps failed logins from one IP across usernames; other IPs are counted apart", async () => {
    const api = appWith({ RATE_LIMIT_LOGIN_PER_IP: "3", TRUST_PROXY: "1" });
    try {
      for (const name of ["a1", "a2", "a3"]) expect((await login(api.app, name, "x", "203.0.113.5")).status).toBe(401);
      expect((await login(api.app, "a4", "x", "203.0.113.5")).status).toBe(429);
      expect((await login(api.app, "a4", "x", "203.0.113.6")).status).toBe(401);
    } finally { await api.pool.end(); }
  });

  test("raising the per-IP limit (a shared-IP test session) doesn't raise the per-username limit", async () => {
    const juan = await userWithPassword();
    const api = appWith({ RATE_LIMIT_LOGIN_PER_IP: "1000" });
    try {
      for (let i = 0; i < 10; i++) await login(api.app, juan.username, "wrong");
      expect((await login(api.app, juan.username, PASSWORD)).status).toBe(429);
    } finally { await api.pool.end(); }
  });

  test("a blank or invalid value keeps the default of 50", () => {
    const { envLimit } = require("../lib/rateLimit");
    expect(envLimit("", 50)).toBe(50);
    expect(envLimit(undefined, 50)).toBe(50);
    expect(envLimit("abc", 50)).toBe(50);
    expect(envLimit("0", 50)).toBe(50);
    expect(envLimit("-5", 50)).toBe(50);
    expect(envLimit(" 400 ", 50)).toBe(400);
  });
});

describe("register", () => {
  const register = (server, n, overrides = {}) => request(server).post("/api/auth/register")
    .send({ username: `new${n}`, email: `new${n}@example.com`, password: "a-long-password-1", privacy_consent: true, ...overrides });

  test("5 new accounts per IP per hour, then 429 (each one sends an email)", async () => {
    for (let i = 1; i <= 5; i++) expect((await register(app, i)).status).toBe(201);
    const blocked = await register(app, 6);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: "Too many new accounts from this network. Please try again later.", code: "RATE_LIMITED" });
    const [rows] = await pool.query("SELECT COUNT(*) AS n FROM users WHERE username LIKE 'new%'");
    expect(rows[0].n).toBe(5);
  });

  test("a form sent back as incomplete doesn't count; a taken username does", async () => {
    for (let i = 0; i < 6; i++) expect((await register(app, 1, { privacy_consent: false })).status).toBe(400);
    expect((await register(app, 1)).status).toBe(201);
    for (let i = 0; i < 4; i++) expect((await register(app, 1)).status).toBe(409);
    expect((await register(app, 2)).status).toBe(429);
  });

  test("a shared-IP test session raises it with RATE_LIMIT_REGISTER_PER_IP_HOUR / _DAY", async () => {
    const api = appWith({ RATE_LIMIT_REGISTER_PER_IP_HOUR: "40", RATE_LIMIT_REGISTER_PER_IP_DAY: "40" });
    try {
      for (let i = 1; i <= 8; i++) expect((await register(api.app, i)).status).toBe(201);
    } finally { await api.pool.end(); }
  });

  test("the day limit applies even when the hour limit is raised", async () => {
    const api = appWith({ RATE_LIMIT_REGISTER_PER_IP_HOUR: "40", RATE_LIMIT_REGISTER_PER_IP_DAY: "3" });
    try {
      for (let i = 1; i <= 3; i++) expect((await register(api.app, i)).status).toBe(201);
      expect((await register(api.app, 4)).status).toBe(429);
    } finally { await api.pool.end(); }
  });
});

describe("the other per-IP limits a shared-IP session would hit are raisable too", () => {
  test.each([
    ["RATE_LIMIT_VERIFY_EMAIL_PER_IP", (s) => request(s).post("/api/v1/auth/verify-email/send").send({})],
    ["RATE_LIMIT_FORGOT_PASSWORD_PER_IP", (s) => request(s).post("/api/auth/forgot-password").send({ email: "not-an-email" })],
    ["RATE_LIMIT_CHAT_PER_IP_MINUTE", (s) => request(s).post("/api/v1/chat/messages").send({ session_id: "bad", message: "hi" })],
    ["RATE_LIMIT_CHAT_PER_IP_DAY", (s) => request(s).post("/api/v1/chat/messages").send({ session_id: "bad", message: "hi" })],
  ])("%s", async (name, call) => {
    const api = appWith({ [name]: "2" });
    try {
      expect((await call(api.app)).status).not.toBe(429);
      expect((await call(api.app)).status).not.toBe(429);
      expect((await call(api.app)).status).toBe(429);
    } finally { await api.pool.end(); }
  });
});

describe("changes that check the current password (per account)", () => {
  const change = (server, u, current) => request(server).post("/api/v1/account/password").set("Authorization", u.auth)
    .send({ current_password: current, new_password: "another-pass-77" });
  const emailChange = (u, current) => request(app).patch("/api/v1/account/me").set("Authorization", u.auth)
    .send({ email: "other.address@example.com", current_password: current });

  test("10 failed tries in 15 minutes, then 429 even with the right password; other accounts unaffected", async () => {
    const juan = await userWithPassword();
    const ana = await userWithPassword();
    for (let i = 0; i < 6; i++) expect((await change(app, juan, "wrong")).status).toBe(400);
    for (let i = 0; i < 4; i++) expect((await emailChange(juan, "wrong")).status).toBe(400);   // counted together
    const blocked = await change(app, juan, PASSWORD);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: "Too many failed tries. Please wait 15 minutes and try again.", code: "RATE_LIMITED" });
    expect((await change(app, ana, PASSWORD)).status).toBe(200);
  });

  test("RATE_LIMIT_ACCOUNT_PER_USER sets it", async () => {
    const juan = await userWithPassword();
    const api = appWith({ RATE_LIMIT_ACCOUNT_PER_USER: "2" });
    try {
      for (let i = 0; i < 2; i++) expect((await change(api.app, juan, "wrong")).status).toBe(400);
      expect((await change(api.app, juan, "wrong")).status).toBe(429);
    } finally { await api.pool.end(); }
  });
});
