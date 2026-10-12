/* =====================================================================
   BONGALINK — REGISTER SCRIPT (backend-connected)
   File: register.js
   Requires api.js to be loaded first.
   Powers: register.html — POST /api/auth/register, which INSERTs
   directly into the real `users` table (role: "user").
   ===================================================================== */

/* ---------------------------------------------------------------------
   1. DOM REFERENCES
   --------------------------------------------------------------------- */
const registerForm = document.getElementById("registerForm");
const regUsername = document.getElementById("regUsername");
const regEmail = document.getElementById("regEmail");
const regPassword = document.getElementById("regPassword");
const regConfirmPassword = document.getElementById("regConfirmPassword");
const registerMessage = document.getElementById("registerMessage");
const registerSubmitBtn = registerForm.querySelector(".login-btn");

const toggleRegPassword = document.getElementById("toggleRegPassword");
const toggleRegConfirmPassword = document.getElementById("toggleRegConfirmPassword");

/* ---------------------------------------------------------------------
   2. SHOW / HIDE PASSWORD (both fields)
   --------------------------------------------------------------------- */
function wireToggle(button, input) {
  button.addEventListener("click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    button.textContent = show ? "Hide" : "Show";
  });
}
wireToggle(toggleRegPassword, regPassword);
wireToggle(toggleRegConfirmPassword, regConfirmPassword);

/* ---------------------------------------------------------------------
   3. REGISTER SUBMIT — POST /api/auth/register
   Server re-checks uniqueness and password rules — the checks below
   are just for instant feedback before hitting the network.
   --------------------------------------------------------------------- */
registerForm.addEventListener("submit", async event => {
  event.preventDefault();

  const username = regUsername.value.trim();
  const email = regEmail.value.trim();
  const password = regPassword.value;
  const confirmPassword = regConfirmPassword.value;

  if (!username || !email || !password || !confirmPassword) {
    showMessage("Please fill in all fields.", "error");
    return;
  }
  if (password !== confirmPassword) {
    showMessage("Passwords do not match.", "error");
    return;
  }
  if (password.length < 6) {
    showMessage("Password must be at least 6 characters.", "error");
    return;
  }

  registerSubmitBtn.disabled = true;

  try {
    const result = await apiFetch("/auth/register", {
      method: "POST",
      body: JSON.stringify({ username, email, password })
    });

    showVerifyStep(email, result.message);
  } catch (err) {
    showMessage(err.message || "Registration failed.", "error");
  } finally {
    registerSubmitBtn.disabled = false;
  }
});

/* ---------------------------------------------------------------------
   4. VERIFY EMAIL — the server emailed a 6-digit code on register.
   POST /api/v1/auth/verify-email/confirm marks the email verified;
   /send issues a new code (60-second cooldown, enforced server-side).
   Checkout is blocked until this succeeds, but the user can also do it
   later from the checkout page.
   --------------------------------------------------------------------- */
const verifyForm = document.getElementById("verifyForm");
const verifyCode = document.getElementById("verifyCode");
const verifyMessage = document.getElementById("verifyMessage");
let verifyEmail = "";

function showVerifyStep(email, message) {
  verifyEmail = email;
  registerForm.hidden = true;
  verifyForm.hidden = false;
  document.getElementById("verifyIntro").textContent = message;
  verifyCode.focus();
}

verifyForm.addEventListener("submit", async event => {
  event.preventDefault();
  const button = verifyForm.querySelector(".login-btn");
  button.disabled = true;
  try {
    await apiFetch("/v1/auth/verify-email/confirm", {
      method: "POST",
      body: JSON.stringify({ email: verifyEmail, code: verifyCode.value.trim() })
    });
    showVerifyMessage("Email verified. Redirecting to login...", "success");
    setTimeout(() => { window.location.href = "login.html"; }, 800);
  } catch (err) {
    showVerifyMessage(err.message || "Verification failed.", "error");
  } finally {
    button.disabled = false;
  }
});

document.getElementById("resendCode").addEventListener("click", async () => {
  try {
    const result = await apiFetch("/v1/auth/verify-email/send", {
      method: "POST",
      body: JSON.stringify({ email: verifyEmail })
    });
    showVerifyMessage(result.message, "success");
  } catch (err) {
    showVerifyMessage(err.message || "Couldn't send a new code.", "error");
  }
});

/* ---------------------------------------------------------------------
   5. MESSAGE HELPERS
   --------------------------------------------------------------------- */
function showMessage(message, type) {
  registerMessage.textContent = message;
  registerMessage.className = `login-message ${type}`;
}

function showVerifyMessage(message, type) {
  verifyMessage.textContent = message;
  verifyMessage.className = `login-message ${type}`;
}