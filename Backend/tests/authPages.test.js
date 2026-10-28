// Login page "Forgot password?" step and the reset page, "Remember me" and logging out,
// in jsdom with a stubbed API.
const { openPage } = require("./pageHarness");

const submit = (page, id) => page.$(id).dispatchEvent(new page.window.Event("submit", { cancelable: true }));
const SAME = "If that email has an account, we've sent a reset link. It works for 30 minutes.";
const TOKEN = "b".repeat(64);

// A login token whose payload the page can read (exp in seconds); the signature isn't checked by the browser.
const fakeJwt = (exp) => `h.${Buffer.from(JSON.stringify({ userId: 3, exp })).toString("base64url")}.s`;
const LOGIN_KEYS = ["bongalink_token", "bongalink_logged_in", "bongalink_role", "bongalink_username"];
const stored = (area) => LOGIN_KEYS.map((k) => area.getItem(k));

describe("Remember me", () => {
  async function loginWith(remember) {
    const token = fakeJwt(Math.floor(Date.now() / 1000) + 3600);
    const page = await openPage("Pages/Homepage/login.html", { role: null, api: async ({ url, body }) =>
      url === "/auth/login" ? { body: { token, remember: body.remember, user: { username: "juan", role: "user" } } } : { body: [] } });
    page.$("#username").value = "juan";
    page.$("#password").value = "secret123";
    page.$("#rememberMe").checked = remember;
    submit(page, "#loginForm");
    await page.until(() => page.calls.length);
    await page.settle();
    return { page, token };
  }

  test("unchecked: the login is kept for this tab only (sessionStorage), as before", async () => {
    const { page, token } = await loginWith(false);
    expect(page.calls[0]).toEqual({ url: "/auth/login", method: "POST", body: { username: "juan", password: "secret123", remember: false } });
    expect(stored(page.window.sessionStorage)).toEqual([token, "true", "user", "juan"]);
    expect(stored(page.window.localStorage)).toEqual([null, null, null, null]);
    page.close();
  });

  test("checked: the login is kept after the browser closes (localStorage)", async () => {
    const { page, token } = await loginWith(true);
    expect(page.calls[0].body.remember).toBe(true);
    expect(stored(page.window.localStorage)).toEqual([token, "true", "user", "juan"]);
    expect(stored(page.window.sessionStorage)).toEqual([null, null, null, null]);
    expect(page.$("#rememberHint").textContent).toContain("30 days");
    page.close();
  });

  test("a new browser session picks up a remembered login and sends its token", async () => {
    const token = fakeJwt(Math.floor(Date.now() / 1000) + 86400 * 20);
    const page = await openPage("Pages/COpage/orders.html", { role: null,
      local: { bongalink_token: token, bongalink_logged_in: "true", bongalink_role: "user", bongalink_username: "maria" },
      api: async () => ({ body: [] }) });
    await page.until(() => page.calls.length);
    expect(page.$(".account__name").textContent).toBe("maria");
    expect(page.window.location.pathname).toContain("orders.html");   // not sent to the login page
    page.close();
  });

  test("a remembered login past its 30 days is dropped before the page uses it", async () => {
    const page = await openPage("Pages/Homepage/homepage.html", { role: null,
      local: { bongalink_token: fakeJwt(Math.floor(Date.now() / 1000) - 60), bongalink_logged_in: "true", bongalink_role: "user", bongalink_username: "maria" },
      api: async () => ({ body: [] }) });
    expect(stored(page.window.localStorage)).toEqual([null, null, null, null]);
    expect(page.$(".account__name")).toBeNull();
    page.close();
  });
});

describe("Log out", () => {
  test("ends the session on the server (this device) and forgets the login, remembered or not", async () => {
    const token = fakeJwt(Math.floor(Date.now() / 1000) + 86400 * 20);
    const fetched = [];
    const page = await openPage("Pages/Homepage/homepage.html", { role: null,
      local: { bongalink_token: token, bongalink_logged_in: "true", bongalink_role: "user", bongalink_username: "maria" },
      api: async () => ({ body: [] }) });
    const realFetch = page.window.fetch;
    page.window.fetch = (url, options = {}) => { fetched.push({ url, options }); return realFetch(url, options); };
    page.$("[data-logout]").click();
    await page.until(() => fetched.some((f) => f.url.endsWith("/auth/logout")));
    await page.settle();   // let the click handler finish (it then goes to the homepage)
    const call = fetched.find((f) => f.url.endsWith("/auth/logout"));
    expect(call.options).toMatchObject({ method: "POST", headers: { Authorization: `Bearer ${token}` }, keepalive: true });
    expect(stored(page.window.localStorage)).toEqual([null, null, null, null]);
    expect(stored(page.window.sessionStorage)).toEqual([null, null, null, null]);
    page.close();
  });
});

