/* Checkout. Requires api.js, icons.js, cart.js and ui.js.
   1. Shows the cart and, if the customer has one, their default address.
   2. The map pin (js/map-picker.js) fills region/province/city. Each
      courier option says how its fee was worked out; the order sends the
      fee shown, so a changed fee is caught before paying.
   3. Placing the order holds the items for 24 hours, then the customer
      goes to PayMongo to pay.
   4. Back from PayMongo (?order=&payment=success|cancelled) the page
      checks the order's payment status. The redirect alone is not proof of
      payment, so a still-pending order never offers to pay again after
      "success" (that could charge twice). */

renderHeader();

let cart = [];
let options = [];
let selectedCourier = null;
let quote = null;   // last shipping quote
let savedAddresses = [];

const els = {
  items: document.getElementById("summary-items"),
  subtotal: document.getElementById("sum-subtotal"),
  shipping: document.getElementById("sum-shipping"),
  shipLbl: document.getElementById("sum-shipping-label"),
  total: document.getElementById("sum-total"),
  couriers: document.getElementById("courier-choices"),
  region: document.getElementById("region"),
  quoteMeta: document.getElementById("quote-meta"),
  form: document.getElementById("checkout-form"),
  button: document.getElementById("place-order"),
  orderErr: document.getElementById("order-error"),
  saved: document.getElementById("savedAddress")
};

els.region.innerHTML = `<option value="">Choose a region</option>` +
  PSGC_REGIONS.map(r => `<option value="${r.code}">${r.label}</option>`).join("");

function busy(button, on, label) {
  button.disabled = on;
  button.classList.toggle("is-loading", on);
  if (label) button.textContent = label;
}

/* ---------------------------------------------------------------------
   SUMMARY
   --------------------------------------------------------------------- */
function renderSummary() {
  els.items.innerHTML = cart.map(item => `
    <div class="mini-line">
      <span class="thumb thumb--sm frame">${item.image ? `<img src="${escapeHTML(item.image)}" alt="">` : icon("package", { size: 24 })}</span>
      <span><span class="mini-line__name">${escapeHTML(item.name)}</span><br>
        <span class="mini-line__qty">Qty ${item.quantity} × ${formatMoney(item.unitPrice)}</span></span>
      <span class="price">${formatMoney(item.unitPrice * item.quantity)}</span>
    </div>`).join("");
  paintTotals();
}

function paintTotals() {
  const subtotal = subtotalOf(cart);
  const option = options.find(o => o.courier === selectedCourier);
  els.subtotal.textContent = formatMoney(subtotal);
  if (option) {
    els.shipLbl.textContent = `Shipping · ${option.label}`;
    els.shipping.textContent = formatMoney(option.fee);
    els.total.textContent = formatMoney(subtotal + option.fee);
  } else {
    els.shipLbl.textContent = "Shipping";
    els.shipping.textContent = "Choose a courier";
    els.total.textContent = formatMoney(subtotal);
  }
}

/* ---------------------------------------------------------------------
   SHIPPING QUOTE — each request gets a sequence number so a slow, older
   answer can't overwrite a newer one.
   --------------------------------------------------------------------- */
let quoteSeq = 0;

function addressLine() {
  const f = els.form.elements;
  return [f.street.value, f.barangay.value, f.city.value, f.province.value]
    .map(v => v.trim()).filter(Boolean).join(", ");
}

