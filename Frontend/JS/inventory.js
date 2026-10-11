/* =====================================================================
   inventory.js — admin Inventory & Forecasts page
   (Frontend/Pages/Admin/inventory.html)
   Requires api.js to be loaded first.

   Reads what the Python ML worker writes (via /api/admin/ml/*) and lets
   the admin edit stock/price or remove products (via /api/products).
   Edits return immediately: the worker notices the change on its own
   (ml_events) and the table refreshes when new predictions land.
   ===================================================================== */

const STATUS_POLL_MS = 5000;

const statusBadge = document.getElementById("statusBadge");
const predRows = document.getElementById("predRows");
const historyProduct = document.getElementById("historyProduct");
const historyDays = document.getElementById("historyDays");
const chartEl = document.getElementById("historyChart");
const chartTip = document.getElementById("chartTip");

let predictions = [];
let lastSeenUpdate = null;
let editing = false;   // don't redraw the table under the admin's cursor

/* ---------------------------------------------------------------------
   HELPERS
   --------------------------------------------------------------------- */
function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function num(value, digits = 1) {
  return value === null || value === undefined ? null : Number(value).toFixed(digits);
}

function timeAgo(value) {
  if (!value) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(value).toLocaleString("en-PH");
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

/* ---------------------------------------------------------------------
   STATUS BANNER
   --------------------------------------------------------------------- */
const STATES = {
  up_to_date: { label: "✓ Up to date", cls: "ok" },
  updating: { label: "↻ Updating…", cls: "busy" },
  failed: { label: "! Failed", cls: "bad" }
};

async function loadStatus() {
  const s = await apiFetch("/admin/ml/status");
  // Changes already queued count as "updating" even before the worker's next poll sees them.
  const state = s.state === "up_to_date" && s.pending_events > 0 ? STATES.updating : (STATES[s.state] || STATES.updating);

  statusBadge.textContent = s.worker_online ? state.label : "● Worker offline";
  statusBadge.className = `status-badge ${s.worker_online ? state.cls : "off"}`;
  document.getElementById("lastUpdate").textContent =
    s.last_update_at ? `${new Date(s.last_update_at).toLocaleString("en-PH")} (${timeAgo(s.last_update_at)})` : "never";

  const sub = [];
  if (!s.worker_online) sub.push("The ML worker is not running, so the forecasts below may be out of date.");
  if (s.pending_events > 0) sub.push(`${s.pending_events} product change(s) waiting to be processed.`);
  if (s.state === "failed" && s.last_error) sub.push(`Last error: ${s.last_error}`);
  if (s.last_train_status) {
    sub.push(`Last training ${timeAgo(s.last_train_at)}: ${s.last_train_message || s.last_train_status}`);
  }
  document.getElementById("statusSub").textContent = sub.join(" ");

  const m = s.active_model;
  document.getElementById("statusModel").innerHTML = m
    ? `Model <strong>${escapeHTML(m.version)}</strong><br><span>${escapeHTML(m.trained_with)}</span>`
    : "";

  // New predictions landed: refresh the table and change log.
  if (s.last_update_at !== lastSeenUpdate) {
    lastSeenUpdate = s.last_update_at;
    await Promise.all([loadPredictions(), loadEvents()]);
    if (historyProduct.value) loadHistory();
  }
}

/* ---------------------------------------------------------------------
   PREDICTIONS TABLE
   --------------------------------------------------------------------- */
function forecastCell(p) {
  if (!p.computed_at) return `<span class="muted">Pending…</span>`;
  if (p.data_status === "insufficient_data") {
    const estimate = p.predicted_demand_7d === null ? "—" : `~${num(p.predicted_demand_7d)}`;
    const source = { category_average: "category avg", store_average: "store avg" }[p.forecast_source] || "no estimate";
    return `${estimate} <span class="tag tag-muted" title="Listed ${p.history_days} day(s) ago; showing the ${source}">Insufficient data</span>`;
  }
  return num(p.predicted_demand_7d);
}

function daysCell(p) {
  if (!p.computed_at || p.days_until_stockout === null) return `<span class="muted">—</span>`;
  const d = Number(p.days_until_stockout);
  const cls = p.data_status === "ok" && d < 7 ? "warn-text" : "";
  return `<span class="${cls}">${num(d)}${p.data_status === "ok" ? "" : "*"}</span>`;
}

function reorderCell(p) {
  if (!p.computed_at) return "";
  if (Number(p.stock_quantity) <= 0) return `<span class="stock-pill stock-out">Out of stock</span>`;
  if (p.reorder_recommended) return `<span class="stock-pill stock-low">Reorder ${p.suggested_reorder_qty}</span>`;
  return `<span class="muted">—</span>`;
}

function trendCell(p) {
  if (!p.computed_at) return "";
  if (p.trend_status !== "ok") return `<span class="tag tag-muted" title="Needs 84 days of history">Insufficient data</span>`;
  const since = `${p.trend_days_since_breakpoint} days ago`;
  if (p.trend_direction === "upward") return `<span class="trend up" title="Demand started rising ${since}">↑ Rising since ${since}</span>`;
  if (p.trend_direction === "downward") return `<span class="trend down" title="Demand started falling ${since}">↓ Falling since ${since}</span>`;
  return `<span class="muted">→ No shift</span>`;
}

function renderPredictions() {
  if (editing) return;
  document.getElementById("productCount").textContent = `${predictions.length} active products`;
  predRows.innerHTML = predictions.map(p => {
    const stale = p.computed_at && Number(p.predicted_for_stock) !== Number(p.stock_quantity);
    return `
      <tr data-id="${p.product_id}">
        <td><button class="link" data-history="${p.product_id}">${escapeHTML(p.name)}</button>
            ${stale ? `<span class="tag tag-busy" title="Stock changed; new forecast on the way">updating</span>` : ""}</td>
        <td>${escapeHTML(p.category)}</td>
        <td class="num"><input type="number" min="0" step="0.01" value="${Number(p.price)}" data-field="price" aria-label="Price"></td>
        <td class="num"><input type="number" min="0" step="1" value="${p.stock_quantity}" data-field="stock" aria-label="Stock"></td>
        <td class="num">${forecastCell(p)}</td>
        <td class="num">${daysCell(p)}</td>
        <td>${reorderCell(p)}</td>
        <td>${trendCell(p)}</td>
        <td class="actions">
          <button class="btn-small" data-save="${p.product_id}" disabled>Save</button>
          <button class="btn-small danger" data-remove="${p.product_id}">Remove</button>
        </td>
      </tr>`;
  }).join("") || `<tr><td colspan="9" class="muted">No active products.</td></tr>`;
}

async function loadPredictions() {
  predictions = await apiFetch("/admin/ml/predictions");
  renderPredictions();
}

predRows.addEventListener("input", event => {
  const row = event.target.closest("tr");
  if (!row || !event.target.dataset.field) return;
  editing = true;
  row.querySelector("[data-save]").disabled = false;
});

predRows.addEventListener("click", async event => {
  const save = event.target.closest("[data-save]");
  const remove = event.target.closest("[data-remove]");
  const history = event.target.closest("[data-history]");

  if (history) {
    historyProduct.value = history.dataset.history;
    loadHistory();
    historyProduct.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  if (save) {
    const row = save.closest("tr");
    const id = save.dataset.save;
    const original = predictions.find(p => String(p.product_id) === id);
    const price = row.querySelector('[data-field="price"]').value;
    const stock = row.querySelector('[data-field="stock"]').value;
    const body = {};
    if (Number(price) !== Number(original.price)) body.price = price === "" ? "" : Number(price);
    if (Number(stock) !== Number(original.stock_quantity)) body.stock = stock === "" ? "" : Number(stock);
    if (Object.keys(body).length === 0) return;
    save.disabled = true;
    try {
      await apiFetch(`/products/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      showToast("Saved. The forecast will update in a few seconds.");
      editing = false;
      await Promise.all([loadPredictions(), loadEvents(), loadStatus()]);
    } catch (err) {
      save.disabled = false;
      showToast(err.message);
    }
  }

  if (remove) {
    const product = predictions.find(p => String(p.product_id) === remove.dataset.remove);
    if (!confirm(`Remove "${product.name}" from the catalog?\n\nIts order history and sales trend are kept.`)) return;
    try {
      await apiFetch(`/products/${product.product_id}`, { method: "DELETE" });
      showToast("Product removed.");
      editing = false;
      await Promise.all([loadPredictions(), loadEvents(), loadProducts()]);
    } catch (err) {
      showToast(err.message);
    }
  }
});

// Leaving the table without saving: let polling redraw it again.
predRows.addEventListener("focusout", () => {
  setTimeout(() => {
    if (!predRows.contains(document.activeElement) &&
        !predRows.querySelector("[data-save]:not([disabled])")) editing = false;
  }, 0);
});

/* ---------------------------------------------------------------------
   SALES HISTORY CHART (inline SVG, one series: units sold per day)
   --------------------------------------------------------------------- */
async function loadProducts() {
  const products = await apiFetch("/admin/ml/products");
  const current = historyProduct.value;
  historyProduct.innerHTML = products.map(p =>
    `<option value="${p.product_id}">${escapeHTML(p.name)}${p.is_active ? "" : " (removed)"}</option>`
  ).join("");
  if (current && products.some(p => String(p.product_id) === current)) historyProduct.value = current;
}

function niceMax(v) {
  if (v <= 5) return 5;
  const step = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / step) * step;
}

async function loadHistory() {
  const id = historyProduct.value;
  if (!id) return;
  const { product, series } = await apiFetch(`/admin/ml/history/${id}?days=${historyDays.value}`);
  const p = predictions.find(x => String(x.product_id) === String(id));
  document.getElementById("historyTitle").textContent = `Units sold per day — ${product.name}`;

  const forecastDays = p && p.avg_daily_demand !== null && p.avg_daily_demand !== undefined ? 7 : 0;
  const forecast = forecastDays ? Number(p.avg_daily_demand) : null;
  drawChart(series, forecast, forecastDays, p);

  const total = series.reduce((s, d) => s + d.units, 0);
  let note = `${total} units sold in the last ${series.length} days (paid and completed orders).`;
  if (!product.is_active) note += " This product was removed; its history is kept for trend reports.";
  else if (p && p.data_status === "insufficient_data") note += " Dashed line: category estimate, not a forecast for this product.";
  else if (forecast !== null) note += " Dashed line: forecast average per day for the next 7 days.";
  document.getElementById("historyNote").textContent = note;
}

function drawChart(series, forecast, forecastDays, p) {
  const W = Math.max(chartEl.clientWidth, 320);
  const H = 220;
  const pad = { l: 34, r: 12, t: 12, b: 26 };
  const slots = series.length + forecastDays;
  const slot = (W - pad.l - pad.r) / slots;
  const barW = Math.max(1, slot - 2);                       // 2px gap between bars
  const maxY = niceMax(Math.max(1, ...series.map(d => d.units), forecast || 0));
  const y = v => pad.t + (H - pad.t - pad.b) * (1 - v / maxY);
  const base = y(0);

  const grid = [0, maxY / 2, maxY].map(v =>
    `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/>
     <text class="axis" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${Math.round(v * 10) / 10}</text>`
  ).join("");

  const r = Math.min(4, barW / 2);
  const bars = series.map((d, i) => {
    const x = pad.l + i * slot;
    const top = y(d.units);
    const h = base - top;
    // Rounded data-end (top), square baseline.
    const shape = h <= 0 ? "" : h <= r
      ? `<rect class="bar" x="${x}" y="${top}" width="${barW}" height="${h}"/>`
      : `<path class="bar" d="M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${base} Z"/>`;
    // Full-height invisible hit target, wider than the mark.
    return `${shape}<rect class="hit" x="${x - 1}" y="${pad.t}" width="${slot}" height="${base - pad.t}" data-i="${i}"/>`;
  }).join("");

  let forecastMark = "";
  if (forecastDays) {
    const x1 = pad.l + series.length * slot;
    const x2 = W - pad.r;
    const label = p.data_status === "ok" ? "forecast" : "estimate";
    forecastMark = `
      <line class="divider" x1="${x1}" x2="${x1}" y1="${pad.t}" y2="${base}"/>
      <line class="forecast" x1="${x1 + 2}" x2="${x2}" y1="${y(forecast)}" y2="${y(forecast)}"/>
      <text class="axis" x="${x2}" y="${y(forecast) - 6}" text-anchor="end">${label} ${forecast.toFixed(1)}/day</text>`;
  }

  const fmt = s => new Date(s + "T00:00:00").toLocaleDateString("en-PH", { month: "short", day: "numeric" });
  const xLabels = [0, Math.floor(series.length / 2), series.length - 1].map(i =>
    `<text class="axis" x="${pad.l + i * slot + barW / 2}" y="${H - 8}" text-anchor="middle">${fmt(series[i].day)}</text>`
  ).join("");

  chartEl.innerHTML = `
    <svg width="${W}" height="${H}" role="img" aria-label="Units sold per day">
      ${grid}${bars}${forecastMark}
      <line class="baseline" x1="${pad.l}" x2="${W - pad.r}" y1="${base}" y2="${base}"/>
      ${xLabels}
    </svg>`;

  chartEl.querySelectorAll(".hit").forEach(hit => {
    hit.addEventListener("mouseenter", () => {
      const d = series[Number(hit.dataset.i)];
      chartTip.innerHTML = `<strong>${d.units}</strong> unit${d.units === 1 ? "" : "s"}<br>${fmt(d.day)}`;
      chartTip.hidden = false;
      const box = hit.getBoundingClientRect();
      const panel = chartEl.offsetParent.getBoundingClientRect();   // .panel is position:relative
      chartTip.style.left = `${box.left - panel.left + box.width / 2}px`;
      chartTip.style.top = `${chartEl.offsetTop + pad.t - 8}px`;
      hit.previousElementSibling?.classList.add("active");
    });
    hit.addEventListener("mouseleave", () => {
      chartTip.hidden = true;
      hit.previousElementSibling?.classList.remove("active");
    });
  });
}

historyProduct.addEventListener("change", loadHistory);
historyDays.addEventListener("change", loadHistory);
window.addEventListener("resize", () => { clearTimeout(drawChart.t); drawChart.t = setTimeout(loadHistory, 200); });

/* ---------------------------------------------------------------------
   CHANGE LOG
   --------------------------------------------------------------------- */
const EVENT_LABELS = {
  ADDED: "Added", REMOVED: "Removed", STOCK_CHANGED: "Stock", PRICE_CHANGED: "Price", ID_CHANGED: "Product ID"
};

async function loadEvents() {
  const events = await apiFetch("/admin/ml/events?limit=25");
  const val = v => v === null ? "—" : Number(v).toLocaleString("en-PH");
  document.getElementById("eventRows").innerHTML = events.map(e => `
    <tr>
      <td>${new Date(e.created_at).toLocaleString("en-PH")}</td>
      <td>${escapeHTML(e.product_name || `#${e.product_id}`)}</td>
      <td>${EVENT_LABELS[e.event_type] || e.event_type}</td>
      <td class="num">${e.event_type === "ADDED" || e.event_type === "REMOVED" ? "" : val(e.old_value)}</td>
      <td class="num">${e.event_type === "ADDED" ? val(e.new_value) + " in stock" : e.event_type === "REMOVED" ? "" : val(e.new_value)}</td>
      <td>${escapeHTML(e.changed_by || "system")}</td>
      <td>${e.processed ? `<span class="muted">✓ processed</span>` : `<span class="tag tag-busy">pending</span>`}</td>
    </tr>`).join("") || `<tr><td colspan="7" class="muted">No changes recorded yet.</td></tr>`;
}

/* ---------------------------------------------------------------------
   INIT
   --------------------------------------------------------------------- */
async function init() {
  if (!isAdmin()) {
    document.getElementById("locked").hidden = false;
    return;
  }
  document.getElementById("dashboard").hidden = false;
  try {
    await loadProducts();
    await loadStatus();          // also loads predictions + events the first time
    loadHistory();
  } catch (err) {
    showToast(err.message || "Could not reach the API.");
  }
  setInterval(() => loadStatus().catch(() => {}), STATUS_POLL_MS);
}

init();
