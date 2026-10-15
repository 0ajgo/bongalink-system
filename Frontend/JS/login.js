/* =====================================================================
   BONGALINK — LOGIN (login.html)
   Requires api.js, icons.js, cart.js and ui.js.
   POST /api/auth/login { username, password }. The server takes the role
   from the account, so customers and the admin share one form. On
   success the JWT, role and username go to sessionStorage (api.js sends
   the token with every request).
   ===================================================================== */

renderHeader({ search: false });

const loginForm = document.getElementById("loginForm");
const passwordInput = document.getElementById("password");
const togglePassword = document.getElementById("togglePassword");
const loginMessage = document.getElementById("loginMessage");
const loginSubmitBtn = document.getElementById("loginSubmit");

// Only same-site pages under Pages/ (set by requireLoginPage() in ui.js).
function nextPage(role) {
  const next = new URLSearchParams(location.search).get("next") || "";
  if (/^[A-Za-z]+\/[A-Za-z0-9_-]+\.html(\?[\w=&%-]*)?$/.test(next)) return `../${next}`;
  return role === "admin" ? "../Admin/dashboard.html" : "homepage.html";
}

function showMessage(message, type) {
  loginMessage.hidden = false;
  loginMessage.className = `alert alert--${type}`;
  loginMessage.innerHTML = `${icon(type === "error" ? "circle-alert" : "check", { size: 18 })}<span>${escapeHTML(message)}</span>`;
}

// Sent here by api.js when the account was suspended or the session was ended.
const ENDED = {
  suspended: ["Your account is suspended. Contact the shop.", "error"],
  ended: ["Your session has ended. Please log in again.", "info"]
};
const ended = ENDED[new URLSearchParams(location.search).get("ended")];
if (ended) showMessage(...ended);

togglePassword.addEventListener("click", () => {
  const show = passwordInput.type === "password";
  passwordInput.type = show ? "text" : "password";
  togglePassword.textContent = show ? "Hide" : "Show";
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = document.getElementById("username").value.trim();
  const password = passwordInput.value;
  const remember = document.getElementById("rememberMe").checked;

  if (!username || !password) {
    showMessage("Please enter your username and password.", "error");
    return;
  }

  loginSubmitBtn.disabled = true;
  loginSubmitBtn.classList.add("is-loading");
  try {
    const data = await apiFetch("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });

    sessionStorage.setItem("bongalink_token", data.token);
    sessionStorage.setItem("bongalink_logged_in", "true");
    sessionStorage.setItem("bongalink_role", data.user.role);
    sessionStorage.setItem("bongalink_username", data.user.username);
    if (remember) localStorage.setItem("bongalink_remember", "true");
    else localStorage.removeItem("bongalink_remember");

    showMessage("Logged in. Taking you there…", "success");
    window.location.href = nextPage(data.user.role);
  } catch (err) {
    showMessage(err.message || "Invalid username or password.", "error");
    loginSubmitBtn.disabled = false;
    loginSubmitBtn.classList.remove("is-loading");
  }
});

/* ---------------------------------------------------------------------
   FORGOT PASSWORD — login.html#forgot
   POST /api/auth/forgot-password { email }. The answer is the same whether
   or not the email has an account.
   --------------------------------------------------------------------- */
const forgotForm = document.getElementById("forgotForm");
const forgotEmail = document.getElementById("forgotEmail");

function showStep(forgot) {
  document.getElementById("loginStep").hidden = forgot;
  document.getElementById("forgotStep").hidden = !forgot;
  (forgot ? forgotEmail : document.getElementById("username")).focus();
}

function forgotNotice(message, type) {
  const box = document.getElementById("forgotMessage");
  box.hidden = false;
  box.className = `alert alert--${type}`;
  box.innerHTML = `${icon(type === "error" ? "circle-alert" : "mail", { size: 18 })}<span>${escapeHTML(message)}</span>`;
}

document.getElementById("forgotPassword").addEventListener("click", (event) => {
  event.preventDefault();
  history.replaceState(null, "", "#forgot");
  showStep(true);
});
document.getElementById("backToLogin").addEventListener("click", (event) => {
  event.preventDefault();
  history.replaceState(null, "", location.pathname + location.search);
  showStep(false);
});
forgotEmail.addEventListener("input", () => {
  document.getElementById("forgotEmailError").textContent = "";
  forgotEmail.removeAttribute("aria-invalid");
});

forgotForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = forgotEmail.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    document.getElementById("forgotEmailError").textContent = "Enter the email address of your account.";
    forgotEmail.setAttribute("aria-invalid", "true");
    return forgotEmail.focus();
  }
  const button = document.getElementById("forgotSubmit");
  button.disabled = true;
  button.classList.add("is-loading");
  try {
    const { message } = await apiFetch("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) });
    forgotNotice(message, "success");
    forgotForm.reset();
  } catch (err) {
    forgotNotice(err.message || "Could not send the link. Please try again.", "error");
  } finally {
    button.disabled = false;
    button.classList.remove("is-loading");
  }
});

if (location.hash === "#forgot") showStep(true);
