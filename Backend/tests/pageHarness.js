// Loads a real Frontend page in jsdom with its local <script src> files inlined
// and fetch() answered by a stub, so page behaviour can be tested without a browser.
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const FRONTEND = path.join(__dirname, "..", "..", "Frontend");

// page: path under Frontend/, e.g. "Pages/Admin/deliveries.html".
// api(url, options) returns { status = 200, body }.
async function openPage(page, { api, role = "user", query = "" }) {
  const dir = path.dirname(path.join(FRONTEND, page));
  const html = fs.readFileSync(path.join(FRONTEND, page), "utf8")
    .replace(/<script src="([^"]+)"><\/script>/g, (_, src) =>
      `<script>${fs.readFileSync(path.join(dir, src), "utf8")}</script>`);

  const calls = [];
  const timers = new Set();
  const dom = new JSDOM(html, {
    url: `http://localhost:5500/Frontend/${page}${query ? `?${query}` : ""}`,
    runScripts: "dangerously",
    // Quiet: jsdom can't follow window.location changes (e.g. the PayMongo redirect).
    virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      window.sessionStorage.setItem("bongalink_logged_in", "true");
      window.sessionStorage.setItem("bongalink_token", "test-token");
      window.sessionStorage.setItem("bongalink_role", role);
      window.scrollTo = () => {};
      window.confirm = () => true;
      window.console.error = () => {};
      // Polling timers are tracked so close() can stop them.
      window.setInterval = (fn, ms) => { const t = setInterval(fn, ms); timers.add(t); return t; };
      window.fetch = async (url, options = {}) => {
        const call = { url: url.replace("http://localhost:4000/api", ""), method: options.method || "GET",
                       body: options.body ? JSON.parse(options.body) : undefined };
        calls.push(call);
        const { status = 200, body = {} } = (await api(call)) || {};
        return { ok: status < 400, status, json: async () => body };
      };
    }
  });

  const doc = dom.window.document;
  const settle = () => new Promise(r => setTimeout(r, 20));
  await settle();
  return {
    window: dom.window,
    doc,
    calls,
    settle,
    $: (sel) => doc.querySelector(sel),
    $$: (sel) => [...doc.querySelectorAll(sel)],
    close() {
      timers.forEach(clearInterval);
      dom.window.close();
    }
  };
}

module.exports = { openPage };
