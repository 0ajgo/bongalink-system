/* =====================================================================
   catalog-preview.js — Phase 1 sample of the restyled product listing.
   Reads GET /api/products (stock = AVAILABLE stock) and builds the
   category filter from the products themselves. "Add to cart" only
   shows a toast here; Phase 2 wires it to the real cart.
   ===================================================================== */

renderHeader({ active: "shop" });

const API_ORIGIN = API_BASE_URL.replace(/\/api$/, "");
const grid = document.getElementById("product-grid");
const countEl = document.getElementById("result-count");
const state = { products: [], category: "All", inStockOnly: false, sort: "newest",
                q: new URLSearchParams(location.search).get("q") || "" };

function productCard(p) {
  const available = Number(p.stock) || 0;
  const media = p.image
    ? `<img src="${escapeHTML(API_ORIGIN + p.image)}" alt="${escapeHTML(p.name)}" loading="lazy">`
    : `<span class="product-card__placeholder">${icon("package", { size: 56 })}<span class="sr-only">No photo yet</span></span>`;
  return `
    <article class="product-card">
      <div class="product-card__media">${media}</div>
      <div class="product-card__body">
        <div class="product-card__meta"><span class="eyebrow">${escapeHTML(p.category)}</span>${stockBadge(available)}</div>
        <h3 class="product-card__name" title="${escapeHTML(p.name)}">${escapeHTML(p.name)}</h3>
        ${p.brand ? `<span class="product-card__brand">${escapeHTML(p.brand)}</span>` : ""}
        <span class="price product-card__price">${formatMoney(p.price)}</span>
        <button class="btn ${available > 0 ? "btn--primary" : ""} btn--block" type="button" data-add="${p.id}"
                ${available > 0 ? "" : "disabled"}>
          ${available > 0 ? `${icon("shopping-cart", { size: 18 })} Add to cart` : "Out of stock"}
        </button>
      </div>
    </article>`;
}

function visibleProducts() {
  const q = state.q.toLowerCase();
  const list = state.products.filter(p =>
    (state.category === "All" || p.category === state.category) &&
    (!state.inStockOnly || Number(p.stock) > 0) &&
    (!q || [p.name, p.brand, p.category, p.description].some(v => String(v || "").toLowerCase().includes(q))));
  const by = {
    newest: (a, b) => new Date(b.created_at) - new Date(a.created_at),
    "price-asc": (a, b) => a.price - b.price,
    "price-desc": (a, b) => b.price - a.price,
    name: (a, b) => a.name.localeCompare(b.name)
  }[state.sort];
  return list.sort(by);
}

function renderCategories() {
  const counts = state.products.reduce((m, p) => (m[p.category] = (m[p.category] || 0) + 1, m), {});
  const cats = [["All", state.products.length], ...Object.entries(counts).sort((a, b) => b[1] - a[1])];
  document.getElementById("category-list").innerHTML = cats.map(([name, n]) => `
    <li><button type="button" data-category="${escapeHTML(name)}" aria-pressed="${name === state.category}">
      <span>${name === "All" ? "All parts" : escapeHTML(name)}</span><span class="muted">${n}</span></button></li>`).join("");
  document.getElementById("category-chips").innerHTML = cats.map(([name]) => `
    <button class="chip" type="button" data-category="${escapeHTML(name)}" aria-pressed="${name === state.category}">
      ${name === "All" ? "All parts" : escapeHTML(name)}</button>`).join("");
}

function renderGrid() {
  const list = visibleProducts();
  countEl.textContent = `(${list.length})`;
  grid.setAttribute("aria-busy", "false");
  grid.innerHTML = list.length ? list.map(productCard).join("") : `<div class="grid-span-all card">${UIState.empty({
    icon: "search", title: "No parts match",
    text: state.q ? `Nothing found for "${state.q}". Try a model number or a shorter search.` : "Try another category or turn off \"In stock only\".",
    action: `<button class="btn btn--secondary" type="button" data-reset>Show all parts</button>` })}</div>`;
}

async function load() {
  grid.setAttribute("aria-busy", "true");
  grid.innerHTML = UIState.productSkeletons(8);
  try {
    state.products = (await apiFetch("/products")).map(p => ({ ...p, price: Number(p.price) }));
    renderCategories();
    renderGrid();
  } catch (err) {
    grid.setAttribute("aria-busy", "false");
    grid.innerHTML = `<div class="grid-span-all card">${UIState.error(err.message, "retry-load")}</div>`;
    document.getElementById("retry-load").addEventListener("click", load);
  }
}

document.addEventListener("click", (e) => {
  const cat = e.target.closest("[data-category]");
  if (cat) { state.category = cat.dataset.category; renderCategories(); renderGrid(); }
  if (e.target.closest("[data-reset]")) {
    Object.assign(state, { category: "All", inStockOnly: false, q: "" });
    document.getElementById("in-stock-only").checked = false;
    renderCategories(); renderGrid();
  }
  if (e.target.closest("[data-add]")) toast("Preview only — Add to cart is wired up in Phase 2.", "info");
});
document.getElementById("in-stock-only").addEventListener("change", (e) => { state.inStockOnly = e.target.checked; renderGrid(); });
document.getElementById("sort").addEventListener("change", (e) => { state.sort = e.target.value; renderGrid(); });

load();
