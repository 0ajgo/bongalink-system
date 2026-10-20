// Security headers: the API's own (helmet), product photos still usable by the shop's pages on
// another origin, and the pages' Content-Security-Policy (deploy/nginx) matching the frontend code.
process.env.CORS_ORIGIN = "http://127.0.0.1:5500, https://shop.test";
const fs = require("fs");
const path = require("path");
const express = require("express");
const request = require("supertest");
const app = require("../server");
const pool = require("../db");
const { securityHeaders } = require("../lib/securityHeaders");

afterAll(() => pool.end());

const ROOT = path.join(__dirname, "..", "..");
const FRONTEND = path.join(ROOT, "Frontend");
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
  "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");

describe("API headers", () => {
  test("every answer: no X-Powered-By, nosniff, a CSP that loads nothing and can't be framed", async () => {
    const res = await request(app).get("/api/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toMatch(/default-src 'none'/);
    expect(res.headers["content-security-policy"]).toMatch(/frame-ancestors 'none'/);
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
  });

  test("errors carry the headers too", async () => {
    const res = await request(app).get("/api/products/abc/nothing-here");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  test("HSTS only in production", async () => {
    expect((await request(app).get("/api/health")).headers["strict-transport-security"]).toBeUndefined();
    const prod = express().use(securityHeaders({ production: true })).get("/", (req, res) => res.end());
    expect((await request(prod).get("/")).headers["strict-transport-security"]).toBe("max-age=15552000");
  });

  test("the shop's pages on CORS_ORIGIN can still call the API (CORS answers, helmet doesn't get in the way)", async () => {
    const res = await request(app).get("/api/health").set("Origin", "http://127.0.0.1:5500");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5500");
    const pre = await request(app).options("/api/cart").set("Origin", "https://shop.test")
      .set("Access-Control-Request-Method", "PUT").set("Access-Control-Request-Headers", "authorization,content-type");
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe("https://shop.test");
  });
});

describe("product photos (/uploads)", () => {
  const name = `headers-test-${process.pid}.png`;
  beforeAll(() => fs.writeFileSync(path.join(process.env.UPLOAD_DIR, name), PNG));
  afterAll(() => fs.rmSync(path.join(process.env.UPLOAD_DIR, name), { force: true }));

  test("load on a page from another origin (Cross-Origin-Resource-Policy: cross-origin), still with nosniff", async () => {
    const res = await request(app).get(`/uploads/${name}`)
      .set("Origin", "http://127.0.0.1:5500").set("Sec-Fetch-Mode", "no-cors").set("Sec-Fetch-Dest", "image");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5500");
    expect(Buffer.compare(res.body, PNG)).toBe(0);
  });

  test("only /uploads is cross-origin; the API's JSON stays same-origin", async () => {
    expect((await request(app).get("/api/categories")).headers["cross-origin-resource-policy"]).toBe("same-origin");
  });
});

describe("the pages' Content-Security-Policy (deploy/nginx/frontend.conf.template)", () => {
  const conf = fs.readFileSync(path.join(ROOT, "deploy", "nginx", "frontend.conf.template"), "utf8");
  const csp = conf.match(/add_header Content-Security-Policy "([^"]+)"/)[1];
  const directive = (name) => (csp.split(";").map((d) => d.trim().split(/\s+/)).find(([n]) => n === name) || []).slice(1);
  const filesUnder = (dir, exts) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.name === "vendor" ? [] : e.isDirectory() ? filesUnder(path.join(dir, e.name), exts)
      : exts.some((x) => e.name.endsWith(x)) ? [path.join(dir, e.name)] : []);
  const html = filesUnder(FRONTEND, [".html"]);

  test("scripts and styles only from the site's own files", () => {
    expect(directive("script-src")).toEqual(["'self'"]);
    expect(directive("style-src")).toEqual(["'self'", "https://fonts.googleapis.com"]);
    expect(directive("frame-ancestors")).toEqual(["'none'"]);
    expect(directive("object-src")).toEqual(["'none'"]);
  });

  test("no page has an inline script, <style> block, style= attribute or on...= handler (the CSP would block them)", () => {
    const found = html.flatMap((file) => {
      const text = fs.readFileSync(file, "utf8");
      return [/<script(?![^>]*\ssrc=)[^>]*>/gi, /<style[\s>]/gi, /\sstyle\s*=/gi, /\son[a-z]+\s*=/gi]
        .flatMap((re) => (text.match(re) || []).map((m) => `${path.relative(FRONTEND, file)}: ${m}`));
    });
    expect(found).toEqual([]);
  });

  test("every outside address the frontend loads from is allowed", () => {
    // Map tiles (img), Google Fonts (style + font files); links in text (<a href>) are not loads.
    const tiles = fs.readFileSync(path.join(FRONTEND, "JS", "map-picker.js"), "utf8").match(/tileLayer\("(https:\/\/[^/]+)/)[1];
    expect(directive("img-src")).toContain(tiles);
    const fontsCss = fs.readFileSync(path.join(FRONTEND, "CSS", "design-system.css"), "utf8").match(/@import url\("(https:\/\/[^/]+)/)[1];
    expect(directive("style-src")).toContain(fontsCss);
    expect(directive("font-src")).toContain("https://fonts.gstatic.com");
    // No other http(s) script/stylesheet/image tags in the pages.
    const outside = html.flatMap((file) => [...fs.readFileSync(file, "utf8").matchAll(/<(?:script|link|img)[^>]+(?:src|href)="(https?:[^"]+)"/gi)].map((m) => m[1]));
    expect(outside).toEqual([]);
  });

  test("the API (fetch, live updates, product photos) comes from API_ORIGIN, filled in by docker-compose", () => {
    expect(directive("connect-src")).toEqual(["'self'", "${API_ORIGIN}"]);
    expect(directive("img-src")).toContain("${API_ORIGIN}");
    const compose = fs.readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
    expect(compose).toMatch(/API_ORIGIN: \$\{API_ORIGIN:-http:\/\/localhost:4000\}/);
    expect(compose).toContain("./deploy/nginx/frontend.conf.template:/etc/nginx/templates/default.conf.template:ro");
    // The default matches the frontend's own development API address (DEV_API_BASE_URL in JS/api.js).
    const apiBase = fs.readFileSync(path.join(FRONTEND, "JS", "api.js"), "utf8").match(/DEV_API_BASE_URL = "(https?:\/\/[^/]+)/)[1];
    expect(apiBase).toBe("http://localhost:4000");
  });
});

describe("production nginx (deploy/nginx/production.conf.example)", () => {
  const conf = fs.readFileSync(path.join(ROOT, "deploy", "nginx", "production.conf.example"), "utf8").replace(/\r\n/g, "\n");
  const cspOf = (text) => Object.fromEntries(text.match(/add_header Content-Security-Policy "([^"]+)"/)[1]
    .split(";").map((d) => d.trim().split(/\s+/)).map(([n, ...v]) => [n, v]));
  const docker = cspOf(fs.readFileSync(path.join(ROOT, "deploy", "nginx", "frontend.conf.template"), "utf8"));
  const prod = cspOf(conf);
  const block = (start) => conf.slice(conf.indexOf(start), conf.indexOf("\n    }", conf.indexOf(start)));

  test("the same page policy as Docker's, with the API on the same address", () => {
    const withoutApi = Object.fromEntries(Object.entries(docker).map(([n, v]) => [n, v.filter((s) => s !== "${API_ORIGIN}")]));
    expect(prod).toEqual(withoutApi);
  });

  test("HTTPS only: http redirects, the pages send HSTS", () => {
    expect(conf).toMatch(/listen 80;[\s\S]*return 301 https:\/\/\$host\$request_uri;/);
    expect(block("    location / {")).toContain('add_header Strict-Transport-Security "max-age=15552000" always;');
  });

  test("the page headers are only on the pages, not added again to the API's answers", () => {
    const serverLevel = conf.split("\n").filter((l) => /^ {4}add_header/.test(l));
    expect(serverLevel).toEqual([]);
    for (const loc of ["    location /api/ {", "    location /api/v1/admin/notifications/stream {", "    location /uploads/ {"]) {
      expect(block(loc)).not.toContain("add_header");
      expect(block(loc)).toContain("proxy_pass http://127.0.0.1:4000;");
    }
  });

  test("the API sees each visitor's address (TRUST_PROXY=1), and the live stream isn't buffered", () => {
    expect(block("    location /api/ {")).toContain("proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;");
    const sse = block("    location /api/v1/admin/notifications/stream {");
    expect(sse).toContain("proxy_buffering off;");
    expect(sse).toContain("proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;");
    expect(conf).toContain("TRUST_PROXY=1");
  });

  test("photo uploads (5 MB) fit through", () => {
    expect(conf).toMatch(/client_max_body_size 6m;/);
    expect(fs.readFileSync(path.join(__dirname, "..", "routes", "products.js"), "utf8")).toMatch(/MAX_IMAGE_BYTES = 5 \* 1024 \* 1024/);
  });
});
