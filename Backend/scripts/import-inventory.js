/* =====================================================================
   scripts/import-inventory.js — the shop's real product inventory.
   Reads Bongalink_Inventory_Final.xlsx ("Inventory" tab, the source of
   truth) and writes database/imports/real_inventory.sql. The products
   are never typed in here; only the changes approved during the import
   review (RENAMES, HIDE) are.

     node scripts/import-inventory.js                 plan: what the SQL would change in DB_NAME, writes nothing
     node scripts/import-inventory.js --write         also writes database/imports/real_inventory.sql
       --file <xlsx>       default ../imports/Bongalink_Inventory_Final.xlsx
       --photos <dir>      default database/imports/photos (every photo named in the sheet must be there)
       --database <name>   default DB_NAME; only read, to find the admin and check the approved changes
       --admin <user_id>   default: the only active admin

   Then:  mysql -u root -p <database> < database/imports/real_inventory.sql   (never with --force)

   The SQL:
   - runs in one transaction; checks stop it before COMMIT, so a failed check
     changes nothing (they fail with "ERROR 1242 ... Subquery returns more than
     1 row"; the line number points at the check, its comment says what failed);
   - sets @app_user_id, so the 003/005 triggers record the admin in ml_events
     and product_changes;
   - renames the approved existing products (same product_id, so their sales
     history stays with them), then updates each sheet product found by name,
     or inserts it;
   - changes stock like the admin's stock adjustment (POST /api/products/:id/stock):
     an inventory_movements row with the difference, reason 'correction', and a
     separate UPDATE carrying "correction: ..." as the history reason. A new
     product gets no movement row, as when an admin creates one;
   - replaces a description only when it is empty or the import_sales.py placeholder;
   - sets the first photo as image_path and the rest as product_images (in order);
   - leaves weight_kg alone (new products get the 0.5 kg default);
   - only writes what differs, so a second run changes no rows and fires no
     trigger rows.
   ===================================================================== */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const mysql = require('mysql2/promise');
const ExcelJS = require('exceljs');

const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const WORKBOOK = path.resolve(arg('--file', path.join(__dirname, '..', '..', 'imports', 'Bongalink_Inventory_Final.xlsx')));
const PHOTOS = path.resolve(arg('--photos', path.join(__dirname, '..', 'database', 'imports', 'photos')));
const OUTPUT = path.join(__dirname, '..', 'database', 'imports', 'real_inventory.sql');

const NOTE = 'Real inventory import (Bongalink_Inventory_Final.xlsx)';
const PLACEHOLDER = 'Imported from the 2026 sales sheet';   // import_sales.py's description
const VISIBILITY = { 'Shown': 1, 'Hidden draft': 0 };

// Approved at the Phase 3 review: the same part already in the database under
// another name. Kept and renamed, so its product_id and sales stay.
const RENAMES = [
  { id: 61, from: 'Ink Cartridge BH-7', to: 'Cartridge Head BH-7 Black' },
  { id: 23, from: 'CR Motor L1800', to: 'CR Motor L1300/L1800' },
  { id: 25, from: 'Printhead 51AA', to: 'Printhead HP M0H51AA Black' },
];

// Approved at the Phase 3 review: products outside the sheet to hide (is_active = 0).
// zeroStock also sets the stock to 0 (ghost stock). Never deleted.
const HIDE = [
  { id: 73, name: 'Yosi', zeroStock: true, why: 'test product' },
  ...[
    [12, 'Printer L3210'], [27, 'Printer LX-310'], [28, 'Printer and Pickup Roller L1800'], [29, 'Printer T520'],
    [40, 'Printer L5290'], [46, 'Printer L220'], [49, 'Printer L14150'], [52, 'Printer L120'],
    [53, 'Printer G1010'], [59, 'Printer L1300'], [71, 'Printer L3110'],
  ].map(([id, name]) => ({ id, name, zeroStock: false, why: 'whole printer, the shop sells parts' })),
];

const q = (v) => mysql.escape(v);
const money = (n) => Number(n).toFixed(2);

