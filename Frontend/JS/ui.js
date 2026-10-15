/* =====================================================================
   ui.js — shared UI for every page (load after api.js and icons.js).
   - renderHeader(): site header with nav, cart, and the account
     indicator (avatar + username + role badge + menu), or Log in /
     Sign up for visitors. Mobile gets a collapsible menu.
   - toast(), STATUS labels, money/date formatters, escapeHTML(),
     and loading / empty / error state markup for lists and tables.
   Session data (token, role, username) is what login.js stores in
   sessionStorage; the server re-checks the role on every request.
   ===================================================================== */

const UI_ROOT = "../";   // every page lives at Pages/<Section>/<page>.html

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

const PESO = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP", minimumFractionDigits: 2 });
const formatMoney = (value) => PESO.format(Number(value) || 0);
const formatDate = (value) => value ? new Date(value).toLocaleDateString("en-PH", { dateStyle: "medium" }) : "—";
const formatDateTime = (value) => value ? new Date(value).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }) : "—";

/* --- Statuses: one wording for every page ----------------------------- */
const STATUS = {
  pending_payment: "Waiting for payment",
  paid: "Paid",
  packed: "Packed",
  shipped: "Shipped",
  delivered: "Delivered",
  expired: "Expired",
  cancelled: "Cancelled",
  pending: "Pending",
  processing: "Processing",
  completed: "Completed",
  PENDING: "Not booked",
  BOOKED: "Rider booked",
  PICKED_UP: "Handed to courier",
  IN_TRANSIT: "In transit",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  FAILED: "Failed",
  RETURNED: "Returned"
};
const statusBadge = (status) =>
  `<span class="badge" data-status="${escapeHTML(status)}">${escapeHTML(STATUS[status] || status)}</span>`;

/* Stock badge from AVAILABLE stock (on hand minus units held by unpaid orders). */
const LOW_STOCK = 3;
function stockBadge(available) {
  const n = Number(available) || 0;
  if (n <= 0) return `<span class="badge badge--error">Out of stock</span>`;
  if (n <= LOW_STOCK) return `<span class="badge badge--warning">Low stock</span>`;
  return `<span class="badge badge--success">In stock</span>`;
}

/* --- Product card (catalog, related products) ------------------------
   Consistent 4:3 image, name (2 lines max), price, stock badge from
   AVAILABLE stock, Add to cart disabled when out. Image and name link to
   the product page. Admins get a remove button instead of Add to cart. */
const API_ORIGIN = API_BASE_URL.replace(/\/api$/, "");
const imageUrl = (p) => (p ? API_ORIGIN + p : "");
const productUrl = (id) => `${UI_ROOT}Homepage/product.html?id=${encodeURIComponent(id)}`;

function productCard(p, { admin = false } = {}) {
  const available = Number(p.stock) || 0;
  const media = p.image
    ? `<img src="${escapeHTML(imageUrl(p.image))}" alt="${escapeHTML(p.name)}" loading="lazy">`
    : `<span class="product-card__placeholder">${icon("package", { size: 56 })}<span class="sr-only">No photo yet</span></span>`;
  const remove = admin
    ? `<button class="btn btn--secondary btn--sm btn--icon product-card__delete" type="button" data-delete="${p.id}">
         ${icon("trash-2", { size: 16, label: `Remove ${p.name}` })}</button>` : "";
  return `
    <article class="product-card">
      <div class="product-card__media"><a href="${productUrl(p.id)}" tabindex="-1" aria-hidden="true">${media}</a>${remove}</div>
      <div class="product-card__body">
        <div class="product-card__meta"><span class="eyebrow">${escapeHTML(p.category)}</span>${stockBadge(available)}</div>
        <h3 class="product-card__name" title="${escapeHTML(p.name)}"><a href="${productUrl(p.id)}">${escapeHTML(p.name)}</a></h3>
        ${p.brand ? `<span class="product-card__brand">${escapeHTML(p.brand)}</span>` : ""}
        <span class="price product-card__price">${formatMoney(p.price)}</span>
        ${admin ? "" : `
        <button class="btn ${available > 0 ? "btn--primary" : ""} btn--block" type="button" data-add="${p.id}"
                ${available > 0 ? "" : "disabled"}>
          ${available > 0 ? `${icon("shopping-cart", { size: 18 })} Add to cart` : "Out of stock"}
        </button>`}
      </div>
    </article>`;
}

