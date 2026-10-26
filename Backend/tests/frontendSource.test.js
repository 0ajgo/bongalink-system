// Everything under Frontend/ (except vendor/) is downloaded by every visitor: it must not describe
// the server. Developer notes live in docs/frontend-notes.md, which nginx doesn't serve.
const fs = require("fs");
const path = require("path");

const FRONTEND = path.join(__dirname, "..", "..", "Frontend");
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "vendor") walk(p); } else files.push(p);
  }
})(FRONTEND);
const rel = (f) => path.relative(FRONTEND, f).replace(/\\/g, "/");
const read = (f) => fs.readFileSync(f, "utf8");

// The tables in Backend/database (schema + migrations), by name.
const TABLES = ["users", "orders", "order_items", "products", "categories", "carts", "cart_items", "deliveries",
  "delivery_addresses", "shipment_events", "payments", "payment_events", "consent_records", "inventory_movements",
  "email_verifications", "product_changes", "product_images", "faqs", "chat_logs", "admin_audit_log",
  "password_setup_tokens", "ml_events", "ml_status", "ml_predictions", "ml_training_runs", "ml_model_versions",
  "user_sessions", "admin_notifications", "admin_notification_reads", "admin_stream_tickets", "shipping_rates"];

// Every comment: <!-- --> in HTML, /* */ in CSS, and /* */ and // in JS. The JS scan skips strings,
// template literals (with ${...} inside them) and regex literals, so "http://..." in a string is not a comment.
function comments(file) {
  const src = read(file);
  if (file.endsWith(".html")) return [...src.matchAll(/<!--[\s\S]*?-->/g)].map((m) => m[0]);
  if (file.endsWith(".css")) return [...src.matchAll(/\/\*[\s\S]*?\*\//g)].map((m) => m[0]);
  const out = [];
  let i = 0;
  const skipString = (q) => {
    for (i++; i < src.length && src[i] !== q; i++) if (src[i] === "\\") i++;
    i++;
  };
  const skipTemplate = () => {
    for (i++; i < src.length && src[i] !== "`"; i++) {
      if (src[i] === "\\") i++;
      else if (src[i] === "$" && src[i + 1] === "{") { i += 2; code(true); }   // stops on the closing }
    }
    i++;
  };
  const skipRegex = () => {
    let inClass = false;
    for (i++; i < src.length && (inClass || src[i] !== "/"); i++) {
      if (src[i] === "\\") i++;
      else if (src[i] === "[") inClass = true;
      else if (src[i] === "]") inClass = false;
    }
    i++;
  };
  // Scans code until the end, or (inTemplate) until the } that closes a ${.
  function code(inTemplate) {
    let depth = 0, prev = "";
    while (i < src.length) {
      const c = src[i], n = src[i + 1];
      if (c === "}" && inTemplate && depth === 0) return;
      if (c === "/" && n === "*") { const end = src.indexOf("*/", i + 2) + 2; out.push(src.slice(i, end)); i = end; continue; }
      if (c === "/" && n === "/") { const end = src.indexOf("\n", i); out.push(src.slice(i, end === -1 ? undefined : end)); i = end === -1 ? src.length : end; continue; }
      if (c === '"' || c === "'") { skipString(c); prev = c; continue; }
      if (c === "`") { skipTemplate(); prev = c; continue; }
      // A "/" where a value is expected starts a regex literal.
      if (c === "/" && /^$|[(,=:[!&|?{};+\-*%<>~^]/.test(prev)) { skipRegex(); prev = "/"; continue; }
      if (c === "{") depth++;
      if (c === "}") depth--;
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  code(false);
  return out;
}

const pages = files.filter((f) => /\.(html|css|js)$/.test(f));

test("the comment scan finds comments (it isn't silently empty)", () => {
  const ui = comments(path.join(FRONTEND, "JS", "ui.js"));
  expect(ui.some((c) => c.includes("Admin: notification bell"))).toBe(true);   // after regex literals in ui.js
  expect(comments(path.join(FRONTEND, "Pages", "Admin", "inventory.html")).length).toBeGreaterThan(3);
});

test("no API addresses, requirement codes, backend paths or TODOs anywhere in the served files", () => {
  const hits = [];
  for (const f of pages) {
    const src = read(f);
    for (const [label, re] of [["/api/", /\/api\//], ["REQ0", /\bREQ0\d/], ["Backend/", /Backend\//], ["TODO", /\b(TODO|FIXME)\b/]]) {
      if (re.test(src)) hits.push(`${rel(f)}: ${label}`);
    }
  }
  expect(hits).toEqual([]);
});

test("no comment names Gemini, a database table, or how the server works", () => {
  // One-word tables ("orders", "products") are ordinary words in comments; the snake_case ones never are.
  const tableRe = new RegExp(`\\b(${TABLES.filter((t) => t.includes("_")).join("|")})\\b`, "g");
  const serverRe = /gemini|requireAdmin|middleware|webhook|encrypt|nominatim|bcrypt|jwt|rate limit|\bSQL\b|ADMIN_ALERT_EMAIL|CORS_ORIGIN|nginx/gi;
  const hits = [];
  for (const f of pages) {
    for (const c of comments(f)) {
      for (const m of c.matchAll(tableRe)) hits.push(`${rel(f)}: table ${m[0]}`);
      for (const m of c.matchAll(serverRe)) hits.push(`${rel(f)}: ${m[0]}`);
    }
  }
  expect(hits).toEqual([]);
});

test("Gemini is named only where the privacy notice must name it, never in scripts or styles", () => {
  const named = pages.filter((f) => /gemini/i.test(read(f))).map(rel);
  expect(named).toEqual(["Pages/Homepage/privacy.html"]);
});

test("only page assets are served: no notes, backups, source maps, dotfiles or tests", () => {
  const odd = files.map(rel).filter((f) => !/\.(html|css|js|png|jpe?g|svg|ico|webp|gif|woff2?)$/.test(f));
  expect(odd).toEqual([]);
  // vendor/ holds Leaflet and its licence only.
  const vendor = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else vendor.push(rel(p));
    }
  })(path.join(FRONTEND, "vendor"));
  expect(vendor.filter((f) => !/\.(css|js|png)$/.test(f))).toEqual(["vendor/leaflet/LICENSE"]);
});

test("no secrets or keys in the served files", () => {
  const secretRe = /sk_(test|live)_|pk_(test|live)_|whsk_|AIza[0-9A-Za-z_-]{20}|-----BEGIN|DATA_ENCRYPTION_KEY|JWT_SECRET|SMTP_PASS/;
  expect(pages.filter((f) => secretRe.test(read(f))).map(rel)).toEqual([]);
});

test("both nginx configs refuse dotfiles and notes", () => {
  for (const conf of ["frontend.conf.template", "production.conf.example"]) {
    const text = read(path.join(__dirname, "..", "..", "deploy", "nginx", conf));
    expect(text).toContain("location ~ /\\.(?!well-known/) { return 404; }");
    expect(text).toMatch(/location ~\* \\\.\(md\|map\|[^)]*\)\$ \{ return 404; \}/);
  }
});
