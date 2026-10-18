// Errors in async routes reach Express's error handler: a database failure is a 500 with a
// generic message (no SQL, no stack), and the server keeps answering. Express 4 doesn't catch
// errors thrown by async handlers by itself, so every one is wrapped in ah() (lib/asyncHandler).
const fs = require("fs");
const path = require("path");
const request = require("supertest");
const app = require("../server");
const { pool, resetDb, createUser } = require("./helpers");

const unhandled = [];
const onUnhandled = (reason) => unhandled.push(reason);
beforeAll(() => process.on("unhandledRejection", onUnhandled));
afterAll(() => { process.off("unhandledRejection", onUnhandled); return pool.end(); });
beforeEach(async () => {
  await resetDb();
  jest.restoreAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  unhandled.length = 0;
});

// What mysql2 throws: the message and .sql carry the query, with its values.
const dbDown = () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3306"), {
  code: "ECONNREFUSED", sql: "SELECT secret FROM users WHERE email = 'customer@example.com'" });

const expectGeneric500 = (res) => {
  expect(res.status).toBe(500);
  expect(res.body).toEqual({ error: "Something went wrong." });
  expect(JSON.stringify(res.body)).not.toMatch(/SELECT|ECONNREFUSED|customer@example\.com|at .*\.js/);
};

describe("a database error is a 500, and the server keeps working", () => {
  test.each([
    ["GET /api/products (the shop catalog)", () => request(app).get("/api/products")],
    ["GET /api/categories", () => request(app).get("/api/categories")],
  ])("%s", async (_, send) => {
    jest.spyOn(pool, "query").mockRejectedValueOnce(dbDown());
    expectGeneric500(await send());
    // The same route works again once the database is back: the process didn't crash.
    expect((await send()).status).toBe(200);
    expect((await request(app).get("/api/health")).status).toBe(200);
    expect(unhandled).toEqual([]);
  });

  test("POST /api/admin/ml/training: no database connection at all", async () => {
    const admin = await createUser({ role: "admin" });
    jest.spyOn(pool, "getConnection").mockRejectedValueOnce(dbDown());
    expectGeneric500(await request(app).post("/api/admin/ml/training").set("Authorization", admin.auth));
    expect((await request(app).get("/api/health")).status).toBe(200);
    expect(unhandled).toEqual([]);
  });
});

describe("every async route handler is wrapped in ah()", () => {
  test("Backend/routes/*.js", () => {
    const dir = path.join(__dirname, "..", "routes");
    const handlers = [], unwrapped = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
      fs.readFileSync(path.join(dir, f), "utf8").split(/\r?\n/).forEach((line, i) => {
        if (!/\brouter\.(get|post|put|patch|delete)\(/.test(line) || !/\basync\s*\(/.test(line)) return;
        handlers.push(`${f}:${i + 1}`);
        if (!/\bah\(\s*async\s*\(/.test(line)) unwrapped.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(handlers.length).toBeGreaterThan(80);   // the check really sees the routes
    expect(unwrapped).toEqual([]);
  });
});
