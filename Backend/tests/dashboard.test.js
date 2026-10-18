jest.mock("../services/mailer", () => require("./mailerMock")());

const request = require("supertest");
const app = require("../server");
const { pool, resetDb, createUser, createProduct } = require("./helpers");

let admin, customer;

// Runs a query with the session in the given time zone (Philippine time by default, like the dashboard).
async function inZone(sql, params = [], zone = "+08:00") {
  const conn = await pool.getConnection();
  try {
    await conn.query("SET time_zone = ?", [zone]);
    const [rows] = await conn.query(sql, params);
    return rows;
  } finally {
    await conn.query("SET time_zone = DEFAULT");
    conn.release();
  }
}

// An order straight into the tables. `at` is a Philippine date-time ("2026-10-13 00:00:00");
// without it, noon `daysAgo` days ago.
async function sale(productId, { quantity = 1, price, status = "paid", daysAgo = 1, at, zone = "+08:00" }) {
  const created = at ? "?" : "CURDATE() - INTERVAL ? DAY + INTERVAL 12 HOUR";
  const o = await inZone(`INSERT INTO orders (user_id, status, total_amount, created_at) VALUES (?, ?, ?, ${created})`,
    [customer.id, status, quantity * price, at ?? daysAgo], zone);
  await pool.query("INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)",
    [o.insertId, productId, quantity, price]);
}

// Calendar helpers on "YYYY-MM-DD" (UTC dates), independent of the code under test.
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const addMonths = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
const mondayOf = (day) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
const lastSecondBefore = (day) => `${addDays(day, -1)} 23:59:59`;

