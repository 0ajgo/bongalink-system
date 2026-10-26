/* My orders: one card per order, with a Paid → Packed → Shipped → Delivered
   tracker and a Track panel that opens inside the card.
   Requires api.js, icons.js, cart.js and ui.js. The profile page reuses
   orderCardMarkup() (compact) and wirePayButtons(). */

const COURIER = { JNT: "J&T Express", LBC: "LBC Express", LALAMOVE: "Lalamove" };
const COURIER_SHORT = { JNT: "J&T", LBC: "LBC", LALAMOVE: "Lalamove" };
const STEPS = ["Paid", "Packed", "Shipped", "Delivered"];
const STEP_OF = { paid: 1, packed: 2, shipped: 3, delivered: 4 };   // how many steps are done
const HOLD_HOURS = 24;   // an unpaid order expires after this long

const orderRef = (order) => `BGL-${new Date(order.created_at).getFullYear()}-${String(order.order_id).padStart(4, "0")}`;
const shortDate = (value) => new Date(value).toLocaleDateString("en-PH", { month: "short", day: "numeric" });
const courierOf = (order) => order.shipment_courier || order.courier;
const courierName = (code) => COURIER[code] || code || "";

function headline(order) {
  switch (order.status) {
    case "pending_payment": return "Pay to confirm your order";
    case "paid": return "Payment received — we're packing your order";
    case "packed": return "Packed — handing it to the courier soon";
    case "shipped": return courierOf(order) === "LALAMOVE" ? "Your rider is on the way" : `Your parcel is with ${courierName(courierOf(order))}`;
    case "delivered": return order.delivered_at ? `Delivered ${shortDate(order.delivered_at)}` : "Delivered";
    default: return "";   // expired, cancelled: the badge says it
  }
}

function trackerMarkup(order) {
  const done = STEP_OF[order.status];
  if (!done) return "";
  const dates = [order.paid_at, order.packed_at, order.shipped_at, order.delivered_at];
  return `
    <ol class="tracker" aria-label="Order progress">${STEPS.map((label, i) => `
      <li class="tracker__step${i < done ? " is-done" : ""}"${i === done - 1 ? ' aria-current="step"' : ""}>
        <span class="tracker__dot" aria-hidden="true"></span>${label}
        ${i < done && dates[i] ? `<small>${shortDate(dates[i])}</small>` : ""}
        <span class="sr-only">${i < done ? "done" : "not yet"}</span>
      </li>`).join("")}
    </ol>`;
}

function orderCardMarkup(order, { compact = false } = {}) {
  const id = order.order_id;
  const count = (order.items || []).reduce((n, i) => n + Number(i.quantity), 0);
  const unpaid = order.status === "pending_payment";
  const meta = [
    `Placed ${formatDate(order.created_at)}`,
    `${count} item${count === 1 ? "" : "s"}`,
    escapeHTML(courierName(courierOf(order))),
    unpaid ? `unpaid orders cancel after ${HOLD_HOURS} hours` : ""
  ].filter(Boolean).join(" · ");
  const label = order.status === "delivered" ? "Details" : "Track";

  let action = "";
  if (unpaid) {
    action = `<button class="btn btn--primary btn--sm" type="button" data-pay="${id}">Pay now</button>`;
  } else if (compact) {
    action = STEP_OF[order.status]
      ? `<a class="btn btn--secondary btn--sm" href="../COpage/orders.html#order-${id}">${icon("truck", { size: 16 })} ${label}</a>` : "";
  } else {
    action = `<button class="btn btn--secondary btn--sm" type="button" data-toggle="${id}" aria-expanded="false" aria-controls="details-${id}">
      ${label} ${icon("chevron-down", { size: 16 })}</button>`;
  }
  const head = headline(order);
  return `
    <article class="card order-card" data-order="${id}" id="order-${id}">
      <div class="card__body">
        <div class="order-card__head">
          <span class="order-card__ref">${orderRef(order)}</span>
          ${statusBadge(order.status)}
        </div>
        ${head ? `<p class="order-card__headline">${escapeHTML(head)}</p>` : ""}
        <p class="order-card__meta">${meta}</p>
        ${compact ? "" : trackerMarkup(order)}
      </div>
      <div class="order-card__total">
        <span class="price">${formatMoney(order.total_amount)}</span>
        ${action}
      </div>
      ${compact || unpaid ? "" : `<div class="order-card__details" id="details-${id}" hidden></div>`}
    </article>`;
}

/* ---------------------------------------------------------------------
   The Track / Details panel
   --------------------------------------------------------------------- */
