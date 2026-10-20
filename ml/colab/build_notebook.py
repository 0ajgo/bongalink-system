"""Builds bongalink_training.ipynb for Google Colab.

Each cell is (kind, tag, source). Tags let this script run the non-TensorFlow
cells locally as a test harness (`python build_notebook.py --test`).
"""
import json
import sys
from pathlib import Path

CELLS = [
("md", "", r'''# Bongalink — Stock Prediction & Trend Shift Training (Google Colab)

Trains the two analytics algorithms for the **Database System** objective (REQ07, REQ028, REQ032):

| # | Algorithm | Answers | Trained with |
|---|-----------|---------|--------------|
| 1 | **Linear regression** (stock prediction) | "How many units of this part will sell in the next 7 days, and when will we run out?" | TensorFlow (`Dense(1)` = linear regression), checked against the closed-form solution |
| 2 | **Segmented regression via optimization** (trend shift) | "Did demand for this part change direction recently, when, and which way?" | TensorFlow curve fit (SciPy `curve_fit`-style), threshold calibrated on labeled series |

**Output:** three JSON files (`stock_lr.json`, `trend_config.json`, `parity.json`) that go into `backend/models/`.
The Rust backend loads them and serves predictions — no Python at runtime.

Run all cells top to bottom (`Runtime → Run all`).'''),

("code", "", r'''import json, math, datetime as dt
from pathlib import Path
import numpy as np
import pandas as pd

SEED = 42
rng = np.random.default_rng(SEED)

# ---- Shared contract with the Rust backend (backend/src/features.rs) ----
WINDOW = 28          # days of sales history the stock model reads
HORIZON = 7          # days ahead the stock model predicts
TREND_DAYS = 84      # days of history the trend-shift detector reads (12 weeks)
MIN_SEGMENT = 14     # each side of a trend breakpoint must cover at least 2 weeks
FEATURE_NAMES = ["mean_7", "mean_14", "mean_28", "slope_14", "zero_ratio_28", "paydays_next_7"]
EXPORT_DIR = Path("bongalink_models")
EXPORT_DIR.mkdir(exist_ok=True)'''),

("code", "tf", r'''import tensorflow as tf
tf.random.set_seed(SEED)
print("TensorFlow", tf.__version__)'''),

("md", "", r'''## 1. Sales data

`DATA_SOURCE = "synthetic"` generates realistic practice data (Bongalink's history is still in Notepad logs).
Once orders are in the MySQL database, switch to `"mysql"` (or export a CSV with columns `product_id,date,units`).

Synthetic data includes weekend bumps, **payday spikes (15th/30th)**, sudden/gradual demand shifts, and occasional stockouts.'''),

("code", "", r'''def is_payday(d: dt.date) -> bool:
    """Philippine semi-monthly payday window: 14th-16th, last two days of month, and the 1st."""
    nxt = dt.date(d.year + d.month // 12, d.month % 12 + 1, 1)
    days_in_month = (nxt - dt.timedelta(days=1)).day
    return d.day in (1, 14, 15, 16) or d.day >= days_in_month - 1


def simulate_series(rng, dates, base, n_shifts):
    """Daily unit sales for one part. Returns (units, shifts) where shifts = [(start, ramp, multiplier)]."""
    n = len(dates)
    idx = np.arange(n)
    level = np.full(n, base, dtype=float)
    shifts = []
    for _ in range(n_shifts):
        start = int(rng.integers(30, n - 30))
        ramp = int(rng.integers(1, 21))  # 1 = sudden shift, 20 = gradual
        mult = float(rng.uniform(0.35, 0.7) if rng.random() < 0.5 else rng.uniform(1.5, 2.5))
        level *= np.interp(idx, [start, start + ramp], [1.0, mult])
        shifts.append((start, ramp, mult))
    weekend = np.array([1.15 if d.weekday() >= 5 else 1.0 for d in dates])
    payday = np.array([1.3 if is_payday(d) else 1.0 for d in dates])
    units = rng.poisson(level * weekend * payday).astype(float)
    if rng.random() < 0.3:  # stockout: recorded sales drop to zero for a few days
        s = int(rng.integers(0, n - 10))
        units[s:s + int(rng.integers(3, 10))] = 0
    return units, shifts'''),

("code", "", r'''DATA_SOURCE = "synthetic"   # "synthetic" | "csv" | "mysql"
CSV_PATH = "sales_daily.csv"
MYSQL_URL = "mysql+pymysql://USER:PASSWORD@HOST:3306/bongalink_real"   # needs: !pip install pymysql sqlalchemy

# Same definition of "demand" the ML worker uses (worker/bongalink_ml/db.py)
# and Backend/routes/ml.js: paid orders count as sales; unpaid, expired and
# cancelled orders don't. Keep all three lists identical.
SOLD_STATUSES = ("processing", "completed", "paid", "packed", "shipped", "delivered")
SALES_SQL = f"""
SELECT oi.product_id, DATE(o.created_at) AS date, SUM(oi.quantity) AS units
FROM order_items oi JOIN orders o ON o.order_id = oi.order_id
WHERE o.status IN ({", ".join(repr(s) for s in SOLD_STATUSES)})
GROUP BY oi.product_id, DATE(o.created_at)
"""

CATALOG = {
    "printer": ["Printhead", "Waste ink pad", "Pickup roller", "Fuser unit", "Printer mainboard", "CISS ink tank kit"],
    "laptop":  ["Laptop battery", "Laptop keyboard", "14in laptop screen", "Laptop charger", "Laptop cooling fan", "Hinge set"],
    "desktop": ["RAM 8GB DDR4", "SSD 256GB", "PSU 500W", "CPU cooler", "Motherboard", "HDD 1TB"],
}

def synthetic_sales(days=730):
    end = dt.date.today() - dt.timedelta(days=1)
    dates = [end - dt.timedelta(days=days - 1 - i) for i in range(days)]
    rows, pid = [], 1
    for items in CATALOG.values():
        for _ in items:
            units, _ = simulate_series(rng, dates, base=float(rng.uniform(0.3, 6.0)), n_shifts=int(rng.integers(1, 4)))
            rows += [(pid, d, u) for d, u in zip(dates, units)]
            pid += 1
    return pd.DataFrame(rows, columns=["product_id", "date", "units"])

if DATA_SOURCE == "synthetic":
    sales = synthetic_sales()
elif DATA_SOURCE == "csv":
    sales = pd.read_csv(CSV_PATH)
    sales["date"] = pd.to_datetime(sales["date"]).dt.date
elif DATA_SOURCE == "mysql":
    from sqlalchemy import create_engine
    sales = pd.read_sql(SALES_SQL, create_engine(MYSQL_URL))
    sales["date"] = pd.to_datetime(sales["date"]).dt.date
else:
    raise ValueError(DATA_SOURCE)

first, last = min(sales["date"]), max(sales["date"])
all_dates = [first + dt.timedelta(days=i) for i in range((last - first).days + 1)]
matrix = (sales.pivot_table(index="date", columns="product_id", values="units", aggfunc="sum")
               .reindex(all_dates).fillna(0.0))   # days with no orders = 0 units
if len(matrix) < WINDOW + HORIZON + 90:
    raise ValueError(f"Need at least {WINDOW + HORIZON + 90} days of history, got {len(matrix)}")
print(f"{matrix.shape[1]} products x {matrix.shape[0]} days ({first} to {last})")'''),

("md", "", r'''## 2. Features for the stock-prediction model

For each product and each day *t*, the model sees the previous 28 days and predicts **total units sold over the next 7 days**.
These six features are re-implemented line-for-line in `backend/src/features.rs`; `parity.json` proves both sides match.

| Feature | Meaning |
|---|---|
| `mean_7`, `mean_14`, `mean_28` | average daily units over the last 7 / 14 / 28 days |
| `slope_14` | least-squares slope of the last 14 days (units/day per day) |
| `zero_ratio_28` | share of the last 28 days with zero sales (slow movers, stockouts) |
| `paydays_next_7` | payday-window days in the coming week |'''),

("code", "", r'''def ols_slope(y):
    y = np.asarray(y, dtype=float)
    x = np.arange(len(y), dtype=float)
    x -= x.mean()
    return float((x * (y - y.mean())).sum() / (x * x).sum())

def make_features(history, target_start):
    h = np.asarray(history, dtype=float)
    assert len(h) == WINDOW
    paydays = sum(is_payday(target_start + dt.timedelta(days=i)) for i in range(HORIZON))
    return np.array([h[-7:].mean(), h[-14:].mean(), h.mean(), ols_slope(h[-14:]),
                     float((h == 0).mean()), float(paydays)])

dates = list(matrix.index)
T = len(dates)
cutoff = int(T * 0.8)   # time-based split: train on the past, test on the most recent 20%
X_tr, y_tr, X_te, y_te = [], [], [], []
for pid in matrix.columns:
    col = matrix[pid].to_numpy(dtype=float)
    for t in range(WINDOW, T - HORIZON + 1):
        f = make_features(col[t - WINDOW:t], dates[t])
        target = col[t:t + HORIZON].sum()
        if t + HORIZON <= cutoff:
            X_tr.append(f); y_tr.append(target)
        elif t >= cutoff:
            X_te.append(f); y_te.append(target)

X_train, y_train = np.array(X_tr), np.array(y_tr)
X_test, y_test = np.array(X_te), np.array(y_te)

feature_mean = X_train.mean(axis=0)
feature_std = X_train.std(axis=0)
feature_std[feature_std == 0] = 1.0
Z_train = (X_train - feature_mean) / feature_std
Z_test = (X_test - feature_mean) / feature_std
print(f"train rows: {len(X_train)}, test rows: {len(X_test)}")'''),

("md", "", r'''## 3. Algorithm 1 — Linear regression (TensorFlow)

A single `Dense(1)` layer with no activation **is** linear regression: `demand_7d = w·z + b`.
TensorFlow fits it by minimizing mean squared error; the next cell confirms it reached the same answer as the exact least-squares formula.'''),

("code", "tf_train", r'''lr_model = tf.keras.Sequential([
    tf.keras.Input(shape=(len(FEATURE_NAMES),)),
    tf.keras.layers.Dense(1, name="linear"),
])
lr_model.compile(optimizer=tf.keras.optimizers.Adam(learning_rate=0.05), loss="mse")
history = lr_model.fit(
    Z_train, y_train, epochs=300, batch_size=512, validation_split=0.1, verbose=0,
    callbacks=[tf.keras.callbacks.EarlyStopping(monitor="val_loss", patience=20, restore_best_weights=True)],
)
kernel, b = lr_model.get_layer("linear").get_weights()
weights, bias = kernel[:, 0].astype(float), float(b[0])
TRAINED_WITH = f"tensorflow {tf.__version__}"
print(f"stopped after {len(history.history['loss'])} epochs, final val MSE {history.history['val_loss'][-1]:.3f}")'''),

("code", "", r'''# Sanity check: closed-form least squares (normal equations) should give nearly the same weights.
A = np.column_stack([Z_train, np.ones(len(Z_train))])
coef_cf, *_ = np.linalg.lstsq(A, y_train, rcond=None)
cf_weights, cf_bias = coef_cf[:-1], float(coef_cf[-1])
if "weights" in globals():
    print("max |TF - closed form| weight difference:", float(np.max(np.abs(weights - cf_weights))))'''),

("code", "", r'''def predict_units(Z):
    return np.clip(Z @ weights + bias, 0.0, None)

pred_test = predict_units(Z_test)
naive_test = X_test[:, 0] * HORIZON          # baseline: "next week = last week's average"
mae = float(np.mean(np.abs(pred_test - y_test)))
mae_naive = float(np.mean(np.abs(naive_test - y_test)))
r2 = float(1 - np.sum((pred_test - y_test) ** 2) / np.sum((y_test - y_test.mean()) ** 2))
stock_metrics = {"test_mae_units_7d": round(mae, 3), "naive_mae_units_7d": round(mae_naive, 3),
                 "improvement_vs_naive_pct": round(100 * (1 - mae / mae_naive), 1), "test_r2": round(r2, 3),
                 "train_rows": int(len(X_train)), "test_rows": int(len(X_test))}
print(json.dumps(stock_metrics, indent=2))
print(pd.DataFrame({"feature": FEATURE_NAMES, "weight (standardized)": np.round(weights, 3)})
        .sort_values("weight (standardized)", key=np.abs, ascending=False).to_string(index=False))'''),

("md", "", r'''## 4. Algorithm 2 — Trend shift detection (optimization)

Fit a **continuous two-segment line** to the last 84 days of sales:

`units(x) ≈ a + b·x + c·max(0, x − k)`

The optimizer finds the breakpoint day `k` and slopes that minimize squared error (the same problem `scipy.optimize.curve_fit` solves).
`b` is the slope before the breakpoint, `b + c` the slope after. A **trend shift** is flagged when the slope change, relative to the product's average demand, exceeds a threshold calibrated below.

- `fit_breakpoint` — exact search over every allowed `k` (what the Rust backend runs: deterministic, always the global optimum).
- `tf_curve_fit` — TensorFlow gradient-based curve fit of the same model, used here to show both approaches agree.'''),

("code", "", r'''def fit_breakpoint(y, min_segment=MIN_SEGMENT):
    y = np.asarray(y, dtype=float)
    n = len(y)
    x = np.arange(n, dtype=float)
    best = None
    for k in range(min_segment, n - min_segment):
        A = np.column_stack([np.ones(n), x, np.maximum(0.0, x - k)])
        coef = np.linalg.solve(A.T @ A, A.T @ y)       # normal equations (same as backend)
        sse = float(((A @ coef - y) ** 2).sum())
        if best is None or sse < best["sse"]:
            best = {"breakpoint_index": k, "sse": sse, "intercept": float(coef[0]),
                    "slope_before": float(coef[1]), "slope_after": float(coef[1] + coef[2])}
    return best

def detect_shift(y, threshold):
    fit = fit_breakpoint(y)
    level = float(np.mean(y)) + 1.0
    rel = (fit["slope_after"] - fit["slope_before"]) / level
    detected = abs(rel) >= threshold
    return {**fit, "relative_change": rel, "shift_detected": bool(detected),
            "direction": ("upward" if rel > 0 else "downward") if detected else "none",
            "days_since_breakpoint": len(y) - 1 - fit["breakpoint_index"]}'''),

("code", "tf", r'''def tf_curve_fit(y, sharpness=2.0, steps=2000, lr=0.05):
    """Gradient-based fit of a + b*x + c*hinge(x - k). The hinge is smoothed (softplus) so k is differentiable."""
    y_t = tf.constant(np.asarray(y, dtype=np.float32))
    n = len(y)
    x = tf.range(n, dtype=tf.float32)
    best = None
    for frac in (0.25, 0.5, 0.75):               # several starting points: k is non-convex
        params = [tf.Variable(float(np.mean(y))), tf.Variable(0.0), tf.Variable(0.0), tf.Variable(frac * (n - 1))]
        m = [tf.Variable(0.0) for _ in params]; v = [tf.Variable(0.0) for _ in params]; t = tf.Variable(0.0)

        @tf.function
        def step():
            a, b, c, k = params
            with tf.GradientTape() as tape:
                hinge = tf.nn.softplus(sharpness * (x - k)) / sharpness
                loss = tf.reduce_mean(tf.square(a + b * x + c * hinge - y_t))
            grads = tape.gradient(loss, params)
            t.assign_add(1.0)
            for p, g, mi, vi in zip(params, grads, m, v):   # Adam update
                mi.assign(0.9 * mi + 0.1 * g); vi.assign(0.999 * vi + 0.001 * g * g)
                p.assign_sub(lr * (mi / (1 - 0.9 ** t)) / (tf.sqrt(vi / (1 - 0.999 ** t)) + 1e-8))
            k.assign(tf.clip_by_value(k, float(MIN_SEGMENT), float(n - MIN_SEGMENT - 1)))
            return loss

        for _ in range(steps):
            loss = step()
        a, b, c, k = (float(p.numpy()) for p in params)
        if best is None or float(loss) < best["loss"]:
            best = {"loss": float(loss), "breakpoint_index": k, "slope_before": b, "slope_after": b + c}
    return best

for pid in list(matrix.columns)[:4]:
    y = matrix[pid].to_numpy(dtype=float)[-TREND_DAYS:]
    exact, grad = fit_breakpoint(y), tf_curve_fit(y)
    print(f"product {pid}: exact k={exact['breakpoint_index']:>2}  slopes {exact['slope_before']:+.3f} -> {exact['slope_after']:+.3f} | "
          f"TF k={grad['breakpoint_index']:5.1f}  slopes {grad['slope_before']:+.3f} -> {grad['slope_after']:+.3f}")'''),

("code", "", r'''# Calibrate the shift threshold on labeled series (half with a real demand shift, half without).
cal_dates = [dt.date(2026, 1, 1) + dt.timedelta(days=i) for i in range(TREND_DAYS)]
scores, labels = [], []
for i in range(600):
    has_shift = i % 2 == 0
    y, _ = simulate_series(rng, cal_dates, base=float(rng.uniform(0.5, 8.0)), n_shifts=1 if has_shift else 0)
    fit = fit_breakpoint(y)
    scores.append(abs(fit["slope_after"] - fit["slope_before"]) / (float(np.mean(y)) + 1.0))
    labels.append(has_shift)
scores, labels = np.array(scores), np.array(labels)

rows = []
for th in np.round(np.arange(0.002, 0.0605, 0.001), 4):
    pred = scores >= th
    tp = int(np.sum(pred & labels)); fp = int(np.sum(pred & ~labels)); fn = int(np.sum(~pred & labels))
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    rows.append((float(th), precision, recall, f1))
cal = pd.DataFrame(rows, columns=["threshold", "precision", "recall", "f1"])
best_row = cal.loc[cal["f1"].idxmax()]
RELATIVE_CHANGE_THRESHOLD = float(best_row["threshold"])
trend_metrics = {"precision": round(float(best_row["precision"]), 3), "recall": round(float(best_row["recall"]), 3),
                 "f1": round(float(best_row["f1"]), 3), "labeled_series": int(len(scores))}
print("chosen threshold:", RELATIVE_CHANGE_THRESHOLD, trend_metrics)'''),

("code", "plot", r'''import matplotlib.pyplot as plt

pid = matrix.columns[0]
y = matrix[pid].to_numpy(dtype=float)[-TREND_DAYS:]
r = detect_shift(y, RELATIVE_CHANGE_THRESHOLD)
x = np.arange(TREND_DAYS); k = r["breakpoint_index"]
fitted = r["intercept"] + r["slope_before"] * x + (r["slope_after"] - r["slope_before"]) * np.maximum(0, x - k)
plt.figure(figsize=(10, 4))
plt.bar(x, y, color="#bbb", label="daily units")
plt.plot(x, fitted, color="crimson", lw=2, label="segmented fit")
plt.axvline(k, ls="--", color="k", label=f"breakpoint ({r['days_since_breakpoint']} days ago)")
plt.title(f"Product {pid}: shift={r['shift_detected']} ({r['direction']}), relative change {r['relative_change']:+.3f}")
plt.legend(); plt.show()'''),

("md", "", r'''## 5. Export for the Rust backend

- `stock_lr.json` — linear regression weights + feature scaling
- `trend_config.json` — trend window and calibrated threshold
- `parity.json` — one fixed example with the exact numbers this notebook computes; `cargo test` checks the backend reproduces them'''),

("code", "", r'''trained_at = dt.datetime.now().isoformat(timespec="seconds")
stock_lr = {
    "model": "linear_regression", "trained_with": TRAINED_WITH, "trained_at": trained_at, "data_source": DATA_SOURCE,
    "window_days": WINDOW, "horizon_days": HORIZON, "feature_names": FEATURE_NAMES,
    "feature_mean": feature_mean.tolist(), "feature_std": feature_std.tolist(),
    "weights": [float(w) for w in weights], "bias": float(bias), "metrics": stock_metrics,
}
trend_config = {
    "algorithm": "segmented_linear_regression", "trained_at": trained_at,
    "window_days": TREND_DAYS, "min_segment_days": MIN_SEGMENT,
    "relative_change_threshold": RELATIVE_CHANGE_THRESHOLD, "metrics": trend_metrics,
}

# Fixed parity example: demand steps up from ~3 to ~7.5 units/day around day 50.
fx_rng = np.random.default_rng(7)
fx_idx = np.arange(TREND_DAYS)
fx_units = fx_rng.poisson(np.interp(fx_idx, [50, 55], [3.0, 7.5])).astype(float)
fx_target_start = dt.date(2026, 6, 1) + dt.timedelta(days=TREND_DAYS)
fx_hist = fx_units[-WINDOW:]
fx_features = make_features(fx_hist, fx_target_start)
fx_trend = detect_shift(fx_units, RELATIVE_CHANGE_THRESHOLD)
parity = {
    "history": fx_units.tolist(), "target_start": fx_target_start.isoformat(),
    "features": fx_features.tolist(),
    "predicted_demand_7d": float(predict_units(((fx_features - feature_mean) / feature_std)[None, :])[0]),
    "trend": {k: fx_trend[k] for k in ("breakpoint_index", "slope_before", "slope_after", "relative_change", "shift_detected")},
}

for name, obj in [("stock_lr.json", stock_lr), ("trend_config.json", trend_config), ("parity.json", parity)]:
    (EXPORT_DIR / name).write_text(json.dumps(obj, indent=2))
    print("wrote", EXPORT_DIR / name)'''),

("code", "", r'''try:
    from google.colab import files
    for name in ("stock_lr.json", "trend_config.json", "parity.json"):
        files.download(str(EXPORT_DIR / name))
except ImportError:
    print("Not running in Colab; files are in", EXPORT_DIR.resolve())'''),
]


