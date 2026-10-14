/* =====================================================================
   BONGALINK — ADMIN DELIVERIES (deliveries.html)
   Requires api.js and adminNav.js first.

   - Paid orders to ship:  GET  /api/v1/admin/orders/awaiting-shipment
       ship with J&T / LBC: POST /api/v1/admin/shipments/:orderId/manual
       book Lalamove:       POST /api/v1/admin/shipments/:orderId/lalamove
   - Outgoing deliveries:  GET   /api/v1/admin/shipments?status=
       update status:       PATCH /api/v1/admin/shipments/:deliveryId/status
   The server re-checks everything (admin role, order paid, not shipped
   twice); the checks here are only for instant feedback.
   ===================================================================== */

const STATUS_LABEL = {
  BOOKED: "Rider booked",
  PICKED_UP: "Handed to courier",
  IN_TRANSIT: "In transit",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  FAILED: "Failed",
  RETURNED: "Returned"
};
const STATUS_TONE = { DELIVERED: "ok", FAILED: "bad", RETURNED: "bad" };
// Statuses the admin can set by hand (the first two come from booking).
const SETTABLE = ["IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "FAILED", "RETURNED"];

const els = {
  awaiting: document.getElementById("awaitingList"),
  awaitingCount: document.getElementById("awaitingCount"),
  rows: document.getElementById("shipmentRows"),
  filter: document.getElementById("statusFilter")
};

/* ---------------------------------------------------------------------
   HELPERS
   --------------------------------------------------------------------- */
function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

const peso = (value) => Number(value).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (value) => value ? new Date(value).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }) : "—";

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function itemsList(items) {
  return `<ul class="ship-items">${items.map(i =>
    `<li>${Number(i.quantity)} × ${escapeHTML(i.name)}</li>`).join("")}</ul>`;
}

function shipTo(o) {
  return `${escapeHTML(o.ship_name)} · ${escapeHTML(o.ship_phone)}<br>
    ${escapeHTML(o.ship_address)}${o.ship_region ? ` <span class="tag tag-muted">${escapeHTML(o.ship_region)}</span>` : ""}
    ${o.ship_landmark ? `<br><span class="muted">${escapeHTML(o.ship_landmark)}</span>` : ""}`;
}

// Runs an action with its button disabled, then reloads both lists and the badge.
// successMessage is a string, or a function of the action's result.
async function act(button, work, successMessage) {
  button.disabled = true;
  try {
    const result = await work();
    showToast(typeof successMessage === "function" ? successMessage(result) : successMessage);
    await reloadAll();
  } catch (err) {
    showToast(err.message || "Something went wrong.");
    button.disabled = false;
  }
}

/* ---------------------------------------------------------------------
   PAID ORDERS TO SHIP
   --------------------------------------------------------------------- */
function lalamoveBlock(o) {
  if (o.can_book_lalamove) {
    return `<span class="or">or</span>
      <button class="btn-small${o.courier_chosen === "LALAMOVE" ? " primary" : ""}" type="button" data-lalamove="${o.order_id}">
        Book Lalamove rider</button>`;
  }
  // Customer picked Lalamove but it can't be booked now: say why instead of hiding silently.
  if (o.courier_chosen === "LALAMOVE") {
    const why = o.has_map_pin ? "Lalamove isn't configured on the server" : "the address has no map pin";
    return `<span class="muted">Customer chose Lalamove, but ${why}. Ship with J&amp;T or LBC instead.</span>`;
  }
  return "";
}

function awaitingCard(o) {
  const preset = ["JNT", "LBC"].includes(o.courier_chosen) ? o.courier_chosen : "JNT";
  return `
    <article class="ship-card" data-order="${o.order_id}">
      <div class="ship-card-head">
        <h3>Order #${o.order_id} <span class="tag tag-busy">${escapeHTML(o.order_status)}</span></h3>
        <span class="muted">Paid ${when(o.paid_at)} · Total ₱${peso(o.total_amount)}</span>
      </div>
      <div class="ship-grid">
        <div><h4>Customer</h4>${escapeHTML(o.customer_username)}<br><span class="muted">${escapeHTML(o.customer_email)}</span></div>
        <div><h4>Ship to</h4>${shipTo(o)}</div>
        <div><h4>Items</h4>${itemsList(o.items)}</div>
        <div><h4>Courier chosen</h4>${escapeHTML(o.courier_chosen_label || "—")}<br>
          <span class="muted">Shipping fee paid: ₱${peso(o.shipping_fee)}</span></div>
      </div>
      <form class="ship-actions" data-manual="${o.order_id}">
        <select name="courier" aria-label="Courier">
          <option value="JNT" ${preset === "JNT" ? "selected" : ""}>J&amp;T Express</option>
          <option value="LBC" ${preset === "LBC" ? "selected" : ""}>LBC Express</option>
        </select>
        <input class="tn" name="tracking" placeholder="Tracking / waybill no." aria-label="Tracking number"
               required pattern="[A-Za-z0-9\\-]{6,40}" title="6–40 letters, numbers or dashes">
        <input class="fee" name="fee" type="number" min="0" step="0.01" placeholder="Actual fee (opt.)" aria-label="Actual courier fee">
        <button class="btn-small primary" type="submit">Mark as shipped</button>
        ${lalamoveBlock(o)}
      </form>
    </article>`;
}

