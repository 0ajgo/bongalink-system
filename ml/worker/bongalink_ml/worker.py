"""Background worker: keeps ml_predictions in step with the product catalog.

Every poll (ML_POLL_SECONDS):
  1. heartbeat, so the dashboard can tell the worker is alive;
  2. if ml_events has unprocessed rows, wait until no new event has arrived for
     ML_QUIET_SECONDS (or the oldest one is ML_MAX_WAIT_SECONDS old), then run one
     inference pass for the whole batch, so 20 quick edits = 1 update;
  3. otherwise re-score everything every ML_FULL_REFRESH_MINUTES (new orders and
     order-status changes change demand without touching the products table);
  4. retrain (REQ028), recording each run in ml_training_runs:
     - first, a run an admin queued with "Update forecasts & trends";
     - otherwise nightly (ML_RETRAIN_HOUR), or once ML_RETRAIN_NEW_ORDERS new paid orders
       or ML_RETRAIN_STOCK_CHANGES stock changes have arrived since the last training.
     Only one run at a time (the database refuses a second); a failed run keeps the model in use.

The worker only reads products/orders and writes the ml_* tables, so it can
never block the admin's product CRUD.
"""
from __future__ import annotations

import logging
import shutil
import time
from collections import Counter

from . import db, training
from .config import Settings
from .core import StockModel, TrendConfig
from .predict import compute_predictions

log = logging.getLogger("bongalink_ml.worker")

BOOTSTRAP_VERSION = "v0-colab"


