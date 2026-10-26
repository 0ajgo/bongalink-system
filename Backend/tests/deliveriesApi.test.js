jest.mock("../services/mailer", () => require("./mailerMock")());

const request = require("supertest");
const app = require("../server");
const lalamove = require("../services/lalamove");
const { pool, resetDb, createUser, createProduct, fillCart, orderBody } = require("./helpers");

let customer, admin;

// Places an order through the API, then marks it paid `paidMinutesAgo` ago.
async function paidOrder({ courier = "JNT", pin = false, paidMinutesAgo = 0, status = "paid", quantity = 1 } = {}) {
  const productId = await createProduct({ price: 250 });
  await fillCart(customer.id, [{ productId, quantity }]);
  const body = orderBody({ courier });
  if (pin) body.address = { ...body.address, lat: 14.548, lng: 121.057 };
  const res = await request(app).post("/api/orders").set("Authorization", customer.auth).send(body);
  expect(res.status).toBe(201);
  await pool.query("UPDATE orders SET status = ?, paid_at = NOW() - INTERVAL ? MINUTE WHERE order_id = ?",
    [status, paidMinutesAgo, res.body.orderId]);
  return res.body.orderId;
}

const awaiting = () => request(app).get("/api/v1/admin/orders/awaiting-shipment").set("Authorization", admin.auth);

beforeEach(async () => {
  await resetDb();
  jest.restoreAllMocks();
  customer = await createUser();
  admin = await createUser({ role: "admin" });
});
afterAll(() => pool.end());

describe("GET /api/v1/admin/orders/awaiting-shipment", () => {
  test("lists paid and packed orders, oldest payment first, with customer, address, items, courier and fee", async () => {
    const newer = await paidOrder({ paidMinutesAgo: 5, quantity: 2 });
    const older = await paidOrder({ paidMinutesAgo: 60, status: "packed", courier: "LBC" });
    const unpaid = await paidOrder({ status: "pending_payment" });
    const shipped = await paidOrder({ status: "shipped" });

    const res = await awaiting();
    expect(res.status).toBe(200);
    expect(res.body.map(o => o.order_id)).toEqual([older, newer]);
    expect(res.body.map(o => o.order_id)).not.toContain(unpaid);
    expect(res.body.map(o => o.order_id)).not.toContain(shipped);

    expect(res.body[1]).toMatchObject({
      order_id: newer,
      order_status: "paid",
      courier_chosen: "JNT",
      courier_chosen_label: "J&T Express",
      shipping_fee: "100.00",
      total_amount: "600.00",
      customer_username: customer.username,
      customer_email: "b***@example.com",   // masked in the list
      ship_name: "Juan Dela Cruz",
      ship_phone: "09171234567",
      ship_address: "123 Street, Pembo, Makati, 1218",
      ship_region: "NCR",
      has_map_pin: false,
      can_book_lalamove: false,
      items: [{ product_id: expect.any(Number), name: expect.stringMatching(/^Product/), quantity: 2, unit_price: "250.00" }]
    });
    expect(res.body[0]).toMatchObject({ courier_chosen: "LBC", order_status: "packed", ship_city: "Makati" });
    expect(res.body[1]).toHaveProperty("packed_at", null);
  });

  test("can_book_lalamove needs both the Lalamove keys and a map pin", async () => {
    jest.spyOn(lalamove, "getQuotation").mockResolvedValue({ quotationId: "q", total: 150, stops: [] });
    const withPin = await paidOrder({ courier: "LALAMOVE", pin: true });
    const noPin = await paidOrder({ courier: "JNT" });

    let byId = Object.fromEntries((await awaiting()).body.map(o => [o.order_id, o]));
    expect(byId[withPin]).toMatchObject({ has_map_pin: true, can_book_lalamove: true, courier_chosen: "LALAMOVE" });
    expect(byId[noPin]).toMatchObject({ has_map_pin: false, can_book_lalamove: false });

    const saved = process.env.LALAMOVE_API_KEY;
    delete process.env.LALAMOVE_API_KEY;
    try {
      byId = Object.fromEntries((await awaiting()).body.map(o => [o.order_id, o]));
      expect(byId[withPin]).toMatchObject({ has_map_pin: true, can_book_lalamove: false });
    } finally {
      process.env.LALAMOVE_API_KEY = saved;
    }
  });

  test("a shipped order moves to the outgoing deliveries list with its details", async () => {
    const orderId = await paidOrder({ quantity: 3 });
    await request(app).post(`/api/v1/admin/shipments/${orderId}/manual`).set("Authorization", admin.auth)
      .send({ courier: "LBC", tracking_number: "LBC-998877", fee_actual: 120 });

    expect((await awaiting()).body).toEqual([]);
    const out = await request(app).get("/api/v1/admin/shipments").set("Authorization", admin.auth);
    expect(out.body).toHaveLength(1);
    expect(out.body[0]).toMatchObject({
      order_id: orderId, status: "PICKED_UP", courier: "LBC", courier_label: "LBC Express",
      tracking_number: "LBC-998877", fee_charged: "150.00", fee_actual: "120.00",   // 3 x 0.5 kg -> 3 kg bracket
      customer_username: customer.username, ship_name: "Juan Dela Cruz", courier_chosen: "JNT",
      items: [expect.objectContaining({ quantity: 3 })]
    });

    const filtered = await request(app).get("/api/v1/admin/shipments?status=IN_TRANSIT").set("Authorization", admin.auth);
    expect(filtered.body).toEqual([]);
  });

  test("admin only", async () => {
    expect((await request(app).get("/api/v1/admin/orders/awaiting-shipment").set("Authorization", customer.auth)).status).toBe(403);
    expect((await request(app).get("/api/v1/admin/orders/awaiting-shipment")).status).toBe(401);
  });
});

