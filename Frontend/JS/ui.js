/* =====================================================================
   ui.js — shared UI for every page (load after api.js and icons.js).
   - renderHeader(): site header with nav, cart, and the account
     indicator (avatar + username + role badge + menu), or Log in /
     Sign up for visitors. Mobile gets a collapsible menu. Admins also
     get the notification bell (startNotificationBell).
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

/* --- A new password (register, reset, set up, change) ----------------
   The length is checked here so the form answers at once; the server
   checks the full rule. Logging in never checks it. */
const PASSWORD_MIN = 10;
const PASSWORD_MAX_BYTES = 72;
function newPasswordProblem(password) {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters for your password.`;
  // UTF-8 bytes: 1 to 4 per character.
  const bytes = [...password].reduce((n, ch) => { const c = ch.codePointAt(0); return n + (c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4); }, 0);
  if (bytes > PASSWORD_MAX_BYTES) {
    return "That password is too long: use at most 72 characters (fewer if it has emoji or accented letters).";
  }
  return "";
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
  get role() { return authStore.get("bongalink_role") || ""; },
  get username() { return authStore.get("bongalink_username") || ""; },
  logout() { return logOut(); }   // ends this device's session on the server too (api.js)
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

  const bell = admin ? `
    <div class="notif">
      <button class="btn btn--ghost btn--icon notif__button" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="notif-panel" aria-label="Notifications">
        ${icon("bell")}<span class="badge badge--count" data-notif-count hidden>0</span>
      </button>
      <div class="notif-panel" id="notif-panel" role="region" aria-labelledby="notif-title" hidden>
        <div class="notif-panel__head">
          <h2 class="notif-panel__title" id="notif-title">Notifications</h2>
          <button class="btn btn--ghost btn--sm" type="button" data-notif-read-all disabled>Mark all as read</button>
        </div>
        <div class="notif-panel__body" data-notif-list></div>
      </div>
    </div>` : "";

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
      <div class="header-actions">${cart}${bell}${account}</div>
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
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) { setOpen(false); button.focus(); } });
    root.querySelector("[data-logout]").addEventListener("click", async (e) => {
      e.currentTarget.disabled = true;
      await session.logout();
      window.location.href = `${UI_ROOT}Homepage/homepage.html`;
    });
  }

  if (admin) { startToShipBadge(); startNotificationBell(root); }
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
   Header badge linking to Deliveries, refreshed every 30 seconds. */
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

/* --- Admin: notification bell -----------------------------------------
   New notifications arrive live; while the live connection is down the
   unread count is refreshed every 30 seconds and the connection retried
   after 2 s, 4 s, 8 s ... up to a minute.

   One live connection per browser, not one per tab: one tab holds it
   (Web Locks API) and passes each notification to the other tabs over a
   BroadcastChannel; when it closes another tab takes over. Each tab keeps
   its own unread count. Browsers without those APIs give each tab its own
   connection, closed while the tab is hidden. */
const NOTIF_POLL_MS = 30000;
const NOTIF_RETRY_MS = [2000, 4000, 8000, 16000, 30000, 60000];
const NOTIF_CHANNEL = "bongalink-notifications";
const NOTIF_LOCK = "bongalink-notification-stream";
const NOTIF_PAGE_SIZE = 15;
const NOTIF_ICON = {
  sale: "credit-card", payment_review: "circle-alert", orders_expired: "clock", shipment_booked: "truck",
  shipment_delivered: "circle-check", shipment_failed: "triangle-alert", low_stock: "package", out_of_stock: "package-open",
  new_customer: "user-plus", chat_unanswered: "circle-help"
};

// "just now", "2 min ago", "3 h ago", "yesterday", "4 days ago", then the date.
function timeAgo(value) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  return days < 7 ? `${days} days ago` : formatDate(value);
}

// Only links to pages under Pages/ are followed; anything else is ignored.
const notifHref = (link) => (/^[A-Za-z]+\/[A-Za-z0-9_-]+\.html([?#][A-Za-z0-9_=&#-]*)?$/.test(link || "") ? UI_ROOT + link : null);

function startNotificationBell(root) {
  const wrap = root.querySelector(".notif");
  if (!wrap) return;
  startNotificationBell.stop?.();   // the header was drawn again (e.g. the profile page): replace the old bell
  const button = wrap.querySelector(".notif__button");
  const panel = wrap.querySelector("#notif-panel");
  const list = wrap.querySelector("[data-notif-list]");
  const readAll = wrap.querySelector("[data-notif-read-all]");
  const state = { unread: 0, items: null, source: null, attempt: 0, retryTimer: null, pollTimer: null, ended: false,
                  shared: "locks" in navigator && typeof BroadcastChannel === "function",
                  holder: false, live: false, channel: null, release: null, lockAbort: null, onVisibility: null };
  // Tells the other tabs (shared mode only).
  const share = (message) => { try { state.channel?.postMessage(message); } catch (e) { /* channel closed */ } };

  function paintCount() {
    const badge = wrap.querySelector("[data-notif-count]");
    badge.textContent = state.unread > 9 ? "9+" : String(state.unread);
    badge.hidden = state.unread === 0;
    button.setAttribute("aria-label", state.unread ? `Notifications, ${state.unread} unread` : "Notifications");
    readAll.disabled = state.unread === 0;
  }
  const setUnread = (n) => { state.unread = Math.max(0, Number(n) || 0); paintCount(); };

  function paintList() {
    if (!state.items) {
      list.innerHTML = '<div class="notif-panel__loading" aria-hidden="true"><span class="skeleton skeleton--text"></span><span class="skeleton skeleton--text"></span></div>';
      return;
    }
    if (!state.items.length) {
      list.innerHTML = UIState.empty({ icon: "bell", title: "No notifications yet",
        text: "Sales, deliveries, stock alerts, new customers and unanswered chats show up here." });
      return;
    }
    list.innerHTML = `<ul class="notif-list">${state.items.map((n) => {
      const href = notifHref(n.link);
      const tag = href ? "a" : "button";
      const attrs = href ? `href="${escapeHTML(href)}"` : 'type="button"';
      return `<li><${tag} class="notif-item${n.read ? "" : " is-unread"}" ${attrs} data-notif-id="${n.id}" data-type="${escapeHTML(n.type)}">
        <span class="notif-item__icon">${icon(NOTIF_ICON[n.type] || "info", { size: 18 })}</span>
        <span class="notif-item__text">
          <span class="notif-item__title">${n.read ? "" : '<span class="sr-only">Unread: </span>'}${escapeHTML(n.title)}</span>
          ${n.body ? `<span class="notif-item__body">${escapeHTML(n.body)}</span>` : ""}
          <time class="notif-item__time" datetime="${escapeHTML(n.created_at)}">${escapeHTML(timeAgo(n.created_at))}</time>
        </span>
      </${tag}></li>`;
    }).join("")}</ul>`;
  }

  async function loadList() {
    try {
      const data = await apiFetch(`/v1/admin/notifications?per_page=${NOTIF_PAGE_SIZE}`);
      state.items = data.items;
      setUnread(data.unread);
    } catch (err) {
      if (!state.items) {
        list.innerHTML = UIState.error(`Couldn't load notifications: ${err.message}`);
        return;
      }
    }
    paintList();
  }

  const refreshCount = () => apiFetch("/v1/admin/notifications/unread-count").then((d) => setUnread(d.unread)).catch(() => {});

  /* Open / close: the bell button, Esc, a click outside. */
  const isOpen = () => !panel.hidden;
  function setOpen(open, { focusButton = false } = {}) {
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    if (open) {
      paintList();
      loadList().then(() => {
        if (isOpen() && document.activeElement === button) (list.querySelector(".notif-item") || readAll).focus();
      });
    } else if (focusButton) {
      button.focus();
    }
  }
  button.addEventListener("click", (e) => { e.stopPropagation(); setOpen(!isOpen()); });
  document.addEventListener("click", (e) => { if (isOpen() && !wrap.contains(e.target)) setOpen(false); });
  document.addEventListener("keydown", (e) => {
    if (!isOpen()) return;
    if (e.key === "Escape") { setOpen(false, { focusButton: true }); return; }
    // Up/Down move between the items.
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const items = [...list.querySelectorAll(".notif-item")];
      const i = items.indexOf(document.activeElement);
      if (!items.length || (i === -1 && !panel.contains(document.activeElement))) return;
      e.preventDefault();
      items[Math.min(Math.max(i + (e.key === "ArrowDown" ? 1 : -1), 0), items.length - 1)].focus();
    }
  });

  // An item: mark it read for this admin, then open its page.
  list.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-notif-id]");
    if (!el) return;
    e.preventDefault();
    const n = state.items?.find((x) => String(x.id) === el.dataset.notifId);
    if (n && !n.read) {
      n.read = true;
      el.classList.remove("is-unread");
      setUnread(state.unread - 1);
      try {
        setUnread((await apiFetch(`/v1/admin/notifications/${n.id}/read`, { method: "POST" })).unread);
        share({ type: "read", username: session.username });
      } catch (err) { /* still open the page */ }
    }
    if (el.getAttribute("href")) window.location.href = el.getAttribute("href");
  });

  readAll.addEventListener("click", async (e) => {
    e.stopPropagation();
    readAll.disabled = true;
    try {
      setUnread((await apiFetch("/v1/admin/notifications/read-all", { method: "POST" })).unread);
      share({ type: "read", username: session.username });
      state.items?.forEach((n) => { n.read = true; });
      paintList();
    } catch (err) {
      toast(err.message, "error");
      paintCount();
    }
  });

  function onNotification(n) {
    setUnread(state.unread + 1);
    if (state.items && !state.items.some((x) => x.id === n.id)) {
      state.items.unshift(n);
      if (isOpen()) paintList();
    }
    if (n.type === "sale") toast(n.body ? `${n.title} · ${n.body}` : n.title, "success");
  }

  /* Live stream, with polling while it's down. */
  function startPolling() {
    if (!state.pollTimer) state.pollTimer = setInterval(refreshCount, NOTIF_POLL_MS);
  }
  function stopPolling() {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  function retryLater() {
    if (state.ended || state.retryTimer) return;
    const wait = NOTIF_RETRY_MS[Math.min(state.attempt, NOTIF_RETRY_MS.length - 1)];
    state.attempt++;
    state.retryTimer = setTimeout(() => { state.retryTimer = null; connect(); }, wait);
  }
  const pausedWhileHidden = () => !state.shared && document.visibilityState === "hidden";
  function setLive(live) {
    state.live = live;
    share({ type: "live", live });
  }
  async function connect() {
    if (typeof EventSource !== "function") return startPolling();   // very old browser: polling only
    let ticket;
    try {
      ({ ticket } = await apiFetch("/v1/admin/notifications/stream-ticket", { method: "POST" }));
    } catch (err) {
      setLive(false);
      startPolling();
      if (!(err.status === 401 || err.status === 403)) retryLater();
      return;
    }
    if (state.ended) return;                                       // stopped while asking for the ticket
    if (pausedWhileHidden()) return startPolling();                // hidden meanwhile: connect when shown
    const source = new EventSource(`${API_BASE_URL}/v1/admin/notifications/stream?ticket=${encodeURIComponent(ticket)}`);
    state.source = source;
    source.addEventListener("ready", (e) => {
      state.attempt = 0;
      stopPolling();
      state.items = null;   // anything missed while disconnected comes with the next list load
      setUnread(JSON.parse(e.data).unread);
      setLive(true);
    });
    source.addEventListener("notification", (e) => {
      const n = JSON.parse(e.data);
      onNotification(n);
      share({ type: "notification", n });
    });
    // The login stopped working (logged out, suspended, role changed): this request
    // gets the reason, and api.js ends the session if that's what happened.
    // Another tab takes over the stream.
    source.addEventListener("end", () => {
      state.ended = true;
      source.close();
      setLive(false);
      giveUpStream();
      refreshCount();
    });
    // Each ticket works once, so reconnect with a new one instead of letting EventSource retry.
    source.onerror = () => {
      source.close();
      if (state.source === source) state.source = null;
      if (state.ended) return;
      setLive(false);
      startPolling();
      refreshCount();
      retryLater();
    };
  }

  /* Shared mode: one tab holds the stream, the others hear from it. */
  function onShared(message) {
    if (message.type === "hello" && state.holder) share({ type: "live", live: state.live });
    if (message.type === "read" && message.username === session.username) refreshCount();
    if (state.holder) return;
    if (message.type === "notification") onNotification(message.n);
    if (message.type === "live" && message.live) {
      stopPolling();
      state.items = null;
      refreshCount();   // catches up on anything missed while no stream was live
    } else if (message.type === "live") {
      startPolling();
    }
  }
  function giveUpStream() {
    state.holder = false;
    state.release?.();
    state.release = null;
  }
  function startShared() {
    state.channel = new BroadcastChannel(NOTIF_CHANNEL);
    state.channel.onmessage = (e) => onShared(e.data || {});
    state.lockAbort = new AbortController();
    startPolling();                     // until the holder's stream is live
    share({ type: "hello" });
    navigator.locks.request(NOTIF_LOCK, { signal: state.lockAbort.signal }, () => new Promise((release) => {
      if (state.ended) return release();
      state.holder = true;
      state.release = release;
      connect();
    })).catch(() => { /* this bell was stopped while waiting for the stream */ });
  }

  /* Without shared mode: a hidden tab closes its stream and polls instead. */
  function startOwn() {
    state.onVisibility = () => {
      if (state.ended) return;
      if (document.visibilityState === "hidden") {
        state.source?.close();
        state.source = null;
        clearTimeout(state.retryTimer);
        state.retryTimer = null;
        startPolling();
      } else if (!state.source && !state.retryTimer) {
        state.attempt = 0;
        refreshCount();
        connect();
      }
    };
    document.addEventListener("visibilitychange", state.onVisibility);
    if (pausedWhileHidden()) startPolling(); else connect();
  }

  startNotificationBell.stop = () => {
    state.ended = true;
    state.source?.close();
    stopPolling();
    clearTimeout(state.retryTimer);
    if (state.onVisibility) document.removeEventListener("visibilitychange", state.onVisibility);
    state.lockAbort?.abort();
    if (state.holder) setLive(false);
    giveUpStream();
    state.channel?.close();
  };
  paintCount();
  refreshCount();
  if (state.shared) startShared(); else startOwn();
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
