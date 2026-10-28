// The rule for NEW passwords (lib/passwordRule.js): register, reset, set up and change refuse a
// weak one with code WEAK_PASSWORD; logging in with an older, weaker password still works.
jest.mock("../services/mailer", () => require("./mailerMock")());

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const rateLimits = require("../lib/rateLimit");
const { newPasswordProblem, MESSAGES } = require("../lib/passwordRule");
const { hashToken } = require("../services/accountSetup");
const { pool, resetDb, createUser } = require("./helpers");
const { openPage } = require("./pageHarness");

beforeEach(async () => {
  await resetDb();
  await rateLimits.resetAll();
});
afterAll(() => pool.end());

const weak = (reason) => ({ error: MESSAGES[reason], code: "WEAK_PASSWORD" });
const GOOD = "Tamang-kape7";

describe("newPasswordProblem", () => {
  test("at least 10 characters", () => {
    expect(newPasswordProblem("Abcdef-12")).toEqual(weak("short"));
    expect(newPasswordProblem("")).toEqual(weak("short"));
    expect(newPasswordProblem(undefined)).toEqual(weak("short"));
    expect(newPasswordProblem(12345678901)).toEqual(weak("short"));
    expect(newPasswordProblem("Abcdef-123")).toBeNull();
  });

  test("at most 72 bytes, the part bcrypt actually checks", () => {
    expect(newPasswordProblem("Aa1-" + "a".repeat(68))).toBeNull();                 // 72 bytes
    expect(newPasswordProblem("Aa1-" + "a".repeat(69))).toEqual(weak("long"));
    expect(newPasswordProblem("Aa1-" + "é".repeat(34))).toBeNull();                  // 4 + 68 bytes
    expect(newPasswordProblem("Aa1-" + "é".repeat(34) + "b")).toEqual(weak("long"));
    expect(newPasswordProblem("Aa1-" + "x".repeat(62) + "😀😀")).toEqual(weak("long"));   // 66 + 8
  });

  test("an uppercase letter, a lowercase letter, a number and a symbol — each with its own message", () => {
    expect(newPasswordProblem("tamang-kape7")).toEqual(weak("upper"));
    expect(newPasswordProblem("TAMANG-KAPE7")).toEqual(weak("lower"));
    expect(newPasswordProblem("Tamang-kape")).toEqual(weak("number"));
    expect(newPasswordProblem("Tamangkape7")).toEqual(weak("symbol"));
    expect(newPasswordProblem("Tamang kape7")).toBeNull();          // a space counts as a symbol
    expect(newPasswordProblem(GOOD)).toBeNull();
    expect(new Set(["short", "long", "upper", "lower", "number", "symbol", "personal", "common"].map((r) => MESSAGES[r])).size).toBe(8);
  });

  test("not the username or the email's name (3+ characters), ignoring case", () => {
    const account = { username: "JuanDC", email: "maria.santos@gmail.com" };
    expect(newPasswordProblem("My-juandc-2026", account)).toEqual(weak("personal"));
    expect(newPasswordProblem("Hi-MARIA.SANTOS9", account)).toEqual(weak("personal"));
    expect(newPasswordProblem("Hi-maria-santos9", account)).toBeNull();          // not the exact name
    expect(newPasswordProblem("My-juandc-2026")).toBeNull();                      // no account given
    // Names shorter than 3 characters are not checked (they'd rule out too many passwords).
    expect(newPasswordProblem("Jo-tamang-kape7", { username: "jo", email: "al@gmail.com" })).toBeNull();
    expect(newPasswordProblem("Abc-tamang-kape7", { username: "ABC" })).toEqual(weak("personal"));
  });

  test("not a well-known password (any case) or one character repeated", () => {
    expect(newPasswordProblem("P@ssw0rd123")).toEqual(weak("common"));
    expect(newPasswordProblem("p@SSW0RD123")).toEqual(weak("common"));
    expect(newPasswordProblem("Password123")).toEqual(weak("symbol"));             // fails an earlier rule first
  });
});

