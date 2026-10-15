"""Integration tests against a throwaway MySQL database (bongalink_worker_test).

Needs the MySQL server from ml/worker/.env; skipped if it can't be reached.
The database is recreated from the real schema + migrations 003-010 and the synthetic
data in tests/fixture_data.py, so these exercise the actual triggers, not a mock of them.
"""
import dataclasses
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

WORKER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKER))

from bongalink_ml import config, db, training  # noqa: E402
from bongalink_ml.worker import Worker  # noqa: E402

TEST_DB = "bongalink_worker_test"


def setUpModule():
    global SETTINGS, TMP
    import pymysql
    from tests import fixture_data
    try:
        fixture_data.build(TEST_DB, days=150)
    except pymysql.err.OperationalError as e:  # server down / wrong credentials
        raise unittest.SkipTest(f"MySQL not available for integration tests: {e}")
    TMP = tempfile.TemporaryDirectory()
    SETTINGS = dataclasses.replace(config.load(), db_name=TEST_DB, quiet_seconds=1, max_wait_seconds=30,
                                   models_dir=Path(TMP.name))


def tearDownModule():
    try:
        conn = db.connect(dataclasses.replace(SETTINGS, db_name="mysql"))
        with conn.cursor() as cur:
            cur.execute(f"DROP DATABASE IF EXISTS `{TEST_DB}`")
        TMP.cleanup()
    except NameError:
        pass


