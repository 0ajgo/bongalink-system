/* Admin › Deliveries: three tabs — To pack, Ready to ship, Outgoing.
   Requires api.js, icons.js, cart.js and ui.js. The checks here only give
   instant feedback; the server checks everything again. */

renderHeader({ active: "deliveries" });

const DELIVERY_STATUSES = ["BOOKED", "PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "FAILED", "RETURNED"];
// Statuses the admin can set by hand (the first two come from booking).
const SETTABLE = ["IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "FAILED", "RETURNED"];
const COURIER_NAME = { JNT: "J&T Express", LBC: "LBC Express", LALAMOVE: "Lalamove" };

const els = {
  tabs: [...document.querySelectorAll(".pipe__tab")],
  packRows: document.getElementById("packRows"),
  shipList: document.getElementById("shipList"),
  rows: document.getElementById("shipmentRows"),
  filter: document.getElementById("statusFilter"),
  count: { pack: document.getElementById("countPack"), ship: document.getElementById("countShip"), out: document.getElementById("countOut") }
};

const itemsList = (items) =>
  `<ul class="ship-items">${items.map(i => `<li>${Number(i.quantity)} × ${escapeHTML(i.name)}</li>`).join("")}</ul>`;

function shipTo(o) {
  return `${escapeHTML(o.ship_name)} · ${escapeHTML(o.ship_phone)}<br>
    ${escapeHTML(o.ship_address)}${o.ship_region ? ` <span class="badge">${escapeHTML(o.ship_region)}</span>` : ""}
    ${o.ship_landmark ? `<br><span class="muted">${escapeHTML(o.ship_landmark)}</span>` : ""}`;
}

function setCount(key, n, noun) {
  els.count[key].textContent = n;
  els.count[key].setAttribute("aria-label", `${n} ${noun}${n === 1 ? "" : "s"}`);
}

/* ---------------------------------------------------------------------
   Tabs
   --------------------------------------------------------------------- */
function showTab(name, { focus = false } = {}) {
  for (const tab of els.tabs) {
    const on = tab.dataset.tab === name;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    document.getElementById(tab.getAttribute("aria-controls")).hidden = !on;
    if (on && focus) tab.focus();
  }
}

els.tabs.forEach((tab, i) => {
  tab.addEventListener("click", () => showTab(tab.dataset.tab));
  tab.addEventListener("keydown", (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    showTab(els.tabs[(i + step + els.tabs.length) % els.tabs.length].dataset.tab, { focus: true });
  });
});

// Runs an action with its button busy, then reloads every list and the badge.
// successMessage is a string, or a function of the action's result.
async function act(button, work, successMessage) {
  button.disabled = true;
  button.classList.add("is-loading");
  try {
    const result = await work();
    toast(typeof successMessage === "function" ? successMessage(result) : successMessage, "success");
    await reloadAll();
  } catch (err) {
    toast(err.message || "Something went wrong.", "error");
    button.disabled = false;
    button.classList.remove("is-loading");
  }
}

/* ---------------------------------------------------------------------
   1. TO PACK
   --------------------------------------------------------------------- */
function packRow(o) {
  return `
    <tr data-order="${o.order_id}">
      <td><strong>#${o.order_id}</strong><br><span class="muted">Paid ${formatDateTime(o.paid_at)}</span></td>
      <td>${itemsList(o.items)}</td>
      <td>${escapeHTML(o.ship_name)}${o.ship_city ? `<br><span class="muted">${escapeHTML(o.ship_city)}</span>` : ""}</td>
      <td>${escapeHTML(o.courier_chosen_label || "—")}</td>
      <td class="num"><button class="btn btn--accent btn--sm" type="button" data-pack="${o.order_id}">
        ${icon("package", { size: 16 })} Mark as packed</button></td>
    </tr>`;
}

els.packRows.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-pack]");
  if (!button) return;
  const orderId = button.dataset.pack;
  act(button,
    () => apiFetch(`/v1/admin/orders/${orderId}/packed`, { method: "POST" }),
    `Order #${orderId} packed — moved to Ready to ship.`);
});

/* ---------------------------------------------------------------------
   2. READY TO SHIP — one action box, for the courier the customer chose
   --------------------------------------------------------------------- */
function manualForm(o, { hidden = false } = {}) {
  const preset = o.courier_chosen === "LBC" ? "LBC" : "JNT";
  return `
    <form class="ship-actions" data-manual="${o.order_id}" novalidate ${hidden ? "hidden" : ""}>
      <div class="field">
        <label class="label" for="courier-${o.order_id}">Courier</label>
        <select class="select" id="courier-${o.order_id}" name="courier">
          <option value="JNT" ${preset === "JNT" ? "selected" : ""}>J&amp;T Express</option>
          <option value="LBC" ${preset === "LBC" ? "selected" : ""}>LBC Express</option>
        </select>
      </div>
      <div class="field">
        <label class="label" for="tracking-${o.order_id}">Tracking / waybill no.</label>
        <input class="input tn" id="tracking-${o.order_id}" name="tracking" autocomplete="off">
      </div>
      <div class="field">
        <label class="label" for="fee-${o.order_id}">Fee paid to courier <span class="optional">(optional)</span></label>
        <input class="input fee" id="fee-${o.order_id}" name="fee" type="number" min="0" step="0.01">
      </div>
      <button class="btn btn--primary" type="submit">Mark as shipped</button>
    </form>`;
}

