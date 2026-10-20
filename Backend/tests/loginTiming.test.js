// Login doesn't tell which usernames exist by how fast it answers: unknown, deleted and
// not-yet-set-up accounts run the same bcrypt check (cost 10) as a real wrong password.
const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const authRoutes = require("../routes/auth");
const { pool, resetDb, createUser } = require("./helpers");

let compare;
beforeEach(async () => {
  await resetDb();
  await authRoutes.resetRateLimits();
  compare = jest.spyOn(bcrypt, "compare");
});
afterEach(() => compare.mockRestore());
afterAll(() => pool.end());

const login = (username, password = "some-guess-1") => request(app).post("/api/auth/login").send({ username, password });
const costOf = (hash) => Number(hash.split("$")[2]);

test("a wrong password for a real account: one bcrypt check against its hash", async () => {
  const u = await createUser();
  await pool.query("UPDATE users SET password_hash = ? WHERE user_id = ?", [await bcrypt.hash("the-real-one", 10), u.id]);
  compare.mockClear();
  expect((await login(u.username)).status).toBe(401);
  expect(compare).toHaveBeenCalledTimes(1);
  expect(costOf(compare.mock.calls[0][1])).toBe(10);
});

test("an unknown username: the same check, the same answer", async () => {
  const res = await login("nobody-here");
  expect(res.status).toBe(401);
  expect(res.body).toEqual({ error: "Invalid username or password." });
  expect(compare).toHaveBeenCalledTimes(1);
  expect(costOf(compare.mock.calls[0][1])).toBe(10);
});

test("a deleted account looks like an unknown one, after the same check", async () => {
  const u = await createUser();
  await pool.query("UPDATE users SET status = 'deleted' WHERE user_id = ?", [u.id]);
  const res = await login(u.username);
  expect(res.status).toBe(401);
  expect(res.body).toEqual({ error: "Invalid username or password." });
  expect(compare).toHaveBeenCalledTimes(1);
});

test("an account waiting for setup gets its hint only after the same check", async () => {
  const u = await createUser();
  await pool.query("UPDATE users SET must_set_password = 1 WHERE user_id = ?", [u.id]);
  const res = await login(u.username);
  expect(res.status).toBe(403);
  expect(res.body.code).toBe("PASSWORD_NOT_SET");
  expect(compare).toHaveBeenCalledTimes(1);
  expect(costOf(compare.mock.calls[0][1])).toBe(10);
});
