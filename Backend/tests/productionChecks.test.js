// Startup checks (lib/productionChecks.js): production refuses to start without its essentials,
// warns about test-mode and non-HTTPS settings, and every environment warns about raised limits.
const path = require("path");
const { spawnSync } = require("child_process");
const { startupChecks } = require("../lib/productionChecks");
const { RATE_LIMIT_DEFAULTS, raisedLimits } = require("../lib/rateLimit");

const GOOD = {
  NODE_ENV: "production", JWT_SECRET: "x".repeat(48), CORS_ORIGIN: "https://shop.example.com",
  APP_URL: "https://shop.example.com", PAYMONGO_SECRET_KEY: "sk_live_abc", DB_USER: "bongalink_app", TRUST_PROXY: "1",
};

test("a complete production setup: no errors, no warnings", () => {
  expect(startupChecks(GOOD)).toEqual({ errors: [], warnings: [] });
});

test("production won't start without a strong JWT_SECRET, CORS_ORIGIN and APP_URL", () => {
  const { errors } = startupChecks({ ...GOOD, JWT_SECRET: "short", CORS_ORIGIN: " ", APP_URL: "" });
  expect(errors).toEqual([
    "JWT_SECRET must be a random string of at least 32 characters.",
    "CORS_ORIGIN is empty: the shop's pages couldn't call the API.",
    "APP_URL is empty: PayMongo couldn't send customers back to the shop.",
  ]);
});

test("production warns about http://, test keys, sandbox, root and a blank TRUST_PROXY", () => {
  const { errors, warnings } = startupChecks({ ...GOOD, APP_URL: "http://shop.example.com", CORS_ORIGIN: "https://a.example.com, http://b.example.com",
    PAYMONGO_SECRET_KEY: "sk_test_abc", LALAMOVE_API_KEY: "pk", LALAMOVE_ENV: "sandbox", DB_USER: "root", TRUST_PROXY: "" });
  expect(errors).toEqual([]);
  expect(warnings).toEqual([
    "APP_URL has an address that isn't https://. Logins and payments must use HTTPS.",
    "CORS_ORIGIN has an address that isn't https://. Logins and payments must use HTTPS.",
    "PayMongo is in TEST mode (sk_test_ key): customers can't really pay.",
    "Lalamove is in sandbox mode (LALAMOVE_ENV): no real rider will come.",
    "DB_USER is root. Use the bongalink_app account (DEPLOYMENT.md, least-privilege users).",
    "TRUST_PROXY is blank: right only if browsers reach Node directly. Behind nginx or a load balancer, set it (usually 1).",
  ]);
});

test("development: none of the production checks", () => {
  expect(startupChecks({ NODE_ENV: "development" })).toEqual({ errors: [], warnings: [] });
});

test("a raised rate limit is reported in every environment, until it's set back", () => {
  const env = { NODE_ENV: "development", RATE_LIMIT_LOGIN_PER_IP: "500", RATE_LIMIT_CHAT_PER_IP_DAY: "300", RATE_LIMIT_REGISTER_PER_IP_HOUR: "2" };
  expect(raisedLimits(env)).toEqual([{ name: "RATE_LIMIT_LOGIN_PER_IP", value: 500, default: 50 }]);   // equal or lower isn't "raised"
  expect(startupChecks(env).warnings).toEqual([
    'RATE_LIMIT_LOGIN_PER_IP is raised to 500 (default 50). Set it back to blank after the test session (DEPLOYMENT.md, "UAT").']);
  expect(startupChecks({ ...GOOD, RATE_LIMIT_LOGIN_PER_IP: "" }).warnings).toEqual([]);
});

test("every limit read from .env has its default in RATE_LIMIT_DEFAULTS, and .env.example lists it", () => {
  const fs = require("fs");
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const used = new Set(["server.js", "routes/auth.js", "routes/chat.js", "routes/account.js"]
    .flatMap((f) => [...read(f).matchAll(/process\.env\.(RATE_LIMIT_[A-Z_]+)/g)].map((m) => m[1])));
  expect([...used].sort()).toEqual(Object.keys(RATE_LIMIT_DEFAULTS).sort());
  for (const f of ["server.js", "routes/auth.js", "routes/chat.js", "routes/account.js"]) {
    expect(read(f)).not.toMatch(/envLimit\(process\.env\.RATE_LIMIT_[A-Z_]+, \d/);   // no second copy of a default
  }
  for (const name of used) expect(read(".env.example")).toMatch(new RegExp(`^${name}=$`, "m"));
});

describe("starting the real server (it stops before touching any database)", () => {
  const start = (env) => spawnSync(process.execPath, ["server.js"], { cwd: path.join(__dirname, ".."), encoding: "utf8", timeout: 15000,
    env: { ...process.env, PORT: "0", ...env } });

  test("production with a missing setting: the errors, then exit 1", () => {
    const run = start({ NODE_ENV: "production", JWT_SECRET: "short", CORS_ORIGIN: "", APP_URL: "", DB_PORT: "1" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("ERROR: JWT_SECRET must be a random string of at least 32 characters.");
    expect(run.stderr).toContain("The server will not start in production until these are fixed");
    expect(run.stdout).not.toContain("Bongalink API running");
  });

  test("MySQL unreachable: a clear message, then exit 1 (Docker / systemd start it again)", () => {
    const run = start({ NODE_ENV: "development", DB_HOST: "127.0.0.1", DB_PORT: "1" });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/Database: can't connect \(ECONNREFUSED\)/);
    expect(run.stdout).not.toContain("Bongalink API running");
  });
});
