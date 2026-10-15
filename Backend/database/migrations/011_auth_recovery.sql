-- 011_auth_recovery.sql
-- "Forgot password" and "Remember me". Requires 008 and 010.
--
--   password_setup_tokens + purpose   the emailed links now come in two kinds: 'setup'
--                                     (an admin created the account, 72 h) and 'reset'
--                                     (forgot password, 30 min). Same rules for both:
--                                     random token, only its SHA-256 hash stored, single use.
--                                     A link only works on its own page.
--   admin_audit_log.action + 'password_reset'   a password reset through an emailed link.
--
-- Apply with:  mysql -u root -p bongalink_real < Backend/database/migrations/011_auth_recovery.sql

ALTER TABLE password_setup_tokens
  ADD COLUMN purpose ENUM('setup','reset') NOT NULL DEFAULT 'setup' AFTER user_id,
  ADD KEY idx_pst_user_purpose (user_id, purpose, used_at);

ALTER TABLE admin_audit_log
  MODIFY COLUMN action ENUM('create_account','resend_invite','suspend','unsuspend','promote','demote','delete','anonymize',
                            'ml_retrain','password_reset') NOT NULL;