describe("GET /api/orders (customer's order page)", () => {
  test("returns only this customer's orders, newest first, each with its items", async () => {
    const first = await paidOrder({ quantity: 2 });
    const second = await paidOrder({ status: "pending_payment" });
    const other = await createUser();
    const otherProduct = await createProduct();
    await fillCart(other.id, [{ productId: otherProduct, quantity: 1 }]);
    await request(app).post("/api/orders").set("Authorization", other.auth).send(orderBody());

    const res = await request(app).get("/api/orders").set("Authorization", customer.auth);
    expect(res.status).toBe(200);
    expect(res.body.map(o => o.order_id)).toEqual([second, first]);
    expect(res.body[1]).toMatchObject({
      status: "paid", courier: "JNT", shipping_fee: "100.00",
      packed_at: null, shipped_at: null, delivered_at: null, shipment_courier: null,
      items: [{ name: expect.any(String), quantity: 2, unit_price: "250.00" }]
    });
  });

  test("each order carries the dates of its tracker steps and the courier actually used", async () => {
    const orderId = await paidOrder({ courier: "JNT" });
    await request(app).post(`/api/v1/admin/orders/${orderId}/packed`).set("Authorization", admin.auth);
    await request(app).post(`/api/v1/admin/shipments/${orderId}/manual`).set("Authorization", admin.auth)
      .send({ courier: "LBC", tracking_number: "LBC-998877" });
    const [[d]] = await pool.query("SELECT delivery_id FROM deliveries WHERE order_id = ?", [orderId]);
    await request(app).patch(`/api/v1/admin/shipments/${d.delivery_id}/status`).set("Authorization", admin.auth)
      .send({ status: "DELIVERED" });

    const [order] = (await request(app).get("/api/orders").set("Authorization", customer.auth)).body;
    expect(order).toMatchObject({
      order_id: orderId, status: "delivered", courier: "JNT", shipment_courier: "LBC",
      paid_at: expect.any(String), packed_at: expect.any(String), shipped_at: expect.any(String), delivered_at: expect.any(String)
    });
  });
});
