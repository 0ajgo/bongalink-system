// The admin notification bell in the shared header (ui.js), run in jsdom against a stubbed API.
const { openPage } = require("./pageHarness");

const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
const item = (id, overrides = {}) => ({
  id, type: "sale", title: `New sale: order #${id}`, body: "₱650.00 · 3 items", link: "Admin/deliveries.html",
  created_at: minutesAgo(2), read: false, ...overrides
});

// A stand-in for the browser's EventSource: tests push events into it.
function fakeEventSource(window) {
  const sources = [];
  window.EventSource = class {
    constructor(url) { this.url = url; this.listeners = {}; this.closed = false; sources.push(this); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    emit(type, data) { (this.listeners[type] || []).forEach((fn) => fn({ data: JSON.stringify(data) })); }
    fail() { this.onerror?.({}); }
    close() { this.closed = true; }
  };
  return sources;
}

// Stubbed notification API with server-side state, so read / mark-all change what comes back.
function bellApi({ items = [], unread = items.filter((n) => !n.read).length, extra = {} } = {}) {
  const state = { items: items.map((n) => ({ ...n })), unread, tickets: 0 };
  const handler = async ({ url, method }) => {
    if (url in extra) return extra[url];
    if (url === "/v1/admin/notifications/unread-count") return { body: { unread: state.unread } };
    if (url.startsWith("/v1/admin/notifications?")) return { body: { items: state.items.map((n) => ({ ...n })), unread: state.unread, page: 1, per_page: 15, has_more: false } };
    if (url === "/v1/admin/notifications/stream-ticket" && method === "POST") return { body: { ticket: `ticket-${++state.tickets}`, expires_in: 60 } };
    if (url === "/v1/admin/notifications/read-all" && method === "POST") {
      state.items.forEach((n) => { n.read = true; });
      state.unread = 0;
      return { body: { unread: 0 } };
    }
    const one = url.match(/^\/v1\/admin\/notifications\/(\d+)\/read$/);
    if (one && method === "POST") {
      const n = state.items.find((x) => x.id === Number(one[1]));
      if (n && !n.read) { n.read = true; state.unread--; }
      return { body: { unread: state.unread } };
    }
    if (url === "/v1/admin/orders/to-ship") return { body: { count: 0 } };
    return { body: [] };
  };
  return { handler, state };
}

const open = (opts) => openPage("Pages/Admin/rates.html", { role: "admin", ...opts });
const bellButton = (page) => page.$(".notif__button");
const badge = (page) => page.$("[data-notif-count]");

describe("notification bell", () => {
  test("admins get the bell with an unread badge capped at 9+; customers and visitors don't", async () => {
    const { handler } = bellApi({ unread: 12 });
    const page = await open({ api: handler });
    await page.until(() => !badge(page).hidden);
    expect(badge(page).textContent).toBe("9+");
    expect(bellButton(page).getAttribute("aria-label")).toBe("Notifications, 12 unread");
    expect(bellButton(page).getAttribute("aria-expanded")).toBe("false");
    expect(page.$("#notif-panel").hidden).toBe(true);
    page.close();

    for (const role of ["user", null]) {
      const customer = await openPage("Pages/Homepage/homepage.html", { role, api: handler });
      expect(customer.$(".notif")).toBeNull();
      expect(customer.calls.some((c) => c.url.includes("notifications"))).toBe(false);
      customer.close();
    }
  });

  test("the dropdown lists the newest items with an icon per type, relative time and unread highlighted", async () => {
    const { handler } = bellApi({ items: [
      item(3, { type: "low_stock", title: "Low stock: Epson L3210 printhead", body: "3 available to sell.", link: "Admin/inventory.html?edit=9", created_at: minutesAgo(0.2) }),
      item(2, { created_at: minutesAgo(2) }),
      item(1, { type: "shipment_delivered", title: "Delivered: order #1", body: "J&T Express", read: true, created_at: minutesAgo(180) })
    ] });
    const page = await open({ api: handler });
    await page.until(() => badge(page).textContent === "2");

    bellButton(page).click();
    expect(bellButton(page).getAttribute("aria-expanded")).toBe("true");
    expect(page.$("#notif-panel").hidden).toBe(false);
    await page.until(() => page.$$(".notif-item").length === 3);
    const rows = page.$$(".notif-item").map((el) => [
      el.querySelector(".notif-item__title").textContent, el.querySelector(".notif-item__time").textContent,
      el.classList.contains("is-unread"), el.getAttribute("href"), el.querySelector(".notif-item__icon svg") !== null]);
    expect(rows).toEqual([
      ["Unread: Low stock: Epson L3210 printhead", "just now", true, "../Admin/inventory.html?edit=9", true],
      ["Unread: New sale: order #2", "2 min ago", true, "../Admin/deliveries.html", true],
      ["Delivered: order #1", "3 h ago", false, "../Admin/deliveries.html", true]
    ]);
    expect(page.$(".notif-item .notif-item__body").textContent).toBe("3 available to sell.");
    expect(page.calls.some((c) => c.url === "/v1/admin/notifications?per_page=15")).toBe(true);
    page.close();
  });

  test("clicking an item marks it read and opens its page; Mark all as read clears the badge", async () => {
    const { handler, state } = bellApi({ items: [item(5), item(4), item(3, { read: true })] });
    const page = await open({ api: handler });
    await page.until(() => badge(page).textContent === "2");
    bellButton(page).click();
    await page.until(() => page.$$(".notif-item").length === 3);

    page.$('[data-notif-id="5"]').click();
    await page.until(() => badge(page).textContent === "1");
    expect(page.calls).toContainEqual({ url: "/v1/admin/notifications/5/read", method: "POST", body: undefined });
    expect(page.$('[data-notif-id="5"]').classList.contains("is-unread")).toBe(false);
    expect(state.unread).toBe(1);

    page.$("[data-notif-read-all]").click();
    await page.until(() => badge(page).hidden);
    expect(page.calls).toContainEqual({ url: "/v1/admin/notifications/read-all", method: "POST", body: undefined });
    expect(page.$$(".notif-item.is-unread")).toHaveLength(0);
    expect(page.$("[data-notif-read-all]").disabled).toBe(true);
    expect(bellButton(page).getAttribute("aria-label")).toBe("Notifications");
    page.close();
  });

  test("empty state; Esc and a click outside close it, Esc returns focus to the bell; arrows move between items", async () => {
    const empty = await open({ api: bellApi().handler });
    bellButton(empty).click();
    await empty.until(() => empty.$("#notif-panel .state"));
    expect(empty.$("#notif-panel").textContent).toContain("No notifications yet");
    empty.doc.body.click();
    expect(empty.$("#notif-panel").hidden).toBe(true);
    expect(bellButton(empty).getAttribute("aria-expanded")).toBe("false");
    empty.close();

    const page = await open({ api: bellApi({ items: [item(2), item(1)] }).handler });
    bellButton(page).focus();
    bellButton(page).click();
    await page.until(() => page.doc.activeElement?.dataset?.notifId === "2");   // focus moves to the first item
    page.doc.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(page.doc.activeElement.dataset.notifId).toBe("1");
    page.doc.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape" }));
    expect(page.$("#notif-panel").hidden).toBe(true);
    expect(page.doc.activeElement).toBe(bellButton(page));
    page.close();
  });

  test("live: opens the stream with a ticket (never the login token), new notifications raise the badge, a sale shows a toast", async () => {
    let sources;
    const { handler } = bellApi({ items: [item(1)] });
    const page = await open({ api: handler, setup: (w) => { sources = fakeEventSource(w); } });
    await page.until(() => sources.length === 1);
    expect(page.calls.filter((c) => c.url === "/v1/admin/notifications/stream-ticket")).toEqual(
      [{ url: "/v1/admin/notifications/stream-ticket", method: "POST", body: undefined }]);
    expect(sources[0].url).toBe("http://localhost:4000/api/v1/admin/notifications/stream?ticket=ticket-1");
    expect(sources[0].url).not.toContain("test-token");

    sources[0].emit("ready", { unread: 4 });
    expect(badge(page).textContent).toBe("4");
    sources[0].emit("notification", item(7, { title: "New sale: order #7", body: "₱1,200.00 · 2 items" }));
    expect(badge(page).textContent).toBe("5");
    expect(page.$(".toast").textContent).toBe("New sale: order #7 · ₱1,200.00 · 2 items");
    sources[0].emit("notification", item(8, { type: "new_customer", title: "New customer: maria", body: "Signed up for an account." }));
    expect(badge(page).textContent).toBe("6");
    expect(page.$$(".toast")).toHaveLength(1);   // toasts only for sales

    // Open panel: a live notification appears at the top.
    bellButton(page).click();
    await page.until(() => page.$$(".notif-item").length >= 1);
    sources[0].emit("notification", item(9, { title: "New sale: order #9" }));
    expect(page.$(".notif-item__title").textContent).toBe("Unread: New sale: order #9");
    page.close();
  });

  test("if the stream drops: polls the unread count every 30 s and reconnects with a new ticket; after 'end' it stops", async () => {
    let sources;
    const intervals = [];
    const { handler, state } = bellApi({ unread: 1 });
    const page = await open({ api: handler, fastTimers: true, setup: (w) => {
      sources = fakeEventSource(w);
      const real = w.setInterval;
      w.setInterval = (fn, ms) => { intervals.push(ms); return real(fn, ms); };
    } });
    await page.until(() => sources.length === 1);
    sources[0].emit("ready", { unread: 1 });

    state.unread = 3;
    sources[0].fail();
    expect(sources[0].closed).toBe(true);
    expect(intervals).toContain(30000);
    await page.until(() => sources.length === 2);
    expect(sources[1].url).toMatch(/ticket=ticket-2$/);
    await page.until(() => badge(page).textContent === "3");

    const before = page.calls.length;
    sources[1].emit("end", { code: "SESSION_ENDED" });
    expect(sources[1].closed).toBe(true);
    await page.settle();
    expect(page.calls.slice(before).map((c) => c.url)).toEqual(["/v1/admin/notifications/unread-count"]);
    expect(sources).toHaveLength(2);
    page.close();
  });
});
