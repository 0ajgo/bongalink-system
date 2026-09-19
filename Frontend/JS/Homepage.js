/* =====================================================================
   BONGALINK — HOMEPAGE / PRODUCT CATALOG SCRIPT (backend-connected)
   File: Homepage.js
   Requires api.js to be loaded first (see homepage.html <script> order).
   Powers: homepage.html (catalog grid, category sidebar, search,
           shopping cart, and the admin "List a Product" flow)

   Every array that used to live in localStorage now comes from the
   API, which reads/writes the real MySQL tables:
     products  -> GET/POST/DELETE /api/products
     categories-> GET /api/categories
     cart      -> GET/POST/DELETE /api/cart
     checkout  -> POST /api/orders
   ===================================================================== */

/* ---------------------------------------------------------------------
   1. DOM REFERENCES
   --------------------------------------------------------------------- */
const grid = document.getElementById("grid");
const gridTitle = document.getElementById("gridTitle");
const gridCount = document.getElementById("gridCount");
const catList = document.getElementById("catList");
const searchInput = document.getElementById("searchInput");

const cartLines = document.getElementById("cartLines");
const cartBadge = document.getElementById("cartBadge");
const subtotal = document.getElementById("subtotal");
const total = document.getElementById("total");
const checkoutBtn = document.getElementById("checkoutBtn");

const openAddBtn = document.getElementById("openAddBtn");

// "Admin login required" modal (shown when a non-admin tries to list/delete)
const adminLoginOverlay = document.getElementById("adminLoginOverlay");
const closeAdminLogin = document.getElementById("closeAdminLogin");
const cancelAdminLogin = document.getElementById("cancelAdminLogin");

// "List a Product" modal
const productOverlay = document.getElementById("productOverlay");
const closeProductModal = document.getElementById("closeProductModal");
const cancelProduct = document.getElementById("cancelProduct");
const productForm = document.getElementById("productForm");
const productImage = document.getElementById("productImage");
const imagePreview = document.getElementById("imagePreview");

const toast = document.getElementById("toast");

/* ---------------------------------------------------------------------
   2. STATE
   Populated from the API on load (see section 13, loadCatalog()).
   --------------------------------------------------------------------- */
let products = [];
let categories = [];
let cart = [];

let currentCategory = "All";
let selectedImageFile = null; // the actual File object, sent as multipart/form-data

// The API is served from a different port than the static frontend
// (see api.js), so image paths like "/uploads/x.jpg" need the API's
// origin prepended to resolve correctly.
const API_ORIGIN = API_BASE_URL.replace(/\/api$/, "");
function resolveImageUrl(imagePath) {
  return imagePath ? `${API_ORIGIN}${imagePath}` : "";
}

/* ---------------------------------------------------------------------
   3. AUTH HELPERS — isLoggedIn() / isAdmin() now live in api.js, since
      checkout.html needs them too.
   --------------------------------------------------------------------- */

/* ---------------------------------------------------------------------
   4. FORMAT / ESCAPE HELPERS
   --------------------------------------------------------------------- */
