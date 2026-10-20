// Admin Accounts page, the set-password page, and what customers see when they're
// suspended or logged out by an account change - in jsdom with a stubbed API.
const { openPage } = require("./pageHarness");

const account = (id, extra = {}) => ({ user_id: id, username: `user${id}`, email: `user${id}@example.com`, role: "user",
  status: "active", verified: true, created_at: "2026-10-01T08:00:00Z", last_login_at: "2026-10-14T08:00:00Z", order_count: 2, ...extra });
const summary = { total: 57, admins: 1, new_this_week: 4, suspended: 2, invited: 1 };
const allowed = { allowed: true, reason: null };
const detail = (extra = {}) => ({
  account: { ...account(5, { username: "maria" }), email_verified_at: "2026-10-01T09:00:00Z", suspended_at: null, suspended_reason: null,
             created_by: null, anonymized_at: null, is_you: false },
  addresses: [{ address_id: 1, recipient_name: "Maria Santos", recipient_phone: "09171234567", street: "1 Rizal St", barangay: "Pembo",
                city: "Makati", province: null, postal_code: "1218", is_default: 1 }],
  orders: [{ order_id: 41, status: "delivered", total_amount: 1950, created_at: "2026-10-10T08:00:00Z", units: 2 }],
  order_summary: { orders: 1, paid_total: 1950 },
  activity: [{ audit_id: 3, admin: "owner", action: "suspend", reason: "Chargeback", old_value: { status: "active" },
               new_value: { status: "suspended" }, created_at: "2026-10-12T08:00:00Z", target: "maria", target_user_id: 5 }],
  can: { suspend: allowed, unsuspend: { allowed: false, reason: "This account isn't suspended." }, promote: allowed,
         demote: { allowed: false, reason: "This account is already a customer." }, delete: allowed,
         resend_invite: { allowed: false, reason: "This account has already set its password." } },
  delete_mode: "anonymize", records: { orders: 1, products_listed: 0, staff_records: 0 },
  ...extra
});

function adminApi({ detailBody = detail(), answers = {} } = {}) {
  return async (call) => {
    const { url, method } = call;
    const key = `${method} ${url.split("?")[0]}`;
    if (answers[key]) return answers[key](call);
    if (url === "/v1/admin/accounts/summary") return { body: summary };
    if (url.startsWith("/v1/admin/accounts/audit-log")) {
      return { body: { entries: [{ audit_id: 9, admin: "owner", action: "promote", target: "pedro", target_user_id: 7, reason: "New staff",
        old_value: { role: "user" }, new_value: { role: "admin" }, created_at: "2026-10-14T08:00:00Z" }], total: 1, page: 1, per_page: 10 } };
    }
    if (url.startsWith("/v1/admin/accounts?")) {
      return { body: { accounts: [account(1, { username: "owner", role: "admin", order_count: 0 }), account(5, { username: "maria" }),
        account(6, { username: "pedro", status: "suspended", verified: false, last_login_at: null })], total: 45, page: 1, per_page: 20 } };
    }
    if (/^\/v1\/admin\/accounts\/\d+$/.test(url) && method === "GET") return { body: detailBody };
    if (url.startsWith("/v1/admin/accounts")) return { body: { ok: true, result: "anonymized" } };
    if (url === "/v1/admin/orders/to-ship") return { body: { count: 0 } };
    return { body: {} };
  };
}

const open = async (opts) => {
  const page = await openPage("Pages/Admin/accounts.html", { role: "admin", username: "owner", api: adminApi(opts) });
  await page.until(() => page.$("#accRows [data-open]") && page.$("#logList .log-entry"));
  return page;
};
const listCalls = (page) => page.calls.filter(c => c.url.startsWith("/v1/admin/accounts?"));
const submit = (page, id) => page.$(id).dispatchEvent(new page.window.Event("submit", { cancelable: true }));

