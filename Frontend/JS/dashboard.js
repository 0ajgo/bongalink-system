/* =====================================================================
   BONGALINK — ADMIN DASHBOARD (Pages/Admin/dashboard.html)
   Requires api.js, icons.js, cart.js, ui.js, chart.js and forecast-ui.js. Read-only.
   ===================================================================== */

renderHeader({ active: "dashboard" });

const $ = (id) => document.getElementById(id);
const state = { data: null, metric: "revenue", group: "day", range: 30 };
const METRIC = {
  revenue: { label: "Item revenue", header: "Revenue", format: (v) => formatMoney(v),
             axis: (v) => v >= 1000 ? `₱${Math.round(v / 100) / 10}k` : `₱${Math.round(v)}` },
  units: { label: "Units sold", header: "Units", format: (v) => `${v} unit${v === 1 ? "" : "s"}`, axis: (v) => String(Math.round(v * 10) / 10) }
};

// Trend groupings. Each bar's `day` is the first day of its period ("YYYY-MM-DD", Philippine date);
// weeks are ISO weeks (Monday to Sunday). The ranges match the API's.
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
function isoWeek(day) {
  const thursday = new Date(Date.parse(`${addDays(day, 3)}T00:00:00Z`));   // `day` is a Monday
  return 1 + Math.floor((thursday - Date.UTC(thursday.getUTCFullYear(), 0, 1)) / (7 * 86400000));
}
const monthName = (day, month) => new Date(`${day}T00:00:00`).toLocaleDateString("en-PH", { month, year: "numeric" });
const weekdayDate = (day) => new Date(`${day}T00:00:00`).toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric" });
// per / best / short: the Sales card's tiles ("Daily average", "Best day" + "Oct 19"); tip: the chart tooltip.
const GROUP = {
  day: { ranges: [30, 90, 180], unit: "day", header: "Day", current: "today", axis: chartDate, label: chartDate,
         per: "Daily", best: "Best day", short: chartDate, tip: weekdayDate, ticks: 7,
         empty: "Paid orders appear here the day after they're placed." },
  week: { ranges: [12, 26, 52], unit: "week", header: "Week", current: "this week", axis: chartDate,
          label: (d) => `Week ${isoWeek(d)} · ${chartDate(d)}–${chartDate(addDays(d, 6))}`,
          per: "Weekly", best: "Best week", short: (d) => `Week ${isoWeek(d)}`, ticks: 1,
          empty: "Paid orders appear here once their week (Monday to Sunday) is over." },
  month: { ranges: [6, 12, 24], unit: "month", header: "Month", current: "this month", axis: (d) => monthName(d, "short"),
           label: (d) => monthName(d, "long"), per: "Monthly", best: "Best month", short: (d) => monthName(d, "short"), ticks: 1,
           empty: "Paid orders appear here once their month is over." }
};
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function setStat(id, value, sub) {
  const tile = $(id);
  tile.querySelector(".stat__value").innerHTML = value;
  tile.querySelector(".stat__sub").textContent = sub;
}

/* ---------------------------------------------------------------------
   SUMMARY TILES
   --------------------------------------------------------------------- */
async function loadToShip() {
  try {
    const count = await refreshToShipBadge();
    setStat("statToShip", String(count), count ? "Paid, waiting for a courier — open Deliveries" : "Nothing waiting. All paid orders have shipped.");
  } catch (err) {
    setStat("statToShip", "—", `Couldn't load: ${err.message}`);
  }
}

// Questions the AI chat assistant couldn't answer, waiting on Chat & FAQs.
async function loadChat() {
  try {
    const { unanswered_open: open } = await apiFetch("/v1/admin/chat/summary");
    setStat("statChat", String(open), open ? "The assistant couldn't answer: add FAQs" : "Nothing to review");
  } catch (err) {
    setStat("statChat", "—", `Couldn't load: ${err.message}`);
  }
}

