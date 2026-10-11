"""End-to-end demo: product changes through the real Node API -> triggers ->
ml_events -> worker -> ml_predictions (what the admin dashboard reads).

Prerequisites (see ml/worker/README.md):
  1. python seed_demo.py                                    (creates bongalink_test)
  2. Node API pointed at it:  DB_NAME=bongalink_test npm start   (in Backend/)
  3. optional: the worker running (python -m bongalink_ml) + --external-worker

    python demo.py                    # runs the worker in-process, step by step
    python demo.py --external-worker  # waits for an already-running worker instead

Steps: add a product, change stock, change price, remove a product, then 20
rapid stock edits that the debounce folds into ONE prediction update.
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import logging
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bongalink_ml import config, db  # noqa: E402

API = "http://localhost:4000/api"


# ---------------------------------------------------------------- HTTP helpers
def call(method, path, token=None, body=None, form=None):
    headers = {}
    data = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if form is not None:   # multipart/form-data, like the "List a Product" form
        boundary = uuid.uuid4().hex
        parts = [f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n' for k, v in form.items()]
        data = ("".join(parts) + f"--{boundary}--\r\n").encode()
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    req = urllib.request.Request(API + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {path} -> HTTP {e.code}: {e.read().decode()}")
    except urllib.error.URLError as e:
        raise SystemExit(f"Cannot reach the API at {API} ({e.reason}). Start it with DB_NAME=bongalink_test "
                         "(see ml/worker/README.md).")


# ---------------------------------------------------------------- display
def banner(text):
    print(f"\n{'=' * 78}\n{text}\n{'=' * 78}")


def show_predictions(conn, highlight=()):
    with conn.cursor() as cur:
        cur.execute("""SELECT p.product_id, p.name, p.stock_quantity, mp.predicted_demand_7d, mp.days_until_stockout,
                              mp.reorder_recommended, mp.data_status, mp.forecast_source, mp.trend_direction,
                              mp.model_version
                       FROM products p LEFT JOIN ml_predictions mp ON mp.product_id = p.product_id
                       WHERE p.is_active = 1 ORDER BY p.product_id""")
        rows = cur.fetchall()
    print(f"  {'id':>3} {'product':<27} {'stock':>5} {'7d fcst':>8} {'days':>6} {'reorder':>7}  {'data':<18} trend")
    for r in rows:
        mark = "->" if r["product_id"] in highlight else "  "
        f = "-" if r["predicted_demand_7d"] is None else f"{float(r['predicted_demand_7d']):.1f}"
        d = "-" if r["days_until_stockout"] is None else f"{float(r['days_until_stockout']):.1f}"
        data = "ok" if r["data_status"] == "ok" else f"INSUFFICIENT ({r['forecast_source'].split('_')[0]})"
        print(f"{mark}{r['product_id']:>3} {r['name'][:27]:<27} {r['stock_quantity']:>5} {f:>8} {d:>6} "
              f"{'YES' if r['reorder_recommended'] else '':>7}  {data:<18} {r['trend_direction'] or 'n/a'}")
    st = db.get_status(conn)
    print(f"  status: {st['state']}, last model update {st['last_update_at']}")


def latest_events(conn, n):
    with conn.cursor() as cur:
        cur.execute("""SELECT event_id, product_id, event_type, old_value, new_value, processed, processed_at
                       FROM ml_events ORDER BY event_id DESC LIMIT %s""", (n,))
        return list(reversed(cur.fetchall()))


def print_events(events):
    for e in events:
        print(f"  event #{e['event_id']}: product {e['product_id']} {e['event_type']:<13} "
              f"{e['old_value']} -> {e['new_value']}  processed={e['processed']}")


# ---------------------------------------------------------------- waiting for the worker
class InProcess:
    def __init__(self, settings):
        from bongalink_ml.worker import Worker
        logging.basicConfig(level=logging.INFO, format="  [worker] %(message)s")
        self.worker = Worker(settings)

    def settle(self, conn):
        """Poll exactly like the real loop until the debounce lets a batch through."""
        start = time.time()
        while not self.worker.process_events():
            time.sleep(1)
        print(f"  (worker processed the batch after {time.time() - start:.0f}s of debounce)")


class External:
    def settle(self, conn):
        start = time.time()
        while True:
            conn.ping(reconnect=True)
            pending = db.pending_summary(conn)["n"]
            if pending == 0 and db.get_status(conn)["state"] == "up_to_date":
                break
            if time.time() - start > 120:
                raise SystemExit("worker did not process the events within 2 minutes; is it running?")
            time.sleep(1)
        print(f"  (running worker processed the batch after {time.time() - start:.0f}s)")


def product_id(conn, name):
    with conn.cursor() as cur:
        cur.execute("SELECT product_id FROM products WHERE name = %s AND is_active = 1", (name,))
        row = cur.fetchone()
    if not row:
        raise SystemExit(f"'{name}' not found; re-run seed_demo.py")
    return row["product_id"]


def main() -> int:
    global API
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--external-worker", action="store_true")
    ap.add_argument("--database", default="bongalink_test")
    ap.add_argument("--api", default=API)
    args = ap.parse_args()
    API = args.api.rstrip("/")

    settings = dataclasses.replace(config.load(), db_name=args.database)
    conn = db.connect(settings)
    runner = External() if args.external_worker else InProcess(settings)

    token = call("POST", "/auth/login", body={"username": "demo_admin", "password": "DemoAdmin123!"})["token"]

    banner("0. Starting point (seeded data)")
    if db.pending_summary(conn)["n"]:
        runner.settle(conn)
    show_predictions(conn)

    banner("1. ADD a product through POST /api/products")
    new = call("POST", "/products", token, form={"name": "Brother DR-2455 Drum Unit", "category": "Printer Parts",
                                                  "brand": "Brother", "price": "1850", "stock": "9"})
    pid_new = new["productId"]
    print_events(latest_events(conn, 1))
    runner.settle(conn)
    show_predictions(conn, highlight={pid_new})
    print("  -> new product has no sales yet: shown as INSUFFICIENT DATA with its category average")

    banner("2. CHANGE STOCK through PATCH /api/products/:id  (inference only, no retraining)")
    ssd = product_id(conn, "Kingston 256GB SSD")
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) AS n FROM ml_model_versions")
        versions_before = cur.fetchone()["n"]
    call("PATCH", f"/products/{ssd}", token, body={"stock": 2})
    print_events(latest_events(conn, 1))
    runner.settle(conn)
    show_predictions(conn, highlight={ssd})
    with conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) AS n FROM ml_model_versions")
        print(f"  -> days of stock dropped and reorder flagged; model versions before/after: "
              f"{versions_before}/{cur.fetchone()['n']} (no retraining)")

    banner("3. CHANGE PRICE through PATCH /api/products/:id  (audit trail)")
    hdmi = product_id(conn, "HDMI Cable 2m")
    call("PATCH", f"/products/{hdmi}", token, body={"price": 250})
    print_events(latest_events(conn, 1))
    runner.settle(conn)

    banner("4. REMOVE a product through DELETE /api/products/:id  (soft delete)")
    roller = product_id(conn, "Canon Pickup Roller")
    call("DELETE", f"/products/{roller}", token)
    print_events(latest_events(conn, 1))
    runner.settle(conn)
    show_predictions(conn)
    hist = call("GET", f"/admin/ml/history/{roller}?days=84", token)
    in_catalog = any(p["id"] == roller for p in call("GET", "/products"))
    print(f"  -> gone from predictions and catalog (in catalog: {in_catalog}); history still available: "
          f"{sum(d['units'] for d in hist['series'])} units over 84 days")

    banner("5. DEBOUNCE: 20 rapid stock edits")
    mouse = product_id(conn, "Logitech USB Mouse")
    for stock in range(31, 51):   # ends at 50 (seed starts it at 60)
        call("PATCH", f"/products/{mouse}", token, body={"stock": stock})
    print(f"  sent 20 PATCH requests; pending events: {db.pending_summary(conn)['n']}")
    runner.settle(conn)
    events = latest_events(conn, 20)
    stamps = {str(e["processed_at"]) for e in events}
    print(f"  -> all 20 events processed in {len(stamps)} update(s) (processed_at = {', '.join(sorted(stamps))})")
    show_predictions(conn, highlight={mouse})

    banner("Model versions")
    with conn.cursor() as cur:
        cur.execute("SELECT version, status, trained_with, val_mae, baseline_val_mae FROM ml_model_versions ORDER BY version_id")
        for v in cur.fetchall():
            mae = "" if v["val_mae"] is None else f"  val MAE {v['val_mae']:.3f} vs {v['baseline_val_mae'] or 0:.3f}"
            print(f"  {v['version']:<22} {v['status']:<9} {v['trained_with']}{mae}")
    print("\nOpen Frontend/Pages/Admin/inventory.html (logged in as demo_admin) to see the same data on the dashboard.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
