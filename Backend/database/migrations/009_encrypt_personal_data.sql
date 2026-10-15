-- 009_encrypt_personal_data.sql
-- Personal information is stored encrypted (REQ027, REQ030; RA 10173 Data Privacy Act).
-- Requires 006 and 008. The backend encrypts with AES-256-GCM before saving
-- (Backend/lib/dataProtection.js); this migration only makes room for it:
--
--   * encrypted columns become TEXT ("enc:v1:..." is longer than the plain value;
--     lat/lng stop being DECIMAL);
--   * users.email_bidx: HMAC-SHA256 "blind index" of the email, so login-related and
--     duplicate checks find an email without storing it in plain text. It takes over
--     the unique key from users.email;
--   * consent_records gains PRIVACY_NOTICE (accepted at registration / account setup).
--
-- Existing rows are still plain text after this migration. Encrypt them right after
-- with:  node scripts/encrypt-personal-data.js --apply
-- (the old backend keeps working on plain rows until then; the new one needs both).
--
-- Plain on purpose: delivery_addresses.province, region, shipping_zone (coarse areas,
-- kept for delivery-area reports and on anonymized orders) and users.username (the
-- login lookup). Nothing the ML worker reads is personal.
--
-- Apply with:  mysql -u root -p bongalink_real < Backend/database/migrations/009_encrypt_personal_data.sql

ALTER TABLE users
  DROP INDEX uq_users_email,
  MODIFY COLUMN email TEXT NOT NULL,
  MODIFY COLUMN suspended_reason TEXT NULL,
  ADD COLUMN email_bidx CHAR(64) NULL AFTER email,
  ADD UNIQUE KEY uq_users_email_bidx (email_bidx);

ALTER TABLE orders
  MODIFY COLUMN contact_email TEXT NULL;

ALTER TABLE delivery_addresses
  MODIFY COLUMN recipient_name  TEXT NOT NULL,
  MODIFY COLUMN recipient_phone TEXT NOT NULL,
  MODIFY COLUMN street          TEXT NOT NULL,
  MODIFY COLUMN barangay        TEXT NOT NULL,
  MODIFY COLUMN city            TEXT NOT NULL,
  MODIFY COLUMN postal_code     TEXT NOT NULL,
  MODIFY COLUMN landmark        TEXT NULL,
  MODIFY COLUMN lat             TEXT NULL,
  MODIFY COLUMN lng             TEXT NULL;

ALTER TABLE chat_logs
  MODIFY COLUMN message TEXT NOT NULL;

ALTER TABLE admin_audit_log
  MODIFY COLUMN reason TEXT NULL;

ALTER TABLE consent_records
  MODIFY COLUMN consent_type ENUM('ORDER_PROCESSING','MARKETING','PRIVACY_NOTICE') NOT NULL;
