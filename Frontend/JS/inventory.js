/* =====================================================================
   inventory.js — admin Inventory & forecasts (Pages/Admin/inventory.html)
   Requires api.js, icons.js, cart.js, ui.js and chart.js.
   Reads what the Python ML worker writes (via /api/admin/ml/*) and lets
   the admin edit stock/price or remove products (via /api/products).
   ===================================================================== */

renderHeader({ active: "inventory" });

const STATUS_POLL_MS = 5000;
const predRows = document.getElementById("predRows");
const historyProduct = document.getElementById("historyProduct");
const historyDays = document.getElementById("historyDays");
const chartEl = document.getElementById("historyChart");

let predictions = [];
let lastSeenUpdate = null;
let editing = false;   // don't redraw the table under the admin's cursor

const num = (value, digits = 1) => value === null || value === undefined ? null : Number(value).toFixed(digits);

function timeAgo(value) {
  if (!value) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return formatDateTime(value);
}

/* ---------------------------------------------------------------------
   STATUS BANNER
   --------------------------------------------------------------------- */
const STATES = {
  up_to_date: { label: "Up to date", tone: "success", icon: "check" },
  updating: { label: "Updating", tone: "info", icon: "refresh-cw" },
  failed: { label: "Failed", tone: "error", icon: "circle-alert" }
};

async function loadStatus() {
  const s = await apiFetch("/admin/ml/status");
  // Changes already queued count as "updating" even before the worker's next poll sees them.
  const state = s.state === "up_to_date" && s.pending_events > 0 ? STATES.updating : (STATES[s.state] || STATES.updating);
  const badge = document.getElementById("statusBadge");
  const shown = s.worker_online ? state : { label: "Worker offline", tone: "warning", icon: "triangle-alert" };
  badge.className = `badge badge--${shown.tone}`;
  badge.innerHTML = `${icon(shown.icon, { size: 14 })} ${shown.label}`;
  document.getElementById("lastUpdate").textContent =
    s.last_update_at ? `${formatDateTime(s.last_update_at)} (${timeAgo(s.last_update_at)})` : "never";

  const sub = [];
  if (!s.worker_online) sub.push("The ML worker is not running, so the forecasts below may be out of date.");
  if (s.pending_events > 0) sub.push(`${s.pending_events} product change(s) waiting to be processed.`);
  if (s.state === "failed" && s.last_error) sub.push(`Last error: ${s.last_error}`);
  if (s.last_train_status) sub.push(`Last training ${timeAgo(s.last_train_at)}: ${s.last_train_message || s.last_train_status}`);
  document.getElementById("statusSub").textContent = sub.join(" ");

  const m = s.active_model;
  document.getElementById("statusModel").innerHTML = m
    ? `Model <strong>${escapeHTML(m.version)}</strong><br><span class="muted">${escapeHTML(m.trained_with)}</span>` : "";

  // New predictions landed: refresh the table and change log.
  if (s.last_update_at !== lastSeenUpdate) {
    lastSeenUpdate = s.last_update_at;
    await Promise.all([loadPredictions(), loadEvents()]);
    if (historyProduct.value) loadHistory();
  }
}

/* ---------------------------------------------------------------------
   FORECAST TABLE
   --------------------------------------------------------------------- */
