// Runs before every test file (and from globalSetup). Test values are set
// first; dotenv never overrides a variable that is already set, so only the
// DB host/user/password come from Backend/.env.
const path = require("path");

Object.assign(process.env, {
  NODE_ENV: "test",
  DB_NAME: "bongalink_test",
  JWT_SECRET: "test-jwt-secret",
  VERIFICATION_SECRET: "test-verification-secret",
  APP_URL: "http://localhost:5500",
  PAYMONGO_SECRET_KEY: "sk_test_fake",
  PAYMONGO_WEBHOOK_SECRET: "whsk_test_fake",
  LALAMOVE_API_KEY: "pk_test_fake",
  LALAMOVE_API_SECRET: "sk_test_fake",
  STORE_LAT: "14.5547",
  STORE_LNG: "121.0244",
  STORE_ADDRESS: "Test shop",
  STORE_PHONE: "09170000000",
  TRACKING_URL_JNT: "https://www.jtexpress.ph/track?waybill={tn}",
  TRACKING_URL_LBC: "",
  // Gemini is mocked in the chat tests; this fake key keeps the real one out of tests.
  GEMINI_API_KEY: "test-gemini-key",
  GEMINI_MODEL: "gemini-test-model",
  GEMINI_FALLBACK_MODEL: "gemini-test-fallback",
  // Test-only encryption keys (32 bytes each, base64). The real ones stay in Backend/.env.
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  DATA_INDEX_KEY: Buffer.alloc(32, 9).toString("base64"),
  // Uploaded photos go to a throwaway folder, never Backend/uploads.
  UPLOAD_DIR: path.join(require("os").tmpdir(), "bongalink-test-uploads")
});

require("fs").mkdirSync(process.env.UPLOAD_DIR, { recursive: true });

require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

// No test may reach PayMongo, Lalamove or any other real service.
global.fetch = async (url) => {
  throw new Error(`Network disabled in tests (tried ${url})`);
};
