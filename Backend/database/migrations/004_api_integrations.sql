-- 004_api_integrations.sql
-- Email verification, PayMongo payments and courier logistics.
-- Requires 003_ml_sync.sql (products.is_active).
--
--   users.email_verified_at   set by POST /api/v1/auth/verify-email/confirm;
--                             existing accounts are backfilled as verified.
--   products.reserved         units held by unpaid orders. Available stock is
--                             stock_quantity - reserved. The PayMongo webhook turns
--                             a reservation into a real stock_quantity deduction;
--                             the expiry job releases it after 24 hours unpaid.
--   products.weight_kg        parcel weight used by the shipping fee table.
--   orders.status             keeps the old values for existing orders and adds
--                             the payment/shipping lifecycle values.
--   delivery_addresses        region (PSGC) + optional map pin for Lalamove.
--   deliveries                reused as the shipment record (one per order).
--
-- Apply with:  mysql -u root -p bongalink_real < Backend/database/migrations/004_api_integrations.sql

-- ---------------------------------------------------------------- existing tables
ALTER TABLE users
  ADD COLUMN email_verified_at DATETIME NULL AFTER role;

-- Accounts created before verification existed are treated as verified.
UPDATE users SET email_verified_at = COALESCE(created_at, NOW()) WHERE email_verified_at IS NULL;

ALTER TABLE products
  ADD COLUMN reserved INT UNSIGNED NOT NULL DEFAULT 0 AFTER stock_quantity,
  ADD COLUMN weight_kg DECIMAL(6,3) NOT NULL DEFAULT 0.500 AFTER reserved;

ALTER TABLE orders
  MODIFY COLUMN status ENUM('pending','processing','completed','cancelled',
                            'pending_payment','paid','packed','shipped','delivered','expired')
                       NOT NULL DEFAULT 'pending_payment',
  ADD COLUMN courier ENUM('LALAMOVE','JNT','LBC') NULL AFTER shipping_fee,
  ADD COLUMN paid_at DATETIME NULL AFTER courier,
  ADD INDEX idx_orders_status_created (status, created_at);

ALTER TABLE delivery_addresses
  ADD COLUMN region VARCHAR(10) NULL AFTER province,     -- NCR, CAR, I ... XIII, IV-A, IV-B, NIR, BARMM
  ADD COLUMN lat DECIMAL(10,7) NULL AFTER landmark,      -- map pin, only needed for Lalamove
  ADD COLUMN lng DECIMAL(10,7) NULL AFTER lat;

-- PENDING = order placed, nothing booked yet. BOOKED = Lalamove rider requested.
-- PICKED_UP = handed to the courier. RETURNED = parcel came back.
ALTER TABLE deliveries
  MODIFY COLUMN status ENUM('PENDING','BOOKED','PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY',
                            'DELIVERED','FAILED','RETURNED') NOT NULL DEFAULT 'PENDING',
  ADD COLUMN external_order_id VARCHAR(64) NULL AFTER tracking_number,   -- Lalamove orderId
  ADD COLUMN tracking_url VARCHAR(500) NULL AFTER external_order_id,
  ADD COLUMN fee_charged DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER tracking_url,  -- what the customer paid
  ADD COLUMN fee_actual DECIMAL(10,2) NULL AFTER fee_charged,                     -- what the courier charged
  ADD COLUMN updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  ADD UNIQUE KEY uq_delivery_order (order_id),
  ADD INDEX idx_delivery_status (status),
  ADD INDEX idx_delivery_external (external_order_id);

