// deploy/mysql/check_migrations.sql: on a database built like globalSetup.js (schema + every
// migration) it reports every migration applied and the triggers' definer account present.
const fs = require("fs");
const path = require("path");
const pool = require("../db");

afterAll(() => pool.end());

const sql = fs.readFileSync(path.join(__dirname, "..", "..", "deploy", "mysql", "check_migrations.sql"), "utf8").replace(/\r\n/g, "\n");
const statements = sql.split(/;\n/).map((s) => s.replace(/^--.*$/gm, "").trim()).filter(Boolean);

test("every migration file after 002 (except data-only 007) has a check", () => {
  const files = fs.readdirSync(path.join(__dirname, "..", "database", "migrations")).filter((f) => f.endsWith(".sql"))
    .map((f) => f.replace(/\.sql$/, "")).filter((f) => !/^00[27]_/.test(f));
  expect([...sql.matchAll(/'(\d{3}_[a-z_]+)'/g)].map((m) => m[1])).toEqual(files);
});

test("a fully migrated database: all applied, and the triggers' definer exists", async () => {
  const [migrations] = await pool.query(statements[0]);
  expect(migrations.length).toBe(10);
  expect(migrations.filter((m) => m.state !== "applied")).toEqual([]);
  const [definers] = await pool.query(statements[1]);
  expect(definers.length).toBeGreaterThan(0);
  for (const d of definers) expect({ definer: d.DEFINER, exists: Number(d.account_exists) }).toEqual({ definer: d.DEFINER, exists: 1 });
});