async function refreshQuote() {
  const region = els.region.value;
  const pin = picker.getPin();

  if ((!region && !pin) || !cart.length) {
    options = [];
    quote = null;
    selectedCourier = null;
    els.quoteMeta.hidden = true;
    els.couriers.innerHTML = `<p class="muted">Pin your location or choose your region to see shipping options.</p>`;
    paintTotals();
    return;
  }

  const seq = ++quoteSeq;
  els.couriers.innerHTML = `<p class="muted">${icon("loader-circle", { size: 16 })} Getting shipping options…</p>`;
  let failed = null;
  try {
    const result = await apiFetch("/v1/shipping/quote", {
      method: "POST", timeout: API_TIMEOUT_LONG_MS,
      body: JSON.stringify({
        items: cart.map(i => ({ product_id: Number(i.productId), quantity: i.quantity })),
        address: {
          region: region || "NCR",  
          province: els.form.elements.province.value.trim() || null,
          city: els.form.elements.city.value.trim() || null,
          line: addressLine() || region,
          lat: pin?.lat, lng: pin?.lng
        }
      })
    });
    if (seq !== quoteSeq) return;
    quote = result;
    options = result.options;
    // The pin decides the region: keep the dropdown in step with it.
    if (result.location.source === "pin" && els.region.value !== result.location.region) els.region.value = result.location.region;
    renderQuoteMeta(result);
  } catch (err) {
    if (seq !== quoteSeq) return;
    options = [];
    quote = null;
    els.quoteMeta.hidden = true;
    failed = err.message || "Couldn't load shipping options.";
  }

  if (!options.some(o => o.courier === selectedCourier)) selectedCourier = null;
  if (options.length) renderCouriers();
  else {
    els.couriers.innerHTML = `<div class="alert alert--error">${icon("circle-alert", { size: 18 })}
      <span>${escapeHTML(failed || "No courier delivers this order to that region. Please contact the shop.")}</span></div>`;
  }
  paintTotals();
}

function renderCouriers() {
  els.couriers.innerHTML = options.map(o => `
    <label class="choice">
      <input type="radio" name="courier" value="${o.courier}" ${o.courier === selectedCourier ? "checked" : ""}>
      <span><span class="choice__title">${escapeHTML(o.label)}</span>
        <span class="choice__detail">Arrives in ${escapeHTML(o.eta)}</span>
        <span class="choice__basis">${escapeHTML(o.basis || "")}</span></span>
      <span class="price">${formatMoney(o.fee)}</span>
    </label>`).join("");
}

els.couriers.addEventListener("change", (event) => {
  selectedCourier = event.target.value;
  paintTotals();
  clearError("courier");
});
els.region.addEventListener("change", () => { clearError("region"); refreshQuote(); });
els.form.elements.province.addEventListener("change", refreshQuote);

function renderQuoteMeta(result) {
  const l = result.location;
  const where = [l.city, l.province, regionName(l.region)].filter(Boolean).join(", ");
  els.quoteMeta.hidden = false;
  els.quoteMeta.innerHTML = `
    <span>${icon("package", { size: 16 })} Parcel weight: <strong>${result.weight_kg} kg</strong></span>
    <span>${l.source === "pin"
      ? `${icon("map-pin", { size: 16 })} Fees for your pin: ${escapeHTML(where)}`
      : `${icon("info", { size: 16 })} Fees for the region you chose. Pin your location for exact fees.`}</span>`;
}

// Map pin: fills in what the lookup found; the customer can still edit every field.
const picker = createMapPicker(document.getElementById("mapPicker"), {
  onLocation(location) {
    const f = els.form.elements;
    els.region.value = location.region;
    f.province.value = location.province || "";
    if (location.city) f.city.value = location.city;
    if (location.barangay && !f.barangay.value.trim()) f.barangay.value = location.barangay;
    if (location.postcode && !f.postalCode.value.trim()) f.postalCode.value = location.postcode;
    ["region", "city", "barangay", "postalCode"].forEach(clearError);
    refreshQuote();
  },
  onClear: () => refreshQuote(),
  onError: () => refreshQuote()
});

/* ---------------------------------------------------------------------
   SAVED ADDRESSES — prefill the form
   --------------------------------------------------------------------- */
function fillAddress(a) {
  const f = els.form.elements;
  const [first, ...rest] = String(a.recipient_name).split(" ");
  f.firstName.value = rest.length ? first : a.recipient_name;
  f.lastName.value = rest.join(" ");
  f.phone.value = a.recipient_phone;
  f.street.value = a.street;
  f.barangay.value = a.barangay;
  f.city.value = a.city;
  f.province.value = a.province || "";
  f.postalCode.value = a.postal_code;
  f.landmark.value = a.landmark || "";
  els.region.value = a.region || "";
  if (a.lat !== null && a.lat !== undefined && a.lng !== null) picker.setPin({ lat: Number(a.lat), lng: Number(a.lng) }, { lookup: false });
  refreshQuote();
}

