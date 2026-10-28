/* Reset password (reset-password.html?token=...), reached from the
   "Forgot password?" email. Same password rules as sign-up.
   Requires api.js, icons.js, cart.js and ui.js. */

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
    resetChecklist.update();
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
const resetAccount = () => ({ username: document.getElementById("setUsername").value });
const resetChecklist = passwordChecklist({ input: resetPassword, confirm: resetConfirm, list: document.getElementById("newPasswordRules"),
  button: document.getElementById("setSubmit"), confirmError: document.getElementById("confirmPasswordError"), account: resetAccount });

resetForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = resetPassword.value;
  const weak = newPasswordProblem(password, resetAccount());
  resetFieldError(resetPassword, weak);
  resetFieldError(resetConfirm, !weak && resetConfirm.value !== password ? "The two passwords don't match." : "");
  if (weak) return resetPassword.focus();
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
    if (err.code === "WEAK_PASSWORD") {
      resetFieldError(resetPassword, err.message);
      resetPassword.focus();
    } else {
      resetNotice(`${escapeHTML(err.message)} ${err.code === "ACCOUNT_SUSPENDED" ? "" : askAgain}`, "error");
    }
    submit.classList.remove("is-loading");
    resetChecklist.update();
  }
});

checkResetLink();
