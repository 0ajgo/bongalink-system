/* =====================================================================
   BONGALINK — LOGIN SCRIPT (backend-connected)
   File: login.js
   Requires api.js to be loaded first (see login.html <script> order).
   Powers: login.html (role switch, password visibility toggle,
           credential check against the real `users` table, session).
   ===================================================================== */

/* ---------------------------------------------------------------------
   1. DOM REFERENCES
   --------------------------------------------------------------------- */
const loginForm = document.getElementById("loginForm");
const userRoleBtn = document.getElementById("userRoleBtn");
const adminRoleBtn = document.getElementById("adminRoleBtn");
const passwordInput = document.getElementById("password");
const togglePassword = document.getElementById("togglePassword");
const loginMessage = document.getElementById("loginMessage");
const forgotPassword = document.getElementById("forgotPassword");
const loginSubmitBtn = loginForm.querySelector(".login-btn");

let selectedRole = "user";

/* ---------------------------------------------------------------------
   2. ROLE SWITCH (User / Admin tabs)
   --------------------------------------------------------------------- */
function setRole(role) {
  selectedRole = role;
  userRoleBtn.classList.toggle("active", role === "user");
  adminRoleBtn.classList.toggle("active", role === "admin");
  clearMessage();
}

userRoleBtn.addEventListener("click", () => setRole("user"));
adminRoleBtn.addEventListener("click", () => setRole("admin"));

/* ---------------------------------------------------------------------
   3. SHOW / HIDE PASSWORD
   --------------------------------------------------------------------- */
togglePassword.addEventListener("click", () => {
  const show = passwordInput.type === "password";
  passwordInput.type = show ? "text" : "password";
  togglePassword.textContent = show ? "Hide" : "Show";
});

/* ---------------------------------------------------------------------
   4. LOGIN SUBMIT — POST /api/auth/login
   On success: stores the JWT + role + username in sessionStorage.
   Homepage.js reads bongalink_role to gate admin-only features and
   sends the token on every request via api.js's apiFetch().
   --------------------------------------------------------------------- */
loginForm.addEventListener("submit", async event => {
  event.preventDefault();

  const username = document.getElementById("username").value.trim();
  const password = passwordInput.value;
  const remember = document.getElementById("rememberMe").checked;

  if (!username || !password) {
    showMessage("Please enter your username and password.", "error");
    return;
  }

  loginSubmitBtn.disabled = true;

  try {
    const data = await apiFetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password, role: selectedRole })
    });

    sessionStorage.setItem("bongalink_token", data.token);
    sessionStorage.setItem("bongalink_logged_in", "true");
    sessionStorage.setItem("bongalink_role", data.user.role);
    sessionStorage.setItem("bongalink_username", data.user.username);

    if (remember) {
      localStorage.setItem("bongalink_remember", "true");
    } else {
      localStorage.removeItem("bongalink_remember");
    }

    showMessage("Login successful. Redirecting...", "success");
    setTimeout(() => { window.location.href = "homepage.html"; }, 700);
  } catch (err) {
    showMessage(err.message || "Invalid username or password.", "error");
  } finally {
    loginSubmitBtn.disabled = false;
  }
});

/* ---------------------------------------------------------------------
   5. FORGOT PASSWORD (placeholder until a real email flow exists)
   --------------------------------------------------------------------- */
forgotPassword.addEventListener("click", event => {
  event.preventDefault();
  showMessage("Password recovery will be connected later.", "error");
});

/* ---------------------------------------------------------------------
   6. MESSAGE HELPERS
   --------------------------------------------------------------------- */
function showMessage(message, type) {
  loginMessage.textContent = message;
  loginMessage.className = `login-message ${type}`;
}

function clearMessage() {
  loginMessage.textContent = "";
  loginMessage.className = "login-message";
}