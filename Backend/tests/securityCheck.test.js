// Nothing from the backend can be seen or changed from the browser, or by calling the API directly.
// The cases other test files already prove are listed in docs/reports/delivery-tracking-report.md
// ("Security check"); these are the rest.
jest.mock("../services/mailer", () => require("./mailerMock")());

const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../server");
const { pool, resetDb, createUser, createProduct, fillCart, orderBody } = require("./helpers");

afterAll(() => pool.end());
beforeEach(async () => {
  await resetDb();
  await require("../lib/rateLimit").resetAll();
});

const inProduction = async (work) => {
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try { return await work(); } finally { process.env.NODE_ENV = saved; }
};

// No stack trace, SQL, file path or library name in an answer.
const expectNothingInternal = (res) => {
  const text = JSON.stringify(res.body) + (res.text || "");
  expect(text).not.toMatch(/\bat \S+\.js|node_modules|SELECT |INSERT |ER_[A-Z_]+|[A-Z]:\\|\/Backend\/|express|body-parser|mysql/i);
  expect(res.headers["x-powered-by"]).toBeUndefined();
};

describe("can't be seen: only /api and /uploads answer, everything else is a JSON 404", () => {
  const UPLOADS = process.env.UPLOAD_DIR;
  beforeAll(() => {
    fs.writeFileSync(path.join(UPLOADS, ".secret"), "hidden");
    fs.mkdirSync(path.join(UPLOADS, "sub"), { recursive: true });
    fs.writeFileSync(path.join(UPLOADS, "sub", "a.jpg"), "x");
  });

  test.each([
    "/.env", "/Backend/.env", "/Backend/server.js", "/server.js", "/db.js", "/package.json", "/package-lock.json",
    "/node_modules/express/package.json", "/.git/config", "/backups/bongalink_real.sql", "/ml/worker/.env",
    "/deploy/mysql/create_app_users.sql", "/DEPLOYMENT.md", "/Backend/database/bongalink_schema.sql", "/logs/app.log",
    "/uploads/", "/uploads/sub/", "/uploads/.secret", "/uploads/..%2fserver.js", "/uploads/%2e%2e/%2e%2e/Backend/server.js",
    "/uploads/..%5cserver.js", "/uploads/..%2f..%2f.env", "/api/nope", "/api/v1/nope",
  ])("GET %s -> 404 Not found", async (url) => {
    const res = await request(app).get(url);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found." });
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expectNothingInternal(res);
  });

  test("an uploaded photo is served as an image, with nosniff and a policy that runs nothing", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
    fs.writeFileSync(path.join(UPLOADS, "photo-test.png"), png);
    const res = await request(app).get("/uploads/photo-test.png");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
  });
});

describe("can't be seen: errors in production say nothing about the server", () => {
  test("malformed JSON: a fixed message, not the parser's text or what was sent", async () => {
    const res = await inProduction(() => request(app).post("/api/auth/login")
      .set("Content-Type", "application/json").send('{"username": oops-secret-input'));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "The request couldn't be read." });
    expectNothingInternal(res);
  });

  test("a body over the limit: 413 with a fixed message", async () => {
    const res = await inProduction(() => request(app).post("/api/auth/login")
      .set("Content-Type", "application/json").send(JSON.stringify({ x: "a".repeat(200000) })));
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "The request is too large." });
  });

  test("a database failure: the generic 500, nothing about the query", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(pool, "query").mockRejectedValueOnce(Object.assign(new Error("ER_PARSE_ERROR near 'SELECT password_hash FROM users'"),
      { code: "ER_PARSE_ERROR", sql: "SELECT password_hash FROM users" }));
    const res = await inProduction(() => request(app).get("/api/categories"));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Something went wrong." });
    expectNothingInternal(res);
    jest.restoreAllMocks();
  });
});