describe("Accounts page", () => {
  test("tiles, the list with its columns, You badge, and the activity log", async () => {
    const page = await open();
    expect(page.$('.site-nav a[aria-current="page"]').textContent.trim()).toBe("Accounts");
    expect(page.$("#statTotal .stat__value").textContent).toBe("57");
    expect(page.$("#statNew .stat__value").textContent).toBe("4");
    expect(page.$("#statAdmins .stat__sub").textContent).toBe("The only admin can't be removed");
    expect(page.$("#statSuspended .stat__sub").textContent).toBe("1 invited, password not set yet");
    expect(page.$$("#accTable thead th").map(th => th.textContent.trim()))
      .toEqual(["Username", "Email", "Role", "Status", "Verified", "Created", "Last login", "Orders"]);
    const owner = page.$('#accRows tr[data-id="1"]');
    expect(owner.textContent).toContain("You");
    expect(owner.textContent).toContain("Admin");
    const pedro = page.$('#accRows tr[data-id="6"]').textContent.replace(/\s+/g, " ");
    expect(pedro).toContain("Suspended");
    expect(pedro).toContain("Never");
    expect(page.$("#accPager").textContent).toContain("1–20 of 45 accounts");
    expect(page.$("#logList").textContent.replace(/\s+/g, " ")).toContain("owner · Made admin · pedro");
    expect(page.$("#logList").textContent).toContain("Role: Customer → Admin");
    expect(page.$("#logList").textContent).toContain("Reason: New staff");
    page.close();
  });

  test("search, filters, sortable headers (with aria-sort) and paging send the right queries", async () => {
    const page = await open();
    expect(listCalls(page)[0].url).toBe("/v1/admin/accounts?q=&role=all&status=all&verified=all&sort=created_at&dir=desc&page=1&per_page=20");
    expect(page.$('th[data-sort="created_at"]').getAttribute("aria-sort")).toBe("descending");

    page.$('[data-sort-key="username"]').click();
    await page.until(() => listCalls(page).length === 2);
    expect(listCalls(page)[1].url).toContain("sort=username&dir=asc");
    expect(page.$('th[data-sort="username"]').getAttribute("aria-sort")).toBe("ascending");
    page.$('[data-sort-key="username"]').click();
    await page.until(() => listCalls(page).length === 3);
    expect(listCalls(page)[2].url).toContain("sort=username&dir=desc");

    page.$("#fStatus").value = "suspended";
    page.$("#fStatus").dispatchEvent(new page.window.Event("change"));
    page.$("#fRole").value = "admin";
    page.$("#fRole").dispatchEvent(new page.window.Event("change"));
    page.$("#fVerified").value = "no";
    page.$("#fVerified").dispatchEvent(new page.window.Event("change"));
    await page.until(() => listCalls(page).length === 6);
    expect(listCalls(page)[5].url).toContain("role=admin&status=suspended&verified=no");

    page.$("#fSearch").value = "maria@";
    page.$("#fSearch").dispatchEvent(new page.window.Event("input"));
    await page.until(() => listCalls(page).some(c => c.url.includes("q=maria%40")), 500);
    page.$('#accPager [data-page="2"]').click();
    await page.until(() => listCalls(page).some(c => c.url.includes("page=2")));
    await page.settle();
    page.close();
  });

  test("details: profile, saved addresses, orders, activity; buttons it can't use say why", async () => {
    const page = await open();
    page.$('[data-open="5"]').click();
    await page.until(() => page.$("#detailBody .acc-facts"));
    expect(page.$("#detailDialog").open).toBe(true);
    expect(page.$("#detailTitle").textContent).toBe("maria");
    const body = page.$("#detailBody").textContent.replace(/\s+/g, " ");
    expect(body).toContain("user5@example.com");
    expect(body).toContain("Maria Santos");
    expect(body).toContain("#41");
    expect(body).toContain("1 order · ₱1,950.00 paid");
    expect(body).toContain("owner · Suspended");
    expect(body).toContain("Reason: Chargeback");
    expect(page.$('[data-action="promote"]').disabled).toBe(false);
    expect(page.$('[data-action="delete"]').textContent).toContain("Delete (anonymize)");
    page.close();
  });

  test("own account: Suspend, Make customer and Delete are disabled with the reason", async () => {
    const self = detail({ account: { ...detail().account, username: "owner", role: "admin", is_you: true },
      can: { suspend: { allowed: false, reason: "You can't suspend your own account." }, unsuspend: { allowed: false, reason: "x" },
             promote: { allowed: false, reason: "This account is already an admin." },
             demote: { allowed: false, reason: "You can't remove admin access from your own account." },
             delete: { allowed: false, reason: "You can't delete your own account." }, resend_invite: { allowed: false, reason: "x" } } });
    const page = await open({ detailBody: self });
    page.$('[data-open="1"]').click();
    await page.until(() => page.$('[data-action="suspend"]'));
    for (const [action, why] of [["suspend", "You can't suspend your own account."], ["demote", "You can't remove admin access from your own account."],
                                 ["delete", "You can't delete your own account."]]) {
      const b = page.$(`[data-action="${action}"]`);
      expect(b.disabled).toBe(true);
      expect(page.$(`#${b.getAttribute("aria-describedby")}`).textContent).toBe(why);
    }
    page.close();
  });

  test("suspending needs a reason, shown next to the field; then it's sent and everything reloads", async () => {
    const page = await open();
    page.$('[data-open="5"]').click();
    await page.until(() => page.$('[data-action="suspend"]'));
    page.$('[data-action="suspend"]').click();
    expect(page.$("#confirmDialog").open).toBe(true);
    expect(page.$("#confirmTitle").textContent).toBe("Suspend maria?");
    expect(page.$("#confirmText").textContent).toContain("Your account is suspended. Contact the shop.");
    expect(page.$("#reasonNeed").textContent).toBe("(required)");

    submit(page, "#confirmForm");
    expect(page.$("#confirmReasonError").textContent).toBe("Write a reason (at least 3 characters).");
    expect(page.$("#confirmReason").getAttribute("aria-invalid")).toBe("true");
    expect(page.calls.some(c => c.method === "POST")).toBe(false);

    page.$("#confirmReason").value = "Chargeback dispute";
    submit(page, "#confirmForm");
    await page.until(() => page.calls.some(c => c.method === "POST"));
    expect(page.calls.find(c => c.method === "POST")).toEqual({ url: "/v1/admin/accounts/5/suspend", method: "POST", body: { reason: "Chargeback dispute" } });
    await page.until(() => !page.$("#confirmDialog").open && listCalls(page).length === 2);
    expect(page.doc.body.textContent).toContain("Account suspended. They were logged out.");
    await page.settle();
    page.close();
  });

  test("a refusal from the server (e.g. last admin) is shown in the dialog", async () => {
    const page = await open({ answers: { "POST /v1/admin/accounts/5/role": () => ({ status: 409,
      body: { error: "maria is the last active admin. Make another account an admin first.", code: "LAST_ADMIN" } }) } });
    page.$('[data-open="5"]').click();
    await page.until(() => page.$('[data-action="promote"]'));
    page.$('[data-action="promote"]').click();
    expect(page.$("#reasonNeed").textContent).toBe("(optional)");
    submit(page, "#confirmForm");
    await page.until(() => page.$("#confirmError").textContent);
    expect(page.$("#confirmError").textContent).toBe("maria is the last active admin. Make another account an admin first.");
    expect(page.$("#confirmDialog").open).toBe(true);
    page.close();
  });

  test("delete with orders explains anonymizing and needs the username typed", async () => {
    const page = await open();
    page.$('[data-open="5"]').click();
    await page.until(() => page.$('[data-action="delete"]'));
    page.$('[data-action="delete"]').click();
    const text = page.$("#confirmText").textContent.replace(/\s+/g, " ");
    expect(text).toContain("maria has 1 order, so deleting the account outright would break the shop's sales history and stock forecasts.");
    expect(text).toContain("anonymized");
    expect(text).toContain("Kept: the orders, items and payments, under “deleted-user-5”");
    expect(page.$("#confirmSubmit").textContent).toBe("Anonymize account");
    expect(page.$("#typeField").hidden).toBe(false);

    page.$("#confirmUsername").value = "Maria";
    submit(page, "#confirmForm");
    expect(page.$("#confirmUsernameError").textContent).toBe("Type maria exactly.");
    page.$("#confirmUsername").value = "maria";
    page.$("#confirmReason").value = "Customer asked to delete";
    submit(page, "#confirmForm");
    await page.until(() => page.calls.some(c => c.method === "DELETE"));
    expect(page.calls.find(c => c.method === "DELETE")).toEqual({ url: "/v1/admin/accounts/5", method: "DELETE",
      body: { reason: "Customer asked to delete", confirm_username: "maria" } });
    await page.until(() => !page.$("#detailDialog").open);
    expect(page.doc.body.textContent).toContain("Account anonymized. Its orders are kept.");
    await page.settle();
    page.close();
  });

  test("delete without orders says it's deleted completely", async () => {
    const page = await open({ detailBody: detail({ delete_mode: "delete", records: { orders: 0, products_listed: 0, staff_records: 0 } }) });
    page.$('[data-open="5"]').click();
    await page.until(() => page.$('[data-action="delete"]'));
    page.$('[data-action="delete"]').click();
    expect(page.$("#confirmText").textContent).toContain("has no orders, so the account is deleted completely");
    expect(page.$("#confirmSubmit").textContent).toBe("Delete account");
    page.close();
  });

  test("create account: checks the fields next to them, then creates and emails", async () => {
    const page = await open();
    page.$("#createAccount").click();
    expect(page.$("#createDialog").open).toBe(true);
    submit(page, "#createForm");
    expect(page.$("#newUsernameError").textContent).toBe("Use 3 to 50 letters, numbers, dots, dashes or underscores.");
    page.$("#newUsername").value = "ana.reyes";
    page.$("#newEmail").value = "not-an-email";
    submit(page, "#createForm");
    expect(page.$("#newEmailError").textContent).toBe("Enter a valid email address.");
    page.$("#newEmail").value = "ana@example.com";
    page.$('input[name="newRole"][value="admin"]').checked = true;
    submit(page, "#createForm");
    await page.until(() => page.calls.some(c => c.method === "POST"));
    expect(page.calls.find(c => c.method === "POST")).toEqual({ url: "/v1/admin/accounts", method: "POST",
      body: { username: "ana.reyes", email: "ana@example.com", role: "admin" } });
    await page.until(() => !page.$("#createDialog").open);
    await page.settle();
    page.close();
  });

  test("a duplicate username from the server is shown under Username", async () => {
    const page = await open({ answers: { "POST /v1/admin/accounts": () => ({ status: 409, body: { error: "That username is already taken." } }) } });
    page.$("#createAccount").click();
    page.$("#newUsername").value = "maria";
    page.$("#newEmail").value = "m2@example.com";
    submit(page, "#createForm");
    await page.until(() => page.$("#newUsernameError").textContent);
    expect(page.$("#newUsernameError").textContent).toBe("That username is already taken.");
    page.close();
  });

  test("customers see 'Admin account required' and no account data is loaded", async () => {
    const page = await openPage("Pages/Admin/accounts.html", { role: "user", api: adminApi() });
    expect(page.$("main").textContent).toContain("Admin account required");
    expect(page.calls.some(c => c.url.includes("/admin/accounts"))).toBe(false);
    page.close();
  });

  test("the Dashboard shows the Accounts tile and links to the page", async () => {
    const page = await openPage("Pages/Admin/dashboard.html", { role: "admin", api: async (call) =>
      call.url === "/v1/admin/accounts/summary" ? { body: summary } : { status: 500, body: { error: "not stubbed" } } });
    await page.until(() => page.$("#statAccounts .stat__value").textContent === "57");
    expect(page.$("#statAccounts .stat__sub").textContent).toBe("4 new this week · 2 suspended · 1 admin");
    expect(page.$("#statAccounts").getAttribute("href")).toBe("accounts.html");
    expect(page.$$(".site-nav a").map(a => a.textContent.trim())).toContain("Accounts");
    page.close();
  });
});