// Accounts: total, new in the last 7 days, suspended.
async function loadAccountsTile() {
  try {
    const s = await apiFetch("/v1/admin/accounts/summary");
    setStat("statAccounts", String(s.total), `${s.new_this_week} new this week · ${s.suspended} suspended · ${s.admins} admin${s.admins === 1 ? "" : "s"}`);
  } catch (err) {
    setStat("statAccounts", "—", `Couldn't load: ${err.message}`);
  }
}

const ML_STATE = { up_to_date: ["Up to date", "success"], updating: ["Updating", "info"], failed: ["Failed", "error"] };
async function loadModel() {
  try {
    const s = await apiFetch("/admin/ml/status");
    const [label, tone] = !s.worker_online ? ["Worker offline", "warning"] : (ML_STATE[s.state] || ML_STATE.updating);
    setStat("statModel", `<span class="badge badge--${tone}">${label}</span>`,
      s.last_update_at ? `Last update ${formatDateTime(s.last_update_at)}${s.active_model ? ` · ${s.active_model.version}` : ""}` : "No forecasts yet");
  } catch (err) {
    setStat("statModel", "—", `Couldn't load: ${err.message}`);
  }
}

function renderSummary(d) {
  setStat("statLow", String(d.stock.low_stock), `1–${d.low_stock_threshold} available · of ${d.stock.active_products} active parts`);
  setStat("statOut", String(d.stock.out_of_stock), "0 available (on hand minus unpaid orders)");
  const month = new Date(`${d.today}T00:00:00`).toLocaleDateString("en-PH", { month: "long" });
  setStat("statOrders", String(d.month.orders), `${month}: ${plural(d.month.units, "unit")} sold`);
}

/* Revenue today / this week / this month, each vs the whole previous period, e.g.
   "₱12,400" and "+18% vs last week · 5 orders". */
const REVENUE_TILES = [["revToday", "today", "yesterday"], ["revWeek", "week", "last week"], ["revMonth", "month", "last month"]];
const wholePesos = (v) => formatMoney(v).replace(/\.00$/, "");

function changeText(t, vs) {
  if (t.change_pct === null) return escapeHTML(`No sales ${vs}`);
  const pct = t.change_pct;
  const tone = pct > 0 ? " delta--up" : pct < 0 ? " delta--down" : "";
  return `<span class="delta${tone}">${pct > 0 ? "+" : pct < 0 ? "-" : "±"}${Math.abs(pct)}%</span> vs ${escapeHTML(vs)}`;
}

function renderRevenue(sales) {
  for (const [id, key, vs] of REVENUE_TILES) {
    const t = sales[key];
    const tile = $(id);
    tile.querySelector(".stat__value").textContent = wholePesos(t.revenue);
    tile.querySelector(".stat__sub").innerHTML = `${changeText(t, vs)} · ${plural(t.orders, "order")}`;
    tile.title = `${vs[0].toUpperCase()}${vs.slice(1)}: ${wholePesos(t.previous_revenue)}`;
  }
}

/* ---------------------------------------------------------------------
   SALES + TOP PRODUCTS
   --------------------------------------------------------------------- */
// Revenue to the centavo, units to one decimal (averages).
const roundValue = (v) => (state.metric === "revenue" ? Math.round(v * 100) / 100 : Math.round(v * 10) / 10);

// Total / average / best period, from the same bars the chart draws. Revenue in whole pesos,
// like the revenue tiles at the top of the page.
function renderKpis(points, total, period, m, g) {
  const best = points.reduce((b, p) => (p.value > b.value ? p : b), points[0]);
  const show = (v) => (state.metric === "revenue" ? wholePesos(Math.round(v)) : m.format(roundValue(v)));
  const tile = (label, value, sub = "") => `
    <div class="kpi"><span class="kpi__label">${escapeHTML(label)}</span>
      <span class="kpi__value">${escapeHTML(value)}${sub ? ` <span class="kpi__sub">${escapeHTML(sub)}</span>` : ""}</span></div>`;
  $("trendKpis").innerHTML = tile(`Total, ${period}`, show(total))
    + tile(`${g.per} average`, show(total / points.length))
    + tile(g.best, show(best.value), g.short(best.day));
  $("trendKpis").hidden = false;
}

