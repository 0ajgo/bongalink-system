/* =====================================================================
   server.js — Bongalink API entry point
   Run with:  npm run dev   (local development, auto-restarts)
              npm start     (production)
   ===================================================================== */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const authRoutes = require("./routes/auth");
const categoryRoutes = require("./routes/categories");
const productRoutes = require("./routes/products");
const cartRoutes = require("./routes/cart");
const orderRoutes = require("./routes/orders");

const app = express();

// Only origins listed in CORS_ORIGIN (.env) may call this API.
// Add your hosted frontend's URL there once deployed — no code change.
const allowedOrigins = (process.env.CORS_ORIGIN || "").split(",").map(o => o.trim());
app.use(cors({ origin: allowedOrigins }));

app.use(express.json());

// Serves uploaded product images at /uploads/<filename>
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.use("/api/auth", authRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/products", productRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/orders", orderRoutes);

app.get("/api/health", (req, res) => res.json({ status: "ok" }));

// Multer / generic error handler (e.g. bad file type, file too large)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(400).json({ error: err.message || "Something went wrong." });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Bongalink API running on http://localhost:${PORT}`);
});