function courierBox(t) {
  if (t.shipped && t.courier === "LALAMOVE") {
    return `<div class="courier-box"><span><strong>Lalamove</strong></span>
      ${t.tracking_url ? `<a class="btn btn--secondary btn--sm" href="${escapeHTML(t.tracking_url)}" target="_blank" rel="noopener">Open live tracking ↗</a>` : ""}</div>`;
  }
  if (t.shipped) {
    const number = t.tracking_number
      ? ` · <span class="courier-box__tn">${escapeHTML(t.tracking_number)}</span>
          <button class="link-button" type="button" data-copy="${escapeHTML(t.tracking_number)}">Copy</button>` : "";
    return `<div class="courier-box"><span><strong>${escapeHTML(t.courier_label || courierName(t.courier))}</strong>${number}</span>
      ${t.tracking_url ? `<a class="btn btn--secondary btn--sm" href="${escapeHTML(t.tracking_url)}" target="_blank" rel="noopener">Track on ${escapeHTML(COURIER_SHORT[t.courier] || t.courier_label)}'s site ↗</a>` : ""}</div>`;
  }
  if (["paid", "packed"].includes(t.order_status) && t.courier_chosen) {
    return `<div class="courier-box"><span><strong>${escapeHTML(t.courier_chosen_label || courierName(t.courier_chosen))}</strong>
      <span class="muted">· tracking number appears once shipped</span></span></div>`;
  }
  return "";
}

function updatesMarkup(t) {
  const updates = [
    { at: t.created_at, text: "Order placed" },
    t.paid_at && { at: t.paid_at, text: "Paid" },
    t.packed_at && { at: t.packed_at, text: "Packed" },
    // Notes from the courier's own system are internal codes; the status says it in plain words.
    ...(t.events || []).map(e => ({ at: e.created_at, text: STATUS[e.status] || e.status, note: e.source === "courier_webhook" ? null : e.note }))
  ].filter(Boolean).sort((a, b) => new Date(a.at) - new Date(b.at)).reverse();
  return `<ul class="updates">${updates.map(u => `
    <li><time datetime="${escapeHTML(u.at)}">${formatDateTime(u.at)}</time>
      <span>${escapeHTML(u.text)}${u.note ? `<span class="updates__note">${escapeHTML(u.note)}</span>` : ""}</span></li>`).join("")}
  </ul>`;
}

function detailsMarkup(t, order) {
  const items = (order.items || []).map(i => `<li>${Number(i.quantity)} × ${escapeHTML(i.name)}</li>`).join("");
  return `
    ${courierBox(t)}
    <h4 class="order-card__label">Updates</h4>
    ${updatesMarkup(t)}
    <h4 class="order-card__label">Items</h4>
    <ul class="order-card__items">${items}</ul>`;
}

async function toggleDetails(card, order, open) {
  const button = card.querySelector("[data-toggle]");
  const panel = card.querySelector(".order-card__details");
  button.setAttribute("aria-expanded", String(open));
  panel.hidden = !open;
  if (!open || panel.dataset.loaded) return;
  panel.innerHTML = `<span class="skeleton skeleton--text"></span><span class="skeleton skeleton--text skeleton--short"></span>`;
  try {
    panel.innerHTML = detailsMarkup(await apiFetch(`/v1/orders/${order.order_id}/tracking`), order);
    panel.dataset.loaded = "true";
  } catch (err) {
    panel.innerHTML = `<p class="error-text">Couldn't load tracking: ${escapeHTML(err.message)}</p>`;
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
        method: "POST", timeout: API_TIMEOUT_LONG_MS, body: JSON.stringify({ order_id: Number(button.dataset.pay) })
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
  const byId = new Map();

  async function loadOrders() {
    ordersEl.innerHTML = `<div class="card"><table class="table"><tbody>${UIState.rowSkeletons(3, 3)}</tbody></table></div>`;
    try {
      const orders = await apiFetch("/orders");
      orders.forEach(o => byId.set(String(o.order_id), o));
      ordersEl.innerHTML = orders.length
        ? orders.map(o => orderCardMarkup(o)).join("")
        : `<div class="card">${UIState.empty({ icon: "clipboard-list", title: "No orders yet",
            text: "When you place an order, its payment and delivery status show up here.",
            action: `<a class="btn btn--primary" href="../Homepage/homepage.html">Browse parts</a>` })}</div>`;
      // Opened from the profile page's Track link: expand that order.
      const target = /^#order-(\d+)$/.exec(location.hash);
      const card = target && document.getElementById(`order-${target[1]}`);
      if (card) {
        card.scrollIntoView();
        if (card.querySelector("[data-toggle]")) await toggleDetails(card, byId.get(target[1]), true);
      }
    } catch (err) {
      ordersEl.innerHTML = `<div class="card">${UIState.error(err.message, "retryOrders")}</div>`;
      document.getElementById("retryOrders").addEventListener("click", loadOrders);
    }
  }

  ordersEl.addEventListener("click", (event) => {
    const toggle = event.target.closest("button[data-toggle]");
    if (toggle) {
      toggleDetails(toggle.closest(".order-card"), byId.get(toggle.dataset.toggle), toggle.getAttribute("aria-expanded") !== "true");
      return;
    }
    const copy = event.target.closest("button[data-copy]");
    if (copy) {
      Promise.resolve(navigator.clipboard?.writeText(copy.dataset.copy))
        .then(() => { if (!navigator.clipboard) throw new Error(); copy.textContent = "Copied ✓"; })
        .catch(() => toast("Couldn't copy. Select the number and copy it instead.", "error"));
    }
  });

  wirePayButtons(ordersEl, showError);
  if (requireLoginPage()) loadOrders();
}
