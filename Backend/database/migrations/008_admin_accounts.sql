-- 008_admin_accounts.sql
-- Admin account management (REQ010, REQ018, REQ019, REQ029). Requires 004.
--
--   users + status            active / suspended / deleted (anonymized). Suspended and
--                             deleted accounts can't log in; requireAuth checks it on
--                             every request.
--         + token_version     goes up on suspend and role change; tokens carry it, so
--                             older tokens stop working at once (the user is logged out).
--                             Existing tokens have no version and count as 0, so nobody is
--                             logged out by this migration.
--         + suspended_at, suspended_reason
--         + must_set_password accounts created by an admin: no usable password until the
--                             user opens the emailed link and sets one.
--         + last_login_at, created_by (the admin who created it), anonymized_at
--   password_setup_tokens     the emailed "verify and set your password" links, stored as
--                             SHA-256 hashes, single use, with an expiry.
--   admin_audit_log           every admin action on an account: who, when, what, target,
--                             reason, old -> new. Labels are copies (the log outlives the
--                             account); anonymizing an account also scrubs its old labels.
--
-- Apply with:  mysql -u root -p bongalink_real < Backend/database/migrations/008_admin_accounts.sql

ALTER TABLE users
  ADD COLUMN status            ENUM('active','suspended','deleted') NOT NULL DEFAULT 'active' AFTER role,
  ADD COLUMN suspended_at      DATETIME NULL AFTER status,
  ADD COLUMN suspended_reason  VARCHAR(255) NULL AFTER suspended_at,
  ADD COLUMN token_version     INT UNSIGNED NOT NULL DEFAULT 0 AFTER suspended_reason,
  ADD COLUMN must_set_password TINYINT(1) NOT NULL DEFAULT 0 AFTER token_version,
  ADD COLUMN last_login_at     DATETIME NULL AFTER email_verified_at,
  ADD COLUMN created_by        INT UNSIGNED NULL AFTER last_login_at,     -- users.user_id of the admin; NULL = self-registered
  ADD COLUMN anonymized_at     DATETIME NULL AFTER created_by,
  ADD INDEX idx_users_role_status (role, status),
  ADD INDEX idx_users_created (created_at);

CREATE TABLE password_setup_tokens (
  token_id    INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED NOT NULL,
  token_hash  CHAR(64) NOT NULL,                     -- SHA-256 of the token in the link
  expires_at  DATETIME NOT NULL,
  used_at     DATETIME NULL,
  created_by  INT UNSIGNED NULL,                     -- the admin who sent it
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (token_id),
  UNIQUE KEY uq_pst_hash (token_hash),
  KEY idx_pst_user (user_id),
  CONSTRAINT fk_pst_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE admin_audit_log (
  audit_id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  admin_id        INT UNSIGNED NULL,                 -- no FK: the log outlives accounts
  admin_label     VARCHAR(60) NOT NULL,              -- the admin's username at the time
  action          ENUM('create_account','resend_invite','suspend','unsuspend','promote','demote','delete','anonymize') NOT NULL,
  target_user_id  INT UNSIGNED NULL,
  target_label    VARCHAR(60) NOT NULL,              -- the account's username at the time
  reason          VARCHAR(255) NULL,
  old_value       JSON NULL,
  new_value       JSON NULL,
  created_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (audit_id),
  KEY idx_audit_target (target_user_id, created_at),
  KEY idx_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
