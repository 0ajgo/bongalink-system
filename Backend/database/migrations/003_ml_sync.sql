-- 003_ml_sync.sql
-- Keeps the ML predictions in step with the product catalog.
--
--   products.is_active  soft delete: "removed" products stay in the table so
--                       order_items, transaction logs and trend history keep
--                       pointing at a real row (REQ020/REQ021/REQ024).
--   ml_events           audit trail of every product ID, quantity, price and
--                       add/remove change (anti "ghost stock"), written by the
--                       triggers below. The Python worker (ml/worker) reads the
--                       unprocessed rows and only ever flips `processed`.
--   ml_predictions      latest forecast per active product (dashboard reads this).
--   ml_model_versions   every trained model, its validation error, and whether
--                       it was promoted, rejected, or failed.
--   ml_status           one row: what the worker is doing right now.
--
-- Triggers run inside the same transaction as the product change, so an
-- event row exists only if that change commits.
--
-- Apply with:  mysql -u root -p bongalink < Backend/database/migrations/003_ml_sync.sql

ALTER TABLE products
  ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER stock_quantity,
  ADD INDEX idx_products_active (is_active);

-- No foreign key to products on purpose: audit rows must survive (and keep
-- the old value) even if a product ID is changed or a row is hard-deleted.
CREATE TABLE ml_events (
  event_id     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id   INT UNSIGNED NOT NULL,
  event_type   ENUM('ADDED','REMOVED','STOCK_CHANGED','PRICE_CHANGED','ID_CHANGED') NOT NULL,
  old_value    DECIMAL(12,2) NULL,
  new_value    DECIMAL(12,2) NULL,
  changed_by   INT UNSIGNED NULL,              -- backend sets @app_user_id per request
  created_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  processed    TINYINT(1) NOT NULL DEFAULT 0,
  processed_at TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (event_id),
  KEY idx_ml_events_pending (processed, event_id),
  KEY idx_ml_events_product (product_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ml_predictions (
  product_id                  INT UNSIGNED NOT NULL,
  current_stock               INT NOT NULL,
  predicted_demand_7d         DECIMAL(10,2) NULL,     -- NULL = no estimate at all
  avg_daily_demand            DECIMAL(10,3) NULL,
  days_until_stockout         DECIMAL(10,1) NULL,     -- NULL = no predicted demand
  reorder_recommended         TINYINT(1) NOT NULL DEFAULT 0,
  suggested_reorder_qty       INT NOT NULL DEFAULT 0,
  forecast_source             ENUM('model','category_average','store_average','none') NOT NULL,
  data_status                 ENUM('ok','insufficient_data') NOT NULL,
  history_days                INT NOT NULL,           -- days since the product was listed
  trend_status                ENUM('ok','insufficient_data') NOT NULL,
  trend_direction             ENUM('upward','downward','none') NULL,
  trend_relative_change       DOUBLE NULL,
  trend_days_since_breakpoint INT NULL,
  model_version               VARCHAR(40) NULL,
  computed_at                 TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ml_model_versions (
  version_id       INT UNSIGNED NOT NULL AUTO_INCREMENT,
  version          VARCHAR(40) NOT NULL,
  file_path        VARCHAR(255) NOT NULL,
  trained_with     VARCHAR(160) NOT NULL,             -- e.g. "tensorflow 2.21.0 (Keras Dense(1))"
  data_source      VARCHAR(40) NOT NULL,
  train_rows       INT NULL,
  val_rows         INT NULL,
  val_mae          DOUBLE NULL,                       -- this model on the holdout
  baseline_val_mae DOUBLE NULL,                       -- model it was compared against, same holdout
  status           ENUM('active','retired','rejected','failed') NOT NULL,
  notes            VARCHAR(1000) NULL,
  trained_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (version_id),
  UNIQUE KEY uq_ml_model_version (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ml_status (
  id                      TINYINT UNSIGNED NOT NULL,
  state                   ENUM('up_to_date','updating','failed') NOT NULL DEFAULT 'updating',
  last_update_at          TIMESTAMP NULL DEFAULT NULL,  -- last successful predictions refresh
  last_error              VARCHAR(1000) NULL,
  last_train_at           TIMESTAMP NULL DEFAULT NULL,  -- last training attempt
  last_train_status       ENUM('promoted','rejected','skipped','failed') NULL,
  last_train_message      VARCHAR(1000) NULL,
  sold_items_at_last_train INT NOT NULL DEFAULT 0,
  heartbeat_at            TIMESTAMP NULL DEFAULT NULL,  -- worker alive check
  PRIMARY KEY (id),
  CONSTRAINT chk_ml_status_single_row CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO ml_status (id, state) VALUES (1, 'updating');

DELIMITER //

CREATE TRIGGER trg_products_ml_insert
AFTER INSERT ON products
FOR EACH ROW
BEGIN
  INSERT INTO ml_events (product_id, event_type, old_value, new_value, changed_by)
  VALUES (NEW.product_id, 'ADDED', NULL, NEW.stock_quantity, COALESCE(@app_user_id, NEW.created_by));
END//

CREATE TRIGGER trg_products_ml_update
AFTER UPDATE ON products
FOR EACH ROW
BEGIN
  IF OLD.product_id <> NEW.product_id THEN
    INSERT INTO ml_events (product_id, event_type, old_value, new_value, changed_by)
    VALUES (NEW.product_id, 'ID_CHANGED', OLD.product_id, NEW.product_id, @app_user_id);
  END IF;
  IF OLD.is_active <> NEW.is_active THEN
    INSERT INTO ml_events (product_id, event_type, old_value, new_value, changed_by)
    VALUES (NEW.product_id, IF(NEW.is_active = 1, 'ADDED', 'REMOVED'), OLD.is_active, NEW.is_active, @app_user_id);
  END IF;
  IF OLD.stock_quantity <> NEW.stock_quantity THEN
    INSERT INTO ml_events (product_id, event_type, old_value, new_value, changed_by)
    VALUES (NEW.product_id, 'STOCK_CHANGED', OLD.stock_quantity, NEW.stock_quantity, @app_user_id);
  END IF;
  IF OLD.price <> NEW.price THEN
    INSERT INTO ml_events (product_id, event_type, old_value, new_value, changed_by)
    VALUES (NEW.product_id, 'PRICE_CHANGED', OLD.price, NEW.price, @app_user_id);
  END IF;
END//

-- The API never hard-deletes any more, but a manual DELETE still leaves a trace.
CREATE TRIGGER trg_products_ml_delete
AFTER DELETE ON products
FOR EACH ROW
BEGIN
  INSERT INTO ml_events (product_id, event_type, old_value, new_value, changed_by)
  VALUES (OLD.product_id, 'REMOVED', OLD.stock_quantity, NULL, @app_user_id);
END//

DELIMITER ;
