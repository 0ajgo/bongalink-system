/* =====================================================================
   lib/emailRule.js — the rule for a NEW email address: register, the
   profile's email change and accounts created on Admin › Accounts.
   Only Gmail and Yahoo addresses are accepted. Logging in, "Forgot
   password" and existing accounts never check it, so accounts made with
   another address keep working.
   The pages check the same list (Frontend/JS/ui.js, EMAIL_DOMAINS).
   ===================================================================== */

const ALLOWED_EMAIL_DOMAINS = ["gmail.com", "googlemail.com", "yahoo.com", "yahoo.com.ph", "ymail.com"];
const MAX_EMAIL = 150;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const MESSAGES = {
  invalid: "Enter a valid email address.",
  domain: "Only Gmail (@gmail.com) or Yahoo (@yahoo.com, @yahoo.com.ph) addresses are accepted.",
};

// -> null when the address is fine, otherwise { error, code } to send as a 400.
function newEmailProblem(email) {
  const value = String(email ?? "").trim();
  if (!EMAIL_RE.test(value) || value.length > MAX_EMAIL) return { error: MESSAGES.invalid, code: "INVALID_EMAIL" };
  // The whole part after the @ must be on the list: gmail.co or gmail.com.evil.com are refused.
  const domain = value.slice(value.lastIndexOf("@") + 1).toLowerCase();
  if (!ALLOWED_EMAIL_DOMAINS.includes(domain)) return { error: MESSAGES.domain, code: "EMAIL_DOMAIN_NOT_ALLOWED" };
  return null;
}

module.exports = { newEmailProblem, ALLOWED_EMAIL_DOMAINS, MESSAGES };
