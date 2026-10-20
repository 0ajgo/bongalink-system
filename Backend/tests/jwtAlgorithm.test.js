// Login tokens are HS256 only: a token signed another way, even with the right secret, is refused.
const request = require("supertest");
const jwt = require("jsonwebtoken");
const app = require("../server");
const { pool, resetDb, createUser } = require("./helpers");

beforeEach(resetDb);
afterAll(() => pool.end());

const me = (token) => request(app).get("/api/v1/account/me").set("Authorization", `Bearer ${token}`);
const claims = (u) => ({ userId: u.id, username: u.username, role: "user" });

test("an HS256 token works", async () => {
  const u = await createUser();
  expect((await me(jwt.sign(claims(u), process.env.JWT_SECRET, { algorithm: "HS256" }))).status).toBe(200);
});

test("the same claims and secret with another algorithm are refused", async () => {
  const u = await createUser();
  for (const algorithm of ["HS384", "HS512"]) {
    expect((await me(jwt.sign(claims(u), process.env.JWT_SECRET, { algorithm }))).status).toBe(401);
  }
});

test("an unsigned token (alg none) is refused", async () => {
  const u = await createUser();
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  expect((await me(`${b64({ alg: "none", typ: "JWT" })}.${b64(claims(u))}.`)).status).toBe(401);
});

test("tokens the app issues are HS256", async () => {
  const { signToken } = require("../middleware/auth");
  const token = signToken({ user_id: 1, username: "x", role: "user" });
  expect(jwt.decode(token, { complete: true }).header.alg).toBe("HS256");
});
