/* =====================================================================
   BONGALINK — RESET PASSWORD (reset-password.html?token=...)
   Requires api.js, icons.js, cart.js and ui.js.
     GET  /api/auth/reset-password?token=   is the link still good? -> { username }
     POST /api/auth/reset-password { token, password }
   Reached from the "Forgot password?" email. Same password rules as sign-up.
   ===================================================================== */

renderHeader({ search: false });

const resetToken = new URLSearchParams(location.search).get("token") || "";
const resetForm = document.getElementById("setForm");
const resetLead = document.getElementById("setLead");
const resetPassword = document.getElementById("newPassword");
const resetConfirm = document.getElementById("confirmPassword");

function resetNotice(html, type) {
  const box = document.getElementById("setMessage");
  box.hidden = !html;
  box.className = `alert alert--${type}`;
  box.innerHTML = html ? `${icon(type === "error" ? "circle-alert" : type === "success" ? "check" : "info", { size: 18 })}<span>${html}</span>` : "";
}

function resetFieldError(input, text) {
  document.getElementById(`${input.id}Error`).textContent = text;
  if (text) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
}

const askAgain = `<a href="login.html#forgot">Ask for a new link</a>.`;

async function checkResetLink() {
  try {
    const { username } = await apiFetch(`/auth/reset-password?token=${encodeURIComponent(resetToken)}`);
    document.getElementById("setUsername").value = username;
    resetLead.textContent = `Choose a new password for ${username}.`;
    resetForm.hidden = false;
    resetPassword.focus();
  } catch (err) {
    resetLead.textContent = "We couldn't use this link.";
    resetNotice(`${escapeHTML(err.message)} ${err.code === "ACCOUNT_SUSPENDED" ? "" : askAgain}`, "error");
  }
}

document.getElementById("toggleNew").addEventListener("click", (e) => {
  const show = resetPassword.type === "password";
  resetPassword.type = show ? "text" : "password";
  resetConfirm.type = resetPassword.type;
  e.currentTarget.textContent = show ? "Hide" : "Show";
});
[resetPassword, resetConfirm].forEach(i => i.addEventListener("input", () => resetFieldError(i, "")));

resetForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = resetPassword.value;
  resetFieldError(resetPassword, password.length < 6 ? "Use at least 6 characters." : "");
  resetFieldError(resetConfirm, password.length >= 6 && resetConfirm.value !== password ? "The two passwords don't match." : "");
  if (password.length < 6) return resetPassword.focus();
  if (resetConfirm.value !== password) return resetConfirm.focus();

  const submit = document.getElementById("setSubmit");
  submit.disabled = true;
  submit.classList.add("is-loading");
  try {
    const { username } = await apiFetch("/auth/reset-password", { method: "POST", body: JSON.stringify({ token: resetToken, password }) });
    resetForm.hidden = true;
    resetLead.textContent = "Password changed.";
    resetNotice(`Your password was changed and every device that was logged in has been logged out.
      <a href="login.html">Log in as ${escapeHTML(username)}</a>.`, "success");
  } catch (err) {
    resetNotice(`${escapeHTML(err.message)} ${err.code === "ACCOUNT_SUSPENDED" ? "" : askAgain}`, "error");
    submit.disabled = false;
    submit.classList.remove("is-loading");
  }
});

checkResetLink();
