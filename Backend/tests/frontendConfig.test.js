// Where the pages find the API (Frontend/JS/config.js + api.js): the development API from a
// port-5500 dev server, /api on the same site in production, or the address set in config.js.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const FRONTEND = path.join(__dirname, "..", "..", "Frontend");
const read = (f) => fs.readFileSync(path.join(FRONTEND, f), "utf8");

// API_BASE_URL and the photo origin (ui.js) for a page opened at `url`, with config.js set to `configured`.
function resolved(url, configured = "") {
  const config = read("JS/config.js").replace('window.BONGALINK_API_BASE_URL = "";', `window.BONGALINK_API_BASE_URL = ${JSON.stringify(configured)};`);
  const dom = new JSDOM(`<script>${config}\n${read("JS/api.js")}\nwindow.__base = API_BASE_URL;</script>`, { url, runScripts: "dangerously" });
  const base = dom.window.__base;
  dom.window.close();
  return base;
}

test("a dev server on port 5500 (Live Server, Docker) uses the API on localhost:4000", () => {
  expect(resolved("http://127.0.0.1:5500/Frontend/Pages/Homepage/homepage.html")).toBe("http://localhost:4000/api");
  expect(resolved("http://localhost:5500/Pages/Homepage/homepage.html")).toBe("http://localhost:4000/api");
});

test("anywhere else, /api on the same site (production behind nginx)", () => {
  expect(resolved("https://shop.example.com/Pages/Homepage/homepage.html")).toBe("https://shop.example.com/api");
  expect(resolved("https://staging.example.com:8443/Pages/COpage/checkout.html")).toBe("https://staging.example.com:8443/api");
});

test("an address set in config.js wins (trailing slashes dropped)", () => {
  expect(resolved("https://shop.example.com/x.html", "https://api.example.com/api/")).toBe("https://api.example.com/api");
  expect(resolved("http://127.0.0.1:5500/x.html", "  http://localhost:4001/api ")).toBe("http://localhost:4001/api");
});

test("config.js ships blank, and every page loads it right before api.js", () => {
  expect(read("JS/config.js")).toMatch(/^window\.BONGALINK_API_BASE_URL = "";$/m);
  const pages = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".html") && pages.push(path.join(d, e.name)));
  walk(path.join(FRONTEND, "Pages"));
  expect(pages.length).toBeGreaterThan(10);
  for (const page of pages) {
    const scripts = [...fs.readFileSync(page, "utf8").matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => path.basename(m[1]));
    expect({ page: path.basename(page), first: scripts.slice(0, 2) }).toEqual({ page: path.basename(page), first: ["config.js", "api.js"] });
  }
});
