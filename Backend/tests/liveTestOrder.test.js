// Backend/database/imports/remove_live_test_order.sql: takes one paid test order out of the
// sales (with everything that depends on it), refuses an order with a part still shown in the
// shop, and leaves stock and every other order alone.
jest.mock("../services/mailer", () => require("./mailerMock")());

const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");
const request = require("supertest");
const app = require("../server");
const { pool, resetDb, createUser, createProduct, fillCart, orderBody } = require("./helpers");

const TEMPLATE = fs.readFileSync(path.join(__dirname, "..", "database", "imports", "remove_live_test_order.sql"), "utf8");
const withOrder = (id) => {
  expect(TEMPLATE).toContain("SET @order_id = 0;");
  return TEMPLATE.replace("SET @order_id = 0;", `SET @order_id = ${Number(id)};`);
};
let conn;
beforeAll(async () => {
  conn = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, multipleStatements: true });
});
afterAll(async () => { await conn.end(); await pool.end(); });
beforeEach(resetDb);

// A paid order for `productId` (placed through the API, then marked paid as the webhook would).
async function paidOrder(user, productId) {
  await fillCart(user.id, [{ productId, quantity: 1 }]);
  const { orderId } = (await request(app).post("/api/orders").set("Authorization", user.auth).send(orderBody())).body;
  await pool.query("UPDATE orders SET status = 'paid', paid_at = NOW() WHERE order_id = ?", [orderId]);
  await pool.query("INSERT INTO payments (order_id, checkout_session_id, amount_centavos, status) VALUES (?, ?, 10900, 'paid')", [orderId, `cs_${orderId}`]);
  await pool.query("INSERT INTO inventory_movements (product_id, change_qty, reason, reference) VALUES (?, -1, 'sale', ?)", [productId, `order:${orderId}`]);
  return orderId;
}

test("removes the test order and what depends on it; stock and the real order stay", async () => {
  const user = await createUser();
  const testProduct = await createProduct({ stock: 3 });
  const realProduct = await createProduct({ stock: 5 });
  const testOrder = await paidOrder(user, testProduct);
  const realOrder = await paidOrder(user, realProduct);
  await pool.query("UPDATE products SET is_active = 0 WHERE product_id = ?", [testProduct]);   // hidden again
  const [[before]] = await pool.query("SELECT stock_quantity, reserved FROM products WHERE product_id = ?", [testProduct]);

  await conn.query(withOrder(testOrder));

  const count = async (sql, id) => (await pool.query(sql, [id]))[0][0].n;
  for (const [table, sql] of [["orders", "SELECT COUNT(*) n FROM orders WHERE order_id = ?"],
    ["order_items", "SELECT COUNT(*) n FROM order_items WHERE order_id = ?"],
    ["deliveries", "SELECT COUNT(*) n FROM deliveries WHERE order_id = ?"],
    ["payments", "SELECT COUNT(*) n FROM payments WHERE order_id = ?"]]) {
    expect({ table, n: await count(sql, testOrder) }).toEqual({ table, n: 0 });
  }
  expect(await count("SELECT COUNT(*) n FROM inventory_movements WHERE reference = CONCAT('order:', ?)", testOrder)).toBe(0);
  expect(await count("SELECT COUNT(*) n FROM orders WHERE order_id = ?", realOrder)).toBe(1);
  expect(await count("SELECT COUNT(*) n FROM payments WHERE order_id = ?", realOrder)).toBe(1);
  const [[after]] = await pool.query("SELECT stock_quantity, reserved FROM products WHERE product_id = ?", [testProduct]);
  expect(after).toEqual(before);
});

test("refuses an order with a part still shown in the shop, and changes nothing", async () => {
  const user = await createUser();
  const shown = await createProduct({ stock: 3 });
  const orderId = await paidOrder(user, shown);
  await expect(conn.query(withOrder(orderId))).rejects.toThrow(/Subquery returns more than 1 row/);
  await conn.query("ROLLBACK");
  expect((await pool.query("SELECT COUNT(*) n FROM orders WHERE order_id = ?", [orderId]))[0][0].n).toBe(1);
  expect((await pool.query("SELECT COUNT(*) n FROM payments WHERE order_id = ?", [orderId]))[0][0].n).toBe(1);
});

test("the template ships with order 0, which matches nothing and is refused", async () => {
  await expect(conn.query(TEMPLATE)).rejects.toThrow(/Subquery returns more than 1 row/);
  await conn.query("ROLLBACK");
});
