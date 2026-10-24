// How the forecasts and sales look on the admin pages (js/forecast-ui.js, js/chart.js):
// the status tiles and their filter on Inventory, the new table cells, the trend %, the
// Dashboard's Sales and Forecast cards, and barChart's extra options staying off by default.
// jsdom with a stubbed API.
const { openPage } = require("./pageHarness");

const pred = (id, name, over = {}) => ({
  product_id: id, name, category: "Printer Parts", price: "100.00", stock_quantity: 5, reserved: 0, available: 5,
  weight_kg: "1.000", computed_at: "2026-10-14T08:00:00Z", predicted_for_stock: over.stock_quantity ?? 5,
  predicted_demand_7d: 2, avg_daily_demand: 0.286, days_until_stockout: 17.5, reorder_recommended: 0, suggested_reorder_qty: 0,
  forecast_source: "model", data_status: "ok", history_days: 200, trend_status: "ok", trend_direction: "none",
  trend_relative_change: 0.002, trend_days_since_breakpoint: 30, ...over });

// One group each, the first that matches: Reorder now 1, 2, 3 · Runs out within 7 days 8 ·
// Not enough data 6 · Healthy 4, 5, 9 (9: in stock, no expected sales) · 7 not scored yet.
const PREDICTIONS = [
  pred(1, "Ryzen 5 5600", { stock_quantity: 9, available: 9, predicted_demand_7d: 17, days_until_stockout: 3.8, reorder_recommended: 1,
    suggested_reorder_qty: 15, trend_direction: "upward", trend_relative_change: 0.32, trend_days_since_breakpoint: 21 }),
  pred(2, "Samsung 980 NVMe", { stock_quantity: 0, available: 0, predicted_demand_7d: 6, days_until_stockout: 0, reorder_recommended: 1, suggested_reorder_qty: 8 }),
  pred(3, "Held part", { stock_quantity: 2, reserved: 2, available: 0, predicted_demand_7d: 1, days_until_stockout: 14, reorder_recommended: 1, suggested_reorder_qty: 3 }),
  pred(4, "TP-Link Archer C6", { stock_quantity: 22, available: 22, predicted_demand_7d: 5, days_until_stockout: 31,
    trend_direction: "downward", trend_relative_change: -0.15, trend_days_since_breakpoint: 30 }),
  pred(5, "Corsair CV550", { stock_quantity: 7, available: 7, predicted_demand_7d: 6, days_until_stockout: 8.2 }),
  pred(6, "Cooler Master MasterGel", { stock_quantity: 3, available: 3, predicted_demand_7d: 0.14, days_until_stockout: 150,
    data_status: "insufficient_data", forecast_source: "category_average", history_days: 5, trend_status: "insufficient_data",
    trend_direction: null, trend_relative_change: null, trend_days_since_breakpoint: null }),
  pred(7, "Pending part", { computed_at: null }),
  pred(8, "Epson L3210 printhead", { stock_quantity: 3, available: 3, predicted_demand_7d: 4, days_until_stockout: 5.3 }),
  pred(9, "Slow seller", { stock_quantity: 4, available: 4, predicted_demand_7d: 0, days_until_stockout: null })
];

function inventoryApi(predictions = PREDICTIONS) {
  return async ({ url, method }) => {
    if (url === "/admin/ml/predictions") return { body: predictions };
    if (url === "/admin/ml/status") return { body: { state: "up_to_date", worker_online: true, last_update_at: "2026-10-14T08:00:00Z" } };
    if (url === "/admin/ml/products") return { body: [{ product_id: 1, name: "Ryzen 5 5600", is_active: 1 }] };
    if (url.startsWith("/admin/ml/history")) return { body: { product: { name: "Ryzen 5 5600", is_active: 1 }, series: [
      { day: "2026-10-11", units: 1 }, { day: "2026-10-12", units: 4 }, { day: "2026-10-13", units: 2 }] } };
    if (method === "PATCH") return { body: {} };
    if (url === "/v1/admin/orders/to-ship") return { body: { count: 0 } };
    return { body: [] };
  };
}

