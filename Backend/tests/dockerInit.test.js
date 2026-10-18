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

/* ---- every variable the code reads reaches its container, and is documented ---- */
const BACKEND = path.join(__dirname, "..");
const WORKER = path.join(ROOT, "ml", "worker");
const filesUnder = (dir, ext, skip) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  skip.includes(e.name) ? [] : e.isDirectory() ? filesUnder(path.join(dir, e.name), ext, skip)
    : e.name.endsWith(ext) ? [path.join(dir, e.name)] : []);
const namesIn = (files, re) => new Set(files.flatMap((f) => [...fs.readFileSync(f, "utf8").matchAll(re)].map((m) => m[1])));

// process.env.X, plus the names built at run time (encryption keys, tracking page templates).
const backendVars = new Set([...namesIn(filesUnder(BACKEND, ".js", ["node_modules", "tests", "scripts"]), /process\.env\.([A-Z0-9_]+)/g),
  "DATA_ENCRYPTION_KEY", "DATA_INDEX_KEY", "DATA_ENCRYPTION_KEY_VERSION", "DATA_ENCRYPTION_KEY_V1", "TRACKING_URL_JNT", "TRACKING_URL_LBC"]);
const workerVars = namesIn(filesUnder(path.join(WORKER, "bongalink_ml"), ".py", ["__pycache__"]),
  /(?:environ\.get|_int|_optional_int|_path)\(\s*"([A-Z0-9_]+)"/g);
// Set by the image layout instead: the uploads volume is mounted at the default UPLOAD_DIR,
// and the worker image keeps the repo layout its default model paths expect.
const FROM_IMAGE = ["UPLOAD_DIR", "ML_MODELS_DIR", "ML_BOOTSTRAP_DIR"];

const composeLf = compose.replace(/\r\n/g, "\n");
const service = (name) => composeLf.split(/\n  (?=[a-z]+:\n)/).find((block) => block.startsWith(`${name}:`));
const envOf = (name) => new Set([...service(name).matchAll(/^ {6}([A-Z0-9_]+):/gm)].map((m) => m[1]));
const exampleKeys = (file) => new Set([...fs.readFileSync(file, "utf8").matchAll(/^#?\s*([A-Z0-9_]+)=/gm)].map((m) => m[1]));
const missing = (needed, have) => [...needed].filter((v) => !FROM_IMAGE.includes(v) && !have.has(v)).sort();

test("sanity: the variable scan finds the code's settings", () => {
  expect(backendVars.has("JWT_SECRET") && backendVars.has("PAYMONGO_SECRET_KEY") && backendVars.has("GEMINI_MODEL")).toBe(true);
  expect(workerVars.has("DB_PASSWORD") && workerVars.has("ML_RETRAIN_HOUR")).toBe(true);
});

test("docker-compose passes every variable the backend reads to the api container", () => {
  expect(missing(backendVars, envOf("api"))).toEqual([]);
});

test("docker-compose passes every variable the ML worker reads to the worker container", () => {
  expect(missing(workerVars, envOf("worker"))).toEqual([]);
});

test("secrets come from .env (${VAR}), never written into docker-compose.yml", () => {
  const SECRET = /(PASSWORD|SECRET|_KEY|_PASS)$/;
  const literal = [...compose.matchAll(/^ {6}([A-Z0-9_]+): *(.*)$/gm)]
    .filter(([, name, value]) => SECRET.test(name) && !/^\$\{[A-Z0-9_]+(:[-?][^}]*)?\}/.test(value.trim()))
    .map(([, name]) => name);
  expect(literal).toEqual([]);
});

test("each .env.example lists the variables of its side; the root one every ${VAR} compose reads", () => {
  expect(missing(backendVars, exampleKeys(path.join(BACKEND, ".env.example")))).toEqual([]);
  expect(missing(workerVars, exampleKeys(path.join(WORKER, ".env.example")))).toEqual([]);
  const settings = composeLf.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");   // not the comments
  const composeVars = new Set([...settings.matchAll(/\$\{([A-Z0-9_]+)/g)].map((m) => m[1]));
  expect(missing(composeVars, exampleKeys(path.join(ROOT, ".env.example")))).toEqual([]);
});

test("the .env.example files hold no real secrets", () => {
  for (const file of [path.join(ROOT, ".env.example"), path.join(BACKEND, ".env.example"), path.join(WORKER, ".env.example")]) {
    const filled = [...fs.readFileSync(file, "utf8").matchAll(/^([A-Z0-9_]*(?:PASSWORD|SECRET|_KEY|_PASS))=(.+)$/gm)].map((m) => m[1]);
    expect({ file: path.basename(path.dirname(file)), filled }).toEqual({ file: path.basename(path.dirname(file)), filled: [] });
  }
});

test("Docker builds never receive database dumps, the inventory workbook or the sales sheet", () => {
  const ignored = fs.readFileSync(path.join(ROOT, ".dockerignore"), "utf8").split(/\r?\n/).map((l) => l.trim());
  expect(ignored).toEqual(expect.arrayContaining(["backups", "imports", "ml/worker/data", "**/.env"]));
});
