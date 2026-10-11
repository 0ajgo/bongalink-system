"""Retraining the stock model from the orders in MySQL.

Same recipe as the Colab notebook (ml/colab/build_notebook.py, sections 2-3):
28-day windows -> 6 features -> units sold in the next 7 days, time-based 80/20
split, TensorFlow Dense(1) fitted with Adam + early stopping.

Safety rules:
  * every attempt is written to ml_model_versions (promoted, rejected or failed);
  * a new model is promoted only if its validation MAE is no worse than the
    active model's on the SAME holdout; otherwise the active model stays;
  * any exception leaves the active model untouched.

The trend-shift threshold is NOT retrained here: it was calibrated on labeled
series in Colab, and real orders have no "was this a real shift?" labels.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import db
from .core import FEATURE_NAMES, HORIZON, WINDOW, StockModel, make_features

log = logging.getLogger("bongalink_ml.training")

MIN_TRAIN_DAYS = WINDOW + HORIZON + 90   # same minimum as the notebook
MIN_TRAIN_ROWS = 50
MIN_VAL_ROWS = 20
SEED = 42


class InsufficientData(Exception):
    pass


@dataclass
class Dataset:
    X_train: np.ndarray
    y_train: np.ndarray
    X_val: np.ndarray
    y_val: np.ndarray
    first_day: dt.date
    last_day: dt.date


@dataclass
class TrainResult:
    status: str            # promoted | rejected | skipped | failed
    message: str
    version: str | None = None


def build_dataset(series: dict[int, np.ndarray], listed_idx: dict[int, int], dates: list[dt.date]) -> Dataset:
    """series[pid][i] = units sold on dates[i]. Windows that start before a product
    was listed are skipped, so pre-launch zeros are never treated as zero demand."""
    T = len(dates)
    if T < MIN_TRAIN_DAYS:
        raise InsufficientData(f"need at least {MIN_TRAIN_DAYS} days of sales history, have {T}")
    cutoff = int(T * 0.8)   # train on the past, validate on the most recent 20%
    X_tr, y_tr, X_va, y_va = [], [], [], []
    for pid, col in series.items():
        first_t = max(WINDOW, listed_idx.get(pid, 0) + WINDOW)
        for t in range(first_t, T - HORIZON + 1):
            f = make_features(col[t - WINDOW:t], dates[t])
            target = col[t:t + HORIZON].sum()
            if t + HORIZON <= cutoff:
                X_tr.append(f); y_tr.append(target)
            elif t >= cutoff:
                X_va.append(f); y_va.append(target)
    if len(X_tr) < MIN_TRAIN_ROWS or len(X_va) < MIN_VAL_ROWS:
        raise InsufficientData(f"only {len(X_tr)} training / {len(X_va)} validation windows "
                               f"(need {MIN_TRAIN_ROWS} / {MIN_VAL_ROWS})")
    return Dataset(np.array(X_tr), np.array(y_tr), np.array(X_va), np.array(y_va), dates[0], dates[-1])


def load_dataset(conn, today: dt.date) -> Dataset:
    first = db.first_sale_date(conn)
    if first is None:
        raise InsufficientData("no sold orders yet")
    dates = [first + dt.timedelta(days=i) for i in range((today - first).days)]   # up to yesterday
    products = db.all_products(conn)
    series = db.daily_units(conn, first, today, [p["product_id"] for p in products])
    listed_idx = {p["product_id"]: max((p["listed_on"] - first).days, 0) for p in products}
    return build_dataset(series, listed_idx, dates)


def fit_tensorflow(Z: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, float, str]:
    import tensorflow as tf   # imported lazily: inference never needs TensorFlow

    tf.keras.utils.set_random_seed(SEED)
    # validation_split takes the LAST 10% of rows, and rows are grouped by product, so
    # shuffle first or early stopping watches only the last few (often brand-new) products.
    order = np.random.default_rng(SEED).permutation(len(Z))
    Z, y = Z[order], y[order]
    # ~20 gradient steps per epoch, like the notebook's 9,900 rows / batch 512.
    batch_size = int(min(512, max(32, len(Z) // 20)))
    model = tf.keras.Sequential([
        tf.keras.Input(shape=(len(FEATURE_NAMES),)),
        tf.keras.layers.Dense(1, name="linear"),
    ])
    model.compile(optimizer=tf.keras.optimizers.Adam(learning_rate=0.05), loss="mse")
    hist = model.fit(
        Z, y, epochs=300, batch_size=batch_size, validation_split=0.1, verbose=0,
        callbacks=[tf.keras.callbacks.EarlyStopping(monitor="val_loss", patience=20, restore_best_weights=True)],
    )
    kernel, b = model.get_layer("linear").get_weights()
    epochs = len(hist.history["loss"])
    return (kernel[:, 0].astype(float), float(b[0]),
            f"tensorflow {tf.__version__} (Keras Dense(1), Adam, {epochs} epochs, batch {batch_size})")


def fit_closed_form(Z: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, float]:
    A = np.column_stack([Z, np.ones(len(Z))])
    coef, *_ = np.linalg.lstsq(A, y, rcond=None)
    return coef[:-1].astype(float), float(coef[-1])


def train_model(ds: Dataset, trainer: str) -> dict:
    """Returns a stock_lr.json-style dict (same format the notebook exports)."""
    feature_mean = ds.X_train.mean(axis=0)
    feature_std = ds.X_train.std(axis=0)
    feature_std[feature_std == 0] = 1.0
    Z = (ds.X_train - feature_mean) / feature_std

    cf_w, cf_b = fit_closed_form(Z, ds.y_train)
    notes = []
    try:
        weights, bias, trained_with = fit_tensorflow(Z, ds.y_train)
        notes.append(f"max |TF - closed form| weight diff {float(np.max(np.abs(weights - cf_w))):.4f}")
        log.info("trained with %s", trained_with)
    except ImportError:
        if trainer != "auto":
            raise RuntimeError("TensorFlow is not installed in this environment (set ML_TRAINER=auto "
                               "to allow the least-squares fallback)") from None
        weights, bias = cf_w, cf_b
        trained_with = f"numpy {np.__version__} closed-form least squares (FALLBACK: TensorFlow not installed)"
        log.warning("TensorFlow not available: trained with closed-form least squares instead")

    return {
        "model": "linear_regression", "trained_with": trained_with,
        "trained_at": dt.datetime.now().isoformat(timespec="seconds"), "data_source": "mysql",
        "window_days": WINDOW, "horizon_days": HORIZON, "feature_names": FEATURE_NAMES,
        "feature_mean": feature_mean.tolist(), "feature_std": feature_std.tolist(),
        "weights": [float(w) for w in weights], "bias": float(bias),
        "metrics": {"train_rows": int(len(ds.X_train)), "val_rows": int(len(ds.X_val)),
                    "data_from": ds.first_day.isoformat(), "data_to": ds.last_day.isoformat()},
        "notes": "; ".join(notes),
    }


def mae(model: StockModel, X: np.ndarray, y: np.ndarray) -> float:
    return float(np.mean(np.abs(model.predict_features(X) - y)))


def retrain(conn, models_dir: Path, active: StockModel | None, trainer: str) -> TrainResult:
    version = "v" + dt.datetime.now().strftime("%Y%m%d-%H%M%S-%f")[:-3]   # ms: unique even if retried at once
    try:
        ds = load_dataset(conn, db.today(conn))
    except InsufficientData as e:
        log.info("retraining skipped: %s", e)
        return TrainResult("skipped", f"Retraining skipped: {e}.")

    try:
        spec = train_model(ds, trainer)
        candidate = StockModel(spec)
        cand_mae = mae(candidate, ds.X_val, ds.y_val)
        base_mae = mae(active, ds.X_val, ds.y_val) if active else None
        naive_mae = float(np.mean(np.abs(ds.X_val[:, 0] * HORIZON - ds.y_val)))
        spec["metrics"].update(val_mae_units_7d=round(cand_mae, 3), naive_val_mae_units_7d=round(naive_mae, 3),
                               active_model_val_mae=None if base_mae is None else round(base_mae, 3))

        promote = base_mae is None or cand_mae <= base_mae
        status = "active" if promote else "rejected"
        file_name = f"stock_lr_{version}.json"
        (models_dir / "versions").mkdir(parents=True, exist_ok=True)
        (models_dir / "versions" / file_name).write_text(json.dumps(spec, indent=2), encoding="utf-8")

        verdict = (f"validation MAE {cand_mae:.3f} vs active {base_mae:.3f}" if base_mae is not None
                   else f"validation MAE {cand_mae:.3f} (no active model to compare)")
        notes = f"{verdict}; naive baseline {naive_mae:.3f}" + (f"; {spec['notes']}" if spec["notes"] else "")
        db.record_model_version(
            conn, version=version, file_path=file_name, trained_with=spec["trained_with"], data_source="mysql",
            train_rows=len(ds.X_train), val_rows=len(ds.X_val), val_mae=cand_mae, baseline_val_mae=base_mae,
            status=status, notes=notes,
        )
        if promote:
            log.info("model %s promoted (%s) [%s]", version, verdict, spec["trained_with"])
            return TrainResult("promoted", f"Model {version} promoted: {verdict}. Trained with {spec['trained_with']}.",
                               version)
        log.warning("model %s rejected, keeping the active model (%s)", version, verdict)
        return TrainResult("rejected", f"Model {version} rejected, kept the active model: {verdict}.", version)

    except Exception as e:   # anything at all: keep the active model, record the failure
        log.exception("retraining failed; keeping the active model")
        try:
            db.record_model_version(conn, version=version, file_path="", trained_with="(failed)",
                                    data_source="mysql", status="failed", notes=f"{type(e).__name__}: {e}")
        except Exception:
            log.exception("could not record the failed training run")
        return TrainResult("failed", f"Retraining failed, kept the active model: {type(e).__name__}: {e}"[:1000])
