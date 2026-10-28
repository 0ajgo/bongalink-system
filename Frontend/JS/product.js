/* Product page (product.html?id=<id>). Requires api.js, icons.js, cart.js
   and ui.js. Before adding to the cart the product is fetched again, so a
   customer who left the page open sees a clear message if stock changed. */

renderHeader({ active: "shop" });

const $ = (id) => document.getElementById(id);
const view = $("productView");
const productId = new URLSearchParams(location.search).get("id");
let product = null;
let photoIndex = 0;

/* ---------------------------------------------------------------------
   STATES
   --------------------------------------------------------------------- */
function showSkeleton() {
  view.setAttribute("aria-busy", "true");
  view.innerHTML = `
    <div class="product product-skeleton" aria-hidden="true">
      <span class="skeleton skeleton--media skeleton--square"></span>
      <div class="product__info">
        <span class="skeleton skeleton--text skeleton--short"></span>
        <span class="skeleton skeleton--title"></span>
        <span class="skeleton skeleton--title skeleton--tiny"></span>
        <span class="skeleton skeleton--text"></span><span class="skeleton skeleton--text"></span>
      </div>
    </div>`;
}

function showNotFound() {
  document.title = "Part not found — Bongalink";
  view.setAttribute("aria-busy", "false");
  view.innerHTML = `<div class="card">${UIState.empty({ icon: "package-open", title: "We can't find that part",
    text: "It may have been removed from the catalog, or the link is incomplete.",
    action: `<a class="btn btn--primary" href="homepage.html#catalog">Browse all parts</a>` })}</div>`;
}

function showError(message) {
  view.setAttribute("aria-busy", "false");
  view.innerHTML = `<div class="card">${UIState.error(message, "retryProduct")}</div>`;
  $("retryProduct").addEventListener("click", load);
}

/* ---------------------------------------------------------------------
   PRODUCT
   --------------------------------------------------------------------- */
function stockText(available) {
  if (available <= 0) return "This part is sold out for now.";
  if (available <= LOW_STOCK) return `Only ${available} left.`;
  return `${available} available.`;
}

function render() {
  const p = product;
  const available = Number(p.stock) || 0;
  const photos = p.images || [];
  photoIndex = 0;   // the gallery starts on the first photo
  document.title = `${p.name} — Bongalink`;
  view.setAttribute("aria-busy", "false");

  $("breadcrumb").innerHTML = `
    <li><a href="homepage.html">Home</a></li>
    <li><a href="homepage.html?category=${encodeURIComponent(p.category)}#catalog">${escapeHTML(p.category)}</a></li>
    <li><span aria-current="page">${escapeHTML(p.name)}</span></li>`;

  const buy = isAdmin()
    ? `<div class="product__buy"><a class="btn btn--secondary" href="../Admin/inventory.html?edit=${p.id}">${icon("pencil", { size: 18 })} Edit this part</a></div>`
    : `<div class="product__buy">
        <div class="stepper" role="group" aria-label="Quantity">
          <button type="button" id="qtyDown" ${available <= 1 ? "disabled" : ""}>${icon("minus", { size: 18, label: "Decrease quantity" })}</button>
          <input type="number" id="qty" value="${available > 0 ? 1 : 0}" min="1" max="${Math.max(available, 1)}" aria-label="Quantity" ${available > 0 ? "" : "disabled"}>
          <button type="button" id="qtyUp" ${available <= 1 ? "disabled" : ""}>${icon("plus", { size: 18, label: "Increase quantity" })}</button>
        </div>
        <button class="btn ${available > 0 ? "btn--primary" : ""} btn--lg" type="button" id="addToCart" ${available > 0 ? "" : "disabled"}>
          ${available > 0 ? `${icon("shopping-cart", { size: 18 })} Add to cart` : "Out of stock"}
        </button>
      </div>`;

  view.innerHTML = `
    <article class="product">
      ${galleryMarkup(p, photos)}

      <div class="product__info">
        <span class="eyebrow">${escapeHTML(p.category)}</span>
        <h1>${escapeHTML(p.name)}</h1>
        ${p.brand ? `<span class="product__brand">by ${escapeHTML(p.brand)}</span>` : ""}
        <span class="product__price price">${formatMoney(p.price)}</span>
        <div class="product__stock">${stockBadge(available)}<span>${stockText(available)}</span></div>
        <div id="stockAlert" role="alert"></div>
        ${buy}
        ${!isAdmin() && typeof ChatWidget !== "undefined" ? `<button class="btn btn--secondary" type="button" id="askAbout">${icon("message-circle", { size: 18 })} Ask about this part</button>` : ""}
        <dl class="product__facts">
          <dt>Parcel weight</dt><dd>${Number(p.weight_kg)} kg</dd>
          <dt>Delivery</dt><dd>J&amp;T and LBC nationwide · Lalamove same-day in Metro Manila</dd>
          <dt>Payment</dt><dd>GCash, QR Ph or online banking through PayMongo</dd>
        </dl>
        <div class="product__description">
          <h2>Description</h2>
          <p class="product__desc-text">${p.description ? escapeHTML(p.description) : `<span class="muted">No description yet. Use “Ask about this part” to check compatibility.</span>`}</p>
        </div>
      </div>
    </article>`;
  wireProduct();
}

