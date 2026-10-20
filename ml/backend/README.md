# LEGACY — superseded by the Python worker in `ml/worker`; do not run

This folder's Rust code (`src/`, `Cargo.toml`, `Cargo.lock`, `.env.example`) was the first ML
server. It is **no longer used** and must not be run against the shop's database:

- The forecasts the admin pages show are computed by the **Python ML worker** (`ml/worker/`), which
  writes `ml_predictions`; the Node API serves them (`/api/admin/ml/*`). Nothing calls this server.
- Its SQL (`src/db.rs`) counts only orders with status `processing` or `completed` as sales. The shop
  now also counts `paid`, `packed`, `shipped` and `delivered` (`SOLD_STATUSES` in
  `ml/worker/bongalink_ml/db.py` and `Backend/routes/ml.js`), so this server's forecasts would be
  wrong.
- Its maths check (`cargo test` against `models/parity.json`) is duplicated by the worker's
  `ml/worker/tests/test_core.py`.

It is kept only until the project adviser confirms the Python worker as the ML runtime; then the Rust
code is deleted (DEPLOYMENT.md, "Open items").

**`models/` is not legacy and stays:** `stock_lr.json`, `trend_config.json` and `parity.json` are the
Colab export the Python worker starts from (`ML_BOOTSTRAP_DIR`) and checks itself against. The
worker's Docker image copies this folder.
