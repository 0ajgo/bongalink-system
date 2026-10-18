# Real product inventory import

The shop's real parts inventory, imported into `bongalink_real` on 2026-10-19 from
`Bongalink_Inventory_Final.xlsx` (the source of truth; not committed, nor is `photos.zip`).

| File | What it is |
|---|---|
| `../../scripts/import-inventory.js` | Reads the workbook's "Inventory" tab and generates the SQL |
| `real_inventory.sql` | The generated import (one transaction, safe to run again) |
| `photos/` | The 30 product photos named in the workbook (served from `/uploads/<file>`) |

## What was imported

36 products: 22 shown (16 in stock, 36 units) and 14 hidden drafts (5 units); 10 of them
have photos (10 covers in `products.image_path`, 20 gallery rows in `product_images`).

- **28 inserted** (product_id 74–101).
- **8 updated in place**, keeping their product_id and sales history:
  15 Printhead L3210, 16 Printhead L1800, 22 Printhead L18050, 42 Printhead L1300,
  67 CR Motor L8050, and these 3 **renamed** (the same part under the sales sheet's name):

  | product_id | Was | Now |
  |---|---|---|
  | 61 | Ink Cartridge BH-7 | Cartridge Head BH-7 Black |
  | 23 | CR Motor L1800 | CR Motor L1300/L1800 |
  | 25 | Printhead 51AA | Printhead HP M0H51AA Black |

- **12 products outside the workbook hidden** (`is_active = 0`, never deleted):
  73 Yosi (test product, also set to stock 0), and the whole printers (the shop sells parts):
  12 Printer L3210, 27 Printer LX-310, 28 Printer and Pickup Roller L1800, 29 Printer T520,
  40 Printer L5290, 46 Printer L220, 49 Printer L14150, 52 Printer L120, 53 Printer G1010,
  59 Printer L1300, 71 Printer L3110.

Stock changes were recorded like an admin stock adjustment: one `inventory_movements` row
per change (reason `correction`, reference `adjustment`), and the triggers logged every
change to `product_changes` and `ml_events` as admin 4. New products get no movement row,
as when an admin creates one. Descriptions were replaced only where empty or still the
`import_sales.py` placeholder. `weight_kg` was left alone. No orders, payments, users or
sales history were touched.

## Rules used to fill the gaps (workbook, "Rules used" tab)

No owner answers were available, so these rules filled the gaps. Every product row in the
workbook says which rule it used.

1. Duplicate rows are merged into one product. When they disagree on the count, the lower
   number is used (safer against ghost stock).
2. 'ON STOCK' with no count = stock 1.
3. No sign the item is on hand (blank status, or TO-ORDER) = stock 0. It is still listed if
   it has a price, and shows as out of stock.
4. Two prices or a price range = the higher price.
5. No price = imported as a HIDDEN draft (customers can't see or buy it). Set the price in
   the admin Edit part dialog, then switch it to shown.
6. Rows that only name a printer (L18050, L1300, L1800) are treated as printheads: the sheet
   lists them among the printheads and their prices are printhead-level.
7. A model code overrides a conflicting word (Canon 810 is the black PG-810, even though the
   row says Color).
8. Nothing is called genuine/original or tied to a printer model unless the sheet, a box
   label or the owner's photo folder title says so.
9. Photo sets with no sheet row become hidden drafts with stock 0, so their photos are
   already in place when the owner adds a price and count.
10. General stock photos (boxes of several parts) are not attached to any product. The old
    test products (iPhone, Camel, electric fan...) are left untouched.

(The workbook's Model column isn't stored: `products` has no model column, and the model
is already in each name and description. Product 73 "Yosi" was hidden at the import review,
overriding rule 10.)

## Re-running

```bash
cd Backend
node scripts/import-inventory.js            # plan: what would change in DB_NAME, writes nothing
node scripts/import-inventory.js --write    # regenerate database/imports/real_inventory.sql
```
Options: `--file <xlsx>` (default `../imports/Bongalink_Inventory_Final.xlsx`),
`--photos <dir>` (default `database/imports/photos`), `--database <name>`, `--admin <user_id>`.
The script only reads the database. The renames and hidden products approved at the review
are listed at the top of the script (`RENAMES`, `HIDE`); each is checked against its
reviewed name before anything is written.

Then, after a backup (`mysqldump --single-transaction --routines --triggers
--default-character-set=utf8mb4 bongalink_real > backups/<name>.sql`):

1. Copy `photos/*` into the uploads folder (`UPLOAD_DIR`, default `Backend/uploads/`)
   without overwriting existing files.
2. Run the SQL with the mysql client, **never with `--force`**:
   `mysql -u root -p bongalink_real < database/imports/real_inventory.sql`

Checks inside the transaction (admin, categories, triggers, reviewed names, reserved stock,
final totals, every product's photos) stop it before COMMIT if anything is off; a failed
check shows as `ERROR 1242 ... Subquery returns more than 1 row` with the line of the check,
whose comment says what failed. Running it again changes no rows and writes no history,
`ml_events` or movement rows. Requires migrations 003 and 005 (triggers); the backend on
this branch also needs 011 and 012.

## Open items (not changed by the import)

- **14 hidden products need a price** (they're at 0 on purpose); the admin Edit part dialog
  requires a price above 0 before a product can be shown.
- **Shipping weights:** the 28 new products are on the 0.5 kg default. Set real packed
  weights on the Inventory page.
- **47 sales-sheet parts are still visible** at stock 0, with prices from the 2026 sales
  sheet that haven't been confirmed (and the sheet's placeholder description).
- **3 delivered test orders for Yosi** (₱9 each, orders 173, 176, 177) still count as sales
  on the dashboard and in ML training; orders weren't touched.
