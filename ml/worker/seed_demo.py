"""Build a demo database (bongalink_test by default) with ~150 days of realistic orders.

    python seed_demo.py                 # drops and recreates bongalink_test
    python seed_demo.py --days 180

What it creates, so every dashboard state shows up during the demo:
  * the real schema (Backend/database/bongalink_schema.sql) + migrations/003_ml_sync.sql
  * an admin account   demo_admin / DemoAdmin123!   and 40 customers (password DemoCustomer123!)
  * 15 active products across 5 categories with daily sales shaped like the Colab
    simulator: weekend bumps, payday spikes (1st, 14th-16th, end of month), noise;
      - "Epson L3110 Printhead"  flat, then demand starts climbing ~40 days ago   -> UPWARD trend shift
      - "Seagate 1TB HDD"        flat, then demand starts falling ~40 days ago    -> DOWNWARD trend shift
        (the trend model detects a change in slope, so the seed changes the slope, not just the level)
      - "Ugreen USB-C Dock"      listed 6 days ago   -> insufficient data (category average)
      - "Arctic MX-4 Thermal Paste" listed 3 days ago, no sales -> insufficient data
      - a few products with low stock -> reorder recommended
  * one product removed 20 days ago (soft delete) that still has sales history
  * orders mostly 'completed', some 'processing', 'pending' and 'cancelled'

It refuses to touch any database whose name does not end in "_test".
Credentials come from ml/worker/.env (DB_HOST, DB_USER, DB_PASSWORD, ...).
"""
from __future__ import annotations

import argparse
import datetime as dt
import sys
from pathlib import Path

import numpy as np
import pymysql

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bongalink_ml import config, sqlscript  # noqa: E402
from bongalink_ml.core import is_payday     # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
SCHEMA = ROOT / "Backend" / "database" / "bongalink_schema.sql"
MIGRATION = ROOT / "Backend" / "database" / "migrations" / "003_ml_sync.sql"

ADMIN_HASH = "$2a$10$ebMSCsQT9yuaOFoeNm574.cvxtDjbuHUHq/sX2hUw/XWqG3pfOfBS"     # DemoAdmin123!
CUSTOMER_HASH = "$2a$10$wWHv2Mq7mUMMkDUjKdrY2u.nLLqqHL4MxQdd.lyJMI51SmnIDF2n2"  # DemoCustomer123!

CATEGORIES = [(1, "Printer Parts"), (2, "Computer Parts"), (3, "Laptop Parts"),
              (4, "Accessories"), (5, "Electronics"), (6, "Other")]

# name, category_id, brand, price, stock, base units/day, listed days ago (None = start of history),
# shift = (days ago it starts, ramp days, multiplier) or None
PRODUCTS = [
    ("Epson L3110 Printhead",      1, "Epson",    2850, 6,  1.2, None, (40, 40, 3.5)),
    ("Epson Waste Ink Pad",        1, "Epson",     450, 40, 2.5, None, None),
    ("Canon Pickup Roller",        1, "Canon",     380, 25, 1.8, None, None),
    ("CISS Ink Tank Kit",          1, "Generic",  1200, 12, 1.0, None, None),
    ("Kingston 8GB DDR4 RAM",      2, "Kingston", 1650, 30, 2.2, None, None),
    ("Kingston 256GB SSD",         2, "Kingston", 1890, 18, 2.6, None, None),
    ("Seagate 1TB HDD",            2, "Seagate",  2450, 35, 3.0, None, (40, 40, 0.3)),
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
    # Pending (unconfirmed bank transfer) orders don't count as sales, so keep them to a
    # small share of yesterday; a large share would read as a fake demand drop at the end.
    r = rng.random()
    if days_ago <= 1:
        return "pending" if r < 0.1 else "processing"
    if days_ago <= 7:
        return "cancelled" if r < 0.05 else ("processing" if r < 0.5 else "completed")
    return "cancelled" if r < 0.05 else ("processing" if r < 0.07 else "completed")


def seed(database: str = "bongalink_test", days: int = 150, seed_value: int = 2026, quiet: bool = False) -> None:
    if not database.endswith("_test"):
        raise SystemExit(f"refusing to seed '{database}': demo data only goes into a database ending in _test")
    say = (lambda *a: None) if quiet else print

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
    sqlscript.run_file(conn, MIGRATION)
    say(f"created {database}: schema + 003_ml_sync")

    start = today - dt.timedelta(days=days)
    dates = [start + dt.timedelta(days=i) for i in range(days)]   # up to yesterday
    created = dt.datetime.combine(start - dt.timedelta(days=10), dt.time(9, 0))

    with conn.cursor() as cur:
        cur.executemany("INSERT INTO categories (category_id, name) VALUES (%s, %s)", CATEGORIES)
        cur.execute("INSERT INTO users (user_id, username, email, password_hash, role) VALUES (1, %s, %s, %s, 'admin')",
                    ("demo_admin", "demo_admin@bongalink.test", ADMIN_HASH))
        customers = list(range(2, 42))
        cur.executemany("INSERT INTO users (user_id, username, email, password_hash, role) VALUES (%s, %s, %s, %s, 'user')",
                        [(u, f"customer{u:02d}", f"customer{u:02d}@bongalink.test", CUSTOMER_HASH) for u in customers])

        product_rows, demand = [], {}
        all_products = PRODUCTS + [(*REMOVED, None, None)]
        for pid, (name, cat, brand, price, stock, base, listed_ago, shift) in enumerate(all_products, start=1):
            listed_at = (dt.datetime.combine(today - dt.timedelta(days=listed_ago), dt.time(10, 0))
                         if listed_ago else created)
            listed_idx = max((listed_at.date() - start).days, 0)
            stop_idx = days - REMOVED_DAYS_AGO if name == REMOVED[0] else None
            demand[pid] = (price, daily_demand(rng, dates, base, shift, listed_idx, stop_idx))
            product_rows.append((pid, name, cat, brand, price, stock, f"{brand} {name} (demo data)", listed_at))
        cur.executemany(
            """INSERT INTO products (product_id, name, category_id, brand, price, stock_quantity, description,
                                     created_by, created_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, 1, %s)""",
            product_rows,
        )
        # The removed product goes through the same soft delete the API uses (logs a REMOVED event).
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
                    orders.append((oid, user, f"customer{user:02d}@bongalink.test", order_status(rng, days_ago),
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
        cur.execute("""SELECT status, COUNT(*) FROM orders GROUP BY status ORDER BY status""")
        by_status = ", ".join(f"{n} {st}" for st, n in cur.fetchall())

    conn.close()
    say(f"seeded {len(all_products)} products ({len(PRODUCTS)} active, 1 removed), 41 users, "
        f"{len(orders)} orders / {sum(i[2] for i in items)} units from {dates[0]} to {dates[-1]}")
    say(f"orders by status: {by_status}")
    say("admin login: demo_admin / DemoAdmin123!")
    say(f"next: set DB_NAME={database} and start the worker (python -m bongalink_ml)")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--database", default="bongalink_test")
    ap.add_argument("--days", type=int, default=150,
                    help="days of order history (150 default; 365 gives enough data for a retrained "
                         "model to beat the Colab model and get promoted)")
    ap.add_argument("--seed", type=int, default=2026)
    args = ap.parse_args()
    seed(args.database, args.days, args.seed)
    return 0


if __name__ == "__main__":
    sys.exit(main())
