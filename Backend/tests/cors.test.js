// CORS: only CORS_ORIGIN may call the API, and browsers may cache the preflight answer.
process.env.CORS_ORIGIN = "http://shop.test, http://127.0.0.1:5500";
const request = require("supertest");
const app = require("../server");
const pool = require("../db");

afterAll(() => pool.end());

const preflight = (origin) => request(app).options("/api/admin/ml/predictions")
  .set("Origin", origin).set("Access-Control-Request-Method", "GET").set("Access-Control-Request-Headers", "authorization");

describe("CORS preflight", () => {
  test("an allowed origin gets a cacheable answer (Access-Control-Max-Age), so pages don't send one before every call", async () => {
    const res = await preflight("http://127.0.0.1:5500");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5500");
    expect(res.headers["access-control-allow-headers"]).toMatch(/authorization/i);
    expect(res.headers["access-control-max-age"]).toBe("600");
  });

  test("another origin is not allowed", async () => {
    const res = await preflight("http://evil.test");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
