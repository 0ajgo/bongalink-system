/* =====================================================================
   lib/securityHeaders.js — HTTP security headers for the API (helmet).
   The API only answers JSON, event streams and product photos, so its
   own Content-Security-Policy allows nothing to run or load, and no page
   may frame it. The shop's pages get their own policy from the web
   server that serves Frontend/ (DEPLOYMENT.md, deploy/nginx).
   Product photos (/uploads) are shown by pages on another origin
   (CORS_ORIGIN), so they are marked Cross-Origin-Resource-Policy:
   cross-origin; everything else stays same-origin (the API's own JSON is
   read cross-origin through CORS, which this doesn't affect).
   HSTS (browsers remember to use HTTPS only) is sent in production only:
   on plain-http development it would do nothing useful.
   ===================================================================== */
const helmet = require("helmet");

const HSTS_MAX_AGE_S = 180 * 24 * 60 * 60;

function securityHeaders({ production = process.env.NODE_ENV === "production" } = {}) {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: "same-origin" },
    // Not on by default in helmet 8 either; a JSON API has nothing to isolate.
    crossOriginEmbedderPolicy: false,
    // includeSubDomains is left off: other subdomains of the shop's domain may not have HTTPS.
    strictTransportSecurity: production ? { maxAge: HSTS_MAX_AGE_S, includeSubDomains: false } : false,
    referrerPolicy: { policy: "no-referrer" },
  });
}

// For /uploads: product photos may be shown on any page that has their URL.
function allowCrossOriginImages(req, res, next) {
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
}

module.exports = { securityHeaders, allowCrossOriginImages };
