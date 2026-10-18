/* =====================================================================
   BONGALINK — ADMIN ACCOUNTS (Pages/Admin/accounts.html)
   Requires api.js, icons.js, cart.js and ui.js.
     GET    /api/v1/admin/accounts?q&role&status&verified&sort&dir&page
     GET    /api/v1/admin/accounts/summary | /:id | /audit-log
     POST   /api/v1/admin/accounts                         create
     POST   /api/v1/admin/accounts/:id/suspend | unsuspend | role | resend-invite
     DELETE /api/v1/admin/accounts/:id                     delete or anonymize
   Buttons the server would refuse are disabled with the reason shown, but
   the server checks every rule itself (own account, last admin, ...).
   ===================================================================== */

renderHeader({ active: "accounts" });

const $ = (id) => document.getElementById(id);
const acc = { q: "", role: "all", status: "all", verified: "all", sort: "created_at", dir: "desc", page: 1,
              total: 0, perPage: 20, logPage: 1, detail: null, pending: null };

const ROLE = { admin: ["Admin", "info"], user: ["Customer", ""] };
const STATE = { active: ["Active", "success"], invited: ["Invited", "warning"], suspended: ["Suspended", "error"], deleted: ["Deleted", ""] };
const badge = ([label, tone]) => `<span class="badge${tone ? ` badge--${tone}` : ""}">${label}</span>`;
const roleBadge = (r) => badge(ROLE[r] || [r, ""]);
const stateBadge = (s) => badge(STATE[s] || [s, ""]);
const isMe = (a) => a.is_you || a.username === session.username;
const when = (v) => v ? formatDateTime(v) : "Never";

/* ---------------------------------------------------------------------
   SUMMARY
   --------------------------------------------------------------------- */
function setTile(id, value, sub) {
  $(id).querySelector(".stat__value").textContent = value;
  $(id).querySelector(".stat__sub").textContent = sub;
}
async function loadSummary() {
  try {
    const s = await apiFetch("/v1/admin/accounts/summary");
    setTile("statTotal", s.total, "Not counting deleted accounts");
    setTile("statNew", s.new_this_week, "Created in the last 7 days");
    setTile("statAdmins", s.admins, s.admins === 1 ? "The only admin can't be removed" : "Can manage the shop");
    setTile("statSuspended", s.suspended, s.invited ? `${s.invited} invited, password not set yet` : "Can't log in");
  } catch (err) {
    ["statTotal", "statNew", "statAdmins", "statSuspended"].forEach(id => setTile(id, "—", `Couldn't load: ${err.message}`));
  }
}

/* ---------------------------------------------------------------------
   LIST: search, filters, sortable headers, pages
   --------------------------------------------------------------------- */
function accountRowHTML(a) {
  return `
    <tr data-id="${a.user_id}">
      <th scope="row"><button class="link-button" type="button" data-open="${a.user_id}">${escapeHTML(a.username)}</button>
        ${isMe(a) ? `<span class="badge">You</span>` : ""}</th>
      <td class="acc-email">${escapeHTML(a.email)}</td>
      <td>${roleBadge(a.role)}</td>
      <td>${stateBadge(a.status)}</td>
      <td>${a.verified ? `${icon("check", { size: 16, className: "ok-icon" })}<span class="sr-only">Verified</span>` : `<span class="muted">No</span>`}</td>
      <td>${formatDate(a.created_at)}</td>
      <td>${a.last_login_at ? formatDate(a.last_login_at) : `<span class="muted">Never</span>`}</td>
      <td class="num">${a.order_count}</td>
    </tr>`;
}

function renderSortHeaders() {
  document.querySelectorAll("#accTable th[data-sort]").forEach(th => {
    const key = th.dataset.sort;
    const label = th.dataset.label || (th.dataset.label = th.textContent.trim());
    const active = acc.sort === key;
    th.setAttribute("aria-sort", active ? (acc.dir === "asc" ? "ascending" : "descending") : "none");
    th.innerHTML = `<button class="sort-button" type="button" data-sort-key="${key}">${label}
      ${icon(active ? (acc.dir === "asc" ? "arrow-up" : "arrow-down") : "arrow-up-down", { size: 14 })}</button>`;
  });
}

