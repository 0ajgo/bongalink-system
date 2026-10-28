// The rule for NEW email addresses (lib/emailRule.js): only Gmail and Yahoo, on register, the
// profile's email change and Admin › Accounts. Logging in, "Forgot password" and existing
// accounts with another address keep working.
jest.mock("../services/mailer", () => require("./mailerMock")());

const fs = require("fs");
const path = require("path");
const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const rateLimits = require("../lib/rateLimit");
const { mail } = require("../services/mailer");
const { newEmailProblem, ALLOWED_EMAIL_DOMAINS, MESSAGES } = require("../lib/emailRule");
const { pool, resetDb, createUser } = require("./helpers");
const { openPage } = require("./pageHarness");

beforeEach(async () => {
  await resetDb();
  await rateLimits.resetAll();
  jest.clearAllMocks();
});
afterAll(() => pool.end());

const DOMAIN_ERROR = "Only Gmail (@gmail.com) or Yahoo (@yahoo.com, @yahoo.com.ph) addresses are accepted.";
const refused = { error: DOMAIN_ERROR, code: "EMAIL_DOMAIN_NOT_ALLOWED" };
const PASSWORD = "Tamang-kape7";
const userCount = async () => (await pool.query("SELECT COUNT(*) AS n FROM users"))[0][0].n;

describe("newEmailProblem", () => {
  test("Gmail and Yahoo addresses, in any case", () => {
    expect(ALLOWED_EMAIL_DOMAINS).toEqual(["gmail.com", "googlemail.com", "yahoo.com", "yahoo.com.ph", "ymail.com"]);
    for (const ok of ["juan@gmail.com", "Juan.DC@GMAIL.COM", "juan+shop@googlemail.com", "maria@yahoo.com",
                      "maria@Yahoo.Com.Ph", "maria@ymail.com", "  juan@gmail.com  "]) {
      expect([ok, newEmailProblem(ok)]).toEqual([ok, null]);
    }
  });

  test("other providers and lookalikes are refused", () => {
    for (const bad of ["juan@outlook.com", "juan@hotmail.com", "juan@example.com", "juan@gmail.co", "juan@gmail.com.evil.com",
                       "juan@evilgmail.com", "juan@mail.gmail.com", "juan@yahoo.co", "juan@yahoo.com.ph.evil.com", "juan@yahoo.ph"]) {
      expect([bad, newEmailProblem(bad)]).toEqual([bad, refused]);
    }
    expect(MESSAGES.domain).toBe(DOMAIN_ERROR);
  });

  test("not an email address at all", () => {
    for (const bad of ["", "juan", "juan@gmail", "juan @gmail.com", "a@b@gmail.com", null, undefined, "x".repeat(141) + "@gmail.com"]) {
      expect(newEmailProblem(bad)).toEqual({ error: "Enter a valid email address.", code: "INVALID_EMAIL" });
    }
  });
});

describe("register", () => {
  const register = (email, username = "ana_r") => request(app).post("/api/auth/register")
    .send({ username, email, password: PASSWORD, privacy_consent: true });

  test("refuses other providers and lookalikes (400), creating nothing", async () => {
    for (const email of ["ana@outlook.com", "ana@gmail.co", "ana@gmail.com.evil.com"]) {
      const res = await register(email);
      expect(res.status).toBe(400);
      expect(res.body).toEqual(refused);
    }
    expect(await userCount()).toBe(0);
    expect(mail.verificationCode).not.toHaveBeenCalled();
  });

  test("accepts Gmail (any case) and Yahoo Philippines, and still sends the 6-digit code", async () => {
    expect((await register("Ana.Reyes@GMAIL.COM")).status).toBe(201);
    expect((await register("ana@yahoo.com.ph", "ana_y")).status).toBe(201);
    expect(await userCount()).toBe(2);
    expect(mail.verificationCode).toHaveBeenCalledTimes(2);
    expect(mail.verificationCode).toHaveBeenCalledWith("ana@yahoo.com.ph", "ana_y", expect.stringMatching(/^\d{6}$/), 15);
  });
});

describe("profile email change", () => {
  test("a new address must be Gmail or Yahoo; an older account can still save other changes", async () => {
    const u = await createUser();                          // an existing account at @example.com
    await pool.query("UPDATE users SET password_hash = ? WHERE user_id = ?", [await bcrypt.hash(PASSWORD, 4), u.id]);
    const patch = (body) => request(app).patch("/api/v1/account/me").set("Authorization", u.auth).send(body);

    for (const email of ["new@outlook.com", "new@gmail.co", "new@gmail.com.evil.com"]) {
      const res = await patch({ email, current_password: PASSWORD });
      expect(res.status).toBe(400);
      expect(res.body).toEqual(refused);
    }
    // Keeping the old address (any case) while renaming is fine.
    const renamed = await patch({ username: "renamed_user", email: u.email.toUpperCase() });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ username: "renamed_user", email: u.email, email_changed: false });

    const moved = await patch({ email: "new@yahoo.com", current_password: PASSWORD });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ email: "new@yahoo.com", email_changed: true, email_verified_at: null });
  });
});