describe("every way to set a new password applies it", () => {
  test("register: each rule, and the username / email name", async () => {
    const register = (password, username = "ana_r") => request(app).post("/api/auth/register")
      .send({ username, email: "ana.reyes@gmail.com", password, privacy_consent: true });
    expect((await register("tamang-kape7")).body).toEqual(weak("upper"));
    expect((await register("Tamangkape7")).body).toEqual(weak("symbol"));
    expect((await register("Ana_R-tamang7")).body).toEqual(weak("personal"));
    expect((await register("Ana.Reyes-2026")).body).toEqual(weak("personal"));
    expect((await pool.query("SELECT COUNT(*) AS n FROM users"))[0][0].n).toBe(0);
    expect((await register(GOOD)).status).toBe(201);
  });

  test("reset link and account setup link (the general rules are checked before the link, so no token is used up)", async () => {
    const reset = await request(app).post("/api/auth/reset-password").send({ token: "abc", password: "short" });
    expect(reset.status).toBe(400);
    expect(reset.body).toEqual(weak("short"));
    const setup = await request(app).post("/api/auth/set-password").send({ token: "abc", password: "tamang-kape7", privacy_consent: true });
    expect(setup.status).toBe(400);
    expect(setup.body).toEqual(weak("upper"));
  });

  test("reset link and setup link: not the account's username or email name; the link stays usable", async () => {
    const u = await createUser({ email: "pedro.cruz@gmail.com" });
    const link = async (purpose) => {
      const token = crypto.randomBytes(32).toString("hex");
      await pool.query("INSERT INTO password_setup_tokens (user_id, token_hash, purpose, expires_at) VALUES (?, ?, ?, NOW() + INTERVAL 1 HOUR)",
        [u.id, hashToken(token), purpose]);
      return token;
    };
    const resetToken = await link("reset");
    const r1 = await request(app).post("/api/auth/reset-password").send({ token: resetToken, password: `X-${u.username}-77` });
    expect(r1.body).toEqual(weak("personal"));
    const r2 = await request(app).post("/api/auth/reset-password").send({ token: resetToken, password: "X-Pedro.Cruz-77" });
    expect(r2.body).toEqual(weak("personal"));
    expect((await request(app).post("/api/auth/reset-password").send({ token: resetToken, password: GOOD })).status).toBe(200);

    await pool.query("UPDATE users SET must_set_password = 1 WHERE user_id = ?", [u.id]);
    const setupToken = await link("setup");
    const s1 = await request(app).post("/api/auth/set-password").send({ token: setupToken, password: "X-pedro.cruz-77", privacy_consent: true });
    expect(s1.body).toEqual(weak("personal"));
    expect((await request(app).post("/api/auth/set-password").send({ token: setupToken, password: GOOD, privacy_consent: true })).status).toBe(200);
  });

  test("change in the profile", async () => {
    const u = await createUser({ email: "rosa.lim@gmail.com" });
    await pool.query("UPDATE users SET password_hash = ? WHERE user_id = ?", [await bcrypt.hash("old-pass", 4), u.id]);
    const change = (new_password) => request(app).post("/api/v1/account/password").set("Authorization", u.auth)
      .send({ current_password: "old-pass", new_password });
    expect((await change("Aa1-" + "a".repeat(80))).body).toEqual(weak("long"));
    expect((await change("TAMANG-KAPE7")).body).toEqual(weak("lower"));
    expect((await change("Rosa.Lim-2026!")).body).toEqual(weak("personal"));
    expect((await change(`${u.username.toUpperCase()}-kape7`)).body).toEqual(weak("personal"));
    expect((await change(GOOD)).status).toBe(200);
  });
});

test("accounts made under older rules still log in (the new rule is never checked at login)", async () => {
  const u = await createUser();
  for (const old of ["abc123", "alllowercase1", "NoNumbersHere!"]) {
    await pool.query("UPDATE users SET password_hash = ? WHERE user_id = ?", [await bcrypt.hash(old, 4), u.id]);
    const res = await request(app).post("/api/auth/login").send({ username: u.username, password: old });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  }
});

