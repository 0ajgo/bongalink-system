/* =====================================================================
   forecast-ui.js — how the 7-day forecasts look on the Dashboard
   ("Forecast" card) and Inventory ("Forecast by part" table).
   Requires icons.js and ui.js (escapeHTML). Display only: every number
   is shown as the forecast list gives it.

     forecastGroup(p)        the row's status group ("reorder", "soon", "nodata", "healthy"), null if not scored yet
     statusTiles(rows, { selected, buttons })   the 4 count tiles
     stockVsDemand(p, scaleMax)   bullet bar: stock on hand vs 7-day demand
     runwayBar(p)            how many days the stock lasts, 0–30 day scale
     actionPill(p)           Out · reorder / Reorder / Category estimate / OK
     trendPill(p)            ↑ Rising / ↓ Falling / → Steady / Not enough data
   Status is never colour alone: every tile and pill has an icon and text.
   ===================================================================== */

const RUNWAY_DAYS = 30;   // the runway bar's full width
const RUNWAY_SOON = 7;    // its tick, and the "runs out within 7 days" line

// Tile order. Each scored part is in exactly one group, so the four counts add up to the
// number of forecast parts; parts not scored yet are in none.
const FORECAST_GROUPS = [
  { key: "reorder", label: "Reorder now", tone: "error", mark: () => icon("triangle-alert", { size: 14 }) },
  { key: "soon", label: "Runs out within 7 days", tone: "warning", mark: () => icon("clock", { size: 14 }) },
  { key: "healthy", label: "Healthy", tone: "success", mark: () => icon("check", { size: 14 }) },
  { key: "nodata", label: "Not enough data", tone: "neutral", mark: () => `<span aria-hidden="true">…</span>` }
];

const hasDays = (p) => p.days_until_stockout !== null && p.days_until_stockout !== undefined;
const isOut = (p) => Number(p.available) <= 0;
const needsReorder = (p) => isOut(p) || Number(p.reorder_recommended) > 0;
// 17 -> "17", 4.72 -> "4.7", 0.04 -> "<0.1", 0 or below -> "0"
function units1(v) {
  const n = Number(v);
  if (!(n > 0)) return "0";
  return n < 0.05 ? "<0.1" : n.toFixed(1).replace(/\.0$/, "");
}

// The first group that matches: Reorder now, Runs out within 7 days, Not enough data, else Healthy
// (including parts with stock and no expected demand).
function forecastGroup(p) {
  if (!p.computed_at) return null;
  if (needsReorder(p)) return "reorder";
  if (p.data_status === "ok" && hasDays(p) && Number(p.days_until_stockout) < RUNWAY_SOON) return "soon";
  if (p.data_status === "insufficient_data") return "nodata";
  return "healthy";
}

function groupCounts(rows) {
  const counts = Object.fromEntries(FORECAST_GROUPS.map(g => [g.key, 0]));
  rows.forEach(p => { const k = forecastGroup(p); if (k) counts[k]++; });
  return counts;
}

// In stock, but the forecast expects no sales: there is no stock-out date.
const noDemand = (p) => p.computed_at && !isOut(p) && !(Number(p.predicted_demand_7d) > 0)
  && (!hasDays(p) || Number(p.days_until_stockout) === 0);

// buttons: true on Inventory, where a tile filters the table (aria-pressed shows the filter).
function statusTiles(rows, { selected = null, buttons = false } = {}) {
  const counts = groupCounts(rows);
  return FORECAST_GROUPS.map(g => {
    const body = `<span class="fc-tile__count">${counts[g.key]}</span>
      <span class="fc-tile__label">${g.mark()} ${escapeHTML(g.label)}</span>`;
    return buttons
      ? `<button type="button" class="fc-tile fc-tile--${g.tone}" data-group="${g.key}" aria-pressed="${selected === g.key}"
           title="${selected === g.key ? "Show all parts" : "Show only these parts"}">${body}</button>`
      : `<div class="fc-tile fc-tile--${g.tone}" data-group="${g.key}">${body}</div>`;
  }).join("");
}

