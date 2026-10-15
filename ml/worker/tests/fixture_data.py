"""Synthetic data for the integration tests: a throwaway database (name must end in
"_test") built from the real schema + migration 003, with ~150 days of orders.

Shapes the tests rely on:
  * "Epson L3110 Printhead"  flat, then demand climbs steadily for the last ~50 days -> upward trend
  * "Seagate 1TB HDD"        flat, then demand falls steadily for the last ~50 days  -> downward trend
    (the trend model detects a change in slope; these ramps were read correctly for 11/11 random seeds)
  * "Ugreen USB-C Dock" listed 6 days ago, "Arctic MX-4 Thermal Paste" 3 days ago, unsold -> cold start
  * one product removed 20 days ago (soft delete) that still has sales history

No account here can log in: every user gets an unusable password hash.
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path

import numpy as np
import pymysql

from bongalink_ml import config, sqlscript
from bongalink_ml.core import is_payday

ROOT = Path(__file__).resolve().parents[3]
SCHEMA = ROOT / "Backend" / "database" / "bongalink_schema.sql"
# Same migrations as the backend's test database (003 = ML triggers ... 010 = training runs).
MIGRATIONS = sorted(p for p in (ROOT / "Backend" / "database" / "migrations").glob("0*.sql") if p.name >= "003")
NO_LOGIN = "!test-fixture-no-login"

CATEGORIES = [(1, "Printer Parts"), (2, "Computer Parts"), (3, "Laptop Parts"),
              (4, "Accessories"), (5, "Electronics"), (6, "Other")]

# name, category_id, brand, price, stock, base units/day, listed days ago (None = start of history),
# shift = (days ago it starts, ramp days, multiplier) or None
PRODUCTS = [
    ("Epson L3110 Printhead",      1, "Epson",    2850, 6,  1.0, None, (50, 50, 6.0)),
    ("Epson Waste Ink Pad",        1, "Epson",     450, 40, 2.5, None, None),
    ("Canon Pickup Roller",        1, "Canon",     380, 25, 1.8, None, None),
    ("CISS Ink Tank Kit",          1, "Generic",  1200, 12, 1.0, None, None),
    ("Kingston 8GB DDR4 RAM",      2, "Kingston", 1650, 30, 2.2, None, None),
    ("Kingston 256GB SSD",         2, "Kingston", 1890, 18, 2.6, None, None),
    ("Seagate 1TB HDD",            2, "Seagate",  2450, 35, 3.5, None, (50, 50, 0.15)),
    ("Corsair 500W PSU",           2, "Corsair",  2900, 8,  0.8, None, None),
    ("Laptop Battery (Generic)",   3, "Generic",  1750, 10, 1.5, None, None),
    ("Laptop Keyboard (Generic)",  3, "Generic",   950, 14, 1.1, None, None),
    ("65W Laptop Charger",         3, "Generic",   890, 5,  2.4, None, None),
    ("Logitech USB Mouse",         4, "Logitech",  450, 60, 3.5, None, None),
    ("HDMI Cable 2m",              4, "Generic",   220, 3,  2.8, None, None),
    ("Ugreen USB-C Dock",          4, "Ugreen",   2490, 15, 0.6, 6,    None),
    ("Arctic MX-4 Thermal Paste",  2, "Arctic",    350, 20, 0.0, 3,    None),
]
REMOVED = ("Epson L120 Mainboard", 1, "Epson", 3200, 4, 0.7)   # removed REMOVED_DAYS_AGO
REMOVED_DAYS_AGO = 20


def daily_demand(rng, dates, base, shift, listed_idx, stop_idx=None):
    n = len(dates)
    idx = np.arange(n)
    level = np.full(n, base, dtype=float)
    if shift:
        days_ago, ramp, mult = shift
        start = n - days_ago
        level *= np.interp(idx, [start, start + ramp], [1.0, mult])
    weekend = np.array([1.15 if d.weekday() >= 5 else 1.0 for d in dates])
    payday = np.array([1.3 if is_payday(d) else 1.0 for d in dates])
    units = rng.poisson(level * weekend * payday)
    units[:listed_idx] = 0
    if stop_idx is not None:
        units[stop_idx:] = 0
    return units


def order_status(rng, days_ago):
    # Pending orders don't count as sales: keep them to a small share of yesterday,
    # or they read as a fake demand drop at the end of the series.
    r = rng.random()
    if days_ago <= 1:
        return "pending" if r < 0.1 else "processing"
    if days_ago <= 7:
        return "cancelled" if r < 0.05 else ("processing" if r < 0.5 else "completed")
    return "cancelled" if r < 0.05 else ("processing" if r < 0.07 else "completed")


def build(database: str, days: int = 150, seed_value: int = 2026) -> None:
    """Drop and recreate `database` with the fixture data."""
    if not database.endswith("_test"):
        raise ValueError(f"refusing to build '{database}': test fixtures only go into a database ending in _test")

    s = config.load()
    rng = np.random.default_rng(seed_value)
    conn = pymysql.connect(host=s.db_host, port=s.db_port, user=s.db_user, password=s.db_password,
                           charset="utf8mb4", autocommit=True)
    with conn.cursor() as cur:
        cur.execute(f"DROP DATABASE IF EXISTS `{database}`")
        cur.execute(f"CREATE DATABASE `{database}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
        cur.execute(f"USE `{database}`")
        cur.execute("SELECT CURDATE()")
        today = cur.fetchone()[0]
    sqlscript.run_file(conn, SCHEMA)
    for migration in MIGRATIONS:
        sqlscript.run_file(conn, migration)

    start = today - dt.timedelta(days=days)
    dates = [start + dt.timedelta(days=i) for i in range(days)]   # up to yesterday
    created = dt.datetime.combine(start - dt.timedelta(days=10), dt.time(9, 0))

    with conn.cursor() as cur:
        cur.executemany("INSERT INTO categories (category_id, name) VALUES (%s, %s)", CATEGORIES)
        # user 1 is the admin the triggers' changed_by / products.created_by point at.
        cur.execute("INSERT INTO users (user_id, username, email, password_hash, role) VALUES (1, %s, %s, %s, 'admin')",
                    ("fixture_admin", "fixture_admin@bongalink.invalid", NO_LOGIN))
        customers = list(range(2, 42))
        cur.executemany("INSERT INTO users (user_id, username, email, password_hash, role) VALUES (%s, %s, %s, %s, 'user')",
                        [(u, f"customer{u:02d}", f"customer{u:02d}@bongalink.invalid", NO_LOGIN) for u in customers])

        product_rows, demand = [], {}
        all_products = PRODUCTS + [(*REMOVED, None, None)]
        for pid, (name, cat, brand, price, stock, base, listed_ago, shift) in enumerate(all_products, start=1):
            listed_at = (dt.datetime.combine(today - dt.timedelta(days=listed_ago), dt.time(10, 0))
                         if listed_ago else created)
            listed_idx = max((listed_at.date() - start).days, 0)
            stop_idx = days - REMOVED_DAYS_AGO if name == REMOVED[0] else None
            demand[pid] = (price, daily_demand(rng, dates, base, shift, listed_idx, stop_idx))
            product_rows.append((pid, name, cat, brand, price, stock, f"{brand} {name} (test fixture)", listed_at))
        cur.executemany(
            """INSERT INTO products (product_id, name, category_id, brand, price, stock_quantity, description,
                                     created_by, created_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, 1, %s)""",
            product_rows,
        )
        # Same soft delete the API uses, so a REMOVED event is logged.
        cur.execute("UPDATE products SET is_active = 0 WHERE name = %s", (REMOVED[0],))

        orders, items, oid = [], [], 1
        for i, day in enumerate(dates):
            days_ago = (today - day).days
            for pid, (price, units) in demand.items():
                left = int(units[i])
                while left > 0:
                    q = min(left, int(rng.choice([1, 1, 1, 1, 2, 2, 3])))
                    left -= q
                    when = dt.datetime.combine(day, dt.time(int(rng.integers(8, 22)), int(rng.integers(0, 60))))
                    user = int(rng.choice(customers))
                    fee = 120
                    orders.append((oid, user, f"customer{user:02d}@bongalink.invalid", order_status(rng, days_ago),
                                   price * q + fee, "GCASH" if rng.random() < 0.6 else "BANK_TRANSFER", fee, when))
                    items.append((oid, pid, q, price))
                    oid += 1
        cur.executemany(
            """INSERT INTO orders (order_id, user_id, contact_email, status, total_amount, payment_method,
                                   shipping_fee, created_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
            orders,
        )
        cur.executemany("INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (%s, %s, %s, %s)",
                        items)
    conn.close()
