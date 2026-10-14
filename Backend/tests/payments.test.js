jest.mock("../services/mailer", () => require("./mailerMock")());

const request = require("supertest");
const app = require("../server");
const paymongo = require("../services/paymongo");
const { mail } = require("../services/mailer");
const { pool, resetDb, createUser, createProduct, fillCart, orderBody, product, paymongoEvent } = require("./helpers");

let user, productId, orderId;

// Places an order (2 x ₱499.50 + ₱100 J&T) and opens a mocked PayMongo checkout.
beforeEach(async () => {
  await resetDb();
  jest.restoreAllMocks();
  jest.clearAllMocks();
  user = await createUser();
  productId = await createProduct({ price: 499.5, stock: 5 });
  await fillCart(user.id, [{ productId, quantity: 2 }]);
  orderId = (await request(app).post("/api/orders").set("Authorization", user.auth).send(orderBody())).body.orderId;

  jest.spyOn(paymongo, "createCheckoutSession")
    .mockResolvedValue({ id: "cs_test_1", checkoutUrl: "https://checkout.paymongo.com/cs_test_1" });
  await request(app).post("/api/v1/payments/checkout").set("Authorization", user.auth).send({ order_id: orderId });
});
afterAll(() => pool.end());

const sendWebhook = (body, signature) =>
  request(app).post("/api/v1/webhooks/paymongo")
    .set("Content-Type", "application/json")
    .set("Paymongo-Signature", signature)
    .send(body);

describe("POST /api/v1/payments/checkout", () => {
  test("builds line items in centavos from the database", () => {
    expect(paymongo.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({
      referenceNumber: `BL-${orderId}`,
      lineItems: [
        { name: expect.any(String), quantity: 2, amount: 49950, currency: "PHP" },
        { name: "Shipping fee", quantity: 1, amount: 10000, currency: "PHP" }
      ],
      customer: { name: "Juan Dela Cruz", email: "buyer@example.com", phone: "09171234567" },
      successUrl: `http://localhost:5500/Pages/COpage/checkout.html?order=${orderId}&payment=success`
    }));
  });

  test("return URLs point at the real checkout page when APP_URL includes the Frontend folder", async () => {
    const saved = process.env.APP_URL;
    process.env.APP_URL = "http://localhost:5500/Frontend/"; // Live Server on the repo root; trailing slash tolerated
    try {
      paymongo.createCheckoutSession.mockResolvedValueOnce({ id: "cs_test_2", checkoutUrl: "https://x" });
      const res = await request(app).post("/api/v1/payments/checkout").set("Authorization", user.auth).send({ order_id: orderId });
      expect(res.status).toBe(200);
      expect(paymongo.createCheckoutSession).toHaveBeenLastCalledWith(expect.objectContaining({
        successUrl: `http://localhost:5500/Frontend/Pages/COpage/checkout.html?order=${orderId}&payment=success`,
        cancelUrl: `http://localhost:5500/Frontend/Pages/COpage/checkout.html?order=${orderId}&payment=cancelled`
      }));
    } finally {
      process.env.APP_URL = saved;
    }
  });

  test("stores a pending payment for the full amount", async () => {
    const [[p]] = await pool.query("SELECT order_id, amount_centavos, status FROM payments");
    expect(p).toEqual({ order_id: orderId, amount_centavos: 109900, status: "pending" });
  });

  test("another customer can't pay for this order", async () => {
    const other = await createUser();
    const res = await request(app).post("/api/v1/payments/checkout").set("Authorization", other.auth).send({ order_id: orderId });
    expect(res.status).toBe(404);
  });

  test("a PayMongo failure is a 502 with its message", async () => {
    paymongo.createCheckoutSession.mockRejectedValue(new paymongo.PaymentError("Payment method not activated"));
    jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(app).post("/api/v1/payments/checkout").set("Authorization", user.auth).send({ order_id: orderId });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Payment method not activated");
  });
});

