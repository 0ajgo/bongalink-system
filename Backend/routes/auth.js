/* =====================================================================
   routes/auth.js
   Powers: register.html (POST /api/auth/register) and
           login.html (POST /api/auth/login)
   Backing table: users
   ===================================================================== */

const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db");
const { issueVerificationCode } = require("./emailVerification");

const router = express.Router();

/* ---------------------------------------------------------------------
   POST /api/auth/register
   Body: { username, email, password }
   Always creates a regular "user" account — admins are provisioned
   directly in the database, never through this endpoint.
   --------------------------------------------------------------------- */
router.post("/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: "Please fill in all fields." });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }

    const [existing] = await pool.query(
      "SELECT user_id FROM users WHERE username = ? OR email = ?",
      [username, email]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: "Username or email already in use." });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const [result] = await pool.query(
      "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, 'user')",
      [username, email, passwordHash]
    );

    // The account exists either way; if the email can't be sent now, the
    // user can ask for a new code from the verify step.
    let emailSent = true;
    try {
      await issueVerificationCode({ id: result.insertId, name: username, email });
    } catch (err) {
      emailSent = false;
      console.error("Verification email failed:", err.message);
    }

    res.status(201).json({
      message: emailSent
        ? "Account created. Enter the 6-digit code we sent to your email."
        : "Account created, but we couldn't send the verification email. Use \"Resend code\" to try again.",
      verificationRequired: true,
      emailSent
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Registration failed." });
  }
});

/* ---------------------------------------------------------------------
   POST /api/auth/login
   Body: { username, password, role }  -- role is the tab the user
   picked (User/Admin) on the login page; the server re-checks it
   against the real role in the database rather than trusting it blindly.
   --------------------------------------------------------------------- */
router.post("/login", async (req, res) => {
  try {
    const { username, password, role } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "Please enter your username and password." });
    }

    const [rows] = await pool.query(
      "SELECT user_id, username, email, password_hash, role FROM users WHERE username = ?",
      [username]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    const user = rows[0];
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

    const token = jwt.sign(
      { userId: user.user_id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    res.json({
      token,
      user: { username: user.username, role: user.role }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed." });
  }
});

module.exports = router;