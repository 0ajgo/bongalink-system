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
const accountRoutes = require("./routes/account");
const geoRoutes = require("./routes/geo");
const rateRoutes = require("./routes/rates");
const chatRoutes = require("./routes/chat");
const chatAdminRoutes = require("./routes/chatAdmin");
const adminAccountRoutes = require("./routes/adminAccounts");
const { PaymentError } = require("./services/paymongo");
const { LogisticsError } = require("./services/lalamove");
const { startOrderExpiryJob } = require("./jobs/expireOrders");
const { statusLines } = require("./lib/integrationStatus");
const { logError } = require("./lib/pii");

const app = express();

// PayMongo signs the RAW body, so this route must come BEFORE express.json().
app.post("/api/v1/webhooks/paymongo", express.raw({ type: "application/json" }), ah(paymongoWebhook));

// Only origins listed in CORS_ORIGIN (.env) may call this API.
// Add your hosted frontend's URL there once deployed — no code change.
const allowedOrigins = (process.env.CORS_ORIGIN || "").split(",").map(o => o.trim());
app.use(cors({ origin: allowedOrigins }));

app.use(express.json({ limit: "100kb" }));

// Serves uploaded product images at /uploads/<filename>
app.use("/uploads", express.static(process.env.UPLOAD_DIR || path.join(__dirname, "uploads")));

app.use("/api/auth", authRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/products", productRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/admin/ml", mlRoutes);

// Limit code requests/guesses per IP (on top of the per-code attempt limit).
app.use("/api/v1/auth/verify-email", rateLimit({ windowMs: 15 * 60 * 1000, limit: 20 }), verifyEmailRoutes);
app.use("/api/v1/account", accountRoutes);   // profile, password, saved addresses
app.use("/api/v1/geo", geoRoutes);            // map pin -> region/province/city (Nominatim, server-side)
app.use("/api/v1/admin/shipping-rates", rateRoutes);
app.use("/api/v1/payments", paymentRoutes);
app.use("/api/v1", chatRoutes);              // /chat/messages (AI chat support, Gemini server-side)
app.use("/api/v1", chatAdminRoutes);         // /admin/chat/*, /admin/faqs
app.use("/api/v1/admin/accounts", adminAccountRoutes);   // account management (admins)
app.use("/api/v1", logisticsRoutes); // /shipping/quote, /orders/:id/tracking, /admin/shipments, /webhooks/lalamove

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

// Validation errors (bad upload, malformed JSON) keep their message so the
// frontend can show it; PayMongo/Lalamove failures are 502; anything else is
// an unexpected 500 and gets a generic message.
app.use((err, req, res, next) => {
  if (err instanceof PaymentError || err instanceof LogisticsError) {
    logError(err.constructor.name, err);
    return res.status(502).json({ error: err.message });
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

  // The ML worker is a separate process; this says whether it's running and when it last trained.
  require("./lib/mlStatus").mlStatusLine(require("./db")).then((line) => {
    console.log(`  ${line}`);
    const PORT = process.env.PORT || 4000;
    app.listen(PORT, () => {
      console.log(`Bongalink API running on http://localhost:${PORT}`);
    });
    startOrderExpiryJob();
  });
}

module.exports = app;