/* --------------------------------------------------------------- workbook */
async function readWorkbook() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(WORKBOOK);
  const ws = wb.getWorksheet('Inventory');
  if (!ws) throw new Error('The workbook has no "Inventory" tab.');

  const header = {};
  ws.getRow(1).eachCell((cell, col) => { header[String(cell.text).trim()] = col; });
  const COLUMNS = ['Product name', 'Category', 'Brand', 'Stock', 'Price (PHP)', 'Visibility', 'Photos', 'Description'];
  const missing = COLUMNS.filter((c) => !header[c]);
  if (missing.length) throw new Error(`The Inventory tab is missing the column(s): ${missing.join(', ')}`);

  const products = [];
  const problems = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const text = (col) => String(row.getCell(header[col]).text ?? '').trim();
    const name = text('Product name');
    if (!name) return;
    const at = `row ${n} (${name})`;
    const stock = Number(row.getCell(header['Stock']).value);
    const price = Number(row.getCell(header['Price (PHP)']).value);
    const photos = text('Photos') === '-' ? [] : text('Photos').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const brand = text('Brand');
    const p = {
      name, category: text('Category'), brand: brand && brand !== '-' ? brand : null, stock, price,
      active: VISIBILITY[text('Visibility')], photos, description: text('Description') || null,
    };
    if (name.length > 150) problems.push(`${at}: the name is longer than 150 characters`);
    if (!Number.isInteger(stock) || stock < 0) problems.push(`${at}: stock must be a whole number of 0 or more`);
    if (!(price >= 0) || Math.round(price * 100) !== price * 100) problems.push(`${at}: price must be 0 or more, in centavos at most`);
    if (p.active === undefined) problems.push(`${at}: visibility must be "Shown" or "Hidden draft"`);
    if (p.active === 1 && !(price > 0)) problems.push(`${at}: a shown product needs a price above 0`);
    if (p.brand && p.brand.length > 100) problems.push(`${at}: the brand is longer than 100 characters`);
    for (const f of photos) {
      if (!/^[a-z0-9-]+\.jpg$/.test(f)) problems.push(`${at}: unexpected photo file name "${f}"`);
      else if (!fs.existsSync(path.join(PHOTOS, f))) problems.push(`${at}: photo ${f} is not in ${PHOTOS}`);
    }
    products.push(p);
  });

  const seen = new Set();
  for (const p of products) {
    if (seen.has(p.name.toLowerCase())) problems.push(`"${p.name}" is in the sheet twice`);
    seen.add(p.name.toLowerCase());
  }
  const allPhotos = products.flatMap((p) => p.photos);
  if (new Set(allPhotos).size !== allPhotos.length) problems.push('a photo is used by more than one product');
  for (const r of RENAMES) if (!seen.has(r.to.toLowerCase())) problems.push(`rename target "${r.to}" is not in the sheet`);
  for (const h of HIDE) if (seen.has(h.name.toLowerCase())) problems.push(`"${h.name}" is in the sheet, it can't also be hidden`);
  if (problems.length) throw new Error(`The workbook can't be imported:\n  - ${problems.join('\n  - ')}`);
  return products;
}

/* --------------------------------------------------------------- SQL */
// A check: stops the script (no COMMIT) unless cond is true.
const check = (label, cond) =>
  `-- check: ${label}\nDO (SELECT 1 FROM (SELECT 1 UNION ALL SELECT 2) g WHERE NOT COALESCE(${cond}, FALSE));`;

const categoryId = (name) => `(SELECT category_id FROM categories WHERE name = ${q(name)})`;

