// Backend/database/seed_data.sql loads on the current schema (after every migration), gives a
// fresh install its categories and the hidden test products, and can run twice.
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const { pool, resetDb, createUser } = require("./helpers");

const SEED = fs.readFileSync(path.join(__dirname, "..", "database", "seed_data.sql"), "utf8");
let conn;
beforeAll(async () => {
  conn = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, multipleStatements: true });
});
afterAll(async () => { await conn.end(); await pool.end(); });
beforeEach(resetDb);

test("categories plus 4 hidden test products with 3 in stock each; no whole printers; runs twice", async () => {
  const admin = await createUser({ role: "admin" });
  await conn.query(SEED);
  await conn.query(SEED);

  const [cats] = await pool.query("SELECT name FROM categories ORDER BY name");
  expect(cats.map((c) => c.name)).toEqual(expect.arrayContaining(
    ["Accessories", "Computer Parts", "Electronics", "Laptop Parts", "Other", "Printer Parts"]));
  const [rows] = await pool.query(
    "SELECT p.name, c.name AS category, p.stock_quantity, p.reserved, p.is_active, p.created_by FROM products p JOIN categories c USING (category_id) ORDER BY p.product_id");
  expect(rows).toEqual([
    { name: "Iphone13", category: "Electronics", stock_quantity: 3, reserved: 0, is_active: 0, created_by: admin.id },
    { name: "Camel", category: "Other", stock_quantity: 3, reserved: 0, is_active: 0, created_by: admin.id },
    { name: "Iphone13 (test 2)", category: "Accessories", stock_quantity: 3, reserved: 0, is_active: 0, created_by: admin.id },
    { name: "electric fan", category: "Electronics", stock_quantity: 3, reserved: 0, is_active: 0, created_by: admin.id },
  ]);
  expect(rows.some((r) => /printer/i.test(r.name))).toBe(false);
});
