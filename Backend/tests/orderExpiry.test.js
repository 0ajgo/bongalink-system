jest.mock("../services/mailer", () => require("./mailerMock")());

const request = require("supertest");
const app = require("../server");
const paymongo = require("../services/paymongo");
const { expireStaleOrders } = require("../jobs/expireOrders");
const { pool, resetDb, createUser, createProduct, fillCart, orderBody, product, paymongoEvent } = require("./helpers");

let user, productId;

async function placeOrder(quantity) {
  await fillCart(user.id, [{ productId, quantity }]);
  const res = await request(app).post("/api/orders").set("Authorization", user.auth).send(orderBody());
  expect(res.status).toBe(201);
  return res.body.orderId;
}

beforeEach(async () => {
  await resetDb();
  jest.restoreAllMocks();
  user = await createUser();
  productId = await createProduct({ stock: 10, price: 100 });
});
afterAll(() => pool.end());

describe("order expiry job", () => {
  test("expires unpaid orders older than 24h, releases stock and logs it", async () => {
    const oldOrder = await placeOrder(3);
    const freshOrder = await placeOrder(2);
    expect(await product(productId)).toEqual({ stock_quantity: 10, reserved: 5 });

    await pool.query("UPDATE orders SET created_at = NOW() - INTERVAL 25 HOUR WHERE order_id = ?", [oldOrder]);
    expect(await expireStaleOrders()).toBe(1);

    const [orders] = await pool.query("SELECT order_id, status FROM orders ORDER BY order_id");
    expect(orders).toEqual([
      { order_id: oldOrder, status: "expired" },
      { order_id: freshOrder, status: "pending_payment" }
    ]);
    expect(await product(productId)).toEqual({ stock_quantity: 10, reserved: 2 });

    const [moves] = await pool.query("SELECT product_id, change_qty, reason, reference FROM inventory_movements");
    expect(moves).toEqual([{ product_id: productId, change_qty: 3, reason: "reservation_release", reference: `order:${oldOrder}` }]);

    // Running again changes nothing.
    expect(await expireStaleOrders()).toBe(0);
    expect(await product(productId)).toEqual({ stock_quantity: 10, reserved: 2 });
  });

  test("paid orders are never expired", async () => {
    const orderId = await placeOrder(1);
    await pool.query("UPDATE orders SET status = 'paid', created_at = NOW() - INTERVAL 3 DAY WHERE order_id = ?", [orderId]);
    expect(await expireStaleOrders()).toBe(0);
  });

  test("a payment arriving after expiry is flagged for review, stock not deducted", async () => {
    const orderId = await placeOrder(1);
    jest.spyOn(paymongo, "createCheckoutSession").mockResolvedValue({ id: "cs_late", checkoutUrl: "https://x" });
    await request(app).post("/api/v1/payments/checkout").set("Authorization", user.auth).send({ order_id: orderId });

    await pool.query("UPDATE orders SET created_at = NOW() - INTERVAL 25 HOUR");
    await expireStaleOrders();

    const { body, signature } = paymongoEvent({ sessionId: "cs_late", amount: 20000 });
    const res = await request(app).post("/api/v1/webhooks/paymongo")
      .set("Content-Type", "application/json").set("Paymongo-Signature", signature).send(body);
    expect(res.status).toBe(200);

    const [[p]] = await pool.query("SELECT status, review_reason FROM payments");
    expect(p.status).toBe("review");
    expect(p.review_reason).toMatch(/expired/);
    expect(await product(productId)).toEqual({ stock_quantity: 10, reserved: 0 });
  });
});
