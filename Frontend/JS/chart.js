/* =====================================================================
   chart.js — one bar chart for every admin chart (dashboard sales trend,
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

function barChart(container, points, { label = "Chart", format = (v) => String(v), axis = null, overlay = null,
                                       dayLabel = chartDate, tipLabel = dayLabel } = {}) {
  const W = Math.max(container.clientWidth, 280);
  const H = 220;
  const pad = { l: 48, r: 12, t: 16, b: 26 };
  const extra = overlay ? overlay.slots : 0;
  const slots = points.length + extra;
  const slot = (W - pad.l - pad.r) / slots;
  const barW = Math.max(1, slot - 2);                        // 2px gap between bars
  const maxY = niceMax(Math.max(1, ...points.map(p => p.value), overlay ? overlay.value : 0));
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / maxY);
  const base = y(0);
  const axisText = (v) => (axis ? axis(v) : String(Math.round(v * 10) / 10));

  const grid = [0, maxY / 2, maxY].map(v => `
    <line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/>
    <text class="axis" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${escapeHTML(axisText(v))}</text>`).join("");

  const r = Math.min(4, barW / 2);
  const bars = points.map((p, i) => {
    const x = pad.l + i * slot;
    const top = y(p.value);
    const h = base - top;
    // Rounded data-end (top), square baseline.
    const shape = h <= 0 ? `<rect class="bar" x="${x}" y="${base}" width="${barW}" height="0"/>` : h <= r
      ? `<rect class="bar" x="${x}" y="${top}" width="${barW}" height="${h}"/>`
      : `<path class="bar" d="M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${base} Z"/>`;
    return `${shape}<rect class="hit" x="${x - 1}" y="${pad.t}" width="${slot}" height="${base - pad.t}" data-i="${i}"/>`;
  }).join("");

  let overlayMark = "";
  if (overlay) {
    const x1 = pad.l + points.length * slot;
    const x2 = W - pad.r;
    overlayMark = `
      <line class="divider" x1="${x1}" x2="${x1}" y1="${pad.t}" y2="${base}"/>
      <line class="overlay-line" x1="${x1 + 2}" x2="${x2}" y1="${y(overlay.value)}" y2="${y(overlay.value)}"/>
      <text class="axis" x="${x2}" y="${y(overlay.value) - 6}" text-anchor="end">${escapeHTML(overlay.label)}</text>`;
  }

  const ticks = points.length > 1 ? [0, Math.floor(points.length / 2), points.length - 1] : [0];
  const xLabels = ticks.map(i =>
    `<text class="axis" x="${pad.l + i * slot + barW / 2}" y="${H - 8}" text-anchor="middle">${escapeHTML(dayLabel(points[i].day))}</text>`).join("");

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${escapeHTML(label)}">
      ${grid}${bars}${overlayMark}
      <line class="baseline" x1="${pad.l}" x2="${W - pad.r}" y1="${base}" y2="${base}"/>
      ${xLabels}
    </svg>
    <div class="chart-tip" hidden></div>`;

  const tip = container.querySelector(".chart-tip");
  container.querySelectorAll(".hit").forEach(hit => {
    const show = () => {
      const p = points[Number(hit.dataset.i)];
      tip.innerHTML = `<strong>${escapeHTML(format(p.value))}</strong><br>${escapeHTML(tipLabel(p.day))}`;
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