function setQty(value) {
  const available = Number(product.stock) || 0;
  const q = Math.min(Math.max(Math.round(Number(value)) || 1, 1), Math.max(available, 1));
  $("qty").value = q;
  $("qtyDown").disabled = q <= 1;
  $("qtyUp").disabled = q >= available;
  return q;
}

function stockAlert(html, tone = "warning") {
  $("stockAlert").innerHTML = html ? `<div class="alert alert--${tone}">${icon(tone === "success" ? "check" : "triangle-alert", { size: 18 })}<span>${html}</span></div>` : "";
}

function wireProduct() {
  wireGallery();
  if (isAdmin()) return;
  $("askAbout")?.addEventListener("click", () => ChatWidget.askAbout({ id: product.id, name: product.name }));
  $("qtyDown").addEventListener("click", () => setQty(Number($("qty").value) - 1));
  $("qtyUp").addEventListener("click", () => setQty(Number($("qty").value) + 1));
  $("qty").addEventListener("change", () => setQty($("qty").value));
  $("addToCart").addEventListener("click", addToCart);
}

async function addToCart() {
  if (!isLoggedIn()) {
    toast("Log in to add parts to your cart.", "info");
    setTimeout(() => { location.href = `login.html?next=${encodeURIComponent(`Homepage/product.html?id=${productId}`)}`; }, 900);
    return;
  }
  const button = $("addToCart");
  const wanted = Number($("qty").value);
  button.disabled = true;
  button.classList.add("is-loading");
  try {
    // Stock may have changed while the page was open: check before adding.
    const fresh = await apiFetch(`/products/${encodeURIComponent(productId)}`);
    const before = Number(product.stock);
    const now = Number(fresh.stock);
    if (now !== before || now < wanted) {
      product = fresh;
      render();
      if (now <= 0) return stockAlert("This part just sold out since you opened the page.", "error");
      if (now < wanted) {
        setQty(now);
        return stockAlert(`Stock changed since you opened this page: only ${now} available now. We set the quantity to ${now} — add again to confirm.`);
      }
      stockAlert(`Stock changed since you opened this page: ${now} available now.`);
    }
    const cart = await cartApi.add(productId, wanted);
    const inCart = cart.find(i => i.productId === String(productId));
    toast(`${product.name} added to your cart.`, "success");
    if (inCart && inCart.quantity < wanted) {
      stockAlert(`Your cart now has ${inCart.quantity}, the most available.`);
    }
  } catch (err) {
    if (err.status === 404) return showNotFound();
    toast(err.message || "Could not add to cart.", "error");
  } finally {
    const b = $("addToCart");
    if (b) { b.classList.remove("is-loading"); b.disabled = !(Number(product.stock) > 0); }
  }
}

/* ---------------------------------------------------------------------
   PHOTOS — the gallery swipes (scroll-snap); the counter, thumbnails,
   arrows and arrow keys move it; tapping a photo opens the full-screen
   viewer, where a tap zooms 2x.
   --------------------------------------------------------------------- */
