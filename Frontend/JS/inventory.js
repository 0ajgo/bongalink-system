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
  renderWeightNotice();
  predRows.innerHTML = predictions.map(p => {
    const stale = p.computed_at && Number(p.predicted_for_stock) !== Number(p.stock_quantity);
    const label = escapeHTML(p.name);
    return `
      <tr data-id="${p.product_id}">
        <td class="col-part"><button class="link-button" type="button" data-history="${p.product_id}" title="Show sales history">${label}</button>
            ${stale ? `<span class="badge badge--info" title="Stock changed; new forecast on the way">updating</span>` : ""}
            <br><span class="muted">${escapeHTML(p.category)}</span></td>
        <td class="num">${quickInput(p, "price", Number(p.price), { min: 0.01, step: 0.01, label: `Price of ${label}` })}</td>
        <td class="num"><strong>${p.stock_quantity}</strong>${Number(p.reserved) > 0 ? `<br><span class="muted" title="Held by unpaid orders">${p.reserved} held</span>` : ""}</td>
        <td class="num">${quickInput(p, "weight", Number(p.weight_kg), { min: 0.01, step: 0.01, label: `Weight in kg of ${label}` })}
            ${isDefaultWeight(p) ? `<span class="badge badge--warning" data-default-badge title="Still the default weight; enter the real parcel weight">Default</span>` : ""}</td>
        <td class="num">${forecastCell(p)}</td>
        <td class="num">${daysCell(p)}</td>
        <td>${reorderCell(p)}</td>
        <td>${trendCell(p)}</td>
        <td class="actions">
          <button class="btn btn--secondary btn--sm" type="button" data-edit="${p.product_id}" aria-label="Edit ${label}" title="Edit">${icon("pencil", { size: 14 })}<span class="btn-label">Edit</span></button>
          <button class="btn btn--ghost btn--sm btn--icon" type="button" data-more="${p.product_id}"
                  aria-haspopup="menu" aria-expanded="false" title="More actions">${icon("ellipsis-vertical", { size: 16, label: `More actions for ${p.name}` })}</button>
        </td>
      </tr>`;
  }).join("") || `<tr><td colspan="9">${UIState.empty({ icon: "boxes", title: "No active parts", text: "List a product from the Shop page." })}</td></tr>`;
  updateScrollShadow();
}

function renderWeightNotice() {
  const unweighed = predictions.filter(isDefaultWeight).length;
  const notice = document.getElementById("weightNotice");
  notice.hidden = unweighed === 0;
  notice.innerHTML = unweighed ? `<div class="alert alert--warning">${icon("triangle-alert", { size: 18 })}
    <span>${unweighed} part${unweighed === 1 ? " still uses" : "s still use"} the default 0.5 kg weight. Enter real
    weights so J&amp;T and LBC fees match what the couriers charge.</span></div>` : "";
}

async function loadPredictions() {
  predictions = await apiFetch("/admin/ml/predictions");
  renderPredictions();
}

/* ---------------------------------------------------------------------
   QUICK EDITS (price, weight) — saved automatically when the field loses
   focus or on Enter; Escape puts the old value back. Each field shows
   Saving… / Saved, and on an error the old value comes back with the
   reason. Stock only changes through Edit > Adjust stock (with a reason).
   --------------------------------------------------------------------- */
const QUICK = {
  price: { api: "price", key: "price", name: "Price", show: (v) => formatMoney(v) },
  weight: { api: "weight_kg", key: "weight_kg", name: "Weight", show: (v) => `${v} kg` }
};
let pendingSaves = 0;

function quickInput(p, field, value, { min, step, label }) {
  return `<div class="quick-edit">
      <input class="input input--sm" type="number" min="${min}" step="${step}" value="${value}" data-field="${field}"
             data-id="${p.product_id}" data-original="${value}" aria-label="${label}" aria-describedby="qs-${field}-${p.product_id}">
      <span class="quick-edit__state" id="qs-${field}-${p.product_id}" role="status"></span>
    </div>`;
}

function setQuickState(input, text, tone = "") {
  const state = document.getElementById(input.getAttribute("aria-describedby"));
  state.className = `quick-edit__state${tone ? ` quick-edit__state--${tone}` : ""}`;
  state.innerHTML = text;
  clearTimeout(state.timer);
  if (tone === "ok") state.timer = setTimeout(() => { state.innerHTML = ""; }, 2500);
}

