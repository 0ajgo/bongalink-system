// Admin Inventory page: each section loads on its own. A failed or unanswered request shows an
// error (with Try again) in that section only, never endless loading placeholders. jsdom, stubbed API.
const { openPage } = require("./pageHarness");

const OK = {
  "/admin/ml/predictions": [{ product_id: 1, name: "Part 1", category: "Printer Parts", price: "100.00", stock_quantity: 5,
    reserved: 0, available: 5, weight_kg: "1.000", computed_at: null }],
  "/admin/ml/status": { state: "up_to_date", worker_online: true, last_update_at: "2026-10-14T08:00:00Z" },
  "/admin/ml/products": [{ product_id: 1, name: "Part 1", is_active: 1 }],
  "/admin/ml/events?limit=25": [{ created_at: "2026-10-14T08:00:00Z", product_id: 1, product_name: "Part 1", event_type: "ADDED",
    old_value: null, new_value: 5, changed_by: "owner", processed: 1 }],
  "/v1/admin/orders/to-ship": { count: 0 }
};
const HISTORY = { product: { name: "Part 1", is_active: 1 }, series: [{ day: "2026-10-13", units: 2 }] };

// failing: { url prefix: "error" | "hang" }; a request that hangs never answers.
function api(failing = {}) {
  return async ({ url }) => {
    const mode = Object.entries(failing).find(([prefix]) => url.startsWith(prefix))?.[1];
    if (mode === "hang") return new Promise(() => {});
    if (mode === "error") return { status: 500, body: { error: "Database unavailable." } };
    if (url.startsWith("/admin/ml/history")) return { body: HISTORY };
    return { body: OK[url] ?? [] };
  };
}
const open = (opts) => openPage("Pages/Admin/inventory.html", { role: "admin", ...opts });
const forecastLoaded = (page) => page.$('#predRows tr[data-id="1"]');
const eventsLoaded = (page) => page.$("#eventRows tr td")?.textContent.includes("Part 1");
const chartLoaded = (page) => page.$("#historyTitle").textContent.includes("Part 1") && !page.$("#historyChart .skeleton");

describe("inventory page sections", () => {
  test("the forecast request fails: only the forecast table shows the error; status, chart and change log load; Try again works", async () => {
    const failing = { "/admin/ml/predictions": "error" };
    const page = await open({ api: api(failing) });
    await page.until(() => page.$("#predRows .state--error"));
    expect(page.$("#predRows").textContent).toContain("Couldn't load the stock forecast: Database unavailable.");
    await page.until(() => chartLoaded(page) && eventsLoaded(page));
    expect(page.$("#lastUpdate").textContent).not.toBe("—");
    expect(page.$("#statusBadge").textContent).toContain("Up to date");

    delete failing["/admin/ml/predictions"];
    page.$("#retryForecast").click();
    await page.until(() => forecastLoaded(page));
    expect(page.$("#predRows .state--error")).toBeNull();
    page.close();
  });

  test("the status request fails: 'Last forecast update' says so instead of staying on a placeholder; the rest still loads", async () => {
    const page = await open({ api: api({ "/admin/ml/status": "error" }) });
    await page.until(() => page.$("#lastUpdate").textContent === "couldn't load");
    expect(page.$("#statusBadge").textContent).toContain("Unavailable");
    expect(page.$("#statusSub").textContent).toContain("Couldn't load the forecast status: Database unavailable.");
    expect(page.$("#retryStatus")).not.toBeNull();
    await page.until(() => forecastLoaded(page) && eventsLoaded(page) && chartLoaded(page));
    page.close();
  });

  test("the sales history and the change log each show their own error", async () => {
    const page = await open({ api: api({ "/admin/ml/history": "error", "/admin/ml/events": "error" }) });
    await page.until(() => page.$("#historyChart .state--error") && page.$("#eventRows .state--error"));
    expect(page.$("#historyChart").textContent).toContain("Couldn't load the sales history");
    expect(page.$("#retryHistory")).not.toBeNull();
    expect(page.$("#eventRows").textContent).toContain("Couldn't load the change log");
    await page.until(() => forecastLoaded(page));
    page.close();
  });

  test("a request that never answers fails after 20 s with a clear message instead of loading forever", async () => {
    let clock = 0;
    const page = await open({ api: api({ "/admin/ml/history": "hang" }), fastTimers: true, setup: (w) => {
      const now = w.Date.now.bind(w.Date);
      w.Date.now = () => now() + clock;
    } });
    await page.until(() => forecastLoaded(page));
    expect(page.$("#historyChart .skeleton")).not.toBeNull();   // still waiting, not failed early
    clock = 19000;
    await page.settle();
    expect(page.$("#historyChart .state--error")).toBeNull();
    clock = 21000;
    await page.until(() => page.$("#historyChart .state--error"));
    expect(page.$("#historyChart").textContent).toContain("The server took too long to answer. Please try again.");
    page.close();
  });
});
