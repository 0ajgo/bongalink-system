/* =====================================================================
   server.js — Bongalink API entry point
   Run with:  npm run dev   (local development, auto-restarts)
              npm start     (production: NODE_ENV=production, under Docker or
                             systemd so it restarts on failure, DEPLOYMENT.md)
   Tests import `app` from here without starting the listener.
   ===================================================================== */

// Backend/.env, wherever the process was started from (a service manager may use another folder).
require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const express = require("express");
const cors = require("cors");
const path = require("path");
const multer = require("multer");
const ah = require("./lib/asyncHandler");

const authRoutes = require("./routes/auth");
const categoryRoutes = require("./routes/categories");
const productRoutes = require("./routes/products");
const cartRoutes = require("./routes/cart");
const orderRoutes = require("./routes/orders");
const mlRoutes = require("./routes/ml");
const { router: verifyEmailRoutes } = require("./routes/emailVerification");
const { router: paymentRoutes, paymongoWebhook } = require("./routes/payments");
const logisticsRoutes = require("./routes/logistics");
const accountRoutes = require("./routes/account");
const geoRoutes = require("./routes/geo");
const rateRoutes = require("./routes/rates");
const chatRoutes = require("./routes/chat");
const chatAdminRoutes = require("./routes/chatAdmin");
const adminAccountRoutes = require("./routes/adminAccounts");
const notificationRoutes = require("./routes/notifications");
const { PaymentError } = require("./services/paymongo");
const { LogisticsError } = require("./services/lalamove");
const { startOrderExpiryJob } = require("./jobs/expireOrders");
const { statusLines } = require("./lib/integrationStatus");
const { logError } = require("./lib/pii");
const { trustProxySetting } = require("./lib/trustProxy");
const { securityHeaders, allowCrossOriginImages } = require("./lib/securityHeaders");
const { envLimit, limiter, RATE_LIMIT_DEFAULTS } = require("./lib/rateLimit");

const app = express();

// Behind a proxy, req.ip (and so every per-IP rate limit) must be the visitor's address.
app.set("trust proxy", trustProxySetting());

// Security headers on every answer (lib/securityHeaders.js); no X-Powered-By.
app.use(securityHeaders());

// PayMongo signs the RAW body, so this route must come BEFORE express.json().
app.post("/api/v1/webhooks/paymongo", express.raw({ type: "application/json" }), ah(paymongoWebhook));

// Only origins listed in CORS_ORIGIN (.env) may call this API.
// Add your hosted frontend's URL there once deployed — no code change.
const allowedOrigins = (process.env.CORS_ORIGIN || "").split(",").map(o => o.trim());
// Browsers may reuse a preflight answer for 10 minutes (Chrome caps it at 2 h), so a
// logged-in page doesn't send an extra OPTIONS request before every API call.
const CORS_PREFLIGHT_MAX_AGE_S = 600;
app.use(cors({ origin: allowedOrigins, maxAge: CORS_PREFLIGHT_MAX_AGE_S }));

app.use(express.json({ limit: "100kb" }));

// Serves uploaded product images at /uploads/<filename>, to pages on the CORS_ORIGIN sites too.
app.use("/uploads", allowCrossOriginImages, express.static(process.env.UPLOAD_DIR || path.join(__dirname, "uploads")));

app.use("/api/auth", authRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/products", productRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/admin/ml", mlRoutes);

// Limit code requests/guesses per IP (on top of the per-code attempt limit).
const verifyEmailPerIp = limiter({ windowMs: 15 * 60 * 1000, limit: envLimit(process.env.RATE_LIMIT_VERIFY_EMAIL_PER_IP, RATE_LIMIT_DEFAULTS.RATE_LIMIT_VERIFY_EMAIL_PER_IP),
  message: { error: "Too many tries. Please wait a few minutes." } });
app.use("/api/v1/auth/verify-email", verifyEmailPerIp, verifyEmailRoutes);
app.use("/api/v1/account", accountRoutes);   // profile, password, saved addresses
app.use("/api/v1/geo", geoRoutes);            // map pin -> region/province/city (Nominatim, server-side)
app.use("/api/v1/admin/shipping-rates", rateRoutes);
app.use("/api/v1/payments", paymentRoutes);
app.use("/api/v1", chatRoutes);              // /chat/messages (AI chat support, Gemini server-side)
app.use("/api/v1", chatAdminRoutes);         // /admin/chat/*, /admin/faqs
app.use("/api/v1/admin/accounts", adminAccountRoutes);   // account management (admins)
app.use("/api/v1/admin/notifications", notificationRoutes);   // the admin bell: list, read state, live stream (SSE)
app.use("/api/v1", logisticsRoutes); // /shipping/quote, /orders/:id/tracking, /admin/shipments, /webhooks/lalamove

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

