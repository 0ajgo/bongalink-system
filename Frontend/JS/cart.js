/* ==========================================================================
   Bongalink — cart (requires api.js; ui.js optional for the header count)

   The SERVER cart (GET/POST/DELETE /api/cart) is the source of truth:
   POST /api/orders builds the order from it. Every change goes through
   the API and then refreshes a local copy (localStorage) that cart.html
   and checkout.html render from, so what the customer sees is always
   what will be ordered.
   ========================================================================== */

const CART_KEY = "bongalink.cart";

/* PSGC regions for address forms. Shipping fees are NOT kept here:
   checkout asks POST /api/v1/shipping/quote, and the server recomputes
   the fee again when the order is placed (REQ015). */
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

const peso = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP", minimumFractionDigits: 2 });
const money = (value) => peso.format(value);

/* --- Local copy -------------------------------------------------------- */
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
  paintCartCount(items);
}

const subtotalOf = (items) => items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
const countOf = (items) => items.reduce((sum, item) => sum + item.quantity, 0);

function paintCartCount(items) {
  if (typeof paintHeaderCartCount === "function") paintHeaderCartCount(countOf(items));
}

/* --- Server cart -------------------------------------------------------
   GET /api/cart rows: { id, quantity, name, price, image, stock }
   where stock is AVAILABLE stock (on hand minus unpaid reservations). */
const CART_API_ORIGIN = API_BASE_URL.replace(/\/api$/, "");

function fromServerRow(row) {
  return {
    productId: String(row.id),
    name: row.name,
    unitPrice: Number(row.price),
    quantity: Number(row.quantity),
    stockOnHand: Number(row.stock),
    image: row.image ? CART_API_ORIGIN + row.image : ""
  };
}

// Replaces the local copy with the server cart. Logged-out visitors have no cart.
async function syncCartFromServer() {
  if (!isLoggedIn()) {
    writeCart([]);
    return [];
  }
  const items = (await apiFetch("/cart")).map(fromServerRow);
  writeCart(items);
  return items;
}

const cartApi = {
  async add(productId, quantity = 1) {
    await apiFetch("/cart", { method: "POST", body: JSON.stringify({ productId, quantity }) });
    return syncCartFromServer();
  },
  async remove(productId) {
    await apiFetch(`/cart/${encodeURIComponent(productId)}`, { method: "DELETE" });
    return syncCartFromServer();
  },
  // Sets the line to exactly `quantity` in one request (0 removes it). If the server
  // refuses (e.g. more than available), the line keeps its old quantity.
  async setQuantity(productId, quantity) {
    if (quantity > 0) {
      await apiFetch(`/cart/${encodeURIComponent(productId)}`, { method: "PUT", body: JSON.stringify({ quantity }) });
    } else {
      await apiFetch(`/cart/${encodeURIComponent(productId)}`, { method: "DELETE" });
    }
    return syncCartFromServer();
  }
};
