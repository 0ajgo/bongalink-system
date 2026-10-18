/* =====================================================================
   routes/auth.js
   Powers: register.html (POST /api/auth/register),
           login.html (POST /api/auth/login) and
           set-password.html (GET/POST /api/auth/set-password: accounts
           created by an admin, services/accountSetup.js) and
           reset-password.html (forgot password, services/passwordReset.js)
   Backing table: users
   ===================================================================== */

const express = require("express");
const bcrypt = require("bcryptjs");
const pool = require("../db");
const ah = require("../lib/asyncHandler");
const { issueVerificationCode } = require("./emailVerification");
const { rateLimit, MemoryStore } = require("express-rate-limit");
const { startSession, endSession, bearer, SUSPENDED } = require("../middleware/auth");
const { findSetup, completeSetup } = require("../services/accountSetup");
const { requestReset, findReset, completeReset } = require("../services/passwordReset");
const { emailColumns, logError } = require("../lib/pii");
const { blindIndex } = require("../lib/dataProtection");
const { PRIVACY_POLICY_VERSION } = require("../lib/privacy");
const notifications = require("../services/notifications");

const router = express.Router();

/* ---------------------------------------------------------------------
   POST /api/auth/register
   Body: { username, email, password, privacy_consent: true }
   The email is stored encrypted, found by its blind index (email_bidx).
   Accepting the privacy notice is required and recorded in consent_records.
   Always creates a regular "user" account — admins are provisioned
   directly in the database, never through this endpoint.
   --------------------------------------------------------------------- */
router.post("/register", ah(async (req, res) => {
  try {
    const { username, password } = req.body;
    const email = String(req.body.email || "").trim();

    if (!username || !email || !password) {
      return res.status(400).json({ error: "Please fill in all fields." });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }
    if (req.body.privacy_consent !== true) {
      return res.status(400).json({ error: "Please read and accept the privacy notice to create an account.", code: "PRIVACY_CONSENT_REQUIRED" });
    }

    const [existing] = await pool.query(
      "SELECT user_id FROM users WHERE username = ? OR email_bidx = ?",
      [username, blindIndex(email)]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: "Username or email already in use." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const stored = emailColumns(email);

    const connection = await pool.getConnection();
    let result;
    try {
      await connection.beginTransaction();
      [result] = await connection.query(
        "INSERT INTO users (username, email, email_bidx, password_hash, role) VALUES (?, ?, ?, ?, 'user')",
        [username, stored.email, stored.email_bidx, passwordHash]
      );
      await connection.query(
        `INSERT INTO consent_records (user_id, consent_type, granted, policy_version, source)
         VALUES (?, 'PRIVACY_NOTICE', 1, ?, 'registration')`,
        [result.insertId, PRIVACY_POLICY_VERSION]
      );
      await notifications.customerRegistered(connection, { userId: result.insertId, username });   // admin bell
      await connection.commit();
    } catch (err) {
      await connection.rollback();
      if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "Username or email already in use." });
      throw err;
    } finally {
      connection.release();
    }

    // The account exists either way; if the email can't be sent now, the
    // user can ask for a new code from the verify step.
    let emailSent = true;
    try {
      await issueVerificationCode({ id: result.insertId, name: username, email });
    } catch (err) {
      emailSent = false;
      logError("Verification email failed", err);
    }

    res.status(201).json({
      message: emailSent
        ? "Account created. Enter the 6-digit code we sent to your email."
        : "Account created, but we couldn't send the verification email. Use \"Resend code\" to try again.",
      verificationRequired: true,
      emailSent
    });
  } catch (err) {
    logError("Registration failed", err);
    res.status(500).json({ error: "Registration failed." });
  }
}));

/* ---------------------------------------------------------------------
   POST /api/auth/login
   Body: { username, password, remember?, role? }  -- role is the tab the user
   picked (User/Admin) on the login page; the server re-checks it
   against the real role in the database rather than trusting it blindly.
   --------------------------------------------------------------------- */
router.post("/login", ah(async (req, res) => {
  try {
    const { username, password, role } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Please enter your username and password." });
    }

    const [rows] = await pool.query(
      `SELECT user_id, username, email, password_hash, role, status, token_version, must_set_password
         FROM users WHERE username = ?`,
      [username]
    );
    // Deleted (anonymized) accounts look like unknown usernames.
    if (rows.length === 0 || rows[0].status === "deleted") {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    const user = rows[0];
    // Created by an admin and not set up yet: there is no password to check.
    if (user.must_set_password) {
      return res.status(403).json({
        error: "Finish setting up your account first: open the link we emailed you to set your password. If it expired, ask the shop to send a new one.",
        code: "PASSWORD_NOT_SET"
      });
    }
    const passwordMatches = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatches) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    // If the person picked the "Admin" tab but their account isn't an
    // admin (or vice versa), reject it here rather than letting a
    // regular user in through the admin tab.
    if (role && role !== user.role) {
      return res.status(403).json({ error: `This account is not registered as ${role}.` });
    }

    // Checked after the password, so the status of an account isn't revealed to guessers.
    if (user.status === "suspended") return res.status(403).json(SUSPENDED);

    // "Remember me": a 30-day login the browser keeps after closing; otherwise this tab only.
    const session = await startSession(user, { remember: req.body.remember === true });
    await pool.query("UPDATE users SET last_login_at = NOW() WHERE user_id = ?", [user.user_id]);

    res.json({
      token: session.token,
      remember: session.remember,
      expires_at: session.expiresAt,
      user: { username: user.username, role: user.role }
    });
  } catch (err) {
    logError("Login failed", err);
    res.status(500).json({ error: "Login failed." });
  }
}));

