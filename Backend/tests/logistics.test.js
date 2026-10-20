jest.mock("../services/mailer", () => require("./mailerMock")());

const request = require("supertest");
const app = require("../server");
const lalamove = require("../services/lalamove");
const { mail } = require("../services/mailer");
const { pool, resetDb, createUser, createProduct, fillCart, orderBody } = require("./helpers");

let customer, admin, orderId;

async function placeOrder(body = orderBody()) {
  const productId = await createProduct();
  await fillCart(customer.id, [{ productId, quantity: 1 }]);
  const res = await request(app).post("/api/orders").set("Authorization", customer.auth).send(body);
  return res.body.orderId;
}

beforeEach(async () => {
  await resetDb();
  jest.restoreAllMocks();
  jest.clearAllMocks();
  customer = await createUser();
  admin = await createUser({ role: "admin" });
  orderId = await placeOrder();
  await pool.query("UPDATE orders SET status = 'paid' WHERE order_id = ?", [orderId]);
});
afterAll(() => pool.end());

describe("manual J&T shipment + tracking timeline", () => {
  test("admin encodes the waybill, customer sees the timeline through delivery", async () => {
    const booked = await request(app).post(`/api/v1/admin/shipments/${orderId}/manual`).set("Authorization", admin.auth)
      .send({ courier: "JNT", tracking_number: "JT0001234567", fee_actual: 95 });
    expect(booked.status).toBe(201);
    expect(booked.body.tracking_url).toBe("https://www.jtexpress.ph/track?waybill=JT0001234567");
    const deliveryId = booked.body.delivery_id;

    // The order's existing PENDING delivery row is filled in, not duplicated.
    const [deliveries] = await pool.query("SELECT delivery_id, status, courier, tracking_number, fee_charged, fee_actual FROM deliveries");
    expect(deliveries).toEqual([{
      delivery_id: deliveryId, status: "PICKED_UP", courier: "JNT", tracking_number: "JT0001234567",
      fee_charged: "100.00", fee_actual: "95.00"
    }]);
    const [[order]] = await pool.query("SELECT status, courier FROM orders");
    expect(order).toEqual({ status: "shipped", courier: "JNT" });
    expect(mail.shipmentBooked).toHaveBeenCalledWith(
      "buyer@example.com", customer.username, orderId, "J&T Express", "JT0001234567", booked.body.tracking_url
    );

    for (const status of ["IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED"]) {
      const res = await request(app).patch(`/api/v1/admin/shipments/${deliveryId}/status`).set("Authorization", admin.auth)
        .send({ status, note: `now ${status}` });
      expect(res.status).toBe(200);
    }

    const tracking = await request(app).get(`/api/v1/orders/${orderId}/tracking`).set("Authorization", customer.auth);
    expect(tracking.status).toBe(200);
    expect(tracking.body).toMatchObject({
      courier: "JNT", courier_label: "J&T Express", status: "DELIVERED", tracking_number: "JT0001234567"
    });
    expect(tracking.body.events.map(e => e.status)).toEqual(["PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED"]);

    const [[done]] = await pool.query("SELECT o.status, d.dispatched_at, d.delivered_at FROM orders o JOIN deliveries d USING (order_id)");
    expect(done.status).toBe("delivered");
    expect(done.dispatched_at).not.toBeNull();
    expect(done.delivered_at).not.toBeNull();
    expect(mail.delivered).toHaveBeenCalledWith("buyer@example.com", customer.username, orderId);

    const again = await request(app).patch(`/api/v1/admin/shipments/${deliveryId}/status`).set("Authorization", admin.auth)
      .send({ status: "RETURNED" });
    expect(again.status).toBe(409);
  });

  test("an order can only be shipped once", async () => {
    const send = () => request(app).post(`/api/v1/admin/shipments/${orderId}/manual`).set("Authorization", admin.auth)
      .send({ courier: "LBC", tracking_number: "LBC-123456" });
    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(409);
  });

  test("unpaid orders can't be shipped", async () => {
    await pool.query("UPDATE orders SET status = 'pending_payment' WHERE order_id = ?", [orderId]);
    const res = await request(app).post(`/api/v1/admin/shipments/${orderId}/manual`).set("Authorization", admin.auth)
      .send({ courier: "JNT", tracking_number: "JT0001234567" });
    expect(res.status).toBe(409);
  });

  test("validation and access control", async () => {
    const badCourier = await request(app).post(`/api/v1/admin/shipments/${orderId}/manual`).set("Authorization", admin.auth)
      .send({ courier: "DHL", tracking_number: "JT0001234567" });
    expect(badCourier.body).toEqual({ error: "Courier must be JNT or LBC" });

    const badTn = await request(app).post(`/api/v1/admin/shipments/${orderId}/manual`).set("Authorization", admin.auth)
      .send({ courier: "JNT", tracking_number: "x" });
    expect(badTn.status).toBe(400);

    const notAdmin = await request(app).post(`/api/v1/admin/shipments/${orderId}/manual`).set("Authorization", customer.auth)
      .send({ courier: "JNT", tracking_number: "JT0001234567" });
    expect(notAdmin.status).toBe(403);

    const noShipment = await request(app).get(`/api/v1/orders/${orderId}/tracking`).set("Authorization", customer.auth);
    expect(noShipment.status).toBe(404);
  });

  test("customers can't see another customer's tracking", async () => {
    await request(app).post(`/api/v1/admin/shipments/${orderId}/manual`).set("Authorization", admin.auth)
      .send({ courier: "JNT", tracking_number: "JT0001234567" });
    const stranger = await createUser();
    const res = await request(app).get(`/api/v1/orders/${orderId}/tracking`).set("Authorization", stranger.auth);
    expect(res.status).toBe(404);
  });

  test("admin shipment list shows booked deliveries only", async () => {
    await placeOrder(); // still PENDING delivery, not listed
    await request(app).post(`/api/v1/admin/shipments/${orderId}/manual`).set("Authorization", admin.auth)
      .send({ courier: "JNT", tracking_number: "JT0001234567" });

    const all = await request(app).get("/api/v1/admin/shipments").set("Authorization", admin.auth);
    expect(all.body.map(d => d.order_id)).toEqual([orderId]);
    expect(all.body[0]).toMatchObject({ ship_name: "Juan Dela Cruz", order_status: "shipped" });

    const none = await request(app).get("/api/v1/admin/shipments?status=DELIVERED").set("Authorization", admin.auth);
    expect(none.body).toEqual([]);
  });
});

