-- =====================================================================
-- Least-privilege MySQL accounts for the API and the ML worker (DEPLOYMENT.md, "Database users").
-- Neither process changes the schema, so neither needs more than this. Run it ONCE as an admin
-- account (root), after the migrations, on the server that holds the shop's database:
--   mysql -u root -p < deploy/mysql/create_app_users.sql
--   Docker: docker compose exec -T mysql mysql -uroot -p"$DB_PASSWORD" < deploy/mysql/create_app_users.sql
-- Fill in the four values below first; the script refuses to run with the placeholders.
--   @db        the shop's database (bongalink_real on the shop's server, bongalink in Docker)
--   @app_host  where the API and the worker connect FROM: 'localhost' when they run on the same
--              machine as MySQL; '%' in Docker (other containers on the compose network)
-- Then put the users and passwords in Backend/.env and ml/worker/.env (DB_USER, DB_PASSWORD),
-- or for Docker in the root .env (API_DB_USER/API_DB_PASSWORD, ML_DB_USER/ML_DB_PASSWORD).
-- Migrations, backups, import_sales.py and the one-off scripts keep using the admin account.
-- The database triggers run as their definer (root@localhost): keep that account.
-- =====================================================================

SET @db           = 'bongalink_real';
SET @app_host     = 'localhost';
SET @app_password = 'CHANGE-ME';   -- long random, e.g. node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
SET @ml_password  = 'CHANGE-ME';   -- a different one

-- Guard: stop (error 1242) unless real passwords were filled in and the database exists.
DO (SELECT 1 FROM (SELECT 1 UNION ALL SELECT 2) g WHERE NOT COALESCE(
  @app_password <> 'CHANGE-ME' AND @ml_password <> 'CHANGE-ME' AND @app_password <> @ml_password
  AND CHAR_LENGTH(@app_password) >= 20 AND CHAR_LENGTH(@ml_password) >= 20
  AND EXISTS (SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = @db), FALSE));

SET @app = CONCAT("'bongalink_app'@", QUOTE(@app_host));
SET @ml  = CONCAT("'bongalink_ml'@", QUOTE(@app_host));
SET @d   = CONCAT('`', REPLACE(@db, '`', ''), '`');
-- In a database-wide grant, _ is a wildcard: escape it so only this database is meant.
SET @dw  = CONCAT('`', REPLACE(REPLACE(@db, '`', ''), '_', '\_'), '`');

-- The API: reads and writes the shop's data; no schema changes, no other databases.
SET @s = CONCAT('CREATE USER IF NOT EXISTS ', @app, ' IDENTIFIED BY ', QUOTE(@app_password)); PREPARE s FROM @s; EXECUTE s; DEALLOCATE PREPARE s;
SET @s = CONCAT('GRANT SELECT, INSERT, UPDATE, DELETE ON ', @dw, '.* TO ', @app); PREPARE s FROM @s; EXECUTE s; DEALLOCATE PREPARE s;

-- The ML worker: reads products and sales, writes only its own tables.
SET @s = CONCAT('CREATE USER IF NOT EXISTS ', @ml, ' IDENTIFIED BY ', QUOTE(@ml_password)); PREPARE s FROM @s; EXECUTE s; DEALLOCATE PREPARE s;
SET @s = CONCAT('GRANT SELECT ON ', @d, '.products TO ', @ml); PREPARE s FROM @s; EXECUTE s; DEALLOCATE PREPARE s;
SET @s = CONCAT('GRANT SELECT ON ', @d, '.categories TO ', @ml); PREPARE s FROM @s; EXECUTE s; DEALLOCATE PREPARE s;
SET @s = CONCAT('GRANT SELECT ON ', @d, '.orders TO ', @ml); PREPARE s FROM @s; EXECUTE s; DEALLOCATE PREPARE s;
SET @s = CONCAT('GRANT SELECT ON ', @d, '.order_items TO ', @ml); PREPARE s FROM @s; EXECUTE s; DEALLOCATE PREPARE s;
SET @s = CONCAT('GRANT SELECT, UPDATE ON ', @d, '.ml_events TO ', @ml); PREPARE s FROM @s; EXECUTE s; DEALLOCATE PREPARE s;
SET @s = CONCAT('GRANT SELECT, UPDATE ON ', @d, '.ml_status TO ', @ml); PREPARE s FROM @s; EXECUTE s; DEALLOCATE PREPARE s;
SET @s = CONCAT('GRANT SELECT, INSERT, UPDATE ON ', @d, '.ml_training_runs TO ', @ml); PREPARE s FROM @s; EXECUTE s; DEALLOCATE PREPARE s;
SET @s = CONCAT('GRANT SELECT, INSERT, UPDATE ON ', @d, '.ml_model_versions TO ', @ml); PREPARE s FROM @s; EXECUTE s; DEALLOCATE PREPARE s;
SET @s = CONCAT('GRANT SELECT, INSERT, UPDATE, DELETE ON ', @d, '.ml_predictions TO ', @ml); PREPARE s FROM @s; EXECUTE s; DEALLOCATE PREPARE s;

-- What was granted (check it):
SET @s = CONCAT('SHOW GRANTS FOR ', @app); PREPARE s FROM @s; EXECUTE s; DEALLOCATE PREPARE s;
SET @s = CONCAT('SHOW GRANTS FOR ', @ml);  PREPARE s FROM @s; EXECUTE s; DEALLOCATE PREPARE s;
