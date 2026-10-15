-- 007_faq_no_repairs.sql
-- The system's scope is ordering parts, customer inquiries, delivery and inventory.
-- Repairs are not offered through it, so the starter FAQs from 006 are corrected:
--   - the "Do you repair...?" FAQ now says repairs aren't handled online and points
--     to the shop (and is no longer a placeholder: it states the system's scope);
--   - the returns FAQ no longer mentions a technician.
-- Only rows that still have the original 006 text are changed, so anything already
-- edited on Admin > Chat & FAQs is left alone. Data only; no table changes.
-- A database created with the current 006 already has this text (both updates then
-- change 0 rows).
--
-- Apply with:  mysql -u root -p bongalink_real < Backend/database/migrations/007_faq_no_repairs.sql

UPDATE faqs
   SET question = 'Can I book a repair through the website or this chat?',
       answer = 'No. The online store is for ordering computer, laptop and printer parts only; repairs are not handled through the website or this chat. For anything about a repair, please contact the shop directly.',
       category = 'General',
       is_placeholder = 0
 WHERE question = 'Do you repair computers, laptops and printers?'
   AND answer LIKE 'Yes. Bongalink repairs desktop computers, laptops and printers,%';

UPDATE faqs
   SET answer = REPLACE(answer, 'Returns are checked by our technician before', 'Returns are checked by the shop before')
 WHERE question = 'Can I return or exchange a part?'
   AND answer LIKE '%Returns are checked by our technician before a replacement or refund is given.';
