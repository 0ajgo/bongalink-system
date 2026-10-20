// Cart quantities: whole numbers from 1 to 999, never more than the product's available
// stock (on hand minus what unpaid orders hold). A bad request changes nothing.
const request = require("supertest");
const app = require("../server");
const { pool, resetDb, createUser, createProduct } = require("./helpers");

let user, productId;
beforeEach(async () => {
  await resetDb();
  user = await createUser();
  productId = await createProduct({ stock: 5, reserved: 1 });   // 4 available
});
afterAll(() => pool.end());

const add = (body) => request(app).post("/api/cart").set("Authorization", user.auth).send(body);
const set = (id, body) => request(app).put(`/api/cart/${id}`).set("Authorization", user.auth).send(body);
const inCart = async () => {
  const [rows] = await pool.query("SELECT ci.quantity FROM cart_items ci JOIN carts c USING (cart_id) WHERE c.user_id = ? AND ci.product_id = ?",
    [user.id, productId]);
  return rows[0]?.quantity ?? 0;
};

const BAD = [0, -1, -5, 1.5, "1.5", "abc", "2abc", "", " ", null, true, [2], { n: 2 }, 1e9, 1000, "1000", Number.MAX_SAFE_INTEGER];

describe("POST /api/cart", () => {
  test.each(BAD)("quantity %p is a 400 and the cart is unchanged", async (quantity) => {
    await add({ productId, quantity: 2 });
    const res = await add({ productId, quantity });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Quantity must be a whole number from 1 to 999.");
    expect(await inCart()).toBe(2);
  });

  test("whole numbers (or digit strings) are added; no quantity means 1", async () => {
    expect((await add({ productId, quantity: 2 })).body).toEqual({ message: "Product added to cart.", quantity: 2 });
    expect((await add({ productId, quantity: "1" })).status).toBe(200);
    expect((await add({ productId })).status).toBe(200);
    expect(await inCart()).toBe(4);
  });

  test("never more than available stock: a new line or on top of what's in the cart", async () => {
    let res = await add({ productId, quantity: 5 });   // 5 on hand, 1 held by an unpaid order
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Only 4 available.", available: 4 });
    expect(await inCart()).toBe(0);

    await add({ productId, quantity: 3 });
    res = await add({ productId, quantity: 2 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Only 4 available (you already have 3 in your cart).");
    expect(await inCart()).toBe(3);
  });

  test("bad product ids: 400; unknown or hidden products: 404", async () => {
    for (const bad of [undefined, "", "abc", -1, 1.5, "1;DROP"]) expect((await add({ productId: bad, quantity: 1 })).status).toBe(400);
    expect((await add({ productId: 999999, quantity: 1 })).status).toBe(404);
    await pool.query("UPDATE products SET is_active = 0 WHERE product_id = ?", [productId]);
    expect((await add({ productId, quantity: 1 })).status).toBe(404);
  });

  test("two quick adds can't together go past the stock", async () => {
    const results = await Promise.all([add({ productId, quantity: 3 }), add({ productId, quantity: 3 })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(await inCart()).toBe(3);
  });
});

describe("PUT /api/cart/:productId sets the quantity", () => {
  test("sets the exact quantity (adds the line if it's new)", async () => {
    expect((await set(productId, { quantity: 3 })).body).toEqual({ message: "Cart updated.", quantity: 3 });
    expect((await set(productId, { quantity: 1 })).status).toBe(200);
    expect(await inCart()).toBe(1);
  });

  test.each(BAD)("quantity %p is a 400 and the line keeps its quantity", async (quantity) => {
    await set(productId, { quantity: 2 });
    const res = await set(productId, { quantity });
    expect(res.status).toBe(400);
    expect(await inCart()).toBe(2);
  });

  test("more than available: 400, the line keeps its quantity (it isn't removed)", async () => {
    await set(productId, { quantity: 2 });
    const res = await set(productId, { quantity: 5 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Only 4 available.", available: 4 });
    expect(await inCart()).toBe(2);
  });

  test("missing quantity, bad id, unknown product", async () => {
    expect((await set(productId, {})).status).toBe(400);
    expect((await set("abc", { quantity: 1 })).status).toBe(400);
    expect((await set(999999, { quantity: 1 })).status).toBe(404);
  });

  test("needs a login", async () => {
    expect((await request(app).put(`/api/cart/${productId}`).send({ quantity: 1 })).status).toBe(401);
  });
});