function renderPager(el, page, total, perPage, what) {
  const pages = Math.max(Math.ceil(total / perPage), 1);
  const from = total ? (page - 1) * perPage + 1 : 0;
  const to = Math.min(page * perPage, total);
  el.innerHTML = `<span class="muted">${total ? `${from}–${to} of ${total} ${what}` : `No ${what}`}</span>
    <span class="row">
      <button class="btn btn--secondary btn--sm" type="button" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>${icon("chevron-left", { size: 16 })} Previous</button>
      <span class="muted">Page ${page} of ${pages}</span>
      <button class="btn btn--secondary btn--sm" type="button" data-page="${page + 1}" ${page >= pages ? "disabled" : ""}>Next ${icon("chevron-right", { size: 16 })}</button>
    </span>`;
}

async function loadAccounts() {
  const rows = $("accRows");
  rows.innerHTML = UIState.rowSkeletons(8, 5);
  const p = new URLSearchParams({ q: acc.q, role: acc.role, status: acc.status, verified: acc.verified,
                                  sort: acc.sort, dir: acc.dir, page: acc.page, per_page: acc.perPage });
  try {
    const data = await apiFetch(`/v1/admin/accounts?${p}`);
    acc.total = data.total;
    rows.innerHTML = data.accounts.length ? data.accounts.map(accountRowHTML).join("")
      : `<tr><td colspan="8">${UIState.empty({ icon: "users", title: "No accounts match", text: "Try another search or clear the filters." })}</td></tr>`;
    $("listCount").textContent = `${data.total} account${data.total === 1 ? "" : "s"}`;
    renderPager($("accPager"), data.page, data.total, data.per_page, "accounts");
  } catch (err) {
    rows.innerHTML = `<tr><td colspan="8">${UIState.error(err.message, "retryAccounts")}</td></tr>`;
    $("retryAccounts")?.addEventListener("click", loadAccounts);
  }
}

let accSearchTimer = null;
$("accFilters").addEventListener("submit", (e) => { e.preventDefault(); acc.page = 1; loadAccounts(); });
$("fSearch").addEventListener("input", () => {
  clearTimeout(accSearchTimer);
  accSearchTimer = setTimeout(() => { acc.q = $("fSearch").value.trim(); acc.page = 1; loadAccounts(); }, 300);
});
[["fRole", "role"], ["fStatus", "status"], ["fVerified", "verified"]].forEach(([id, key]) =>
  $(id).addEventListener("change", () => { acc[key] = $(id).value; acc.page = 1; loadAccounts(); }));
$("accTable").querySelector("thead").addEventListener("click", (e) => {
  const b = e.target.closest("[data-sort-key]");
  if (!b) return;
  const key = b.dataset.sortKey;
  acc.dir = acc.sort === key ? (acc.dir === "asc" ? "desc" : "asc") : (["username", "email", "role", "status"].includes(key) ? "asc" : "desc");
  acc.sort = key;
  acc.page = 1;
  renderSortHeaders();
  loadAccounts();
  document.querySelector(`[data-sort-key="${key}"]`)?.focus();
});
$("accPager").addEventListener("click", (e) => {
  const b = e.target.closest("[data-page]");
  if (b && !b.disabled) { acc.page = Number(b.dataset.page); loadAccounts(); }
});
$("accRows").addEventListener("click", (e) => {
  const b = e.target.closest("[data-open]");
  if (b) openDetail(Number(b.dataset.open));
});

/* ---------------------------------------------------------------------
   ACTIVITY LOG
   --------------------------------------------------------------------- */
