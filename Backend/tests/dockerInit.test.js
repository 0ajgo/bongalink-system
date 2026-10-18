// A fresh `docker compose up` must build the same database as the tests: docker-compose.yml
// mounts the schema dump + every migration into /docker-entrypoint-initdb.d/, in the same
// order as globalSetup.js (002 is already folded into the dump).
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const compose = fs.readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
const setup = fs.readFileSync(path.join(__dirname, "globalSetup.js"), "utf8");
const migrationFiles = fs.readdirSync(path.join(__dirname, "..", "database", "migrations")).filter((f) => f.endsWith(".sql")).sort();

// [source file, mounted name] in mount order.
const mounts = [...compose.matchAll(/\.\/Backend\/database\/(\S+\.sql):\/docker-entrypoint-initdb\.d\/(\S+\.sql):ro/g)]
  .map((m) => [path.basename(m[1]), m[2]]);
const setupFiles = [...setup.matchAll(/"([^"]+\.sql)"/g)].map((m) => m[1]);

test("docker-compose mounts the schema and the same migrations, in the same order, as globalSetup", () => {
  expect(mounts.map(([file]) => file)).toEqual(setupFiles);
});

test("every migration after 002 is applied on a fresh volume", () => {
  const applied = new Set(mounts.map(([file]) => file));
  expect(migrationFiles.filter((f) => f !== "002_add_checkout_fields.sql" && !applied.has(f))).toEqual([]);
});

test("init scripts run in migration order (MySQL sorts them by name)", () => {
  const names = mounts.map(([, mounted]) => mounted);
  expect([...names].sort()).toEqual(names);
  for (const [file, mounted] of mounts.slice(1)) expect(mounted).toBe(`${file.slice(1, 3)}_${file.slice(4)}`);
});

test("the API gets the encryption keys it needs to start", () => {
  expect(compose).toMatch(/DATA_ENCRYPTION_KEY: \$\{DATA_ENCRYPTION_KEY:\?/);
  expect(compose).toMatch(/DATA_INDEX_KEY: \$\{DATA_INDEX_KEY:\?/);
});
