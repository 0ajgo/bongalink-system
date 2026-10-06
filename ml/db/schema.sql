-- Bongalink core schema (MySQL 8). Covers REQ017-REQ024 and the stock audit trail.
-- Addition to the paper: order_items, so one order can contain several parts
-- (REQ024 lists a single "quantity ordered" per order).

CREATE DATABASE IF NOT EXISTS bongalink CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE bongalink;

CREATE TABLE users (
  user_id        BIGINT AUTO_INCREMENT PRIMARY KEY,
  username       VARCHAR(50)  NOT NULL UNIQUE,
  email          VARCHAR(255) NOT NULL UNIQUE,
  password_hash  VARCHAR(255) NOT NULL,                 -- argon2/bcrypt hash, never plain text (REQ017)
  full_name      VARCHAR(120),
  contact_number VARCHAR(20),
  role           ENUM('customer', 'staff', 'admin') NOT NULL DEFAULT 'customer',   -- RBAC (REQ019, REQ029)
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE products (
  product_id  BIGINT AUTO_INCREMENT PRIMARY KEY,
  sku         VARCHAR(40) UNIQUE,
  name        VARCHAR(150) NOT NULL,
  description TEXT,
  category    VARCHAR(60),                              -- printer / laptop / desktop ...
  price       DECIMAL(10, 2) NOT NULL,
  quantity    INT NOT NULL DEFAULT 0,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT chk_quantity_nonnegative CHECK (quantity >= 0)   -- blocks negative "ghost stock"
);

CREATE TABLE orders (
  order_id       BIGINT AUTO_INCREMENT PRIMARY KEY,
  customer_id    BIGINT NOT NULL,
  total_amount   DECIMAL(12, 2) NOT NULL,
  payment_method ENUM('bank_transfer', 'gcash') NOT NULL,       -- REQ03
  order_status   ENUM('pending', 'paid', 'shipped', 'delivered', 'cancelled') NOT NULL DEFAULT 'pending',
  order_date     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES users (user_id),
  INDEX idx_orders_date_status (order_date, order_status)
);

CREATE TABLE order_items (
  order_item_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_id      BIGINT NOT NULL,
  product_id    BIGINT NOT NULL,
  quantity      INT NOT NULL,
  unit_price    DECIMAL(10, 2) NOT NULL,                 -- price at time of purchase
  CONSTRAINT fk_items_order   FOREIGN KEY (order_id)   REFERENCES orders (order_id) ON DELETE CASCADE,
  CONSTRAINT fk_items_product FOREIGN KEY (product_id) REFERENCES products (product_id),
  CONSTRAINT chk_item_quantity CHECK (quantity > 0),
  INDEX idx_items_product (product_id)
);

-- Audit trail for every stock change (addresses ghost stocks / auditability, Sprint 1).
CREATE TABLE stock_movements (
  movement_id  BIGINT AUTO_INCREMENT PRIMARY KEY,
  product_id   BIGINT NOT NULL,
  old_quantity INT NOT NULL,
  new_quantity INT NOT NULL,
  changed_by   BIGINT NULL,          -- backend sets @app_user_id per request
  changed_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_moves_product FOREIGN KEY (product_id) REFERENCES products (product_id),
  INDEX idx_moves_product_time (product_id, changed_at)
);

DELIMITER //
CREATE TRIGGER trg_products_stock_audit
AFTER UPDATE ON products
FOR EACH ROW
BEGIN
  IF OLD.quantity <> NEW.quantity THEN
    INSERT INTO stock_movements (product_id, old_quantity, new_quantity, changed_by)
    VALUES (NEW.product_id, OLD.quantity, NEW.quantity, @app_user_id);
  END IF;
END//
DELIMITER ;
