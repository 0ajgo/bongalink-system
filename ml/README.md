# Bongalink — Stock Prediction & Trend Shift (ML)

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

## How the admin pages get the predictions

The worker writes `ml_predictions`; the Node API serves them to the Dashboard and Inventory pages
(`/api/admin/ml/*`). Nothing in the browser talks to the worker directly.

## Contract between notebook and worker

Changing any of these requires changing `make_features` in the notebook **and**
`worker/bongalink_ml/core.py`, then retraining:

- `WINDOW = 28`, `HORIZON = 7`, `TREND_DAYS = 84`, `MIN_SEGMENT = 14`
- Features: `mean_7, mean_14, mean_28, slope_14, zero_ratio_28, paydays_next_7`
- Payday window: 14th–16th, last two days of the month, and the 1st
- "Units sold" = order items in orders with status `processing`, `completed`, `paid`, `packed`, `shipped`
  or `delivered` (`SOLD_STATUSES` in `worker/bongalink_ml/db.py` and `Backend/routes/ml.js`), dated by
  `orders.created_at`.

`worker/tests/test_core.py` fails loudly if the worker drifts from `parity.json`.
