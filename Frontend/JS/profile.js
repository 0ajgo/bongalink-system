/* =====================================================================
   BONGALINK — MY PROFILE (Pages/Account/profile.html)
   Requires api.js, icons.js, cart.js, ui.js and orders.js.
     GET/PATCH /api/v1/account/me          header card + personal info
     POST      /api/v1/account/password    change password
     /api/v1/account/addresses[...]        saved delivery addresses
     /api/v1/auth/verify-email/send|confirm  email verification
     GET       /api/orders                 recent orders (customers only)
   ===================================================================== */

renderHeader({ active: "profile" });

let me = null;
let addresses = [];
let editingAddressId = null;

const $ = (id) => document.getElementById(id);

function busy(button, on) {
  button.disabled = on;
  button.classList.toggle("is-loading", on);
}

/* ---------------------------------------------------------------------
   HEADER CARD
   --------------------------------------------------------------------- */
function renderHead() {
  const admin = me.role === "admin";
  const verified = Boolean(me.email_verified_at);
  $("profileHead").setAttribute("aria-busy", "false");
  $("profileHead").innerHTML = `
    <span class="avatar avatar--lg" data-role="${escapeHTML(me.role)}">${escapeHTML(initials(me.username))}</span>
    <div>
      <div class="row"><h1 id="profileName">${escapeHTML(me.username)}</h1>
        <span class="badge ${admin ? "badge--info" : ""}">${ROLE_LABEL[me.role] || "Customer"}</span></div>
      <div class="profile-head__meta">
        <span class="row">${icon("mail", { size: 16 })}${escapeHTML(me.email)}</span>
        ${verified
          ? `<span class="badge badge--success">${icon("check", { size: 14 })} Email verified</span>`
          : `<span class="badge badge--warning">${icon("triangle-alert", { size: 14 })} Email not verified</span>`}
        <span>Member since ${formatDate(me.created_at)}</span>
      </div>
    </div>`;
  $("verifyPanel").hidden = verified;
  $("verifyEmailLabel").textContent = me.email;
  $("infoUsername").value = me.username;
  $("infoEmail").value = me.email;
  $("infoPasswordField").hidden = true;
}

/* ---------------------------------------------------------------------
   EMAIL VERIFICATION
   --------------------------------------------------------------------- */
$("resendCode").addEventListener("click", async (event) => {
  const button = event.currentTarget;   // currentTarget is null again after an await
  busy(button, true);
  $("verifyMessage").textContent = "";
  try {
    const r = await apiFetch("/v1/auth/verify-email/send", { method: "POST", body: JSON.stringify({ email: me.email }) });
    toast(r.message, "success");
  } catch (err) {
    $("verifyMessage").textContent = err.message;
  } finally {
    busy(button, false);
  }
});

$("verifyForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  busy($("verifySubmit"), true);
  $("verifyMessage").textContent = "";
  try {
    await apiFetch("/v1/auth/verify-email/confirm", {
      method: "POST", body: JSON.stringify({ email: me.email, code: $("verifyCode").value.trim() })
    });
    me = await apiFetch("/v1/account/me");
    renderHead();
    toast("Email verified. You're ready to check out.", "success");
  } catch (err) {
    $("verifyMessage").textContent = err.message;
  } finally {
    busy($("verifySubmit"), false);
  }
});

/* ---------------------------------------------------------------------
   PERSONAL INFO
   --------------------------------------------------------------------- */
$("infoEmail").addEventListener("input", () => {
  $("infoPasswordField").hidden = $("infoEmail").value.trim().toLowerCase() === me.email.toLowerCase();
});

$("infoForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("infoError").textContent = "";
  const body = { username: $("infoUsername").value.trim(), email: $("infoEmail").value.trim() };
  if (!$("infoPasswordField").hidden) body.current_password = $("infoPassword").value;
  busy($("infoSubmit"), true);
  try {
    me = await apiFetch("/v1/account/me", { method: "PATCH", body: JSON.stringify(body) });
    sessionStorage.setItem("bongalink_username", me.username);
    renderHeader({ active: "profile" });
    renderHead();
    $("infoPassword").value = "";
    toast(me.email_changed
      ? (me.email_sent ? "Saved. We sent a verification code to your new email." : "Saved, but the verification email couldn't be sent. Use Resend code.")
      : "Profile saved.", "success");
  } catch (err) {
    $("infoError").textContent = err.message;
  } finally {
    busy($("infoSubmit"), false);
  }
});

/* ---------------------------------------------------------------------
   CHANGE PASSWORD
   --------------------------------------------------------------------- */
$("passwordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("passwordError").textContent = "";
  const current = $("currentPassword").value, next = $("newPassword").value;
  if (next.length < 6) return ($("passwordError").textContent = "New password must be at least 6 characters.");
  if (next !== $("confirmPassword").value) return ($("passwordError").textContent = "The new passwords don't match.");
  busy($("passwordSubmit"), true);
  try {
    await apiFetch("/v1/account/password", { method: "POST", body: JSON.stringify({ current_password: current, new_password: next }) });
    $("passwordForm").reset();
    toast("Password changed.", "success");
  } catch (err) {
    $("passwordError").textContent = err.message;
  } finally {
    busy($("passwordSubmit"), false);
  }
});

/* ---------------------------------------------------------------------
   SAVED ADDRESSES
   --------------------------------------------------------------------- */
const regionLabel = (code) => (PSGC_REGIONS.find(r => r.code === code) || { label: code || "" }).label;

