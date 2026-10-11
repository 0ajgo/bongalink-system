"""Inference: turn current sales history + stock into ml_predictions rows.

No training happens here. A stock or price change only changes the inputs
(current stock), and an added/removed product only changes which products get
scored. The stock model is product-agnostic (6 features in, one number out),
so neither ever requires retraining.
"""
from __future__ import annotations

import datetime as dt
from collections import defaultdict
from statistics import mean

from . import db
from .core import TREND_DAYS, WINDOW, StockModel, TrendConfig, stock_outlook


def compute_predictions(conn, model: StockModel, model_version: str, trend: TrendConfig,
                        cold_start_days: int, today: dt.date | None = None) -> list[dict]:
    today = today or db.today(conn)
    products = db.active_products(conn)
    ids = [p["product_id"] for p in products]
    history = db.daily_units(conn, today - dt.timedelta(days=TREND_DAYS), today, ids)
    lifetime = db.lifetime_units(conn, ids)

    rows = []
    for p in products:
        pid = p["product_id"]
        age = (today - p["listed_on"]).days
        h = history[pid]
        has_sales = lifetime.get(pid, 0) > 0
        row = {
            "product_id": pid, "current_stock": int(p["stock_quantity"]), "history_days": age,
            "model_version": model_version, "_category_id": p["category_id"],
        }

        # Cold start: a product listed less than `cold_start_days` ago (or never sold)
        # has zeros in its 28-day window that mean "didn't exist yet", not "no demand".
        if age >= max(cold_start_days, WINDOW) and has_sales:
            demand = model.predict_demand(h[-WINDOW:], today)
            row.update(stock_outlook(demand, row["current_stock"]),
                       forecast_source="model", data_status="ok")
        else:
            row.update(data_status="insufficient_data")  # filled in below

        if age >= TREND_DAYS and has_sales:
            t = trend.detect(h)
            row.update(trend_status="ok", trend_direction=t["direction"],
                       trend_relative_change=round(t["relative_change"], 6),
                       trend_days_since_breakpoint=int(t["days_since_breakpoint"]))
        else:
            row.update(trend_status="insufficient_data", trend_direction=None,
                       trend_relative_change=None, trend_days_since_breakpoint=None)
        rows.append(row)

    _fill_cold_start(rows)
    for r in rows:
        r.pop("_category_id")
    return rows


def _fill_cold_start(rows: list[dict]) -> None:
    """Products without enough history get their category's average model forecast
    (or the store average if the category has none), clearly labelled as such."""
    by_category = defaultdict(list)
    for r in rows:
        if r["data_status"] == "ok":
            by_category[r["_category_id"]].append(r["predicted_demand_7d"])
    store = [d for ds in by_category.values() for d in ds]

    for r in rows:
        if r["data_status"] == "ok":
            continue
        if by_category.get(r["_category_id"]):
            estimate, source = mean(by_category[r["_category_id"]]), "category_average"
        elif store:
            estimate, source = mean(store), "store_average"
        else:
            estimate, source = None, "none"

        if estimate is None:
            r.update(predicted_demand_7d=None, avg_daily_demand=None, days_until_stockout=None,
                     reorder_recommended=r["current_stock"] <= 0, suggested_reorder_qty=0)
        else:
            # A guessed demand never triggers a reorder on its own; only an empty shelf does.
            r.update(stock_outlook(estimate, r["current_stock"], allow_reorder=False))
        r["forecast_source"] = source