function actionBox(o) {
  if (o.courier_chosen === "LALAMOVE" && o.can_book_lalamove) {
    return `
      <p class="act-box__title">${icon("truck", { size: 16 })} Lalamove — the system books the rider for you</p>
      <button class="btn btn--primary" type="button" data-lalamove="${o.order_id}">${icon("truck", { size: 18 })} Book Lalamove rider</button>
      <p class="act-box__note">Status updates arrive from Lalamove automatically.
        <button class="link-button" type="button" data-show-manual="${o.order_id}">Ship with J&amp;T/LBC instead</button></p>
      ${manualForm(o, { hidden: true })}`;
  }
  if (o.courier_chosen === "LALAMOVE") {
    // Lalamove can't be booked now: say why, and offer J&T/LBC instead.
    const why = o.has_map_pin ? "Lalamove isn't configured on the server" : "the address has no map pin";
    return `
      <p class="act-box__note act-box__note--warn">Customer chose Lalamove, but ${why}. Ship with J&amp;T or LBC instead.</p>
      ${manualForm(o)}`;
  }
  const name = COURIER_NAME[o.courier_chosen] || "J&T Express or LBC Express";
  return `
    <p class="act-box__title">${icon("truck", { size: 16 })} ${escapeHTML(name)} — book at the branch, then enter the waybill</p>
    ${manualForm(o)}`;
}

function shipRow(o) {
  return `
    <article class="ship-row" data-order="${o.order_id}">
      <div>
        <h3 class="ship-row__title">#${o.order_id} ${statusBadge(o.order_status)}</h3>
        <span class="muted">Packed ${formatDateTime(o.packed_at)}</span>
        ${itemsList(o.items)}
      </div>
      <div>
        <h4 class="ship-row__label">Ship to</h4>
        ${shipTo(o)}
        <p class="muted">Shipping fee paid: ${formatMoney(o.shipping_fee)}</p>
      </div>
      <div class="act-box">${actionBox(o)}</div>
    </article>`;
}

els.shipList.addEventListener("submit", (event) => {
  const form = event.target.closest("form[data-manual]");
  if (!form) return;
  event.preventDefault();
  const orderId = form.dataset.manual;
  const tracking = form.elements.tracking.value.trim();
  if (!/^[A-Za-z0-9-]{6,40}$/.test(tracking)) {
    form.elements.tracking.setAttribute("aria-invalid", "true");
    toast("Enter the waybill number (6–40 letters, numbers or dashes).", "error");
    form.elements.tracking.focus();
    return;
  }
  const body = { courier: form.elements.courier.value, tracking_number: tracking };
  if (form.elements.fee.value !== "") body.fee_actual = Number(form.elements.fee.value);

  act(form.querySelector("button[type=submit]"),
    () => apiFetch(`/v1/admin/shipments/${orderId}/manual`, { method: "POST", body: JSON.stringify(body) }),
    `Order #${orderId} marked as shipped. The customer was emailed the tracking details.`);
});

els.shipList.addEventListener("click", (event) => {
  const reveal = event.target.closest("button[data-show-manual]");
  if (reveal) {
    const form = els.shipList.querySelector(`form[data-manual="${reveal.dataset.showManual}"]`);
    form.hidden = false;
    reveal.hidden = true;
    form.elements.tracking.focus();
    return;
  }
  const button = event.target.closest("button[data-lalamove]");
  if (!button) return;
  const orderId = button.dataset.lalamove;
  if (!confirm(`Book a Lalamove rider for order #${orderId}? The live Lalamove price is charged to the shop's Lalamove wallet.`)) return;
  act(button,
    () => apiFetch(`/v1/admin/shipments/${orderId}/lalamove`, { method: "POST", timeout: API_TIMEOUT_CHAT_MS }),
    (r) => r.fee_difference
      ? `Lalamove rider booked for order #${orderId}. The live price differs from what the customer paid by ${formatMoney(r.fee_difference)}.`
      : `Lalamove rider booked for order #${orderId}.`);
});

async function loadAwaiting() {
  const orders = await apiFetch("/v1/admin/orders/awaiting-shipment");
  const toPack = orders.filter(o => o.order_status === "paid");
  const toShip = orders.filter(o => o.order_status === "packed");
  setCount("pack", toPack.length, "order");
  setCount("ship", toShip.length, "order");
  els.packRows.innerHTML = toPack.length
    ? toPack.map(packRow).join("")
    : `<tr><td colspan="5">${UIState.empty({ icon: "package-open", title: "Nothing to pack",
        text: "New paid orders appear here as soon as PayMongo confirms the payment." })}</td></tr>`;
  els.shipList.innerHTML = toShip.length
    ? toShip.map(shipRow).join("")
    : UIState.empty({ icon: "truck", title: "Nothing ready to ship", text: "Orders appear here once they are marked as packed." });
}