class Worker:
    def __init__(self, settings: Settings, conn=None):
        self.s = settings
        self.conn = conn or db.connect(settings)
        self.trend = TrendConfig.from_file(settings.bootstrap_dir / "trend_config.json")
        self.model: StockModel | None = None
        self.model_version: str | None = None
        self.last_full_refresh = 0.0
        self.retry_after = 0.0
        self._ensure_model()
        # A run left "training" means the worker stopped mid-run; say so instead of leaving it stuck.
        if db.fail_interrupted_runs(self.conn):
            log.warning("marked an interrupted training run as failed")
        # Tell the admin page which automatic triggers are on.
        db.set_status(self.conn, auto_retrain_hour=settings.retrain_hour, auto_retrain_orders=settings.retrain_new_orders,
                      auto_retrain_stock_changes=settings.retrain_stock_changes)

    # ------------------------------------------------------------ models
    def _ensure_model(self) -> None:
        """Load the active model; on the very first run, register the Colab export as v0."""
        active = db.active_model_version(self.conn)
        if active is None:
            src = self.s.bootstrap_dir / "stock_lr.json"
            file_name = f"stock_lr_{BOOTSTRAP_VERSION}.json"
            dest = self.s.models_dir / "versions" / file_name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dest)
            spec = StockModel.from_file(dest).spec
            db.record_model_version(
                self.conn, version=BOOTSTRAP_VERSION, file_path=file_name,
                trained_with=f"{spec.get('trained_with', 'unknown')} (Colab export)",
                data_source=spec.get("data_source", "unknown"), status="active",
                notes="Initial model copied from ml/backend/models/stock_lr.json",
            )
            log.info("registered bootstrap model %s from %s", BOOTSTRAP_VERSION, src)
            active = db.active_model_version(self.conn)
        self._load(active)

    def _load(self, row: dict) -> None:
        path = self.s.models_dir / "versions" / row["file_path"]
        if not path.exists():
            # e.g. the database moved to another machine without the models folder
            log.error("active model file %s is missing; using the Colab export until the next retrain", path)
            path = self.s.bootstrap_dir / "stock_lr.json"
        self.model = StockModel.from_file(path)
        self.model_version = row["version"]
        log.info("using model %s [%s]", row["version"], row["trained_with"])

    # ------------------------------------------------------------ inference
    def refresh(self, max_event_id: int | None, reason: str) -> bool:
        """One inference pass over all active products. Returns True on success."""
        started = time.monotonic()
        try:
            rows = compute_predictions(self.conn, self.model, self.model_version, self.trend,
                                       self.s.cold_start_days, trend_min_sale_days=self.s.trend_min_sale_days)
            marked = db.write_predictions(self.conn, rows, max_event_id)
            db.set_status(self.conn, state="up_to_date", last_update_at="NOW()", last_error=None)
            self.last_full_refresh = time.monotonic()
            insufficient = sum(r["data_status"] == "insufficient_data" for r in rows)
            log.info("predictions refreshed (%s): %d products, %d insufficient data, %d events processed, %.2fs",
                     reason, len(rows), insufficient, marked, time.monotonic() - started)
            return True
        except Exception as e:
            log.exception("prediction refresh failed (%s); events stay unprocessed and will be retried", reason)
            self.retry_after = time.monotonic() + self.s.retry_seconds
            db.set_status(self.conn, state="failed", last_error=f"{type(e).__name__}: {e}"[:1000])
            return False

    def process_events(self, force: bool = False) -> bool:
        """Debounced handling of ml_events. Returns True if a batch was processed."""
        p = db.pending_summary(self.conn)
        if p["n"] == 0:
            return False
        db.set_status(self.conn, state="updating")
        quiet = p["newest_age"] >= self.s.quiet_seconds
        overdue = p["oldest_age"] >= self.s.max_wait_seconds
        if not (force or quiet or overdue):
            log.debug("%d pending events, waiting for edits to settle", p["n"])
            return False

        events = db.pending_events(self.conn, p["max_id"])
        kinds = Counter(e["event_type"] for e in events)
        # Every event type needs only an inference pass: the model's inputs are per-product
        # features, not the product list, so ADDED/REMOVED just change which rows get scored.
        summary = ", ".join(f"{n} {k}" for k, n in sorted(kinds.items()))
        why = "forced" if force else ("quiet window" if quiet else "max wait reached")
        return self.refresh(p["max_id"], f"{len(events)} events: {summary}; {why}")

    # ------------------------------------------------------------ training
    def auto_retrain_reason(self) -> tuple[str, str] | None:
        """(trigger_type, detail) when an automatic retrain is due, else None."""
        status = db.get_status(self.conn)
        last = status["last_train_at"]
        hour = self.s.retrain_hour
        if hour is not None and time.localtime().tm_hour >= hour and (last is None or last.date() < db.today(self.conn)):
            return "nightly", f"nightly retraining (after {hour:02d}:00)"
        if self.s.retrain_new_orders is not None:
            new_orders = db.sold_orders_total(self.conn) - status["sold_orders_at_last_train"]
            if new_orders >= self.s.retrain_new_orders:
                return "new_data", f"{new_orders} new paid orders since the last training"
        if self.s.retrain_stock_changes is not None:
            changes = db.stock_changes_since(self.conn, status["event_id_at_last_train"])
            if changes >= self.s.retrain_stock_changes:
                return "new_data", f"{changes} stock changes since the last training"
        return None

    def maybe_retrain(self, force: bool = False) -> training.TrainResult | None:
        """Runs one retraining if one is queued (admin button), forced (--retrain) or due."""
        run = db.claim_queued_run(self.conn)
        if run is None:
            if force:
                trigger = ("command_line", "python -m bongalink_ml --retrain")
            else:
                trigger = self.auto_retrain_reason()
                if trigger is None:
                    return None
            run = db.start_run(self.conn, *trigger)
            if run is None:
                log.info("not retraining (%s): another training run is already in progress", trigger[1])
                return None
        return self._train(run)

    def _train(self, run: dict) -> training.TrainResult:
        who = run["requested_by_label"] or run["trigger_type"]
        log.info("retraining (run %s: %s, %s)", run["run_id"], who, run["trigger_detail"] or "")
        db.set_status(self.conn, state="updating")
        # The counters the new-data trigger compares against, taken before training.
        counters = {"sold_items_at_last_train": db.sold_items_total(self.conn),
                    "sold_orders_at_last_train": db.sold_orders_total(self.conn),
                    "event_id_at_last_train": db.max_event_id(self.conn)}
        try:
            result = training.retrain(self.conn, self.s.models_dir, self.model, self.s.trainer)
        except Exception as e:   # retrain() already catches training errors; this is the last guard
            log.exception("retraining crashed; keeping the active model")
            result = training.TrainResult("failed", f"Retraining failed, kept the active model: {type(e).__name__}: {e}"[:1000])
        db.set_status(self.conn, last_train_at="NOW()", last_train_status=result.status,
                      last_train_message=result.message, **counters)
        db.finish_run(self.conn, run["run_id"], status="failed" if result.status == "failed" else "done",
                      outcome=result.status, message=result.message, model_version=result.version, stats=result.stats)
        if result.status == "promoted":
            self._load(db.active_model_version(self.conn))
            self.refresh(None, f"new model {result.version}")
        else:
            # Put the banner back to whatever the predictions' real state is.
            db.set_status(self.conn, state="up_to_date" if self.retry_after == 0 else "failed")
        return result

    # ------------------------------------------------------------ loop
    def tick(self) -> None:
        self.conn.ping(reconnect=True)
        db.set_status(self.conn, heartbeat_at="NOW()")
        if time.monotonic() < self.retry_after:
            return
        self.retry_after = 0.0
        processed = self.process_events()
        if not processed and time.monotonic() - self.last_full_refresh >= self.s.full_refresh_minutes * 60:
            if db.pending_summary(self.conn)["n"] == 0:
                self.refresh(None, "scheduled full refresh")
        self.maybe_retrain()

    def run_forever(self) -> None:
        log.info("worker started: db=%s@%s/%s poll=%ss debounce=%ss/%ss trainer=%s",
                 self.s.db_user, self.s.db_host, self.s.db_name, self.s.poll_seconds,
                 self.s.quiet_seconds, self.s.max_wait_seconds, self.s.trainer)
        # Anything that changed while the worker was down is handled right away.
        if not self.process_events(force=True):
            self.refresh(None, "startup")
        while True:
            try:
                self.tick()
            except Exception:
                log.exception("worker tick failed; retrying in %ss", self.s.retry_seconds)
                time.sleep(self.s.retry_seconds)
                continue
            time.sleep(self.s.poll_seconds)