function productSql(p, n, total) {
  const vis = p.active ? 'shown' : 'hidden';
  const [cover, ...gallery] = p.photos.map((f) => `/uploads/${f}`);
  const lines = [
    `-- [${n}/${total}] ${p.name}: stock ${p.stock}, price ${money(p.price)}, ${vis}, ${p.photos.length} photo(s)`,
    'SET @app_change_reason = @import_note;',
    `SET @pid = (SELECT product_id FROM products WHERE name = ${q(p.name)});`,
    `INSERT INTO products (name, category_id, brand, price, stock_quantity, is_active, image_path, description, created_by)`,
    `SELECT ${q(p.name)}, ${categoryId(p.category)}, ${q(p.brand)}, ${money(p.price)}, ${p.stock}, ${p.active}, ${q(cover ?? null)}, ${q(p.description)}, @app_user_id`,
    '  FROM DUAL WHERE @pid IS NULL;',
    `SET @pid = (SELECT product_id FROM products WHERE name = ${q(p.name)});`,
    check(`stock ${p.stock} is not below what unpaid orders hold`, `(SELECT reserved FROM products WHERE product_id = @pid) <= ${p.stock}`),
    'SET @app_change_reason = @stock_reason;',
    'INSERT INTO inventory_movements (product_id, change_qty, reason, reference, note, created_by)',
    `SELECT product_id, ${p.stock} - CAST(stock_quantity AS SIGNED), 'correction', 'adjustment', @import_note, @app_user_id`,
    `  FROM products WHERE product_id = @pid AND stock_quantity <> ${p.stock};`,
    `UPDATE products SET stock_quantity = ${p.stock} WHERE product_id = @pid;`,
    'SET @app_change_reason = @import_note;',
    `UPDATE products SET category_id = ${categoryId(p.category)}, brand = ${q(p.brand)}, price = ${money(p.price)}, is_active = ${p.active},`,
    ...(cover ? [`       image_path = ${q(cover)},`] : []),
    `       description = IF(description IS NULL OR TRIM(description) = '' OR description LIKE ${q(PLACEHOLDER + '%')}, ${q(p.description)}, description)`,
    ' WHERE product_id = @pid;',
  ];
  if (cover) {
    const want = gallery.length ? gallery.join('|') : null;
    lines.push(
      `SET @have = (SELECT GROUP_CONCAT(image_path ORDER BY sort_order, image_id SEPARATOR '|') FROM product_images WHERE product_id = @pid);`,
      `SET @want = ${q(want)};`,
      'DELETE FROM product_images WHERE product_id = @pid AND NOT (@have <=> @want);',
    );
    if (gallery.length) {
      lines.push(
        'INSERT INTO product_images (product_id, image_path, sort_order)',
        `SELECT @pid, v.image_path, v.sort_order FROM (${gallery
          .map((g, i) => (i ? `SELECT ${q(g)}, ${i}` : `SELECT ${q(g)} AS image_path, ${i} AS sort_order`)).join(' UNION ALL ')}) v`,
        ' WHERE NOT (@have <=> @want);',
      );
    }
  }
  return lines.join('\n');
}

