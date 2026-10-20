/* =====================================================================
   BONGALINK — ADMIN DELIVERIES (Pages/Admin/deliveries.html)
   Requires api.js, icons.js, cart.js and ui.js.

   - Paid orders to ship:  GET  /api/v1/admin/orders/awaiting-shipment
       ship with J&T / LBC: POST /api/v1/admin/shipments/:orderId/manual
       book Lalamove:       POST /api/v1/admin/shipments/:orderId/lalamove
   - Outgoing deliveries:  GET   /api/v1/admin/shipments?status=
       update status:       PATCH /api/v1/admin/shipments/:deliveryId/status
   The server re-checks everything (admin role, order paid, not shipped
   twice); the checks here are only for instant feedback.
   ===================================================================== */

renderHeader({ active: "deliveries" });

const DELIVERY_STATUSES = ["BOOKED", "PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "FAILED", "RETURNED"];
// Statuses the admin can set by hand (the first two come from booking).
const SETTABLE = ["IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "FAILED", "RETURNED"];

const els = {
  awaiting: document.getElementById("awaitingList"),
  awaitingCount: document.getElementById("awaitingCount"),
  rows: document.getElementById("shipmentRows"),
  filter: document.getElementById("statusFilter")
};

const itemsList = (items) =>
  `<ul class="ship-items">${items.map(i => `<li>${Number(i.quantity)} × ${escapeHTML(i.name)}</li>`).join("")}</ul>`;

function shipTo(o) {
  return `${escapeHTML(o.ship_name)} · ${escapeHTML(o.ship_phone)}<br>
    ${escapeHTML(o.ship_address)}${o.ship_region ? ` <span class="badge">${escapeHTML(o.ship_region)}</span>` : ""}
    ${o.ship_landmark ? `<br><span class="muted">${escapeHTML(o.ship_landmark)}</span>` : ""}`;
}

// Runs an action with its button busy, then reloads both lists and the badge.
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
   PAID ORDERS TO SHIP
   --------------------------------------------------------------------- */
function lalamoveBlock(o) {
  if (o.can_book_lalamove) {
    return `<button class="btn ${o.courier_chosen === "LALAMOVE" ? "btn--primary" : "btn--secondary"}" type="button" data-lalamove="${o.order_id}">
      ${icon("truck", { size: 18 })} Book Lalamove rider</button>`;
  }
  // Customer picked Lalamove but it can't be booked now: say why instead of hiding silently.
  if (o.courier_chosen === "LALAMOVE") {
    const why = o.has_map_pin ? "Lalamove isn't configured on the server" : "the address has no map pin";
    return `<p class="muted">Customer chose Lalamove, but ${why}. Ship with J&amp;T or LBC instead.</p>`;
  }
  return "";
}

function awaitingCard(o) {
  const preset = ["JNT", "LBC"].includes(o.courier_chosen) ? o.courier_chosen : "JNT";
  return `
    <article class="card ship-card" data-order="${o.order_id}">
      <div class="card__header">
        <h3>Order #${o.order_id} ${statusBadge(o.order_status)}</h3>
        <span class="muted">Paid ${formatDateTime(o.paid_at)} · Total <span class="price">${formatMoney(o.total_amount)}</span></span>
      </div>
      <div class="card__body ship-grid">
        <div><h4>Customer</h4>${escapeHTML(o.customer_username)}<br><span class="muted">${escapeHTML(o.customer_email)}</span></div>
        <div><h4>Ship to</h4>${shipTo(o)}</div>
        <div><h4>Items</h4>${itemsList(o.items)}</div>
        <div><h4>Courier chosen</h4>${escapeHTML(o.courier_chosen_label || "—")}<br>
          <span class="muted">Shipping fee paid: ${formatMoney(o.shipping_fee)}</span></div>
      </div>
      <form class="card__footer ship-actions" data-manual="${o.order_id}" novalidate>
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
          <label class="label" for="fee-${o.order_id}">Actual fee <span class="optional">(optional)</span></label>
          <input class="input fee" id="fee-${o.order_id}" name="fee" type="number" min="0" step="0.01">
        </div>
        <button class="btn btn--primary" type="submit">Mark as shipped</button>
        ${lalamoveBlock(o)}
      </form>
    </article>`;
}

async function loadAwaiting() {
  const orders = await apiFetch("/v1/admin/orders/awaiting-shipment");
  els.awaitingCount.textContent = orders.length === 1 ? "1 order" : `${orders.length} orders`;
  els.awaiting.innerHTML = orders.length
    ? orders.map(awaitingCard).join("")
    : `<div class="card">${UIState.empty({ icon: "package-open", title: "No paid orders waiting",
        text: "New ones appear here as soon as PayMongo confirms the payment." })}</div>`;
}

els.awaiting.addEventListener("submit", (event) => {
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

els.awaiting.addEventListener("click", (event) => {
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

/* ---------------------------------------------------------------------
   OUTGOING DELIVERIES
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
  els.awaiting.innerHTML = `<div class="card"><table class="table"><tbody>${UIState.rowSkeletons(4, 2)}</tbody></table></div>`;
  els.rows.innerHTML = UIState.rowSkeletons(7, 3);
  try {
    await reloadAll();
  } catch (err) {
    els.awaiting.innerHTML = `<div class="card">${UIState.error(err.message, "retryDeliveries")}</div>`;
    els.rows.innerHTML = "";
    document.getElementById("retryDeliveries").addEventListener("click", init);
  }
}

document.getElementById("refreshBtn").addEventListener("click", () => reloadAll().catch(err => toast(err.message, "error")));
if (requireAdminPage()) init();
