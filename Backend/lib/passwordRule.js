/* =====================================================================
   lib/passwordRule.js — the rule for a NEW password: register, reset,
   change (profile) and account setup. Logging in never checks it, so
   accounts made under the old 6-character rule keep working.
     - at least 10 characters;
     - at most 72 bytes: bcrypt ignores everything after that, so a longer
       password would work with only its first 72 bytes typed;
     - not a well-known password, nor one character repeated.
   The pages check the length too (Frontend/JS/ui.js) and show these
   messages next to the password field (code WEAK_PASSWORD).
   ===================================================================== */

const MIN_PASSWORD = 10;
const MAX_PASSWORD_BYTES = 72;

// The most used passwords of 10+ characters (shorter ones fail the length rule),
// from public breach lists, plus the shop's own name. Compared ignoring case.
const COMMON = new Set([
  "1234567890", "0987654321", "12345678910", "123456789a", "a123456789", "1234567890a", "1q2w3e4r5t",
  "1q2w3e4r5t6y", "1qaz2wsx3edc", "zaq12wsxcde3", "qwertyuiop", "qwertyuiop123", "qwerty1234", "qwerty12345",
  "qwerty123456", "1234qwerty", "123qweasdzxc", "qweasdzxc123", "asdfghjkl1", "asdfghjkl123", "zxcvbnm123",
  "password12", "password123", "password1234", "password12345", "passw0rd123", "password!", "password01",
  "passwordpassword", "p@ssw0rd123", "p@ssword123", "iloveyou12", "iloveyou123", "iloveyou1234",
  "princess123", "sunshine123", "football123", "baseball123", "superman123", "batman1234", "michael123",
  "jennifer123", "charlie123", "computer123", "internet123", "welcome123", "welcome1234", "letmein123",
  "monkey12345", "dragon1234", "master1234", "starwars123", "whatever123", "trustno1234", "abcdefghij",
  "abcdefghijk", "abcd123456", "abc1234567", "abc123456789", "123abc456def", "1234512345", "1122334455",
  "1111111111", "0000000000", "1212121212", "1231231231", "123123123123", "123321123321", "9876543210",
  "administrator", "admin12345", "admin123456", "adminadmin", "changeme123", "computer12", "mahalkita123",
  "iloveyou143", "mahalkokayo", "philippines", "pilipinas123", "manila1234", "bongalink1", "bongalink12",
  "bongalink123", "bongalink2008", "bongalink2026",
]);

const MESSAGES = {
  short: `Use at least ${MIN_PASSWORD} characters for your password.`,
  long: "That password is too long: use at most 72 characters (fewer if it has emoji or accented letters).",
  common: "That password is too common and easy to guess. Choose another.",
};

// -> null when the password is fine, otherwise { error, code: "WEAK_PASSWORD" } to send as a 400.
function newPasswordProblem(password) {
  const reason = typeof password !== "string" || password.length < MIN_PASSWORD ? "short"
    : Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES ? "long"
    : COMMON.has(password.toLowerCase()) || /^(.)\1*$/.test(password) ? "common"
    : null;
  return reason && { error: MESSAGES[reason], code: "WEAK_PASSWORD" };
}

module.exports = { newPasswordProblem, MIN_PASSWORD, MAX_PASSWORD_BYTES, MESSAGES };
