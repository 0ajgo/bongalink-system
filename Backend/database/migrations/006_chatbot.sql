-- 006_chatbot.sql
-- AI chat support (Objective 1, REQ04, REQ026): FAQs the chatbot answers from,
-- and a log of every customer exchange. Requires 004 (orders/products columns).
--
--   faqs       question/answer pairs the admin manages on "Chat & FAQs". Every
--              active FAQ is sent to the chatbot with each message, so a new or
--              edited FAQ is used in the very next answer. is_placeholder marks
--              the starter FAQs below until the shop confirms them; the bot tells
--              customers to confirm placeholder details with the shop.
--   chat_logs  one row per exchange (customer message + bot reply): session,
--              customer if logged in, which database tools the bot used, and
--              whether it answered. Unanswered questions are the admin's review
--              queue; turning one into an FAQ links it (faq_id) and resolves it.
--
-- Apply with:  mysql -u root -p bongalink_real < Backend/database/migrations/006_chatbot.sql

CREATE TABLE faqs (
  faq_id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  question        VARCHAR(255) NOT NULL,
  answer          TEXT NOT NULL,
  category        VARCHAR(40) NOT NULL DEFAULT 'General',
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  is_placeholder  TINYINT(1) NOT NULL DEFAULT 0,   -- starter text, not yet confirmed by the shop
  created_by      INT UNSIGNED NULL,               -- users.user_id; NULL = seeded by this migration
  updated_by      INT UNSIGNED NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (faq_id),
  KEY idx_faqs_active (is_active, category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE chat_logs (
  chat_id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id         VARCHAR(64) NOT NULL,          -- random id kept by the browser tab
  user_id            INT UNSIGNED NULL,             -- NULL = not logged in
  product_id         INT UNSIGNED NULL,             -- "Ask about this part": the product page it started from
  message            VARCHAR(1000) NOT NULL,
  reply              TEXT NOT NULL,
  tools_used         JSON NULL,                     -- [{"name":"search_products","args":{...}}, ...]
  answered           TINYINT(1) NOT NULL,
  unanswered_reason  ENUM('no_information','needs_staff','off_topic','service_down') NULL,
  model              VARCHAR(60) NULL,              -- NULL = fallback reply, Gemini not reached
  response_ms        INT UNSIGNED NULL,
  resolved_at        DATETIME NULL,                 -- admin handled this unanswered question
  resolved_by        INT UNSIGNED NULL,
  faq_id             INT UNSIGNED NULL,             -- the FAQ made from this question
  created_at         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (chat_id),
  KEY idx_chat_logs_session (session_id, chat_id),
  KEY idx_chat_logs_review (answered, resolved_at, created_at),
  KEY idx_chat_logs_created (created_at),
  KEY idx_chat_logs_user (user_id),
  CONSTRAINT fk_chat_logs_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE SET NULL,
  CONSTRAINT fk_chat_logs_faq FOREIGN KEY (faq_id) REFERENCES faqs (faq_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Starter FAQs. PLACEHOLDERS: confirm every answer with the shop owner, then edit
-- it on Admin > Chat & FAQs and tick "Confirmed by the shop".
-- Payment, courier, delivery-time and ordering facts match how the system works today;
-- store hours, returns and repair details are guesses to be replaced.
INSERT INTO faqs (question, answer, category, is_placeholder) VALUES
('What payment methods do you accept?',
 'We accept GCash and bank transfer. At checkout you pay securely through PayMongo using GCash, QR Ph or online banking. Orders are confirmed as soon as the payment goes through.',
 'Payment', 1),
('How long do I have to pay for my order?',
 'Unpaid orders are held for 24 hours. The parts are reserved for you during that time; after 24 hours the order expires and the parts go back on sale.',
 'Payment', 1),
('Where do you deliver?',
 'We deliver nationwide with J&T Express and LBC Express. Lalamove same-day delivery is available in Metro Manila and nearby provinces (Bulacan, Cavite, Laguna and Rizal) when you pin your location on the map at checkout.',
 'Delivery', 1),
('How long does delivery take?',
 'Estimated delivery after your order ships: Metro Manila 1-3 days, rest of Luzon 2-5 days, Visayas 3-7 days, Mindanao 3-8 days, island provinces 5-9 days. Lalamove delivers the same day. The shipping fee is shown at checkout before you pay.',
 'Delivery', 1),
('How do I place an order?',
 'Create an account and verify your email, add parts to your cart, then go to checkout. Enter your delivery address (pin it on the map for exact fees), choose a courier, and pay with GCash or bank transfer. You can follow your order under My orders.',
 'Ordering', 1),
('How do I track my order?',
 'Log in and open My orders. Once your order ships you will see the courier, the tracking number and each delivery update there. You can also ask this chat about your order.',
 'Ordering', 1),
('Can I return or exchange a part?',
 'If a part arrives defective or is not what you ordered, message the shop within 7 days of delivery with your order number and photos. Parts must be unused and in their original packaging. Returns are checked by our technician before a replacement or refund is given.',
 'Returns', 1),
('Do you repair computers, laptops and printers?',
 'Yes. Bongalink repairs desktop computers, laptops and printers, including printhead cleaning and replacement, laptop screen and battery replacement, and general troubleshooting. Repair prices depend on the problem, so contact the shop for a quote.',
 'Repairs', 1),
('What are your store hours?',
 'Our physical shop is open Monday to Saturday, 9:00 AM to 6:00 PM, closed on Sundays and holidays. Online orders and this chat are available 24/7.',
 'Store', 1),
('Are your parts original or compatible?',
 'Each product page says the brand. If you are not sure a part fits your model, ask us here with your printer, laptop or computer model before ordering.',
 'Products', 1);