/* ---------------------------------------------------------------------
   3. OUTGOING
   --------------------------------------------------------------------- */
els.filter.innerHTML += DELIVERY_STATUSES.map(s => `<option value="${s}">${STATUS[s]}</option>`).join("");

function trackingCell(d) {
  const tn = d.tracking_number ? `<br><span class="muted">${escapeHTML(d.tracking_number)}</span>` : "";
  const link = d.tracking_url
    ? `<br><a href="${escapeHTML(d.tracking_url)}" target="_blank" rel="noopener">${icon("external-link", { size: 14 })} Tracking page</a>` : "";
  return `${escapeHTML(d.courier_label)}${tn}${link}`;
}

function statusForm(d) {
  if (d.status === "DELIVERED") return `<span class="muted">Done ${formatDateTime(d.delivered_at)}</span>`;
  if (d.courier === "LALAMOVE") return `<span class="muted">Updates automatically from Lalamove</span>`;
  return `
    <form class="status-form" data-delivery="${d.delivery_id}" novalidate>
      <label class="sr-only" for="status-${d.delivery_id}">New status</label>
      <select class="select" id="status-${d.delivery_id}" name="status">
        ${SETTABLE.filter(s => s !== d.status).map(s => `<option value="${s}">${STATUS[s]}</option>`).join("")}
      </select>
      <label class="sr-only" for="note-${d.delivery_id}">Note</label>
      <input class="input" id="note-${d.delivery_id}" name="note" maxlength="255" placeholder="Note (optional)">
      <button class="btn btn--secondary btn--sm" type="submit">Update</button>
    </form>`;
}

function shipmentRow(d) {
  const fee = d.fee_actual !== null && d.fee_actual !== undefined
    ? `${formatMoney(d.fee_charged)}<br><span class="muted">actual ${formatMoney(d.fee_actual)}</span>`
    : formatMoney(d.fee_charged);
  return `
    <tr>
      <td><strong>#${d.order_id}</strong><br><span class="muted">${escapeHTML(d.customer_username)}</span></td>
      <td>${shipTo(d)}</td>
      <td>${itemsList(d.items)}</td>
      <td>${trackingCell(d)}</td>
      <td class="num">${fee}</td>
      <td>${statusBadge(d.status)}<br><span class="muted">${formatDateTime(d.updated_at)}</span></td>
      <td>${statusForm(d)}</td>
    </tr>`;
}

async function loadShipments() {
  const status = els.filter.value;
  const rows = await apiFetch(`/v1/admin/shipments${status ? `?status=${encodeURIComponent(status)}` : ""}`);
  setCount("out", rows.length, "delivery");
  els.rows.innerHTML = rows.length
    ? rows.map(shipmentRow).join("")
    : `<tr><td colspan="7">${UIState.empty({ icon: "truck", title: status ? `No deliveries "${STATUS[status]}"` : "No deliveries yet",
        text: status ? "Try another status." : "Shipped orders appear here." })}</td></tr>`;
}

els.filter.addEventListener("change", () => loadShipments().catch(err => toast(err.message, "error")));

els.rows.addEventListener("submit", (event) => {
  const form = event.target.closest("form[data-delivery]");
  if (!form) return;
  event.preventDefault();
  const status = form.elements.status.value;
  if (status === "DELIVERED" && !confirm("Mark this delivery as delivered? The customer is emailed and it can't be changed afterwards.")) return;
  const body = { status, note: form.elements.note.value.trim() || undefined };
  act(form.querySelector("button"),
    () => apiFetch(`/v1/admin/shipments/${form.dataset.delivery}/status`, { method: "PATCH", body: JSON.stringify(body) }),
    `Status updated to "${STATUS[status]}".`);
});

/* ---------------------------------------------------------------------
   INIT
   --------------------------------------------------------------------- */
async function reloadAll() {
  await Promise.all([loadAwaiting(), loadShipments(), refreshToShipBadge()]);
}

async function init() {
  els.packRows.innerHTML = UIState.rowSkeletons(5, 2);
  els.shipList.innerHTML = `<table class="table"><tbody>${UIState.rowSkeletons(3, 2)}</tbody></table>`;
  els.rows.innerHTML = UIState.rowSkeletons(7, 3);
  try {
    await reloadAll();
  } catch (err) {
    els.packRows.innerHTML = `<tr><td colspan="5">${UIState.error(err.message, "retryDeliveries")}</td></tr>`;
    els.shipList.innerHTML = "";
    els.rows.innerHTML = "";
    document.getElementById("retryDeliveries").addEventListener("click", init);
  }
}

document.getElementById("refreshBtn").addEventListener("click", () => reloadAll().catch(err => toast(err.message, "error")));
if (requireAdminPage()) init();
