// Runs the real Frontend/Pages/COpage/checkout.html in jsdom as if PayMongo
// had just redirected back to it, with GET /api/v1/payments/orders/:id stubbed.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const FRONTEND = path.join(__dirname, "..", "..", "Frontend");
const read = (p) => fs.readFileSync(path.join(FRONTEND, p), "utf8");

// statuses: the successive bodies GET /v1/payments/orders/:id returns.
async function openReturnPage(query, statuses) {
  const html = read("Pages/COpage/checkout.html")
    .replace('<script src="../../JS/api.js"></script>', `<script>${read("JS/api.js")}</script>`)
    .replace('<script src="../../JS/cart.js"></script>', `<script>${read("JS/cart.js")}</script>`);

  const calls = [];
  const timers = new Set();
  const dom = new JSDOM(html, {
    url: `http://localhost:5500/Frontend/Pages/COpage/checkout.html?${query}`,
    runScripts: "dangerously",
    beforeParse(window) {
      window.sessionStorage.setItem("bongalink_logged_in", "true");
      window.sessionStorage.setItem("bongalink_token", "test-token");
      window.scrollTo = () => {};
      window.console.error = () => {};
      // Skip the 3 s / 15 s waits; tracked so close() stops the background poller.
      window.setTimeout = (fn) => {
        const t = setTimeout(() => { timers.delete(t); fn(); }, 0);
        timers.add(t);
        return t;
      };
      window.clearTimeout = (t) => { clearTimeout(t); timers.delete(t); };
      window.fetch = async (url, options = {}) => {
        calls.push({ url, method: options.method || "GET" });
        const body = statuses[Math.min(calls.filter(c => c.url.includes("/payments/orders/")).length - 1, statuses.length - 1)];
        return { ok: true, status: 200, json: async () => body };
      };
    }
  });

  const page = {
    calls,
    heading: () => dom.window.document.querySelector(".confirm h1")?.textContent,
    text: () => dom.window.document.querySelector(".confirm")?.textContent || "",
    button: () => dom.window.document.getElementById("status-action")?.textContent || null,
    close: () => {
      timers.forEach(clearTimeout);
      timers.clear();
      dom.window.close();
    }
  };
  page.waitFor = async (heading) => {
    for (let i = 0; i < 200 && page.heading() !== heading; i++) await new Promise(r => setTimeout(r, 5));
    expect(page.heading()).toBe(heading);
  };
  return page;
}

const pending = { order_status: "pending_payment", payment: { status: "pending" } };
const paid = { order_status: "paid", payment: { status: "paid", method_used: "gcash" } };

describe("checkout.html after returning from PayMongo", () => {
  test("paid: polls the status endpoint until the webhook marks the order paid", async () => {
    const page = await openReturnPage("order=172&payment=success", [pending, pending, paid]);
    await page.waitFor("Payment received");
    expect(page.calls.every(c => c.url.endsWith("/api/v1/payments/orders/172") && c.method === "GET")).toBe(true);
    expect(page.calls.length).toBe(3);
    expect(page.button()).toBeNull();
    page.close();
  });

  test("still pending after success: clear message, keeps checking, never offers to pay again", async () => {
    const page = await openReturnPage("order=172&payment=success", [pending]);
    await page.waitFor("Waiting for payment confirmation");
    expect(page.text()).toMatch(/please don't pay again/);
    expect(page.button()).toBe("Check now");
    expect(page.text()).not.toMatch(/Pay now/);

    // It keeps polling in the background, and switches when the payment lands.
    const before = page.calls.length;
    await new Promise(r => setTimeout(r, 50));
    expect(page.calls.length).toBeGreaterThan(before);
    page.close();
  });

  test("cancelled: offers to pay", async () => {
    const page = await openReturnPage("order=172&payment=cancelled", [pending]);
    await page.waitFor("Payment cancelled");
    expect(page.button()).toBe("Pay now");
    expect(page.calls.length).toBe(1);
    page.close();
  });

  test("expired and review states get their own message", async () => {
    const expired = await openReturnPage("order=172&payment=success", [{ order_status: "expired", payment: { status: "pending" } }]);
    await expired.waitFor("Order expired");
    expired.close();

    const review = await openReturnPage("order=172&payment=success", [{ order_status: "expired", payment: { status: "review" } }]);
    await review.waitFor("Payment under review");
    review.close();
  });
});
