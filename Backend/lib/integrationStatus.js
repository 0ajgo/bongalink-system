// One status line per outside service, printed when the server starts:
//   Lalamove: enabled (sandbox; areas NCR, Bulacan, Cavite, Laguna, Rizal)
//   PayMongo: incomplete, not set: PAYMONGO_WEBHOOK_SECRET
//   Email:    off, keys not set (SMTP_USER, SMTP_PASS, MAIL_FROM, VERIFICATION_SECRET)
//   Gemini:   enabled (model gemini-3.8-flash, fallback gemini-3.5-flash-lite)
//   Encryption: enabled (AES-256-GCM, key v1)
// Only variable NAMES and labels derived from them (test/live, sandbox/production)
// are ever printed, never values. Remember: .env is read at startup, so restart the
// server after changing it.
//
// To add a service, add an entry to INTEGRATIONS: its required variable names and
// an optional detail(env) that returns non-secret context.

const DEFAULT_LALAMOVE_AREAS = "NCR,Bulacan,Cavite,Laguna,Rizal";
// Keep in sync with services/chatbot.js
const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
const DEFAULT_GEMINI_FALLBACK = "gemini-3.5-flash-lite";

const INTEGRATIONS = [
  {
    name: "Lalamove",
    required: ["LALAMOVE_API_KEY", "LALAMOVE_API_SECRET", "STORE_LAT", "STORE_LNG"],
    detail: (env) => {
      const mode = env.LALAMOVE_ENV === "production" ? "PRODUCTION" : "sandbox";
      const areas = (env.LALAMOVE_SERVICE_AREAS || DEFAULT_LALAMOVE_AREAS).split(",").map((a) => a.trim()).filter(Boolean);
      return `${mode}; areas ${areas.join(", ")}`;
    },
  },
  {
    name: "PayMongo",
    required: ["PAYMONGO_SECRET_KEY", "PAYMONGO_WEBHOOK_SECRET", "APP_URL"],
    detail: (env) => {
      const key = env.PAYMONGO_SECRET_KEY || "";
      const mode = key.startsWith("sk_live_") ? "LIVE mode" : key.startsWith("sk_test_") ? "test mode" : "unrecognised key type";
      return `${mode}; methods ${env.PAYMONGO_METHODS || "gcash,qrph,dob,dob_ubp"}`;
    },
  },
  {
    name: "Email",
    required: ["SMTP_USER", "SMTP_PASS", "MAIL_FROM", "VERIFICATION_SECRET"],
    detail: (env) =>
      `${env.SMTP_HOST || "smtp.gmail.com"}:${env.SMTP_PORT || 465}; shop alerts ${isSet(env.ADMIN_ALERT_EMAIL) ? "on" : "off (ADMIN_ALERT_EMAIL not set)"}`,
  },
  {
    // AI chat support. Off = the chat answers with the shop's contact details instead.
    name: "Gemini",
    required: ["GEMINI_API_KEY"],
    detail: (env) => {
      const model = isSet(env.GEMINI_MODEL) ? env.GEMINI_MODEL.trim() : DEFAULT_GEMINI_MODEL;
      const fallback = isSet(env.GEMINI_FALLBACK_MODEL) ? env.GEMINI_FALLBACK_MODEL.trim() : DEFAULT_GEMINI_FALLBACK;
      return `model ${model}${fallback !== model ? `, fallback ${fallback}` : ""}`;
    },
  },
  {
    // Personal information at rest (lib/dataProtection.js). The server won't start without it.
    name: "Encryption",
    required: ["DATA_ENCRYPTION_KEY", "DATA_INDEX_KEY"],
    detail: (env) => {
      const older = Object.keys(env).filter((k) => /^DATA_ENCRYPTION_KEY_V\d+$/.test(k) && isSet(env[k]))
        .map((k) => `v${k.slice("DATA_ENCRYPTION_KEY_V".length)}`).sort();
      return `AES-256-GCM, key v${String(env.DATA_ENCRYPTION_KEY_VERSION || "").trim() || 1}${older.length ? `; can also read ${older.join(", ")}` : ""}`;
    },
  },
];

const isSet = (v) => typeof v === "string" && v.trim() !== "";

// -> [{ name, state: "enabled" | "incomplete" | "off", missing: [names], detail }]
function integrationStatus(env = process.env) {
  return INTEGRATIONS.map(({ name, required, detail }) => {
    const missing = required.filter((k) => !isSet(env[k]));
    const state = missing.length === 0 ? "enabled" : missing.length === required.length ? "off" : "incomplete";
    return { name, state, missing, detail: state === "enabled" ? detail(env) : null };
  });
}

function statusLines(env = process.env) {
  const width = Math.max(...INTEGRATIONS.map((i) => i.name.length)) + 1;
  return integrationStatus(env).map(({ name, state, missing, detail }) => {
    const label = `${name}:`.padEnd(width + 1);
    if (state === "enabled") return `${label}enabled (${detail})`;
    if (state === "off") return `${label}off, keys not set (${missing.join(", ")})`;
    return `${label}incomplete, not set: ${missing.join(", ")}`;
  });
}

module.exports = { integrationStatus, statusLines, INTEGRATIONS };
