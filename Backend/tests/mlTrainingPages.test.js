// "Update forecasts & trends" on the Forecasts page and the Dashboard, in jsdom with a
// stubbed API: one click = one queued run, progress without reloading the page, the
// forecasts reload when it finishes, failures and an offline worker are explained.
const { openPage } = require("./pageHarness");

const model = { version: "v20261014-211029-815", trained_with: "tensorflow 2.21.0 (Keras Dense(1), Adam, 24 epochs)",
  trained_at: "2026-10-14T13:10:34Z", train_rows: 3649, val_rows: 1798, val_mae: 0.249, baseline_val_mae: 0.253 };
const doneRun = { run_id: 7, trigger_type: "nightly", trigger_detail: "nightly retraining (after 02:00)", requested_by: null,
  status: "done", outcome: "promoted", model_version: model.version, sales_records: 412, orders_used: 168, products_used: 67,
  train_rows: 3649, val_rows: 1798, data_from: "2026-01-02", data_to: "2026-10-13", val_mae: 0.249, baseline_val_mae: 0.253,
  naive_val_mae: 0.401, message: "Model promoted", queued_at: "2026-10-14T13:10:00Z", started_at: "2026-10-14T13:10:01Z",
  finished_at: "2026-10-14T13:10:34Z" };
const training = (over = {}) => ({
  current: null, runs: [doneRun], last_completed: doneRun, last_trained_at: "2026-10-14T13:10:34Z",
  last_result: { status: "promoted", message: "Model promoted" }, model, worker_online: true,
  auto: { nightly_hour: 2, new_orders: { threshold: 50, since_last: 12 }, stock_changes: { threshold: 100, since_last: 30 } },
  ...over });
const run = (status, over = {}) => ({ ...doneRun, run_id: 8, trigger_type: "manual", trigger_detail: "Update forecasts & trends button",
  requested_by: "owner", status, outcome: null, model_version: null, sales_records: null, val_mae: null, baseline_val_mae: null,
  queued_at: new Date().toISOString(), started_at: status === "queued" ? null : new Date().toISOString(), finished_at: null, ...over });

// Inventory page API. GET /admin/ml/training serves trainingStates[0] until the button is
// used; after the POST it serves afterPost in order, one per poll (the last one repeats).
function inventoryApi({ trainingStates = [training()], afterPost = null,
                        post = { status: 202, body: { run: run("queued"), worker_online: true } } } = {}) {
  let posted = false;
  let i = 0;
  return async ({ url, method }) => {
    if (url === "/admin/ml/training" && method === "POST") { posted = true; return post; }
    if (url === "/admin/ml/training") {
      if (!posted || !afterPost) return { body: trainingStates[0] };
      return { body: afterPost[Math.min(i++, afterPost.length - 1)] };
    }
    if (url === "/admin/ml/status") return { body: { state: "up_to_date", worker_online: true, last_update_at: "2026-10-14T15:10:42Z", pending_events: 0 } };
    if (url === "/admin/ml/predictions") return { body: [] };
    if (url === "/admin/ml/products") return { body: [{ product_id: 1, name: "Part 1", is_active: 1 }] };
    if (url.startsWith("/admin/ml/history")) return { body: { product: { name: "Part 1", is_active: 1 }, series: [{ day: "2026-10-13", units: 1 }] } };
    if (url === "/v1/admin/orders/to-ship") return { body: { count: 0 } };
    return { body: [] };
  };
}

const openInventory = async (opts, harness = {}) => {
  const page = await openPage("Pages/Admin/inventory.html", { role: "admin", username: "owner", api: inventoryApi(opts), ...harness });
  await page.until(() => page.$("#modelTraining [data-retrain]"));
  return page;
};
const calls = (page, method, url) => page.calls.filter((c) => c.method === method && c.url === url);
const panel = (page) => page.$("#modelTraining").textContent.replace(/\s+/g, " ");

