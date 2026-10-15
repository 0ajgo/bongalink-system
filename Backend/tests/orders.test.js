jest.mock("../services/mailer", () => require("./mailerMock")());

const request = require("supertest");
const app = require("../server");
const lalamove = require("../services/lalamove");
const { pool, resetDb, createUser, createProduct, fillCart, orderBody, product, addressRows } = require("./helpers");

beforeEach(async () => {
  await resetDb();
  jest.restoreAllMocks();
});
afterAll(() => pool.end());

describe("POST /api/orders — stock reservation", () => {
  test("reserves stock, keeps stock_quantity, and creates a pending_payment order", async () => {
    const user = await createUser();
    const productId = await createProduct({ price: 499.5, stock: 5 });
    await fillCart(user.id, [{ productId, quantity: 2 }]);

    const res = await request(app).post("/api/orders").set("Authorization", user.auth).send(orderBody());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "pending_payment", subtotal: 999, shippingFee: 100, totalAmount: 1099, courier: "JNT" });

    expect(await product(productId)).toEqual({ stock_quantity: 5, reserved: 2 });

    const [[order]] = await pool.query("SELECT status, courier, shipping_fee, total_amount FROM orders");
    expect(order).toEqual({ status: "pending_payment", courier: "JNT", shipping_fee: "100.00", total_amount: "1099.00" });

    const [address] = await addressRows();
    expect(address).toMatchObject({ region: "NCR", shipping_zone: "NCR", lat: null, lng: null, recipient_name: "Juan Dela Cruz",
      recipient_phone: "09171234567", street: "123 Street", city: "Makati", postal_code: "1218" });

    const [[delivery]] = await pool.query("SELECT status, courier, fee_charged FROM deliveries");
    expect(delivery).toEqual({ status: "PENDING", courier: "JNT", fee_charged: "100.00" });

    const [cart] = await pool.query("SELECT * FROM cart_items");
    expect(cart).toHaveLength(0);
  });

  test("rejects an order when available stock (on hand - reserved) is too low", async () => {
    const user = await createUser();
    const productId = await createProduct({ stock: 5, reserved: 4 });
    await fillCart(user.id, [{ productId, quantity: 2 }]);

    const res = await request(app).post("/api/orders").set("Authorization", user.auth).send(orderBody());
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/enough stock/);

    expect(await product(productId)).toEqual({ stock_quantity: 5, reserved: 4 });
    const [orders] = await pool.query("SELECT * FROM orders");
    expect(orders).toHaveLength(0);
  });

  test("two customers racing for the last unit: exactly one order succeeds", async () => {
    const productId = await createProduct({ stock: 1 });
    const buyers = [await createUser(), await createUser()];
    for (const b of buyers) await fillCart(b.id, [{ productId, quantity: 1 }]);

    const results = await Promise.all(
      buyers.map(b => request(app).post("/api/orders").set("Authorization", b.auth).send(orderBody()))
    );
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    expect(await product(productId)).toEqual({ stock_quantity: 1, reserved: 1 });
  });

  test("ignores any shipping fee sent by the browser", async () => {
    const user = await createUser();
    const productId = await createProduct({ price: 100, stock: 5 });
    await fillCart(user.id, [{ productId, quantity: 1 }]);

    const res = await request(app).post("/api/orders").set("Authorization", user.auth)
      .send({ ...orderBody({ courier: "LBC" }), shippingFee: 1, shipping_fee: 1, totalAmount: 1 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ shippingFee: 130, totalAmount: 230 });
  });

  test("rejects a courier that isn't offered for the address (Lalamove without a pin)", async () => {
    const user = await createUser();
    const productId = await createProduct();
    await fillCart(user.id, [{ productId, quantity: 1 }]);

    const res = await request(app).post("/api/orders").set("Authorization", user.auth).send(orderBody({ courier: "LALAMOVE" }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/courier isn't available/);
  });

  test("Lalamove with a pin uses the live quote and saves the pin", async () => {
    jest.spyOn(lalamove, "getQuotation").mockResolvedValue({ quotationId: "q1", total: 187, currency: "PHP", stops: [] });
    const user = await createUser();
    const productId = await createProduct({ price: 100 });
    await fillCart(user.id, [{ productId, quantity: 1 }]);

    const body = orderBody({ courier: "LALAMOVE" });
    body.address = { ...body.address, lat: 14.548, lng: 121.057 };
    const res = await request(app).post("/api/orders").set("Authorization", user.auth).send(body);
    expect(res.status).toBe(201);
    expect(res.body.shippingFee).toBe(187);

    const [address] = await addressRows();
    expect(address).toMatchObject({ lat: 14.548, lng: 121.057 });
  });

  test("an island province is billed at the ISLAND_PROVINCE rate", async () => {
    const user = await createUser();
    const productId = await createProduct({ price: 100 });
    await fillCart(user.id, [{ productId, quantity: 1 }]);

    const body = orderBody();
    body.address = { ...body.address, region: "IV-B", province: "Palawan", city: "Puerto Princesa" };
    const res = await request(app).post("/api/orders").set("Authorization", user.auth).send(body);
    expect(res.status).toBe(201);
    expect(res.body.shippingFee).toBe(190);
    const [[address]] = await pool.query("SELECT shipping_zone FROM delivery_addresses");
    expect(address.shipping_zone).toBe("ISLAND_PROVINCE");
  });

  test("blocks checkout until the email is verified", async () => {
    const user = await createUser({ verified: false });
    const productId = await createProduct();
    await fillCart(user.id, [{ productId, quantity: 1 }]);

    const res = await request(app).post("/api/orders").set("Authorization", user.auth).send(orderBody());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("EMAIL_NOT_VERIFIED");
    expect(await product(productId)).toEqual({ stock_quantity: 10, reserved: 0 });
  });

  test("validation errors keep their message", async () => {
    const user = await createUser();
    const body = orderBody();
    body.address = { ...body.address, region: "ATLANTIS" };
    const res = await request(app).post("/api/orders").set("Authorization", user.auth).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Choose a delivery region so shipping can be calculated.");
  });
});

describe("cart uses available stock", () => {
  test("reserved units can't be added to another cart", async () => {
    const user = await createUser();
    const productId = await createProduct({ stock: 3, reserved: 3 });
    const res = await request(app).post("/api/cart").set("Authorization", user.auth).send({ productId, quantity: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("This product is out of stock.");
  });
});
