# Bongalink — Stock Prediction & Trend Shift (ML)

> **LEGACY — `backend/` (the Rust server) is superseded by the Python worker in `worker/`; do not run it.**
> Its SQL counts only `processing` and `completed` orders as sales, while the shop now also counts
> `paid`, `packed`, `shipped` and `delivered` (the worker and the Node API do), so its forecasts
> would be wrong. It is kept until the adviser confirms the Python worker, then deleted (DEPLOYMENT.md,
> open items). `backend/models/` is **not** legacy: it is the worker's starting model and stays.

Implements the Machine Learning part of the Database System objective (REQ07, REQ028, REQ032).
The models are first trained with **TensorFlow in Google Colab**. The **Python ML worker**
(`worker/`) then keeps the predictions up to date as products are added, removed or
restocked, and retrains them automatically with TensorFlow. The Node API serves the
results to the admin dashboard.

```
colab/bongalink_training.ipynb   Colab notebook: data -> train -> calibrate -> export JSON
colab/build_notebook.py          Source of the notebook (python build_notebook.py --test runs the non-TF cells)
worker/                          Python ML runtime: change detection, inference, automatic retraining (see worker/README.md)
backend/models/*.json            Colab export: the worker's starting model + fixed trend threshold + parity example
backend/                         LEGACY Rust server and parity checker (see the notice above); not run
```

## The two algorithms

| | Stock prediction | Trend shift |
|---|---|---|
| Method | Linear regression on 6 features of the last 28 days | Segmented (two-piece) linear regression; breakpoint found by optimization |
| Trained with TensorFlow | `Dense(1)` in Colab, and again automatically by the worker on real orders (nightly, or after 50 new paid orders / 100 stock changes) | TensorFlow curve fit; shift threshold calibrated on 600 labeled series in Colab |
| Output | Units expected to sell in the next 7 days, days until stockout, reorder suggestion | Whether demand changed direction, when, and which way |

The models in `backend/models/` right now are **placeholders** from synthetic data. The worker registers them as
`v0-colab` and replaces them as soon as a model retrained on real orders validates better.

## Workflow

1. Run the worker: see `worker/README.md` (Python 3.12 venv with TensorFlow, `python -m bongalink_ml`).
2. Optional: retrain in Colab with `DATA_SOURCE = "mysql"`, copy the three exported files into `backend/models/`,
   and run the worker's parity check (`worker/tests/test_core.py`) to confirm the maths still match.

## Legacy Rust API

**Do not run it.** The Rust server (`cargo run`) is no longer the runtime: the dashboard reads
`ml_predictions` through the Node API (`/api/admin/ml/*`), written by the Python worker. Its SQL
(`backend/src/db.rs`) still counts only `processing`/`completed` orders as sales, so its numbers would
disagree with the shop's. The endpoints below are kept for reference only, until the code is deleted.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness |
| GET | `/api/ml/models` | loaded model metadata and metrics |
| GET | `/api/ml/insights` | all active products, most urgent restock first (dashboard feed) |
| GET | `/api/ml/products/{id}/insights` | forecast + trend for one product |
| POST | `/api/ml/stock-forecast` | `{"history": [28 numbers], "current_stock": 5}` — no DB needed |
| POST | `/api/ml/trend` | `{"history": [84 numbers]}` — no DB needed |

Quick test without a database:

```bash
curl -X POST localhost:8080/api/ml/stock-forecast -H 'Content-Type: application/json' \
  -d '{"history":[3,2,4,1,0,5,3,2,3,4,2,6,3,3,4,2,5,3,4,6,2,5,4,3,6,5,4,7],"current_stock":10}'
```

## Contract between notebook, worker and Rust checker

Changing any of these requires changing `make_features` in the notebook, `worker/bongalink_ml/core.py`
**and** `backend/src/features.rs`, then retraining:

- `WINDOW = 28`, `HORIZON = 7`, `TREND_DAYS = 84`, `MIN_SEGMENT = 14`
- Features: `mean_7, mean_14, mean_28, slope_14, zero_ratio_28, paydays_next_7`
- Payday window: 14th–16th, last two days of the month, and the 1st
- "Units sold" = order items in orders with status `processing`, `completed`, `paid`, `packed`, `shipped`
  or `delivered` (`SOLD_STATUSES` in `worker/bongalink_ml/db.py` and `Backend/routes/ml.js`), dated by
  `orders.created_at`. The legacy Rust code still uses only the first two.

`worker/tests/test_core.py` fails loudly if the worker drifts from `parity.json` (so did `cargo test`
for the legacy Rust code).