describe("Forecasts page: Update forecasts & trends", () => {
  test("shows last updated, the data used, accuracy, the automatic triggers and the history", async () => {
    const page = await openInventory();
    const text = panel(page);
    expect(page.$("#modelTraining-title").textContent).toBe("Forecast model");
    expect(text).toContain("Last updated: Oct 14, 2026");
    expect(text).toContain("412 sales records from 168 orders, 67 products");
    expect(text).toContain("Off by 0.25 units per part per week on average");
    expect(text).toContain("38% better than a simple average, 0.40");
    expect(text).toContain("Also updates by itself: nightly after 02:00 · after 50 new paid orders (12 so far) · after 100 stock changes (30 so far).");
    const row = page.$(".ml-history tbody tr").textContent.replace(/\s+/g, " ");
    expect(row).toContain("Nightly schedule");
    expect(row).toContain("412 sales, 67 products");
    expect(row).toContain("New model in use");
    expect(page.$("[data-retrain]").disabled).toBe(false);
    page.close();
  });

  test("one click queues one run; progress updates without reloading; the forecasts reload when it's done", async () => {
    const page = await openInventory({ afterPost: [training({ current: run("queued") }), training({ current: run("training") }),
      training({ current: null, runs: [{ ...run("done"), outcome: "promoted", model_version: "v-next", finished_at: new Date().toISOString() }, doneRun] })] },
      { fastTimers: true });
    const predictionsBefore = calls(page, "GET", "/admin/ml/predictions").length;
    page.$("[data-retrain]").click();
    page.$("[data-retrain]").click();     // a double click still sends one request
    await page.until(() => page.$(".ml-steps"));
    expect(calls(page, "POST", "/admin/ml/training")).toHaveLength(1);
    expect(page.$("[data-retrain]").disabled).toBe(true);
    expect(page.$('.ml-step[aria-current="step"]').textContent.trim()).toMatch(/^(Queued|Training)$/);

    await page.until(() => page.doc.body.textContent.includes("Forecast update: New model in use."));
    await page.until(() => calls(page, "GET", "/admin/ml/predictions").length > predictionsBefore);
    expect(page.$(".ml-steps")).toBeNull();
    expect(page.$("[data-retrain]").disabled).toBe(false);
    page.close();
  });

  test("while a run is in progress (from anyone) the button is disabled and says who started it", async () => {
    const page = await openInventory({ trainingStates: [training({ current: run("training", { requested_by: "maria" }) })] });
    expect(page.$("[data-retrain]").disabled).toBe(true);
    expect(panel(page)).toContain("Training by maria, started");
    expect(page.$('.ml-step[aria-current="step"]').textContent.trim()).toBe("Training");
    page.close();
  });

  test("a refused request (another run just started) is explained", async () => {
    const page = await openInventory({ post: { status: 409, body: { error: "A retrain is already queued, started by maria. Wait for it to finish.", code: "RETRAIN_IN_PROGRESS" } } });
    page.$("[data-retrain]").click();
    await page.until(() => page.doc.body.textContent.includes("A retrain is already queued, started by maria."));
    page.close();
  });

  test("a failed update is shown with its error, and the previous model is still in use", async () => {
    const failed = { ...run("failed"), outcome: "failed", message: "Retraining failed, kept the active model: RuntimeError: out of memory" };
    const page = await openInventory({ trainingStates: [training({ runs: [failed, doneRun],
      last_result: { status: "failed", message: failed.message } })] });
    const alert = page.$(".ml-training__status .alert--error").textContent.replace(/\s+/g, " ");
    expect(alert).toContain("The last update failed.");
    expect(alert).toContain("RuntimeError: out of memory");
    expect(alert).toContain("The forecasts still use the previous model.");
    expect(page.$(".ml-history tbody tr").textContent).toContain("Failed: kept the current model");
    expect(panel(page)).toContain("Off by 0.25 units");   // accuracy of the model still in use
    page.close();
  });

  test("with the ML worker stopped, the admin is told the update will wait for it", async () => {
    const page = await openInventory({ trainingStates: [training({ worker_online: false })] });
    expect(panel(page)).toContain("The ML worker isn't running. You can still ask for an update; it starts when the worker is back.");
    page.close();
  });
});

describe("Dashboard", () => {
  test("has the same button in a compact panel, linking to the history", async () => {
    const page = await openPage("Pages/Admin/dashboard.html", { role: "admin", api: async ({ url, method }) => {
      if (url === "/admin/ml/training" && method === "POST") return { status: 202, body: { run: run("queued"), worker_online: true } };
      if (url === "/admin/ml/training") return { body: training() };
      return { status: 500, body: { error: "not stubbed" } };
    } });
    await page.until(() => page.$("#dashTraining [data-retrain]"));
    expect(page.$("#dashTraining-title").textContent).toBe("Forecasts & trends");
    expect(page.$("#dashTraining .ml-history")).toBeNull();
    expect(page.$('#dashTraining a[href="inventory.html#modelTraining"]').textContent).toBe("Training history");
    page.$("#dashTraining [data-retrain]").click();
    await page.until(() => page.calls.some((c) => c.method === "POST"));
    expect(page.calls.filter((c) => c.method === "POST")).toEqual([{ url: "/admin/ml/training", method: "POST", body: undefined }]);
    await page.settle();
    page.close();
  });

  test("customers don't get the panel or any training request", async () => {
    const page = await openPage("Pages/Admin/inventory.html", { role: "user", api: inventoryApi() });
    expect(page.$("main").textContent).toContain("Admin account required");
    expect(page.calls.some((c) => c.url.includes("/admin/ml/training"))).toBe(false);
    page.close();
  });
});