const ACTION = {
  create_account: "Created the account", resend_invite: "Resent the setup email", suspend: "Suspended", unsuspend: "Unsuspended",
  promote: "Made admin", demote: "Made customer", delete: "Deleted the account", anonymize: "Anonymized the account",
  ml_retrain: "Asked for a forecast update", password_reset: "Reset the password (emailed link)"
};
function changeText(e) {
  const o = e.old_value || {}, n = e.new_value || {};
  if (e.action === "create_account") return `${n.role === "admin" ? "Admin" : "Customer"} account${n.email ? `, ${escapeHTML(n.email)}` : ""}`;
  if (e.action === "anonymize" && n.kept) return `Kept ${n.kept.orders} order${n.kept.orders === 1 ? "" : "s"} for the sales history`;
  if (o.role && n.role) return `Role: ${ROLE[o.role]?.[0] || o.role} → ${ROLE[n.role]?.[0] || n.role}`;
  if (o.status && n.status) return `Status: ${o.status} → ${n.status}`;
  return "";
}
function logEntryHTML(e, { withTarget = true } = {}) {
  const target = withTarget
    ? (e.target_user_id && !String(e.target).startsWith("deleted-user-")
        ? `<button class="link-button" type="button" data-open="${e.target_user_id}">${escapeHTML(e.target)}</button>` : escapeHTML(e.target))
    : "";
  const change = changeText(e);
  return `
    <li class="log-entry">
      <span class="log-entry__when">${formatDateTime(e.created_at)}</span>
      <span class="log-entry__what"><strong>${escapeHTML(e.admin)}</strong> · ${ACTION[e.action] || e.action}${withTarget ? ` · ${target}` : ""}</span>
      ${change ? `<span class="log-entry__change">${change}</span>` : ""}
      ${e.reason ? `<span class="log-entry__reason">Reason: ${escapeHTML(e.reason)}</span>` : ""}
    </li>`;
}

async function loadLog() {
  const p = new URLSearchParams({ page: acc.logPage, per_page: 10 });
  if ($("logAction").value) p.set("action", $("logAction").value);
  try {
    const data = await apiFetch(`/v1/admin/accounts/audit-log?${p}`);
    $("logList").innerHTML = data.entries.length ? `<ol class="log-list">${data.entries.map(e => logEntryHTML(e)).join("")}</ol>`
      : UIState.empty({ icon: "clipboard-list", title: "Nothing logged yet", text: "Suspensions, role changes, new accounts and deletions show up here." });
    renderPager($("logPager"), data.page, data.total, data.per_page, "entries");
  } catch (err) {
    $("logList").innerHTML = UIState.error(err.message);
  }
}
$("logAction").addEventListener("change", () => { acc.logPage = 1; loadLog(); });
$("logPager").addEventListener("click", (e) => {
  const b = e.target.closest("[data-page]");
  if (b && !b.disabled) { acc.logPage = Number(b.dataset.page); loadLog(); }
});
$("logList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-open]");
  if (b) openDetail(Number(b.dataset.open));
});

/* ---------------------------------------------------------------------
   DETAILS
   --------------------------------------------------------------------- */
function actionButton(d, action, label, iconName, tone = "secondary") {
  const c = d.can[action];
  const noteId = `why-${action}`;
  return `<div class="acc-action">
      <button class="btn btn--${tone} btn--sm" type="button" data-action="${action}" ${c.allowed ? "" : `disabled aria-describedby="${noteId}"`}>
        ${icon(iconName, { size: 16 })} ${label}</button>
      ${c.allowed ? "" : `<span class="hint" id="${noteId}">${escapeHTML(c.reason)}</span>`}
    </div>`;
}