describe("suspended or logged out", () => {
  test("a suspended answer ends the session (token, role and name cleared)", async () => {
    const page = await openPage("Pages/COpage/orders.html", { role: "user", api: async ({ url }) =>
      url === "/orders" ? { status: 403, body: { error: "Your account is suspended. Contact the shop.", code: "ACCOUNT_SUSPENDED" } } : { body: [] } });
    await page.until(() => !page.window.sessionStorage.getItem("bongalink_token"));
    expect(["bongalink_token", "bongalink_logged_in", "bongalink_role", "bongalink_username"]
      .map(k => page.window.sessionStorage.getItem(k))).toEqual([null, null, null, null]);
    page.close();
  });

  test("the login page explains why", async () => {
    const page = await openPage("Pages/Homepage/login.html", { role: null, query: "ended=suspended", api: async () => ({ body: {} }) });
    expect(page.$("#loginMessage").hidden).toBe(false);
    expect(page.$("#loginMessage").textContent).toContain("Your account is suspended. Contact the shop.");
    page.close();
    const again = await openPage("Pages/Homepage/login.html", { role: null, query: "ended=ended", api: async () => ({ body: {} }) });
    expect(again.$("#loginMessage").textContent).toContain("Your session has ended. Please log in again.");
    again.close();
  });
});