function renderLegend(g) {
  $("trendLegend").innerHTML = [["above", "Above average"], ["below", "Below average"], ["best", g.best], ["avg", "Average"]]
    .map(([key, text]) => `<li><span class="chart-legend__key chart-legend__key--${key}" aria-hidden="true"></span>${escapeHTML(text)}</li>`).join("");
  $("trendLegend").hidden = false;
}

function renderTrend() {
  const d = state.data;
  const m = METRIC[state.metric];
  const g = GROUP[d.group] || GROUP.day;
  const period = `last ${plural(d.range, g.unit)}`;
  const points = d.trend.map(t => ({ day: t.day, value: t[state.metric], units: t.units }));
  const total = points.reduce((s, p) => s + p.value, 0);
  if (total === 0) {
    $("trendChart").innerHTML = UIState.empty({ icon: "clipboard-list", title: "No sales in this period", text: g.empty });
    $("trendKpis").hidden = true;
    $("trendKpis").innerHTML = "";
    $("trendLegend").hidden = true;
    $("trendNote").textContent = "";
    $("trendTable").innerHTML = "";
    return;
  }
  renderKpis(points, total, period, m, g);
  barChart($("trendChart"), points, { label: `${m.label} per ${g.unit}, ${period}`, format: m.format, axis: m.axis,
                                      dayLabel: g.axis, tipLabel: g.tip || g.label, unit: g.unit, height: 250, xTicks: g.ticks,
                                      average: true, highlightMax: true, dimBelowAverage: true,
                                      detail: state.metric === "revenue" ? (p) => ` · ${plural(p.units, "unit")}` : null });
  renderLegend(g);
  $("trendNote").textContent = `${m.header} in the ${period}: ${m.format(state.metric === "revenue" ? Math.round(total * 100) / 100 : total)}. Excludes ${g.current} and unpaid or expired orders.`;
  $("trendTable").innerHTML = chartTable(points, { valueHeader: m.header, format: m.format, periodHeader: g.header, dayLabel: g.label });
}

/* ---------------------------------------------------------------------
   FORECAST — status counts and the 5 parts that run out first
   --------------------------------------------------------------------- */
const RISK_ROWS = 5;

function renderForecast(rows) {
  const body = $("forecastBody");
  if (!rows.some(p => p.computed_at)) {
    body.innerHTML = UIState.empty({ icon: "boxes", title: "No forecasts yet", text: "The ML worker fills this in after its first run." });
    return;
  }
  // Parts still on sale, fewest days of stock first (on a tie, more expected demand first).
  // Out-of-stock parts are already counted in the Reorder now tile.
  const risk = rows.filter(p => p.computed_at && Number(p.available) > 0 && p.days_until_stockout !== null && p.days_until_stockout !== undefined)
    .sort((a, b) => Number(a.days_until_stockout) - Number(b.days_until_stockout)
                    || Number(b.predicted_demand_7d) - Number(a.predicted_demand_7d))
    .slice(0, RISK_ROWS);
  body.innerHTML = `
    <div class="fc-tiles fc-tiles--2">${statusTiles(rows)}</div>
    <h3 class="fc-subhead">Most at risk</h3>
    ${risk.length ? `<ul class="risk-list">${risk.map(p => `
      <li class="risk-item">
        <div class="risk-item__head"><strong>${escapeHTML(p.name)}</strong>${actionPill(p)}</div>
        ${runwayBar(p)}
      </li>`).join("")}</ul>` : `<p class="muted">No parts running low</p>`}`;
}

