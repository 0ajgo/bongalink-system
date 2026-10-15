-- 011_auth_recovery.sql
-- "Forgot password" and "Remember me". Requires 008 and 010.
--
--   password_setup_tokens + purpose   the emailed links now come in two kinds: 'setup'
--                                     (an admin created the account, 72 h) and 'reset'
--                                     (forgot password, 30 min). Same rules for both:
--                                     random token, only its SHA-256 hash stored, single use.
--                                     A link only works on its own page.
--   admin_audit_log.action + 'password_reset'   a password reset through an emailed link.
--   user_sessions                     one row per login. The login token carries its
--                                     session_id, so logging out ends that one device's
--                                     session at once (revoked_at), even for a 30-day
--                                     "Remember me" login. Suspension, role changes and
--                                     password changes still end every session through
--                                     users.token_version (008). Logins from before this
--                                     migration have no session_id and work until they expire.
--
-- Apply with:  mysql -u root -p bongalink_real < Backend/database/migrations/011_auth_recovery.sql

ALTER TABLE password_setup_tokens
  ADD COLUMN purpose ENUM('setup','reset') NOT NULL DEFAULT 'setup' AFTER user_id,
  ADD KEY idx_pst_user_purpose (user_id, purpose, used_at);

ALTER TABLE admin_audit_log
  MODIFY COLUMN action ENUM('create_account','resend_invite','suspend','unsuspend','promote','demote','delete','anonymize',
                            'ml_retrain','password_reset') NOT NULL;

CREATE TABLE user_sessions (
  session_id  CHAR(32) NOT NULL,                  -- random, in the login token
  user_id     INT UNSIGNED NOT NULL,
  remember    TINYINT(1) NOT NULL DEFAULT 0,      -- "Remember me": 30 days, kept after the browser closes
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  DATETIME NOT NULL,
  revoked_at  DATETIME NULL,                      -- logged out (or ended by a password change)
  PRIMARY KEY (session_id),
  KEY idx_user_sessions_user (user_id, expires_at),
  CONSTRAINT fk_user_sessions_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
