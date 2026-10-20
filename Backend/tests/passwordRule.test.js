// The rule for NEW passwords (lib/passwordRule.js): register, reset, set up and change refuse a
// weak one with code WEAK_PASSWORD; logging in with an older, shorter password still works.
jest.mock("../services/mailer", () => require("./mailerMock")());

const fs = require("fs");
const path = require("path");
const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const rateLimits = require("../lib/rateLimit");
const { newPasswordProblem, MESSAGES } = require("../lib/passwordRule");
const { pool, resetDb, createUser } = require("./helpers");
const { openPage } = require("./pageHarness");

beforeEach(async () => {
  await resetDb();
  await rateLimits.resetAll();
});
afterAll(() => pool.end());

const weak = (reason) => ({ error: MESSAGES[reason], code: "WEAK_PASSWORD" });

describe("newPasswordProblem", () => {
  test("at least 10 characters", () => {
    expect(newPasswordProblem("abcdefghi")).toEqual(weak("short"));
    expect(newPasswordProblem("")).toEqual(weak("short"));
    expect(newPasswordProblem(undefined)).toEqual(weak("short"));
    expect(newPasswordProblem(12345678901)).toEqual(weak("short"));
    expect(newPasswordProblem("tamang-kape")).toBeNull();
  });

  test("at most 72 bytes, the part bcrypt actually checks", () => {
    expect(newPasswordProblem("a".repeat(71) + "b")).toBeNull();
    expect(newPasswordProblem("a".repeat(72) + "b")).toEqual(weak("long"));
    expect(newPasswordProblem("éa".repeat(24))).toBeNull();               // 48 characters, 72 bytes
    expect(newPasswordProblem("éa".repeat(24) + "b")).toEqual(weak("long"));
    expect(newPasswordProblem("x".repeat(66) + "😀😀")).toEqual(weak("long"));   // 66 + 8
  });

  test("not a well-known password (any case) or one character repeated", () => {
    expect(newPasswordProblem("password123")).toEqual(weak("common"));
    expect(newPasswordProblem("PassWord123")).toEqual(weak("common"));
    expect(newPasswordProblem("1234567890")).toEqual(weak("common"));
    expect(newPasswordProblem("Bongalink123")).toEqual(weak("common"));
    expect(newPasswordProblem("zzzzzzzzzzzz")).toEqual(weak("common"));
  });
});

describe("every way to set a new password applies it", () => {
  test("register", async () => {
    const res = await request(app).post("/api/auth/register")
      .send({ username: "ana", email: "ana@example.com", password: "password123", privacy_consent: true });
    expect(res.status).toBe(400);
    expect(res.body).toEqual(weak("common"));
    expect((await pool.query("SELECT COUNT(*) AS n FROM users"))[0][0].n).toBe(0);
  });

  test("reset link and account setup link (checked before the link, so no token is used up)", async () => {
    const reset = await request(app).post("/api/auth/reset-password").send({ token: "abc", password: "short" });
    expect(reset.status).toBe(400);
    expect(reset.body).toEqual(weak("short"));
    const setup = await request(app).post("/api/auth/set-password").send({ token: "abc", password: "qwertyuiop", privacy_consent: true });
    expect(setup.status).toBe(400);
    expect(setup.body).toEqual(weak("common"));
  });

  test("change in the profile", async () => {
    const u = await createUser();
    await pool.query("UPDATE users SET password_hash = ? WHERE user_id = ?", [await bcrypt.hash("old-pass", 4), u.id]);
    const res = await request(app).post("/api/v1/account/password").set("Authorization", u.auth)
      .send({ current_password: "old-pass", new_password: "a".repeat(80) });
    expect(res.status).toBe(400);
    expect(res.body).toEqual(weak("long"));
  });
});

test("an account made under the old 6-character rule still logs in", async () => {
  const u = await createUser();
  await pool.query("UPDATE users SET password_hash = ? WHERE user_id = ?", [await bcrypt.hash("abc123", 4), u.id]);
  const res = await request(app).post("/api/auth/login").send({ username: u.username, password: "abc123" });
  expect(res.status).toBe(200);
  expect(res.body.token).toBeTruthy();
});

describe("the forms", () => {
  const FRONTEND = path.join(__dirname, "..", "..", "Frontend");
  const HINT = "At least 10 characters, and not a common one like password123.";
  const forms = [
    ["Pages/Homepage/register.html", "#regPassword"],
    ["Pages/Homepage/set-password.html", "#newPassword"],
    ["Pages/Homepage/reset-password.html", "#newPassword"],
    ["Pages/Account/profile.html", "#newPassword"],
  ];

  test.each(forms)("%s states the rule next to the field", (page, field) => {
    const html = fs.readFileSync(path.join(FRONTEND, page), "utf8");
    const input = html.match(new RegExp(`<input[^>]*id="${field.slice(1)}"[^>]*>`))[0];
    expect(input).toContain('minlength="10"');
    const hintId = input.match(/aria-describedby="(\S+)/)[1];
    expect(html).toContain(`id="${hintId}">${HINT}</span>`);
  });

  test("the pages' length messages are the server's", () => {
    const ui = fs.readFileSync(path.join(FRONTEND, "JS", "ui.js"), "utf8");
    expect(ui).toContain("const PASSWORD_MIN = 10;");
    expect(ui).toContain("const PASSWORD_MAX_BYTES = 72;");
    expect(ui).toContain(MESSAGES.long);
    expect(MESSAGES.short).toBe("Use at least 10 characters for your password.");
  });

  test("register: too short is shown at the field; a common one the server refuses is shown there too", async () => {
    const page = await openPage("Pages/Homepage/register.html", { role: null,
      api: async () => ({ status: 400, body: weak("common") }) });
    const fill = (pw) => {
      page.$("#regUsername").value = "ana";
      page.$("#regEmail").value = "ana@example.com";
      page.$("#regPassword").value = pw;
      page.$("#regConfirmPassword").value = pw;
      page.$("#regConsent").checked = true;
    };
    fill("short");
    page.$("#registerForm").dispatchEvent(new page.window.Event("submit", { cancelable: true }));
    expect(page.$("#regPasswordError").textContent).toBe(MESSAGES.short);
    expect(page.calls).toEqual([]);

    fill("password123");
    page.$("#registerForm").dispatchEvent(new page.window.Event("submit", { cancelable: true }));
    await page.until(() => page.$("#regPasswordError").textContent === MESSAGES.common);
    expect(page.calls).toHaveLength(1);
    page.close();
  });

  test("reset page: a common password the server refuses is shown at the field", async () => {
    const page = await openPage("Pages/Homepage/reset-password.html", { role: null, query: "token=abc",
      api: async ({ method }) => (method === "POST" ? { status: 400, body: weak("common") } : { body: { username: "juan" } }) });
    await page.until(() => !page.$("#setForm").hidden);
    page.$("#newPassword").value = "password123";
    page.$("#confirmPassword").value = "password123";
    page.$("#setForm").dispatchEvent(new page.window.Event("submit", { cancelable: true }));
    await page.until(() => page.$("#newPasswordError").textContent === MESSAGES.common);
    page.close();
  });
});