function forecastCell(p) {
  if (!p.computed_at) return `<span class="muted">Pending…</span>`;
  if (p.data_status === "insufficient_data") {
    const estimate = p.predicted_demand_7d === null ? "—" : `~${num(p.predicted_demand_7d)}`;
    const source = { category_average: "category avg", store_average: "store avg" }[p.forecast_source] || "no estimate";
    return `${estimate} <span class="badge" title="Listed ${p.history_days} day(s) ago; showing the ${source}">Insufficient data</span>`;
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
  // available = on hand minus units held by unpaid orders
  if (Number(p.available) <= 0) {
    const held = Number(p.reserved) > 0 ? ` title="${p.reserved} held by unpaid orders"` : "";
    return `<span class="badge badge--error"${held}>Out of stock</span>`;
  }
  if (!p.computed_at) return "";
  if (p.reorder_recommended) return `<span class="badge badge--warning">Reorder ${p.suggested_reorder_qty}</span>`;
  return `<span class="muted">—</span>`;
}

function trendCell(p) {
  if (!p.computed_at) return "";
  if (p.trend_status !== "ok") {
    return `<span class="badge" title="A trend needs 84 days of history and sales on at least 8 different days in that period">Insufficient data</span>`;
  }
  const since = `${p.trend_days_since_breakpoint} days ago`;
  if (p.trend_direction === "upward") return `<span class="trend trend--up" title="Demand started rising ${since}">↑ Rising since ${since}</span>`;
  if (p.trend_direction === "downward") return `<span class="trend trend--down" title="Demand started falling ${since}">↓ Falling since ${since}</span>`;
  return `<span class="muted">→ No shift</span>`;
}

// Parts still on the 0.5 kg default weight: J&T / LBC fees use this weight.
const DEFAULT_WEIGHT = 0.5;
const isDefaultWeight = (p) => Number(p.weight_kg) === DEFAULT_WEIGHT;

function renderPredictions() {
  if (editing) return;
  document.getElementById("productCount").textContent = `${predictions.length} active parts`;
  const unweighed = predictions.filter(isDefaultWeight).length;
  const notice = document.getElementById("weightNotice");
  notice.hidden = unweighed === 0;
  notice.innerHTML = unweighed ? `<div class="alert alert--warning">${icon("triangle-alert", { size: 18 })}
    <span>${unweighed} part${unweighed === 1 ? " still uses" : "s still use"} the default 0.5 kg weight. Enter real
    weights so J&amp;T and LBC fees match what the couriers charge.</span></div>` : "";
  predRows.innerHTML = predictions.map(p => {
    const stale = p.computed_at && Number(p.predicted_for_stock) !== Number(p.stock_quantity);
    return `
      <tr data-id="${p.product_id}">
        <td><button class="link-button" type="button" data-history="${p.product_id}">${escapeHTML(p.name)}</button>
            ${stale ? `<span class="badge badge--info" title="Stock changed; new forecast on the way">updating</span>` : ""}
            <br><span class="muted">${escapeHTML(p.category)}</span></td>
        <td class="num"><input class="input input--sm" type="number" min="0" step="0.01" value="${Number(p.price)}" data-field="price" aria-label="Price of ${escapeHTML(p.name)}"></td>
        <td class="num"><strong>${p.stock_quantity}</strong>${Number(p.reserved) > 0 ? `<br><span class="muted" title="Held by unpaid orders">${p.reserved} held</span>` : ""}</td>
        <td class="num"><input class="input input--sm" type="number" min="0.01" step="0.01" value="${Number(p.weight_kg)}" data-field="weight" aria-label="Weight in kg of ${escapeHTML(p.name)}">
            ${isDefaultWeight(p) ? `<br><span class="badge badge--warning" title="Still the default weight; enter the real parcel weight">Default</span>` : ""}</td>
        <td class="num">${forecastCell(p)}</td>
        <td class="num">${daysCell(p)}</td>
        <td>${reorderCell(p)}</td>
        <td>${trendCell(p)}</td>
        <td class="actions">
          <button class="btn btn--secondary btn--sm" type="button" data-edit="${p.product_id}">${icon("pencil", { size: 14 })} Edit</button>
          <button class="btn btn--primary btn--sm" type="button" data-save="${p.product_id}" disabled>Save</button>
          <button class="btn btn--danger btn--sm" type="button" data-remove="${p.product_id}">Hide</button>
        </td>
      </tr>`;
  }).join("") || `<tr><td colspan="9">${UIState.empty({ icon: "boxes", title: "No active parts", text: "List a product from the Shop page." })}</td></tr>`;
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
  const editBtn = event.target.closest("[data-edit]");

  if (editBtn) return openEditor(editBtn.dataset.edit);

  if (history) {
    historyProduct.value = history.dataset.history;
    loadHistory();
    historyProduct.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  if (save) {
    const row = save.closest("tr");
    const id = save.dataset.save;
    const original = predictions.find(p => String(p.product_id) === id);
    // Quick edits: price and weight. Stock only changes through Edit > Adjust stock (with a reason).
    const price = row.querySelector('[data-field="price"]').value;
    const weight = row.querySelector('[data-field="weight"]').value;
    const body = {};
    if (Number(weight) !== Number(original.weight_kg)) body.weight_kg = weight === "" ? "" : Number(weight);
    if (Number(price) !== Number(original.price)) body.price = price === "" ? "" : Number(price);
    if (Object.keys(body).length === 0) return;
    save.disabled = true;
    save.classList.add("is-loading");
    try {
      await apiFetch(`/products/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      toast("Saved. The forecast will update in a few seconds.", "success");
      editing = false;
      await Promise.all([loadPredictions(), loadEvents(), loadStatus()]);
    } catch (err) {
      save.disabled = false;
      save.classList.remove("is-loading");
      toast(err.message, "error");
    }
  }

  if (remove) {
    const product = predictions.find(p => String(p.product_id) === remove.dataset.remove);
    if (!confirm(`Hide "${product.name}" from the shop?\n\nIts order history and sales trend are kept, and you can show it again from Hidden parts.`)) return;
    try {
      await apiFetch(`/products/${product.product_id}`, { method: "DELETE" });
      toast("Part hidden.", "success");
      editing = false;
      await Promise.all([loadPredictions(), loadEvents(), loadProducts()]);
    } catch (err) {
      toast(err.message, "error");
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
   SALES HISTORY (units sold per day + 7-day forecast line)
   --------------------------------------------------------------------- */
async function loadProducts() {
  const products = await apiFetch("/admin/ml/products");
  const current = historyProduct.value;
  historyProduct.innerHTML = products.map(p =>
    `<option value="${p.product_id}">${escapeHTML(p.name)}${p.is_active ? "" : " (hidden)"}</option>`).join("");
  if (current && products.some(p => String(p.product_id) === current)) historyProduct.value = current;

  // Hidden parts: open the editor to show them in the shop again.
  const hidden = products.filter(p => !p.is_active);
  document.getElementById("hiddenSection").hidden = hidden.length === 0;
  document.getElementById("hiddenList").innerHTML = hidden.map(p => `
    <button class="btn btn--secondary btn--sm" type="button" data-edit="${p.product_id}">${icon("pencil", { size: 14 })} ${escapeHTML(p.name)}</button>`).join("");
}

/* ---------------------------------------------------------------------
   EDIT PART — js/product-editor.js. After any save, refresh the table,
   hidden parts and change log in place (no page reload).
   --------------------------------------------------------------------- */
function openEditor(id) {
  openProductEditor(id, {
    onChange: () => {
      editing = false;
      return Promise.all([loadPredictions(), loadProducts(), loadEvents()]).catch(() => {});
    }
  });
}
document.getElementById("hiddenList").addEventListener("click", (event) => {
  const b = event.target.closest("[data-edit]");
  if (b) openEditor(b.dataset.edit);
});

async function loadHistory() {
  const id = historyProduct.value;
  if (!id) return;
  const { product, series } = await apiFetch(`/admin/ml/history/${id}?days=${historyDays.value}`);
  const p = predictions.find(x => String(x.product_id) === String(id));
  document.getElementById("historyTitle").textContent = `Units sold per day — ${product.name}`;

  const forecast = p && p.avg_daily_demand !== null && p.avg_daily_demand !== undefined ? Number(p.avg_daily_demand) : null;
  const points = series.map(d => ({ day: d.day, value: d.units }));
  const units = (v) => `${v} unit${v === 1 ? "" : "s"}`;
  barChart(chartEl, points, {
    label: `Units sold per day, ${product.name}`,
    format: units,
    overlay: forecast === null ? null
      : { value: forecast, slots: 7, label: `${p.data_status === "ok" ? "forecast" : "estimate"} ${forecast.toFixed(1)}/day` }
  });
  document.getElementById("historyTable").innerHTML = chartTable(points, { valueHeader: "Units sold", format: units });

  const total = series.reduce((s, d) => s + d.units, 0);
  let note = `${total} units sold in the last ${series.length} days (paid and completed orders).`;
  if (!product.is_active) note += " This part was removed; its history is kept for trend reports.";
  else if (p && p.data_status === "insufficient_data") note += " Dashed line: category estimate, not a forecast for this part.";
  else if (forecast !== null) note += " Dashed line: forecast average per day for the next 7 days.";
  document.getElementById("historyNote").textContent = note;
}

historyProduct.addEventListener("change", loadHistory);
historyDays.addEventListener("change", loadHistory);
window.addEventListener("resize", () => { clearTimeout(loadHistory.t); loadHistory.t = setTimeout(loadHistory, 200); });

/* ---------------------------------------------------------------------
   CHANGE LOG
   --------------------------------------------------------------------- */
const EVENT_LABELS = { ADDED: "Added", REMOVED: "Removed", STOCK_CHANGED: "Stock", PRICE_CHANGED: "Price", ID_CHANGED: "Part ID" };

async function loadEvents() {
  const events = await apiFetch("/admin/ml/events?limit=25");
  const val = v => v === null ? "—" : Number(v).toLocaleString("en-PH");
  document.getElementById("eventRows").innerHTML = events.map(e => `
    <tr>
      <td>${formatDateTime(e.created_at)}</td>
      <td>${escapeHTML(e.product_name || `#${e.product_id}`)}</td>
      <td>${EVENT_LABELS[e.event_type] || escapeHTML(e.event_type)}</td>
      <td class="num">${e.event_type === "ADDED" || e.event_type === "REMOVED" ? "" : val(e.old_value)}</td>
      <td class="num">${e.event_type === "ADDED" ? val(e.new_value) + " in stock" : e.event_type === "REMOVED" ? "" : val(e.new_value)}</td>
      <td>${escapeHTML(e.changed_by || "system")}</td>
      <td>${e.processed ? `<span class="badge badge--success">${icon("check", { size: 12 })} processed</span>` : `<span class="badge badge--info">pending</span>`}</td>
    </tr>`).join("") || `<tr><td colspan="7">${UIState.empty({ icon: "clipboard-list", title: "No changes recorded yet" })}</td></tr>`;
}

/* ---------------------------------------------------------------------
   INIT
   --------------------------------------------------------------------- */
async function init() {
  predRows.innerHTML = UIState.rowSkeletons(9, 5);
  document.getElementById("eventRows").innerHTML = UIState.rowSkeletons(7, 3);
  chartEl.innerHTML = `<span class="skeleton skeleton--media"></span>`;
  try {
    await loadProducts();
    await loadStatus();          // also loads predictions + events the first time
    await loadHistory();
  } catch (err) {
    predRows.innerHTML = `<tr><td colspan="9">${UIState.error(err.message, "retryInventory")}</td></tr>`;
    document.getElementById("retryInventory").addEventListener("click", init);
    return;
  }
  if (location.hash === "#forecasts") document.getElementById("forecasts").scrollIntoView();
  // inventory.html?edit=12 (e.g. "Edit this part" on the product page) opens the editor.
  const editId = new URLSearchParams(location.search).get("edit");
  if (/^\d+$/.test(editId || "")) openEditor(editId);
  setInterval(() => loadStatus().catch(() => {}), STATUS_POLL_MS);
}

if (requireAdminPage()) init();
