# Bongalink — Stock Prediction & Trend Shift (ML + Rust backend)

Implements the Machine Learning part of the Database System objective (REQ07, REQ028, REQ032):
models are trained with **TensorFlow in Google Colab**, and the **Rust backend** serves the results to the admin dashboard.

```
colab/bongalink_training.ipynb   Colab notebook: data -> train -> calibrate -> export JSON
colab/build_notebook.py          Source of the notebook (python build_notebook.py --test runs the non-TF cells)
backend/                         Rust (axum + sqlx/MySQL) API
backend/models/*.json            Model files exported by the notebook
db/schema.sql                    MySQL tables the API reads + stock audit trigger
```

## The two algorithms

| | Stock prediction | Trend shift |
|---|---|---|
| Method | Linear regression on 6 features of the last 28 days | Segmented (two-piece) linear regression; breakpoint found by optimization |
| Trained in Colab | TensorFlow `Dense(1)`, verified against closed-form least squares | TensorFlow curve fit; shift threshold calibrated on 600 labeled series |
| Output | Units expected to sell in the next 7 days, days until stockout, reorder suggestion | Whether demand changed direction, when, and which way |

The models in `backend/models/` right now are **placeholders** from synthetic data so the backend runs immediately.
Replace them with your own Colab export.

## Workflow

1. Open `colab/bongalink_training.ipynb` in Google Colab, `Runtime → Run all`.
   It downloads `stock_lr.json`, `trend_config.json`, `parity.json`.
2. Copy the three files into `backend/models/`.
3. `cd backend && cargo test` — confirms Rust computes exactly what the notebook computed.
4. `mysql -u root -p < ../db/schema.sql`, then `cp .env.example .env` and edit `DATABASE_URL`.
5. `cargo run` → `http://127.0.0.1:8080`

When real orders accumulate (at least ~4 months), set `DATA_SOURCE = "mysql"` in the notebook and retrain.

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

## Contract between notebook and backend

Changing any of these requires changing **both** `make_features` (notebook) and `src/features.rs` (Rust), then retraining:

- `WINDOW = 28`, `HORIZON = 7`, `TREND_DAYS = 84`, `MIN_SEGMENT = 14`
- Features: `mean_7, mean_14, mean_28, slope_14, zero_ratio_28, paydays_next_7`
- Payday window: 14th–16th, last two days of the month, and the 1st
- "Units sold" = order items in orders with status `paid`, `shipped`, or `delivered`

`cargo test` fails loudly if the two sides drift apart.