function renderAddresses() {
  $("addressList").innerHTML = addresses.length ? addresses.map(a => `
    <div class="address">
      <div>
        <div class="row"><strong>${escapeHTML(a.recipient_name)}</strong>
          ${a.is_default ? `<span class="badge badge--info">Default</span>` : ""}</div>
        <div>${escapeHTML(a.recipient_phone)}</div>
        <div>${escapeHTML([a.street, a.barangay, a.city, a.province, a.postal_code].filter(Boolean).join(", "))}</div>
        <div class="muted">${escapeHTML(regionLabel(a.region))}${a.landmark ? ` · ${escapeHTML(a.landmark)}` : ""}</div>
      </div>
      <div class="address__actions">
        ${a.is_default ? "" : `<button class="btn btn--ghost btn--sm" type="button" data-default="${a.address_id}">Make default</button>`}
        <button class="btn btn--secondary btn--sm" type="button" data-edit="${a.address_id}">${icon("pencil", { size: 14 })} Edit</button>
        <button class="btn btn--danger btn--sm" type="button" data-remove="${a.address_id}">${icon("trash-2", { size: 14 })} Delete</button>
      </div>
    </div>`).join("")
    : UIState.empty({ icon: "map-pin", title: "No saved addresses", text: "Add one so checkout fills it in for you." });
}

async function loadAddresses() {
  $("addressList").innerHTML = `<span class="skeleton skeleton--text"></span><span class="skeleton skeleton--text skeleton--short"></span>`;
  try {
    addresses = await apiFetch("/v1/account/addresses");
    renderAddresses();
  } catch (err) {
    $("addressList").innerHTML = UIState.error(err.message, "retryAddresses");
    $("retryAddresses").addEventListener("click", loadAddresses);
  }
}

const dialog = $("addressDialog");
const form = $("addressForm");
$("aRegion").innerHTML = `<option value="">Choose a region</option>` +
  PSGC_REGIONS.map(r => `<option value="${r.code}">${r.label}</option>`).join("");

function openAddressDialog(address = null) {
  editingAddressId = address ? address.address_id : null;
  form.reset();
  $("addressError").textContent = "";
  $("addressDialogTitle").textContent = address ? "Edit address" : "Add address";
  if (address) {
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === "checkbox") el.checked = Boolean(address[el.name]);
      else el.value = address[el.name] ?? "";
    }
  }
  dialog.showModal();
}
dialog.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => dialog.close()));
$("addAddress").addEventListener("click", () => openAddressDialog());

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = {};
  for (const el of form.elements) if (el.name) body[el.name] = el.type === "checkbox" ? el.checked : el.value;
  busy($("addressSubmit"), true);
  try {
    await apiFetch(`/v1/account/addresses${editingAddressId ? `/${editingAddressId}` : ""}`,
      { method: editingAddressId ? "PATCH" : "POST", body: JSON.stringify(body) });
    dialog.close();
    toast("Address saved.", "success");
    await loadAddresses();
  } catch (err) {
    $("addressError").textContent = err.message;
  } finally {
    busy($("addressSubmit"), false);
  }
});

$("addressList").addEventListener("click", async (event) => {
  const edit = event.target.closest("[data-edit]");
  if (edit) return openAddressDialog(addresses.find(a => String(a.address_id) === edit.dataset.edit));
  const def = event.target.closest("[data-default]");
  const remove = event.target.closest("[data-remove]");
  if (!def && !remove) return;
  if (remove && !confirm("Delete this address? Past orders keep their own copy.")) return;
  const button = def || remove;
  busy(button, true);
  try {
    addresses = def
      ? await apiFetch(`/v1/account/addresses/${def.dataset.default}/default`, { method: "POST" })
      : await apiFetch(`/v1/account/addresses/${remove.dataset.remove}`, { method: "DELETE" });
    renderAddresses();
    toast(def ? "Default address updated." : "Address deleted.", "success");
  } catch (err) {
    toast(err.message, "error");
    busy(button, false);
  }
});

/* ---------------------------------------------------------------------
   RECENT ORDERS (customers)
   --------------------------------------------------------------------- */
async function loadRecentOrders() {
  const list = $("recentOrders");
  $("ordersSection").hidden = false;
  list.innerHTML = `<span class="skeleton skeleton--text"></span><span class="skeleton skeleton--text skeleton--short"></span>`;
  try {
    const orders = (await apiFetch("/orders")).slice(0, 5);
    list.innerHTML = orders.length
      ? orders.map(o => orderCardMarkup(o, { compact: true })).join("")
      : UIState.empty({ icon: "clipboard-list", title: "No orders yet", text: "Your orders and their delivery status will appear here.",
          action: `<a class="btn btn--primary" href="../Homepage/homepage.html">Browse parts</a>` });
  } catch (err) {
    list.innerHTML = UIState.error(err.message, "retryRecent");
    $("retryRecent").addEventListener("click", loadRecentOrders);
  }
}
wirePayButtons($("recentOrders"), (message) => toast(message, "error"));

/* ---------------------------------------------------------------------
   INIT
   --------------------------------------------------------------------- */
async function init() {
  try {
    me = await apiFetch("/v1/account/me");
  } catch (err) {
    $("profileHead").innerHTML = UIState.error(err.message);
    return;
  }
  renderHead();
  loadAddresses();
  if (me.role !== "admin") loadRecentOrders();
}

if (requireLoginPage()) init();