/* ---------------------------------------------------------------------
   POST /api/auth/logout — ends this device's session at once (the token
   stops working everywhere it was copied). Always answers 200, so the
   browser can always finish logging out.
   --------------------------------------------------------------------- */
router.post("/logout", ah(async (req, res) => {
  const token = bearer(req);
  try {
    if (token) await endSession(token);
  } catch (err) {
    logError("Logout failed", err);
  }
  res.json({ ok: true });
}));

/* ---------------------------------------------------------------------
   Set-password link for accounts created by an admin.
   GET  /api/auth/set-password?token=...    is the link still good? -> { username }
   POST /api/auth/set-password  { token, password }
   --------------------------------------------------------------------- */
const setupLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false,
  message: { error: "Too many tries. Please wait a few minutes." } });
const BAD_LINK = "This link is invalid, already used or expired. Ask the shop to send a new one.";

router.get("/set-password", setupLimit, ah(async (req, res) => {
  try {
    const setup = await findSetup(req.query.token);
    if (!setup) return res.status(400).json({ error: BAD_LINK });
    res.json({ username: setup.username });
  } catch (err) {
    logError("Set-password link check failed", err);
    res.status(500).json({ error: "Could not check the link." });
  }
}));

router.post("/set-password", setupLimit, ah(async (req, res) => {
  try {
    if (req.body?.privacy_consent !== true) {
      return res.status(400).json({ error: "Please read and accept the privacy notice to finish setting up your account.", code: "PRIVACY_CONSENT_REQUIRED" });
    }
    const result = await completeSetup(req.body?.token, req.body?.password);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ message: "Password set. You can log in now.", username: result.username });
  } catch (err) {
    logError("Set password failed", err);
    res.status(500).json({ error: "Could not set the password." });
  }
}));

/* ---------------------------------------------------------------------
   Forgot password (services/passwordReset.js).
   POST /api/auth/forgot-password  { email }   always the same answer
   GET  /api/auth/reset-password?token=...      is the link still good? -> { username }
   POST /api/auth/reset-password  { token, password }
   Rate limits: per IP, and per email (counted by its blind index, so it
   works the same for emails with and without an account).
   --------------------------------------------------------------------- */
const RESET_SENT = "If that email has an account, we've sent a reset link. It works for 30 minutes.";
const tooMany = { error: "Too many reset requests. Please wait a while and try again.", code: "RATE_LIMITED" };
const resetStores = [new MemoryStore(), new MemoryStore(), new MemoryStore()];
const forgotPerIp = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, store: resetStores[0],
  standardHeaders: "draft-7", legacyHeaders: false, message: tooMany });
const forgotPerEmail = rateLimit({ windowMs: 60 * 60 * 1000, limit: 3, store: resetStores[1],
  standardHeaders: "draft-7", legacyHeaders: false, message: tooMany,
  keyGenerator: (req) => `email:${blindIndex(req.body?.email) || "none"}` });
const resetLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, store: resetStores[2],
  standardHeaders: "draft-7", legacyHeaders: false, message: { error: "Too many tries. Please wait a few minutes." } });
const BAD_RESET_LINK = "This link is invalid, already used or expired. Ask for a new one from the login page.";

router.post("/forgot-password", forgotPerIp, forgotPerEmail, ah(async (req, res) => {
  const email = String(req.body?.email || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 150) {
    return res.status(400).json({ error: "Enter the email address of your account." });
  }
  // Answer right away and send in the background: the same answer, and about the same
  // response time, whether or not the email has an account. Failures are only logged.
  requestReset(email).catch((err) => logError("Password reset request failed", err));
  res.json({ message: RESET_SENT });
}));

router.get("/reset-password", resetLimit, ah(async (req, res) => {
  try {
    const reset = await findReset(req.query.token);
    if (!reset) return res.status(400).json({ error: BAD_RESET_LINK });
    if (reset.status === "suspended") return res.status(403).json(SUSPENDED);
    res.json({ username: reset.username });
  } catch (err) {
    logError("Reset link check failed", err);
    res.status(500).json({ error: "Could not check the link." });
  }
}));

router.post("/reset-password", resetLimit, ah(async (req, res) => {
  try {
    const result = await completeReset(req.body?.token, req.body?.password);
    if (result.code === "ACCOUNT_SUSPENDED") return res.status(403).json(SUSPENDED);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ message: "Your password was changed. Log in with the new one.", username: result.username });
  } catch (err) {
    logError("Password reset failed", err);
    res.status(500).json({ error: "Could not reset the password." });
  }
}));

// Tests: start every test from empty rate-limit counters.
router.resetRateLimits = () => Promise.all(resetStores.map((s) => s.resetAll()));

module.exports = router;
