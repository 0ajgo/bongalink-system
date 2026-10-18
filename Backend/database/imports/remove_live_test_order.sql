-- remove_live_test_order.sql: takes the live PayMongo test order out of the sales, after the
-- test (Backend/README.md, "Live payment test"). Same steps as remove_test_orders.sql, for one
-- order: the order and every row that depends on it (order_items, deliveries, shipment_events,
-- payments, its checkout address, its inventory_movements and admin_notifications rows).
-- Product stock is NOT changed (adjust it in Inventory if you want the unit back).
--
-- 1. Back up the database first (mysqldump, see DEPLOYMENT.md).
-- 2. Hide the test product again (Inventory > Edit part > Hidden), then put the order number
--    in the line below (the order is refused if any of its parts is still shown in the shop).
-- 3. mysql -u root -p bongalink_real < Backend/database/imports/remove_live_test_order.sql
-- A failed check (ERROR 1242 ... Subquery returns more than 1 row) stops it before COMMIT.

SET @order_id = 0;   -- <== the test order's number

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;
START TRANSACTION;

-- check: the order exists, has lines, and every line is a HIDDEN (test) product
DO (SELECT 1 FROM (SELECT 1 UNION ALL SELECT 2) g WHERE NOT COALESCE((
  SELECT COUNT(*) FROM order_items WHERE order_id = @order_id) > 0, FALSE));
DO (SELECT 1 FROM (SELECT 1 UNION ALL SELECT 2) g WHERE NOT COALESCE((
  SELECT COUNT(*) FROM order_items oi JOIN products p USING (product_id) WHERE oi.order_id = @order_id AND p.is_active = 1) = 0, FALSE));

SET @stock_before = (SELECT SUM(CRC32(CONCAT_WS(':', product_id, stock_quantity, reserved, updated_at))) FROM products);
SET @address_id = (SELECT address_id FROM orders WHERE order_id = @order_id);

DELETE FROM payments WHERE order_id = @order_id;                         -- FK has no cascade
DELETE FROM admin_notifications WHERE order_id = @order_id;
DELETE FROM inventory_movements WHERE reference = CONCAT('order:', @order_id);
DELETE FROM orders WHERE order_id = @order_id;                           -- cascades: order_items, deliveries -> shipment_events
DELETE FROM delivery_addresses WHERE address_id = @address_id
   AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.address_id = @address_id);
-- the ML worker counts new paid orders from its last training: never above the real total
UPDATE ml_status SET sold_orders_at_last_train = LEAST(sold_orders_at_last_train,
  (SELECT COUNT(*) FROM orders WHERE status IN ('processing', 'completed', 'paid', 'packed', 'shipped', 'delivered')))
 WHERE id = 1;

-- check: nothing left that pointed at the order, and product stock untouched
DO (SELECT 1 FROM (SELECT 1 UNION ALL SELECT 2) g WHERE NOT COALESCE(
  (SELECT COUNT(*) FROM orders WHERE order_id = @order_id)
  + (SELECT COUNT(*) FROM order_items WHERE order_id = @order_id)
  + (SELECT COUNT(*) FROM deliveries WHERE order_id = @order_id)
  + (SELECT COUNT(*) FROM payments WHERE order_id = @order_id)
  + (SELECT COUNT(*) FROM inventory_movements WHERE reference = CONCAT('order:', @order_id)) = 0, FALSE));
DO (SELECT 1 FROM (SELECT 1 UNION ALL SELECT 2) g WHERE NOT COALESCE(
  (SELECT SUM(CRC32(CONCAT_WS(':', product_id, stock_quantity, reserved, updated_at))) FROM products) = @stock_before, FALSE));

SET @order_id = NULL, @stock_before = NULL, @address_id = NULL;
COMMIT;
