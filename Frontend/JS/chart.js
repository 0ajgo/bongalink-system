/* =====================================================================
   chart.js — one bar chart for every admin chart (dashboard sales,
   inventory sales history). Inline SVG, single series, no library.
   Requires ui.js (escapeHTML).

     barChart(container, points, options)
       points:  [{ day: "2026-10-01", value: 12 }]   oldest first
       options: { label: "Units sold per day",       accessible name
                  format: v => `${v} units`,          tooltip text
                  axis: v => `${v}`,                  y-axis tick text (optional)
                  dayLabel: day => "Oct 13",          x-axis text (default: the date)
                  tipLabel: day => "Week of Oct 13",  tooltip text (default: dayLabel)
                  overlay: { value, slots, label } }  dashed line after the
                                                      bars (e.g. 7-day forecast)
       Optional, all off by default (the dashboard's Sales card turns them on):
                  average: true          dashed line at the mean, labelled "avg ₱4.4k/day"
                  unit: "day"            the word after the slash in that label
                  highlightMax: true     tallest bar in --color-primary, its value above it
                  dimBelowAverage: true  bars below the mean in --color-chart-soft
                  xTicks: 7              a date every 7 bars (fewer if they would collide)
                  height: 250            chart height in px (default 220)
                  detail: p => " · 3 units"  more text after the tooltip value
   Follows the dataviz rules: thin bars with a 2px gap, rounded data-end,
   square baseline, recessive grid, one series colour (CSS --color-chart),
   per-bar hover tooltip with a hit target wider than the mark. Pair it
   with chartTable() so the numbers are also available as a table.
   ===================================================================== */

const chartDate = (day) => new Date(day + "T00:00:00").toLocaleDateString("en-PH", { month: "short", day: "numeric" });

function niceMax(v) {
  if (v <= 5) return 5;
  const step = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / step) * step;
}

// Tighter rounding (1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10 × 10^k) so the tallest bar fills the chart.
const NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
function tightMax(v) {
  if (v <= 0) return 1;
  const step = Math.pow(10, Math.floor(Math.log10(v)));
  return NICE_STEPS.find(m => m * step >= v - 1e-9) * step;
}

// Rough width of an 11px axis label, for keeping labels apart.
const textWidth = (text) => String(text).length * 6.2;

