"""Unit tests, no database. Run from ml/worker:  python -m unittest discover -s tests -v"""
import datetime as dt
import json
import sys
import unittest
from pathlib import Path

import numpy as np

WORKER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKER))

from bongalink_ml import core, predict, training  # noqa: E402

MODELS = WORKER.parent / "backend" / "models"
PARITY = json.loads((MODELS / "parity.json").read_text())


class ParityWithNotebook(unittest.TestCase):
    """Same numbers the Colab notebook exported (and that `cargo test` checks in Rust)."""

    def test_features(self):
        hist = PARITY["history"][-core.WINDOW:]
        f = core.make_features(hist, dt.date.fromisoformat(PARITY["target_start"]))
        np.testing.assert_allclose(f, PARITY["features"], atol=1e-9)

    def test_predicted_demand(self):
        model = core.StockModel.from_file(MODELS / "stock_lr.json")
        pred = model.predict_demand(PARITY["history"][-core.WINDOW:], dt.date.fromisoformat(PARITY["target_start"]))
        self.assertAlmostEqual(pred, PARITY["predicted_demand_7d"], delta=1e-9)

    def test_trend(self):
        cfg = core.TrendConfig.from_file(MODELS / "trend_config.json")
        t = cfg.detect(PARITY["history"])
        exp = PARITY["trend"]
        self.assertEqual(t["breakpoint_index"], exp["breakpoint_index"])
        for k in ("slope_before", "slope_after", "relative_change"):
            self.assertAlmostEqual(t[k], exp[k], delta=1e-9)
        self.assertEqual(t["shift_detected"], exp["shift_detected"])


class Outlook(unittest.TestCase):
    def test_paydays(self):
        self.assertTrue(core.is_payday(dt.date(2026, 10, 15)))
        self.assertTrue(core.is_payday(dt.date(2026, 2, 27)))   # Feb 2026 has 28 days
        self.assertFalse(core.is_payday(dt.date(2026, 10, 20)))

    def test_out_of_stock_always_reorders(self):
        o = core.stock_outlook(21.0, 0)
        self.assertTrue(o["reorder_recommended"])
        self.assertEqual(o["suggested_reorder_qty"], 42)          # 3/day x 14 days cover

    def test_stockout_and_rounding_match_rust(self):
        o = core.stock_outlook(7.0, 5)                             # 1/day, 5 units -> 5.0 days
        self.assertEqual(o["days_until_stockout"], 5.0)
        self.assertTrue(o["reorder_recommended"])                  # < 7 days left
        self.assertEqual(core._round_half_up(2.25, 1), 2.3)        # Python round() would give 2.2

    def test_estimate_never_triggers_reorder_by_itself(self):
        o = core.stock_outlook(70.0, 5, allow_reorder=False)
        self.assertEqual(o["days_until_stockout"], 0.5)
        self.assertFalse(o["reorder_recommended"])


class ColdStart(unittest.TestCase):
    def _row(self, pid, cat, demand=None, stock=10):
        r = {"product_id": pid, "_category_id": cat, "current_stock": stock}
        if demand is None:
            r["data_status"] = "insufficient_data"
        else:
            r.update(core.stock_outlook(demand, stock), data_status="ok", forecast_source="model")
        return r

    def test_category_then_store_average(self):
        rows = [self._row(1, 1, 10.0), self._row(2, 1, 20.0), self._row(3, 2, 40.0),
                self._row(4, 1), self._row(5, 9)]
        predict._fill_cold_start(rows)
        new_in_cat1, new_in_empty_cat = rows[3], rows[4]
        self.assertEqual(new_in_cat1["forecast_source"], "category_average")
        self.assertEqual(new_in_cat1["predicted_demand_7d"], 15.0)
        self.assertEqual(new_in_empty_cat["forecast_source"], "store_average")
        self.assertAlmostEqual(new_in_empty_cat["predicted_demand_7d"], 23.33, places=2)
        self.assertEqual(new_in_cat1["data_status"], "insufficient_data")

    def test_no_data_anywhere(self):
        rows = [self._row(1, 1, stock=0)]
        predict._fill_cold_start(rows)
        self.assertEqual(rows[0]["forecast_source"], "none")
        self.assertIsNone(rows[0]["predicted_demand_7d"])
        self.assertTrue(rows[0]["reorder_recommended"])            # empty shelf still flagged


class Dataset(unittest.TestCase):
    def _dates(self, n):
        return [dt.date(2026, 1, 1) + dt.timedelta(days=i) for i in range(n)]

    def test_too_little_history_is_skipped(self):
        with self.assertRaises(training.InsufficientData):
            training.build_dataset({1: np.ones(100)}, {1: 0}, self._dates(100))

    def test_windows_before_listing_are_ignored(self):
        n = 200
        dates = self._dates(n)
        full = training.build_dataset({1: np.ones(n), 2: np.ones(n)}, {1: 0, 2: 0}, dates)
        late = training.build_dataset({1: np.ones(n), 2: np.ones(n)}, {1: 0, 2: 100}, dates)
        self.assertEqual(len(full.X_train) - len(late.X_train), 100)


if __name__ == "__main__":
    unittest.main()