function stockVsDemand(p, scaleMax) {
  const stock = Number(p.stock_quantity) || 0;
  const pct = (v) => (scaleMax > 0 ? Math.min(100, (v / scaleMax) * 100) : 0);
  const held = Number(p.reserved) > 0 ? ` · <span title="Held by unpaid orders">${escapeHTML(p.reserved)} held</span>` : "";
  const scored = p.computed_at && p.predicted_demand_7d !== null && p.predicted_demand_7d !== undefined;
  const demand = scored ? Math.max(0, Number(p.predicted_demand_7d)) : null;
  let text = `${escapeHTML(stock)} on hand`;
  if (!p.computed_at) text += ` · <span class="muted">Pending…</span>`;
  else if (demand !== null) {
    text += ` · ${p.data_status === "insufficient_data" ? "~" : ""}${escapeHTML(units1(demand))} needed`;
    // "short" only when it is at least 0.1 unit, never "short 0"
    if (demand - stock >= 0.05) text += ` · <strong class="svd__short">short ${escapeHTML(units1(demand - stock))}</strong>`;
  }
  return `<div class="svd">
      <div class="svd__bars" aria-hidden="true">
        <span class="svd__have" style="width:${pct(stock)}%"></span>
        ${demand !== null ? `<span class="svd__need" style="left:${pct(demand)}%"></span>` : ""}
      </div>
      <span class="svd__text">${text}${held}</span>
    </div>`;
}

function runwayBar(p) {
  const days = p.computed_at && hasDays(p) ? Number(p.days_until_stockout) : null;
  let tone = "none", text = `<span class="muted">—</span>`;
  if (isOut(p)) {
    tone = "short";
    text = `<strong class="runway__out">Out</strong>`;
  } else if (noDemand(p)) {
    text = `<span class="muted">No sales expected</span>`;
  } else if (days !== null) {
    tone = days < RUNWAY_SOON ? "short" : days < 14 ? "mid" : "long";
    text = `${escapeHTML(units1(days))} days${p.data_status === "ok" ? "" : "*"}`;
  }
  const fill = days === null || isOut(p) || noDemand(p) ? 0 : Math.min(100, (days / RUNWAY_DAYS) * 100);
  return `<div class="runway runway--${tone}">
      <span class="runway__track" aria-hidden="true">
        <span class="runway__fill" style="width:${fill}%"></span>
        <span class="runway__tick" style="left:${(RUNWAY_SOON / RUNWAY_DAYS) * 100}%"></span>
      </span>
      <span class="runway__text">${text}</span>
    </div>`;
}

const pill = (tone, mark, text, title = "") =>
  `<span class="pill pill--${tone}"${title ? ` title="${escapeHTML(title)}"` : ""}>${mark}${escapeHTML(text)}</span>`;

function actionPill(p) {
  // available = on hand minus units held by unpaid orders
  if (isOut(p)) {
    const qty = Number(p.suggested_reorder_qty) || 0;
    const held = Number(p.reserved) > 0 ? `${p.reserved} held by unpaid orders` : "";
    return pill("error", icon("x", { size: 12 }), p.computed_at && qty > 0 ? `Out · reorder ${qty}` : "Out of stock", held);
  }
  if (!p.computed_at) return "";
  if (Number(p.reorder_recommended) > 0) return pill("warning", icon("triangle-alert", { size: 12 }), `Reorder ${p.suggested_reorder_qty}`);
  if (p.data_status === "insufficient_data") {
    const source = { category_average: "category avg", store_average: "store avg" }[p.forecast_source] || "no estimate";
    return pill("neutral", icon("info", { size: 12 }), "Category estimate", `Listed ${p.history_days} day(s) ago; showing the ${source}`);
  }
  return pill("success", icon("check", { size: 12 }), "OK");
}

function trendPill(p) {
  if (!p.computed_at) return "";
  if (p.trend_status !== "ok") {
    return pill("neutral", icon("info", { size: 12 }), "Not enough data",
      "A trend needs 84 days of history and sales on at least 8 different days in that period");
  }
  const since = `${p.trend_days_since_breakpoint} days ago`;
  if (p.trend_direction === "upward") return pill("up", icon("arrow-up", { size: 12 }), "Rising", `Rising since ${since}`);
  if (p.trend_direction === "downward") return pill("down", icon("arrow-down", { size: 12 }), "Falling", `Falling since ${since}`);
  return pill("neutral", `<span aria-hidden="true">→</span>`, "Steady", "No shift in demand detected in the last 84 days");
}