async function phToday() {
  const [{ today }] = await inZone("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today");
  return today;
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
    const { trend, top_products, days, group, range } = res.body;
    expect([group, range, days]).toEqual(["day", 30, 30]);
    expect(trend).toHaveLength(30);
    expect(trend.at(-1)).toEqual({ day: addDays(await phToday(), -1), units: 7, revenue: 1500 });   // yesterday
    expect(trend.at(-2)).toEqual({ day: expect.any(String), units: 0, revenue: 0 });
    expect(trend.at(-3)).toMatchObject({ units: 1, revenue: 100 });
    expect(top_products.map(t => [t.product_id, t.units, t.revenue])).toEqual([[ink, 6, 600], [fuser, 2, 1000]]);

    // This month: whichever of those paid sales fall in the current calendar month.
    const [expected] = await inZone(
      `SELECT COUNT(DISTINCT o.order_id) AS orders, COALESCE(SUM(oi.quantity),0) AS units
       FROM orders o JOIN order_items oi USING (order_id)
       WHERE o.status IN ('paid','delivered','completed') AND o.created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`);
    expect(res.body.month).toMatchObject({ orders: Number(expected.orders), units: Number(expected.units) });

    const longer = await dashboard("?days=90");
    expect(longer.body.trend).toHaveLength(90);
    expect(longer.body.top_products.find(t => t.product_id === ink).units).toBe(13);
  });

  test("revenue tiles: today, this week (from Monday) and this month, each vs the previous whole period", async () => {
    const part = await createProduct({ price: 1, createdBy: admin.id });
    const today = await phToday();
    const monday = mondayOf(today);
    const first = `${today.slice(0, 8)}01`;
    // [Philippine time, revenue]; each amount is different so every total says which orders it counted.
    const orders = [
      [`${today} 00:00:00`, 1], [lastSecondBefore(today), 2],                       // first second of today / last of yesterday
      [`${addDays(today, -1)} 00:00:00`, 4], [lastSecondBefore(addDays(today, -1)), 8],
      [`${monday} 00:00:00`, 16], [lastSecondBefore(monday), 32],                     // week boundary
      [`${addDays(monday, -7)} 00:00:00`, 64], [lastSecondBefore(addDays(monday, -7)), 128],
      [`${first} 00:00:00`, 256], [lastSecondBefore(first), 512],                     // month boundary
      [`${addMonths(first, -1)} 00:00:00`, 1024], [lastSecondBefore(addMonths(first, -1)), 2048]
    ];
    for (const [at, price] of orders) await sale(part, { price, at });
    for (const status of ["pending_payment", "expired", "cancelled"]) await sale(part, { price: 100000, at: `${today} 00:00:00`, status });

    const sum = (from, to) => orders.filter(([at]) => at >= from && at < to).reduce((s, [, p]) => s + p, 0);
    const tile = (from, next, previous) => {
      const revenue = sum(from, next), before = sum(previous, from);
      return { revenue, previous_revenue: before, start: from,
               change_pct: before ? Math.round(((revenue - before) / before) * 1000) / 10 : null,
               orders: orders.filter(([at]) => at >= from && at < next).length };
    };

    const res = await dashboard();
    expect(res.status).toBe(200);
    expect(res.body.today).toBe(today);
    expect(res.body.sales.today).toMatchObject(tile(today, addDays(today, 1), addDays(today, -1)));
    expect(res.body.sales.week).toMatchObject(tile(monday, addDays(monday, 7), addDays(monday, -7)));
    expect(res.body.sales.month).toMatchObject(tile(first, addMonths(first, 1), addMonths(first, -1)));
    // The first second of a period belongs to it; the last second before it to the previous one.
    expect(res.body.sales.today.revenue % 2).toBe(1);
    expect(res.body.sales.week.start).toBe(monday);
    expect(new Date(`${monday}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(res.body.month).toEqual({ orders: res.body.sales.month.orders, units: res.body.sales.month.units, revenue: res.body.sales.month.revenue });
  });

  test("no sales in the previous period: the change is null, not a division by zero", async () => {
    const part = await createProduct({ price: 250, createdBy: admin.id });
    await sale(part, { price: 250, at: `${await phToday()} 00:00:00` });
    const { sales } = (await dashboard()).body;
    expect(sales.today).toMatchObject({ revenue: 250, orders: 1, units: 1, previous_revenue: 0, change_pct: null });
  });

  test("days follow Philippine time even when the order was written in UTC", async () => {
    const part = await createProduct({ price: 10, createdBy: admin.id });
    const today = await phToday();
    // 00:30 in Manila today is 16:30 UTC yesterday.
    await sale(part, { price: 10, at: `${addDays(today, -1)} 16:30:00`, zone: "+00:00" });
    // 23:30 in Manila yesterday is 15:30 UTC yesterday.
    await sale(part, { price: 3, at: `${addDays(today, -1)} 15:30:00`, zone: "+00:00" });
    const { sales, trend } = (await dashboard()).body;
    expect(sales.today.revenue).toBe(10);
    expect(sales.today.previous_revenue).toBe(3);
    expect(trend.at(-1)).toEqual({ day: addDays(today, -1), units: 1, revenue: 3 });
  });

  test("weekly trend: ISO weeks from Monday, zero-filled, boundary orders in the right week, current week left out", async () => {
    const part = await createProduct({ price: 1, createdBy: admin.id });
    const monday = mondayOf(await phToday());
    const lastWeek = addDays(monday, -7);
    await sale(part, { price: 100, at: `${monday} 00:00:00` });               // current week: left out
    await sale(part, { price: 10, at: lastSecondBefore(monday) });            // Sunday 23:59:59: last week
    await sale(part, { price: 20, at: `${lastWeek} 00:00:00` });              // Monday 00:00: last week
    await sale(part, { price: 40, at: lastSecondBefore(lastWeek) });          // the week before
    await sale(part, { price: 80, at: `${addDays(monday, -70)} 12:00:00` });  // 10 weeks ago
    await sale(part, { price: 999, at: `${lastWeek} 09:00:00`, status: "pending_payment" });
    await sale(part, { price: 999, at: `${lastWeek} 09:00:00`, status: "expired" });
    await sale(part, { price: 999, at: `${lastWeek} 09:00:00`, status: "cancelled" });

    const res = await dashboard("?group=week&range=12");
    expect(res.status).toBe(200);
    const { trend, group, range, from, to } = res.body;
    expect([group, range, from, to]).toEqual(["week", 12, addDays(monday, -84), monday]);
    expect(trend.map(t => t.day)).toEqual(Array.from({ length: 12 }, (_, i) => addDays(monday, -7 * (12 - i))));
    expect(trend.map(t => t.revenue)).toEqual([0, 0, 80, 0, 0, 0, 0, 0, 0, 0, 40, 30]);
    expect(trend.at(-1)).toEqual({ day: lastWeek, units: 2, revenue: 30 });
    expect(res.body.top_products).toEqual([expect.objectContaining({ product_id: part, units: 4, revenue: 150 })]);

    expect((await dashboard("?group=week&range=52")).body.trend).toHaveLength(52);
    expect((await dashboard("?group=week&range=26")).body.trend).toHaveLength(26);
  });

  test("monthly trend: calendar months, zero-filled, boundary orders in the right month, current month left out", async () => {
    const part = await createProduct({ price: 1, createdBy: admin.id });
    const first = `${(await phToday()).slice(0, 8)}01`;
    const lastMonth = addMonths(first, -1);
    await sale(part, { price: 100, at: `${first} 00:00:00` });                // this month: left out
    await sale(part, { price: 10, at: lastSecondBefore(first) });             // last day of last month, 23:59:59
    await sale(part, { price: 20, at: `${lastMonth} 00:00:00` });             // first second of last month
    await sale(part, { price: 40, at: `${addMonths(first, -4)} 12:00:00` });
    await sale(part, { price: 999, at: `${lastMonth} 09:00:00`, status: "pending_payment" });
    await sale(part, { price: 999, at: `${lastMonth} 09:00:00`, status: "expired" });

    const res = await dashboard("?group=month&range=6");
    const { trend, group, range, from, to } = res.body;
    expect([group, range, from, to]).toEqual(["month", 6, addMonths(first, -6), first]);
    expect(trend.map(t => t.day)).toEqual(Array.from({ length: 6 }, (_, i) => addMonths(first, i - 6)));
    expect(trend.map(t => t.revenue)).toEqual([0, 0, 40, 0, 0, 30]);
    expect(trend.at(-1)).toEqual({ day: lastMonth, units: 2, revenue: 30 });

    expect((await dashboard("?group=month&range=24")).body.trend).toHaveLength(24);
  });

  test("unknown groupings and ranges fall back to the defaults", async () => {
    expect((await dashboard("?group=year")).body).toMatchObject({ group: "day", range: 30 });
    expect((await dashboard("?group=week&range=7")).body).toMatchObject({ group: "week", range: 12 });
    expect((await dashboard("?group=month&days=90")).body).toMatchObject({ group: "month", range: 6 });
    expect((await dashboard("?days=180")).body).toMatchObject({ group: "day", range: 180, days: 180 });
  });

  test("admin only", async () => {
    expect((await request(app).get("/api/admin/ml/dashboard").set("Authorization", customer.auth)).status).toBe(403);
    expect((await request(app).get("/api/admin/ml/dashboard")).status).toBe(401);
  });
});
