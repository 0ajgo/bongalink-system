"""All SQL the worker runs. Every value is passed as a bound parameter (%s)."""
from __future__ import annotations

import datetime as dt
from collections import defaultdict

import numpy as np
import pymysql
import pymysql.cursors

from .config import Settings

# What counts as a sale: payment confirmed (processing, paid, packed, shipped)
# or delivered (completed, delivered). processing/completed are the statuses
# used before PayMongo; the rest come from migration 004.
# pending/pending_payment = not paid yet, expired/cancelled = never happened.
# Must match SOLD_STATUSES in Backend/routes/ml.js.
SOLD_STATUSES = ("processing", "completed", "paid", "packed", "shipped", "delivered")


def connect(s: Settings) -> pymysql.connections.Connection:
    return pymysql.connect(
        host=s.db_host, port=s.db_port, user=s.db_user, password=s.db_password,
        database=s.db_name, charset="utf8mb4", autocommit=True,
        cursorclass=pymysql.cursors.DictCursor,
    )


def _in(values) -> str:
    return ", ".join(["%s"] * len(values))


def today(conn) -> dt.date:
    """The database's date, so 'today' agrees with order timestamps even if the
    worker runs in a container with a different time zone."""
    with conn.cursor() as cur:
        cur.execute("SELECT CURDATE() AS d")
        return cur.fetchone()["d"]


# ---------------------------------------------------------------- events
def pending_summary(conn) -> dict:
    with conn.cursor() as cur:
        cur.execute(
            """SELECT COUNT(*) AS n, MAX(event_id) AS max_id,
                      TIMESTAMPDIFF(MICROSECOND, MIN(created_at), NOW(3)) / 1e6 AS oldest_age,
                      TIMESTAMPDIFF(MICROSECOND, MAX(created_at), NOW(3)) / 1e6 AS newest_age
               FROM ml_events WHERE processed = 0"""
        )
        row = cur.fetchone()
    return {"n": int(row["n"]), "max_id": row["max_id"],
            "oldest_age": float(row["oldest_age"] or 0), "newest_age": float(row["newest_age"] or 0)}


def pending_events(conn, max_id: int) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            """SELECT event_id, product_id, event_type, old_value, new_value
               FROM ml_events WHERE processed = 0 AND event_id <= %s ORDER BY event_id""",
            (max_id,),
        )
        return cur.fetchall()


def mark_processed(cur, max_id: int) -> int:
    cur.execute(
        "UPDATE ml_events SET processed = 1, processed_at = NOW() WHERE processed = 0 AND event_id <= %s",
        (max_id,),
    )
    return cur.rowcount


# ---------------------------------------------------------------- products & sales
def active_products(conn) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            """SELECT p.product_id, p.name, p.category_id, c.name AS category,
                      p.stock_quantity, DATE(p.created_at) AS listed_on
               FROM products p JOIN categories c ON c.category_id = p.category_id
               WHERE p.is_active = 1
               ORDER BY p.product_id"""
        )
        return cur.fetchall()


def all_products(conn) -> list[dict]:
    """Active AND removed products: removed ones still carry useful training history."""
    with conn.cursor() as cur:
        cur.execute("SELECT product_id, DATE(created_at) AS listed_on FROM products ORDER BY product_id")
        return cur.fetchall()


def lifetime_units(conn, product_ids) -> dict[int, int]:
    if not product_ids:
        return {}
    with conn.cursor() as cur:
        cur.execute(
            f"""SELECT oi.product_id, CAST(SUM(oi.quantity) AS SIGNED) AS units
                FROM order_items oi JOIN orders o ON o.order_id = oi.order_id
                WHERE o.status IN ({_in(SOLD_STATUSES)}) AND oi.product_id IN ({_in(product_ids)})
                GROUP BY oi.product_id""",
            (*SOLD_STATUSES, *product_ids),
        )
        return {r["product_id"]: int(r["units"]) for r in cur.fetchall()}


def daily_units(conn, start: dt.date, end: dt.date, product_ids=None) -> dict[int, np.ndarray]:
    """Units sold per product per day for start <= day < end (oldest first, zero-filled)."""
    days = (end - start).days
    params = [*SOLD_STATUSES, start, end]
    product_filter = ""
    if product_ids is not None:
        if not product_ids:
            return {}
        product_filter = f"AND oi.product_id IN ({_in(product_ids)})"
        params += list(product_ids)
    with conn.cursor() as cur:
        cur.execute(
            f"""SELECT oi.product_id, DATE(o.created_at) AS d, CAST(SUM(oi.quantity) AS SIGNED) AS units
                FROM order_items oi JOIN orders o ON o.order_id = oi.order_id
                WHERE o.status IN ({_in(SOLD_STATUSES)})
                  AND o.created_at >= %s AND o.created_at < %s {product_filter}
                GROUP BY oi.product_id, DATE(o.created_at)""",
            params,
        )
        rows = cur.fetchall()
    out: dict[int, np.ndarray] = defaultdict(lambda: np.zeros(days))
    for pid in product_ids or []:
        out[pid] = np.zeros(days)
    for r in rows:
        out[r["product_id"]][(r["d"] - start).days] = float(r["units"])
    return dict(out)