const scrollBehavior = () => (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");
// Which photo a swipe row shows, and moving it to a photo.
const shownIndex = (track) => Math.round(track.scrollLeft / Math.max(track.clientWidth, 1));
function scrollToPhoto(track, i, behavior = scrollBehavior()) {
  const left = i * track.clientWidth;
  if (track.scrollTo) track.scrollTo({ left, behavior });
  else track.scrollLeft = left;
}
// Calls fn(index) once a swipe settles on a photo.
function onSwipe(track, fn) {
  let frame = 0;
  track.addEventListener("scroll", () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => fn(shownIndex(track)));
  }, { passive: true });
}

function galleryMarkup(p, photos) {
  if (!photos.length) {
    return `<div class="gallery"><div class="gallery__track"><div class="gallery__slide frame" id="mainPhoto">
      ${icon("package", { size: 96 })}<span class="sr-only">No photo yet</span></div></div></div>`;
  }
  const n = photos.length;
  const arrow = (dir, label) => `<button class="btn btn--secondary btn--icon gallery__arrow gallery__arrow--${dir}" type="button"
      data-step="${dir === "prev" ? -1 : 1}">${icon("chevron-right", { size: 18, label, className: dir === "prev" ? "flip" : "" })}</button>`;
  return `
    <div class="gallery">
      <div class="gallery__stage">
        <div class="gallery__track" id="galleryTrack" role="group" aria-roledescription="carousel" aria-label="Photos of ${escapeHTML(p.name)}">
          ${photos.map((src, i) => `
          <button class="gallery__slide frame" type="button" data-open="${i}" ${i === 0 ? 'id="mainPhoto"' : ""}
                  aria-label="Photo ${i + 1} of ${n}: open full screen">
            <img src="${escapeHTML(imageUrl(src))}" alt="" ${i ? 'loading="lazy"' : ""}></button>`).join("")}
        </div>
        ${n > 1 ? `${arrow("prev", "Previous photo")}${arrow("next", "Next photo")}
        <span class="gallery__count" id="galleryCount" aria-hidden="true">1 / ${n}</span>` : ""}
      </div>
      ${n > 1 ? `<div class="gallery__thumbs" role="list">${photos.map((src, i) => `
        <button class="gallery__thumb frame" type="button" role="listitem" data-photo="${i}" aria-current="${i === 0}"
                aria-label="Show photo ${i + 1} of ${n}"><img src="${escapeHTML(imageUrl(src))}" alt=""></button>`).join("")}</div>` : ""}
    </div>`;
}

// The gallery shows photo i: counter and thumbnails follow.
function markPhoto(i) {
  photoIndex = i;
  const count = $("galleryCount");
  if (count) count.textContent = `${i + 1} / ${product.images.length}`;
  view.querySelectorAll("[data-photo]").forEach(b => b.setAttribute("aria-current", String(Number(b.dataset.photo) === i)));
}

function selectPhoto(i, behavior) {
  const n = product.images.length;
  const track = $("galleryTrack");
  if (!n || !track) return;
  const next = Math.min(Math.max(i, 0), n - 1);
  markPhoto(next);
  scrollToPhoto(track, next, behavior);
}

function wireGallery() {
  const track = $("galleryTrack");
  if (!track) return;
  onSwipe(track, (i) => { if (i !== photoIndex) markPhoto(i); });
  view.querySelectorAll("[data-photo]").forEach(b => b.addEventListener("click", () => selectPhoto(Number(b.dataset.photo))));
  view.querySelectorAll(".gallery__arrow").forEach(b => b.addEventListener("click", () => selectPhoto(photoIndex + Number(b.dataset.step))));
  track.querySelectorAll("[data-open]").forEach(b => b.addEventListener("click", () => openPhoto(Number(b.dataset.open))));
  track.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    selectPhoto(photoIndex + (e.key === "ArrowLeft" ? -1 : 1));
    track.querySelector(`[data-open="${photoIndex}"]`)?.focus({ preventScroll: true });
  });
}

/* --- Full-screen viewer --------------------------------------------- */
const dialog = $("photoDialog");
const viewerTrack = $("viewerTrack");
let viewerIndex = 0;
let lastZoomAt = 0;

function viewerMark(i) {
  viewerIndex = i;
  const n = product.images.length;
  $("viewerCount").textContent = `${i + 1} / ${n}`;
  $("photoPrev").disabled = i === 0;
  $("photoNext").disabled = i === n - 1;
}