async function loadAwaiting() {
  const orders = await apiFetch("/v1/admin/orders/awaiting-shipment");
  els.awaitingCount.textContent = orders.length === 1 ? "1 order" : `${orders.length} orders`;
  els.awaiting.innerHTML = orders.length
    ? orders.map(awaitingCard).join("")
    : `<p class="empty-note">No paid orders waiting. New ones appear here as soon as PayMongo confirms the payment.</p>`;
}

els.awaiting.addEventListener("submit", (event) => {
  const form = event.target.closest("form[data-manual]");
  if (!form) return;
  event.preventDefault();
  const orderId = form.dataset.manual;
  const tracking = form.elements.tracking.value.trim();
  if (!/^[A-Za-z0-9-]{6,40}$/.test(tracking)) {
    showToast("Enter the waybill number (6–40 letters, numbers or dashes).");
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
    () => apiFetch(`/v1/admin/shipments/${orderId}/lalamove`, { method: "POST" }),
    (r) => r.fee_difference
      ? `Lalamove rider booked for order #${orderId}. The live price differs from what the customer paid by ₱${peso(r.fee_difference)}.`
      : `Lalamove rider booked for order #${orderId}.`);
});

/* ---------------------------------------------------------------------
   OUTGOING DELIVERIES
   --------------------------------------------------------------------- */
els.filter.innerHTML += Object.entries(STATUS_LABEL)
  .map(([value, label]) => `<option value="${value}">${label}</option>`).join("");

function trackingCell(d) {
  const tn = d.tracking_number ? `<br><span class="muted">${escapeHTML(d.tracking_number)}</span>` : "";
  const link = d.tracking_url
    ? `<br><a class="link" href="${escapeHTML(d.tracking_url)}" target="_blank" rel="noopener">Tracking page</a>` : "";
  return `${escapeHTML(d.courier_label)}${tn}${link}`;
}

function statusForm(d) {
  if (d.status === "DELIVERED") return `<span class="muted">Done ${when(d.delivered_at)}</span>`;
  return `
    <form class="status-form" data-delivery="${d.delivery_id}">
      <select name="status" aria-label="New status">
        ${SETTABLE.filter(s => s !== d.status).map(s => `<option value="${s}">${STATUS_LABEL[s]}</option>`).join("")}
      </select>
      <input name="note" maxlength="255" placeholder="Note (optional)" aria-label="Note">
      <button class="btn-small" type="submit">Update</button>
    </form>`;
}

function shipmentRow(d) {
  const fee = d.fee_actual !== null && d.fee_actual !== undefined
    ? `${peso(d.fee_charged)}<br><span class="muted">actual ${peso(d.fee_actual)}</span>`
    : peso(d.fee_charged);
  return `
    <tr>
      <td>#${d.order_id}<br><span class="muted">${escapeHTML(d.customer_username)}</span></td>
      <td>${shipTo(d)}</td>
      <td>${itemsList(d.items)}</td>
      <td>${trackingCell(d)}</td>
      <td class="num">${fee}</td>
      <td><span class="ship-pill ${STATUS_TONE[d.status] || "busy"}">${STATUS_LABEL[d.status] || escapeHTML(d.status)}</span>
          <br><span class="muted">${when(d.updated_at)}</span></td>
      <td>${statusForm(d)}</td>
    </tr>`;
}

async function loadShipments() {
  const status = els.filter.value;
  const rows = await apiFetch(`/v1/admin/shipments${status ? `?status=${encodeURIComponent(status)}` : ""}`);
  els.rows.innerHTML = rows.length
    ? rows.map(shipmentRow).join("")
    : `<tr><td colspan="7" class="empty-note">No deliveries${status ? ` with status "${STATUS_LABEL[status]}"` : " yet"}.</td></tr>`;
}

els.filter.addEventListener("change", () => loadShipments().catch(err => showToast(err.message)));

els.rows.addEventListener("submit", (event) => {
  const form = event.target.closest("form[data-delivery]");
  if (!form) return;
  event.preventDefault();
  const status = form.elements.status.value;
  if (status === "DELIVERED" && !confirm("Mark this delivery as delivered? The customer is emailed and it can't be changed afterwards.")) return;
  const body = { status, note: form.elements.note.value.trim() || undefined };
  act(form.querySelector("button"),
    () => apiFetch(`/v1/admin/shipments/${form.dataset.delivery}/status`, { method: "PATCH", body: JSON.stringify(body) }),
    `Status updated to "${STATUS_LABEL[status]}".`);
});

/* ---------------------------------------------------------------------
   INIT
   --------------------------------------------------------------------- */
async function reloadAll() {
  await Promise.all([loadAwaiting(), loadShipments(), refreshToShipBadge()]);
}

document.getElementById("refreshBtn").addEventListener("click", () => reloadAll().catch(err => showToast(err.message)));

async function init() {
  if (!isAdmin()) {
    document.getElementById("locked").hidden = false;
    return;
  }
  document.getElementById("dashboard").hidden = false;
  try {
    await reloadAll();
  } catch (err) {
    showToast(err.message || "Could not reach the API.");
  }
}

init();
