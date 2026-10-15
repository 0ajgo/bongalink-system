/* =====================================================================
   BONGALINK — ADMIN DASHBOARD (Pages/Admin/dashboard.html)
   Requires api.js, icons.js, cart.js, ui.js and chart.js. Read-only.
   ===================================================================== */

renderHeader({ active: "dashboard" });

const $ = (id) => document.getElementById(id);
const state = { data: null, metric: "revenue", days: 30 };
const METRIC = {
  revenue: { label: "Item revenue per day", header: "Revenue", format: (v) => formatMoney(v),
             axis: (v) => v >= 1000 ? `₱${Math.round(v / 100) / 10}k` : `₱${Math.round(v)}` },
  units: { label: "Units sold per day", header: "Units", format: (v) => `${v} unit${v === 1 ? "" : "s"}`, axis: (v) => String(Math.round(v * 10) / 10) }
};

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
  const month = new Date().toLocaleDateString("en-PH", { month: "long" });
  setStat("statSales", formatMoney(d.month.revenue).replace(/\.00$/, ""),
    `${month}: ${d.month.orders} order${d.month.orders === 1 ? "" : "s"}, ${d.month.units} unit${d.month.units === 1 ? "" : "s"}`);
}

/* ---------------------------------------------------------------------
   SALES TREND + TOP PRODUCTS
   --------------------------------------------------------------------- */
function renderTrend() {
  const d = state.data;
  const m = METRIC[state.metric];
  const points = d.trend.map(t => ({ day: t.day, value: t[state.metric] }));
  const total = points.reduce((s, p) => s + p.value, 0);
  if (total === 0) {
    $("trendChart").innerHTML = UIState.empty({ icon: "clipboard-list", title: "No sales in this period",
      text: "Paid orders appear here the day after they're placed." });
    $("trendNote").textContent = "";
    $("trendTable").innerHTML = "";
    return;
  }
  barChart($("trendChart"), points, { label: `${m.label}, last ${d.days} days`, format: m.format, axis: m.axis });
  $("trendNote").textContent = `${m.header} in the last ${d.days} days: ${m.format(state.metric === "revenue" ? Math.round(total * 100) / 100 : total)}. Excludes today and unpaid or expired orders.`;
  $("trendTable").innerHTML = chartTable(points, { valueHeader: m.header, format: m.format });
}

function renderTop() {
  const top = state.data.top_products;
  $("topPeriod").textContent = `Last ${state.data.days} days`;
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
    state.data = await apiFetch(`/admin/ml/dashboard?days=${state.days}`);
    renderSummary(state.data);
    renderTrend();
    renderTop();
  } catch (err) {
    $("trendChart").innerHTML = UIState.error(err.message, "retryDashboard");
    $("topProducts").innerHTML = "";
    $("retryDashboard").addEventListener("click", loadDashboard);
  }
}

document.querySelectorAll("[data-metric]").forEach(b => b.addEventListener("click", () => {
  state.metric = b.dataset.metric;
  document.querySelectorAll("[data-metric]").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  if (state.data) renderTrend();
}));
$("trendDays").addEventListener("change", () => { state.days = Number($("trendDays").value); loadDashboard(); });
window.addEventListener("resize", () => {
  clearTimeout(renderTrend.t);
  renderTrend.t = setTimeout(() => state.data && renderTrend(), 200);
});

if (requireAdminPage()) {
  loadDashboard();
  loadToShip();
  loadModel();
  loadChat();
  loadAccountsTile();
  // After a retrain: the model tile and the sales trend chart.
  MLTraining.mount(document.getElementById("dashTraining"), { compact: true, onFinished: () => { loadModel(); loadDashboard(); } });
}