describe("can't be seen: answers carry only what the page needs", () => {
  test("the public catalog and product page: no admin ids, no reserved/raw stock, no hidden products", async () => {
    const shown = await createProduct({ price: 250, stock: 10, reserved: 3 });
    const hidden = await createProduct();
    await pool.query("UPDATE products SET is_active = 0 WHERE product_id = ?", [hidden]);
    const list = await request(app).get("/api/products");
    expect(list.body.map((p) => p.id)).toEqual([shown]);
    expect(Object.keys(list.body[0]).sort()).toEqual(["brand", "category", "created_at", "description", "id", "image", "name", "price", "stock"]);
    expect(list.body[0].stock).toBe(7);   // available, not on hand
    const one = await request(app).get(`/api/products/${shown}`);
    expect(one.body).not.toHaveProperty("created_by");
    expect(one.body).not.toHaveProperty("reserved");
    expect((await request(app).get(`/api/products/${hidden}`)).status).toBe(404);
  });

  test("login and profile: never the password hash, tokens, the email index or encrypted values", async () => {
    const loginUser = await createUser();
    await pool.query("UPDATE users SET password_hash = ? WHERE user_id = ?", [await bcrypt.hash("Correct horse battery 9", 4), loginUser.id]);
    const login = await request(app).post("/api/auth/login").send({ username: loginUser.username, password: "Correct horse battery 9" });
    expect(login.status).toBe(200);
    expect(Object.keys(login.body).sort()).toEqual(["expires_at", "remember", "token", "user"]);
    expect(login.body.user).toEqual({ username: loginUser.username, role: "user" });

    const customer = await createUser();
    const me = await request(app).get("/api/v1/account/me").set("Authorization", customer.auth);
    expect(Object.keys(me.body).sort()).toEqual(["created_at", "email", "email_verified_at", "role", "user_id", "username"]);
    expect(me.body.email).toBe(customer.email);   // decrypted for its owner only
    expect(JSON.stringify(me.body)).not.toMatch(/password|bidx|token|v1:/);
  });

  test("tracking: no Lalamove/PayMongo ids, courier cost or admin ids", async () => {
    const customer = await createUser();
    const admin = await createUser({ role: "admin" });
    const productId = await createProduct();
    await fillCart(customer.id, [{ productId, quantity: 1 }]);
    const { body: { orderId } } = await request(app).post("/api/orders").set("Authorization", customer.auth).send(orderBody());
    await pool.query("UPDATE orders SET status = 'paid' WHERE order_id = ?", [orderId]);
    await request(app).post(`/api/v1/admin/shipments/${orderId}/manual`).set("Authorization", admin.auth)
      .send({ courier: "JNT", tracking_number: "JT0001234567", fee_actual: 80 });
    const t = await request(app).get(`/api/v1/orders/${orderId}/tracking`).set("Authorization", customer.auth);
    expect(t.status).toBe(200);
    expect(JSON.stringify(t.body)).not.toMatch(/external_order_id|fee_actual|created_by|delivery_id|user_id/);
    expect(Object.keys(t.body.events[0]).sort()).toEqual(["created_at", "note", "source", "status"]);
  });
});

describe("can't be changed: customers only reach their own orders", () => {
  test("another customer's order: payment status and Pay now are 404, and nothing is created", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const productId = await createProduct();
    await fillCart(owner.id, [{ productId, quantity: 1 }]);
    const { body: { orderId } } = await request(app).post("/api/orders").set("Authorization", owner.auth).send(orderBody());

    const status = await request(app).get(`/api/v1/payments/orders/${orderId}`).set("Authorization", stranger.auth);
    expect(status.status).toBe(404);
    const pay = await request(app).post("/api/v1/payments/checkout").set("Authorization", stranger.auth).send({ order_id: orderId });
    expect(pay.status).toBe(404);
    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM payments WHERE order_id = ?", [orderId]);
    expect(n).toBe(0);
    // The owner's own list doesn't include the stranger's orders, and vice versa.
    expect((await request(app).get("/api/orders").set("Authorization", stranger.auth)).body).toEqual([]);
  });
});