describe("Admin › Accounts", () => {
  test("a new account needs a Gmail or Yahoo address", async () => {
    const admin = await createUser({ role: "admin" });
    const create = (email) => request(app).post("/api/v1/admin/accounts").set("Authorization", admin.auth)
      .send({ username: "staff_new", email, role: "user" });
    const res = await create("staff@outlook.com");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(DOMAIN_ERROR);
    expect((await create("staff@gmail.com.evil.com")).status).toBe(400);
    expect((await create("Staff@Yahoo.com")).status).toBe(201);
  });
});

describe("existing accounts with another address keep working", () => {
  test("login and forgot password are not blocked", async () => {
    const u = await createUser({ email: "old.customer@outlook.com" });
    await pool.query("UPDATE users SET password_hash = ? WHERE user_id = ?", [await bcrypt.hash("old-pass-1", 4), u.id]);
    const login = await request(app).post("/api/auth/login").send({ username: u.username, password: "old-pass-1" });
    expect(login.status).toBe(200);

    const forgot = await request(app).post("/api/auth/forgot-password").send({ email: "old.customer@outlook.com" });
    expect(forgot.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));          // the email goes out in the background
    expect(mail.passwordReset).toHaveBeenCalledWith("old.customer@outlook.com", u.username, expect.any(String), expect.anything());
  });
});

describe("the pages", () => {
  const FRONTEND = path.join(__dirname, "..", "..", "Frontend");
  const HINT = "Use a Gmail or Yahoo address. We'll send a 6-digit code to verify it.";

  test("register and profile show the hint under the email field; the pages use the same list and message", () => {
    for (const page of ["Pages/Homepage/register.html", "Pages/Account/profile.html"]) {
      expect(fs.readFileSync(path.join(FRONTEND, page), "utf8")).toContain(`>${HINT}</span>`);
    }
    const ui = fs.readFileSync(path.join(FRONTEND, "JS", "ui.js"), "utf8");
    expect(ui).toContain(`const EMAIL_DOMAINS = ${JSON.stringify(ALLOWED_EMAIL_DOMAINS).replace(/,/g, ", ")};`);
    expect(ui).toContain(DOMAIN_ERROR);
  });

  test("register: the message shows when leaving the field, clears once fixed, and the form isn't sent", async () => {
    const page = await openPage("Pages/Homepage/register.html", { role: null, api: async () => ({ status: 201, body: {} }) });
    const email = page.$("#regEmail");
    email.value = "ana@outlook.com";
    email.dispatchEvent(new page.window.Event("blur"));
    expect(page.$("#regEmailError").textContent).toBe(DOMAIN_ERROR);
    expect(email.getAttribute("aria-invalid")).toBe("true");
    email.value = "ana@gmail.com";
    email.dispatchEvent(new page.window.Event("input"));
    expect(page.$("#regEmailError").textContent).toBe("");

    email.value = "ana@gmail.co";
    page.$("#regUsername").value = "ana_r";
    page.$("#regPassword").value = PASSWORD;
    page.$("#regConfirmPassword").value = PASSWORD;
    page.$("#regConsent").checked = true;
    page.$("#registerForm").dispatchEvent(new page.window.Event("submit", { cancelable: true }));
    expect(page.$("#regEmailError").textContent).toBe(DOMAIN_ERROR);
    expect(page.calls).toEqual([]);
    page.close();
  });

  test("profile: a new address that isn't Gmail or Yahoo is refused before sending; keeping the old one is fine", async () => {
    const me = { user_id: 1, username: "juan", email: "juan@outlook.com", role: "user", created_at: "2026-01-01", email_verified_at: "2026-01-02" };
    const page = await openPage("Pages/Account/profile.html", { api: async ({ url, method }) => {
      if (url === "/v1/account/me") return { body: method === "PATCH" ? { ...me, username: "juan2" } : me };
      if (url === "/orders") return { body: [] };
      return { body: [] };
    } });
    await page.until(() => page.$("#profileName"));
    page.$("#infoEmail").value = "juan@hotmail.com";
    page.$("#infoForm").dispatchEvent(new page.window.Event("submit", { cancelable: true }));
    expect(page.$("#infoError").textContent).toBe(DOMAIN_ERROR);
    expect(page.calls.some((c) => c.method === "PATCH")).toBe(false);

    page.$("#infoEmail").value = "juan@outlook.com";              // unchanged
    page.$("#infoUsername").value = "juan2";
    page.$("#infoForm").dispatchEvent(new page.window.Event("submit", { cancelable: true }));
    await page.until(() => page.calls.some((c) => c.method === "PATCH"));
    expect(page.calls.find((c) => c.method === "PATCH").body).toEqual({ username: "juan2", email: "juan@outlook.com" });
    await page.settle();
    page.close();
  });
});
