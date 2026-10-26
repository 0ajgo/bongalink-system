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
  // Asking again looks up the open session first; unless a test says otherwise it has expired,
  // so a new one is made. (Tests never call the real PayMongo.)
  jest.spyOn(paymongo, "getCheckoutSession").mockImplementation(async (id) => ({ id, checkoutUrl: `https://checkout.paymongo.com/${id}`, status: "expired" }));
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

  describe("one payable link per order (Pay now again, a double click, a retry after a timeout)", () => {
    const payNow = () => request(app).post("/api/v1/payments/checkout").set("Authorization", user.auth).send({ order_id: orderId });
    const sessions = async () => (await pool.query("SELECT checkout_session_id, status FROM payments WHERE order_id = ?", [orderId]))[0];

    test("while the session is still open, the same link comes back: no second session, no second payment row", async () => {
      paymongo.getCheckoutSession.mockImplementation(async (id) => ({ id, checkoutUrl: `https://checkout.paymongo.com/${id}`, status: "active" }));
      const res = await payNow();
      expect(res.status).toBe(200);
      expect(res.body.checkout_url).toBe("https://checkout.paymongo.com/cs_test_1");
      expect(paymongo.getCheckoutSession).toHaveBeenCalledWith("cs_test_1");
      expect(paymongo.createCheckoutSession).toHaveBeenCalledTimes(1);   // only the first, in beforeEach
      expect(await sessions()).toEqual([{ checkout_session_id: "cs_test_1", status: "pending" }]);
    });

    test("already paid at PayMongo but the webhook isn't here yet: 409, and no new session to pay again", async () => {
      paymongo.getCheckoutSession.mockImplementation(async (id) => ({ id, checkoutUrl: "https://x", status: "paid" }));
      const res = await payNow();
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("PAYMENT_CONFIRMING");
      expect(paymongo.createCheckoutSession).toHaveBeenCalledTimes(1);
    });

    test("the old session expired: a new one is opened", async () => {
      paymongo.createCheckoutSession.mockResolvedValueOnce({ id: "cs_test_2", checkoutUrl: "https://checkout.paymongo.com/cs_test_2" });
      expect((await payNow()).body.checkout_url).toBe("https://checkout.paymongo.com/cs_test_2");
      expect((await sessions()).map((s) => s.checkout_session_id)).toEqual(["cs_test_1", "cs_test_2"]);
    });

    test("two Pay now requests at the same time for a new order open ONE session", async () => {
      await fillCart(user.id, [{ productId, quantity: 1 }]);
      const second = (await request(app).post("/api/orders").set("Authorization", user.auth).send(orderBody())).body.orderId;
      let n = 0;
      paymongo.createCheckoutSession.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 100));   // PayMongo takes a moment
        return { id: `cs_parallel_${++n}`, checkoutUrl: `https://checkout.paymongo.com/cs_parallel_${n}` };
      });
      paymongo.getCheckoutSession.mockImplementation(async (id) => ({ id, checkoutUrl: `https://checkout.paymongo.com/${id}`, status: "active" }));
      const send = () => request(app).post("/api/v1/payments/checkout").set("Authorization", user.auth).send({ order_id: second });
      const [a, b] = await Promise.all([send(), send()]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(a.body.checkout_url).toBe(b.body.checkout_url);
      expect(n).toBe(1);
      const [rows] = await pool.query("SELECT COUNT(*) AS n FROM payments WHERE order_id = ?", [second]);
      expect(rows[0].n).toBe(1);
    });
  });

  test("a PayMongo failure is a 502 with its message", async () => {
    paymongo.createCheckoutSession.mockRejectedValue(new paymongo.PaymentError("Payment method not activated"));
    jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(app).post("/api/v1/payments/checkout").set("Authorization", user.auth).send({ order_id: orderId });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Payment method not activated");
  });

  test("in production, PayMongo's own error text stays in the log, not in the answer", async () => {
    paymongo.createCheckoutSession.mockRejectedValue(
      Object.assign(new paymongo.PaymentError("API key sk_live_abc123 is not valid"), { fromProvider: true }));
    const logged = jest.spyOn(console, "error").mockImplementation(() => {});
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const res = await request(app).post("/api/v1/payments/checkout").set("Authorization", user.auth).send({ order_id: orderId });
      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: "The payment service couldn't complete this. Please try again in a moment." });
      expect(logged).toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = saved;
    }
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

  describe("test or live mode comes from the secret key, never from the event", () => {
    const crypto = require("crypto");
    // An event in either mode, signed for that mode (te= or li=), t seconds ago.
    const signed = ({ live, ageSeconds = 0 }) => {
      const body = paymongoEvent({ amount: 109900 }).body.replace('"livemode":false', `"livemode":${live}`);
      const t = Math.floor(Date.now() / 1000) - ageSeconds;
      const sig = crypto.createHmac("sha256", process.env.PAYMONGO_WEBHOOK_SECRET).update(`${t}.${body}`).digest("hex");
      return { body, signature: live ? `t=${t},te=,li=${sig}` : `t=${t},te=${sig},li=` };
    };
    const orderStatus = async () => (await pool.query("SELECT status FROM orders"))[0][0].status;
    const withEnv = async (env, fn) => {
      const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
      Object.assign(process.env, env);
      try { await fn(); } finally {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      }
    };

    test("live key: a correctly signed TEST event is refused and the order stays unpaid", async () => {
      await withEnv({ PAYMONGO_SECRET_KEY: "sk_live_fake" }, async () => {
        const { body, signature } = signed({ live: false });
        expect((await sendWebhook(body, signature)).status).toBe(401);
        expect(await orderStatus()).toBe("pending_payment");
      });
    });

    test("live key: a live event with the live signature is accepted", async () => {
      await withEnv({ PAYMONGO_SECRET_KEY: "sk_live_fake" }, async () => {
        const { body, signature } = signed({ live: true });
        expect((await sendWebhook(body, signature)).status).toBe(200);
        expect(await orderStatus()).toBe("paid");
      });
    });

    test("test key: a live event is refused, whatever it is signed with", async () => {
      const { body, signature } = signed({ live: true });
      expect((await sendWebhook(body, signature)).status).toBe(401);
      const relabelled = body.replace('"livemode":true', '"livemode":false');
      expect((await sendWebhook(relabelled, signature)).status).toBe(401);
      expect(await orderStatus()).toBe("pending_payment");
    });

    test("an event without livemode is refused", async () => {
      const body = paymongoEvent({ amount: 109900 }).body.replace('"livemode":false,', "");
      expect((await sendWebhook(body, require("./helpers").signPaymongo(body))).status).toBe(401);
    });
  });

  describe("signature age (PAYMONGO_WEBHOOK_TOLERANCE_SECONDS)", () => {
    const crypto = require("crypto");
    const aged = (ageSeconds) => {
      const { body } = paymongoEvent({ amount: 109900 });
      const t = Math.floor(Date.now() / 1000) - ageSeconds;
      return { body, signature: `t=${t},te=${crypto.createHmac("sha256", process.env.PAYMONGO_WEBHOOK_SECRET).update(`${t}.${body}`).digest("hex")},li=` };
    };

    test("off by default: an old signature (a retried delivery) is still accepted", async () => {
      const { body, signature } = aged(6 * 60 * 60);
      expect((await sendWebhook(body, signature)).status).toBe(200);
    });

    test("when set, a signature older than the limit is refused and a fresh one accepted", async () => {
      process.env.PAYMONGO_WEBHOOK_TOLERANCE_SECONDS = "300";
      try {
        const old = aged(10 * 60);
        expect((await sendWebhook(old.body, old.signature)).status).toBe(401);
        const fresh = aged(5);
        expect((await sendWebhook(fresh.body, fresh.signature)).status).toBe(200);
      } finally { delete process.env.PAYMONGO_WEBHOOK_TOLERANCE_SECONDS; }
    });
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

  test("unknown checkout session (e.g. a replay with the order id): 200, nothing changes, a warning is logged", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { body, signature } = paymongoEvent({ sessionId: `BL-${orderId}`, amount: 109900 });
    expect((await sendWebhook(body, signature)).status).toBe(200);

    const [[order]] = await pool.query("SELECT status FROM orders");
    expect(order.status).toBe("pending_payment");
    expect(await product(productId)).toEqual({ stock_quantity: 5, reserved: 2 });
    const [moves] = await pool.query("SELECT * FROM inventory_movements WHERE reason = 'sale'");
    expect(moves).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(`PayMongo webhook: no payment for checkout session BL-${orderId}; no order changed`);
  });

  test("refused webhooks say why in the log (no secrets)", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const { body } = paymongoEvent({ amount: 109900 });
    await sendWebhook(body, require("./helpers").signPaymongo(body, "whsk_attacker"));
    expect(warn).toHaveBeenLastCalledWith("PayMongo webhook refused (401): bad or missing signature");
    const live = body.replace('"livemode":false', '"livemode":true');
    await sendWebhook(live, require("./helpers").signPaymongo(live));
    expect(warn).toHaveBeenLastCalledWith("PayMongo webhook refused (401): livemode is true, but the secret key is test");
    expect(warn.mock.calls.flat().join(" ")).not.toContain(process.env.PAYMONGO_WEBHOOK_SECRET);
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