async function loadAccountDefaults() {
  try {
    const [me, addresses] = await Promise.all([apiFetch("/v1/account/me"), apiFetch("/v1/account/addresses")]);
    if (!els.form.elements.email.value) els.form.elements.email.value = me.email;
    savedAddresses = addresses;
    if (!addresses.length) return;
    document.getElementById("saved-field").hidden = false;
    els.saved.innerHTML = addresses.map(a => `<option value="${a.address_id}">
      ${escapeHTML(a.recipient_name)} — ${escapeHTML([a.street, a.city].join(", "))}${a.is_default ? " (default)" : ""}</option>`).join("") +
      `<option value="">Enter a different address</option>`;
    fillAddress(addresses[0]);
  } catch {
    /* Prefill is a convenience; the form still works empty. */
  }
}

els.saved.addEventListener("change", () => {
  const a = savedAddresses.find(x => String(x.address_id) === els.saved.value);
  if (a) fillAddress(a);
});

/* ---------------------------------------------------------------------
   VALIDATION — the same rules the server checks
   --------------------------------------------------------------------- */
function showError(name, message) {
  const slot = document.querySelector(`[data-error-for="${name}"]`);
  if (slot) slot.textContent = message;
  const input = els.form.elements[name];
  if (input && input.setAttribute) input.setAttribute("aria-invalid", "true");
}

function clearError(name) {
  const slot = document.querySelector(`[data-error-for="${name}"]`);
  if (slot) slot.textContent = "";
  const input = els.form.elements[name];
  if (input && input.removeAttribute) input.removeAttribute("aria-invalid");
}

function validate() {
  const required = ["email", "phone", "firstName", "lastName", "street", "barangay", "city", "region", "postalCode"];
  let firstBad = null;
  required.forEach(name => {
    clearError(name);
    if (!els.form.elements[name].value.trim()) {
      showError(name, "This field is required.");
      firstBad ??= name;
    }
  });
  const email = els.form.elements.email.value.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { showError("email", "Enter a valid email address."); firstBad ??= "email"; }
  const phone = els.form.elements.phone.value.replace(/\D/g, "");
  if (phone && !/^(09\d{9}|639\d{9})$/.test(phone)) { showError("phone", "Enter an 11-digit mobile number starting with 09."); firstBad ??= "phone"; }
  const postal = els.form.elements.postalCode.value.trim();
  if (postal && !/^\d{4}$/.test(postal)) { showError("postalCode", "Philippine postal codes are 4 digits."); firstBad ??= "postalCode"; }
  if (!selectedCourier) { showError("courier", "Choose a courier so shipping can be calculated."); firstBad ??= "region"; }
  if (!els.form.elements.consentRequired.checked) {
    showError("consentRequired", "Tick the box to allow Bongalink to process your delivery details.");
    firstBad ??= "consentRequired";
  }
  return firstBad;
}

/* ---------------------------------------------------------------------
   EMAIL VERIFICATION — checkout is blocked until the email is verified;
   verifying retries the order.
   --------------------------------------------------------------------- */
const verify = {
  box: document.getElementById("verify-box"),
  email: document.getElementById("verify-email"),
  code: document.getElementById("verify-code"),
  message: document.getElementById("verify-message")
};

function showVerifyStep() {
  verify.box.hidden = false;
  if (!verify.email.value) verify.email.value = els.form.elements.email.value.trim();
  els.button.hidden = true;
  verify.code.focus();
}

document.getElementById("verify-resend").addEventListener("click", async (event) => {
  verify.message.textContent = "";
  const button = event.currentTarget;   // currentTarget is null again after an await
  busy(button, true);
  try {
    const result = await apiFetch("/v1/auth/verify-email/send", {
      method: "POST", timeout: API_TIMEOUT_LONG_MS, body: JSON.stringify({ email: verify.email.value.trim() })
    });
    verify.message.textContent = result.message;
  } catch (err) {
    verify.message.textContent = err.message;
  } finally {
    busy(button, false);
  }
});

