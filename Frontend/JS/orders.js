/* =====================================================================
   BONGALINK — MY ORDERS (Pages/COpage/orders.html)
   Requires api.js, icons.js, cart.js and ui.js.
   - GET  /api/orders                  this customer's orders + items
   - GET  /api/v1/orders/:id/tracking  courier, tracking no./link, timeline
   - POST /api/v1/payments/checkout    "Pay now" for an unpaid order
   Shared with the profile page: orderCardMarkup() and loadTracking().
   ===================================================================== */

const COURIER = { JNT: "J&T Express", LBC: "LBC Express", LALAMOVE: "Lalamove" };
const TRACKABLE = ["shipped", "delivered"];
const orderRef = (order) => `BGL-${new Date(order.created_at).getFullYear()}-${String(order.order_id).padStart(4, "0")}`;

function orderCardMarkup(order, { compact = false } = {}) {
  const items = (order.items || []).map(i => `<li>${Number(i.quantity)} × ${escapeHTML(i.name)}</li>`).join("");
  const courier = order.courier ? ` · ${COURIER[order.courier] || escapeHTML(order.courier)}` : "";
  const trackLink = compact && TRACKABLE.includes(order.status)
    ? `<a class="btn btn--secondary btn--sm" href="../COpage/orders.html#order-${order.order_id}">${icon("truck", { size: 16 })} Track</a>` : "";
  return `
    <article class="card" data-order="${order.order_id}" id="order-${order.order_id}">
      <div class="card__body">
        <div class="order-card__head">
          <span class="order-card__ref">${orderRef(order)}</span>
          ${statusBadge(order.status)}
        </div>
        <p class="order-card__meta">Placed ${formatDateTime(order.created_at)}${courier}${order.paid_at ? ` · Paid ${formatDateTime(order.paid_at)}` : ""}</p>
        ${compact ? "" : `<ul class="order-card__items">${items}</ul>`}
        <div class="order-card__total">
          <span>${compact ? `${(order.items || []).length} item(s)` : `Shipping ${formatMoney(order.shipping_fee)}`}</span>
          <span class="row"><span class="price">${formatMoney(order.total_amount)}</span>
          ${order.status === "pending_payment"
            ? `<button class="btn btn--primary btn--sm" type="button" data-pay="${order.order_id}">Pay now</button>` : ""}
          ${trackLink}</span>
        </div>
        ${compact ? "" : `<div class="tracking" data-tracking="${order.order_id}" hidden></div>`}
      </div>
    </article>`;
}

function trackingMarkup(t) {
  const link = t.tracking_url
    ? `<a href="${escapeHTML(t.tracking_url)}" target="_blank" rel="noopener">${icon("external-link", { size: 14 })} Track on the courier's site</a>` : "";
  const number = t.tracking_number ? `Tracking no. <strong>${escapeHTML(t.tracking_number)}</strong>` : "No tracking number";
  // Newest first, so the current status is at the top.
  const events = [...t.events].reverse().map((e, i) => `
    <li class="${i === 0 ? "is-latest" : ""}">
      <div class="timeline__status">${escapeHTML(STATUS[e.status] || e.status)}</div>
      <div class="timeline__time">${formatDateTime(e.created_at)}</div>
      ${e.note ? `<div class="timeline__note">${escapeHTML(e.note)}</div>` : ""}
    </li>`).join("");
  return `
    <div class="tracking__head">
      <span><strong>${escapeHTML(t.courier_label || COURIER[t.courier] || t.courier)}</strong> · ${number}</span>${link}
    </div>
    <ol class="timeline">${events}</ol>`;
}

async function loadTracking(root, orderId) {
  const slot = root.querySelector(`[data-tracking="${orderId}"]`);
  if (!slot) return;
  try {
    slot.innerHTML = trackingMarkup(await apiFetch(`/v1/orders/${orderId}/tracking`));
    slot.hidden = false;
  } catch (err) {
    if (err.status !== 404) {   // 404 = not handed to a courier yet
      slot.innerHTML = `<p class="error-text">Couldn't load tracking: ${escapeHTML(err.message)}</p>`;
      slot.hidden = false;
    }
  }
}

// "Pay now" on an unpaid order: open PayMongo for it.
function wirePayButtons(root, onError) {
  root.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-pay]");
    if (!button) return;
    button.disabled = true;
    button.classList.add("is-loading");
    try {
      const { checkout_url } = await apiFetch("/v1/payments/checkout", {
        method: "POST", body: JSON.stringify({ order_id: Number(button.dataset.pay) })
      });
      window.location.href = checkout_url;
    } catch (err) {
      onError(err.message);
      button.disabled = false;
      button.classList.remove("is-loading");
    }
  });
}

/* ---------------------------------------------------------------------
   The My orders page itself (skipped when loaded by the profile page)
   --------------------------------------------------------------------- */
const ordersEl = document.getElementById("orders");
if (ordersEl) {
  renderHeader({ active: "orders" });
  const errorEl = document.getElementById("orders-error");
  const showError = (message) => {
    errorEl.hidden = false;
    errorEl.innerHTML = `${icon("circle-alert", { size: 18 })}<span>${escapeHTML(message)}</span>`;
  };

  async function loadOrders() {
    ordersEl.innerHTML = `<div class="card"><table class="table"><tbody>${UIState.rowSkeletons(3, 3)}</tbody></table></div>`;
    try {
      const orders = await apiFetch("/orders");
      ordersEl.innerHTML = orders.length
        ? orders.map(o => orderCardMarkup(o)).join("")
        : `<div class="card">${UIState.empty({ icon: "clipboard-list", title: "No orders yet",
            text: "When you place an order, its payment and delivery status show up here.",
            action: `<a class="btn btn--primary" href="../Homepage/homepage.html">Browse parts</a>` })}</div>`;
      await Promise.all(orders.filter(o => TRACKABLE.includes(o.status)).map(o => loadTracking(ordersEl, o.order_id)));
      if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
    } catch (err) {
      ordersEl.innerHTML = `<div class="card">${UIState.error(err.message, "retryOrders")}</div>`;
      document.getElementById("retryOrders").addEventListener("click", loadOrders);
    }
  }

  wirePayButtons(ordersEl, showError);
  if (requireLoginPage()) loadOrders();
}