def to_ipynb(path):
    cells = []
    for kind, _tag, src in CELLS:
        lines = src.splitlines(keepends=True)
        if kind == "md":
            cells.append({"cell_type": "markdown", "metadata": {}, "source": lines})
        else:
            cells.append({"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": lines})
    nb = {"cells": cells, "metadata": {"kernelspec": {"name": "python3", "display_name": "Python 3"},
          "language_info": {"name": "python"}, "colab": {"provenance": []}}, "nbformat": 4, "nbformat_minor": 5}
    Path(path).write_text(json.dumps(nb, indent=1))


def run_local_test():
    """Run every non-TensorFlow cell. The TF training cell is replaced by the closed-form weights."""
    ns = {}
    for kind, tag, src in CELLS:
        if kind != "code" or tag in ("tf", "tf_train", "plot"):
            continue
        exec(src, ns)
        if "cf_weights" in ns and "weights" not in ns:
            ns["weights"], ns["bias"] = ns["cf_weights"], ns["cf_bias"]
            ns["TRAINED_WITH"] = "numpy closed-form (placeholder: replace with the Colab export)"


if __name__ == "__main__":
    to_ipynb(Path(__file__).with_name("bongalink_training.ipynb"))
    print("notebook written")
    if "--test" in sys.argv:
        run_local_test()