function renderDetail(d) {
  const a = d.account;
  $("detailTitle").textContent = a.username;
  if (a.status === "deleted") {
    $("detailBody").innerHTML = `<div class="alert alert--info">${icon("info", { size: 18 })}<span>This account was deleted on
      ${formatDateTime(a.anonymized_at)}. Its personal details were removed; its ${d.order_summary.orders} order${d.order_summary.orders === 1 ? " is" : "s are"}
      kept without them so sales history and forecasts stay correct.</span></div>${historyHTML(d)}`;
    return;
  }
  const isAdminTarget = a.role === "admin";
  $("detailBody").innerHTML = `
    <div class="acc-detail__badges">${roleBadge(a.role)} ${stateBadge(a.status)} ${a.verified ? badge(["Email verified", "success"]) : badge(["Email not verified", ""])}
      ${a.is_you ? badge(["You", ""]) : ""}</div>
    ${a.status === "suspended" ? `<div class="alert alert--error">${icon("user-x", { size: 18 })}<span>Suspended ${formatDateTime(a.suspended_at)}.
      Reason: ${escapeHTML(a.suspended_reason || "—")}</span></div>` : ""}
    ${a.status === "invited" ? `<div class="alert alert--warning">${icon("mail", { size: 18 })}<span>Waiting for ${escapeHTML(a.username)} to set a password from the setup email.</span></div>` : ""}
    <div class="acc-grid">
      <section aria-labelledby="profileTitle">
        <h3 id="profileTitle">Profile</h3>
        <dl class="acc-facts">
          <dt>Email</dt><dd>${escapeHTML(a.email)}</dd>
          <dt>Role</dt><dd>${ROLE[a.role]?.[0] || a.role}</dd>
          <dt>Created</dt><dd>${formatDateTime(a.created_at)}${a.created_by ? ` by ${escapeHTML(a.created_by)}` : " (signed up)"}</dd>
          <dt>Email verified</dt><dd>${a.email_verified_at ? formatDateTime(a.email_verified_at) : "Not yet"}</dd>
          <dt>Last login</dt><dd>${when(a.last_login_at)}</dd>
        </dl>
        <h3>Actions</h3>
        <div class="acc-actions">
          ${a.status === "suspended" ? actionButton(d, "unsuspend", "Unsuspend", "user-check", "primary") : actionButton(d, "suspend", "Suspend", "user-x", "danger")}
          ${isAdminTarget ? actionButton(d, "demote", "Make customer", "user") : actionButton(d, "promote", "Make admin", "shield-check")}
          ${a.status === "invited" ? actionButton(d, "resend_invite", "Resend setup email", "mail") : ""}
          ${actionButton(d, "delete", d.delete_mode === "anonymize" ? "Delete (anonymize)" : "Delete account", "trash-2", "danger")}
        </div>
        <h3>Saved addresses</h3>
        ${d.addresses.length ? `<ul class="acc-addresses">${d.addresses.map(ad => `<li>
            <strong>${escapeHTML(ad.recipient_name)}</strong> · ${escapeHTML(ad.recipient_phone)}${ad.is_default ? ` ${badge(["Default", ""])}` : ""}<br>
            <span class="muted">${escapeHTML([ad.street, ad.barangay, ad.city, ad.province, ad.postal_code].filter(Boolean).join(", "))}</span></li>`).join("")}</ul>`
          : `<p class="muted">No saved addresses.</p>`}
      </section>
      ${historyHTML(d)}
    </div>`;
}

function historyHTML(d) {
  const s = d.order_summary;
  return `<section aria-labelledby="ordersTitle">
      <h3 id="ordersTitle">Orders</h3>
      <p class="muted">${s.orders} order${s.orders === 1 ? "" : "s"} · ${formatMoney(s.paid_total)} paid</p>
      ${d.orders.length ? `<div class="table-wrap"><table class="table table--compact">
        <thead><tr><th scope="col">Order</th><th scope="col">Date</th><th scope="col">Status</th><th scope="col" class="num">Total</th></tr></thead>
        <tbody>${d.orders.map(o => `<tr><td>#${o.order_id}</td><td>${formatDate(o.created_at)}</td><td>${statusBadge(o.status)}</td>
          <td class="num price">${formatMoney(o.total_amount)}</td></tr>`).join("")}</tbody></table></div>` : ""}
      <h3>Activity</h3>
      ${d.activity.length ? `<ol class="log-list log-list--compact">${d.activity.map(e => logEntryHTML(e, { withTarget: false })).join("")}</ol>`
        : `<p class="muted">No admin actions on this account yet.</p>`}
    </section>`;
}

async function openDetail(id, { keepOpen = false } = {}) {
  if (!keepOpen) {
    $("detailTitle").textContent = "Account";
    $("detailBody").innerHTML = `<span class="skeleton skeleton--title"></span><span class="skeleton skeleton--text"></span><span class="skeleton skeleton--text skeleton--short"></span>`;
    if (!$("detailDialog").open) $("detailDialog").showModal();
  }
  try {
    acc.detail = await apiFetch(`/v1/admin/accounts/${id}`);
    renderDetail(acc.detail);
  } catch (err) {
    $("detailBody").innerHTML = UIState.error(err.message);
  }
}

