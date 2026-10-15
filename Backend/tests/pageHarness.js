// Loads a real Frontend page in jsdom with its local <script src> files inlined
// and fetch() answered by a stub, so page behaviour can be tested without a browser.
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const FRONTEND = path.join(__dirname, "..", "..", "Frontend");

// page: path under Frontend/, e.g. "Pages/Admin/deliveries.html".
// api(url, options) returns { status = 200, body }.
// role: "user" | "admin" | null (logged out). fastTimers: run setTimeout callbacks immediately.
// storage: extra sessionStorage entries, e.g. a chat carried over from another page.
async function openPage(page, { api, role = "user", query = "", hash = "", fastTimers = false, username = "juan", storage = {} }) {
  const dir = path.dirname(path.join(FRONTEND, page));
  const html = fs.readFileSync(path.join(FRONTEND, page), "utf8")
    .replace(/<script src="([^"]+)"><\/script>/g, (_, src) =>
      `<script>${fs.readFileSync(path.join(dir, src), "utf8")}</script>`);

  const calls = [];
  const timers = new Set();
  let closed = false;   // after close(), page timers and fetches stop for good
  const dom = new JSDOM(html, {
    url: `http://localhost:5500/Frontend/${page}${query ? `?${query}` : ""}${hash ? `#${hash}` : ""}`,
    runScripts: "dangerously",
    // Quiet: jsdom can't follow window.location changes (e.g. the PayMongo redirect).
    virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      if (role) {
        window.sessionStorage.setItem("bongalink_logged_in", "true");
        window.sessionStorage.setItem("bongalink_token", "test-token");
        window.sessionStorage.setItem("bongalink_role", role);
        window.sessionStorage.setItem("bongalink_username", username);
      }
      Object.entries(storage).forEach(([k, v]) => window.sessionStorage.setItem(k, v));
      window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
      window.HTMLDialogElement.prototype.close = function () { this.open = false; };
      window.scrollTo = () => {};
      window.confirm = () => true;
      window.console.error = () => {};
      // Polling timers are tracked so close() can stop them.
      window.setInterval = (fn, ms) => { if (closed) return 0; const t = setInterval(fn, ms); timers.add(t); return t; };
      if (fastTimers) {
        window.setTimeout = (fn) => { if (closed) return 0; const t = setTimeout(() => { timers.delete(t); if (!closed) fn(); }, 0); timers.add(t); return t; };
        window.clearTimeout = (t) => { clearTimeout(t); timers.delete(t); };
      }
      window.fetch = async (url, options = {}) => {
        if (closed) return new Promise(() => {});   // never settles: the closed page does nothing more
        const call = { url: url.replace("http://localhost:4000/api", ""), method: options.method || "GET",
                       body: typeof options.body === "string" ? JSON.parse(options.body) : options.body };
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
    // Waits until fn() is truthy (or fails after ~1 s).
    async until(fn) {
      for (let i = 0; i < 200 && !fn(); i++) await new Promise(r => setTimeout(r, 5));
      return fn();
    },
    close() {
      closed = true;
      timers.forEach(t => { clearInterval(t); clearTimeout(t); });
      dom.window.close();
    }
  };
}

module.exports = { openPage };
