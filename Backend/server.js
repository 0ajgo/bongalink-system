/* =====================================================================
   server.js — Bongalink API entry point
   Run with:  npm run dev   (local development, auto-restarts)
              npm start     (production)
   Tests import `app` from here without starting the listener.
   ===================================================================== */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
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
const { PaymentError } = require("./services/paymongo");
const { LogisticsError } = require("./services/lalamove");
const { startOrderExpiryJob } = require("./jobs/expireOrders");

const app = express();

// PayMongo signs the RAW body, so this route must come BEFORE express.json().
app.post("/api/v1/webhooks/paymongo", express.raw({ type: "application/json" }), ah(paymongoWebhook));

// Only origins listed in CORS_ORIGIN (.env) may call this API.
// Add your hosted frontend's URL there once deployed — no code change.
const allowedOrigins = (process.env.CORS_ORIGIN || "").split(",").map(o => o.trim());
app.use(cors({ origin: allowedOrigins }));

app.use(express.json({ limit: "100kb" }));

// Serves uploaded product images at /uploads/<filename>
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.use("/api/auth", authRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/products", productRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/admin/ml", mlRoutes);

// Limit code requests/guesses per IP (on top of the per-code attempt limit).
app.use("/api/v1/auth/verify-email", rateLimit({ windowMs: 15 * 60 * 1000, limit: 20 }), verifyEmailRoutes);
app.use("/api/v1/payments", paymentRoutes);
app.use("/api/v1", logisticsRoutes); // /shipping/quote, /orders/:id/tracking, /admin/shipments, /webhooks/lalamove

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

// Validation errors (bad upload, malformed JSON) keep their message so the
// frontend can show it; PayMongo/Lalamove failures are 502; anything else is
// an unexpected 500 and gets a generic message.
app.use((err, req, res, next) => {
  if (err instanceof PaymentError || err instanceof LogisticsError) {
    console.error(`${err.constructor.name}: ${err.message}`);
    return res.status(502).json({ error: err.message });
  }
  const status = err instanceof multer.MulterError ? 400 : err.status || err.statusCode || 500;
  if (status < 500) {
    return res.status(status).json({ error: err.message || "Invalid request." });
  }
  console.error(err);
  res.status(500).json({ error: "Something went wrong." });
});

// Names only — never print the values.
const INTEGRATION_ENV = [
  "VERIFICATION_SECRET", "SMTP_USER", "SMTP_PASS", "MAIL_FROM", "ADMIN_ALERT_EMAIL", "APP_URL",
  "PAYMONGO_SECRET_KEY", "PAYMONGO_WEBHOOK_SECRET"
];

if (require.main === module) {
  const missing = INTEGRATION_ENV.filter(name => !process.env[name]);
  if (missing.length) console.warn(`Not set in .env (related features will fail): ${missing.join(", ")}`);

  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => {
    console.log(`Bongalink API running on http://localhost:${PORT}`);
  });
  startOrderExpiryJob();
}

module.exports = app;
