"""The two Bongalink algorithms, without any database code.

Feature engineering and trend detection are copied from the Colab notebook
(ml/colab/build_notebook.py: make_features, fit_breakpoint, detect_shift) and the
forecast post-processing from ml/backend/src/stock.rs. tests/test_core.py checks
all of it against ml/backend/models/parity.json, the numbers the notebook exported,
so the worker, the notebook and the Rust parity checker can't silently drift apart.
"""
from __future__ import annotations

import datetime as dt
import json
import math
from pathlib import Path

import numpy as np

# ---- Shared contract with the notebook and ml/backend/src/features.rs ----
WINDOW = 28          # days of sales history the stock model reads
HORIZON = 7          # days ahead the stock model predicts
TREND_DAYS = 84      # days of history the trend-shift detector reads
MIN_SEGMENT = 14     # each side of a trend breakpoint covers at least 2 weeks
FEATURE_NAMES = ["mean_7", "mean_14", "mean_28", "slope_14", "zero_ratio_28", "paydays_next_7"]
COVER_DAYS = 14.0    # suggested reorders aim to keep this many days of demand on hand


def is_payday(d: dt.date) -> bool:
    """Philippine semi-monthly payday window: 14th-16th, last two days of month, and the 1st."""
    nxt = dt.date(d.year + d.month // 12, d.month % 12 + 1, 1)
    days_in_month = (nxt - dt.timedelta(days=1)).day
    return d.day in (1, 14, 15, 16) or d.day >= days_in_month - 1


def ols_slope(y) -> float:
    y = np.asarray(y, dtype=float)
    x = np.arange(len(y), dtype=float)
    x -= x.mean()
    return float((x * (y - y.mean())).sum() / (x * x).sum())


def make_features(history, target_start: dt.date) -> np.ndarray:
    h = np.asarray(history, dtype=float)
    if len(h) != WINDOW:
        raise ValueError(f"expected {WINDOW} days of history, got {len(h)}")
    paydays = sum(is_payday(target_start + dt.timedelta(days=i)) for i in range(HORIZON))
    return np.array([h[-7:].mean(), h[-14:].mean(), h.mean(), ols_slope(h[-14:]),
                     float((h == 0).mean()), float(paydays)])


# ---------------------------------------------------------------------------
# Algorithm 1: stock prediction (linear regression trained with TensorFlow)
# ---------------------------------------------------------------------------
class StockModel:
    """Weights in the same JSON format the notebook exports (stock_lr.json)."""

    def __init__(self, spec: dict):
        if spec.get("window_days") != WINDOW or spec.get("horizon_days") != HORIZON:
            raise ValueError("model window/horizon do not match the worker")
        if list(spec.get("feature_names", [])) != FEATURE_NAMES:
            raise ValueError(f"model features {spec.get('feature_names')} != {FEATURE_NAMES}")
        self.spec = spec
        self.mean = np.asarray(spec["feature_mean"], dtype=float)
        self.std = np.asarray(spec["feature_std"], dtype=float)
        self.weights = np.asarray(spec["weights"], dtype=float)
        self.bias = float(spec["bias"])
        if not (len(self.mean) == len(self.std) == len(self.weights) == len(FEATURE_NAMES)):
            raise ValueError("model vectors must all have one entry per feature")
        if np.any(self.std <= 0):
            raise ValueError("feature_std must be positive")

    @classmethod
    def from_file(cls, path) -> "StockModel":
        return cls(json.loads(Path(path).read_text(encoding="utf-8")))

    def predict_features(self, X) -> np.ndarray:
        """Predicted units over the next HORIZON days for each row of raw features."""
        Z = (np.atleast_2d(np.asarray(X, dtype=float)) - self.mean) / self.std
        return np.clip(Z @ self.weights + self.bias, 0.0, None)

    def predict_demand(self, history, target_start: dt.date) -> float:
        return float(self.predict_features(make_features(history, target_start)[None, :])[0])


def _round_half_up(v: float, digits: int) -> float:
    """Rust's f64::round (half away from zero), not Python's banker's rounding."""
    f = 10.0 ** digits
    return math.copysign(math.floor(abs(v) * f + 0.5), v) / f


def stock_outlook(demand_7d: float, current_stock: int, allow_reorder: bool = True) -> dict:
    """Same rules as StockModel::forecast in ml/backend/src/stock.rs.

    allow_reorder=False is used for cold-start estimates: an out-of-stock product
    is still flagged, but a guessed demand never triggers a reorder by itself.
    """
    daily = demand_7d / HORIZON
    stock = max(current_stock, 0)
    # A forecast that rounds to 0.00 units means "no expected demand": dividing stock by a
    # near-zero rate would show thousands of days of stock.
    has_demand = _round_half_up(demand_7d, 2) > 0
    days_until_stockout = _round_half_up(stock / daily, 1) if has_demand else None
    by_demand = days_until_stockout is not None and days_until_stockout < HORIZON
    reorder = current_stock <= 0 or (allow_reorder and by_demand)
    qty = max(math.ceil(daily * COVER_DAYS) - stock, 0) if reorder else 0
    return {
        "predicted_demand_7d": _round_half_up(demand_7d, 2),
        "avg_daily_demand": _round_half_up(daily, 3),
        "days_until_stockout": days_until_stockout,
        "reorder_recommended": bool(reorder),
        "suggested_reorder_qty": int(qty),
    }


# ---------------------------------------------------------------------------
# Algorithm 2: trend shift (segmented regression, threshold calibrated in Colab)
# ---------------------------------------------------------------------------
def fit_breakpoint(y, min_segment: int = MIN_SEGMENT) -> dict:
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


def detect_shift(y, threshold: float) -> dict:
    fit = fit_breakpoint(y)
    level = float(np.mean(y)) + 1.0
    rel = (fit["slope_after"] - fit["slope_before"]) / level
    detected = abs(rel) >= threshold
    return {**fit, "relative_change": rel, "shift_detected": bool(detected),
            "direction": ("upward" if rel > 0 else "downward") if detected else "none",
            "days_since_breakpoint": len(y) - 1 - fit["breakpoint_index"]}


class TrendConfig:
    def __init__(self, spec: dict):
        if spec.get("window_days") != TREND_DAYS or spec.get("min_segment_days") != MIN_SEGMENT:
            raise ValueError("trend_config window/min_segment do not match the worker")
        self.threshold = float(spec["relative_change_threshold"])
        if self.threshold <= 0:
            raise ValueError("relative_change_threshold must be positive")

    @classmethod
    def from_file(cls, path) -> "TrendConfig":
        return cls(json.loads(Path(path).read_text(encoding="utf-8")))

    def detect(self, y) -> dict:
        if len(y) != TREND_DAYS:
            raise ValueError(f"expected {TREND_DAYS} days of history, got {len(y)}")
        return detect_shift(y, self.threshold)