/* --- Chatbot replies (chat widget, admin Chat & FAQs) -------------------
 Escaped text with product links [Name](product:ID), **bold**, "- " lists
 and line breaks. Nothing else becomes HTML. */
function chatTextHTML(text) {
  const lines = escapeHTML(text).split("\n");
  let html = "", list = false;
  for (const raw of lines) {
    const item = /^\s*[-*•]\s+(.*)$/.exec(raw);
    if (item && !list) { html += "<ul>"; list = true; }
    if (!item && list) { html += "</ul>"; list = false; }
    const line = (item ? item[1] : raw)
      .replace(/\[([^\]]{1,200})\]\(product:(\d+)\)/g, (_, label, id) => `<a href="${productUrl(id)}">${label}</a>`)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html += item ? `<li>${line}</li>` : (line.trim() ? `<p>${line}</p>` : "");
  }
  return html + (list ? "</ul>" : "");
}

/* --- List / table states --------------------------------------------- */
const UIState = {
  empty: ({ icon: name = "package-open", title, text = "", action = "" }) => `
    <div class="state">${icon(name, { size: 40 })}<h3>${escapeHTML(title)}</h3>
      ${text ? `<p>${escapeHTML(text)}</p>` : ""}${action}</div>`,
  error: (message, retryId = "") => `
    <div class="state state--error" role="alert">${icon("circle-alert", { size: 40 })}<h3>Something went wrong</h3>
      <p>${escapeHTML(message || "Please check your connection and try again.")}</p>
      ${retryId ? `<button class="btn btn--secondary" type="button" id="${retryId}">${icon("refresh-cw", { size: 16 })} Try again</button>` : ""}</div>`,
  productSkeletons: (count = 8) => Array.from({ length: count }, () => `
    <div class="product-card" aria-hidden="true">
      <span class="skeleton skeleton--media"></span>
      <div class="product-card__body">
        <span class="skeleton skeleton--text skeleton--short"></span>
        <span class="skeleton skeleton--title"></span>
        <span class="skeleton skeleton--text skeleton--tiny"></span>
      </div>
    </div>`).join(""),
  rowSkeletons: (cols, rows = 4) => Array.from({ length: rows }, () =>
    `<tr aria-hidden="true">${`<td><span class="skeleton skeleton--text"></span></td>`.repeat(cols)}</tr>`).join("")
};