-- ---------------------------------------------------------------- email verification
-- 6-digit code, stored as an HMAC, never in plain text.
CREATE TABLE email_verifications (
  verification_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         INT UNSIGNED NOT NULL,
  code_hash       CHAR(64) NOT NULL,
  attempts        TINYINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at      DATETIME NOT NULL,
  used_at         DATETIME NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (verification_id),
  KEY idx_ev_user (user_id),
  CONSTRAINT fk_ev_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------- payments (PayMongo)
CREATE TABLE payments (
  payment_id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id             INT UNSIGNED NOT NULL,
  provider             VARCHAR(20) NOT NULL DEFAULT 'paymongo',
  checkout_session_id  VARCHAR(64) NOT NULL,
  provider_payment_id  VARCHAR(64) NULL,
  amount_centavos      INT UNSIGNED NOT NULL,
  method_used          VARCHAR(30) NULL,               -- gcash, qrph, dob, dob_ubp, brankas_bdo ...
  status               ENUM('pending','paid','review','failed') NOT NULL DEFAULT 'pending',
  review_reason        VARCHAR(255) NULL,              -- paid after expiry, amount mismatch
  paid_at              DATETIME NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (payment_id),
  UNIQUE KEY uq_payment_session (checkout_session_id),
  KEY idx_pay_order (order_id),
  CONSTRAINT fk_payment_order FOREIGN KEY (order_id) REFERENCES orders (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every webhook event is processed once (idempotency + audit trail).
CREATE TABLE payment_events (
  event_id     VARCHAR(64) NOT NULL,
  type         VARCHAR(64) NOT NULL,
  received_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Stock audit trail for reservations and payments (ml_events still logs
-- every stock_quantity change through the 003 triggers).
CREATE TABLE inventory_movements (
  movement_id  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id   INT UNSIGNED NOT NULL,
  change_qty   INT NOT NULL,
  reason       VARCHAR(30) NOT NULL,      -- sale, reservation_release, restock, damage, correction
  reference    VARCHAR(64) NULL,          -- e.g. order:15
  created_by   INT UNSIGNED NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (movement_id),
  KEY idx_im_product (product_id),
  CONSTRAINT fk_im_product FOREIGN KEY (product_id) REFERENCES products (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------- logistics
-- J&T / LBC fees encoded by the admin (no public API without a merchant agreement).
CREATE TABLE shipping_rates (
  rate_id        INT UNSIGNED NOT NULL AUTO_INCREMENT,
  courier        ENUM('JNT','LBC') NOT NULL,
  zone           ENUM('NCR','LUZON','VISAYAS','MINDANAO','ISLAND_PROVINCE') NOT NULL,
  max_weight_kg  DECIMAL(6,2) NOT NULL,
  fee            DECIMAL(10,2) NOT NULL,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (rate_id),
  UNIQUE KEY uq_rate (courier, zone, max_weight_kg)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tracking timeline for a delivery.
CREATE TABLE shipment_events (
  event_id     INT UNSIGNED NOT NULL AUTO_INCREMENT,
  delivery_id  INT UNSIGNED NOT NULL,
  status       VARCHAR(30) NOT NULL,
  note         VARCHAR(255) NULL,
  source       ENUM('admin','courier_webhook','system') NOT NULL DEFAULT 'admin',
  created_by   INT UNSIGNED NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id),
  KEY idx_se_delivery (delivery_id),
  CONSTRAINT fk_se_delivery FOREIGN KEY (delivery_id) REFERENCES deliveries (delivery_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- PLACEHOLDER RATES FOR TESTING ONLY - replace with Bongalink's actual courier rates.
INSERT INTO shipping_rates (courier, zone, max_weight_kg, fee) VALUES
 ('JNT','NCR',1,100),('JNT','NCR',3,150),('JNT','NCR',5,200),
 ('JNT','LUZON',1,120),('JNT','LUZON',3,180),('JNT','LUZON',5,240),
 ('JNT','VISAYAS',1,150),('JNT','VISAYAS',3,230),('JNT','VISAYAS',5,310),
 ('JNT','MINDANAO',1,160),('JNT','MINDANAO',3,250),('JNT','MINDANAO',5,340),
 ('JNT','ISLAND_PROVINCE',1,190),('JNT','ISLAND_PROVINCE',3,290),('JNT','ISLAND_PROVINCE',5,390),
 ('LBC','NCR',1,130),('LBC','NCR',3,190),('LBC','NCR',5,250),
 ('LBC','LUZON',1,160),('LBC','LUZON',3,230),('LBC','LUZON',5,300),
 ('LBC','VISAYAS',1,190),('LBC','VISAYAS',3,280),('LBC','VISAYAS',5,370),
 ('LBC','MINDANAO',1,200),('LBC','MINDANAO',3,300),('LBC','MINDANAO',5,400),
 ('LBC','ISLAND_PROVINCE',1,230),('LBC','ISLAND_PROVINCE',3,340),('LBC','ISLAND_PROVINCE',5,450);