def order_lines(conn, product_ids, start: dt.date | None = None, end: dt.date | None = None) -> list[dict]:
    """Individual sold order lines (product_id, day, quantity), optionally limited to start <= day < end."""
    if not product_ids:
        return []
    params = [*SOLD_STATUSES, *product_ids]
    window = ""
    if start is not None:
        window = "AND o.created_at >= %s AND o.created_at < %s"
        params += [start, end]
    with conn.cursor() as cur:
        cur.execute(
            f"""SELECT oi.product_id, DATE(o.created_at) AS d, oi.quantity
                FROM order_items oi JOIN orders o ON o.order_id = oi.order_id
                WHERE o.status IN ({_in(SOLD_STATUSES)}) AND oi.product_id IN ({_in(product_ids)}) {window}""",
            params,
        )
        return cur.fetchall()


def sold_items_total(conn) -> int:
    with conn.cursor() as cur:
        cur.execute(
            f"""SELECT COALESCE(CAST(SUM(oi.quantity) AS SIGNED), 0) AS n
                FROM order_items oi JOIN orders o ON o.order_id = oi.order_id
                WHERE o.status IN ({_in(SOLD_STATUSES)})""",
            SOLD_STATUSES,
        )
        return int(cur.fetchone()["n"])


def first_sale_date(conn):
    with conn.cursor() as cur:
        cur.execute(
            f"""SELECT MIN(DATE(o.created_at)) AS d FROM orders o
                WHERE o.status IN ({_in(SOLD_STATUSES)})""",
            SOLD_STATUSES,
        )
        return cur.fetchone()["d"]


# ---------------------------------------------------------------- predictions
PREDICTION_COLUMNS = (
    "product_id", "current_stock", "predicted_demand_7d", "avg_daily_demand", "days_until_stockout",
    "reorder_recommended", "suggested_reorder_qty", "forecast_source", "data_status", "history_days",
    "trend_status", "trend_direction", "trend_relative_change", "trend_days_since_breakpoint",
    "model_version",
)


def write_predictions(conn, rows: list[dict], processed_up_to: int | None) -> int:
    """Replace the predictions table contents and mark events processed, atomically:
    the dashboard never sees a half-written refresh, and events are only marked
    processed if their predictions were actually saved."""
    cols = ", ".join(PREDICTION_COLUMNS)
    updates = ", ".join(f"{c} = VALUES({c})" for c in PREDICTION_COLUMNS[1:])
    marked = 0
    conn.begin()
    try:
        with conn.cursor() as cur:
            if rows:
                cur.executemany(
                    f"""INSERT INTO ml_predictions ({cols}, computed_at)
                        VALUES ({_in(PREDICTION_COLUMNS)}, NOW())
                        ON DUPLICATE KEY UPDATE {updates}, computed_at = NOW()""",
                    [tuple(r[c] for c in PREDICTION_COLUMNS) for r in rows],
                )
            ids = [r["product_id"] for r in rows]
            # Removed products (and anything else not scored this round) drop out.
            if ids:
                cur.execute(f"DELETE FROM ml_predictions WHERE product_id NOT IN ({_in(ids)})", ids)
            else:
                cur.execute("DELETE FROM ml_predictions")
            if processed_up_to is not None:
                marked = mark_processed(cur, processed_up_to)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return marked


# ---------------------------------------------------------------- status
def set_status(conn, **fields) -> None:
    allowed = {"state", "last_update_at", "last_error", "last_train_at", "last_train_status",
               "last_train_message", "sold_items_at_last_train", "heartbeat_at",
               "auto_retrain_hour", "auto_retrain_orders", "auto_retrain_stock_changes",
               "sold_orders_at_last_train", "event_id_at_last_train"}
    if not fields:
        return
    bad = set(fields) - allowed
    if bad:
        raise ValueError(f"unknown ml_status fields {bad}")
    assignments = []
    params = []
    for k, v in fields.items():
        if v == "NOW()":
            assignments.append(f"{k} = NOW()")
        else:
            assignments.append(f"{k} = %s")
            params.append(v)
    with conn.cursor() as cur:
        cur.execute(f"UPDATE ml_status SET {', '.join(assignments)} WHERE id = 1", params)


def get_status(conn) -> dict:
    with conn.cursor() as cur:
        cur.execute("SELECT * FROM ml_status WHERE id = 1")
        return cur.fetchone()


# ---------------------------------------------------------------- model versions
def active_model_version(conn) -> dict | None:
    with conn.cursor() as cur:
        cur.execute("SELECT * FROM ml_model_versions WHERE status = 'active' ORDER BY version_id DESC LIMIT 1")
        return cur.fetchone()


