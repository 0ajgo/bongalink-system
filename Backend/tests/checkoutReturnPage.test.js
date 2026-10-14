// Runs the real Frontend/Pages/COpage/checkout.html in jsdom as if PayMongo
// had just redirected back to it, with GET /api/v1/payments/orders/:id stubbed.
const { openPage } = require("./pageHarness");

// statuses: the successive bodies GET /v1/payments/orders/172 returns.
async function openReturnPage(query, statuses) {
  let n = 0;
  const page = await openPage("Pages/COpage/checkout.html", {
    query, fastTimers: true,
    api: async ({ url }) => url.includes("/payments/orders/")
      ? { body: statuses[Math.min(n++, statuses.length - 1)] }
      : { body: url === "/cart" ? [] : {} }
  });
  page.heading = () => page.$(".result h1")?.textContent;
  page.text = () => page.$(".result")?.textContent || "";
  page.button = () => page.$("#status-action")?.textContent.trim() || null;
  page.statusCalls = () => page.calls.filter(c => c.url.includes("/payments/orders/"));
  page.waitFor = async (heading) => {
    await page.until(() => page.heading() === heading);
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
    expect(page.statusCalls().every(c => c.url === "/v1/payments/orders/172" && c.method === "GET")).toBe(true);
    expect(page.statusCalls()).toHaveLength(3);
    expect(page.button()).toBeNull();
    // the cart isn't loaded on the return page
    expect(page.calls.some(c => c.url === "/cart")).toBe(false);
    page.close();
  });

  test("still pending after success: clear message, keeps checking, never offers to pay again", async () => {
    const page = await openReturnPage("order=172&payment=success", [pending]);
    await page.waitFor("Waiting for payment confirmation");
    expect(page.text()).toMatch(/please don't pay again/);
    expect(page.button()).toBe("Check now");
    expect(page.text()).not.toMatch(/Pay now/);

    // It keeps polling in the background.
    const before = page.statusCalls().length;
    await new Promise(r => setTimeout(r, 50));
    expect(page.statusCalls().length).toBeGreaterThan(before);
    page.close();
  });

  test("cancelled: offers to pay", async () => {
    const page = await openReturnPage("order=172&payment=cancelled", [pending]);
    await page.waitFor("Payment cancelled");
    expect(page.button()).toBe("Pay now");
    expect(page.statusCalls()).toHaveLength(1);
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
