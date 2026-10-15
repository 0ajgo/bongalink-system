// The "ML" line in the startup status (REQ028). Unlike the other integrations it isn't a
// setting in .env: it says whether the ML worker (ml/worker) is running, by its heartbeat
// in ml_status, and when the forecasting model was last trained. Never fails startup.
const { padLabel } = require("./integrationStatus");

const WORKER_TIMEOUT_SECONDS = 120;   // same as routes/ml.js

async function mlStatusLine(pool, { timeoutMs = 3000 } = {}) {
  const label = padLabel("ML");
  try {
    const query = pool.query(
      `SELECT TIMESTAMPDIFF(SECOND, s.heartbeat_at, NOW()) AS heartbeat_age,
              DATE_FORMAT(s.heartbeat_at, '%Y-%m-%d %H:%i') AS heartbeat_at,
              DATE_FORMAT(s.last_train_at, '%Y-%m-%d %H:%i') AS last_train_at, s.last_train_status,
              (SELECT version FROM ml_model_versions WHERE status = 'active' ORDER BY version_id DESC LIMIT 1) AS model
         FROM ml_status s WHERE s.id = 1`);
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs).unref());
    const [[s]] = await Promise.race([query, timeout]);
    if (!s) return `${label}not set up (run migration 003, then start the ML worker in ml/worker)`;
    const trained = s.last_train_at ? `last trained ${s.last_train_at} (${s.last_train_status})` : "never trained";
    const model = s.model ? `; model ${s.model}` : "";
    if (s.heartbeat_age !== null && s.heartbeat_age <= WORKER_TIMEOUT_SECONDS) return `${label}enabled (worker running; ${trained}${model})`;
    const seen = s.heartbeat_at ? `last seen ${s.heartbeat_at}` : "never started";
    return `${label}worker not running (${seen}; ${trained}${model}). Start it: cd ml/worker, .venv\\Scripts\\python -m bongalink_ml`;
  } catch (err) {
    return `${label}unknown (could not read ml_status: ${err.code || err.message})`;
  }
}

module.exports = { mlStatusLine };