async function openInventory(predictions) {
  const page = await openPage("Pages/Admin/inventory.html", { role: "admin", api: inventoryApi(predictions) });
  await page.until(() => page.$('#predRows tr[data-id="1"]') && page.$("#historyChart svg"));
  return page;
}
const text = (el) => el.textContent.replace(/\s+/g, " ").trim();
const tile = (page, key) => page.$(`#forecastTiles [data-group="${key}"]`);
const tileCount = (page, key) => tile(page, key).querySelector(".fc-tile__count").textContent;
const shownIds = (page) => page.$$("#predRows tr[data-id]").map(tr => tr.dataset.id);
const cell = (page, id, col) => text(page.$(`#predRows tr[data-id="${id}"]`).cells[col]);

describe("Inventory: Forecast by part", () => {
  test("title, count, and the columns in order", async () => {
    const page = await openInventory();
    expect(page.$("#forecastTitle").textContent).toBe("Forecast by part");
    expect(page.$("#productCount").textContent).toBe("Next 7 days · 9 active parts");
    expect(page.$$("#forecasts thead th").map(th => th.textContent)).toEqual(
      ["Part", "Price (₱)", "Weight (kg)", "Stock vs next 7 days", "Stock lasts", "Action", "Trend", ""]);
    expect(page.$('#predRows tr[data-id="1"]').cells).toHaveLength(8);
    expect(page.$("#forecasts .chart-legend").textContent.replace(/\s+/g, " ").trim())
      .toBe("On hand Forecast demand, 7 days Under 7 days 7–14 days 14+ days");
    page.close();
  });

  test("status group counts: one group per part, adding up to the scored parts; unscored rows left out", async () => {
    const page = await openInventory();
    const counts = ["reorder", "soon", "healthy", "nodata"].map(k => Number(tileCount(page, k)));
    expect(counts).toEqual([3, 1, 3, 1]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(PREDICTIONS.filter(p => p.computed_at).length);
    expect(page.$$("#forecastTiles button[aria-pressed]")).toHaveLength(4);
    // every tile carries an icon and its words, not only a colour
    expect(text(tile(page, "reorder"))).toBe("3 Reorder now");
    expect(tile(page, "soon").querySelector("svg")).not.toBeNull();
    expect(text(tile(page, "nodata"))).toBe("1 … Not enough data");
    const group = page.window.forecastGroup;
    expect(group(PREDICTIONS[0])).toBe("reorder");        // reorder wins over runs out within 7 days
    expect(group(PREDICTIONS[7])).toBe("soon");
    expect(group(PREDICTIONS[8])).toBe("healthy");        // in stock, no expected demand
    expect(group(PREDICTIONS[6])).toBeNull();             // not scored yet
    // out of stock with too little data: Reorder now, not also Not enough data
    expect(group(pred(10, "x", { available: 0, stock_quantity: 0, data_status: "insufficient_data" }))).toBe("reorder");
    page.close();
  });

  test("a tile filters the rows; clicking it again shows every part", async () => {
    const page = await openInventory();
    tile(page, "reorder").click();
    expect(shownIds(page)).toEqual(["1", "2", "3"]);
    expect(tile(page, "reorder").getAttribute("aria-pressed")).toBe("true");
    expect(tile(page, "soon").getAttribute("aria-pressed")).toBe("false");

    tile(page, "soon").click();
    expect(shownIds(page)).toEqual(["8"]);
    tile(page, "soon").click();
    expect(shownIds(page)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(page.$$('#forecastTiles [aria-pressed="true"]')).toHaveLength(0);
    page.close();
  });

  test("the filter survives a quick edit and a redraw (new forecasts after a retrain)", async () => {
    const page = await openInventory();
    tile(page, "healthy").click();
    expect(shownIds(page)).toEqual(["4", "5", "9"]);
    const input = page.$('#predRows tr[data-id="4"] [data-field="price"]');
    input.dispatchEvent(new page.window.Event("focusin", { bubbles: true }));
    input.value = "120";
    input.dispatchEvent(new page.window.Event("change", { bubbles: true }));
    await page.until(() => page.$("#qs-price-4").textContent.includes("Saved"));
    input.blur();
    input.dispatchEvent(new page.window.Event("focusout", { bubbles: true }));
    await page.settle();
    page.window.renderPredictions();
    expect(shownIds(page)).toEqual(["4", "5", "9"]);
    expect(tile(page, "healthy").getAttribute("aria-pressed")).toBe("true");
    page.close();
  });

  test("a group with no parts says how to show them all", async () => {
    const page = await openInventory(PREDICTIONS.filter(p => p.data_status !== "insufficient_data"));
    tile(page, "nodata").click();
    expect(shownIds(page)).toEqual([]);
    expect(page.$("#predRows").textContent).toContain("No parts in this group");
    page.close();
  });

  test("Stock vs next 7 days: one scale for all rows, short in bold, ~ for estimates, held units kept", async () => {
    const page = await openInventory();
    expect(cell(page, 1, 3)).toBe("9 on hand · 17 needed · short 8");
    expect(page.$('#predRows tr[data-id="1"] .svd__short').textContent).toBe("short 8");
    expect(cell(page, 4, 3)).toBe("22 on hand · 5 needed");
    expect(cell(page, 6, 3)).toBe("3 on hand · ~0.1 needed");
    expect(cell(page, 3, 3)).toBe("2 on hand · 1 needed · 2 held");
    expect(cell(page, 7, 3)).toBe("5 on hand · Pending…");
    // scale = 22 (largest stock or demand of any row)
    expect(page.$('#predRows tr[data-id="4"] .svd__have').style.width).toBe("100%");
    expect(page.$('#predRows tr[data-id="1"] .svd__need').style.left).toBe(`${(17 / 22) * 100}%`);
    expect(page.$('#predRows tr[data-id="7"] .svd__need')).toBeNull();
    page.close();
  });

  test("tiny or slightly negative forecasts: no '0 needed · short 0' and no '-0'", async () => {
    const page = await openInventory([
      pred(1, "Tiny", { stock_quantity: 0, available: 0, predicted_demand_7d: 0.04, days_until_stockout: 0, reorder_recommended: 1, suggested_reorder_qty: 1 }),
      pred(2, "Negative", { stock_quantity: 0, available: 0, predicted_demand_7d: -0.004, data_status: "insufficient_data" }),
      pred(3, "Just short", { stock_quantity: 1, available: 1, predicted_demand_7d: 1.06 })]);
    expect(cell(page, 1, 3)).toBe("0 on hand · <0.1 needed");
    expect(cell(page, 2, 3)).toBe("0 on hand · ~0 needed");
    expect(cell(page, 3, 3)).toBe("1 on hand · 1.1 needed · short 0.1");
    page.close();
  });

  test("Stock lasts: Out, days with * for estimates, — without a forecast; colour by runway", async () => {
    const page = await openInventory();
    expect(cell(page, 1, 4)).toBe("3.8 days");
    expect(page.$('#predRows tr[data-id="1"] .runway').classList.contains("runway--short")).toBe(true);
    expect(cell(page, 2, 4)).toBe("Out");
    expect(page.$('#predRows tr[data-id="5"] .runway').classList.contains("runway--mid")).toBe(true);
    expect(page.$('#predRows tr[data-id="4"] .runway').classList.contains("runway--long")).toBe(true);
    expect(cell(page, 6, 4)).toBe("150 days*");
    expect(page.$('#predRows tr[data-id="6"] .runway__fill').style.width).toBe("100%");
    expect(cell(page, 7, 4)).toBe("—");
    // in stock but no expected sales: muted text, empty bar
    expect(cell(page, 9, 4)).toBe("No sales expected");
    expect(page.$('#predRows tr[data-id="9"] .runway__text .muted')).not.toBeNull();
    expect(page.$('#predRows tr[data-id="9"] .runway').classList.contains("runway--none")).toBe(true);
    expect(page.$('#predRows tr[data-id="9"] .runway__fill').style.width).toBe("0%");
    page.close();
  });

  test("Action and Trend pills, with their tooltips", async () => {
    const page = await openInventory();
    const pillOf = (id, col) => page.$(`#predRows tr[data-id="${id}"]`).cells[col].querySelector(".pill");
    expect(cell(page, 2, 5)).toBe("Out · reorder 8");
    expect(pillOf(2, 5).classList.contains("pill--error")).toBe(true);
    expect(pillOf(3, 5).title).toBe("2 held by unpaid orders");
    expect(cell(page, 1, 5)).toBe("Reorder 15");
    expect(cell(page, 6, 5)).toBe("Category estimate");
    expect(pillOf(6, 5).title).toBe("Listed 5 day(s) ago; showing the category avg");
    expect(cell(page, 4, 5)).toBe("OK");
    expect(cell(page, 7, 5)).toBe("");

    expect(cell(page, 1, 6)).toBe("Rising");
    expect(pillOf(1, 6).title).toBe("Rising since 21 days ago");
    expect(pillOf(1, 6).classList.contains("pill--up")).toBe(true);
    expect(pillOf(1, 6).querySelector("svg")).not.toBeNull();
    expect(cell(page, 4, 6)).toBe("Falling");
    expect(pillOf(4, 6).title).toBe("Falling since 30 days ago");
    expect(pillOf(4, 6).classList.contains("pill--down")).toBe(true);
    expect(cell(page, 5, 6)).toBe("→Steady");
    expect(cell(page, 6, 6)).toBe("Not enough data");
    expect(pillOf(6, 6).title).toContain("A trend needs 84 days of history");
    // every pill has an icon (or an arrow) next to its words
    page.$$("#predRows .pill").forEach(p => expect(p.querySelector("svg, [aria-hidden]")).not.toBeNull());
    page.close();
  });

  test("the Trend column shows a direction only, never a percentage", async () => {
    const page = await openInventory();
    const trends = page.$$("#predRows tr[data-id]").map(tr => text(tr.cells[6]));
    expect(trends).toEqual(["Rising", "→Steady", "→Steady", "Falling", "→Steady", "Not enough data", "", "→Steady", "→Steady"]);
    expect(page.$("#predRows").textContent).not.toMatch(/%/);
    page.close();
  });
});

describe("barChart", () => {
  test("the new options are off by default: the inventory history chart is unchanged", async () => {
    const page = await openInventory();
    const svg = page.$("#historyChart svg");
    expect(svg.getAttribute("height")).toBe("220");
    expect(page.$$("#historyChart .grid")).toHaveLength(3);
    expect(page.$$("#historyChart .bar")).toHaveLength(3);
    expect(page.$("#historyChart .avg-line, #historyChart .bar--peak, #historyChart .bar--dim, #historyChart .peak-label")).toBeNull();
    expect(page.$$("#historyChart text.axis").length).toBe(3 + 3 + 1);   // 3 y ticks, 3 dates, the forecast label
    page.close();
  });

  test("average, highlightMax, dimBelowAverage and xTicks when asked for", async () => {
    const page = await openInventory();
    const el = page.doc.createElement("div");
    page.doc.body.appendChild(el);
    const points = Array.from({ length: 30 }, (_, i) => ({ day: `2026-09-${String(i + 1).padStart(2, "0")}`, value: i === 10 ? 940 : 300 + (i % 4) * 100 }));
    page.window.barChart(el, points, {});
    expect(el.querySelector(".avg-line, .bar--peak, .bar--dim")).toBeNull();

    page.window.barChart(el, points, { average: true, highlightMax: true, dimBelowAverage: true, xTicks: 7, unit: "day", height: 250,
      axis: (v) => (v >= 1000 ? `₱${Math.round(v / 100) / 10}k` : `₱${Math.round(v)}`) });
    expect(el.querySelector("svg").getAttribute("height")).toBe("250");
    expect(el.querySelectorAll(".grid")).toHaveLength(5);
    expect(el.querySelectorAll(".bar--peak")).toHaveLength(1);
    expect(el.querySelector('.hit[data-i="10"]').previousElementSibling.classList.contains("bar--peak")).toBe(true);
    expect(el.querySelector(".peak-label").textContent).toBe("₱940");
    const mean = points.reduce((s, p) => s + p.value, 0) / 30;
    expect(el.querySelectorAll(".bar--dim")).toHaveLength(points.filter(p => p.value < mean).length);
    expect(el.querySelector(".avg-label").textContent).toBe(`avg ₱${Math.round(mean)}/day`);
    // the top of the scale rounds 940 up to 1,000 with 5 gridlines
    expect([...el.querySelectorAll("text.axis")].map(t => t.textContent).slice(0, 5)).toEqual(["₱0", "₱250", "₱500", "₱750", "₱1k"]);
    page.close();
  });
});

describe("Dashboard: Sales and Forecast cards", () => {
  const days = Array.from({ length: 30 }, (_, i) => ({ day: `2026-09-${String(i + 1).padStart(2, "0")}`, units: i % 7 === 0 ? 2 : 0, revenue: i % 7 === 0 ? 500 : 0 }));
  const weeks = Array.from({ length: 12 }, (_, i) => ({ day: new Date(Date.UTC(2026, 6, 20 + 7 * i)).toISOString().slice(0, 10), units: i === 11 ? 4 : 1, revenue: i === 11 ? 1200 : 100 }));
  const tile = (revenue) => ({ revenue, previous_revenue: 0, orders: 0, units: 0, change_pct: null });
  const data = { group: "day", range: 30, days: 30, today: "2026-10-14", low_stock_threshold: 3, stock: { active_products: 7, low_stock: 1, out_of_stock: 2 },
    sales: { today: tile(0), week: tile(0), month: tile(0) }, month: { orders: 0, units: 0, revenue: 0 }, trend: days, top_products: [] };
  const api = ({ dashboard = data, predictions = { body: PREDICTIONS } } = {}) => async ({ url }) => {
    if (url.startsWith("/admin/ml/dashboard")) return { body: url.includes("group=week") ? { ...dashboard, group: "week", range: 12, trend: weeks } : dashboard };
    if (url === "/admin/ml/predictions") return typeof predictions === "function" ? predictions() : predictions;
    if (url === "/v1/admin/orders/to-ship") return { body: { count: 0 } };
    return { body: {} };
  };
  const open = (opts) => openPage("Pages/Admin/dashboard.html", { role: "admin", api: api(opts) });

  test("Sales: title, total / daily average / best day tiles, average line, best bar and legend", async () => {
    const page = await open();
    await page.until(() => page.$("#trendChart svg") && page.$("#forecastBody .fc-tiles"));
    expect(page.$("#trendTitle").textContent).toBe("Sales");
    expect(page.$$("#trendKpis .kpi").map(text)).toEqual(["Total, last 30 days ₱2,500", "Daily average ₱83", "Best day ₱500 Sep 1"]);
    expect(page.$("#trendKpis").hidden).toBe(false);
    expect(page.$(".avg-label").textContent).toBe("avg ₱83/day");
    expect(page.$$("#trendChart .bar--peak")).toHaveLength(1);
    expect(page.$$("#trendChart .bar")).toHaveLength(30);
    expect(page.$$("#trendLegend li").map(text)).toEqual(["Above average", "Below average", "Best day", "Average"]);
    expect(page.$("#trendTable details summary").textContent).toBe("Show as a table");

    const hit = page.$('#trendChart .hit[data-i="0"]');
    hit.dispatchEvent(new page.window.Event("mouseenter"));
    expect(page.$("#trendChart .chart-tip").textContent).toMatch(/^₱500\.00 · 2 units.*Sep 1 · \+500% vs avg$/);

    page.$('[data-group="week"]').click();
    await page.until(() => page.$$("#trendChart .bar").length === 12);
    expect(page.$$("#trendKpis .kpi").map(text)).toEqual(["Total, last 12 weeks ₱2,300", "Weekly average ₱192", "Best week ₱1,200 Week 41"]);
    expect(page.$$("#trendLegend li").map(text)[2]).toBe("Best week");

    page.$('[data-metric="units"]').click();   // units keep their own format
    expect(page.$$("#trendKpis .kpi").map(text)).toEqual(["Total, last 12 weeks 15 units", "Weekly average 1.3 units", "Best week 4 units Week 41"]);
    page.close();
  });

  test("Sales: the tiles and legend are hidden in the empty state", async () => {
    const page = await open({ dashboard: { ...data, trend: days.map(d => ({ ...d, units: 0, revenue: 0 })) } });
    await page.until(() => page.$("#trendChart .state"));
    expect(page.$("#trendKpis").hidden).toBe(true);
    expect(page.$("#trendLegend").hidden).toBe(true);
    page.close();
  });

  test("Forecast: 2×2 status tiles and the 5 parts in stock that run out first", async () => {
    const page = await open();
    await page.until(() => page.$("#forecastBody .risk-list"));
    expect(page.$("#forecastCardTitle").textContent).toBe("Forecast");
    expect(page.$("#forecastCard .card__header .muted").textContent).toBe("Next 7 days");
    expect(page.$$("#forecastBody .fc-tile").map(text)).toEqual(["3 Reorder now", "1 Runs out within 7 days", "3 Healthy", "1 … Not enough data"]);
    expect(page.$("#forecastBody button")).toBeNull();   // not filters here
    expect(page.$("#forecastBody .fc-subhead").textContent).toBe("Most at risk");
    // Out-of-stock parts (2, 3) are left out, and so is the part with no expected sales (9)
    const rows = page.$$("#forecastBody .risk-item").map(li => [li.querySelector("strong").textContent, text(li.querySelector(".pill")), text(li.querySelector(".runway__text"))]);
    expect(rows).toEqual([
      ["Ryzen 5 5600", "Reorder 15", "3.8 days"],
      ["Epson L3210 printhead", "OK", "5.3 days"],
      ["Corsair CV550", "OK", "8.2 days"],
      ["TP-Link Archer C6", "OK", "31 days"],
      ["Cooler Master MasterGel", "Category estimate", "150 days*"]]);
    page.close();
  });

  test("Forecast: every part out of stock: 'No parts running low'", async () => {
    const page = await open({ predictions: { body: [PREDICTIONS[1], PREDICTIONS[2], PREDICTIONS[8]] } });
    await page.until(() => page.$("#forecastBody .fc-tiles"));
    expect(page.$("#forecastBody .risk-list")).toBeNull();
    expect(page.$("#forecastBody").textContent).toContain("No parts running low");
    page.close();
  });

  test("Forecast: an error with Try again, then the card loads", async () => {
    let fail = true;
    const page = await open({ predictions: () => (fail ? { status: 500, body: { error: "Database unavailable." } } : { body: PREDICTIONS }) });
    await page.until(() => page.$("#forecastBody .state--error"));
    expect(page.$("#forecastBody").textContent).toContain("Couldn't load the forecast: Database unavailable.");
    expect(page.$("#trendChart svg")).not.toBeNull();   // the Sales card is unaffected
    fail = false;
    page.$("#retryForecast").click();
    await page.until(() => page.$("#forecastBody .risk-list"));
    page.close();
  });

  test("Forecast: no scored parts yet", async () => {
    const page = await open({ predictions: { body: [PREDICTIONS[6]] } });
    await page.until(() => page.$("#forecastBody .state"));
    expect(page.$("#forecastBody").textContent).toContain("No forecasts yet");
    page.close();
  });
});
