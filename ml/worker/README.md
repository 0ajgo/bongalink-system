# Bongalink ML worker

Keeps the admin dashboard's stock forecasts and trend insights (REQ07, REQ028) in step
with the product catalog. Products can be added, removed or restocked at any time; the
dashboard never shows predictions for removed products and never misses new ones.

```
Admin edits product ──► Node API (Backend/routes/products.js)
                          │  UPDATE/INSERT products
                          ▼
                    MySQL triggers (migrations/003_ml_sync.sql)
                          │  same transaction: one ml_events row per change
                          ▼
              Python worker (this folder) — polls every 5 s
                          │  debounce: waits until edits stop for 10 s (max 60 s)
                          │  inference for all active products (no retraining)
                          ▼
     ml_predictions + ml_status ──► Node API (routes/ml.js) ──► Admin dashboard
                                                                 (Pages/Admin/inventory.html)
```

## What triggers what

| Change | Event | Worker does |
|---|---|---|
| Product added (or re-activated) | `ADDED` | Re-scores. New product gets its category's average, labelled **insufficient data** |
| Product removed (soft delete, `is_active = 0`) | `REMOVED` | Re-scores; the product's prediction row is deleted. Its sales history stays for trend charts |
| Stock changed (admin edit or checkout) | `STOCK_CHANGED` | Re-scores (days of stock / reorder change; demand does not) |
| Price changed | `PRICE_CHANGED` | Recorded in the audit trail; re-scores |
| Product ID changed | `ID_CHANGED` | Recorded in the audit trail; re-scores |
| Nothing for an hour | — | Full re-score (new orders change demand without touching `products`) |
| Admin clicks **Update forecasts & trends** (Forecasts page or Dashboard) | queued run | **Retrain** on the next poll |
| Nightly (first poll after `ML_RETRAIN_HOUR`, 02:00) | — | **Retrain** |
| `ML_RETRAIN_NEW_ORDERS` (50) new paid orders or `ML_RETRAIN_STOCK_CHANGES` (100) stock changes since the last training | — | **Retrain** |

No event ever needs a retrain: the stock model takes 6 per-product features, not the product
list, so adding or removing products only changes *which* products are scored.

### Cold start
A product listed fewer than 28 days ago, or that has never sold, has zeros in its 28-day
window that mean "didn't exist yet", not "no demand". Its forecast column shows the average
model forecast of its category (or of the whole store if the category has none), tagged
`insufficient_data`. That estimate never triggers a reorder by itself; only an empty shelf does.
Trend detection likewise needs 84 days.

### Retraining on demand and automatically (REQ028)
Every retraining is a row in `ml_training_runs` (migration 010): what started it (an admin's
button, the nightly schedule, new data, or `--retrain`), its progress (queued → training →
done / failed), the sales records, orders and products it used, the accuracy (validation MAE
of the new model, of the model in use, and of a naive average), and the result. The admin
Forecasts page shows the latest runs and polls for progress.

The API never trains: `POST /api/admin/ml/training` only queues a run, and this worker picks
it up on its next poll. Only one run can be queued or training at a time: `active_slot`
has a unique key, so the database refuses a second run from any source (two admins, the
schedule, or a second worker process). If the worker stops mid-run, the run is marked failed
when it starts again. Any of the automatic triggers can be turned off with `off` in `.env`.

The worker reads only products, orders (status and date), order items and the `ml_*` tables:
no personal data, and it never needs the backend's encryption keys.

### Retraining safety
Every attempt is recorded in `ml_model_versions`:

- `active`: promoted because its validation MAE was no worse than the previous model's on the
  same holdout (the most recent 20% of days).
- `rejected`: worse than the active model, which stays in use.
- `failed`: an exception (or TensorFlow missing); the active model stays in use.

Model files are written to `models/versions/stock_lr_<version>.json` in the same format the
Colab notebook exports. `trained_with` says exactly how each model was trained, e.g.
`tensorflow 2.21.0 (Keras Dense(1), Adam, 300 epochs, batch 60)`. If TensorFlow is
missing, training **fails** (default `ML_TRAINER=tensorflow`). With `ML_TRAINER=auto` it
falls back to least squares and says so: `numpy … closed-form least squares (FALLBACK: TensorFlow not installed)`.
The first run registers the Colab export (`ml/backend/models/stock_lr.json`) as `v0-colab`.

The trend-shift threshold is not retrained: it was calibrated on labeled series in Colab,
and real orders carry no "was this a real shift?" labels.

## Local setup (Windows, Python 3.12)

TensorFlow has no wheels for Python 3.14, so the worker uses its own Python 3.12 virtual
environment.

```powershell
# once: install Python 3.12 next to your existing Python
py install 3.12

cd ml\worker
py -V:3.12 -m venv .venv
.venv\Scripts\python -m pip install --upgrade pip
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python -c "import tensorflow as tf; print(tf.__version__)"   # should print 2.21.x

copy .env.example .env      # then fill in DB_PASSWORD (same as Backend/.env) and DB_NAME
```

Apply the migration to your database once (it adds `products.is_active`, the `ml_*` tables
and the triggers):

```powershell
mysql -u root -p bongalink < ..\..\Backend\database\migrations\003_ml_sync.sql
```

Run the worker (leave it running next to `npm run dev`):

```powershell
.venv\Scripts\python -m bongalink_ml            # until Ctrl+C
.venv\Scripts\python -m bongalink_ml --once     # one update, then exit
.venv\Scripts\python -m bongalink_ml --retrain  # retrain now, then exit
```

Settings are in `.env.example` (debounce windows, cold-start days, retrain schedule).

## Tests

```powershell
.venv\Scripts\python -m unittest discover -s tests -t . -v
```

- `tests/test_core.py` (no database): parity with the notebook's `parity.json`, cold-start
  fallback, reorder rules, trend input (bulk orders capped), and the training-window rules.
- `tests/test_integration.py`: creates and drops `bongalink_worker_test` on the MySQL server
  from `.env`, filled with synthetic orders from `tests/fixture_data.py`, then exercises the
  real triggers. It covers add, stock change (no retrain), price change, soft delete, debounce
  (20 edits → 1 update), rollback (no event), a crashed retrain (old model kept) and a worse
  model (rejected). It is skipped if MySQL is unreachable, and the fixture refuses any database
  name not ending in `_test`.

## Docker

From the repository root, with a `.env` containing `DB_PASSWORD` and `JWT_SECRET`:

```bash
docker compose up --build                       # mysql + api + worker + frontend
docker compose logs -f worker                   # see refreshes and training
# import the sales sheet (kept on the host) into bongalink_real, then switch to it
docker compose run --rm -v ./ml/worker/data:/repo/ml/worker/data worker python import_sales.py
DB_NAME=bongalink_real docker compose up -d api worker
```

The worker image is `python:3.12-slim` with `tensorflow-cpu`. Model versions persist in the
`ml-models` volume.

## Importing the real sales sheet

```powershell
# put the sheet at ml/worker/data/2026 Bongalink Sheet SALES.xlsx (git-ignored)
.venv\Scripts\python import_sales.py --dry-run     # cleaned products, mappings, skipped rows; writes nothing
.venv\Scripts\python import_sales.py               # drops + rebuilds bongalink_real and imports paid sales
$env:DB_NAME="bongalink_real"; .venv\Scripts\python -m bongalink_ml --once
```

The script never writes to `bongalink`. The dry run lists every excluded service, every
unpaid row, the item/model mappings, and each row whose quantity or price came from free
text. Review those before trusting the numbers. Stock counts are placeholders (5 per
product), because the sheet records sales, not stock.
