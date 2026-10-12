jest.mock("../services/mailer", () => require("./mailerMock")());

const request = require("supertest");
const app = require("../server");
const { expireStaleOrders } = require("../jobs/expireOrders");
const { pool, resetDb, createUser, createProduct, fillCart, orderBody } = require("./helpers");

beforeEach(resetDb);
afterAll(() => pool.end());

const catalogStock = async (productId) => {
  const res = await request(app).get("/api/products");
  expect(res.status).toBe(200);
  return Number(res.body.find(p => p.id === productId).stock);
};

describe("GET /api/products shows available stock (on hand - reserved)", () => {
  test("reserved units are not shown as in stock", async () => {
    const partly = await createProduct({ stock: 5, reserved: 2 });
    const allHeld = await createProduct({ stock: 3, reserved: 3 });
    const free = await createProduct({ stock: 4, reserved: 0 });

    expect(await catalogStock(partly)).toBe(3);
    expect(await catalogStock(allHeld)).toBe(0);   // shelf has 3, all held by unpaid orders: out of stock
    expect(await catalogStock(free)).toBe(4);
  });

  test("never negative when an admin lowers stock below what's reserved", async () => {
    const productId = await createProduct({ stock: 1, reserved: 4 });
    expect(await catalogStock(productId)).toBe(0);
  });

  test("goes down when an order reserves units and back up when it expires", async () => {
    const user = await createUser();
    const productId = await createProduct({ stock: 5 });
    await fillCart(user.id, [{ productId, quantity: 5 }]);

    expect(await catalogStock(productId)).toBe(5);
    const order = await request(app).post("/api/orders").set("Authorization", user.auth).send(orderBody());
    expect(order.status).toBe(201);
    expect(await catalogStock(productId)).toBe(0);

    await pool.query("UPDATE orders SET created_at = NOW() - INTERVAL 25 HOUR");
    await expireStaleOrders();
    expect(await catalogStock(productId)).toBe(5);
  });

  test("filters still work", async () => {
    const productId = await createProduct({ stock: 2, reserved: 1 });
    const res = await request(app).get("/api/products").query({ category: "Parts", search: "Product" });
    expect(res.body.map(p => [p.id, Number(p.stock)])).toEqual([[productId, 1]]);
  });
});

describe("admin inventory shows on hand, reserved and available", () => {
  test("GET /api/admin/ml/predictions", async () => {
    const admin = await createUser({ role: "admin" });
    const productId = await createProduct({ stock: 3, reserved: 3, createdBy: admin.id });
    const res = await request(app).get("/api/admin/ml/predictions").set("Authorization", admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.find(p => p.product_id === productId))
      .toMatchObject({ stock_quantity: 3, reserved: 3, available: 0 });
  });
});