async function saveQuickEdit(input) {
  const q = QUICK[input.dataset.field];
  const original = Number(input.dataset.original);
  const value = Number(input.value);
  if (input.value !== "" && value === original) return;
  input.removeAttribute("aria-invalid");
  if (input.value === "" || !(value > 0)) {
    input.value = original;
    input.setAttribute("aria-invalid", "true");
    return setQuickState(input, `${q.name} must be more than 0. Kept ${q.show(original)}.`, "error");
  }

  pendingSaves++;
  input.disabled = true;
  setQuickState(input, "Saving…");
  try {
    await apiFetch(`/products/${input.dataset.id}`, { method: "PATCH", body: JSON.stringify({ [q.api]: value }) });
    input.dataset.original = value;
    const p = predictions.find(x => String(x.product_id) === input.dataset.id);
    if (p) p[q.key] = q.key === "price" ? value.toFixed(2) : value.toFixed(3);
    if (input.dataset.field === "weight") {
      input.closest("td").querySelector("[data-default-badge]")?.remove();
      renderWeightNotice();
    }
    setQuickState(input, `${icon("check", { size: 12 })} Saved`, "ok");
    loadEvents().catch(() => {});
  } catch (err) {
    // Undo: put the last saved value back and say why.
    input.value = original;
    input.setAttribute("aria-invalid", "true");
    setQuickState(input, `Not saved: ${escapeHTML(err.message)}`, "error");
    toast(`${q.name} not saved: ${err.message}`, "error");
  } finally {
    input.disabled = false;
    pendingSaves--;
  }
}

predRows.addEventListener("focusin", (event) => { if (event.target.dataset.field) editing = true; });
predRows.addEventListener("change", (event) => { if (event.target.dataset.field) saveQuickEdit(event.target); });
predRows.addEventListener("keydown", (event) => {
  const input = event.target;
  if (!input.dataset.field) return;
  if (event.key === "Enter") input.blur();
  if (event.key === "Escape") {
    input.value = input.dataset.original;
    input.removeAttribute("aria-invalid");
    setQuickState(input, "");
    input.blur();
  }
});
// Leaving the table: let polling redraw it again once nothing is being saved.
predRows.addEventListener("focusout", () => {
  setTimeout(() => {
    if (!predRows.contains(document.activeElement) && pendingSaves === 0) editing = false;
  }, 0);
});

/* ---------------------------------------------------------------------
   ROW ACTIONS — Edit opens the editor; "More actions" opens a small menu
   (Hide from shop). The menu is positioned against the viewport so the
   table's scroll container can't clip it.
   --------------------------------------------------------------------- */
const rowMenu = document.getElementById("rowMenu");
let rowMenuFor = null;

function closeRowMenu() {
  if (!rowMenuFor) return;
  rowMenu.hidden = true;
  const button = predRows.querySelector(`[data-more="${rowMenuFor}"]`);
  if (button) button.setAttribute("aria-expanded", "false");
  rowMenuFor = null;
}

function openRowMenu(button) {
  closeRowMenu();
  rowMenuFor = button.dataset.more;
  const p = predictions.find(x => String(x.product_id) === rowMenuFor);
  rowMenu.querySelector("[data-menu-title]").textContent = p ? p.name : "";
  rowMenu.hidden = false;
  const r = button.getBoundingClientRect();
  const w = rowMenu.offsetWidth, h = rowMenu.offsetHeight;
  rowMenu.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
  rowMenu.style.top = `${r.bottom + h + 8 > window.innerHeight ? r.top - h - 4 : r.bottom + 4}px`;
  button.setAttribute("aria-expanded", "true");
  rowMenu.querySelector("button").focus();
}

predRows.addEventListener("click", (event) => {
  const editBtn = event.target.closest("[data-edit]");
  if (editBtn) return openEditor(editBtn.dataset.edit);
  const more = event.target.closest("[data-more]");
  if (more) {
    event.stopPropagation();
    return rowMenuFor === more.dataset.more ? closeRowMenu() : openRowMenu(more);
  }
  const history = event.target.closest("[data-history]");
  if (history) {
    historyProduct.value = history.dataset.history;
    loadHistory();
    historyProduct.scrollIntoView({ behavior: "smooth", block: "center" });
  }
});

rowMenu.addEventListener("click", async (event) => {
  const action = event.target.closest("[data-menu-action]");
  if (!action || !rowMenuFor) return;
  const product = predictions.find(p => String(p.product_id) === rowMenuFor);
  closeRowMenu();
  if (action.dataset.menuAction === "hide") {
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

document.addEventListener("click", (event) => { if (!rowMenu.contains(event.target)) closeRowMenu(); });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && rowMenuFor) {
    const id = rowMenuFor;
    closeRowMenu();
    predRows.querySelector(`[data-more="${id}"]`)?.focus();
  }
});
window.addEventListener("resize", closeRowMenu);
window.addEventListener("scroll", closeRowMenu, true);

/* ---------------------------------------------------------------------
   The table scrolls sideways only when it doesn't fit; the Part column
   stays pinned and gets an edge shadow while scrolled.
   --------------------------------------------------------------------- */
const forecastWrap = document.querySelector("#forecasts .table-wrap");
function updateScrollShadow() {
  forecastWrap.classList.toggle("is-scrolled", forecastWrap.scrollLeft > 0);
}
forecastWrap.addEventListener("scroll", updateScrollShadow, { passive: true });

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
  // A finished retrain brings new forecasts and trend labels: reload them and the chart.
  MLTraining.mount(document.getElementById("modelTraining"), {
    onFinished: () => {
      lastSeenUpdate = null;
      loadStatus().then(() => loadHistory()).catch(() => {});
    }
  });
}

if (requireAdminPage()) init();
