/* ==========================================================================
   Bongalink — cart state + shipping calculation
   Backs cart.html / checkout.html. Items are written here by Homepage.js
   (see its "LOCAL CART MIRROR" section) whenever a logged-in shopper adds
   or removes a product, so this localStorage copy always matches what the
   catalog page shows. Shipping fees come from the server at checkout.
   ========================================================================== */

const CART_KEY = "bongalink.cart";

/* PSGC regions for the checkout address form. Shipping fees are NOT
   kept here: checkout.html asks POST /api/v1/shipping/quote, and the
   server recomputes the fee again when the order is placed (REQ015). */
const PSGC_REGIONS = [
  { code: "NCR",   label: "NCR — Metro Manila" },
  { code: "CAR",   label: "CAR — Cordillera Administrative Region" },
  { code: "I",     label: "Region I — Ilocos Region" },
  { code: "II",    label: "Region II — Cagayan Valley" },
  { code: "III",   label: "Region III — Central Luzon" },
  { code: "IV-A",  label: "Region IV-A — CALABARZON" },
  { code: "IV-B",  label: "Region IV-B — MIMAROPA" },
  { code: "V",     label: "Region V — Bicol Region" },
  { code: "VI",    label: "Region VI — Western Visayas" },
  { code: "NIR",   label: "NIR — Negros Island Region" },
  { code: "VII",   label: "Region VII — Central Visayas" },
  { code: "VIII",  label: "Region VIII — Eastern Visayas" },
  { code: "IX",    label: "Region IX — Zamboanga Peninsula" },
  { code: "X",     label: "Region X — Northern Mindanao" },
  { code: "XI",    label: "Region XI — Davao Region" },
  { code: "XII",   label: "Region XII — SOCCSKSARGEN" },
  { code: "XIII",  label: "Region XIII — Caraga" },
  { code: "BARMM", label: "BARMM — Bangsamoro" }
];

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