// Anything else: a short JSON 404, never Express's own error page.
app.use((req, res) => res.status(404).json({ error: "Not found." }));

// Validation errors (bad upload, malformed JSON) keep their message so the
// frontend can show it; PayMongo/Lalamove failures are 502; anything else is
// an unexpected 500 and gets a generic message. In production a 502 never
// repeats the provider's own error text (it stays in the log).
const PROVIDER_FAILED = {
  PaymentError: "The payment service couldn't complete this. Please try again in a moment.",
  LogisticsError: "The courier service couldn't complete this. Please try again in a moment.",
};
// A body the API couldn't read (bad JSON, too large): a fixed message. The parser's own
// text repeats what was sent and names the library.
const BODY_ERRORS = { "entity.too.large": [413, "The request is too large."] };
app.use((err, req, res, next) => {
  if (typeof err.type === "string" && err.type.includes(".")) {
    const [status, error] = BODY_ERRORS[err.type] || [400, "The request couldn't be read."];
    return res.status(status).json({ error });
  }
  if (err instanceof PaymentError || err instanceof LogisticsError) {
    logError(err.constructor.name, err);
    const hide = err.fromProvider && process.env.NODE_ENV === "production";
    return res.status(502).json({ error: hide ? PROVIDER_FAILED[err.constructor.name] : err.message });
  }
  const status = err instanceof multer.MulterError ? 400 : err.status || err.statusCode || 500;
  if (status < 500) {
    return res.status(status).json({ error: err.message || "Invalid request.", ...(typeof err.code === "string" && /^[A-Z_]+$/.test(err.code) ? { code: err.code } : {}) });
  }
  // Never the whole error: database errors carry the SQL with its values (personal data).
  logError(`${req.method} ${req.path} failed`, err);
  res.status(500).json({ error: "Something went wrong." });
});

if (require.main === module) {
  // Which outside services are on. Names only, never values (lib/integrationStatus.js).
  console.log("Integrations (from .env; restart after changing it):");
  statusLines().forEach((line) => console.log(`  ${line}`));

  // Personal information is stored encrypted (lib/dataProtection.js): without working
  // keys the server would write it in plain text or fail to read it, so it won't start.
  try {
    require("./lib/dataProtection").assertReady();
  } catch (err) {
    console.error(`Encryption: ${err.message}. The server will not start without it (see Backend/.env.example).`);
    process.exit(1);
  }

  // Production settings (lib/productionChecks.js): errors stop the start, warnings are listed.
  const { errors, warnings } = require("./lib/productionChecks").startupChecks();
  warnings.forEach((w) => console.warn(`WARNING: ${w}`));
  if (errors.length) {
    errors.forEach((e) => console.error(`ERROR: ${e}`));
    console.error("The server will not start in production until these are fixed in Backend/.env (see DEPLOYMENT.md).");
    process.exit(1);
  }

  // If MySQL can't be reached, stop here instead of answering every request with an error:
  // Docker or the service manager starts the API again a few seconds later (DEPLOYMENT.md).
  const pool = require("./db");
  pool.query("SELECT 1").catch((err) => {
    console.error(`Database: can't connect (${err.code || err.message}). Check DB_HOST, DB_USER, DB_PASSWORD and DB_NAME in Backend/.env.`);
    process.exit(1);
  })
    // The ML worker is a separate process; this says whether it's running and when it last trained.
    .then(() => require("./lib/mlStatus").mlStatusLine(pool))
    .then((line) => {
      console.log(`  ${line}`);
      const PORT = process.env.PORT || 4000;
      // This machine only by default: browsers reach the API through nginx. Docker sets HOST=0.0.0.0
      // inside its container, whose port is published on 127.0.0.1 only (docker-compose.yml).
      const HOST = process.env.HOST || "127.0.0.1";
      app.listen(PORT, HOST, () => {
        console.log(`Bongalink API running on http://${HOST}:${PORT}`);
      });
      startOrderExpiryJob();
    });
}

module.exports = app;
