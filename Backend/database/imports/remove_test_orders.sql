-- remove_test_orders.sql: delete the 7 test orders (171-177, the "Yosi" test product) and every
-- row that depends on them, so the database's sales equal the 2026 sales sheet (162 sales,
-- 274 units, P863,434.00). Product stock and reserved are NOT changed, no inventory_movements
-- are written. ml_status.sold_orders_at_last_train is set to the new sold-order count (162),
-- so the worker's "new paid orders" retrain trigger counts from there.
-- One transaction; a failed check (ERROR 1242) stops it before COMMIT.
-- Applied to bongalink_real on 2026-10-19 (see README.md); running it again stops at the first check.

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;
START TRANSACTION;

-- check: orders 171-177 exist and are exactly the reviewed test orders (one Yosi line each, not import_walkin)
DO (SELECT 1 FROM (SELECT 1 UNION ALL SELECT 2) g WHERE NOT COALESCE((
  SELECT COUNT(*) FROM orders o JOIN users u USING (user_id)
   WHERE o.order_id IN (171, 172, 173, 174, 175, 176, 177) AND u.username <> 'import_walkin'
     AND (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.order_id) = 1
     AND (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.order_id AND oi.product_id = 73) = 1) = 7, FALSE));
-- check: they are the only orders outside the 162 imported from the sheet
DO (SELECT 1 FROM (SELECT 1 UNION ALL SELECT 2) g WHERE NOT COALESCE((
  SELECT COUNT(*) FROM orders o JOIN users u USING (user_id) WHERE u.username <> 'import_walkin') = 7, FALSE));

-- stock and reserved fingerprint, to prove they don't change
SET @stock_before = (SELECT SUM(CRC32(CONCAT_WS(':', product_id, stock_quantity, reserved, updated_at))) FROM products);

-- checkout addresses used only by these orders (orders.address_id is ON DELETE RESTRICT)
CREATE TEMPORARY TABLE tmp_test_order_addresses AS
  SELECT DISTINCT address_id FROM orders WHERE order_id IN (171, 172, 173, 174, 175, 176, 177) AND address_id IS NOT NULL;

DELETE FROM payments WHERE order_id IN (171, 172, 173, 174, 175, 176, 177);                -- FK has no cascade
DELETE FROM admin_notifications WHERE order_id IN (171, 172, 173, 174, 175, 176, 177);
DELETE FROM inventory_movements
 WHERE reference IN ('order:171', 'order:172', 'order:173', 'order:174', 'order:175', 'order:176', 'order:177');
DELETE FROM orders WHERE order_id IN (171, 172, 173, 174, 175, 176, 177);                  -- cascades: order_items, deliveries -> shipment_events
DELETE FROM delivery_addresses
 WHERE address_id IN (SELECT address_id FROM tmp_test_order_addresses)
   AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.address_id = delivery_addresses.address_id);
DROP TEMPORARY TABLE tmp_test_order_addresses;

-- the ML worker counts new paid orders from here (it was 165, including the 3 delivered test orders)
UPDATE ml_status SET sold_orders_at_last_train = 162 WHERE id = 1;

-- check: nothing left that pointed at them
DO (SELECT 1 FROM (SELECT 1 UNION ALL SELECT 2) g WHERE NOT COALESCE(
  (SELECT COUNT(*) FROM order_items WHERE order_id NOT IN (SELECT order_id FROM orders))
  + (SELECT COUNT(*) FROM deliveries WHERE order_id NOT IN (SELECT order_id FROM orders))
  + (SELECT COUNT(*) FROM shipment_events WHERE delivery_id NOT IN (SELECT delivery_id FROM deliveries))
  + (SELECT COUNT(*) FROM payments WHERE order_id NOT IN (SELECT order_id FROM orders))
  + (SELECT COUNT(*) FROM inventory_movements WHERE reference REGEXP '^order:(17[1-7])$') = 0, FALSE));
-- check: sales now equal the sheet: 162 sold orders, 274 units, P863,434.00
DO (SELECT 1 FROM (SELECT 1 UNION ALL SELECT 2) g WHERE NOT COALESCE((
  SELECT CONCAT(COUNT(DISTINCT o.order_id), '/', SUM(oi.quantity), '/', SUM(oi.quantity * oi.unit_price))
    FROM orders o JOIN order_items oi USING (order_id)
   WHERE o.status IN ('processing', 'completed', 'paid', 'packed', 'shipped', 'delivered')) = '162/274/863434.00', FALSE));
DO (SELECT 1 FROM (SELECT 1 UNION ALL SELECT 2) g WHERE NOT COALESCE((
  SELECT SUM(total_amount) FROM orders WHERE status IN ('processing', 'completed', 'paid', 'packed', 'shipped', 'delivered')) = 863434.00, FALSE));
-- check: no order left outside the sheet's 162, and stock / reserved untouched
DO (SELECT 1 FROM (SELECT 1 UNION ALL SELECT 2) g WHERE NOT COALESCE((SELECT COUNT(*) FROM orders) = 162, FALSE));
-- check: ml_status counts from the 162 sold orders
DO (SELECT 1 FROM (SELECT 1 UNION ALL SELECT 2) g WHERE NOT COALESCE((SELECT sold_orders_at_last_train FROM ml_status WHERE id = 1) = 162, FALSE));
DO (SELECT 1 FROM (SELECT 1 UNION ALL SELECT 2) g WHERE NOT COALESCE(
  (SELECT SUM(CRC32(CONCAT_WS(':', product_id, stock_quantity, reserved, updated_at))) FROM products) = @stock_before, FALSE));

SET @stock_before = NULL;
COMMIT;