async function loadForecast() {
  const body = $("forecastBody");
  body.innerHTML = `<div class="fc-tiles fc-tiles--2" aria-hidden="true">${`<span class="skeleton fc-tile-skeleton"></span>`.repeat(4)}</div>
    ${`<span class="skeleton skeleton--text"></span>`.repeat(RISK_ROWS)}`;
  try {
    const rows = await apiFetch("/admin/ml/predictions");
    renderForecast(Array.isArray(rows) ? rows : []);
  } catch (err) {
    body.innerHTML = UIState.error(`Couldn't load the forecast: ${err.message}`, "retryForecast");
    $("retryForecast").addEventListener("click", loadForecast);
  }
}

function renderTop() {
  const top = state.data.top_products;
  $("topPeriod").textContent = `Last ${plural(state.data.range, (GROUP[state.data.group] || GROUP.day).unit)}`;
  $("topProducts").innerHTML = top.length ? `
    <table class="table">
      <thead><tr><th>Part</th><th class="num">Units</th><th class="num">Revenue</th></tr></thead>
      <tbody>${top.map(t => `
        <tr><td><strong>${escapeHTML(t.name)}</strong><br><span class="muted">${escapeHTML(t.category)}</span></td>
            <td class="num">${t.units}</td><td class="num">${formatMoney(t.revenue)}</td></tr>`).join("")}</tbody>
    </table>`
    : UIState.empty({ icon: "package", title: "No sales yet", text: "Best sellers for the period show up here." });
}

async function loadDashboard() {
  $("trendChart").innerHTML = `<span class="skeleton skeleton--media"></span>`;
  $("topProducts").innerHTML = `<table class="table"><tbody>${UIState.rowSkeletons(3, 4)}</tbody></table>`;
  try {
    state.data = await apiFetch(`/admin/ml/dashboard?group=${state.group}&range=${state.range}`);
    renderSummary(state.data);
    renderRevenue(state.data.sales);
    renderTrend();
    renderTop();
  } catch (err) {
    $("trendChart").innerHTML = UIState.error(err.message, "retryDashboard");
    $("trendKpis").hidden = true;
    $("trendLegend").hidden = true;
    $("topProducts").innerHTML = "";
    REVENUE_TILES.forEach(([id]) => { if ($(id).querySelector(".skeleton")) setStat(id, "—", `Couldn't load: ${err.message}`); });
    $("retryDashboard").addEventListener("click", loadDashboard);
  }
}

document.querySelectorAll("[data-metric]").forEach(b => b.addEventListener("click", () => {
  state.metric = b.dataset.metric;
  document.querySelectorAll("[data-metric]").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  if (state.data) renderTrend();
}));
// Day / Week / Month: each grouping has its own ranges (e.g. 12/26/52 weeks); switching starts at the first.
function paintRangeOptions() {
  const g = GROUP[state.group];
  $("trendRange").innerHTML = g.ranges.map(n => `<option value="${n}">Last ${plural(n, g.unit)}</option>`).join("");
  $("trendRange").value = String(state.range);
}
document.querySelectorAll("[data-group]").forEach(b => b.addEventListener("click", () => {
  if (b.dataset.group === state.group) return;
  state.group = b.dataset.group;
  state.range = GROUP[state.group].ranges[0];
  document.querySelectorAll("[data-group]").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  paintRangeOptions();
  loadDashboard();
}));
$("trendRange").addEventListener("change", () => { state.range = Number($("trendRange").value); loadDashboard(); });
window.addEventListener("resize", () => {
  clearTimeout(renderTrend.t);
  renderTrend.t = setTimeout(() => state.data && renderTrend(), 200);
});

if (requireAdminPage()) {
  loadDashboard();
  loadForecast();
  loadToShip();
  loadModel();
  loadChat();
  loadAccountsTile();
  // After a retrain: the model tile, the sales chart and the forecast.
  MLTraining.mount(document.getElementById("dashTraining"), { compact: true, onFinished: () => { loadModel(); loadDashboard(); loadForecast(); } });
}
