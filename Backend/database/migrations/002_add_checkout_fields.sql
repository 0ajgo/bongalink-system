-- Adds the columns POST /api/orders needs to link an order to a
-- delivery_addresses row, its payment method, shipping fee, and a
-- contact email (delivery_addresses has no email column).
ALTER TABLE orders
  ADD COLUMN address_id INT UNSIGNED NULL AFTER user_id,
  ADD COLUMN contact_email VARCHAR(255) NULL AFTER address_id,
  ADD COLUMN payment_method ENUM('BANK_TRANSFER','GCASH') NOT NULL DEFAULT 'BANK_TRANSFER' AFTER total_amount,
  ADD COLUMN shipping_fee DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER payment_method,
  ADD CONSTRAINT fk_orders_address FOREIGN KEY (address_id) REFERENCES delivery_addresses(address_id) ON DELETE RESTRICT ON UPDATE CASCADE;
