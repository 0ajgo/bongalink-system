// DEPLOYMENT.md stays in step with the code: every setting documented, the migrations in the
// order the tests and Docker apply them, every file it names present, the UAT table's defaults right.
const fs = require("fs");
const path = require("path");
const { RATE_LIMIT_DEFAULTS } = require("../lib/rateLimit");

const ROOT = path.join(__dirname, "..", "..");
const doc = fs.readFileSync(path.join(ROOT, "DEPLOYMENT.md"), "utf8").replace(/\r\n/g, "\n");
const keys = (file) => [...fs.readFileSync(path.join(ROOT, file), "utf8").matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]);

test("every variable of the three .env.example files is in DEPLOYMENT.md", () => {
  const all = new Set([...keys("Backend/.env.example"), ...keys("ml/worker/.env.example"), ...keys(".env.example")]);
  expect([...all].filter((k) => !doc.includes(`\`${k}\``) && !doc.includes(`${k},`) && !doc.includes(`${k}\``)).sort()).toEqual([]);
});

test("the migration table is the order globalSetup.js (and Docker) applies them", () => {
  const setup = fs.readFileSync(path.join(__dirname, "globalSetup.js"), "utf8");
  const applied = [...setup.matchAll(/"(\d{3}_[a-z_]+\.sql)"/g)].map((m) => m[1]);
  const table = [...doc.matchAll(/^\| \d+ \| `migrations\/(\d{3}_[a-z_]+\.sql)` \|/gm)].map((m) => m[1]);
  expect(table).toEqual(applied);
});

test("every repository file it names exists (except the removed demo seed it warns about)", () => {
  const REMOVED = ["ml/worker/seed_demo.py"];
  const named = new Set([...doc.matchAll(/`((?:Backend|Frontend|ml|deploy)\/[A-Za-z0-9_./-]+\.[a-z]+)`/g)].map((m) => m[1]));
  expect(named.size).toBeGreaterThan(10);
  expect([...named].filter((f) => !REMOVED.includes(f) && !fs.existsSync(path.join(ROOT, f)))).toEqual([]);
  for (const f of REMOVED) expect(fs.existsSync(path.join(ROOT, f))).toBe(false);
});

test("the UAT table lists every rate limit with its real default", () => {
  const uat = doc.slice(doc.indexOf("## 11. UAT"), doc.indexOf("## 12."));
  for (const [name, value] of Object.entries(RATE_LIMIT_DEFAULTS)) {
    expect(uat).toMatch(new RegExp(`\\| \`${name}\` \\| ${value} /`));
  }
  expect(uat).toMatch(/### Before the session/);
  expect(uat).toMatch(/### After the session/);
});

test("the backup command uses the flags the shop's backups use", () => {
  expect(doc).toContain("--single-transaction --routines --triggers --default-character-set=utf8mb4");
});
