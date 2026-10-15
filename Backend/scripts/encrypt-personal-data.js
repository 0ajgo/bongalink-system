/* =====================================================================
   scripts/encrypt-personal-data.js — one-time encryption of existing rows
   (REQ027, REQ030). Run AFTER migration 009 and AFTER a database backup.

     node scripts/encrypt-personal-data.js                      plan: counts what would change, writes nothing
     node scripts/encrypt-personal-data.js --apply --database bongalink_real
     node scripts/encrypt-personal-data.js --verify             every encrypted value decrypts; every email has its index

   --apply works one table at a time, each in its own transaction:
     1. lock the rows (SELECT ... FOR UPDATE) and keep the plain values in memory;
     2. encrypt every plain value (values already encrypted are skipped, so the script
        can be run again safely, e.g. after import_sales.py);
     3. read the rows back inside the same transaction and check that every value
        decrypts to exactly the original (and every email_bidx matches);
     4. commit only if all rows check out, otherwise roll back that table and stop.
   It also fills users.email_bidx and masks emails kept in admin_audit_log.

   Never prints a value: only table/column names and counts. Uses the keys in
   Backend/.env (DATA_ENCRYPTION_KEY, DATA_INDEX_KEY) and the database in DB_NAME.
   ===================================================================== */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const mysql = require('mysql2/promise');
const { encrypt, decrypt, blindIndex, isEncrypted, assertReady, status, DataProtectionError } = require('../lib/dataProtection');
const { ENCRYPTED_COLUMNS, maskEmail, redactForLog } = require('../lib/pii');

const PRIMARY_KEY = { users: 'user_id', orders: 'order_id', delivery_addresses: 'address_id', chat_logs: 'chat_id', admin_audit_log: 'audit_id' };
const TABLES = Object.keys(ENCRYPTED_COLUMNS);

const args = process.argv.slice(2);
const mode = args.includes('--apply') ? 'apply' : args.includes('--verify') ? 'verify' : 'plan';
const dbArg = args.includes('--database') ? args[args.indexOf('--database') + 1] : null;

const isPlain = (v) => v !== null && v !== undefined && v !== '' && !isEncrypted(v);
const auditEmailToMask = (json) => {
  const value = typeof json === 'string' ? JSON.parse(json) : json;
  return value && typeof value.email === 'string' && !value.email.includes('***') ? value : null;
};

async function connect() {
  return mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
}

async function checkSchema(conn) {
  const [[col]] = await conn.query(
    "SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'email_bidx'");
  if (!col.n) throw new Error('Migration 009 is not applied to this database (users.email_bidx is missing). Run it first.');
}

/* --------------------------------------------------------------- plan */
async function plan(conn) {
  const report = [];
  for (const table of TABLES) {
    const cols = ENCRYPTED_COLUMNS[table];
    const [rows] = await conn.query(`SELECT ${[PRIMARY_KEY[table], ...cols].join(', ')}${table === 'users' ? ', email_bidx' : ''}${table === 'admin_audit_log' ? ', old_value, new_value' : ''} FROM ${table}`);
    for (const c of cols) {
      const plain = rows.filter((r) => isPlain(r[c])).length;
      const encrypted = rows.filter((r) => isEncrypted(r[c])).length;
      report.push({ table, column: c, rows: rows.length, plain, encrypted, empty: rows.length - plain - encrypted });
    }
    if (table === 'users') report.push({ table, column: 'email_bidx (to fill)', rows: rows.length, plain: rows.filter((r) => !r.email_bidx).length, encrypted: '-', empty: '-' });
    if (table === 'admin_audit_log') {
      report.push({ table, column: 'emails inside old/new values (to mask)', rows: rows.length,
        plain: rows.filter((r) => auditEmailToMask(r.old_value) || auditEmailToMask(r.new_value)).length, encrypted: '-', empty: '-' });
    }
  }
  return report;
}

