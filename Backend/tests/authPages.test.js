// Login page "Forgot password?" step and the reset page, in jsdom with a stubbed API.
const { openPage } = require("./pageHarness");

const submit = (page, id) => page.$(id).dispatchEvent(new page.window.Event("submit", { cancelable: true }));
const SAME = "If that email has an account, we've sent a reset link. It works for 30 minutes.";
const TOKEN = "b".repeat(64);

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

    page.$("#forgotEmail").value = "juan@example.com";
    submit(page, "#forgotForm");
    await page.until(() => !page.$("#forgotMessage").hidden);
    expect(page.calls).toEqual([{ url: "/auth/forgot-password", method: "POST", body: { email: "juan@example.com" } }]);
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
    page.$("#forgotEmail").value = "juan@example.com";
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
    expect(page.$("#newPasswordError").textContent).toBe("Use at least 6 characters.");
    page.$("#newPassword").value = "newpass12";
    page.$("#confirmPassword").value = "newpass13";
    submit(page, "#setForm");
    expect(page.$("#confirmPasswordError").textContent).toBe("The two passwords don't match.");
    page.$("#confirmPassword").value = "newpass12";
    submit(page, "#setForm");
    await page.until(() => !page.$("#setMessage").hidden);
    expect(page.calls[1]).toEqual({ url: "/auth/reset-password", method: "POST", body: { token: TOKEN, password: "newpass12" } });
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
