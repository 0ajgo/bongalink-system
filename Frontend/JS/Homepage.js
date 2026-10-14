/* =====================================================================
   BONGALINK — HOMEPAGE + CATALOG (homepage.html)
   Requires api.js, icons.js, cart.js and ui.js.
     products   -> GET /api/products (stock = AVAILABLE stock), and for the
                   admin POST /api/products (multipart) / DELETE /api/products/:id
     categories -> GET /api/categories
     cart       -> cartApi in cart.js (server cart, mirrored locally)
   Search comes from the hero box or the header (?q=).
   ===================================================================== */

renderHeader({ active: "shop", search: false });

const API_ORIGIN = API_BASE_URL.replace(/\/api$/, "");
const PAGE_SIZE = 24;
const CATEGORY_ICON = {
  "Printer Parts": "printer", "Printers": "printer", "Laptop Parts": "laptop",
  "Computer Parts": "cpu", "Accessories": "hard-drive", "Electronics": "monitor"
};

const els = {
  grid: document.getElementById("grid"),
  count: document.getElementById("resultCount"),
  label: document.getElementById("resultsLabel"),
  list: document.getElementById("categoryList"),
  chips: document.getElementById("categoryChips"),
  tiles: document.getElementById("categoryTiles"),
  inStock: document.getElementById("inStockOnly"),
  sort: document.getElementById("sort"),
  more: document.getElementById("moreWrap"),
  heroQ: document.getElementById("heroQ")
};

const state = {
  products: [], categories: [], category: "All", inStockOnly: false, sort: "stock",
  q: new URLSearchParams(location.search).get("q") || "", shown: PAGE_SIZE
};

/* ---------------------------------------------------------------------
   PRODUCT CARD — consistent 4:3 image, name (2 lines max), price,
   stock badge from available stock, Add to cart disabled when out.
   --------------------------------------------------------------------- */
function productCard(p) {
  const available = Number(p.stock) || 0;
  const media = p.image
    ? `<img src="${escapeHTML(API_ORIGIN + p.image)}" alt="${escapeHTML(p.name)}" loading="lazy">`
    : `<span class="product-card__placeholder">${icon("package", { size: 56 })}<span class="sr-only">No photo yet</span></span>`;
  const remove = isAdmin()
    ? `<button class="btn btn--secondary btn--sm btn--icon product-card__delete" type="button" data-delete="${p.id}">
         ${icon("trash-2", { size: 16, label: `Remove ${p.name}` })}</button>` : "";
  return `
    <article class="product-card">
      <div class="product-card__media">${media}${remove}</div>
      <div class="product-card__body">
        <div class="product-card__meta"><span class="eyebrow">${escapeHTML(p.category)}</span>${stockBadge(available)}</div>
        <h3 class="product-card__name" title="${escapeHTML(p.name)}">${escapeHTML(p.name)}</h3>
        ${p.brand ? `<span class="product-card__brand">${escapeHTML(p.brand)}</span>` : ""}
        <span class="price product-card__price">${formatMoney(p.price)}</span>
        ${isAdmin() ? "" : `
        <button class="btn ${available > 0 ? "btn--primary" : ""} btn--block" type="button" data-add="${p.id}"
                ${available > 0 ? "" : "disabled"}>
          ${available > 0 ? `${icon("shopping-cart", { size: 18 })} Add to cart` : "Out of stock"}
        </button>`}
      </div>
    </article>`;
}

/* ---------------------------------------------------------------------
   FILTER + SORT
   --------------------------------------------------------------------- */
function visibleProducts() {
  const q = state.q.trim().toLowerCase();
  const list = state.products.filter(p =>
    (state.category === "All" || p.category === state.category) &&
    (!state.inStockOnly || Number(p.stock) > 0) &&
    (!q || [p.name, p.brand, p.category, p.description].some(v => String(v || "").toLowerCase().includes(q))));
  const by = {
    stock: (a, b) => (Number(b.stock) > 0) - (Number(a.stock) > 0) || new Date(b.created_at) - new Date(a.created_at),
    newest: (a, b) => new Date(b.created_at) - new Date(a.created_at),
    "price-asc": (a, b) => a.price - b.price,
    "price-desc": (a, b) => b.price - a.price,
    name: (a, b) => a.name.localeCompare(b.name)
  }[state.sort];
  return list.sort(by);
}

/* ---------------------------------------------------------------------
   RENDER
   --------------------------------------------------------------------- */
