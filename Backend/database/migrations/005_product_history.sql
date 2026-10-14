-- 005_product_history.sql
-- Product editing (REQ020, REQ021, REQ035): change history, extra photos,
-- and notes on stock adjustments. Requires 003 (ML triggers) and 004.
--
--   product_changes      one row per changed field: who, when, old -> new, and
--                        why (stock adjustments). Written by the triggers below,
--                        so every change is kept — from the app, the payment
--                        webhook, or a manual SQL edit. The backend sets
--                        @app_user_id and @app_change_reason on its connection.
--   product_images       extra photos for the product gallery (products.image_path
--                        stays the cover photo).
--   inventory_movements  + note: free text for stock adjustments.
--
-- The existing 003 trigger trg_products_ml_update is unchanged; the new history
-- trigger runs after it (FOLLOWS).
--
-- Apply with:  mysql -u root -p bongalink_real < Backend/database/migrations/005_product_history.sql

CREATE TABLE product_changes (
  change_id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id  INT UNSIGNED NOT NULL,              -- no FK: history outlives the product row
  field       VARCHAR(30) NOT NULL,               -- created, name, brand, description, category,
                                                  -- price, stock, weight, image, active, photo_added, photo_removed
  old_value   TEXT NULL,
  new_value   TEXT NULL,
  reason      VARCHAR(255) NULL,                  -- e.g. "restock: delivery from supplier"
  changed_by  INT UNSIGNED NULL,                  -- users.user_id; NULL = system (payment, expiry, SQL)
  changed_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (change_id),
  KEY idx_product_changes_product (product_id, changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE product_images (
  image_id    INT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id  INT UNSIGNED NOT NULL,
  image_path  VARCHAR(255) NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (image_id),
  KEY idx_product_images_product (product_id, sort_order),
  CONSTRAINT fk_product_images_product FOREIGN KEY (product_id) REFERENCES products (product_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE inventory_movements
  ADD COLUMN note VARCHAR(255) NULL AFTER reference;

DELIMITER //

CREATE TRIGGER trg_products_history_insert
AFTER INSERT ON products
FOR EACH ROW
BEGIN
  INSERT INTO product_changes (product_id, field, old_value, new_value, reason, changed_by)
  VALUES (NEW.product_id, 'created', NULL, NEW.name, @app_change_reason, COALESCE(@app_user_id, NEW.created_by));
END//

-- One row per field that actually changed. reserved/updated_at are not product data.
CREATE TRIGGER trg_products_history_update
AFTER UPDATE ON products
FOR EACH ROW
FOLLOWS trg_products_ml_update
BEGIN
  IF NOT (OLD.name <=> NEW.name) THEN
    INSERT INTO product_changes (product_id, field, old_value, new_value, reason, changed_by)
    VALUES (NEW.product_id, 'name', OLD.name, NEW.name, @app_change_reason, @app_user_id);
  END IF;
  IF NOT (OLD.brand <=> NEW.brand) THEN
    INSERT INTO product_changes (product_id, field, old_value, new_value, reason, changed_by)
    VALUES (NEW.product_id, 'brand', OLD.brand, NEW.brand, @app_change_reason, @app_user_id);
  END IF;
  IF NOT (OLD.description <=> NEW.description) THEN
    INSERT INTO product_changes (product_id, field, old_value, new_value, reason, changed_by)
    VALUES (NEW.product_id, 'description', OLD.description, NEW.description, @app_change_reason, @app_user_id);
  END IF;
  IF NOT (OLD.category_id <=> NEW.category_id) THEN
    INSERT INTO product_changes (product_id, field, old_value, new_value, reason, changed_by)
    VALUES (NEW.product_id, 'category',
            (SELECT name FROM categories WHERE category_id = OLD.category_id),
            (SELECT name FROM categories WHERE category_id = NEW.category_id),
            @app_change_reason, @app_user_id);
  END IF;
  IF NOT (OLD.price <=> NEW.price) THEN
    INSERT INTO product_changes (product_id, field, old_value, new_value, reason, changed_by)
    VALUES (NEW.product_id, 'price', OLD.price, NEW.price, @app_change_reason, @app_user_id);
  END IF;
  IF NOT (OLD.stock_quantity <=> NEW.stock_quantity) THEN
    INSERT INTO product_changes (product_id, field, old_value, new_value, reason, changed_by)
    VALUES (NEW.product_id, 'stock', OLD.stock_quantity, NEW.stock_quantity, @app_change_reason, @app_user_id);
  END IF;
  IF NOT (OLD.weight_kg <=> NEW.weight_kg) THEN
    INSERT INTO product_changes (product_id, field, old_value, new_value, reason, changed_by)
    VALUES (NEW.product_id, 'weight', OLD.weight_kg, NEW.weight_kg, @app_change_reason, @app_user_id);
  END IF;
  IF NOT (OLD.image_path <=> NEW.image_path) THEN
    INSERT INTO product_changes (product_id, field, old_value, new_value, reason, changed_by)
    VALUES (NEW.product_id, 'image', OLD.image_path, NEW.image_path, @app_change_reason, @app_user_id);
  END IF;
  IF NOT (OLD.is_active <=> NEW.is_active) THEN
    INSERT INTO product_changes (product_id, field, old_value, new_value, reason, changed_by)
    VALUES (NEW.product_id, 'active', OLD.is_active, NEW.is_active, @app_change_reason, @app_user_id);
  END IF;
END//

CREATE TRIGGER trg_product_images_insert
AFTER INSERT ON product_images
FOR EACH ROW
BEGIN
  INSERT INTO product_changes (product_id, field, old_value, new_value, reason, changed_by)
  VALUES (NEW.product_id, 'photo_added', NULL, NEW.image_path, @app_change_reason, @app_user_id);
END//

CREATE TRIGGER trg_product_images_delete
AFTER DELETE ON product_images
FOR EACH ROW
BEGIN
  INSERT INTO product_changes (product_id, field, old_value, new_value, reason, changed_by)
  VALUES (OLD.product_id, 'photo_removed', OLD.image_path, NULL, @app_change_reason, @app_user_id);
END//

DELIMITER ;