describe("the forms", () => {
  const FRONTEND = path.join(__dirname, "..", "..", "Frontend");
  const forms = [
    ["Pages/Homepage/register.html", "#regPassword", "#regPasswordRules"],
    ["Pages/Homepage/set-password.html", "#newPassword", "#newPasswordRules"],
    ["Pages/Homepage/reset-password.html", "#newPassword", "#newPasswordRules"],
    ["Pages/Account/profile.html", "#newPassword", "#newPasswordRules"],
  ];

  test.each(forms)("%s has the rules checklist under the field", (page, field, rules) => {
    const html = fs.readFileSync(path.join(FRONTEND, page), "utf8");
    const input = html.match(new RegExp(`<input[^>]*id="${field.slice(1)}"[^>]*>`))[0];
    expect(input).toContain('minlength="10"');
    expect(input).toMatch(new RegExp(`aria-describedby="${rules.slice(1)} `));
    expect(html).toContain(`<ul id="${rules.slice(1)}" aria-label="Password rules"></ul>`);
  });

  test("the pages' rules and messages are the server's", () => {
    const ui = fs.readFileSync(path.join(FRONTEND, "JS", "ui.js"), "utf8");
    expect(ui).toContain("const PASSWORD_MIN = 10;");
    expect(ui).toContain("const PASSWORD_MAX_BYTES = 72;");
    expect(MESSAGES.short).toBe("Use at least 10 characters for your password.");
    expect(ui).toContain("Use at least ${PASSWORD_MIN} characters for your password.");
    for (const r of ["long", "upper", "lower", "number", "symbol", "personal"]) expect(ui).toContain(MESSAGES[r]);
  });

  const fillRegister = (page, { username = "ana_r", email = "ana.reyes@gmail.com", password = GOOD, confirm = password } = {}) => {
    page.$("#regUsername").value = username;
    page.$("#regEmail").value = email;
    page.$("#regPassword").value = password;
    page.$("#regConfirmPassword").value = confirm;
    page.$("#regConsent").checked = true;
    page.$("#regPassword").dispatchEvent(new page.window.Event("input"));
  };
  const ticked = (page, list) => [...page.$(list).querySelectorAll("li")].filter((li) => li.classList.contains("is-ok")).map((li) => li.dataset.rule);

  test("register: the checklist turns green rule by rule; the button waits for every rule and a matching confirmation", async () => {
    const page = await openPage("Pages/Homepage/register.html", { role: null, api: async () => ({ status: 201, body: {} }) });
    const button = page.$("#registerSubmit");
    expect(page.$("#regPasswordRules").querySelectorAll("li")).toHaveLength(6);
    expect(button.disabled).toBe(true);

    fillRegister(page, { password: "tamang" });
    expect(ticked(page, "#regPasswordRules")).toEqual(["low", "nouser"]);
    fillRegister(page, { password: "Tamang-kape" });
    expect(ticked(page, "#regPasswordRules")).toEqual(["len", "up", "low", "sym", "nouser"]);
    expect(button.disabled).toBe(true);
    fillRegister(page, { password: "Ana_R-kape7" });                    // contains the username
    expect(ticked(page, "#regPasswordRules")).not.toContain("nouser");
    expect(button.disabled).toBe(true);
    fillRegister(page, { password: GOOD, confirm: GOOD + "x" });
    expect(ticked(page, "#regPasswordRules")).toHaveLength(6);
    expect(page.$("#regConfirmPasswordError").textContent).toBe("The two passwords don't match.");
    expect(button.disabled).toBe(true);
    fillRegister(page, { password: GOOD });
    expect(page.$("#regConfirmPasswordError").textContent).toBe("");
    expect(button.disabled).toBe(false);
    fillRegister(page, { email: "ana@outlook.com" });                   // the email must be allowed too
    expect(button.disabled).toBe(true);
    page.close();
  });

  test("register: a weak password is shown at the field; one the server refuses is shown there too", async () => {
    const page = await openPage("Pages/Homepage/register.html", { role: null,
      api: async () => ({ status: 400, body: weak("common") }) });
    fillRegister(page, { password: "tamang-kape7" });
    page.$("#registerForm").dispatchEvent(new page.window.Event("submit", { cancelable: true }));
    expect(page.$("#regPasswordError").textContent).toBe(MESSAGES.upper);
    expect(page.calls).toEqual([]);

    fillRegister(page, { password: "P@ssw0rd123" });
    page.$("#registerForm").dispatchEvent(new page.window.Event("submit", { cancelable: true }));
    await page.until(() => page.$("#regPasswordError").textContent === MESSAGES.common);
    expect(page.calls).toHaveLength(1);
    page.close();
  });

  test("reset page: the checklist knows the username; the button waits; a refused password is shown at the field", async () => {
    const page = await openPage("Pages/Homepage/reset-password.html", { role: null, query: "token=abc",
      api: async ({ method }) => (method === "POST" ? { status: 400, body: weak("common") } : { body: { username: "juan" } }) });
    await page.until(() => !page.$("#setForm").hidden);
    const button = page.$("#setSubmit");
    expect(button.disabled).toBe(true);
    page.$("#newPassword").value = "Juan-kape-77";
    page.$("#confirmPassword").value = "Juan-kape-77";
    page.$("#newPassword").dispatchEvent(new page.window.Event("input"));
    expect(ticked(page, "#newPasswordRules")).not.toContain("nouser");
    expect(button.disabled).toBe(true);
    page.$("#newPassword").value = "P@ssw0rd123";
    page.$("#confirmPassword").value = "P@ssw0rd123";
    page.$("#newPassword").dispatchEvent(new page.window.Event("input"));
    expect(button.disabled).toBe(false);
    page.$("#setForm").dispatchEvent(new page.window.Event("submit", { cancelable: true }));
    await page.until(() => page.$("#newPasswordError").textContent === MESSAGES.common);
    page.close();
  });
});
