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

document.getElementById("forgotPassword").addEventListener("click", (event) => {
  event.preventDefault();
  showMessage("Password reset by email isn't available yet. Please message the shop and we'll reset it for you.", "info");
});
