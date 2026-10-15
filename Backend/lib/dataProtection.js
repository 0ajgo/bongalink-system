// Field-level encryption of personal information (REQ027, REQ030; RA 10173 Data Privacy Act).
//
//   encrypt(value, "table.column")  -> "enc:v1:<base64 of iv | auth tag | ciphertext>"
//   decrypt(stored, "table.column") -> the original text (throws if tampered)
//   blindIndex(email)               -> HMAC-SHA256 hex, for exact-match lookups
//
// AES-256-GCM with a random 12-byte IV per value. The "table.column" name is
// authenticated with each value (AAD), so a value moved to another column, or any
// changed byte, fails to decrypt instead of returning garbage.
//
// Keys (Backend/.env, base64 of 32 random bytes; never logged):
//   DATA_ENCRYPTION_KEY          encrypts new values, as version DATA_ENCRYPTION_KEY_VERSION (default 1)
//   DATA_ENCRYPTION_KEY_V<n>     older keys, kept after a rotation so old values still decrypt
//   DATA_INDEX_KEY               HMAC key of the blind index (users.email_bidx)
// Each value carries its key version ("enc:v1:"). To rotate: set the new key as
// DATA_ENCRYPTION_KEY with DATA_ENCRYPTION_KEY_VERSION=2, move the old one to
// DATA_ENCRYPTION_KEY_V1, then re-encrypt with scripts/encrypt-personal-data.js.
// If the keys are lost, the encrypted data can't be recovered.
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PATTERN = /^enc:v(\d+):([A-Za-z0-9+/]+={0,2})$/;

class DataProtectionError extends Error {}

// base64 (or 64 hex characters) of exactly 32 bytes.
function parseKey(name, raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const buf = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  if (buf.length !== 32) throw new DataProtectionError(`${name} must be 32 bytes (base64). Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`);
  return buf;
}

// Missing settings, by name (never values). Empty array = ready.
function missingKeys(env = process.env) {
  return ['DATA_ENCRYPTION_KEY', 'DATA_INDEX_KEY'].filter((k) => !String(env[k] || '').trim());
}

let cache = null;
function keys() {
  const env = process.env;
  const signature = [env.DATA_ENCRYPTION_KEY, env.DATA_ENCRYPTION_KEY_VERSION, env.DATA_INDEX_KEY,
    ...Object.keys(env).filter((k) => /^DATA_ENCRYPTION_KEY_V\d+$/.test(k)).sort().map((k) => `${k}=${env[k]}`)].join('|');
  if (cache && cache.signature === signature) return cache;

  const missing = missingKeys(env);
  if (missing.length) throw new DataProtectionError(`Encryption keys not set: ${missing.join(', ')}`);
  const version = Number(env.DATA_ENCRYPTION_KEY_VERSION || 1);
  if (!Number.isInteger(version) || version < 1) throw new DataProtectionError('DATA_ENCRYPTION_KEY_VERSION must be a whole number from 1');
  const byVersion = new Map();
  for (const [name, value] of Object.entries(env)) {
    const m = /^DATA_ENCRYPTION_KEY_V(\d+)$/.exec(name);
    if (m) byVersion.set(Number(m[1]), parseKey(name, value));
  }
  byVersion.set(version, parseKey('DATA_ENCRYPTION_KEY', env.DATA_ENCRYPTION_KEY));
  cache = { signature, version, byVersion, indexKey: parseKey('DATA_INDEX_KEY', env.DATA_INDEX_KEY) };
  return cache;
}

// Throws (naming the problem, never a value) unless encryption is usable.
function assertReady() {
  keys();
  const probe = encrypt('probe', 'startup.check');
  if (decrypt(probe, 'startup.check') !== 'probe') throw new DataProtectionError('Encryption self-test failed');
}

const isEncrypted = (value) => typeof value === 'string' && PATTERN.test(value);

// null/undefined stay null and '' stays '' (nothing to protect); everything else is stored as text.
function encrypt(value, context) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (text === '') return '';
  const { version, byVersion } = keys();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, byVersion.get(version), iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `enc:v${version}:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
}

function decrypt(stored, context) {
  if (stored === null || stored === undefined) return null;
  if (stored === '') return '';
  const m = PATTERN.exec(String(stored));
  if (!m) throw new DataProtectionError(`${context} is not encrypted`);
  const key = keys().byVersion.get(Number(m[1]));
  if (!key) throw new DataProtectionError(`${context}: no key for version ${m[1]} (set DATA_ENCRYPTION_KEY_V${m[1]})`);
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < IV_BYTES + TAG_BYTES) throw new DataProtectionError(`${context} could not be decrypted`);
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, buf.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  } catch (err) {
    throw new DataProtectionError(`${context} could not be decrypted (wrong key or tampered value)`);
  }
}

// Key version a stored value was encrypted with (null if not encrypted).
const keyVersionOf = (stored) => (isEncrypted(stored) ? Number(PATTERN.exec(stored)[1]) : null);

// Emails are matched case-insensitively and without surrounding spaces.
const normalizeEmail = (email) => String(email ?? '').trim().toLowerCase();

function blindIndex(email) {
  const value = normalizeEmail(email);
  if (!value) return null;
  return crypto.createHmac('sha256', keys().indexKey).update(`email:${value}`).digest('hex');
}

const status = () => {
  const { version, byVersion } = keys();
  return { algorithm: 'AES-256-GCM', version, readable: [...byVersion.keys()].sort((a, b) => a - b) };
};

module.exports = {
  encrypt, decrypt, blindIndex, normalizeEmail, isEncrypted, keyVersionOf, assertReady, missingKeys, status,
  DataProtectionError,
};