class WorkerFlow(unittest.TestCase):
    """Tests run in order (unittest sorts by name): t1_, t2_, ..."""

    @classmethod
    def setUpClass(cls):
        cls.worker = Worker(SETTINGS)
        cls.conn = cls.worker.conn
        cls.worker.process_events(force=True)          # the seed's ADDED/REMOVED events

    def q(self, sql, params=()):
        with self.conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()

    def as_admin(self, sql, params=()):
        """What the Node routes do: tag the change with @app_user_id, then run it."""
        with self.conn.cursor() as cur:
            cur.execute("SET @app_user_id = 1")
            cur.execute(sql, params)
            cur.execute("SET @app_user_id = NULL")

    def prediction(self, pid):
        rows = self.q("SELECT * FROM ml_predictions WHERE product_id = %s", (pid,))
        return rows[0] if rows else None

    def pending(self):
        return self.q("SELECT COUNT(*) AS n FROM ml_events WHERE processed = 0")[0]["n"]

    # ------------------------------------------------------------------
    def test_t1_initial_state(self):
        active = self.q("SELECT COUNT(*) AS n FROM products WHERE is_active = 1")[0]["n"]
        self.assertEqual(self.q("SELECT COUNT(*) AS n FROM ml_predictions")[0]["n"], active)
        self.assertEqual(self.pending(), 0)
        removed = self.q("SELECT product_id FROM products WHERE is_active = 0")[0]["product_id"]
        self.assertIsNone(self.prediction(removed))
        dock = self.q("SELECT product_id FROM products WHERE name = 'Ugreen USB-C Dock'")[0]["product_id"]
        self.assertEqual(self.prediction(dock)["data_status"], "insufficient_data")
        self.assertEqual(self.prediction(dock)["forecast_source"], "category_average")
        printhead = self.q("SELECT product_id FROM products WHERE name = 'Epson L3110 Printhead'")[0]["product_id"]
        self.assertEqual(self.prediction(printhead)["trend_direction"], "upward")
        hdd = self.q("SELECT product_id FROM products WHERE name = 'Seagate 1TB HDD'")[0]["product_id"]
        self.assertEqual(self.prediction(hdd)["trend_direction"], "downward")

    def test_t2_add_product(self):
        self.as_admin("""INSERT INTO products (name, category_id, brand, price, stock_quantity, created_by)
                         VALUES ('Test Fuser Unit', 1, 'Test', 999, 7, 1)""")
        pid = self.q("SELECT LAST_INSERT_ID() AS id")[0]["id"]
        ev = self.q("SELECT event_type, new_value, changed_by FROM ml_events WHERE product_id = %s", (pid,))
        self.assertEqual([(e["event_type"], int(e["new_value"]), e["changed_by"]) for e in ev], [("ADDED", 7, 1)])
        self.assertTrue(self.worker.process_events(force=True))
        p = self.prediction(pid)
        self.assertEqual((p["data_status"], p["forecast_source"], p["trend_status"]),
                         ("insufficient_data", "category_average", "insufficient_data"))
        self.assertEqual(self.pending(), 0)
        type(self).new_pid = pid

    def test_t3_stock_change_is_inference_only(self):
        pid = self.q("SELECT product_id FROM products WHERE name = 'Kingston 256GB SSD'")[0]["product_id"]
        before = self.prediction(pid)
        versions_before = self.q("SELECT COUNT(*) AS n FROM ml_model_versions")[0]["n"]
        self.as_admin("UPDATE products SET stock_quantity = 2 WHERE product_id = %s", (pid,))
        ev = self.q("SELECT event_type, old_value, new_value FROM ml_events WHERE product_id = %s "
                    "ORDER BY event_id DESC LIMIT 1", (pid,))[0]
        self.assertEqual((ev["event_type"], int(ev["new_value"])), ("STOCK_CHANGED", 2))
        self.assertTrue(self.worker.process_events(force=True))
        after = self.prediction(pid)
        self.assertEqual(after["current_stock"], 2)
        self.assertEqual(after["predicted_demand_7d"], before["predicted_demand_7d"])   # demand unchanged
        self.assertLess(after["days_until_stockout"], before["days_until_stockout"])
        self.assertTrue(after["reorder_recommended"])
        self.assertEqual(after["model_version"], before["model_version"])
        self.assertEqual(self.q("SELECT COUNT(*) AS n FROM ml_model_versions")[0]["n"], versions_before)

    def test_t4_price_change_is_logged(self):
        pid = self.q("SELECT product_id FROM products WHERE name = 'HDMI Cable 2m'")[0]["product_id"]
        self.as_admin("UPDATE products SET price = 250 WHERE product_id = %s", (pid,))
        ev = self.q("SELECT event_type, old_value, new_value FROM ml_events WHERE product_id = %s "
                    "ORDER BY event_id DESC LIMIT 1", (pid,))[0]
        self.assertEqual((ev["event_type"], float(ev["old_value"]), float(ev["new_value"])),
                         ("PRICE_CHANGED", 220.0, 250.0))
        self.worker.process_events(force=True)

    def test_t5_remove_product_soft_delete(self):
        pid = self.q("SELECT product_id FROM products WHERE name = 'Canon Pickup Roller'")[0]["product_id"]
        sold_before = db.lifetime_units(self.conn, [pid])[pid]
        self.as_admin("UPDATE products SET is_active = 0 WHERE product_id = %s", (pid,))
        self.assertTrue(self.worker.process_events(force=True))
        self.assertIsNone(self.prediction(pid))                                  # gone from predictions
        self.assertEqual(db.lifetime_units(self.conn, [pid])[pid], sold_before)  # history intact
        ev = self.q("SELECT event_type FROM ml_events WHERE product_id = %s ORDER BY event_id DESC LIMIT 1", (pid,))
        self.assertEqual(ev[0]["event_type"], "REMOVED")

    def test_t6_debounce_twenty_edits_one_update(self):
        pid = self.q("SELECT product_id FROM products WHERE name = 'Logitech USB Mouse'")[0]["product_id"]
        for stock in range(40, 60):
            self.as_admin("UPDATE products SET stock_quantity = %s WHERE product_id = %s", (stock, pid))
        self.assertEqual(self.pending(), 20)
        self.assertFalse(self.worker.process_events())        # edits just happened: still settling
        self.assertEqual(db.get_status(self.conn)["state"], "updating")
        time.sleep(SETTINGS.quiet_seconds + 0.3)
        with self.assertLogs("bongalink_ml.worker", "INFO") as logs:
            self.assertTrue(self.worker.process_events())
        self.assertEqual(self.pending(), 0)
        self.assertEqual(len([m for m in logs.output if "predictions refreshed" in m]), 1)
        self.assertIn("20 events", logs.output[0])
        self.assertEqual(self.prediction(pid)["current_stock"], 59)
        self.assertEqual(db.get_status(self.conn)["state"], "up_to_date")

    def test_t7_rolled_back_change_leaves_no_event(self):
        before = self.q("SELECT COUNT(*) AS n FROM ml_events")[0]["n"]
        self.conn.begin()
        with self.conn.cursor() as cur:
            cur.execute("UPDATE products SET stock_quantity = stock_quantity + 5 WHERE product_id = 2")
        self.conn.rollback()
        self.assertEqual(self.q("SELECT COUNT(*) AS n FROM ml_events")[0]["n"], before)

    def test_t8_failed_retrain_keeps_active_model(self):
        active = db.active_model_version(self.conn)["version"]
        with mock.patch.object(training, "train_model", side_effect=RuntimeError("simulated crash")):
            result = self.worker.maybe_retrain(force=True)
        self.assertEqual(result.status, "failed")
        self.assertEqual(db.active_model_version(self.conn)["version"], active)
        self.assertEqual(self.worker.model_version, active)
        st = db.get_status(self.conn)
        self.assertEqual(st["last_train_status"], "failed")
        self.assertIn("simulated crash", st["last_train_message"])
        failed = self.q("SELECT status FROM ml_model_versions ORDER BY version_id DESC LIMIT 1")[0]
        self.assertEqual(failed["status"], "failed")
        run = self.q("SELECT * FROM ml_training_runs ORDER BY run_id DESC LIMIT 1")[0]
        self.assertEqual((run["trigger_type"], run["status"], run["outcome"], run["active_slot"]),
                         ("command_line", "failed", "failed", None))
        self.assertIn("simulated crash", run["message"])
        # The predictions still come from the model in use.
        self.assertEqual({r["model_version"] for r in self.q("SELECT DISTINCT model_version FROM ml_predictions")}, {active})

    def test_t9_worse_model_is_rejected(self):
        active = db.active_model_version(self.conn)["version"]
        real_train = training.train_model

        def sabotaged(ds, trainer):
            spec = real_train(ds, "auto")
            spec["bias"] += 50.0          # deliberately terrible
            return spec

        with mock.patch.object(training, "train_model", side_effect=sabotaged):
            result = self.worker.maybe_retrain(force=True)
        self.assertEqual(result.status, "rejected")
        self.assertEqual(db.active_model_version(self.conn)["version"], active)
        row = self.q("SELECT val_mae, baseline_val_mae, status FROM ml_model_versions "
                     "ORDER BY version_id DESC LIMIT 1")[0]
        self.assertEqual(row["status"], "rejected")
        self.assertGreater(row["val_mae"], row["baseline_val_mae"])


    # ------------------------------------------------------------------ training runs (REQ028)
    def queue_run(self, admin="owner"):
        """What POST /api/admin/ml/training does."""
        with self.conn.cursor() as cur:
            cur.execute("""INSERT INTO ml_training_runs (trigger_type, trigger_detail, requested_by, requested_by_label)
                           VALUES ('manual', 'Update forecasts & trends button', 1, %s)""", (admin,))
            return cur.lastrowid

    def test_u1_queued_run_is_trained_and_recorded(self):
        run_id = self.queue_run()
        result = self.worker.maybe_retrain()
        self.assertIn(result.status, ("promoted", "rejected"))
        run = self.q("SELECT * FROM ml_training_runs WHERE run_id = %s", (run_id,))[0]
        self.assertEqual((run["status"], run["outcome"], run["requested_by_label"]), ("done", result.status, "owner"))
        self.assertIsNotNone(run["started_at"])
        self.assertIsNotNone(run["finished_at"])
        self.assertGreater(run["sales_records"], 1000)
        self.assertGreater(run["orders_used"], 500)
        self.assertGreater(run["products_used"], 5)
        self.assertGreater(run["train_rows"], 0)
        self.assertIsNotNone(run["val_mae"])
        self.assertIsNotNone(run["naive_val_mae"])
        self.assertEqual(run["model_version"], result.version)
        # Nothing left to do afterwards.
        self.assertIsNone(self.worker.maybe_retrain())

    def test_u2_only_one_run_at_a_time(self):
        import pymysql
        run_id = self.queue_run()
        with self.assertRaises(pymysql.err.IntegrityError):    # the database refuses a second queued run
            self.queue_run("someone-else")
        self.assertIsNone(db.start_run(self.conn, "nightly", "nightly retraining"))   # and an automatic one
        with self.conn.cursor() as cur:
            cur.execute("UPDATE ml_training_runs SET status = 'training' WHERE run_id = %s", (run_id,))
        self.assertIsNone(db.claim_queued_run(self.conn))
        self.assertIsNone(db.start_run(self.conn, "new_data", "x"))
        # A worker restart finds the stuck run and marks it failed, freeing the slot.
        Worker(SETTINGS, conn=self.conn)
        run = self.q("SELECT status, outcome, message FROM ml_training_runs WHERE run_id = %s", (run_id,))[0]
        self.assertEqual((run["status"], run["outcome"]), ("failed", "failed"))
        self.assertIn("stopped during training", run["message"])
        self.assertIsNotNone(db.start_run(self.conn, "command_line", "x"))
        with self.conn.cursor() as cur:
            cur.execute("UPDATE ml_training_runs SET status = 'done' WHERE status = 'training'")

    def test_u3_automatic_triggers_fire_at_the_threshold(self):
        w = self.worker
        original = w.s
        try:
            w.s = dataclasses.replace(original, retrain_hour=None, retrain_new_orders=3, retrain_stock_changes=4)
            # Just trained: nothing is due.
            with self.conn.cursor() as cur:
                cur.execute("""UPDATE ml_status SET last_train_at = NOW(),
                               sold_orders_at_last_train = (SELECT COUNT(*) FROM orders
                                 WHERE status IN ('processing','completed','paid','packed','shipped','delivered')),
                               event_id_at_last_train = (SELECT COALESCE(MAX(event_id), 0) FROM ml_events) WHERE id = 1""")
            self.assertIsNone(w.auto_retrain_reason())

            def paid_order():
                with self.conn.cursor() as cur:
                    cur.execute("INSERT INTO orders (user_id, status, total_amount) VALUES (2, 'paid', 100)")
            paid_order(); paid_order()
            self.assertIsNone(w.auto_retrain_reason())                       # 2 of 3
            paid_order()
            self.assertEqual(w.auto_retrain_reason(), ("new_data", "3 new paid orders since the last training"))

            w.s = dataclasses.replace(w.s, retrain_new_orders=None)          # orders trigger off
            pid = self.q("SELECT product_id FROM products WHERE name = 'Logitech USB Mouse'")[0]["product_id"]
            for stock in (70, 71, 72):
                self.as_admin("UPDATE products SET stock_quantity = %s WHERE product_id = %s", (stock, pid))
            self.assertIsNone(w.auto_retrain_reason())                       # 3 of 4
            self.as_admin("UPDATE products SET stock_quantity = 73 WHERE product_id = %s", (pid,))
            self.assertEqual(w.auto_retrain_reason(), ("new_data", "4 stock changes since the last training"))

            w.s = dataclasses.replace(w.s, retrain_stock_changes=None, retrain_hour=0)
            self.assertIsNone(w.auto_retrain_reason())                       # already trained today
            with self.conn.cursor() as cur:
                cur.execute("UPDATE ml_status SET last_train_at = NOW() - INTERVAL 1 DAY WHERE id = 1")
            self.assertEqual(w.auto_retrain_reason(), ("nightly", "nightly retraining (after 00:00)"))

            # When it fires, the run is recorded with its trigger, and the counters move on.
            w.s = dataclasses.replace(w.s, retrain_hour=None, retrain_new_orders=3)
            paid_order(); paid_order(); paid_order()
            with mock.patch.object(training, "train_model", side_effect=RuntimeError("simulated crash")):
                result = w.maybe_retrain()
            self.assertEqual(result.status, "failed")
            run = self.q("SELECT trigger_type, trigger_detail, status FROM ml_training_runs ORDER BY run_id DESC LIMIT 1")[0]
            self.assertEqual((run["trigger_type"], run["status"]), ("new_data", "failed"))
            self.assertIn("new paid orders", run["trigger_detail"])
            self.assertIsNone(w.auto_retrain_reason())                       # counted from this run on
        finally:
            w.s = original

    def test_u4_settings_are_published_for_the_admin_page(self):
        st = db.get_status(self.conn)
        self.assertEqual((st["auto_retrain_hour"], st["auto_retrain_orders"], st["auto_retrain_stock_changes"]),
                         (SETTINGS.retrain_hour, SETTINGS.retrain_new_orders, SETTINGS.retrain_stock_changes))


if __name__ == "__main__":
    unittest.main()