def record_model_version(conn, *, version, file_path, trained_with, data_source, train_rows=None,
                         val_rows=None, val_mae=None, baseline_val_mae=None, status, notes=None) -> None:
    """Insert a version row. When status='active', the previous active one is retired
    in the same transaction, so there is always exactly one active model."""
    conn.begin()
    try:
        with conn.cursor() as cur:
            if status == "active":
                cur.execute("UPDATE ml_model_versions SET status = 'retired' WHERE status = 'active'")
            cur.execute(
                """INSERT INTO ml_model_versions
                     (version, file_path, trained_with, data_source, train_rows, val_rows,
                      val_mae, baseline_val_mae, status, notes)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (version, str(file_path), trained_with, data_source, train_rows, val_rows,
                 val_mae, baseline_val_mae, status, (notes or "")[:1000] or None),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise


# ---------------------------------------------------------------- training runs (migration 010)
# One row per retraining. While a run is queued or training, ml_training_runs.active_slot
# is 1 and its UNIQUE key makes MySQL refuse any second run, wherever it comes from.
RUN_STATS = ("sales_records", "orders_used", "products_used", "train_rows", "val_rows", "data_from", "data_to",
             "val_mae", "baseline_val_mae", "naive_val_mae")


def claim_queued_run(conn) -> dict | None:
    """Takes the run an admin queued from the Forecasts page (oldest first), if any."""
    with conn.cursor() as cur:
        cur.execute("""UPDATE ml_training_runs SET status = 'training', started_at = NOW(3)
                       WHERE status = 'queued' ORDER BY run_id LIMIT 1""")
        if cur.rowcount == 0:
            return None
        cur.execute("SELECT * FROM ml_training_runs WHERE status = 'training' ORDER BY run_id DESC LIMIT 1")
        return cur.fetchone()


def start_run(conn, trigger_type: str, detail: str) -> dict | None:
    """Starts an automatic or command-line run. None if another run is already queued or training."""
    try:
        with conn.cursor() as cur:
            cur.execute("""INSERT INTO ml_training_runs (trigger_type, trigger_detail, status, started_at)
                           VALUES (%s, %s, 'training', NOW(3))""", (trigger_type, detail[:255]))
            cur.execute("SELECT * FROM ml_training_runs WHERE run_id = %s", (cur.lastrowid,))
            return cur.fetchone()
    except pymysql.err.IntegrityError:
        return None


def finish_run(conn, run_id: int, *, status: str, outcome: str, message: str,
               model_version: str | None = None, stats: dict | None = None) -> None:
    fields = {"status": status, "outcome": outcome, "message": (message or "")[:1000], "model_version": model_version}
    fields.update({k: v for k, v in (stats or {}).items() if k in RUN_STATS})
    sets = ", ".join(f"{k} = %s" for k in fields)
    with conn.cursor() as cur:
        cur.execute(f"UPDATE ml_training_runs SET {sets}, finished_at = NOW(3) WHERE run_id = %s",
                    (*fields.values(), run_id))


def fail_interrupted_runs(conn) -> int:
    """At start-up: a run still 'training' means the worker stopped in the middle of it."""
    with conn.cursor() as cur:
        cur.execute("""UPDATE ml_training_runs
                       SET status = 'failed', outcome = 'failed', finished_at = NOW(3),
                           message = 'The ML worker stopped during training. The model in use was kept.'
                       WHERE status = 'training'""")
        return cur.rowcount


# ---------------------------------------------------------------- new-data counters
def sold_orders_total(conn) -> int:
    with conn.cursor() as cur:
        cur.execute(f"SELECT COUNT(*) AS n FROM orders WHERE status IN ({_in(SOLD_STATUSES)})", SOLD_STATUSES)
        return int(cur.fetchone()["n"])


def max_event_id(conn) -> int:
    with conn.cursor() as cur:
        cur.execute("SELECT COALESCE(MAX(event_id), 0) AS n FROM ml_events")
        return int(cur.fetchone()["n"])


def stock_changes_since(conn, event_id: int) -> int:
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) AS n FROM ml_events WHERE event_type = 'STOCK_CHANGED' AND event_id > %s", (event_id,))
        return int(cur.fetchone()["n"])


def training_data_counts(conn, start: dt.date, end: dt.date) -> dict:
    """How much sales data a training window used: sold order lines, orders and products."""
    with conn.cursor() as cur:
        cur.execute(
            f"""SELECT COUNT(*) AS lines_, COUNT(DISTINCT o.order_id) AS orders_, COUNT(DISTINCT oi.product_id) AS products_
                FROM order_items oi JOIN orders o ON o.order_id = oi.order_id
                WHERE o.status IN ({_in(SOLD_STATUSES)}) AND o.created_at >= %s AND o.created_at < %s""",
            (*SOLD_STATUSES, start, end),
        )
        r = cur.fetchone()
        return {"sales_records": int(r["lines_"]), "orders_used": int(r["orders_"]), "products_used": int(r["products_"])}