function buildSql(products, adminId) {
  const names = products.map((p) => q(p.name)).join(', ');
  const shown = products.filter((p) => p.active);
  const hidden = products.filter((p) => !p.active);
  const sum = (list) => list.reduce((s, p) => s + p.stock, 0);
  const categories = [...new Set(products.map((p) => p.category))];
  const withPhotos = products.filter((p) => p.photos.length);
  const galleryRows = withPhotos.reduce((s, p) => s + p.photos.length - 1, 0);
  const out = [
    '-- real_inventory.sql: generated by Backend/scripts/import-inventory.js from',
    '-- Bongalink_Inventory_Final.xlsx. Do not edit by hand; change the workbook and regenerate.',
    `-- ${products.length} products (${shown.length} shown, ${hidden.length} hidden), ${products.flatMap((p) => p.photos).length} photos`,
    `-- (${withPhotos.length} products with photos: ${withPhotos.length} covers + ${galleryRows} gallery rows),`,
    `-- ${RENAMES.length} renames and ${HIDE.length} products hidden, as approved at the import review.`,
    '-- Run it with the mysql client, never with --force: a failed check stops it before COMMIT.',
    '-- Safe to run again: only values that differ are written.',
    '',
    "SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;   -- the tables' collation (the server default differs), so variables compare with columns",
    'START TRANSACTION;',
    '',
    `SET @app_user_id = ${adminId};`,
    `SET @import_note = ${q(NOTE)};`,
    "SET @stock_reason = CONCAT('correction: ', @import_note);",
    '',
    check(`user ${adminId} is an active admin`, `(SELECT COUNT(*) FROM users WHERE user_id = @app_user_id AND role = 'admin' AND status = 'active') = 1`),
    ...categories.map((c) => check(`category "${c}" exists`, `${categoryId(c)} IS NOT NULL`)),
    check('the migration 003 and 005 product triggers are installed',
      "(SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND trigger_name IN ('trg_products_ml_insert', 'trg_products_ml_update', 'trg_products_history_insert', 'trg_products_history_update', 'trg_product_images_insert', 'trg_product_images_delete')) = 6"),
    '',
    '-- ---------------------------------------------------------------- renames',
    '-- The same part under another name: keep the row (product_id, sales), rename it.',
  ];
  for (const r of RENAMES) {
    out.push(
      check(`product ${r.id} is "${r.from}" (or already "${r.to}")`, `(SELECT name FROM products WHERE product_id = ${r.id}) IN (${q(r.from)}, ${q(r.to)})`),
      check(`no other product is called "${r.to}"`, `(SELECT COUNT(*) FROM products WHERE name = ${q(r.to)} AND product_id <> ${r.id}) = 0`),
      'SET @app_change_reason = @import_note;',
      `UPDATE products SET name = ${q(r.to)} WHERE product_id = ${r.id} AND name = ${q(r.from)};`,
      '',
    );
  }
  out.push('-- ---------------------------------------------------------------- products');
  products.forEach((p, i) => out.push(productSql(p, i + 1, products.length), ''));

  out.push('-- ---------------------------------------------------------------- hidden (approved)');
  for (const h of HIDE.filter((x) => x.zeroStock)) {
    out.push(
      `-- ${h.id} ${h.name} (${h.why}): stock 0, hidden`,
      check(`product ${h.id} is "${h.name}" and no unpaid order holds it`, `(SELECT COUNT(*) FROM products WHERE product_id = ${h.id} AND name = ${q(h.name)} AND reserved = 0) = 1`),
      'SET @app_change_reason = @stock_reason;',
      'INSERT INTO inventory_movements (product_id, change_qty, reason, reference, note, created_by)',
      `SELECT product_id, -CAST(stock_quantity AS SIGNED), 'correction', 'adjustment', @import_note, @app_user_id FROM products WHERE product_id = ${h.id} AND stock_quantity <> 0;`,
      `UPDATE products SET stock_quantity = 0 WHERE product_id = ${h.id};`,
      'SET @app_change_reason = @import_note;',
      `UPDATE products SET is_active = 0 WHERE product_id = ${h.id};`,
      '',
    );
  }
  const plain = HIDE.filter((x) => !x.zeroStock);
  if (plain.length) {
    out.push(
      `-- ${plain.map((h) => `${h.id} ${h.name}`).join(', ')}`,
      `-- (${plain[0].why}): hidden, stock unchanged`,
      check(`products ${plain.map((h) => h.id).join(', ')} still have the names reviewed`,
        `(SELECT COUNT(*) FROM products WHERE (product_id, name) IN (${plain.map((h) => `(${h.id}, ${q(h.name)})`).join(', ')})) = ${plain.length}`),
      'SET @app_change_reason = @import_note;',
      `UPDATE products SET is_active = 0 WHERE product_id IN (${plain.map((h) => h.id).join(', ')});`,
      '',
    );
  }

  out.push(
    '-- ---------------------------------------------------------------- final checks',
    check(`each of the ${products.length} names is on exactly one product`,
      `(SELECT COUNT(*) FROM products WHERE name IN (${names})) = ${products.length} AND (SELECT COUNT(DISTINCT name) FROM products WHERE name IN (${names})) = ${products.length}`),
    check(`${shown.length} shown with ${sum(shown)} units, ${hidden.length} hidden with ${sum(hidden)} units`,
      `(SELECT CONCAT(SUM(is_active = 1), '/', SUM(IF(is_active = 1, stock_quantity, 0)), '/', SUM(is_active = 0), '/', SUM(IF(is_active = 0, stock_quantity, 0))) FROM products WHERE name IN (${names})) = '${shown.length}/${sum(shown)}/${hidden.length}/${sum(hidden)}'`),
    ...withPhotos.map((p) => {
      const [cover, ...gallery] = p.photos.map((f) => `/uploads/${f}`);
      return check(`"${p.name}" has cover ${p.photos[0]} and ${gallery.length} gallery photo(s) in order`,
        `(SELECT CONCAT_WS('|', p.image_path, (SELECT GROUP_CONCAT(i.image_path ORDER BY i.sort_order, i.image_id SEPARATOR '|') FROM product_images i WHERE i.product_id = p.product_id)) FROM products p WHERE p.name = ${q(p.name)}) = ${q([cover, ...gallery].join('|'))}`);
    }),
    check(`the ${products.length} products have ${withPhotos.length} covers and ${galleryRows} gallery photos in all`,
      `(SELECT CONCAT(COUNT(p.image_path), '/', (SELECT COUNT(*) FROM product_images i JOIN products x ON x.product_id = i.product_id WHERE x.name IN (${names}))) FROM products p WHERE p.name IN (${names})) = '${withPhotos.length}/${galleryRows}'`),
    check(`no description among the ${products.length} is still the sales-sheet placeholder`,
      `(SELECT COUNT(*) FROM products WHERE name IN (${names}) AND description LIKE ${q(PLACEHOLDER + '%')}) = 0`),
    check('no product has more reserved than in stock', '(SELECT COUNT(*) FROM products WHERE reserved > stock_quantity) = 0'),
    '',
    'SET @app_user_id = NULL, @app_change_reason = NULL, @import_note = NULL, @stock_reason = NULL, @pid = NULL, @have = NULL, @want = NULL;',
    'COMMIT;',
    '',
  );
  return out.join('\n');
}

