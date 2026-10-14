/* =====================================================================
   BONGALINK — MY ORDERS (Pages/COpage/orders.html)
   Requires api.js first.
   - GET  /api/orders                  this customer's orders + items
   - GET  /api/v1/orders/:id/tracking  courier, tracking no./link, timeline
   - POST /api/v1/payments/checkout    "Pay now" for an unpaid order
   ===================================================================== */

if (!isLoggedIn()) {
  window.location.href = "../Homepage/login.html";
}

const ORDER_STATUS = {
  pending_payment: { label: "Waiting for payment", tone: "" },
  paid:            { label: "Paid — preparing your parcel", tone: "" },
  packed:          { label: "Packed", tone: "" },
  shipped:         { label: "Shipped", tone: "" },
  delivered:       { label: "Delivered", tone: "ok" },
  expired:         { label: "Expired — not paid in 24 hours", tone: "muted" },
  cancelled:       { label: "Cancelled", tone: "bad" },
  // statuses from before online payment
  pending:         { label: "Pending", tone: "muted" },
  processing:      { label: "Processing", tone: "" },
  completed:       { label: "Completed", tone: "ok" }
};

const DELIVERY_STATUS = {
  BOOKED: "Rider booked",
  PICKED_UP: "Handed to the courier",
  IN_TRANSIT: "In transit",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  FAILED: "Delivery failed",
  RETURNED: "Returned to the shop"
};

const COURIER = { JNT: "J&T Express", LBC: "LBC Express", LALAMOVE: "Lalamove" };
const TRACKABLE = ["shipped", "delivered"];

const ordersEl = document.getElementById("orders");
const errorEl = document.getElementById("orders-error");

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

const peso = (value) => new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(value);
const when = (value) => new Date(value).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" });
const orderRef = (order) => `BGL-${new Date(order.created_at).getFullYear()}-${String(order.order_id).padStart(4, "0")}`;

function statusPill(status) {
  const s = ORDER_STATUS[status] || { label: status, tone: "muted" };
  return `<span class="status${s.tone ? ` status--${s.tone}` : ""}">${escapeHTML(s.label)}</span>`;
}

function orderCard(order) {
  const items = (order.items || []).map(i =>
    `<li>${Number(i.quantity)} × ${escapeHTML(i.name)}</li>`).join("");
  const courier = order.courier ? ` · ${COURIER[order.courier] || escapeHTML(order.courier)}` : "";
  return `
    <article class="order" data-order="${order.order_id}">
      <div class="order__head">
        <span class="order__ref">${orderRef(order)}</span>
        ${statusPill(order.status)}
      </div>
      <p class="order__meta">Placed ${when(order.created_at)}${courier}${order.paid_at ? ` · Paid ${when(order.paid_at)}` : ""}</p>
      <ul class="order__items">${items}</ul>
      <div class="order__total"><span>Shipping ${peso(order.shipping_fee)}</span><b>Total ${peso(order.total_amount)}</b></div>
      ${order.status === "pending_payment"
        ? `<button class="button" type="button" data-pay="${order.order_id}">Pay now</button>` : ""}
      <div class="tracking" data-tracking="${order.order_id}" hidden></div>
    </article>`;
}

function trackingBlock(t) {
  const link = t.tracking_url
    ? ` · <a href="${escapeHTML(t.tracking_url)}" target="_blank" rel="noopener">Track on the courier's site</a>` : "";
  const number = t.tracking_number ? `Tracking no. <b>${escapeHTML(t.tracking_number)}</b>` : "No tracking number";
  // Newest first, so the current status is at the top.
  const events = [...t.events].reverse().map((e, i) => `
    <li class="${i === 0 ? "is-latest" : ""}">
      <div class="timeline__status">${escapeHTML(DELIVERY_STATUS[e.status] || e.status)}</div>
      <div class="timeline__time">${when(e.created_at)}</div>
      ${e.note ? `<div class="timeline__note">${escapeHTML(e.note)}</div>` : ""}
    </li>`).join("");
  return `
    <h3>${escapeHTML(t.courier_label || COURIER[t.courier] || t.courier)}</h3>
    <p class="tracking__id">${number}${link}</p>
    <ol class="timeline">${events}</ol>`;
}

async function loadTracking(orderId) {
  const slot = ordersEl.querySelector(`[data-tracking="${orderId}"]`);
  try {
    const t = await apiFetch(`/v1/orders/${orderId}/tracking`);
    slot.innerHTML = trackingBlock(t);
    slot.hidden = false;
  } catch (err) {
    if (err.status !== 404) {   // 404 = not handed to a courier yet
      slot.innerHTML = `<p class="field__error">Couldn't load tracking: ${escapeHTML(err.message)}</p>`;
      slot.hidden = false;
    }
  }
}

async function loadOrders() {
  try {
    const orders = await apiFetch("/orders");
    ordersEl.innerHTML = orders.length
      ? orders.map(orderCard).join("")
      : `<div class="empty"><p>You haven't placed any orders yet.</p>
           <a class="button" href="../Homepage/homepage.html">Browse the catalog</a></div>`;
    await Promise.all(orders.filter(o => TRACKABLE.includes(o.status)).map(o => loadTracking(o.order_id)));
  } catch (err) {
    ordersEl.innerHTML = "";
    errorEl.textContent = err.message || "Could not load your orders.";
  }
}

ordersEl.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-pay]");
  if (!button) return;
  button.disabled = true;
  button.textContent = "Opening PayMongo…";
  try {
    const { checkout_url } = await apiFetch("/v1/payments/checkout", {
      method: "POST", body: JSON.stringify({ order_id: Number(button.dataset.pay) })
    });
    window.location.href = checkout_url;
  } catch (err) {
    errorEl.textContent = err.message;
    button.disabled = false;
    button.textContent = "Pay now";
  }
});

loadOrders();
