-- Which migrations does this database have? Read-only. DEPLOYMENT.md, "Migrations".
--   mysql -u root -p bongalink_real < deploy/mysql/check_migrations.sql
-- Each migration is recognised by something it creates. 002 is already in bongalink_schema.sql;
-- 007 only rewrites two starter FAQs and is safe to run again, so it isn't listed.
-- Apply the missing ones in number order, after a backup.
SELECT m.migration,
       IF(m.present, 'applied', 'MISSING') AS state
  FROM (
    SELECT '003_ml_sync'              AS migration, EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products' AND COLUMN_NAME = 'is_active') AS present
    UNION ALL SELECT '004_api_integrations',     EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'email_verified_at')
    UNION ALL SELECT '005_product_history',      EXISTS (SELECT 1 FROM information_schema.TABLES  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_changes')
    UNION ALL SELECT '006_chatbot',              EXISTS (SELECT 1 FROM information_schema.TABLES  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'faqs')
    UNION ALL SELECT '008_admin_accounts',       EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'token_version')
    UNION ALL SELECT '009_encrypt_personal_data', EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'email_bidx')
    UNION ALL SELECT '010_ml_training_runs',     EXISTS (SELECT 1 FROM information_schema.TABLES  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ml_training_runs')
    UNION ALL SELECT '011_auth_recovery',        EXISTS (SELECT 1 FROM information_schema.TABLES  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_sessions')
    UNION ALL SELECT '012_admin_notifications',  EXISTS (SELECT 1 FROM information_schema.TABLES  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admin_notifications')
  ) m;

-- The database triggers (ML sync, product history) run as the account that created them.
-- account_exists must be 1, or every product change fails: keep that account (usually root@localhost).
SELECT t.DEFINER, COUNT(*) AS triggers,
       (SELECT COUNT(*) FROM mysql.user u WHERE CONCAT(u.User, '@', u.Host) = t.DEFINER) AS account_exists
  FROM information_schema.TRIGGERS t
 WHERE t.TRIGGER_SCHEMA = DATABASE()
 GROUP BY t.DEFINER;
