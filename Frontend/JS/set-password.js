/* =====================================================================
   BONGALINK — SET PASSWORD (set-password.html?token=...)
   Requires api.js, icons.js, cart.js and ui.js.
     GET  /api/auth/set-password?token=   is the link still good? -> { username }
     POST /api/auth/set-password { token, password }
   For accounts the shop created on Admin > Accounts.
   ===================================================================== */

renderHeader({ search: false });

const setToken = new URLSearchParams(location.search).get("token") || "";
const setForm = document.getElementById("setForm");
const setLead = document.getElementById("setLead");
const newPassword = document.getElementById("newPassword");
const confirmPassword = document.getElementById("confirmPassword");

function setMessage(text, type) {
  const box = document.getElementById("setMessage");
  box.hidden = !text;
  box.className = `alert alert--${type}`;
  box.innerHTML = text ? `${icon(type === "error" ? "circle-alert" : type === "success" ? "check" : "info", { size: 18 })}<span>${text}</span>` : "";
}

function fieldError(input, text) {
  document.getElementById(`${input.id}Error`).textContent = text;
  if (text) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
}

async function checkLink() {
  try {
    const { username } = await apiFetch(`/auth/set-password?token=${encodeURIComponent(setToken)}`);
    document.getElementById("setUsername").value = username;
    setLead.textContent = `Choose a password for ${username}. You'll use it with your username to log in.`;
    setForm.hidden = false;
    newPassword.focus();
  } catch (err) {
    setLead.textContent = "We couldn't use this link.";
    setMessage(escapeHTML(err.message), "error");
  }
}

document.getElementById("toggleNew").addEventListener("click", (e) => {
  const show = newPassword.type === "password";
  newPassword.type = show ? "text" : "password";
  confirmPassword.type = newPassword.type;
  e.currentTarget.textContent = show ? "Hide" : "Show";
});
[newPassword, confirmPassword].forEach(i => i.addEventListener("input", () => fieldError(i, "")));
document.getElementById("setConsent").addEventListener("change", (e) => {
  document.getElementById("setConsentError").textContent = "";
  e.target.removeAttribute("aria-invalid");
});

setForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = newPassword.value;
  const weak = newPasswordProblem(password);
  fieldError(newPassword, weak);
  fieldError(confirmPassword, !weak && confirmPassword.value !== password ? "The two passwords don't match." : "");
  if (weak) return newPassword.focus();
  if (confirmPassword.value !== password) return confirmPassword.focus();
  const consent = document.getElementById("setConsent");
  if (!consent.checked) {
    document.getElementById("setConsentError").textContent = "Please accept the Privacy Policy to finish setting up your account.";
    consent.setAttribute("aria-invalid", "true");
    return consent.focus();
  }

  const submit = document.getElementById("setSubmit");
  submit.disabled = true;
  submit.classList.add("is-loading");
  try {
    const { username } = await apiFetch("/auth/set-password", { method: "POST", body: JSON.stringify({ token: setToken, password, privacy_consent: true }) });
    setForm.hidden = true;
    setLead.textContent = "All set.";
    setMessage(`Your password is set and your email is confirmed. <a href="login.html">Log in as ${escapeHTML(username)}</a>.`, "success");
  } catch (err) {
    if (err.code === "WEAK_PASSWORD") {
      fieldError(newPassword, err.message);
      newPassword.focus();
    } else {
      setMessage(escapeHTML(err.message), "error");
    }
    submit.disabled = false;
    submit.classList.remove("is-loading");
  }
});

checkLink();
