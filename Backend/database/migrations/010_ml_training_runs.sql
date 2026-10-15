-- 010_ml_training_runs.sql
-- Retraining on demand and automatically (REQ028). Requires 003 and 008.
--
--   ml_training_runs   one row per retraining: who or what started it (an admin's
--                      "Update forecasts & trends" button, the nightly schedule, enough
--                      new data, or the command line), its progress
--                      (queued -> training -> done | failed), the data it used, the
--                      model's accuracy, and the result. The admin page shows the latest.
--                      active_slot is 1 while a run is queued or training and NULL
--                      otherwise; its UNIQUE key lets the database itself refuse a
--                      second run at the same time, from any source (two admins, the
--                      schedule, or two worker processes).
--   ml_status          + the automatic-retraining settings the worker is running with
--                      (it writes them at start-up, so the page can show them), and the
--                      counters at the last training that the new-data trigger compares to.
--   admin_audit_log    + action 'ml_retrain' (an admin asked for a retrain).
--
-- Nothing here holds personal information: the ML worker reads only products, orders
-- (status and date) and order items, and never needs the encryption keys.
--
-- Apply with:  mysql -u root -p bongalink_real < Backend/database/migrations/010_ml_training_runs.sql

CREATE TABLE ml_training_runs (
  run_id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  trigger_type        ENUM('manual','nightly','new_data','command_line') NOT NULL,
  trigger_detail      VARCHAR(255) NULL,              -- e.g. "52 new paid orders since the last training"
  requested_by        INT UNSIGNED NULL,              -- users.user_id for manual runs (no FK: history outlives accounts)
  requested_by_label  VARCHAR(60) NULL,               -- the admin's username at the time
  status              ENUM('queued','training','done','failed') NOT NULL DEFAULT 'queued',
  active_slot         TINYINT AS (IF(status IN ('queued','training'), 1, NULL)) STORED,
  outcome             ENUM('promoted','rejected','skipped','failed') NULL,
  model_version       VARCHAR(40) NULL,               -- ml_model_versions.version trained in this run
  sales_records       INT UNSIGNED NULL,              -- sold order lines in the training window
  orders_used         INT UNSIGNED NULL,
  products_used       INT UNSIGNED NULL,
  train_rows          INT UNSIGNED NULL,              -- 28-day training windows
  val_rows            INT UNSIGNED NULL,
  data_from           DATE NULL,
  data_to             DATE NULL,
  val_mae             DOUBLE NULL,                    -- new model: average error, units per product per 7 days
  baseline_val_mae    DOUBLE NULL,                    -- the model in use, on the same validation data
  naive_val_mae       DOUBLE NULL,                    -- "next week = last 28 days' daily average x 7"
  message             VARCHAR(1000) NULL,             -- the verdict, or the error
  queued_at           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  started_at          TIMESTAMP(3) NULL,
  finished_at         TIMESTAMP(3) NULL,
  PRIMARY KEY (run_id),
  UNIQUE KEY uq_ml_training_one_active (active_slot),
  KEY idx_ml_training_status (status, run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE ml_status
  ADD COLUMN auto_retrain_hour          TINYINT NULL AFTER sold_items_at_last_train,       -- NULL = nightly retraining off
  ADD COLUMN auto_retrain_orders        INT UNSIGNED NULL AFTER auto_retrain_hour,         -- new paid orders; NULL = off
  ADD COLUMN auto_retrain_stock_changes INT UNSIGNED NULL AFTER auto_retrain_orders,       -- stock changes; NULL = off
  ADD COLUMN sold_orders_at_last_train  INT UNSIGNED NOT NULL DEFAULT 0 AFTER auto_retrain_stock_changes,
  ADD COLUMN event_id_at_last_train     BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER sold_orders_at_last_train;

ALTER TABLE admin_audit_log
  MODIFY COLUMN action ENUM('create_account','resend_invite','suspend','unsuspend','promote','demote','delete','anonymize',
                            'ml_retrain') NOT NULL;

-- Start the new-data counters at today's totals, so data that already exists doesn't
-- count as "new" and set off a retrain the first time the worker starts.
-- (The statuses are the worker's SOLD_STATUSES: ml/worker/bongalink_ml/db.py.)
UPDATE ml_status SET
  sold_orders_at_last_train = (SELECT COUNT(*) FROM orders
                               WHERE status IN ('processing','completed','paid','packed','shipped','delivered')),
  event_id_at_last_train    = (SELECT COALESCE(MAX(event_id), 0) FROM ml_events)
WHERE id = 1;
