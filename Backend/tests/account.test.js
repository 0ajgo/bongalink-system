jest.mock("../services/mailer", () => require("./mailerMock")());

const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const { mail } = require("../services/mailer");
const { pool, resetDb, createUser, createProduct, fillCart, orderBody } = require("./helpers");

let user;

async function withPassword(u, password) {
  await pool.query("UPDATE users SET password_hash = ? WHERE user_id = ?", [await bcrypt.hash(password, 4), u.id]);
  return u;
}

const address = (overrides = {}) => ({
  recipient_name: "Juan Dela Cruz", recipient_phone: "0917 123 4567", street: "123 Street", barangay: "Pembo",
  city: "Makati", province: "", region: "NCR", postal_code: "1218", landmark: "Blue gate", ...overrides
});

const api = (method, path) => request(app)[method](`/api/v1/account${path}`).set("Authorization", user.auth);

beforeEach(async () => {
  await resetDb();
  jest.clearAllMocks();
  user = await withPassword(await createUser(), "Secret-pass-123");
});
afterAll(() => pool.end());

describe("GET/PATCH /api/v1/account/me", () => {
  test("returns only the logged-in user's profile", async () => {
    await createUser();
    const res = await api("get", "/me");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user_id: user.id, username: user.username, email: user.email, role: "user",
      created_at: expect.any(String), email_verified_at: expect.any(String)
    });
    expect(res.body).not.toHaveProperty("password_hash");
  });

  test("requires login", async () => {
    expect((await request(app).get("/api/v1/account/me")).status).toBe(401);
  });

  test("changes the username without a password", async () => {
    const res = await api("patch", "/me").send({ username: "juan.dc" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ username: "juan.dc", email_changed: false });
  });

  test("changing the email needs the current password, then unverifies it and sends a code", async () => {
    const noPw = await api("patch", "/me").send({ email: "new@gmail.com" });
    expect(noPw.status).toBe(400);
    const wrongPw = await api("patch", "/me").send({ email: "new@gmail.com", current_password: "nope" });
    expect(wrongPw.status).toBe(400);

    const ok = await api("patch", "/me").send({ email: "New@Gmail.com", current_password: "Secret-pass-123" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ email: "new@gmail.com", email_verified_at: null, email_changed: true, email_sent: true });
    expect(mail.verificationCode).toHaveBeenCalledWith("new@gmail.com", user.username, expect.stringMatching(/^\d{6}$/), 15);
  });

  test("rejects a username or email someone else has, and bad formats", async () => {
    const other = await createUser({ email: "taken@gmail.com" });
    const takenName = await api("patch", "/me").send({ username: other.username });
    expect(takenName.status).toBe(409);
    expect(takenName.body.error).toMatch(/username/);
    const takenEmail = await api("patch", "/me").send({ email: other.email, current_password: "Secret-pass-123" });
    expect(takenEmail.status).toBe(409);
    expect((await api("patch", "/me").send({ username: "a b" })).status).toBe(400);
    expect((await api("patch", "/me").send({ email: "not-an-email", current_password: "Secret-pass-123" })).status).toBe(400);
  });
});

describe("POST /api/v1/account/password", () => {
  test("changes the password when the current one is right", async () => {
    const res = await api("post", "/password").send({ current_password: "Secret-pass-123", new_password: "New-secret9" });
    expect(res.status).toBe(200);
    const login = await request(app).post("/api/auth/login").send({ username: user.username, password: "New-secret9" });
    expect(login.status).toBe(200);
    const old = await request(app).post("/api/auth/login").send({ username: user.username, password: "Secret-pass-123" });
    expect(old.status).toBe(401);
  });

  test("rejects a wrong current password, a short one, or the same password", async () => {
    expect((await api("post", "/password").send({ current_password: "wrong", new_password: "New-secret9" })).status).toBe(400);
    expect((await api("post", "/password").send({ current_password: "Secret-pass-123", new_password: "123" })).status).toBe(400);
    const same = await api("post", "/password").send({ current_password: "Secret-pass-123", new_password: "Secret-pass-123" });
    expect(same.status).toBe(400);
    expect(same.body.error).toMatch(/different/);
  });
});

describe("saved addresses", () => {
  test("add, list, edit, make default and delete", async () => {
    const first = await api("post", "/addresses").send(address());
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ recipient_phone: "09171234567", region: "NCR", shipping_zone: "NCR", is_default: true });

    const second = await api("post", "/addresses").send(address({ region: "IV-B", province: "Palawan", city: "Puerto Princesa" }));
    expect(second.body).toMatchObject({ shipping_zone: "ISLAND_PROVINCE", is_default: false });

    let list = (await api("get", "/addresses")).body;
    expect(list.map(a => a.address_id)).toEqual([first.body.address_id, second.body.address_id]);

    const edited = await api("patch", `/addresses/${second.body.address_id}`).send(address({ region: "VII", city: "Cebu City", is_default: true }));
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ region: "VII", shipping_zone: "VISAYAS", is_default: true });
    list = (await api("get", "/addresses")).body;
    expect(list.filter(a => a.is_default).map(a => a.address_id)).toEqual([second.body.address_id]);

    const del = await api("delete", `/addresses/${second.body.address_id}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual([expect.objectContaining({ address_id: first.body.address_id, is_default: true })]);
  });

  test("validation errors keep their message", async () => {
    const bad = await api("post", "/addresses").send(address({ region: "ZZ" }));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("Choose a region.");
    expect((await api("post", "/addresses").send(address({ recipient_phone: "123" }))).body.error).toMatch(/mobile number/);
    expect((await api("post", "/addresses").send(address({ postal_code: "12" }))).body.error).toMatch(/postal/);
  });

  test("other users' addresses and order addresses can't be seen or changed", async () => {
    const mine = (await api("post", "/addresses").send(address())).body;

    const other = await createUser();
    const asOther = (method, path) => request(app)[method](`/api/v1/account${path}`).set("Authorization", other.auth);
    expect((await asOther("get", "/addresses")).body).toEqual([]);
    expect((await asOther("patch", `/addresses/${mine.address_id}`).send(address())).status).toBe(404);
    expect((await asOther("delete", `/addresses/${mine.address_id}`)).status).toBe(404);

    // The copy of the address stored with an order is not a "saved" address.
    const productId = await createProduct();
    await fillCart(user.id, [{ productId, quantity: 1 }]);
    const order = await request(app).post("/api/orders").set("Authorization", user.auth).send(orderBody());
    expect(order.status).toBe(201);
    const [[orderAddress]] = await pool.query("SELECT address_id FROM orders WHERE order_id = ?", [order.body.orderId]);
    expect((await api("get", "/addresses")).body.map(a => a.address_id)).toEqual([mine.address_id]);
    expect((await api("delete", `/addresses/${orderAddress.address_id}`)).status).toBe(404);
  });
});
