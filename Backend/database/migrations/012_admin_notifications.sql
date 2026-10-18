-- 012_admin_notifications.sql
-- The admin notification bell (REQ020 instant alert, REQ021 product monitoring). Requires 008 and 011.
--
--   admin_notifications        one row per event, shared by every admin: a sale, a payment that
--                              needs review, unpaid orders expiring, a shipment booked / delivered /
--                              failed, a product going low or out of stock, a new customer account,
--                              a chat question the assistant couldn't answer. The text never holds
--                              the personal data 009 encrypts (emails, addresses, phone numbers):
--                              only order numbers, product names, amounts, couriers and usernames.
--                              The ref ids have no foreign keys: notifications outlive the rows.
--   admin_notification_reads   which admin has read which notification (per-admin unread counts).
--   users + notifications_read_through
--                              "Mark all as read": every notification up to this id counts as read
--                              for that admin, so marking all never writes one row per notification.
--   admin_stream_tickets       short-lived single-use tickets for the live notification stream
--                              (EventSource can't send the Authorization header, and the login token
--                              must never go in a URL). Only the SHA-256 of a ticket is stored.
--
-- Apply with:  mysql -u root -p bongalink_real < Backend/database/migrations/012_admin_notifications.sql

CREATE TABLE admin_notifications (
  notification_id  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  type             ENUM('sale','payment_review','orders_expired','shipment_booked','shipment_delivered',
                        'shipment_failed','low_stock','out_of_stock','new_customer','chat_unanswered') NOT NULL,
  title            VARCHAR(120) NOT NULL,
  body             VARCHAR(255) NULL,
  link             VARCHAR(255) NULL,            -- frontend page under Pages/, e.g. Admin/deliveries.html
  order_id         INT UNSIGNED NULL,
  product_id       INT UNSIGNED NULL,
  shipment_id      INT UNSIGNED NULL,            -- deliveries.delivery_id
  user_id          INT UNSIGNED NULL,            -- the customer (new account)
  chat_id          BIGINT UNSIGNED NULL,         -- chat_logs.chat_id
  created_at       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (notification_id),
  KEY idx_admin_notifications_type (type, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE admin_notification_reads (
  admin_id         INT UNSIGNED NOT NULL,
  notification_id  BIGINT UNSIGNED NOT NULL,
  read_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (admin_id, notification_id),
  KEY idx_anr_notification (notification_id),
  CONSTRAINT fk_anr_admin FOREIGN KEY (admin_id) REFERENCES users (user_id) ON DELETE CASCADE,
  CONSTRAINT fk_anr_notification FOREIGN KEY (notification_id) REFERENCES admin_notifications (notification_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE users
  ADD COLUMN notifications_read_through BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER last_login_at;

CREATE TABLE admin_stream_tickets (
  ticket_hash       CHAR(64) NOT NULL,            -- SHA-256 of the ticket in the stream URL
  user_id           INT UNSIGNED NOT NULL,
  session_id        CHAR(32) NULL,                -- the login it came from (011); NULL for session-less tokens
  token_version     INT UNSIGNED NOT NULL,        -- users.token_version when it was issued (008)
  token_expires_at  DATETIME NULL,                -- when that login token expires
  expires_at        DATETIME NOT NULL,            -- the ticket itself: 60 seconds
  used_at           DATETIME NULL,                -- single use
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ticket_hash),
  KEY idx_ast_user (user_id, expires_at),
  CONSTRAINT fk_ast_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