document.getElementById("verify-confirm").addEventListener("click", async (event) => {
  verify.message.textContent = "";
  const button = event.currentTarget;   // currentTarget is null again after an await
  busy(button, true);
  try {
    await apiFetch("/v1/auth/verify-email/confirm", {
      method: "POST",
      body: JSON.stringify({ email: verify.email.value.trim(), code: verify.code.value.trim() })
    });
    verify.box.hidden = true;
    els.button.hidden = false;
    placeOrder();
  } catch (err) {
    verify.message.textContent = err.message;
  } finally {
    busy(button, false);
  }
});

/* ---------------------------------------------------------------------
   PLACE ORDER
   --------------------------------------------------------------------- */
els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const bad = validate();
  if (bad) {
    const target = els.form.elements[bad];
    if (target && target.focus) target.focus();
    return;
  }
  placeOrder();
});

async function placeOrder() {
  els.orderErr.textContent = "";
  const f = els.form.elements;
  const payload = {
    contact: { email: f.email.value.trim(), phone: f.phone.value.trim() },
    recipient: { firstName: f.firstName.value.trim(), lastName: f.lastName.value.trim() },
    address: {
      street: f.street.value.trim(), barangay: f.barangay.value.trim(), city: f.city.value.trim(),
      province: f.province.value.trim() || null, region: els.region.value,
      postalCode: f.postalCode.value.trim(), landmark: f.landmark.value.trim() || null,
      lat: picker.getPin()?.lat ?? null, lng: picker.getPin()?.lng ?? null
    },
    courier: selectedCourier,
    expected_shipping_fee: options.find(o => o.courier === selectedCourier)?.fee,
    payment: { method: f.payment.value },
    consent: { marketing: f.consentMarketing.checked, policyVersion: "2026-01" }
  };

  busy(els.button, true);
  let order;
  try {
    order = await apiFetch("/orders", { method: "POST", timeout: API_TIMEOUT_LONG_MS, body: JSON.stringify(payload) });
  } catch (err) {
    busy(els.button, false);
    if (err.code === "EMAIL_NOT_VERIFIED") return showVerifyStep();
    // An earlier try that timed out went through: pay for that order (it is never placed twice).
    if (err.code === "ORDER_ALREADY_PLACED" && err.data?.orderId) {
      writeCart([]);
      return startPayment(err.data.orderId);
    }
    if (err.code === "SHIPPING_FEE_CHANGED") await refreshQuote();   // show the new fee before they retry
    els.orderErr.textContent = err.status ? (err.message || "Checkout failed. Please try again.")
      : `${err.message} If your order went through, pressing Place order again takes you to payment; it won't be placed twice.`;
    return;
  }
  // The server emptied the cart when it created the order.
  writeCart([]);
  startPayment(order.orderId);
}

/* ---------------------------------------------------------------------
   PAYMENT — PayMongo's checkout page
   --------------------------------------------------------------------- */
async function startPayment(orderId) {
  try {
    const { checkout_url } = await apiFetch("/v1/payments/checkout", {
      method: "POST", timeout: API_TIMEOUT_LONG_MS, body: JSON.stringify({ order_id: orderId })
    });
    window.location.href = checkout_url;
  } catch (err) {
    showStatus(orderId, {
      title: "Order placed — payment not started",
      text: `${err.message || "We couldn't open the payment page."} Your items are held for 24 hours.`,
      tone: "warning",
      action: { label: "Pay now", onClick: () => startPayment(orderId) }
    });
  }
}

/* ---------------------------------------------------------------------
   RETURN FROM PAYMONGO
   --------------------------------------------------------------------- */
const orderRef = (orderId) => `BGL-${new Date().getFullYear()}-${String(orderId).padStart(4, "0")}`;
const PAID_STATUSES = ["paid", "packed", "shipped", "delivered"];
const FAST_CHECKS = 10, FAST_MS = 3000, SLOW_MS = 15000;
const TONE_ICON = { success: "check", warning: "triangle-alert", error: "circle-alert", info: "loader-circle" };

