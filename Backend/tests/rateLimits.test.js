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