describe("set-password page", () => {
  const TOKEN = "a".repeat(64);
  test("a good link shows the username; passwords must match; then it's set", async () => {
    const page = await openPage("Pages/Homepage/set-password.html", { role: null, query: `token=${TOKEN}`, api: async ({ url, method }) =>
      method === "GET" ? { body: { username: "ana.reyes" } } : { body: { message: "Password set.", username: "ana.reyes" } } });
    await page.until(() => !page.$("#setForm").hidden);
    expect(page.calls[0].url).toBe(`/auth/set-password?token=${TOKEN}`);
    expect(page.$("#setUsername").value).toBe("ana.reyes");
    page.$("#newPassword").value = "abc";
    submit(page, "#setForm");
    expect(page.$("#newPasswordError").textContent).toBe("Use at least 10 characters for your password.");
    page.$("#newPassword").value = "goodpass-111";
    page.$("#confirmPassword").value = "goodpass-222";
    submit(page, "#setForm");
    expect(page.$("#confirmPasswordError").textContent).toBe("The two passwords don't match.");
    page.$("#confirmPassword").value = "goodpass-111";
    submit(page, "#setForm");
    // The privacy notice has to be accepted, with the error next to the checkbox.
    expect(page.$("#setConsentError").textContent).toBe("Please accept the Privacy Policy to finish setting up your account.");
    expect(page.calls).toHaveLength(1);
    page.$("#setConsent").checked = true;
    submit(page, "#setForm");
    await page.until(() => !page.$("#setMessage").hidden);
    expect(page.calls[1]).toEqual({ url: "/auth/set-password", method: "POST", body: { token: TOKEN, password: "goodpass-111", privacy_consent: true } });
    expect(page.$("#setMessage").textContent).toContain("Your password is set and your email is confirmed.");
    expect(page.$("#setMessage a").getAttribute("href")).toBe("login.html");
    page.close();
  });

  test("an expired link says so and shows no form", async () => {
    const page = await openPage("Pages/Homepage/set-password.html", { role: null, query: "token=bad", api: async () =>
      ({ status: 400, body: { error: "This link is invalid, already used or expired. Ask the shop to send a new one." } }) });
    await page.until(() => !page.$("#setMessage").hidden);
    expect(page.$("#setForm").hidden).toBe(true);
    expect(page.$("#setMessage").textContent).toContain("Ask the shop to send a new one.");
    page.close();
  });
});