// action: { label, onClick } for the main button, or null for none.
function showStatus(orderId, { title, text, action = null, tone = "info" }) {
  document.getElementById("checkout-body").innerHTML = `
    <div class="card"><div class="card__body result${tone === "success" ? " result--success" : ""}">
      ${icon(TONE_ICON[tone], { size: 48 })}
      <h1>${escapeHTML(title)}</h1>
      <p>${escapeHTML(text)}</p>
      <span class="reference">${orderRef(orderId)}</span>
      <p class="muted">Keep this reference. You can follow the delivery from My orders.</p>
      <div class="row">
        ${action ? `<button class="btn btn--primary btn--lg" id="status-action" type="button">${escapeHTML(action.label)}</button>` : ""}
        <a class="btn btn--secondary btn--lg" href="orders.html">My orders</a>
        <a class="btn btn--ghost btn--lg" href="../Homepage/homepage.html">Back to the shop</a>
      </div>
    </div></div>`;
  window.scrollTo({ top: 0 });
  if (action) document.getElementById("status-action").addEventListener("click", action.onClick);
}

function settledMessage(status) {
  if (PAID_STATUSES.includes(status.order_status)) {
    return { title: "Payment received", tone: "success", text: "Thank you! We emailed your receipt and will send tracking details once it ships." };
  }
  if (status.payment?.status === "review") {
    return { title: "Payment under review", tone: "warning", text: "We received a payment the shop needs to check. They'll contact you by email." };
  }
  if (status.order_status === "expired") {
    return { title: "Order expired", tone: "error", text: "This order wasn't paid within 24 hours, so the items went back on sale. If you were charged, the shop will contact you by email." };
  }
  return { title: `Order ${STATUS[status.order_status] || status.order_status}`, text: "This order is no longer waiting for payment." };
}

let pollTimer = null;

async function checkPaymentReturn(orderId, result, attempt = 0) {
  clearTimeout(pollTimer);
  if (attempt === 0) showStatus(orderId, { title: "Checking your payment…", text: "This usually takes a few seconds." });

  let status;
  try {
    status = await apiFetch(`/v1/payments/orders/${orderId}`);
  } catch (err) {
    return showStatus(orderId, {
      title: "Couldn't check the payment", tone: "error", text: `${err.message} Your order is saved.`,
      action: { label: "Check again", onClick: () => checkPaymentReturn(orderId, result) }
    });
  }

  if (status.order_status !== "pending_payment") return showStatus(orderId, settledMessage(status));

  if (result !== "success") {
    return showStatus(orderId, {
      title: "Payment cancelled", tone: "warning",
      text: "Your order is saved and your items are held for 24 hours. You can pay whenever you're ready.",
      action: { label: "Pay now", onClick: () => startPayment(orderId) }
    });
  }

  // Paid on PayMongo's page, but the shop hasn't been notified yet.
  if (attempt + 1 >= FAST_CHECKS) {
    showStatus(orderId, {
      title: "Waiting for payment confirmation",
      text: "PayMongo hasn't confirmed your payment to the shop yet. If you completed the payment, please don't pay again. " +
            "This page keeps checking every 15 seconds, and we'll email your receipt as soon as it's confirmed.",
      action: { label: "Check now", onClick: () => checkPaymentReturn(orderId, result, attempt + 1) }
    });
  }
  pollTimer = setTimeout(() => checkPaymentReturn(orderId, result, attempt + 1),
                         attempt + 1 < FAST_CHECKS ? FAST_MS : SLOW_MS);
}

/* ---------------------------------------------------------------------
   INIT
   --------------------------------------------------------------------- */
async function init() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("order")) return checkPaymentReturn(Number(params.get("order")), params.get("payment"));

  try {
    cart = await syncCartFromServer();
  } catch (err) {
    cart = readCart();
    els.orderErr.textContent = `Couldn't refresh your cart: ${err.message}`;
  }
  if (!cart.length) {
    document.getElementById("checkout-body").innerHTML = `<div class="card">${UIState.empty({
      icon: "shopping-cart", title: "Your cart is empty", text: "Add some parts before checking out.",
      action: `<a class="btn btn--primary" href="../Homepage/homepage.html">Browse parts</a>` })}</div>`;
    return;
  }
  renderSummary();
  loadAccountDefaults();
}

if (requireLoginPage()) init();
