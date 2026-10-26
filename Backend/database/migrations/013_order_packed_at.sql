-- 013_order_packed_at.sql
-- "Mark as packed" on Admin > Deliveries. Requires 004.
--
--   orders + packed_at   when the admin marked the order packed (status 'packed', which 004
--                        already added). NULL for every existing order: nothing is rewritten.
--
-- Apply with:  mysql -u root -p bongalink_real < Backend/database/migrations/013_order_packed_at.sql

ALTER TABLE orders
  ADD COLUMN packed_at DATETIME NULL AFTER paid_at;
