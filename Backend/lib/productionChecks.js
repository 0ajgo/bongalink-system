/* =====================================================================
   lib/productionChecks.js — settings checked when the API starts.
   With NODE_ENV=production:
     errors (the server won't start): no strong JWT_SECRET, no CORS_ORIGIN,
       no APP_URL;
     warnings: addresses that aren't https://, PayMongo or Lalamove still in
       test mode, the database user root, TRUST_PROXY blank.
   In every environment: a warning while a rate limit is raised above its
   default (a test session's setting left in place).
   Names only, never values. See DEPLOYMENT.md.
   ===================================================================== */
const { raisedLimits } = require("./rateLimit");

const MIN_JWT_SECRET = 32;
const list = (value) => String(value || "").split(",").map((s) => s.trim()).filter(Boolean);
const isHttps = (url) => /^https:\/\//i.test(url);

function startupChecks(env = process.env) {
  const errors = [];
  const warnings = [];

  for (const l of raisedLimits(env)) {
    warnings.push(`${l.name} is raised to ${l.value} (default ${l.default}). Set it back to blank after the test session (DEPLOYMENT.md, "UAT").`);
  }
  if (env.NODE_ENV !== "production") return { errors, warnings };

  if (String(env.JWT_SECRET || "").length < MIN_JWT_SECRET) {
    errors.push(`JWT_SECRET must be a random string of at least ${MIN_JWT_SECRET} characters.`);
  }
  const origins = list(env.CORS_ORIGIN);
  if (!origins.length) errors.push("CORS_ORIGIN is empty: the shop's pages couldn't call the API.");
  if (!String(env.APP_URL || "").trim()) errors.push("APP_URL is empty: PayMongo couldn't send customers back to the shop.");

  const plain = [["APP_URL", list(env.APP_URL)], ["CORS_ORIGIN", origins]]
    .flatMap(([name, urls]) => urls.filter((u) => !isHttps(u)).map(() => name));
  for (const name of [...new Set(plain)]) warnings.push(`${name} has an address that isn't https://. Logins and payments must use HTTPS.`);

  const key = String(env.PAYMONGO_SECRET_KEY || "");
  if (key.startsWith("sk_test_")) warnings.push("PayMongo is in TEST mode (sk_test_ key): customers can't really pay.");
  if (env.LALAMOVE_API_KEY && String(env.LALAMOVE_ENV || "sandbox").toLowerCase() !== "production") {
    warnings.push("Lalamove is in sandbox mode (LALAMOVE_ENV): no real rider will come.");
  }
  if (String(env.DB_USER || "").toLowerCase() === "root") {
    warnings.push("DB_USER is root. Use the bongalink_app account (DEPLOYMENT.md, least-privilege users).");
  }
  if (!String(env.TRUST_PROXY || "").trim()) {
    warnings.push("TRUST_PROXY is blank: right only if browsers reach Node directly. Behind nginx or a load balancer, set it (usually 1).");
  }
  return { errors, warnings };
}

module.exports = { startupChecks, MIN_JWT_SECRET };