/* --------------------------------------------------------------- plan */
async function plan(conn, products) {
  const [rows] = await conn.query('SELECT product_id, name, stock_quantity, reserved, price, is_active, description FROM products');
  const byId = new Map(rows.map((r) => [r.product_id, r]));
  const byName = new Map(rows.map((r) => [r.name.toLowerCase(), r]));
  const problems = [];
  for (const r of RENAMES) {
    const row = byId.get(r.id);
    if (!row || ![r.from, r.to].includes(row.name)) problems.push(`product ${r.id} is "${row?.name}", expected "${r.from}"`);
    else byName.set(r.to.toLowerCase(), row);
  }
  for (const h of HIDE) {
    const row = byId.get(h.id);
    if (!row || row.name !== h.name) problems.push(`product ${h.id} is "${row?.name}", expected "${h.name}"`);
  }
  if (problems.length) throw new Error(`The database doesn't match the approved changes:\n  - ${problems.join('\n  - ')}`);

  const vis = (a) => (a ? 'shown' : 'hidden');
  const arrow = (a, b) => (String(a) === String(b) ? String(a) : `${a} -> ${b}`);
  const updated = [];
  const inserted = [];
  for (const p of products) {
    const row = byName.get(p.name.toLowerCase());
    if (!row) { inserted.push(p); continue; }
    updated.push([row.product_id, arrow(row.name, p.name), arrow(row.stock_quantity, p.stock),
      arrow(money(row.price), money(p.price)), arrow(vis(row.is_active), vis(p.active)), row.reserved,
      !row.description || row.description.startsWith(PLACEHOLDER) ? 'replaced' : 'kept']);
  }
  const hidden = HIDE.map((h) => {
    const row = byId.get(h.id);
    return [h.id, h.name, arrow(row.stock_quantity, h.zeroStock ? 0 : row.stock_quantity), money(row.price),
      arrow(vis(row.is_active), 'hidden'), row.reserved, 'kept'];
  });
  const table = (title, head, list) => {
    console.log(`\n${title}`);
    console.table(list.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]]))));
  };
  const head = ['id', 'name', 'stock', 'price', 'visibility', 'reserved', 'description'];
  table(`UPDATED IN PLACE (${updated.length})`, head, updated);
  table(`INSERTED (${inserted.length})`, ['name', 'stock', 'price', 'visibility', 'photos'],
    inserted.map((p) => [p.name, p.stock, money(p.price), vis(p.active), p.photos.length]));
  table(`HIDDEN, OUTSIDE THE SHEET (${hidden.length})`, head, hidden);
}

async function main() {
  const products = await readWorkbook();
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: arg('--database', process.env.DB_NAME),
  });
  try {
    const [admins] = await conn.query("SELECT user_id FROM users WHERE role = 'admin' AND status = 'active'");
    const adminId = Number(arg('--admin', admins.length === 1 ? admins[0].user_id : NaN));
    if (!admins.some((a) => a.user_id === adminId)) {
      throw new Error(`Choose the admin with --admin <user_id> (active admins: ${admins.map((a) => a.user_id).join(', ') || 'none'}).`);
    }
    const [[{ db }]] = await conn.query('SELECT DATABASE() AS db');
    console.log(`Workbook: ${products.length} products, ${products.flatMap((p) => p.photos).length} photos. Database: ${db}, admin ${adminId}.`);
    await plan(conn, products);
    if (args.includes('--write')) {
      fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
      fs.writeFileSync(OUTPUT, buildSql(products, adminId));
      console.log(`\nWrote ${path.relative(process.cwd(), OUTPUT)}`);
    } else {
      console.log('\nPlan only. Add --write to generate the SQL.');
    }
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
