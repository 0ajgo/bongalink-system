jest.mock("../services/mailer", () => require("./mailerMock")());

const request = require("supertest");
const app = require("../server");
const paymongo = require("../services/paymongo");
const { mail } = require("../services/mailer");
const { pool, resetDb, createUser, createProduct, fillCart, orderBody, paymongoEvent } = require("./helpers");

let user, admin;

// Places an order for two products and opens a mocked PayMongo checkout; returns { orderId, amount }.
async function placeOrder(sessionId = "cs_test_1") {
  const a = await createProduct({ price: 300, stock: 5 });
  const b = await createProduct({ price: 50, stock: 5 });
  await fillCart(user.id, [{ productId: a, quantity: 2 }, { productId: b, quantity: 1 }]);
  const body = orderBody({ courier: "LBC" });
  body.address = { ...body.address, region: "VII", province: "Cebu", city: "Cebu City" };
  const res = await request(app).post("/api/orders").set("Authorization", user.auth).send(body);
  expect(res.status).toBe(201);

  paymongo.createCheckoutSession.mockResolvedValueOnce({ id: sessionId, checkoutUrl: "https://x" });
  await request(app).post("/api/v1/payments/checkout").set("Authorization", user.auth).send({ order_id: res.body.orderId });
  return { orderId: res.body.orderId, amountCentavos: Math.round(res.body.totalAmount * 100) };
}

const pay = ({ eventId = "evt_1", sessionId = "cs_test_1", amount }) => {
  const { body, signature } = paymongoEvent({ eventId, sessionId, amount });
  return request(app).post("/api/v1/webhooks/paymongo")
    .set("Content-Type", "application/json").set("Paymongo-Signature", signature).send(body);
};

beforeEach(async () => {
  await resetDb();
  jest.restoreAllMocks();
  jest.clearAllMocks();
  jest.spyOn(paymongo, "createCheckoutSession");
  process.env.ADMIN_ALERT_EMAIL = "shop@example.com";
  user = await createUser();
  admin = await createUser({ role: "admin" });
});
afterAll(() => pool.end());

describe("shop email when an order is paid", () => {
  test("lists products, quantities, courier and shipping address", async () => {
    const { orderId, amountCentavos } = await placeOrder();
    expect((await pay({ amount: amountCentavos })).status).toBe(200);

    expect(mail.orderPaidAlert).toHaveBeenCalledTimes(1);
    const [to, details] = mail.orderPaidAlert.mock.calls[0];
    expect(to).toBe("shop@example.com");
    expect(details).toEqual({
      orderId,
      amount: amountCentavos / 100,
      items: [{ name: expect.any(String), quantity: 2 }, { name: expect.any(String), quantity: 1 }],
      courierLabel: "LBC Express",
      shipName: "Juan Dela Cruz",
      shipPhone: "09171234567",
      shipAddress: "123 Street, Pembo, Cebu City, Cebu, 1218"
    });
  });

  test("not sent for a duplicate event or a payment flagged for review", async () => {
    const { amountCentavos } = await placeOrder();
    await pay({ amount: amountCentavos });
    await pay({ amount: amountCentavos }); // same event id again
    expect(mail.orderPaidAlert).toHaveBeenCalledTimes(1);

    await placeOrder("cs_test_2");
    await pay({ eventId: "evt_2", sessionId: "cs_test_2", amount: 1 }); // amount mismatch -> review
    expect(mail.orderPaidAlert).toHaveBeenCalledTimes(1);
  });

  test("skipped when ADMIN_ALERT_EMAIL is not set; the payment still succeeds", async () => {
    delete process.env.ADMIN_ALERT_EMAIL;
    const { amountCentavos } = await placeOrder();
    expect((await pay({ amount: amountCentavos })).status).toBe(200);
    expect(mail.orderPaidAlert).not.toHaveBeenCalled();
    const [[order]] = await pool.query("SELECT status FROM orders");
    expect(order.status).toBe("paid");
  });

  test("a failing email doesn't fail the webhook", async () => {
    mail.orderPaidAlert.mockRejectedValueOnce(new Error("SMTP down"));
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    const { amountCentavos } = await placeOrder();
    expect((await pay({ amount: amountCentavos })).status).toBe(200);
    await new Promise(r => setImmediate(r));
    expect(errors).toHaveBeenCalledWith("Shop alert failed (Error): SMTP down");
  });
});

describe("shop email content", () => {
  test("escapes customer-entered text in the HTML", async () => {
    const { mail: realMail, transporter } = jest.requireActual("../services/mailer");
    const sendMail = jest.spyOn(transporter, "sendMail").mockResolvedValue({});
    await realMail.orderPaidAlert("shop@example.com", {
      orderId: 7, amount: 1234.5, courierLabel: "J&T Express",
      shipName: "<script>alert(1)</script>", shipPhone: "0917", shipAddress: "1 <b>Main</b> St",
      items: [{ name: "Fuser <unit>", quantity: 2 }]
    });
    const { to, subject, html, text } = sendMail.mock.calls[0][0];
    expect(to).toBe("shop@example.com");
    expect(subject).toBe("New paid order #7 - ₱1,234.50");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Fuser &lt;unit&gt;");
    expect(html).toContain("J&amp;T Express");
    expect(text).toContain("- Fuser <unit> x 2");
  });
});

describe("GET /api/v1/admin/orders/to-ship (dashboard badge)", () => {
  test("counts paid and packed orders, not unpaid or shipped ones", async () => {
    const statuses = ["pending_payment", "paid", "paid", "packed", "shipped", "delivered", "expired", "completed"];
    for (const status of statuses) {
      await pool.query("INSERT INTO orders (user_id, status, total_amount, paid_at) VALUES (?, ?, 100, NOW())", [user.id, status]);
    }
    const res = await request(app).get("/api/v1/admin/orders/to-ship").set("Authorization", admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.oldest_paid_at).not.toBeNull();
  });

  test("drops when the admin ships an order", async () => {
    const { amountCentavos, orderId } = await placeOrder();
    await pay({ amount: amountCentavos });
    const badge = () => request(app).get("/api/v1/admin/orders/to-ship").set("Authorization", admin.auth);
    expect((await badge()).body.count).toBe(1);

    await request(app).post(`/api/v1/admin/shipments/${orderId}/manual`).set("Authorization", admin.auth)
      .send({ courier: "LBC", tracking_number: "LBC-123456" });
    expect((await badge()).body.count).toBe(0);
  });

  test("admin only", async () => {
    expect((await request(app).get("/api/v1/admin/orders/to-ship").set("Authorization", user.auth)).status).toBe(403);
    expect((await request(app).get("/api/v1/admin/orders/to-ship")).status).toBe(401);
  });
});
