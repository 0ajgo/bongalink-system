jest.mock("../services/mailer", () => require("./mailerMock")());

const request = require("supertest");
const app = require("../server");
const { pool, resetDb, createUser, createProduct } = require("./helpers");

let admin, customer;

// An order placed `daysAgo` days ago (noon), straight into the tables.
async function sale(productId, { quantity, price, status = "paid", daysAgo = 1 }) {
  const [o] = await pool.query(
    `INSERT INTO orders (user_id, status, total_amount, created_at)
     VALUES (?, ?, ?, CURDATE() - INTERVAL ? DAY + INTERVAL 12 HOUR)`,
    [customer.id, status, quantity * price, daysAgo]
  );
  await pool.query("INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)",
    [o.insertId, productId, quantity, price]);
}

const dashboard = (query = "") =>
  request(app).get(`/api/admin/ml/dashboard${query}`).set("Authorization", admin.auth);

beforeEach(async () => {
  await resetDb();
  admin = await createUser({ role: "admin" });
  customer = await createUser();
});
afterAll(() => pool.end());

describe("GET /api/admin/ml/dashboard", () => {
  test("stock counts use available stock", async () => {
    await createProduct({ stock: 10, createdBy: admin.id });              // in stock
    await createProduct({ stock: 5, reserved: 3, createdBy: admin.id });  // 2 available: low
    await createProduct({ stock: 3, createdBy: admin.id });               // 3 available: low (threshold)
    await createProduct({ stock: 4, reserved: 4, createdBy: admin.id });  // 0 available: out
    const removed = await createProduct({ stock: 0, createdBy: admin.id });
    await pool.query("UPDATE products SET is_active = 0 WHERE product_id = ?", [removed]);

    const res = await dashboard();
    expect(res.status).toBe(200);
    expect(res.body.stock).toEqual({ active_products: 4, low_stock: 2, out_of_stock: 1 });
    expect(res.body.low_stock_threshold).toBe(3);
  });

  test("sales trend, month totals and top products count only paid orders", async () => {
    const fuser = await createProduct({ price: 500, createdBy: admin.id });
    const ink = await createProduct({ price: 100, createdBy: admin.id });
    await sale(fuser, { quantity: 2, price: 500, daysAgo: 1 });
    await sale(ink, { quantity: 5, price: 100, daysAgo: 1, status: "delivered" });
    await sale(ink, { quantity: 1, price: 100, daysAgo: 3, status: "completed" });
    await sale(fuser, { quantity: 9, price: 500, daysAgo: 2, status: "pending_payment" });   // not a sale
    await sale(fuser, { quantity: 9, price: 500, daysAgo: 2, status: "expired" });           // not a sale
    await sale(ink, { quantity: 7, price: 100, daysAgo: 40 });                               // outside 30 days

    const res = await dashboard();
    const { trend, top_products, days } = res.body;
    expect(days).toBe(30);
    expect(trend).toHaveLength(30);
    expect(trend.at(-1)).toEqual({ day: expect.any(String), units: 7, revenue: 1500 });   // yesterday
    expect(trend.at(-2)).toEqual({ day: expect.any(String), units: 0, revenue: 0 });
    expect(trend.at(-3)).toMatchObject({ units: 1, revenue: 100 });
    expect(top_products.map(t => [t.product_id, t.units, t.revenue])).toEqual([[ink, 6, 600], [fuser, 2, 1000]]);

    // This month: whichever of those paid sales fall in the current calendar month.
    const [[expected]] = await pool.query(
      `SELECT COUNT(DISTINCT o.order_id) AS orders, COALESCE(SUM(oi.quantity),0) AS units
       FROM orders o JOIN order_items oi USING (order_id)
       WHERE o.status IN ('paid','delivered','completed') AND o.created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`);
    expect(res.body.month).toMatchObject({ orders: Number(expected.orders), units: Number(expected.units) });

    const longer = await dashboard("?days=90");
    expect(longer.body.trend).toHaveLength(90);
    expect(longer.body.top_products.find(t => t.product_id === ink).units).toBe(13);
  });

  test("admin only", async () => {
    expect((await request(app).get("/api/admin/ml/dashboard").set("Authorization", customer.auth)).status).toBe(403);
    expect((await request(app).get("/api/admin/ml/dashboard")).status).toBe(401);
  });
});