function unzoom() {
  viewerTrack.classList.remove("is-zoomed");
  viewerTrack.querySelectorAll(".is-zoomed").forEach(s => s.classList.remove("is-zoomed"));
}

// Tap / click toggles 2x on the point tapped; a double-tap counts once (taps 300 ms apart).
function toggleZoom(slide, event) {
  const now = Date.now();
  if (now - lastZoomAt < 300) return;
  lastZoomAt = now;
  if (slide.classList.contains("is-zoomed")) return unzoom();
  const box = slide.getBoundingClientRect();
  const x = event.clientX - box.left, y = event.clientY - box.top;
  slide.classList.add("is-zoomed");
  viewerTrack.classList.add("is-zoomed");
  slide.scrollLeft = x * 2 - box.width / 2;
  slide.scrollTop = y * 2 - box.height / 2;
}

function viewerGo(i) {
  const n = product.images.length;
  if (i < 0 || i >= n) return;
  unzoom();
  viewerMark(i);
  scrollToPhoto(viewerTrack, i);
}

function openPhoto(i) {
  const photos = product.images;
  $("photoDialogTitle").textContent = product.name;
  viewerTrack.innerHTML = photos.map((src, k) => `
    <div class="viewer__slide"><img src="${escapeHTML(imageUrl(src))}" alt="${escapeHTML(product.name)}, photo ${k + 1} of ${photos.length}"></div>`).join("");
  const many = photos.length > 1;
  $("photoPrev").hidden = $("photoNext").hidden = !many;
  viewerMark(i);
  dialog.showModal();
  scrollToPhoto(viewerTrack, i, "auto");
}

onSwipe(viewerTrack, (i) => { if (dialog.open && i !== viewerIndex && !viewerTrack.classList.contains("is-zoomed")) viewerMark(i); });
viewerTrack.addEventListener("click", (e) => {
  const slide = e.target.closest(".viewer__slide");
  if (e.target.tagName === "IMG" && slide) toggleZoom(slide, e);
  else dialog.close();                        // the dark area around the photo
});
dialog.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    viewerGo(viewerIndex + (e.key === "ArrowLeft" ? -1 : 1));
  }
});
// Closing (×, Esc, the dark area) leaves the gallery on the photo last seen.
dialog.addEventListener("close", () => {
  unzoom();
  selectPhoto(viewerIndex, "auto");
});
$("photoPrev").addEventListener("click", () => viewerGo(viewerIndex - 1));
$("photoNext").addEventListener("click", () => viewerGo(viewerIndex + 1));
dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());

/* ---------------------------------------------------------------------
   RELATED — same category, in stock first, up to 4
   --------------------------------------------------------------------- */
async function loadRelated() {
  try {
    const list = (await apiFetch(`/products?category=${encodeURIComponent(product.category)}`))
      .filter(p => String(p.id) !== String(product.id))
      .sort((a, b) => (Number(b.stock) > 0) - (Number(a.stock) > 0))
      .slice(0, 4);
    $("relatedSection").hidden = list.length === 0;
    $("relatedTitle").textContent = `More ${product.category}`;
    $("relatedGrid").innerHTML = list.map(p => productCard(p, { admin: isAdmin() })).join("");
  } catch {
    $("relatedSection").hidden = true;   // related parts are optional
  }
}

$("relatedGrid").addEventListener("click", async (event) => {
  const add = event.target.closest("[data-add]");
  if (!add) return;
  if (!isLoggedIn()) return addToCart();   // same login prompt
  add.disabled = true;
  add.classList.add("is-loading");
  try {
    await cartApi.add(add.dataset.add, 1);
    toast("Added to your cart.", "success");
  } catch (err) {
    toast(err.message || "Could not add to cart.", "error");
  } finally {
    add.disabled = false;
    add.classList.remove("is-loading");
  }
});

/* ---------------------------------------------------------------------
   LOAD
   --------------------------------------------------------------------- */
async function load() {
  if (!/^\d+$/.test(productId || "")) return showNotFound();
  showSkeleton();
  try {
    product = await apiFetch(`/products/${productId}`);
  } catch (err) {
    return err.status === 404 ? showNotFound() : showError(err.message);
  }
  render();
  loadRelated();
}

load();
if (isLoggedIn() && !isAdmin()) syncCartFromServer().catch(() => {});