/* --------------------------------------------------------------- apply */
async function applyTable(conn, table) {
  const pk = PRIMARY_KEY[table];
  const cols = ENCRYPTED_COLUMNS[table];
  await conn.beginTransaction();
  try {
    const extra = table === 'users' ? ', email_bidx' : table === 'admin_audit_log' ? ', old_value, new_value' : '';
    const [rows] = await conn.query(`SELECT ${[pk, ...cols].join(', ')}${extra} FROM ${table} ORDER BY ${pk} FOR UPDATE`);
    const expected = new Map();   // pk -> { column: plain value } for every value that ends up encrypted
    let changedRows = 0, changedValues = 0;

    for (const row of rows) {
      const sets = {};
      const plainByColumn = {};
      for (const c of cols) {
        if (isPlain(row[c])) {
          plainByColumn[c] = String(row[c]);
          sets[c] = encrypt(row[c], `${table}.${c}`);
          changedValues++;
        } else if (isEncrypted(row[c])) {
          plainByColumn[c] = decrypt(row[c], `${table}.${c}`);   // already encrypted: must still decrypt
        }
      }
      if (table === 'users') {
        const email = plainByColumn.email;
        const index = email ? blindIndex(email) : null;
        if (index && row.email_bidx !== index) { sets.email_bidx = index; changedValues++; }
        plainByColumn.email_bidx = index;
      }
      if (table === 'admin_audit_log') {
        for (const c of ['old_value', 'new_value']) {
          const value = auditEmailToMask(row[c]);
          if (value) { sets[c] = JSON.stringify({ ...value, email: maskEmail(value.email) }); changedValues++; }
        }
      }
      expected.set(row[pk], plainByColumn);
      if (Object.keys(sets).length) {
        await conn.query(`UPDATE ${table} SET ? WHERE ${pk} = ?`, [sets, row[pk]]);
        changedRows++;
      }
    }

    // Read back inside the same transaction: every value must decrypt to the original.
    const [after] = await conn.query(`SELECT ${[pk, ...cols].join(', ')}${extra} FROM ${table} ORDER BY ${pk}`);
    let checked = 0;
    for (const row of after) {
      const want = expected.get(row[pk]);
      for (const c of cols) {
        if (row[c] === null || row[c] === '') continue;
        if (!isEncrypted(row[c])) throw new Error(`${table}.${c} row ${pk}=${row[pk]} is still plain`);
        if (decrypt(row[c], `${table}.${c}`) !== want[c]) throw new Error(`${table}.${c} row ${pk}=${row[pk]} does not decrypt to its original`);
        checked++;
      }
      if (table === 'users' && row.email_bidx !== want.email_bidx) throw new Error(`users.email_bidx row ${pk}=${row[pk]} is wrong`);
      if (table === 'admin_audit_log' && (auditEmailToMask(row.old_value) || auditEmailToMask(row.new_value))) {
        throw new Error(`admin_audit_log row ${pk}=${row[pk]} still has an unmasked email`);
      }
    }
    await conn.commit();
    return { table, rows: rows.length, changedRows, changedValues, checked };
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') err.message = 'Two accounts have the same email (ignoring upper/lower case). Fix one of them and run again.';
    throw Object.assign(err, { table });
  }
}

/* --------------------------------------------------------------- verify */
async function verify(conn) {
  const problems = [];
  const counts = [];
  for (const table of TABLES) {
    const pk = PRIMARY_KEY[table];
    const cols = ENCRYPTED_COLUMNS[table];
    const [rows] = await conn.query(`SELECT ${[pk, ...cols].join(', ')}${table === 'users' ? ', email_bidx' : ''} FROM ${table}`);
    let ok = 0;
    for (const row of rows) {
      for (const c of cols) {
        if (row[c] === null || row[c] === '') continue;
        if (!isEncrypted(row[c])) { problems.push(`${table}.${c} ${pk}=${row[pk]}: not encrypted`); continue; }
        try {
          const value = decrypt(row[c], `${table}.${c}`);
          if (table === 'users' && c === 'email' && row.email_bidx !== blindIndex(value)) problems.push(`users.email_bidx ${pk}=${row[pk]}: does not match`);
          ok++;
        } catch (err) {
          problems.push(`${table}.${c} ${pk}=${row[pk]}: ${err instanceof DataProtectionError ? 'does not decrypt' : err.message}`);
        }
      }
    }
    counts.push({ table, rows: rows.length, values_decrypted: ok });
  }
  return { counts, problems };
}

/* --------------------------------------------------------------- main */
(async () => {
  try {
    assertReady();
  } catch (err) {
    console.error(`Encryption keys: ${err.message}`);
    process.exit(1);
  }
  const db = process.env.DB_NAME;
  if (!db) { console.error('DB_NAME is not set in Backend/.env'); process.exit(1); }
  if (mode === 'apply' && dbArg !== db) {
    console.error(`--apply needs --database ${db} (the database in Backend/.env), to be sure it's the one you backed up.`);
    process.exit(1);
  }
  const conn = await connect();
  try {
    await checkSchema(conn);
    const s = status();
    console.log(`Database ${db} on ${process.env.DB_HOST}:${process.env.DB_PORT || 3306}; ${s.algorithm}, key v${s.version}.`);
    if (mode === 'plan') {
      console.log('PLAN (nothing is written):');
      console.table(await plan(conn));
      console.log('To encrypt: node scripts/encrypt-personal-data.js --apply --database ' + db);
    } else if (mode === 'apply') {
      for (const table of TABLES) {
        const r = await applyTable(conn, table);
        console.log(`  ${r.table}: ${r.changedValues} value(s) in ${r.changedRows} of ${r.rows} row(s) encrypted; ${r.checked} value(s) checked; committed.`);
      }
      const { counts, problems } = await verify(conn);
      console.table(counts);
      if (problems.length) { console.error(`VERIFY FAILED:\n  ${problems.join('\n  ')}`); process.exitCode = 1; }
      else console.log('Verified: every encrypted value decrypts, every email has its index.');
    } else {
      const { counts, problems } = await verify(conn);
      console.table(counts);
      if (problems.length) { console.error(`VERIFY FAILED:\n  ${problems.join('\n  ')}`); process.exitCode = 1; }
      else console.log('Verified: every encrypted value decrypts, every email has its index.');
    }
  } catch (err) {
    console.error(`${err.table ? `${err.table}: rolled back. ` : ''}${redactForLog(err.message)}`);
    process.exitCode = 1;
  } finally {
    await conn.end();
  }
})();