function formatPrice(value) {
  return "₱" + Number(value).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getStockClass(stock) {
  if (stock <= 0) return "stock-out";
  if (stock <= 5) return "stock-low";
  return "stock-ok";
}

function getStockText(stock) {
  if (stock <= 0) return "Out of Stock";
  if (stock <= 5) return "Low Stock";
  return "Available";
}

/* ---------------------------------------------------------------------
   5. RENDER — CATEGORY SIDEBAR (#catList)
   --------------------------------------------------------------------- */
function renderCategories() {
  const categoryCounts = {};
  products.forEach(product => {
    categoryCounts[product.category] = (categoryCounts[product.category] || 0) + 1;
  });

  catList.innerHTML = "";

  const allItem = document.createElement("div");
  allItem.className = "cat" + (currentCategory === "All" ? " active" : "");
  allItem.innerHTML = `<span>All Products</span><span class="n">${products.length}</span>`;
  allItem.addEventListener("click", () => {
    currentCategory = "All";
    renderCategories();
    renderProducts();
  });
  catList.appendChild(allItem);

  categories.forEach(category => {
    const count = categoryCounts[category.name] || 0;
    const item = document.createElement("div");
    item.className = "cat" + (currentCategory === category.name ? " active" : "");
    item.innerHTML = `<span>${escapeHTML(category.name)}</span><span class="n">${count}</span>`;
    item.addEventListener("click", () => {
      currentCategory = category.name;
      renderCategories();
      renderProducts();
    });
    catList.appendChild(item);
  });
}

/* ---------------------------------------------------------------------
   6. RENDER — PRODUCT GRID (#grid)
   Category/search filtering is also applied server-side (see
   loadProducts()), but we keep this client-side filter too so typing
   in the search box feels instant without a round trip per keystroke.
   --------------------------------------------------------------------- */
function renderProducts() {
  const search = (searchInput.value || "").trim().toLowerCase();

  const filtered = products.filter(product => {
    const matchesCategory = currentCategory === "All" || product.category === currentCategory;
    const searchableText = [
      product.name, product.category, product.brand || "", product.description || ""
    ].join(" ").toLowerCase();
    return matchesCategory && searchableText.includes(search);
  });

  grid.innerHTML = "";
  gridTitle.textContent = currentCategory === "All" ? "All Available Products" : currentCategory;
  gridCount.textContent = filtered.length + " product" + (filtered.length === 1 ? "" : "s");

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="empty-grid">
        <strong>No products available</strong>
        <span>${products.length === 0 ? "No products have been listed yet." : "No products match your search."}</span>
      </div>`;
    return;
  }

  filtered.forEach(product => {
    const card = document.createElement("article");
    card.className = "card";

    const stock = Number(product.stock) || 0;
    const imageHTML = product.image
      ? `<img src="${resolveImageUrl(product.image)}" alt="${escapeHTML(product.name)}">`
      : `<span class="glyph">📦</span>`;

    card.innerHTML = `
      <div class="thumb">
        ${imageHTML}
        ${isAdmin() ? `<button class="del" title="Delete product" data-delete="${product.id}">×</button>` : ""}
      </div>
      <div class="card-body">
        <div class="meta-row">
          <span class="cat-label">${escapeHTML(product.category)}</span>
          <span class="stock-pill ${getStockClass(stock)}">${getStockText(stock)}</span>
        </div>
        <h3 class="card-title">${escapeHTML(product.name)}</h3>
        ${product.brand ? `<div class="card-brand">${escapeHTML(product.brand)}</div>` : ""}
        ${product.description ? `<p class="card-description">${escapeHTML(product.description)}</p>` : ""}
        <p class="card-price">${formatPrice(product.price)}</p>
        <button class="add-btn" data-add="${product.id}" ${stock <= 0 ? "disabled" : ""}>
          ${stock <= 0 ? "Out of Stock" : "Add to Cart"}
        </button>
      </div>`;

    grid.appendChild(card);
  });
}

/* ---------------------------------------------------------------------
   7. RENDER — SHOPPING CART SIDEBAR
   --------------------------------------------------------------------- */
function renderCart() {
  cartLines.innerHTML = "";

  if (cart.length === 0) {
    cartLines.innerHTML = `<div class="cart-empty">Your cart is empty.</div>`;
    cartBadge.textContent = "0";
    subtotal.textContent = "₱0.00";
    total.textContent = "₱0.00";
    checkoutBtn.disabled = true;
    return;
  }

  let itemCount = 0;
  let cartTotal = 0;

  cart.forEach(item => {
    itemCount += item.quantity;
    cartTotal += Number(item.price) * item.quantity;

    const line = document.createElement("div");
    line.className = "cart-line";
    const thumb = item.image ? `<img src="${resolveImageUrl(item.image)}" alt="">` : "📦";

    line.innerHTML = `
      <div class="cart-thumb">${thumb}</div>
      <div class="info">
        <div class="t">${escapeHTML(item.name)}</div>
        <div class="q">Qty: ${item.quantity}</div>
      </div>
      <div class="p">${formatPrice(Number(item.price) * item.quantity)}</div>
      <button class="rm" data-remove="${item.id}" title="Remove">×</button>`;

    cartLines.appendChild(line);
  });

  cartBadge.textContent = itemCount;
  subtotal.textContent = formatPrice(cartTotal);
  total.textContent = formatPrice(cartTotal);
  checkoutBtn.disabled = itemCount === 0;
}

/* ---------------------------------------------------------------------
   8. CART ACTIONS — now real API calls against carts/cart_items
   --------------------------------------------------------------------- */
async function loadCart() {
  if (!isLoggedIn()) {
    cart = [];
    renderCart();
    return;
  }
  try {
    cart = await apiFetch("/cart");
  } catch (err) {
    cart = [];
  }
  renderCart();
}

async function addToCart(id) {
  if (!isLoggedIn()) {
    showToast("Please login to add items to your cart.");
    setTimeout(() => { window.location.href = "login.html"; }, 700);
    return;
  }

  try {
    await apiFetch("/cart", {
      method: "POST",
      body: JSON.stringify({ productId: id, quantity: 1 })
    });
    await loadCart();
    const product = products.find(p => String(p.id) === String(id));
    if (product) mirrorAddToLocalCart(product);
    showToast("Product added to cart.");
  } catch (err) {
    showToast(err.message || "Could not add to cart.");
  }
}

async function removeFromCart(id) {
  try {
    await apiFetch(`/cart/${id}`, { method: "DELETE" });
    await loadCart();
    mirrorRemoveFromLocalCart(id);
  } catch (err) {
    showToast(err.message || "Could not remove item.");
  }
}

/* ---------------------------------------------------------------------
   8b. LOCAL CART MIRROR
   cart.html / checkout.html are the canonical review-and-checkout pages
   and read a plain localStorage cart (see cart.js) rather than calling
   the API, so every add/remove above is mirrored into that same
   storage. The products table has no condition/variant columns, so
   those two display fields borrow brand/category instead.
   --------------------------------------------------------------------- */
function toLocalCartItem(product, quantity) {
  return {
    productId: String(product.id),
    name: product.name,
    condition: product.brand || "Standard",
    variant: product.category,
    unitPrice: Number(product.price),
    quantity,
    stockOnHand: Number(product.stock),
    image: resolveImageUrl(product.image)
  };
}

function mirrorAddToLocalCart(product) {
  const localCart = readCart();
  const existing = localCart.find(item => item.productId === String(product.id));
  if (existing) {
    existing.quantity = Math.min(existing.quantity + 1, Number(product.stock));
    existing.stockOnHand = Number(product.stock);
  } else {
    localCart.push(toLocalCartItem(product, 1));
  }
  writeCart(localCart);
  paintCartCount(localCart);
}

function mirrorRemoveFromLocalCart(id) {
  const localCart = readCart().filter(item => item.productId !== String(id));
  writeCart(localCart);
  paintCartCount(localCart);
}

/* ---------------------------------------------------------------------
   9. TOAST NOTIFICATIONS
   --------------------------------------------------------------------- */
function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2200);
}

/* ---------------------------------------------------------------------
   10. ADMIN GATE MODAL ("Admin Login Required")
   --------------------------------------------------------------------- */
function openAdminLogin() {
  adminLoginOverlay.classList.add("open");
}
function closeAdminAccess() {
  adminLoginOverlay.classList.remove("open");
}

/* ---------------------------------------------------------------------
   11. "LIST A PRODUCT" MODAL + FORM
   Submitting this form POSTs multipart/form-data (because of the
   image file) straight to /api/products, which the server-side
   requireAdmin middleware gates — the real enforcement now lives on
   the server, not just in this file.
   --------------------------------------------------------------------- */
function openProductModal() {
  if (!isAdmin()) return openAdminLogin();
  productOverlay.classList.add("open");
}

function closeProduct() {
  productOverlay.classList.remove("open");
  productForm.reset();
  selectedImageFile = null;
  imagePreview.innerHTML = "No image selected";
}

async function deleteProduct(id) {
  if (!isAdmin()) return openAdminLogin();

  const product = products.find(p => p.id === id);
  if (!product) return;
  if (!confirm(`Delete "${product.name}" from the catalog?`)) return;

  try {
    await apiFetch(`/products/${id}`, { method: "DELETE" });
    await loadProducts();
    await loadCart(); // in case the deleted product was in the cart
    showToast("Product deleted.");
  } catch (err) {
    showToast(err.message || "Could not delete product.");
  }
}

// Live preview for the image file picked in the "List a Product" form
productImage.addEventListener("change", function () {
  const file = this.files[0];

  if (!file) {
    selectedImageFile = null;
    imagePreview.innerHTML = "No image selected";
    return;
  }
  if (!file.type.startsWith("image/")) {
    showToast("Please select an image file.");
    this.value = "";
    return;
  }

  selectedImageFile = file;
  const reader = new FileReader();
  reader.onload = event => {
    imagePreview.innerHTML = `<img src="${event.target.result}" alt="Product preview">`;
  };
  reader.readAsDataURL(file);
});

// Submit handler — builds multipart/form-data and POSTs to /api/products
productForm.addEventListener("submit", async function (event) {
  event.preventDefault();

  if (!isAdmin()) {
    closeProduct();
    openAdminLogin();
    return;
  }

  const name = document.getElementById("productName").value.trim();
  const category = document.getElementById("productCategory").value;
  const brand = document.getElementById("productBrand").value.trim();
  const price = document.getElementById("productPrice").value;
  const stock = document.getElementById("productStock").value;
  const description = document.getElementById("productDescription").value.trim();

  if (!name || !category || price === "" || stock === "") {
    showToast("Please complete all required fields.");
    return;
  }

  const formData = new FormData();
  formData.append("name", name);
  formData.append("category", category);
  formData.append("brand", brand);
  formData.append("price", price);
  formData.append("stock", stock);
  formData.append("description", description);
  if (selectedImageFile) formData.append("image", selectedImageFile);

  try {
    await apiFetch("/products", { method: "POST", body: formData });
    await loadProducts();
    closeProduct();
    showToast("Product successfully added.");
  } catch (err) {
    showToast(err.message || "Failed to add product.");
  }
});

/* ---------------------------------------------------------------------
   12. EVENT LISTENERS (delegated where possible)
   --------------------------------------------------------------------- */
grid.addEventListener("click", event => {
  const addButton = event.target.closest("[data-add]");
  if (addButton) return addToCart(addButton.dataset.add);

  const deleteButton = event.target.closest("[data-delete]");
  if (deleteButton) deleteProduct(deleteButton.dataset.delete);
});

cartLines.addEventListener("click", event => {
  const removeButton = event.target.closest("[data-remove]");
  if (removeButton) removeFromCart(removeButton.dataset.remove);
});

searchInput.addEventListener("input", renderProducts);

openAddBtn.addEventListener("click", () => {
  isAdmin() ? openProductModal() : openAdminLogin();
});

closeAdminLogin.addEventListener("click", closeAdminAccess);
cancelAdminLogin.addEventListener("click", closeAdminAccess);
closeProductModal.addEventListener("click", closeProduct);
cancelProduct.addEventListener("click", closeProduct);

adminLoginOverlay.addEventListener("click", event => {
  if (event.target === adminLoginOverlay) closeAdminAccess();
});
productOverlay.addEventListener("click", event => {
  if (event.target === productOverlay) closeProduct();
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    closeAdminAccess();
    closeProduct();
  }
});

// Checkout — hands off to checkout.html, which collects delivery/payment
// details and is the canonical place an order actually gets placed.
checkoutBtn.addEventListener("click", () => {
  if (cart.length === 0) return;

  if (!isLoggedIn()) {
    showToast("Please login before checking out.");
    setTimeout(() => { window.location.href = "login.html"; }, 700);
    return;
  }

  window.location.href = "../COpage/checkout.html";
});

document.getElementById("aboutLink").addEventListener("click", event => {
  event.preventDefault();
  showToast("Bongalink Product Catalog");
});

/* ---------------------------------------------------------------------
   13. LOAD DATA FROM THE API + INITIAL RENDER
   --------------------------------------------------------------------- */
async function loadProducts() {
  try {
    products = await apiFetch("/products");
  } catch (err) {
    products = [];
    showToast("Could not load products. Is the API running?");
  }
  renderCategories();
  renderProducts();
}

async function loadCategories() {
  try {
    categories = await apiFetch("/categories");
  } catch (err) {
    categories = [];
  }
}

async function loadCatalog() {
  await loadCategories();
  await loadProducts();
  await loadCart();
  paintCartCount(readCart());
}

loadCatalog();