describe("registration privacy notice and the Privacy Policy page", () => {
  const fill = (page) => {
    page.$("#regUsername").value = "ana";
    page.$("#regEmail").value = "ana@example.com";
    page.$("#regPassword").value = "secret-pass-123";
    page.$("#regConfirmPassword").value = "secret-pass-123";
  };

  test("the notice says what's collected and why, links the policy, and consent is required", async () => {
    const page = await openPage("Pages/Homepage/register.html", { role: null, api: async () => ({ status: 201, body: { emailSent: true } }) });
    const notice = page.$("#privacyNotice").textContent.replace(/\s+/g, " ");
    expect(notice).toContain("username, email and password");
    expect(notice).toContain("name, mobile number, delivery address and map pin");
    expect(notice).toContain("stored encrypted");
    expect(notice).toContain("Data Privacy Act of 2012");
    expect(page.$('#privacyNotice a[href="privacy.html"]')).not.toBeNull();

    fill(page);
    submit(page, "#registerForm");
    expect(page.$("#regConsentError").textContent).toBe("Please accept the Privacy Policy to create an account.");
    expect(page.$("#regConsent").getAttribute("aria-invalid")).toBe("true");
    expect(page.calls).toEqual([]);

    page.$("#regConsent").checked = true;
    page.$("#regConsent").dispatchEvent(new page.window.Event("change"));
    expect(page.$("#regConsentError").textContent).toBe("");
    submit(page, "#registerForm");
    await page.until(() => page.calls.length);
    expect(page.calls[0]).toEqual({ url: "/auth/register", method: "POST",
      body: { username: "ana", email: "ana@example.com", password: "secret-pass-123", privacy_consent: true } });
    await page.settle();
    page.close();
  });

  test("the Privacy Policy page covers collection, sharing, protection, retention and rights", async () => {
    const page = await openPage("Pages/Homepage/privacy.html", { role: null, api: async () => ({ body: [] }) });
    expect(page.$$(".policy h2").map((h) => h.textContent)).toEqual(
      ["Who we are", "What we collect, and why", "Who we share it with", "How we protect it", "How long we keep it", "Your rights", "Changes to this policy"]);
    const text = page.$(".policy").textContent;
    expect(text).toContain("AES-256-GCM");
    expect(text).toContain("National Privacy Commission");
    expect(page.$(".placeholder").textContent).toContain("data protection officer");
    expect(page.$('#site-header .brand')).not.toBeNull();
    page.close();
  });
});