function barChart(container, points, { label = "Chart", format = (v) => String(v), axis = null, overlay = null,
                                       dayLabel = chartDate, tipLabel = dayLabel, average = false, unit = "",
                                       highlightMax = false, dimBelowAverage = false, xTicks = 0, height = 220,
                                       detail = null } = {}) {
  const W = Math.max(container.clientWidth, 280);
  const H = height;
  const pad = { l: 48, r: 12, t: highlightMax ? 28 : 16, b: 26 };
  const extra = overlay ? overlay.slots : 0;
  const slots = points.length + extra;
  const slot = (W - pad.l - pad.r) / slots;
  const barW = Math.max(1, slot - 2);                        // 2px gap between bars
  const largest = Math.max(1, ...points.map(p => p.value), overlay ? overlay.value : 0);
  const maxY = average ? tightMax(largest) : niceMax(largest);
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / maxY);
  const base = y(0);
  const axisText = (v) => (axis ? axis(v) : String(Math.round(v * 10) / 10));

  const mean = points.length ? points.reduce((s, p) => s + p.value, 0) / points.length : 0;
  const maxIndex = highlightMax && points.length ? points.reduce((best, p, i) => (p.value > points[best].value ? i : best), 0) : -1;

  const gridValues = average ? [0, 0.25, 0.5, 0.75, 1].map(f => maxY * f) : [0, maxY / 2, maxY];
  const grid = gridValues.map(v => `
    <line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/>
    <text class="axis" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${escapeHTML(axisText(v))}</text>`).join("");

  const r = Math.min(4, barW / 2);
  const bars = points.map((p, i) => {
    const x = pad.l + i * slot;
    const top = y(p.value);
    const h = base - top;
    const cls = i === maxIndex ? "bar bar--peak" : dimBelowAverage && p.value < mean ? "bar bar--dim" : "bar";
    // Rounded data-end (top), square baseline.
    const shape = h <= 0 ? `<rect class="${cls}" x="${x}" y="${base}" width="${barW}" height="0"/>` : h <= r
      ? `<rect class="${cls}" x="${x}" y="${top}" width="${barW}" height="${h}"/>`
      : `<path class="${cls}" d="M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${base} Z"/>`;
    return `${shape}<rect class="hit" x="${x - 1}" y="${pad.t}" width="${slot}" height="${base - pad.t}" data-i="${i}"/>`;
  }).join("");

  // Direct label on the tallest bar, kept inside the chart's left and right edges.
  let peakMark = "", peakBox = null;
  if (maxIndex >= 0) {
    const text = axisText(points[maxIndex].value);
    const w = textWidth(text);
    const cx = Math.min(Math.max(pad.l + maxIndex * slot + barW / 2, pad.l + w / 2), W - pad.r - w / 2);
    const ty = y(points[maxIndex].value) - 6;
    peakBox = { x1: cx - w / 2, x2: cx + w / 2, y1: ty - 11, y2: ty + 2 };
    peakMark = `<text class="peak-label" x="${cx}" y="${ty}" text-anchor="middle">${escapeHTML(text)}</text>`;
  }

  // Dashed mean line with "avg ₱4.4k/day" on a white backing at its left end; the label moves
  // under the line if it would cover the tallest bar's label.
  let averageMark = "";
  if (average && points.length) {
    const ay = y(mean);
    const text = `avg ${axisText(mean)}${unit ? `/${unit}` : ""}`;
    const w = textWidth(text) + 8;
    let ly = ay - 17;
    if (peakBox && pad.l + 2 < peakBox.x2 && pad.l + 2 + w > peakBox.x1 && ly < peakBox.y2 && ly + 15 > peakBox.y1) ly = ay + 3;
    averageMark = `
      <line class="avg-line" x1="${pad.l}" x2="${W - pad.r}" y1="${ay}" y2="${ay}"/>
      <rect class="avg-label-bg" x="${pad.l + 2}" y="${ly}" width="${w}" height="15" rx="3"/>
      <text class="avg-label" x="${pad.l + 6}" y="${ly + 11}">${escapeHTML(text)}</text>`;
  }

  let overlayMark = "";
  if (overlay) {
    const x1 = pad.l + points.length * slot;
    const x2 = W - pad.r;
    overlayMark = `
      <line class="divider" x1="${x1}" x2="${x1}" y1="${pad.t}" y2="${base}"/>
      <line class="overlay-line" x1="${x1 + 2}" x2="${x2}" y1="${y(overlay.value)}" y2="${y(overlay.value)}"/>
      <text class="axis" x="${x2}" y="${y(overlay.value) - 6}" text-anchor="end">${escapeHTML(overlay.label)}</text>`;
  }

  // xTicks: a label every N bars, widened to a multiple of N when labels would touch.
  let ticks;
  if (xTicks > 0 && points.length > 1) {
    const widest = Math.max(...points.map(p => textWidth(dayLabel(p.day))));
    const every = xTicks * Math.max(1, Math.ceil((widest + 12) / (xTicks * slot)));
    ticks = [];
    for (let i = 0; i < points.length; i += every) ticks.push(i);
  } else {
    ticks = points.length > 1 ? [0, Math.floor(points.length / 2), points.length - 1] : [0];
  }
  const xLabels = ticks.map(i => {
    const text = dayLabel(points[i].day);
    const half = xTicks > 0 ? textWidth(text) / 2 : 0;
    const cx = xTicks > 0 ? Math.min(Math.max(pad.l + i * slot + barW / 2, half), W - pad.r - half) : pad.l + i * slot + barW / 2;
    return `<text class="axis" x="${cx}" y="${H - 8}" text-anchor="middle">${escapeHTML(text)}</text>`;
  }).join("");

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${escapeHTML(label)}">
      ${grid}${bars}${averageMark}${peakMark}${overlayMark}
      <line class="baseline" x1="${pad.l}" x2="${W - pad.r}" y1="${base}" y2="${base}"/>
      ${xLabels}
    </svg>
    <div class="chart-tip" hidden></div>`;

  const tip = container.querySelector(".chart-tip");
  container.querySelectorAll(".hit").forEach(hit => {
    const show = () => {
      const p = points[Number(hit.dataset.i)];
      let vsAverage = "";
      if (average && mean > 0) {
        const pct = Math.round(((p.value - mean) / mean) * 100);
        vsAverage = ` · ${pct > 0 ? "+" : ""}${pct}% vs avg`;
      }
      tip.innerHTML = `<strong>${escapeHTML(format(p.value))}</strong>${detail ? escapeHTML(detail(p)) : ""}<br>${escapeHTML(tipLabel(p.day) + vsAverage)}`;
      tip.hidden = false;
      tip.style.left = `${Number(hit.getAttribute("x")) + slot / 2}px`;
      tip.style.top = `${pad.t - 6}px`;
      hit.previousElementSibling?.classList.add("is-active");
    };
    const hide = () => {
      tip.hidden = true;
      hit.previousElementSibling?.classList.remove("is-active");
    };
    hit.addEventListener("mouseenter", show);
    hit.addEventListener("mouseleave", hide);
  });
}

// The same numbers as a table, inside a <details> under the chart.
// periodHeader / dayLabel: e.g. "Week" and day => "Week 42 · Oct 13–19" (default "Day" and the date).
function chartTable(points, { valueHeader, format, periodHeader = "Day", dayLabel = chartDate }) {
  const rows = [...points].reverse().map(p =>
    `<tr><td>${escapeHTML(dayLabel(p.day))}</td><td class="num">${escapeHTML(format(p.value))}</td></tr>`).join("");
  return `<details class="chart-table"><summary>Show as a table</summary>
    <div class="table-wrap"><table class="table"><thead><tr><th>${escapeHTML(periodHeader)}</th><th class="num">${escapeHTML(valueHeader)}</th></tr></thead>
    <tbody>${rows}</tbody></table></div></details>`;
}
