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
  TRACKING_URL_LBC: ""
});

require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });

// No test may reach PayMongo, Lalamove or any other real service.
global.fetch = async (url) => {
  throw new Error(`Network disabled in tests (tried ${url})`);
};