function categoryCounts() {
  const counts = state.products.reduce((m, p) => (m[p.category] = (m[p.category] || 0) + 1, m), {});
  // Every category the shop has, even empty ones, in a stable order (most parts first).
  const names = new Set([...state.categories.map(c => c.name), ...Object.keys(counts)]);
  return [...names].map(name => [name, counts[name] || 0]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function renderCategories() {
  const cats = categoryCounts();
  const all = [["All", state.products.length], ...cats];
  const label = (name) => name === "All" ? "All parts" : escapeHTML(name);
  els.list.innerHTML = all.map(([name, n]) => `
    <li><button type="button" data-category="${escapeHTML(name)}" aria-pressed="${name === state.category}">
      <span>${label(name)}</span><span class="muted">${n}</span></button></li>`).join("");
  els.chips.innerHTML = all.map(([name]) => `
    <button class="chip" type="button" data-category="${escapeHTML(name)}" aria-pressed="${name === state.category}">${label(name)}</button>`).join("");
  els.tiles.innerHTML = cats.filter(([, n]) => n > 0).map(([name, n]) => `
    <button class="category-tile" type="button" data-category="${escapeHTML(name)}" data-scroll>
      ${icon(CATEGORY_ICON[name] || "package", { size: 24 })}
      <span><strong>${escapeHTML(name)}</strong><span>${n} part${n === 1 ? "" : "s"}</span></span>
    </button>`).join("");
}

function renderInStock() {
  const available = state.products.filter(p => Number(p.stock) > 0).slice(0, 4);
  document.getElementById("inStockSection").hidden = available.length === 0;
  document.getElementById("inStockGrid").innerHTML = available.map(productCard).join("");
}

function renderGrid() {
  const list = visibleProducts();
  els.label.textContent = state.q ? `Results for “${state.q}”` : state.category === "All" ? "All parts" : state.category;
  els.count.textContent = `(${list.length})`;
  els.grid.setAttribute("aria-busy", "false");
  els.more.hidden = list.length <= state.shown;
  if (!list.length) {
    els.grid.innerHTML = `<div class="grid-span-all card">${UIState.empty({
      icon: "search", title: state.products.length ? "No parts match" : "No parts listed yet",
      text: state.q ? `Nothing found for “${state.q}”. Try a model number or a shorter search.`
                    : state.products.length ? "Try another category or turn off “In stock only”." : "Check back soon.",
      action: state.products.length ? `<button class="btn btn--secondary" type="button" data-reset>Show all parts</button>` : ""
    })}</div>`;
    return;
  }
  els.grid.innerHTML = list.slice(0, state.shown).map(productCard).join("");
}

function renderAll() {
  renderCategories();
  renderInStock();
  renderGrid();
}

/* ---------------------------------------------------------------------
   LOAD
   --------------------------------------------------------------------- */
async function loadProducts() {
  els.grid.setAttribute("aria-busy", "true");
  els.grid.innerHTML = UIState.productSkeletons(8);
  els.tiles.innerHTML = "";
  try {
    const [products, categories] = await Promise.all([apiFetch("/products"), apiFetch("/categories").catch(() => [])]);
    state.products = products.map(p => ({ ...p, price: Number(p.price) }));
    state.categories = categories;
    renderAll();
  } catch (err) {
    els.grid.setAttribute("aria-busy", "false");
    els.grid.innerHTML = `<div class="grid-span-all card">${UIState.error(err.message, "retryProducts")}</div>`;
    document.getElementById("retryProducts").addEventListener("click", loadProducts);
  }
}

/* ---------------------------------------------------------------------
   CART + ADMIN ACTIONS
   --------------------------------------------------------------------- */
async function addToCart(id, button) {
  if (!isLoggedIn()) {
    toast("Log in to add parts to your cart.", "info");
    setTimeout(() => { window.location.href = "login.html?next=Homepage/homepage.html"; }, 900);
    return;
  }
  button.disabled = true;
  button.classList.add("is-loading");
  try {
    await cartApi.add(id, 1);
    const product = state.products.find(p => String(p.id) === String(id));
    toast(`${product ? product.name : "Part"} added to your cart.`, "success");
  } catch (err) {
    toast(err.message || "Could not add to cart.", "error");
  } finally {
    button.disabled = false;
    button.classList.remove("is-loading");
  }
}

async function deleteProduct(id) {
  const product = state.products.find(p => String(p.id) === String(id));
  if (!product || !confirm(`Remove "${product.name}" from the catalog?\n\nIts order history and sales trend are kept.`)) return;
  try {
    await apiFetch(`/products/${id}`, { method: "DELETE" });
    toast("Product removed.", "success");
    await loadProducts();
  } catch (err) {
    toast(err.message || "Could not remove the product.", "error");
  }
}

document.addEventListener("click", (event) => {
  const cat = event.target.closest("[data-category]");
  if (cat) {
    Object.assign(state, { category: cat.dataset.category, shown: PAGE_SIZE });
    renderCategories();
    renderGrid();
    if (cat.hasAttribute("data-scroll")) document.getElementById("catalog").scrollIntoView({ behavior: "smooth" });
    return;
  }
  const add = event.target.closest("[data-add]");
  if (add) return addToCart(add.dataset.add, add);
  const del = event.target.closest("[data-delete]");
  if (del) return deleteProduct(del.dataset.delete);
  if (event.target.closest("[data-reset]")) {
    Object.assign(state, { category: "All", inStockOnly: false, q: "", shown: PAGE_SIZE });
    els.inStock.checked = false;
    els.heroQ.value = "";
    history.replaceState(null, "", location.pathname);
    renderCategories();
    renderGrid();
  }
});

els.inStock.addEventListener("change", () => { state.inStockOnly = els.inStock.checked; state.shown = PAGE_SIZE; renderGrid(); });
els.sort.addEventListener("change", () => { state.sort = els.sort.value; renderGrid(); });
document.getElementById("showMore").addEventListener("click", () => { state.shown += PAGE_SIZE; renderGrid(); });
document.getElementById("showInStock").addEventListener("click", () => {
  state.inStockOnly = els.inStock.checked = true;
  state.category = "All";
  renderCategories();
  renderGrid();
  document.getElementById("catalog").scrollIntoView({ behavior: "smooth" });
});

document.getElementById("heroSearch").addEventListener("submit", (event) => {
  event.preventDefault();
  state.q = els.heroQ.value.trim();
  state.category = "All";
  state.shown = PAGE_SIZE;
  history.replaceState(null, "", state.q ? `?q=${encodeURIComponent(state.q)}` : location.pathname);
  renderCategories();
  renderGrid();
  document.getElementById("catalog").scrollIntoView({ behavior: "smooth" });
});

/* ---------------------------------------------------------------------
   ADMIN: LIST A PRODUCT (POST /api/products, multipart for the photo;
   the server's requireAdmin is the real gate)
   --------------------------------------------------------------------- */
const dialog = document.getElementById("productDialog");
const productForm = document.getElementById("productForm");
const productImage = document.getElementById("productImage");
const imagePreview = document.getElementById("imagePreview");
const productError = document.getElementById("productError");

function openProductDialog() {
  document.getElementById("productCategory").innerHTML =
    `<option value="">Choose a category</option>` +
    state.categories.map(c => `<option>${escapeHTML(c.name)}</option>`).join("");
  productError.textContent = "";
  dialog.showModal();
}

function closeProductDialog() {
  dialog.close();
  productForm.reset();
  imagePreview.textContent = "No photo selected";
}

dialog.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", closeProductDialog));
document.getElementById("openAddBtn").addEventListener("click", openProductDialog);

productImage.addEventListener("change", () => {
  const file = productImage.files[0];
  if (!file) { imagePreview.textContent = "No photo selected"; return; }
  if (!file.type.startsWith("image/")) {
    productError.textContent = "Please choose an image file.";
    productImage.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => { imagePreview.innerHTML = `<img src="${e.target.result}" alt="Preview of the selected photo">`; };
  reader.readAsDataURL(file);
});

productForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = (id) => document.getElementById(id).value.trim();
  if (!value("productName") || !value("productCategory") || value("productPrice") === "" || value("productStock") === "") {
    productError.textContent = "Please complete the name, category, price and stock.";
    return;
  }
  const form = new FormData();
  form.append("name", value("productName"));
  form.append("category", value("productCategory"));
  form.append("brand", value("productBrand"));
  form.append("price", value("productPrice"));
  form.append("stock", value("productStock"));
  form.append("description", value("productDescription"));
  if (value("productWeight") !== "") form.append("weight_kg", value("productWeight"));
  if (productImage.files[0]) form.append("image", productImage.files[0]);

  const submit = document.getElementById("productSubmit");
  submit.disabled = true;
  submit.classList.add("is-loading");
  try {
    await apiFetch("/products", { method: "POST", body: form });
    closeProductDialog();
    toast("Product listed.", "success");
    await loadProducts();
  } catch (err) {
    productError.textContent = err.message || "Failed to list the product.";
  } finally {
    submit.disabled = false;
    submit.classList.remove("is-loading");
  }
});

/* ---------------------------------------------------------------------
   INIT
   --------------------------------------------------------------------- */
document.getElementById("openAddBtn").hidden = !isAdmin();
if (state.q) els.heroQ.value = state.q;
loadProducts().then(() => {
  if (state.q) document.getElementById("catalog").scrollIntoView();
});
if (isLoggedIn() && !isAdmin()) syncCartFromServer().catch(() => {});
