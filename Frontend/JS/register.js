/* =====================================================================
   BONGALINK — REGISTER + VERIFY EMAIL (register.html)
   Requires api.js, icons.js, cart.js and ui.js.
   1. POST /api/auth/register creates a "user" account and emails a code.
   2. POST /api/v1/auth/verify-email/confirm { email, code } verifies it;
      /send issues a new code (60-second cooldown, enforced server-side).
   Checkout is blocked until the email is verified.
   ===================================================================== */

renderHeader({ search: false });

const registerForm = document.getElementById("registerForm");
const verifyForm = document.getElementById("verifyForm");
let verifyEmail = "";

function showAlert(id, message, type) {
  const el = document.getElementById(id);
  el.hidden = false;
  el.className = `alert alert--${type}`;
  el.innerHTML = `${icon({ error: "circle-alert", success: "check" }[type] || "info", { size: 18 })}<span>${escapeHTML(message)}</span>`;
}

function busy(button, on) {
  button.disabled = on;
  button.classList.toggle("is-loading", on);
}

document.querySelectorAll("[data-toggle]").forEach(button => {
  button.addEventListener("click", () => {
    const input = document.getElementById(button.dataset.toggle);
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    button.textContent = show ? "Hide" : "Show";
  });
});

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = document.getElementById("regUsername").value.trim();
  const email = document.getElementById("regEmail").value.trim();
  const password = document.getElementById("regPassword").value;
  const confirmPassword = document.getElementById("regConfirmPassword").value;

  if (!username || !email || !password || !confirmPassword) return showAlert("registerMessage", "Please fill in all fields.", "error");
  if (password !== confirmPassword) return showAlert("registerMessage", "Passwords do not match.", "error");
  if (password.length < 6) return showAlert("registerMessage", "Password must be at least 6 characters.", "error");

  const button = document.getElementById("registerSubmit");
  busy(button, true);
  try {
    const result = await apiFetch("/auth/register", { method: "POST", body: JSON.stringify({ username, email, password }) });
    showVerifyStep(email, result);
  } catch (err) {
    showAlert("registerMessage", err.message || "Registration failed.", "error");
  } finally {
    busy(button, false);
  }
});

function showVerifyStep(email, result) {
  verifyEmail = email;
  document.getElementById("registerStep").hidden = true;
  document.getElementById("verifyStep").hidden = false;
  document.getElementById("verifyIntro").textContent = result.emailSent === false
    ? `Your account is ready, but we couldn't send the code to ${email}. Use "Send a new code" below.`
    : `We sent a 6-digit code to ${email}. It expires in 15 minutes.`;
  document.getElementById("verifyCode").focus();
}

verifyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.getElementById("verifySubmit");
  busy(button, true);
  try {
    await apiFetch("/v1/auth/verify-email/confirm", {
      method: "POST", body: JSON.stringify({ email: verifyEmail, code: document.getElementById("verifyCode").value.trim() })
    });
    showAlert("verifyMessage", "Email verified. Taking you to log in…", "success");
    setTimeout(() => { window.location.href = "login.html"; }, 800);
  } catch (err) {
    showAlert("verifyMessage", err.message || "Verification failed.", "error");
    busy(button, false);
  }
});

document.getElementById("resendCode").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  busy(button, true);
  try {
    const result = await apiFetch("/v1/auth/verify-email/send", { method: "POST", body: JSON.stringify({ email: verifyEmail }) });
    showAlert("verifyMessage", result.message, "success");
  } catch (err) {
    showAlert("verifyMessage", err.message || "Couldn't send a new code.", "error");
  } finally {
    busy(button, false);
  }
});
