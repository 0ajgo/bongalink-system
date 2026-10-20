jest.mock("../services/mailer", () => require("./mailerMock")());

const request = require("supertest");
const { blindIndex } = require("../lib/dataProtection");
const app = require("../server");
const { mail } = require("../services/mailer");
const { pool, resetDb } = require("./helpers");
const rateLimits = require("../lib/rateLimit");

const lastCode = () => mail.verificationCode.mock.calls.at(-1)[2];

async function register(email = "new@example.com") {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ username: email.split("@")[0], email, password: "secret123", privacy_consent: true });
  return res;
}

beforeEach(async () => {
  await resetDb();
  await rateLimits.resetAll();   // each test registers from the same IP
  jest.clearAllMocks();
});
afterAll(() => pool.end());

describe("email verification", () => {
  test("register sends a 6-digit code that verifies the account", async () => {
    const res = await register();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ verificationRequired: true, emailSent: true });

    expect(mail.verificationCode).toHaveBeenCalledTimes(1);
    const [to, name, code, ttl] = mail.verificationCode.mock.calls[0];
    expect(to).toBe("new@example.com");
    expect(name).toBe("new");
    expect(code).toMatch(/^\d{6}$/);
    expect(ttl).toBe(15);

    // Stored hashed, never as the plain code.
    const [[row]] = await pool.query("SELECT code_hash FROM email_verifications");
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.code_hash).not.toContain(code);

    const ok = await request(app).post("/api/v1/auth/verify-email/confirm").send({ email: "NEW@example.com", code });
    expect(ok.status).toBe(200);
    expect(ok.body.message).toBe("Email verified");

    const [[user]] = await pool.query("SELECT email_verified_at FROM users WHERE email_bidx = ?", [blindIndex("new@example.com")]);
    expect(user.email_verified_at).not.toBeNull();
  });

  test("registration still succeeds when the email can't be sent", async () => {
    mail.verificationCode.mockRejectedValueOnce(new Error("SMTP down"));
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await register();
    expect(res.status).toBe(201);
    expect(res.body.emailSent).toBe(false);
    errors.mockRestore();
  });

  test("the code is never written to the logs", async () => {
    const spies = ["log", "info", "warn", "error"].map(m => jest.spyOn(console, m).mockImplementation(() => {}));
    await register();
    const code = lastCode();
    await request(app).post("/api/v1/auth/verify-email/confirm").send({ email: "new@example.com", code: "000000" });
    const logged = spies.flatMap(s => s.mock.calls.flat()).map(String).join("\n");
    expect(logged).not.toContain(code);
    spies.forEach(s => s.mockRestore());
  });

  test("a wrong code is rejected and attempts are limited to 5", async () => {
    await register();
    const code = lastCode();
    const wrong = code === "123456" ? "654321" : "123456";

    const first = await request(app).post("/api/v1/auth/verify-email/confirm").send({ email: "new@example.com", code: wrong });
    expect(first.status).toBe(400);
    expect(first.body).toEqual({ error: "Incorrect code", attemptsLeft: 4 });

    for (let i = 0; i < 4; i++) {
      await request(app).post("/api/v1/auth/verify-email/confirm").send({ email: "new@example.com", code: wrong });
    }
    // Even the right code is refused once the attempts are used up.
    const locked = await request(app).post("/api/v1/auth/verify-email/confirm").send({ email: "new@example.com", code });
    expect(locked.status).toBe(429);

    const [[user]] = await pool.query("SELECT email_verified_at FROM users");
    expect(user.email_verified_at).toBeNull();
  });

  test("an expired code is rejected", async () => {
    await register();
    const code = lastCode();
    await pool.query("UPDATE email_verifications SET expires_at = NOW() - INTERVAL 1 MINUTE");

    const res = await request(app).post("/api/v1/auth/verify-email/confirm").send({ email: "new@example.com", code });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Code expired. Request a new one.");
  });

  test("send: resend issues a new code after the cooldown, and replies the same for unknown emails", async () => {
    await register();
    const firstCode = lastCode();

    const tooSoon = await request(app).post("/api/v1/auth/verify-email/send").send({ email: "new@example.com" });
    expect(tooSoon.status).toBe(429);

    await pool.query("UPDATE email_verifications SET created_at = NOW() - INTERVAL 2 MINUTE");
    const resend = await request(app).post("/api/v1/auth/verify-email/send").send({ email: "new@example.com" });
    expect(resend.status).toBe(200);
    expect(mail.verificationCode).toHaveBeenCalledTimes(2);

    // The old code no longer works; the new one does.
    const newCode = lastCode();
    if (newCode !== firstCode) {
      const old = await request(app).post("/api/v1/auth/verify-email/confirm").send({ email: "new@example.com", code: firstCode });
      expect(old.status).toBe(400);
    }
    const ok = await request(app).post("/api/v1/auth/verify-email/confirm").send({ email: "new@example.com", code: newCode });
    expect(ok.status).toBe(200);

    const unknown = await request(app).post("/api/v1/auth/verify-email/send").send({ email: "nobody@example.com" });
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual(resend.body);
  });
});