describe("login page: Forgot password?", () => {
  test("opens the email form, checks the email next to the field, and shows the same answer", async () => {
    const page = await openPage("Pages/Homepage/login.html", { role: null, api: async () => ({ body: { message: SAME } }) });
    expect(page.$("#forgotStep").hidden).toBe(true);
    page.$("#forgotPassword").click();
    expect(page.$("#loginStep").hidden).toBe(true);
    expect(page.$("#forgotStep").hidden).toBe(false);
    expect(page.doc.activeElement.id).toBe("forgotEmail");

    page.$("#forgotEmail").value = "nope";
    submit(page, "#forgotForm");
    expect(page.$("#forgotEmailError").textContent).toBe("Enter the email address of your account.");
    expect(page.calls).toEqual([]);

    page.$("#forgotEmail").value = "juan@gmail.com";
    submit(page, "#forgotForm");
    await page.until(() => !page.$("#forgotMessage").hidden);
    expect(page.calls).toEqual([{ url: "/auth/forgot-password", method: "POST", body: { email: "juan@gmail.com" } }]);
    expect(page.$("#forgotMessage").textContent).toContain(SAME);

    page.$("#backToLogin").click();
    expect(page.$("#loginStep").hidden).toBe(false);
    page.close();
  });

  test("login.html#forgot opens straight on the reset form (the reset page links there)", async () => {
    const page = await openPage("Pages/Homepage/login.html", { role: null, hash: "forgot", api: async () => ({ body: {} }) });
    expect(page.$("#forgotStep").hidden).toBe(false);
    expect(page.$("#loginStep").hidden).toBe(true);
    page.close();
  });

  test("too many requests are explained", async () => {
    const page = await openPage("Pages/Homepage/login.html", { role: null, api: async () =>
      ({ status: 429, body: { error: "Too many reset requests. Please wait a while and try again.", code: "RATE_LIMITED" } }) });
    page.$("#forgotPassword").click();
    page.$("#forgotEmail").value = "juan@gmail.com";
    submit(page, "#forgotForm");
    await page.until(() => !page.$("#forgotMessage").hidden);
    expect(page.$("#forgotMessage").className).toContain("alert--error");
    expect(page.$("#forgotMessage").textContent).toContain("Too many reset requests.");
    page.close();
  });
});

describe("reset page", () => {
  test("a good link: new password twice (same rules as sign-up), then a link to log in", async () => {
    const page = await openPage("Pages/Homepage/reset-password.html", { role: null, query: `token=${TOKEN}`, api: async ({ method }) =>
      method === "GET" ? { body: { username: "juan" } } : { body: { message: "Your password was changed.", username: "juan" } } });
    await page.until(() => !page.$("#setForm").hidden);
    expect(page.calls[0].url).toBe(`/auth/reset-password?token=${TOKEN}`);
    expect(page.$("h1").textContent).toBe("Choose a new password");
    expect(page.$("#setConsent")).toBeNull();
    page.$("#newPassword").value = "abc";
    submit(page, "#setForm");
    expect(page.$("#newPasswordError").textContent).toBe("Use at least 10 characters for your password.");
    page.$("#newPassword").value = "Newpass-1212";
    page.$("#confirmPassword").value = "Newpass-1313";
    submit(page, "#setForm");
    expect(page.$("#confirmPasswordError").textContent).toBe("The two passwords don't match.");
    page.$("#confirmPassword").value = "Newpass-1212";
    submit(page, "#setForm");
    await page.until(() => !page.$("#setMessage").hidden);
    expect(page.calls[1]).toEqual({ url: "/auth/reset-password", method: "POST", body: { token: TOKEN, password: "Newpass-1212" } });
    expect(page.$("#setMessage").textContent).toContain("every device that was logged in has been logged out");
    expect(page.$('#setMessage a[href="login.html"]').textContent).toBe("Log in as juan");
    page.close();
  });

  test("an expired or used link offers a new one; a suspended account just gets the suspended message", async () => {
    const expired = await openPage("Pages/Homepage/reset-password.html", { role: null, query: `token=${TOKEN}`, api: async () =>
      ({ status: 400, body: { error: "This link is invalid, already used or expired. Ask for a new one from the login page." } }) });
    await expired.until(() => !expired.$("#setMessage").hidden);
    expect(expired.$("#setForm").hidden).toBe(true);
    expect(expired.$('#setMessage a[href="login.html#forgot"]').textContent).toBe("Ask for a new link");
    expired.close();

    const suspended = await openPage("Pages/Homepage/reset-password.html", { role: null, query: `token=${TOKEN}`, api: async () =>
      ({ status: 403, body: { error: "Your account is suspended. Contact the shop.", code: "ACCOUNT_SUSPENDED" } }) });
    await suspended.until(() => !suspended.$("#setMessage").hidden);
    expect(suspended.$("#setMessage").textContent).toContain("Your account is suspended. Contact the shop.");
    expect(suspended.$('#setMessage a[href="login.html#forgot"]')).toBeNull();
    suspended.close();
  });
});