/* ---------------------------------------------------------------------
   CONFIRMING ACTIONS
   --------------------------------------------------------------------- */
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
function confirmSetup(action, d) {
  const a = d.account;
  const name = `<strong>${escapeHTML(a.username)}</strong>`;
  switch (action) {
    case "suspend": return { title: `Suspend ${a.username}?`, button: "Suspend account", tone: "danger", reason: "required",
      text: `<p>${name} is logged out right away on every device and can't log in until you unsuspend the account.
        They'll see “Your account is suspended. Contact the shop.”</p>` };
    case "unsuspend": return { title: `Unsuspend ${a.username}?`, button: "Unsuspend", tone: "primary", reason: "required",
      text: `<p>${name} can log in again.</p>` };
    case "promote": return { title: `Make ${a.username} an admin?`, button: "Make admin", tone: "primary", reason: "optional",
      text: `<p>Admins can manage inventory, orders, deliveries, chats and accounts. ${name} is logged out and gets admin access at their next login.</p>` };
    case "demote": return { title: `Make ${a.username} a customer?`, button: "Make customer", tone: "danger", reason: "optional",
      text: `<p>${name} loses admin access right away and is logged out.</p>` };
    case "resend_invite": return { title: "Resend the setup email?", button: "Send email", tone: "primary", reason: "none",
      text: `<p>We email a new link to <strong>${escapeHTML(a.email)}</strong>. The old link stops working.</p>` };
    case "delete": {
      const r = d.records;
      if (d.delete_mode === "delete") {
        return { title: `Delete ${a.username}?`, button: "Delete account", tone: "danger", reason: "optional", type: true,
          text: `<p>${name} has no orders, so the account is deleted completely: profile, saved addresses and cart.
            This can't be undone.</p>` };
      }
      const kept = [r.orders && plural(r.orders, "order"), r.products_listed && plural(r.products_listed, "listed product"),
                    r.staff_records && plural(r.staff_records, "stock or shipping record")].filter(Boolean).join(", ");
      return { title: `Delete ${a.username}?`, button: "Anonymize account", tone: "danger", reason: "optional", type: true,
        text: `<p>${name} has ${kept}, so deleting the account outright would break the shop's sales history and stock forecasts.
          The account is <strong>anonymized</strong> instead:</p>
          <ul>
            <li>Removed: username, email, password, saved addresses, cart, and the name, phone and street on its orders.</li>
            <li>Kept: the orders, items and payments, under “deleted-user-${a.user_id}”, with only the city and province, so sales
              totals, reports and forecasts stay correct.</li>
          </ul>
          <p>The person can't log in again. This can't be undone.</p>` };
    }
  }
  return null;
}

function setConfirmError(id, text) {
  $(`${id}Error`).textContent = text;
  if (text) $(id).setAttribute("aria-invalid", "true");
  else $(id).removeAttribute("aria-invalid");
}

function openConfirm(action) {
  const d = acc.detail;
  const c = confirmSetup(action, d);
  acc.pending = { action, id: d.account.user_id, username: d.account.username, setup: c };
  $("confirmTitle").textContent = c.title;
  $("confirmText").innerHTML = c.text;
  $("reasonField").hidden = c.reason === "none";
  $("reasonNeed").innerHTML = c.reason === "required" ? `<span class="required">(required)</span>` : `<span class="optional">(optional)</span>`;
  $("confirmReason").value = "";
  $("confirmReason").toggleAttribute("required", c.reason === "required");
  $("typeField").hidden = !c.type;
  $("typeName").textContent = d.account.username;
  $("confirmUsername").value = "";
  ["confirmReason", "confirmUsername"].forEach(id => setConfirmError(id, ""));
  $("confirmError").textContent = "";
  const submit = $("confirmSubmit");
  submit.textContent = c.button;
  submit.className = `btn btn--${c.tone}`;
  $("confirmDialog").showModal();
  (c.reason !== "none" ? $("confirmReason") : submit).focus();
}

$("detailBody").addEventListener("click", (e) => {
  const b = e.target.closest("[data-action]");
  if (b && !b.disabled) openConfirm(b.dataset.action);
});

const DONE = { suspend: "Account suspended. They were logged out.", unsuspend: "Account unsuspended.",
  promote: "Now an admin. They get admin access at their next login.", demote: "Now a customer. Admin access removed.",
  resend_invite: "Setup email sent." };

