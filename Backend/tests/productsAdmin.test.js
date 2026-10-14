// Product page, product editing, stock adjustments, history and photo uploads.
jest.mock("../services/mailer", () => require("./mailerMock")());

const fs = require("fs");
const path = require("path");
const request = require("supertest");
const app = require("../server");
const { pool, resetDb, createUser, createProduct, fillCart } = require("./helpers");

let admin, customer, productId;

// A real 1x1 PNG, and files that only pretend to be images.
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
  "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const asAdmin = (method, url) => request(app)[method](url).set("Authorization", admin.auth);
const changes = async (field) => (await pool.query(
  "SELECT field, old_value, new_value, reason, changed_by FROM product_changes WHERE product_id = ? AND field = ? ORDER BY change_id",
  [productId, field]))[0];

beforeEach(async () => {
  await resetDb();
  admin = await createUser({ role: "admin" });
  customer = await createUser();
  productId = await createProduct({ price: 500, stock: 10, reserved: 3, createdBy: admin.id });
});
afterAll(() => pool.end());

describe("GET /api/products/:id (product page)", () => {
  test("returns the product with available stock and its photos", async () => {
    await pool.query("UPDATE products SET image_path = '/uploads/cover.jpg', description = 'Genuine Epson part' WHERE product_id = ?", [productId]);
    await pool.query("INSERT INTO product_images (product_id, image_path, sort_order) VALUES (?, '/uploads/b.jpg', 1), (?, '/uploads/a.jpg', 0)", [productId, productId]);
    const res = await request(app).get(`/api/products/${productId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: productId, category: "Parts", price: "500.00", stock: 7, weight_kg: "0.500",
      description: "Genuine Epson part", images: ["/uploads/cover.jpg", "/uploads/a.jpg", "/uploads/b.jpg"]
    });
    expect(res.body).not.toHaveProperty("reserved");
  });

  test("hidden and unknown products are 404", async () => {
    await pool.query("UPDATE products SET is_active = 0 WHERE product_id = ?", [productId]);
    expect((await request(app).get(`/api/products/${productId}`)).status).toBe(404);
    expect((await request(app).get("/api/products/999999")).status).toBe(404);
    expect((await request(app).get("/api/products/abc")).status).toBe(404);
  });
});

describe("admin only", () => {
  test("customers and visitors can't edit, adjust, upload or read admin data", async () => {
    const tries = [
      ["patch", `/api/products/${productId}`, { price: 1 }],
      ["post", `/api/products/${productId}/stock`, { change: 5, reason: "restock" }],
      ["get", `/api/products/${productId}/admin`],
      ["get", `/api/products/${productId}/history`],
      ["post", `/api/products/${productId}/image`],
      ["delete", `/api/products/${productId}`]
    ];
    for (const [method, url, body] of tries) {
      expect([method, url, (await request(app)[method](url).set("Authorization", customer.auth).send(body)).status]).toEqual([method, url, 403]);
      expect([method, url, (await request(app)[method](url).send(body)).status]).toEqual([method, url, 401]);
    }
    const [[p]] = await pool.query("SELECT price, stock_quantity, is_active FROM products WHERE product_id = ?", [productId]);
    expect(p).toEqual({ price: "500.00", stock_quantity: 10, is_active: 1 });
  });
});

describe("PATCH /api/products/:id (edit form)", () => {
  test("saves the fields and logs each change with old and new values and who", async () => {
    await pool.query("INSERT INTO categories (name) VALUES ('Laptop Parts')");
    const res = await asAdmin("patch", `/api/products/${productId}`).send({
      name: "Fuser unit L3110", brand: "Epson", description: "OEM", category: "Laptop Parts", price: 650.5, weight_kg: 1.25
    });
    expect(res.status).toBe(200);
    const [rows] = await pool.query(
      "SELECT field, old_value, new_value, changed_by FROM product_changes WHERE product_id = ? AND field <> 'created' ORDER BY field", [productId]);
    expect(rows).toEqual([
      { field: "brand", old_value: null, new_value: "Epson", changed_by: admin.id },
      { field: "category", old_value: "Parts", new_value: "Laptop Parts", changed_by: admin.id },
      { field: "description", old_value: null, new_value: "OEM", changed_by: admin.id },
      { field: "name", old_value: expect.stringMatching(/^Product/), new_value: "Fuser unit L3110", changed_by: admin.id },
      { field: "price", old_value: "500.00", new_value: "650.50", changed_by: admin.id },
      { field: "weight", old_value: "0.500", new_value: "1.250", changed_by: admin.id }
    ]);
    // The ML trigger still fires on the same update.
    const [[ml]] = await pool.query("SELECT old_value, new_value, changed_by FROM ml_events WHERE product_id = ? AND event_type = 'PRICE_CHANGED'", [productId]);
    expect(ml).toEqual({ old_value: "500.00", new_value: "650.50", changed_by: admin.id });
  });

  test("validation: price > 0, weight > 0, name required, known category; stock not editable here", async () => {
    const tryPatch = async (body) => (await asAdmin("patch", `/api/products/${productId}`).send(body)).body.error;
    expect(await tryPatch({ price: 0 })).toBe("Price must be more than ₱0.");
    expect(await tryPatch({ price: -5 })).toBe("Price must be more than ₱0.");
    expect(await tryPatch({ price: "abc" })).toBe("Price must be more than ₱0.");
    expect(await tryPatch({ weight_kg: 0 })).toMatch(/Weight must be more than 0/);
    expect(await tryPatch({ name: "   " })).toBe("Product name is required.");
    expect(await tryPatch({ name: "x".repeat(151) })).toMatch(/150 characters/);
    expect(await tryPatch({ category: "Nope" })).toBe("Choose a category.");
    expect(await tryPatch({ is_active: "maybe" })).toBe("Choose shown or hidden.");
    expect(await tryPatch({ stock: 99 })).toMatch(/Adjust stock/);
    expect(await tryPatch({})).toBe("Nothing to update.");
    const [log] = await pool.query("SELECT * FROM product_changes WHERE product_id = ? AND field <> 'created'", [productId]);
    expect(log).toEqual([]);
  });

  test("hiding takes it out of the catalog and carts; restoring brings it back; both are logged", async () => {
    await fillCart(customer.id, [{ productId, quantity: 1 }]);
    expect((await asAdmin("patch", `/api/products/${productId}`).send({ is_active: false })).status).toBe(200);
    expect((await request(app).get(`/api/products/${productId}`)).status).toBe(404);
    const [cart] = await pool.query("SELECT * FROM cart_items");
    expect(cart).toEqual([]);
    expect((await asAdmin("get", `/api/products/${productId}/admin`)).body.is_active).toBe(false);

    expect((await asAdmin("patch", `/api/products/${productId}`).send({ is_active: true })).status).toBe(200);
    expect((await request(app).get(`/api/products/${productId}`)).status).toBe(200);
    expect((await changes("active")).map(c => [c.old_value, c.new_value])).toEqual([["1", "0"], ["0", "1"]]);
  });

  test("POST /api/products validates too", async () => {
    const res = await asAdmin("post", "/api/products").field("name", "Ink pad").field("category", "Parts")
      .field("price", "0").field("stock", "3");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Price must be more than ₱0.");
    const bad = await asAdmin("post", "/api/products").field("name", "Ink pad").field("category", "Parts")
      .field("price", "100").field("stock", "-1");
    expect(bad.body.error).toMatch(/Stock must be a whole number/);
  });
});

describe("POST /api/products/:id/stock (adjust stock)", () => {
  const adjust = (body) => asAdmin("post", `/api/products/${productId}/stock`).send(body);

  test("needs a reason, and the sign must match it", async () => {
    expect((await adjust({ change: 5 })).body.error).toMatch(/Choose a reason/);
    expect((await adjust({ change: 5, reason: "gift" })).body.error).toMatch(/Choose a reason/);
    expect((await adjust({ change: 0, reason: "correction" })).body.error).toMatch(/not 0/);
    expect((await adjust({ change: 1.5, reason: "restock" })).body.error).toMatch(/whole number/);
    expect((await adjust({ change: -2, reason: "restock" })).body.error).toMatch(/positive number/);
    expect((await adjust({ change: 2, reason: "damaged" })).body.error).toMatch(/negative number/);
  });

  test("restock: stock goes up, with a movement row and a history row carrying the reason", async () => {
    const res = await adjust({ change: 5, reason: "restock", note: "Supplier delivery #88" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stock_quantity: 15, reserved: 3, available: 12 });

    const [moves] = await pool.query("SELECT change_qty, reason, reference, note, created_by FROM inventory_movements WHERE product_id = ?", [productId]);
    expect(moves).toEqual([{ change_qty: 5, reason: "restock", reference: "adjustment", note: "Supplier delivery #88", created_by: admin.id }]);
    expect(await changes("stock")).toEqual([{ field: "stock", old_value: "10", new_value: "15",
      reason: "restock: Supplier delivery #88", changed_by: admin.id }]);
    const [[ml]] = await pool.query("SELECT old_value, new_value FROM ml_events WHERE product_id = ? AND event_type = 'STOCK_CHANGED'", [productId]);
    expect(ml).toEqual({ old_value: "10.00", new_value: "15.00" });
  });

  test("can't go below what unpaid orders have reserved", async () => {
    const res = await adjust({ change: -8, reason: "damaged" });   // 10 on hand, 3 reserved -> at most 7 removable
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("You can remove at most 7 units: 3 are held by unpaid orders.");
    expect((await adjust({ change: -7, reason: "correction" })).body).toEqual({ stock_quantity: 3, reserved: 3, available: 0 });
    const [[p]] = await pool.query("SELECT stock_quantity FROM products WHERE product_id = ?", [productId]);
    expect(p.stock_quantity).toBe(3);
  });

  test("history endpoint shows who changed what, newest first", async () => {
    await adjust({ change: 2, reason: "return" });
    await asAdmin("patch", `/api/products/${productId}`).send({ price: 520 });
    const res = await asAdmin("get", `/api/products/${productId}/history`);
    expect(res.body.slice(0, 2).map(h => [h.field, h.old_value, h.new_value, h.reason, h.changed_by])).toEqual([
      ["price", "500.00", "520.00", null, admin.username],
      ["stock", "10", "12", "return", admin.username]
    ]);
    expect(res.body.at(-1)).toMatchObject({ field: "created" });
  });
});

describe("photos", () => {
  const upload = (url, buffer, filename, contentType) =>
    asAdmin("post", url).attach("image", buffer, { filename, contentType });

  test("a real PNG replaces the cover and is logged; the file is stored with a safe name", async () => {
    const res = await upload(`/api/products/${productId}/image`, PNG, "my photo.PNG", "image/png");
    expect(res.status).toBe(200);
    expect(res.body.image).toMatch(/^\/uploads\/\d+-[0-9a-f]{12}\.png$/);
    expect(fs.existsSync(path.join(process.env.UPLOAD_DIR, path.basename(res.body.image)))).toBe(true);
    expect(await changes("image")).toEqual([expect.objectContaining({ old_value: null, new_value: res.body.image, changed_by: admin.id })]);
  });

  test("SVG, files pretending to be images, and files over 5 MB are refused and not kept", async () => {
    const before = fs.readdirSync(process.env.UPLOAD_DIR).length;
    const svg = await upload(`/api/products/${productId}/image`, SVG, "x.svg", "image/svg+xml");
    expect(svg.status).toBe(400);
    expect(svg.body.error).toBe("Photos must be JPEG, PNG, WebP or GIF.");
    const fake = await upload(`/api/products/${productId}/image`, Buffer.from("not really a png"), "x.png", "image/png");
    expect(fake.status).toBe(400);
    expect(fake.body.error).toMatch(/isn't a valid JPEG, PNG, WebP or GIF/);
    const huge = await upload(`/api/products/${productId}/image`, Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]), "big.png", "image/png");
    expect(huge.status).toBe(400);
    expect(huge.body.error).toBe("Photos must be 5 MB or smaller.");
    expect(fs.readdirSync(process.env.UPLOAD_DIR).length).toBe(before);
    const [[p]] = await pool.query("SELECT image_path FROM products WHERE product_id = ?", [productId]);
    expect(p.image_path).toBeNull();
  });

  test("gallery photos can be added (up to 8) and removed; both are logged", async () => {
    const added = await upload(`/api/products/${productId}/images`, PNG, "a.png", "image/png");
    expect(added.status).toBe(201);
    expect((await request(app).get(`/api/products/${productId}`)).body.images).toEqual([added.body.image_path]);
    const del = await asAdmin("delete", `/api/products/${productId}/images/${added.body.image_id}`);
    expect(del.status).toBe(200);
    const [rows] = await pool.query("SELECT field FROM product_changes WHERE product_id = ? AND field LIKE 'photo%' ORDER BY change_id", [productId]);
    expect(rows.map(r => r.field)).toEqual(["photo_added", "photo_removed"]);

    for (let i = 0; i < 8; i++) await pool.query("INSERT INTO product_images (product_id, image_path) VALUES (?, ?)", [productId, `/uploads/g${i}.png`]);
    const ninth = await upload(`/api/products/${productId}/images`, PNG, "z.png", "image/png");
    expect(ninth.status).toBe(400);
    expect(ninth.body.error).toMatch(/up to 8 extra photos/);
  });
});