describe("POST /api/v1/webhooks/paymongo", () => {
  test("valid signature: order paid, reservation becomes a deduction, customer emailed", async () => {
    const { body, signature } = paymongoEvent({ amount: 109900 });
    const res = await sendWebhook(body, signature);
    expect(res.status).toBe(200);

    const [[order]] = await pool.query("SELECT status, paid_at FROM orders");
    expect(order.status).toBe("paid");
    expect(order.paid_at).not.toBeNull();
    expect(await product(productId)).toEqual({ stock_quantity: 3, reserved: 0 });

    const [[p]] = await pool.query("SELECT status, method_used, provider_payment_id FROM payments");
    expect(p).toEqual({ status: "paid", method_used: "gcash", provider_payment_id: "pay_1" });

    const [moves] = await pool.query("SELECT product_id, change_qty, reason, reference FROM inventory_movements");
    expect(moves).toEqual([{ product_id: productId, change_qty: -2, reason: "sale", reference: `order:${orderId}` }]);

    // The 003 trigger logged the stock change for the ML worker.
    const [events] = await pool.query("SELECT event_type, old_value, new_value FROM ml_events WHERE event_type = 'STOCK_CHANGED'");
    expect(events).toEqual([{ event_type: "STOCK_CHANGED", old_value: "5.00", new_value: "3.00" }]);

    expect(mail.paymentReceived).toHaveBeenCalledWith("buyer@example.com", user.username, orderId, 1099);

    const status = await request(app).get(`/api/v1/payments/orders/${orderId}`).set("Authorization", user.auth);
    expect(status.body).toMatchObject({ order_status: "paid", payment: { status: "paid", method_used: "gcash" } });
  });

  test("tampered body: 401 and nothing changes", async () => {
    const { body, signature } = paymongoEvent({ amount: 109900 });
    const tampered = body.replace("109900", "100");
    const res = await sendWebhook(tampered, signature);
    expect(res.status).toBe(401);

    const [[order]] = await pool.query("SELECT status FROM orders");
    expect(order.status).toBe("pending_payment");
    expect(await product(productId)).toEqual({ stock_quantity: 5, reserved: 2 });
    const [events] = await pool.query("SELECT * FROM payment_events");
    expect(events).toHaveLength(0);
  });

  test("wrong secret or missing header: 401", async () => {
    const { body } = paymongoEvent({ amount: 109900 });
    const forged = require("./helpers").signPaymongo(body, "whsk_attacker");
    expect((await sendWebhook(body, forged)).status).toBe(401);
    expect((await request(app).post("/api/v1/webhooks/paymongo").set("Content-Type", "application/json").send(body)).status).toBe(401);
  });

  test("duplicate event: processed once, stock deducted once", async () => {
    const { body, signature } = paymongoEvent({ amount: 109900 });
    expect((await sendWebhook(body, signature)).status).toBe(200);
    expect((await sendWebhook(body, signature)).status).toBe(200);

    expect(await product(productId)).toEqual({ stock_quantity: 3, reserved: 0 });
    const [moves] = await pool.query("SELECT * FROM inventory_movements");
    expect(moves).toHaveLength(1);
    const [events] = await pool.query("SELECT * FROM payment_events");
    expect(events).toHaveLength(1);
    expect(mail.paymentReceived).toHaveBeenCalledTimes(1);
  });

  test("amount mismatch: payment flagged for review, order stays unpaid", async () => {
    const { body, signature } = paymongoEvent({ amount: 100 });
    expect((await sendWebhook(body, signature)).status).toBe(200);

    const [[p]] = await pool.query("SELECT status, review_reason FROM payments");
    expect(p.status).toBe("review");
    expect(p.review_reason).toMatch(/Amount mismatch/);
    const [[order]] = await pool.query("SELECT status FROM orders");
    expect(order.status).toBe("pending_payment");
    expect(await product(productId)).toEqual({ stock_quantity: 5, reserved: 2 });

    const admin = await createUser({ role: "admin" });
    const review = await request(app).get("/api/v1/payments/admin/review").set("Authorization", admin.auth);
    expect(review.body).toHaveLength(1);
    const denied = await request(app).get("/api/v1/payments/admin/review").set("Authorization", user.auth);
    expect(denied.status).toBe(403);
  });
});