$("confirmForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const p = acc.pending;
  const reason = $("confirmReason").value.trim();
  if (p.setup.reason === "required" && reason.length < 3) {
    setConfirmError("confirmReason", "Write a reason (at least 3 characters).");
    return $("confirmReason").focus();
  }
  if (p.setup.type && $("confirmUsername").value.trim() !== p.username) {
    setConfirmError("confirmUsername", `Type ${p.username} exactly.`);
    return $("confirmUsername").focus();
  }
  const base = `/v1/admin/accounts/${p.id}`;
  const body = reason ? { reason } : {};
  const request = {
    suspend: [`${base}/suspend`, "POST", body], unsuspend: [`${base}/unsuspend`, "POST", body],
    promote: [`${base}/role`, "POST", { ...body, role: "admin" }], demote: [`${base}/role`, "POST", { ...body, role: "user" }],
    resend_invite: [`${base}/resend-invite`, "POST", {}],
    delete: [base, "DELETE", { ...body, confirm_username: $("confirmUsername").value.trim() }]
  }[p.action];

  const submit = $("confirmSubmit");
  submit.disabled = true;
  submit.classList.add("is-loading");
  try {
    const result = await apiFetch(request[0], { method: request[1], body: JSON.stringify(request[2]),
      ...(p.action === "resend_invite" ? { timeout: API_TIMEOUT_LONG_MS } : {}) });
    $("confirmDialog").close();
    if (p.action === "delete") {
      $("detailDialog").close();
      toast(result.result === "anonymized" ? "Account anonymized. Its orders are kept." : "Account deleted.", "success");
    } else {
      toast(DONE[p.action], "success");
      await openDetail(p.id, { keepOpen: true });
    }
    loadAccounts();
    loadSummary();
    loadLog();
  } catch (err) {
    $("confirmError").textContent = err.message;
  } finally {
    submit.disabled = false;
    submit.classList.remove("is-loading");
  }
});
["confirmReason", "confirmUsername"].forEach(id => $(id).addEventListener("input", () => setConfirmError(id, "")));

/* ---------------------------------------------------------------------
   CREATE
   --------------------------------------------------------------------- */
const USERNAME_OK = /^[A-Za-z0-9_.-]{3,50}$/;
const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function setCreateError(id, text) {
  $(`${id}Error`).textContent = text;
  if (text) $(id).setAttribute("aria-invalid", "true");
  else $(id).removeAttribute("aria-invalid");
}
$("createAccount").addEventListener("click", () => {
  $("createForm").reset();
  ["newUsername", "newEmail"].forEach(id => setCreateError(id, ""));
  $("createError").textContent = "";
  $("createDialog").showModal();
  $("newUsername").focus();
});
["newUsername", "newEmail"].forEach(id => $(id).addEventListener("input", () => setCreateError(id, "")));
$("createForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = $("newUsername").value.trim();
  const email = $("newEmail").value.trim();
  const role = document.querySelector('input[name="newRole"]:checked').value;
  setCreateError("newUsername", USERNAME_OK.test(username) ? "" : "Use 3 to 50 letters, numbers, dots, dashes or underscores.");
  setCreateError("newEmail", EMAIL_OK.test(email) ? "" : "Enter a valid email address.");
  if (!USERNAME_OK.test(username)) return $("newUsername").focus();
  if (!EMAIL_OK.test(email)) return $("newEmail").focus();
  if (role === "admin" && !confirm(`Create ${username} as an ADMIN?\n\nAdmins can manage inventory, orders, deliveries, chats and accounts.`)) return;

  const submit = $("createSubmit");
  submit.disabled = true;
  submit.classList.add("is-loading");
  try {
    const res = await apiFetch("/v1/admin/accounts", { method: "POST", timeout: API_TIMEOUT_LONG_MS, body: JSON.stringify({ username, email, role }) });
    $("createDialog").close();
    toast(res.email_sent ? `Account created. We emailed ${email} a link to set the password.`
      : "Account created, but the email couldn't be sent. Open it and use Resend setup email.", res.email_sent ? "success" : "error");
    acc.page = 1;
    loadAccounts();
    loadSummary();
    loadLog();
  } catch (err) {
    if (/username/i.test(err.message)) { setCreateError("newUsername", err.message); $("newUsername").focus(); }
    else if (/email/i.test(err.message)) { setCreateError("newEmail", err.message); $("newEmail").focus(); }
    else $("createError").textContent = err.message;
  } finally {
    submit.disabled = false;
    submit.classList.remove("is-loading");
  }
});

document.querySelectorAll("dialog [data-close]").forEach(b => b.addEventListener("click", () => b.closest("dialog").close()));

if (requireAdminPage()) {
  renderSortHeaders();
  loadSummary();
  loadAccounts();
  loadLog();
}