describe("Lalamove booking + webhook", () => {
  beforeEach(async () => {
    const body = orderBody();
    body.address = { ...body.address, lat: 14.548, lng: 121.057 };
    jest.spyOn(lalamove, "getQuotation").mockResolvedValue({
      quotationId: "q1", total: 180, currency: "PHP", stops: [{ stopId: "s1" }, { stopId: "s2" }]
    });
    orderId = await placeOrder({ ...body, courier: "LALAMOVE" });
    await pool.query("UPDATE orders SET status = 'paid' WHERE order_id = ?", [orderId]);
  });

  test("books a rider, then the webhook advances the status from Lalamove's own record", async () => {
    jest.spyOn(lalamove, "placeOrder").mockResolvedValue({ orderId: "LLM1", shareLink: "https://share.lalamove.com/LLM1", status: "ASSIGNING_DRIVER" });

    const res = await request(app).post(`/api/v1/admin/shipments/${orderId}/lalamove`).set("Authorization", admin.auth);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ lalamove_order_id: "LLM1", fee_charged: 180, fee_actual: 180, fee_difference: 0 });

    jest.spyOn(lalamove, "getOrder").mockResolvedValue({ status: "COMPLETED" });
    const hook = await request(app).post("/api/v1/webhooks/lalamove")
      .send({ apiKey: process.env.LALAMOVE_API_KEY, data: { order: { orderId: "LLM1", status: "lies" } } });
    expect(hook.status).toBe(200);

    const [[row]] = await pool.query("SELECT d.status, o.status AS order_status FROM deliveries d JOIN orders o USING (order_id) WHERE order_id = ?", [orderId]);
    expect(row).toEqual({ status: "DELIVERED", order_status: "delivered" });
  });

  test("webhook with the wrong apiKey is rejected", async () => {
    const res = await request(app).post("/api/v1/webhooks/lalamove").send({ apiKey: "nope", data: { order: { orderId: "LLM1" } } });
    expect(res.status).toBe(401);
  });

  test("an order update without the apiKey is rejected too, and Lalamove isn't called", async () => {
    const spy = jest.spyOn(lalamove, "getOrder").mockResolvedValue({ status: "COMPLETED" });
    for (const apiKey of [undefined, "", null, 0]) {
      const res = await request(app).post("/api/v1/webhooks/lalamove").send({ apiKey, data: { order: { orderId: "LLM1" } } });
      expect(res.status).toBe(401);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  test("the Partner Portal's test ping (no order) still gets 200, with or without the key", async () => {
    expect((await request(app).post("/api/v1/webhooks/lalamove").send({})).status).toBe(200);
    expect((await request(app).post("/api/v1/webhooks/lalamove").send({ apiKey: process.env.LALAMOVE_API_KEY })).status).toBe(200);
    expect((await request(app).post("/api/v1/webhooks/lalamove").send({ apiKey: "nope" })).status).toBe(401);
  });

  test("at most 120 calls a minute per IP", async () => {
    await require("../lib/rateLimit").resetAll();
    for (let i = 0; i < 120; i++) await request(app).post("/api/v1/webhooks/lalamove").send({});
    const res = await request(app).post("/api/v1/webhooks/lalamove").send({});
    expect(res.status).toBe(429);
    await require("../lib/rateLimit").resetAll();
  });
});
