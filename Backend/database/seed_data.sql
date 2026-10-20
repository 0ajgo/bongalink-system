-- seed_data.sql: optional starting data for a FRESH install, run after the schema and every
-- migration (and after the first admin account exists: it is recorded as their creator).
--
--   mysql -u root -p <database> < Backend/database/seed_data.sql
--
-- 1. The product categories. A fresh database has none, and a part can't be added without one.
-- 2. Test products for the live PayMongo test after deployment (Backend/README.md, "Live payment
--    test"): HIDDEN (is_active = 0), so customers never see them, with 3 in stock each. Show one,
--    buy it, hide it again. They have no photo (uploaded photos are not in the repository).
-- Safe to run twice: existing categories are kept and the products are only added once.

INSERT IGNORE INTO categories (name) VALUES
  ('Printer Parts'), ('Computer Parts'), ('Laptop Parts'), ('Accessories'), ('Electronics'), ('Other');

INSERT INTO products (name, category_id, brand, price, stock_quantity, is_active, description, created_by)
SELECT t.name, c.category_id, t.brand, t.price, 3, 0, t.description,
       (SELECT MIN(user_id) FROM users WHERE role = 'admin')
  FROM (SELECT 'Iphone13' AS name, 'Electronics' AS category, 'Iphone' AS brand, 14000.00 AS price,
               'Test product (not for sale).' AS description
        UNION ALL SELECT 'Camel', 'Other', 'Camel', 10.00, 'Test product for the live payment test (not for sale).'
        UNION ALL SELECT 'Iphone13 (test 2)', 'Accessories', 'Iphone', 14000.00, 'Test product (not for sale).'
        UNION ALL SELECT 'electric fan', 'Electronics', NULL, 1000.00, 'Test product (not for sale).') AS t
  JOIN categories c ON c.name = t.category
 WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.name = t.name);