describe("can't be changed: values sent by the browser are ignored", () => {
  test("register with role admin, a user_id and a verified email: a plain, unverified customer", async () => {
    const res = await request(app).post("/api/auth/register").send({
      username: "sneaky", email: "sneaky@gmail.com", password: "A long enough password 1", privacy_consent: true,
      role: "admin", user_id: 1, email_verified_at: "2026-01-01", status: "active", token_version: 99,
    });
    expect(res.status).toBe(201);
    const [[u]] = await pool.query("SELECT role, email_verified_at, token_version FROM users WHERE username = 'sneaky'");
    expect(u).toEqual({ role: "user", email_verified_at: null, token_version: 0 });
  });

  test("profile update with role, user_id and status: only username/email can change", async () => {
    const customer = await createUser();
    const res = await request(app).patch("/api/v1/account/me").set("Authorization", customer.auth)
      .send({ username: "renamed_ok", role: "admin", user_id: 1, status: "active", email_verified_at: null });
    expect(res.status).toBe(200);
    const [[u]] = await pool.query("SELECT username, role, user_id FROM users WHERE user_id = ?", [customer.id]);
    expect(u).toEqual({ username: "renamed_ok", role: "user", user_id: customer.id });
    // And the admin pages still refuse this account.
    expect((await request(app).get("/api/v1/admin/accounts").set("Authorization", customer.auth)).status).toBe(403);
  });

  test("checkout with fake prices, total, fee, status and owner: the server's own numbers, pending payment, the caller's order", async () => {
    const customer = await createUser();
    const other = await createUser();
    const productId = await createProduct({ price: 500 });
    await fillCart(customer.id, [{ productId, quantity: 2 }]);
    const res = await request(app).post("/api/orders").set("Authorization", customer.auth).send(orderBody({
      items: [{ product_id: productId, quantity: 2, unit_price: 1 }], subtotal: 2, total_amount: 2, shipping_fee: 0,
      shippingFee: 0, status: "paid", paid_at: "2026-01-01", user_id: other.id,
    }));
    expect(res.status).toBe(201);
    const [[o]] = await pool.query("SELECT user_id, status, paid_at, total_amount, shipping_fee FROM orders WHERE order_id = ?", [res.body.orderId]);
    expect(o).toEqual({ user_id: customer.id, status: "pending_payment", paid_at: null, total_amount: "1100.00", shipping_fee: "100.00" });
    const [[line]] = await pool.query("SELECT unit_price FROM order_items WHERE order_id = ?", [res.body.orderId]);
    expect(line.unit_price).toBe("500.00");
  });

  test("the cart ignores a price sent with the item", async () => {
    const customer = await createUser();
    const productId = await createProduct({ price: 750 });
    await request(app).post("/api/cart").set("Authorization", customer.auth).send({ productId, quantity: 1, price: 1 });
    const cart = await request(app).get("/api/cart").set("Authorization", customer.auth);
    expect(cart.body).toEqual([expect.objectContaining({ id: productId, price: "750.00", quantity: 1 })]);
  });

  test("a customer can't mark an order paid, packed or shipped through any route", async () => {
    const customer = await createUser();
    const productId = await createProduct();
    await fillCart(customer.id, [{ productId, quantity: 1 }]);
    const { body: { orderId } } = await request(app).post("/api/orders").set("Authorization", customer.auth).send(orderBody());
    const tries = [
      request(app).post(`/api/v1/admin/orders/${orderId}/packed`),
      request(app).post(`/api/v1/admin/shipments/${orderId}/manual`).send({ courier: "JNT", tracking_number: "JT0001234567" }),
      request(app).patch(`/api/orders/${orderId}`).send({ status: "paid" }),
      request(app).put(`/api/orders/${orderId}`).send({ status: "paid" }),
      request(app).post(`/api/v1/payments/orders/${orderId}`).send({ status: "paid" }),
      // The PayMongo return page's ?payment=success is only read by the page; the API is never told.
      request(app).get(`/api/v1/payments/orders/${orderId}?payment=success`),
    ];
    for (const req of tries) await req.set("Authorization", customer.auth);
    const [[o]] = await pool.query("SELECT status, paid_at FROM orders WHERE order_id = ?", [orderId]);
    expect(o).toEqual({ status: "pending_payment", paid_at: null });
  });
});

describe("can't be changed: the login token", () => {
  test("a correctly signed token that claims admin, for a customer account: still a customer (role comes from the database)", async () => {
    const customer = await createUser();
    const forged = jwt.sign({ userId: customer.id, username: customer.username, role: "admin" }, process.env.JWT_SECRET);
    expect((await request(app).get("/api/v1/admin/accounts").set("Authorization", `Bearer ${forged}`)).status).toBe(403);
  });

  test("a token edited by hand (payload changed, old signature) is refused", async () => {
    const customer = await createUser();
    const [head, , sig] = customer.token.split(".");
    const payload = Buffer.from(JSON.stringify({ userId: customer.id, username: customer.username, role: "admin" })).toString("base64url");
    const res = await request(app).get("/api/v1/account/me").set("Authorization", `Bearer ${head}.${payload}.${sig}`);
    expect(res.status).toBe(401);
    expect((await request(app).get("/api/v1/admin/accounts").set("Authorization", `Bearer ${head}.${payload}.${sig}`)).status).toBe(401);
  });

  test("a token signed with another secret is refused", async () => {
    const customer = await createUser();
    const other = jwt.sign({ userId: customer.id, username: customer.username, role: "admin" }, "not-the-server-secret");
    expect((await request(app).get("/api/v1/account/me").set("Authorization", `Bearer ${other}`)).status).toBe(401);
  });
});

describe("the API listens on this machine only", () => {
  test("server.js listens on HOST, 127.0.0.1 by default; Docker sets 0.0.0.0 inside its container", () => {
    const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
    expect(server).toMatch(/const HOST = process\.env\.HOST \|\| "127\.0\.0\.1";/);
    expect(server).toMatch(/app\.listen\(PORT, HOST,/);
    const compose = fs.readFileSync(path.join(__dirname, "..", "..", "docker-compose.yml"), "utf8");
    expect(compose).toMatch(/HOST: 0\.0\.0\.0/);
    expect(compose).toMatch(/"127\.0\.0\.1:4000:4000"/);
  });
});
