/* ==========================================================================
   Bongalink — cart state + shipping calculation
   Backs cart.html / checkout.html. Items are written here by Homepage.js
   (see its "LOCAL CART MIRROR" section) whenever a logged-in shopper adds
   or removes a product, so this localStorage copy always matches what the
   catalog page shows. Shipping is still a placeholder (see the TODO).
   ========================================================================== */

const CART_KEY = "bongalink.cart";

/* Region-based rates. TODO (REQ015): replace with live rates from the
   J&T / LBC REST APIs, keyed on parcel weight and destination. */
const SHIPPING_ZONES = {
  "NCR":            { label: "Metro Manila",        fee: 120, eta: "1–2 business days" },
  "LUZON":          { label: "Luzon",               fee: 180, eta: "2–4 business days" },
  "VISAYAS":        { label: "Visayas",             fee: 250, eta: "3–6 business days" },
  "MINDANAO":       { label: "Mindanao",            fee: 280, eta: "4–7 business days" },
  "ISLAND_PROVINCE":{ label: "Island province",     fee: 340, eta: "5–9 business days" }
};

const peso = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  minimumFractionDigits: 2
});

const money = (value) => peso.format(value);

/* --- Storage ----------------------------------------------------------- */

function readCart() {
  try {
    const stored = localStorage.getItem(CART_KEY);
    if (stored) return JSON.parse(stored);
  } catch (err) {
    console.warn("Cart could not be read from storage.", err);
  }
  return [];
}

function writeCart(items) {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(items));
  } catch (err) {
    console.warn("Cart could not be saved.", err);
  }
}

/* --- Derived values ---------------------------------------------------- */

const subtotalOf = (items) =>
  items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);

const countOf = (items) =>
  items.reduce((sum, item) => sum + item.quantity, 0);

function shippingFor(zoneKey) {
  return SHIPPING_ZONES[zoneKey] ?? null;
}

/* Stock label drives the colour signal in the UI. This is the guard against
   the "ghost stock" problem: quantity can never exceed stockOnHand. */
function stockState(item) {
  if (item.stockOnHand <= 0) return { level: "none", text: "Out of stock" };
  if (item.stockOnHand <= 3) return { level: "low", text: `Only ${item.stockOnHand} left in stock` };
  return { level: "ok", text: "In stock" };
}

/* --- Shared header badge ----------------------------------------------- */

function paintCartCount(items) {
  const badge = document.querySelector("[data-cart-count]");
  if (badge) badge.textContent = countOf(items);
}
