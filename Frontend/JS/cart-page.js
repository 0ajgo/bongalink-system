/* Cart page. Requires api.js, icons.js, cart.js and ui.js.
   Shows the cart saved on the server and changes it there (cartApi), so
   checkout orders exactly what is shown. Quantities are capped at
   available stock. */

renderHeader();
const body = document.getElementById("cart-body");
let cart = [];

function lineMarkup(item) {
  const available = item.stockOnHand;
  const atMax = item.quantity >= available;
  const over = item.quantity > available;
  const media = item.image
    ? `<img src="${escapeHTML(item.image)}" alt="">`
    : icon("package", { size: 32 });
  return `
    <article class="line">
      <span class="thumb">${media}</span>
      <div>
        <h3 class="line__name">${escapeHTML(item.name)}</h3>
        <div class="line__meta">${formatMoney(item.unitPrice)} each ${stockBadge(available)}
          ${available > 0 && available <= LOW_STOCK ? `<span>Only ${available} left</span>` : ""}</div>
        ${over ? `<div class="alert alert--warning">${icon("triangle-alert", { size: 18 })}
          <span>${available > 0 ? `Only ${available} available — lower the quantity to continue.` : "This part sold out. Remove it to continue."}</span></div>` : ""}
        <div class="line__controls">
          <div class="stepper" role="group" aria-label="Quantity of ${escapeHTML(item.name)}">
            <button type="button" data-step="-1" data-id="${item.productId}" ${item.quantity <= 1 ? "disabled" : ""}>
              ${icon("minus", { size: 16, label: "Decrease quantity" })}</button>
            <output aria-live="polite">${item.quantity}</output>
            <button type="button" data-step="1" data-id="${item.productId}" ${atMax ? "disabled" : ""}>
              ${icon("plus", { size: 16, label: "Increase quantity" })}</button>
          </div>
          <button class="btn btn--ghost btn--sm" type="button" data-remove="${item.productId}">
            ${icon("trash-2", { size: 16 })} Remove</button>
        </div>
      </div>
      <div class="line__total"><span class="price">${formatMoney(item.unitPrice * item.quantity)}</span></div>
    </article>`;
}

function render() {
  if (!cart.length) {
    body.innerHTML = `<div class="card">${UIState.empty({
      icon: "shopping-cart", title: "Your cart is empty",
      text: "Find printheads, laptop batteries, RAM, SSDs and more — every part is tested at our shop.",
      action: `<a class="btn btn--primary" href="../Homepage/homepage.html">Browse parts</a>` })}</div>`;
    return;
  }
  const blocked = cart.some(item => item.quantity > item.stockOnHand);
  body.innerHTML = `
    <div class="layout-aside">
      <section class="card" aria-label="Items in your cart">${cart.map(lineMarkup).join("")}</section>
      <aside class="card sticky" aria-label="Order summary">
        <div class="card__header"><h2>Order summary</h2></div>
        <div class="card__body">
          <div class="summary-row"><span>Items (${countOf(cart)})</span><span class="price">${formatMoney(subtotalOf(cart))}</span></div>
          <div class="summary-row"><span>Shipping</span><span>Calculated at checkout</span></div>
          <div class="summary-total"><span>Estimated total</span><span class="price">${formatMoney(subtotalOf(cart))}</span></div>
          <div class="summary-actions">
            ${blocked
              ? `<button class="btn btn--primary btn--lg btn--block" type="button" disabled>Proceed to checkout</button>
                 <p class="error-text">Fix the highlighted items to continue.</p>`
              : `<a class="btn btn--primary btn--lg btn--block" href="checkout.html">Proceed to checkout</a>`}
            <p class="muted">Pay with GCash or bank transfer on the next step. Shipping depends on your region and courier.</p>
          </div>
        </div>
      </aside>
    </div>`;
}

async function change(button, work) {
  body.querySelectorAll("button").forEach(b => { b.disabled = true; });
  button.classList.add("is-loading");
  try {
    cart = await work();
  } catch (err) {
    toast(err.message || "Couldn't update your cart.", "error");
    cart = await syncCartFromServer().catch(() => cart);
  }
  render();
}

body.addEventListener("click", (event) => {
  const step = event.target.closest("[data-step]");
  if (step) {
    const item = cart.find(i => i.productId === step.dataset.id);
    const next = Math.min(Math.max(item.quantity + Number(step.dataset.step), 1), Math.max(item.stockOnHand, 1));
    if (next !== item.quantity) change(step, () => cartApi.setQuantity(item.productId, next));
    return;
  }
  const remove = event.target.closest("[data-remove]");
  if (remove) change(remove, () => cartApi.remove(remove.dataset.remove));
});

async function load() {
  body.innerHTML = `<div class="card"><table class="table"><tbody>${UIState.rowSkeletons(3, 3)}</tbody></table></div>`;
  try {
    cart = await syncCartFromServer();
    render();
  } catch (err) {
    body.innerHTML = `<div class="card">${UIState.error(err.message, "retryCart")}</div>`;
    document.getElementById("retryCart").addEventListener("click", load);
  }
}

if (requireLoginPage()) load();