/* --- Toasts ----------------------------------------------------------- */
function toast(message, type = "info") {
  let region = document.querySelector(".toast-region");
  if (!region) {
    region = document.createElement("div");
    region.className = "toast-region";
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    document.body.appendChild(region);
  }
  const el = document.createElement("div");
  el.className = `toast toast--${type}`;
  const name = { success: "check", error: "circle-alert", info: "info" }[type] || "info";
  el.innerHTML = `${icon(name, { size: 18 })}<span>${escapeHTML(message)}</span>`;
  region.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

/* --- Session ---------------------------------------------------------- */
const session = {
  get loggedIn() { return isLoggedIn(); },
  get role() { return sessionStorage.getItem("bongalink_role") || ""; },
  get username() { return sessionStorage.getItem("bongalink_username") || ""; },
  logout() {
    ["bongalink_token", "bongalink_logged_in", "bongalink_role", "bongalink_username"]
      .forEach(k => sessionStorage.removeItem(k));
  }
};
const initials = (name) => (String(name).match(/[A-Za-z0-9]/g) || ["?"]).slice(0, 2).join("").toUpperCase();
const ROLE_LABEL = { admin: "Admin", user: "Customer" };

/* --- Header ----------------------------------------------------------- */
// active: "shop" | "orders" | "profile" | "dashboard" | "inventory" | "deliveries" | "rates" | "chat" | "accounts"
// search: true to show the search box (submits to the catalog)
function renderHeader({ active = "", search = true } = {}) {
  const root = document.getElementById("site-header");
  if (!root) return;
  const admin = session.loggedIn && session.role === "admin";
  const links = [
    { key: "shop", href: `${UI_ROOT}Homepage/homepage.html`, label: "Shop", icon: "store" },
    ...(session.loggedIn && !admin ? [{ key: "orders", href: `${UI_ROOT}COpage/orders.html`, label: "My orders", icon: "clipboard-list" }] : []),
    ...(admin ? [
      { key: "dashboard", href: `${UI_ROOT}Admin/dashboard.html`, label: "Dashboard", icon: "layout-dashboard" },
      { key: "inventory", href: `${UI_ROOT}Admin/inventory.html`, label: "Inventory", icon: "boxes" },
      { key: "deliveries", href: `${UI_ROOT}Admin/deliveries.html`, label: "Deliveries", icon: "truck" },
      { key: "rates", href: `${UI_ROOT}Admin/rates.html`, label: "Rates", icon: "landmark" },
      { key: "chat", href: `${UI_ROOT}Admin/chat.html`, label: "Chat & FAQs", icon: "messages-square" },
      { key: "accounts", href: `${UI_ROOT}Admin/accounts.html`, label: "Accounts", icon: "users" }
    ] : [])
  ];
  const toShip = admin ? `<a class="badge badge--warning to-ship" href="${UI_ROOT}Admin/deliveries.html" data-to-ship hidden></a>` : "";
  const nav = `<nav class="site-nav" aria-label="Main">${links.map(l =>
    `<a href="${l.href}"${l.key === active ? ' aria-current="page"' : ""}>${icon(l.icon, { size: 18 })}${l.label}</a>`).join("")}${toShip}</nav>`;

  search = search && !admin;   // the header search is a shopping tool; admins use the Shop link
  const searchBox = search ? `
    <form class="header-search input-icon" role="search" action="${UI_ROOT}Homepage/homepage.html">
      ${icon("search", { size: 18 })}
      <label class="sr-only" for="header-q">Search parts</label>
      <input class="input" id="header-q" name="q" type="search" placeholder="Search printer, laptop and PC parts" autocomplete="off">
    </form>` : "";

  const cart = admin ? "" : `
    <a class="btn btn--ghost btn--icon cart-link" href="${UI_ROOT}COpage/cart.html" aria-label="Cart">
      ${icon("shopping-cart")}<span class="badge badge--count" data-cart-count hidden>0</span>
    </a>`;

  const account = session.loggedIn ? `
    <div class="account">
      <button class="account__button" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="account-menu">
        <span class="avatar" data-role="${escapeHTML(session.role)}">${escapeHTML(initials(session.username))}</span>
        <span class="account__text">
          <span class="account__name">${escapeHTML(session.username)}</span>
          <span class="account__role">${ROLE_LABEL[session.role] || "Customer"}</span>
        </span>
        ${icon("chevron-down", { size: 16 })}
      </button>
      <div class="menu" id="account-menu" hidden>
        <div class="menu__header">
          <strong>${escapeHTML(session.username)}</strong><br>
          <span class="badge ${admin ? "badge--info" : ""}">${ROLE_LABEL[session.role] || "Customer"}</span>
        </div>
        <a href="${UI_ROOT}Account/profile.html">${icon("circle-user", { size: 18 })}My profile</a>
        ${admin
          ? `<a href="${UI_ROOT}Admin/dashboard.html">${icon("layout-dashboard", { size: 18 })}Admin dashboard</a>`
          : `<a href="${UI_ROOT}COpage/orders.html">${icon("clipboard-list", { size: 18 })}My orders</a>`}
        <hr>
        <button type="button" data-logout>${icon("log-out", { size: 18 })}Log out</button>
      </div>
    </div>` : `
    <a class="btn btn--ghost hide-mobile" href="${UI_ROOT}Homepage/login.html">Log in</a>
    <a class="btn btn--primary" href="${UI_ROOT}Homepage/register.html">Sign up</a>`;

  root.className = admin ? "site-header site-header--admin" : "site-header";   // admin: long nav, text-only links
  root.innerHTML = `
    <div class="container site-header__inner">
      <button class="btn btn--ghost btn--icon menu-toggle" type="button" aria-expanded="false" aria-controls="mobile-panel">
        ${icon("menu", { label: "Open menu" })}
      </button>
      <a class="brand" href="${UI_ROOT}Homepage/homepage.html">
        <span class="brand__name">Bongalink</span><span class="brand__since">est. 2008</span>
      </a>
      ${nav}
      ${searchBox}
      <div class="header-actions">${cart}${account}</div>
    </div>
    <div class="mobile-panel" id="mobile-panel" hidden>
      <div class="container">
        ${search ? searchBox.replace('id="header-q"', 'id="header-q-mobile"').replace('for="header-q"', 'for="header-q-mobile"') : ""}
        ${nav}
        ${session.loggedIn ? "" : `<nav class="site-nav" aria-label="Account"><a href="${UI_ROOT}Homepage/login.html">${icon("log-in", { size: 18 })}Log in</a></nav>`}
      </div>
    </div>`;

  // Mobile menu
  const toggle = root.querySelector(".menu-toggle");
  const panel = root.querySelector("#mobile-panel");
  toggle.addEventListener("click", () => {
    const open = panel.hidden;
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.innerHTML = icon(open ? "x" : "menu", { label: open ? "Close menu" : "Open menu" });
  });

  // Account menu: click to open, Esc / outside click to close
  const button = root.querySelector(".account__button");
  if (button) {
    const menu = root.querySelector("#account-menu");
    const setOpen = (open) => { menu.hidden = !open; button.setAttribute("aria-expanded", String(open)); };
    button.addEventListener("click", (e) => { e.stopPropagation(); setOpen(menu.hidden); });
    document.addEventListener("click", (e) => { if (!menu.contains(e.target)) setOpen(false); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") { setOpen(false); button.focus(); } });
    root.querySelector("[data-logout]").addEventListener("click", () => {
      session.logout();
      window.location.href = `${UI_ROOT}Homepage/homepage.html`;
    });
  }

  if (admin) startToShipBadge();
  else if (typeof readCart === "function") paintHeaderCartCount(countOf(readCart()));

  // Keep the search term visible after searching
  const q = new URLSearchParams(location.search).get("q");
  if (q) root.querySelectorAll('input[name="q"]').forEach(i => { i.value = q; });
}

// Cart count bubble (cart.js keeps the local cart mirror).
function paintHeaderCartCount(count) {
  document.querySelectorAll("[data-cart-count]").forEach(el => {
    el.textContent = count;
    el.hidden = !count;
  });
}

/* --- Admin: paid orders waiting to ship -------------------------------
   Header badge linking to Deliveries. The shop also gets an email per
   payment (ADMIN_ALERT_EMAIL); this is the on-screen alert. Polls
   GET /api/v1/admin/orders/to-ship every 30 seconds. */
const TO_SHIP_POLL_MS = 30000;
const BASE_TITLE = document.title;

async function refreshToShipBadge() {
  const { count } = await apiFetch("/v1/admin/orders/to-ship");
  document.querySelectorAll("[data-to-ship]").forEach(el => {
    el.hidden = count === 0;
    el.textContent = count === 1 ? "1 order to ship" : `${count} orders to ship`;
  });
  // Count in the tab title too, so it shows while the admin is on another tab.
  document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
  return count;
}

function startToShipBadge() {
  if (startToShipBadge.timer) return;
  refreshToShipBadge().catch(() => {});
  startToShipBadge.timer = setInterval(() => refreshToShipBadge().catch(() => {}), TO_SHIP_POLL_MS);
}

/* --- Admin pages: show the "admin required" panel instead of the page -- */
function requireAdminPage() {
  if (session.loggedIn && session.role === "admin") return true;
  const main = document.querySelector("main");
  main.innerHTML = `<div class="container page">
    <div class="card">${UIState.empty({ icon: "lock", title: "Admin account required",
      text: "Log in with the shop's admin account to see this page.",
      action: `<a class="btn btn--primary" href="${UI_ROOT}Homepage/login.html">Go to login</a>` })}</div></div>`;
  return false;
}

/* --- Customer pages: send visitors to login and come back afterwards --- */
function requireLoginPage() {
  if (session.loggedIn) return true;
  const back = encodeURIComponent(location.pathname.split("/Pages/")[1] + location.search);
  window.location.href = `${UI_ROOT}Homepage/login.html?next=${back}`;
  return false;
}
