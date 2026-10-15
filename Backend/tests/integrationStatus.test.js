// Startup status lines: correct state per service, and never a secret value.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { integrationStatus, statusLines } = require("../lib/integrationStatus");

const FULL = {
  LALAMOVE_API_KEY: "pk_test_SECRETKEY111", LALAMOVE_API_SECRET: "sk_test_SECRETSECRET222", LALAMOVE_ENV: "sandbox",
  STORE_LAT: "14.5547", STORE_LNG: "121.0244",
  PAYMONGO_SECRET_KEY: "sk_test_PAYMONGO333", PAYMONGO_WEBHOOK_SECRET: "whsk_WEBHOOK444", APP_URL: "http://localhost:5500/Frontend",
  SMTP_USER: "shop@example.com", SMTP_PASS: "app password 555", MAIL_FROM: "Bongalink <shop@example.com>",
  VERIFICATION_SECRET: "verification-666", ADMIN_ALERT_EMAIL: "owner@example.com",
  GEMINI_API_KEY: "AIzaGEMINI777"
};
const SECRETS = ["SECRETKEY111", "SECRETSECRET222", "PAYMONGO333", "WEBHOOK444", "app password 555", "verification-666",
                 "shop@example.com", "owner@example.com", "14.5547", "121.0244", "AIzaGEMINI777"];

describe("integration status", () => {
  test("everything set: enabled, with non-secret details", () => {
    expect(statusLines(FULL)).toEqual([
      "Lalamove: enabled (sandbox; areas NCR, Bulacan, Cavite, Laguna, Rizal)",
      "PayMongo: enabled (test mode; methods gcash,qrph,dob,dob_ubp)",
      "Email:    enabled (smtp.gmail.com:465; shop alerts on)",
      "Gemini:   enabled (model gemini-3.8-flash, fallback gemini-3.5-flash-lite)"
    ]);
  });

  test("nothing set: off, naming the keys", () => {
    expect(statusLines({})).toEqual([
      "Lalamove: off, keys not set (LALAMOVE_API_KEY, LALAMOVE_API_SECRET, STORE_LAT, STORE_LNG)",
      "PayMongo: off, keys not set (PAYMONGO_SECRET_KEY, PAYMONGO_WEBHOOK_SECRET, APP_URL)",
      "Email:    off, keys not set (SMTP_USER, SMTP_PASS, MAIL_FROM, VERIFICATION_SECRET)",
      "Gemini:   off, keys not set (GEMINI_API_KEY)"
    ]);
  });

  test("some set: incomplete, naming only what's missing; blank values count as not set", () => {
    const env = { ...FULL, STORE_LAT: "", STORE_LNG: "  ", PAYMONGO_WEBHOOK_SECRET: undefined };
    const byName = Object.fromEntries(integrationStatus(env).map(s => [s.name, s]));
    expect(byName.Lalamove).toMatchObject({ state: "incomplete", missing: ["STORE_LAT", "STORE_LNG"], detail: null });
    expect(byName.PayMongo).toMatchObject({ state: "incomplete", missing: ["PAYMONGO_WEBHOOK_SECRET"] });
    expect(statusLines(env)[1]).toBe("PayMongo: incomplete, not set: PAYMONGO_WEBHOOK_SECRET");
  });

  test("modes are labelled from the key type and LALAMOVE_ENV, not shown", () => {
    const live = statusLines({ ...FULL, PAYMONGO_SECRET_KEY: "sk_live_ABC", LALAMOVE_ENV: "production",
                               LALAMOVE_SERVICE_AREAS: "NCR, Cebu", ADMIN_ALERT_EMAIL: "" });
    expect(live[0]).toBe("Lalamove: enabled (PRODUCTION; areas NCR, Cebu)");
    expect(live[1]).toMatch(/^PayMongo: enabled \(LIVE mode;/);
    expect(live[2]).toBe("Email:    enabled (smtp.gmail.com:465; shop alerts off (ADMIN_ALERT_EMAIL not set))");
    expect(statusLines({ ...FULL, GEMINI_MODEL: " gemini-3.5-flash-lite " })[3]).toBe("Gemini:   enabled (model gemini-3.5-flash-lite)");
    expect(statusLines({ ...FULL, GEMINI_FALLBACK_MODEL: "gemini-3.8-flash" })[3]).toBe("Gemini:   enabled (model gemini-3.8-flash)");
  });

  test("no line ever contains a value", () => {
    const all = [statusLines(FULL), statusLines({ ...FULL, STORE_LAT: "" }), statusLines({})].flat().join("\n");
    for (const secret of SECRETS) expect(all).not.toContain(secret);
  });
});

describe("server startup output", () => {
  test("prints one status line per service and none of the .env values", async () => {
    const backend = path.join(__dirname, "..");
    // Values from the real Backend/.env must not appear either, except the non-secret
    // settings the status lines are meant to show.
    const SHOWN = new Set(["LALAMOVE_ENV", "LALAMOVE_SERVICE_AREAS", "PAYMONGO_METHODS", "SMTP_HOST", "SMTP_PORT",
                           "LALAMOVE_SERVICE_TYPE", "NODE_ENV", "PORT", "DB_NAME", "DB_HOST", "DB_PORT",
                           "STORE_CONTACT_NAME", "GEMINI_MODEL", "GEMINI_FALLBACK_MODEL"]);   // "Bongalink", also in the "Bongalink API running" line
    const realValues = Object.entries(require("dotenv").parse(fs.readFileSync(path.join(backend, ".env"))))
      .filter(([k, v]) => !SHOWN.has(k) && v && v.length >= 6)
      .map(([, v]) => v);

    const child = spawn(process.execPath, ["server.js"], {
      cwd: backend,
      env: { ...process.env, ...FULL, PORT: "0", DB_NAME: "bongalink_test" }
    });
    let out = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { out += d; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 15000);
      child.stdout.on("data", () => { if (out.includes("Bongalink API running")) { clearTimeout(timer); resolve(); } });
    });
    child.kill();

    expect(out).toContain("Integrations (from .env; restart after changing it):");
    expect(out).toContain("  Lalamove: enabled (sandbox;");
    expect(out).toContain("  PayMongo: enabled (test mode;");
    expect(out).toContain("  Email:    enabled (");
    expect(out).toContain("  Gemini:   enabled (model ");
    for (const secret of [...SECRETS, ...realValues]) expect(out).not.toContain(secret);
  }, 20000);
});
