/* =====================================================================
   lib/trustProxy.js — TRUST_PROXY (.env) -> Express's "trust proxy".
   Behind a reverse proxy / HTTPS terminator every request comes from the
   proxy, so the per-IP rate limits would count all visitors as one. With
   the right setting req.ip is the visitor's address from X-Forwarded-For.
     blank / 0 / false   no proxy: the API is reached directly (default)
     1, 2, ...           that many proxies in front (e.g. 1 for nginx)
     loopback, 10.0.0.0/8, ...   addresses/subnets of the proxies
   "true" is refused: it trusts any X-Forwarded-For a visitor sends, so
   anyone could pick their own IP and step around every per-IP limit.
   ===================================================================== */

function trustProxySetting(value = process.env.TRUST_PROXY) {
  const text = String(value ?? "").trim();
  if (text === "" || text === "0" || text.toLowerCase() === "false") return false;
  if (text.toLowerCase() === "true") {
    throw new Error('TRUST_PROXY=true would let visitors fake their IP. Set the number of proxies in front of the API (e.g. 1) or their addresses.');
  }
  if (/^\d+$/.test(text)) return Number(text);
  return text.split(",").map((s) => s.trim()).filter(Boolean);
}

module.exports = { trustProxySetting };
