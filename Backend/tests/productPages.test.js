// Customer product page and the admin "Edit part" dialog, in jsdom with a stubbed API.
const { openPage } = require("./pageHarness");

const fuser = (overrides = {}) => ({
  id: 12, name: "Fuser unit L3110", category: "Printer Parts", brand: "Epson", price: "1250.00", stock: 5,
  image: "/uploads/cover.jpg", images: ["/uploads/cover.jpg", "/uploads/side.jpg", "/uploads/back.jpg"],
  description: "Genuine Epson fuser.\nFits L3110 and L3150.", weight_kg: "0.800", created_at: "2026-10-01T00:00:00Z", ...overrides
});
const related = [
  { id: 12, name: "Fuser unit L3110", category: "Printer Parts", price: "1250.00", stock: 5 },
  { id: 13, name: "Printhead L3110", category: "Printer Parts", price: "2800.00", stock: 0 },
  { id: 14, name: "Pickup roller", category: "Printer Parts", price: "350.00", stock: 4 }
];

function productApi({ product = fuser(), later = null, status = 200 } = {}) {
  let n = 0;
  return async ({ url, method, body }) => {
    if (url === "/products/12") {
      n++;
      if (status !== 200) return { status, body: { error: status === 404 ? "Product not found." : "Database is down" } };
      return { body: n > 1 && later ? later : product };
    }
    if (url.startsWith("/products?category=")) return { body: related };
    if (url === "/cart" && method === "POST") return { body: {} };
    if (url === "/cart") return { body: [{ id: 12, quantity: body ? body.quantity : 2, name: "Fuser unit L3110", price: "1250.00", image: null, stock: 5 }] };
    if (url === "/v1/admin/orders/to-ship") return { body: { count: 0 } };
    return { body: [] };
  };
}

describe("product page", () => {
  test("shows the product, its photos, availability, weight and description; title and breadcrumb", async () => {
    const page = await openPage("Pages/Homepage/product.html", { query: "id=12", api: productApi() });
    expect(page.doc.title).toBe("Fuser unit L3110 — Bongalink");
    expect(page.$("h1").textContent).toBe("Fuser unit L3110");
    expect(page.$(".product__price").textContent).toBe("₱1,250.00");
    expect(page.$(".product__stock").textContent).toMatch(/In stock\s*5 available\./);
    expect(page.$(".product__facts").textContent).toContain("0.8 kg");
    expect(page.$(".product__description").textContent).toContain("Fits L3110 and L3150.");
    expect(page.$$("#breadcrumb li").map(li => li.textContent.trim())).toEqual(["Home", "Printer Parts", "Fuser unit L3110"]);
    expect(page.$$("#breadcrumb a")[1].getAttribute("href")).toBe("homepage.html?category=Printer%20Parts#catalog");
    expect(page.$('a[href="homepage.html#catalog"]').textContent).toContain("Back to shop");

    // gallery: thumbnails switch the main photo; clicking it opens the larger view
    expect(page.$$("[data-photo]")).toHaveLength(3);
    page.$('[data-photo="2"]').click();
    expect(page.$("#mainPhoto img").src).toBe("http://localhost:4000/uploads/back.jpg");
    page.$("#mainPhoto").click();
    expect(page.$("#photoDialog").open).toBe(true);
    expect(page.$("#photoLarge").alt).toBe("Fuser unit L3110, photo 3 of 3");
    page.close();
  });

  test("related parts: same category, not this one, in stock first, linking to their pages", async () => {
    const page = await openPage("Pages/Homepage/product.html", { query: "id=12", api: productApi() });
    await page.until(() => !page.$("#relatedSection").hidden);
    const names = page.$$("#relatedGrid .product-card__name a");
    expect(names.map(a => a.textContent)).toEqual(["Pickup roller", "Printhead L3110"]);
    expect(names[0].getAttribute("href")).toBe("../Homepage/product.html?id=14");
    page.close();
  });

  test("quantity is capped at available stock and added to the server cart", async () => {
    const page = await openPage("Pages/Homepage/product.html", { query: "id=12", api: productApi({ product: fuser({ stock: 2 }) }) });
    page.$("#qtyUp").click();
    expect(page.$("#qty").value).toBe("2");
    expect(page.$("#qtyUp").disabled).toBe(true);
    page.$("#qty").value = "9";
    page.$("#qty").dispatchEvent(new page.window.Event("change"));
    expect(page.$("#qty").value).toBe("2");
    page.$("#addToCart").click();
    await page.until(() => page.calls.some(c => c.url === "/cart" && c.method === "POST"));
    expect(page.calls).toContainEqual({ url: "/cart", method: "POST", body: { productId: "12", quantity: 2 } });
    page.close();
  });

  test("stock changed since the page loaded: clear message, quantity lowered, nothing added yet", async () => {
    const page = await openPage("Pages/Homepage/product.html", { query: "id=12", api: productApi({ later: fuser({ stock: 1 }) }) });
    page.$("#qtyUp").click();
    page.$("#qtyUp").click();   // 3 wanted, but only 1 left when we check again
    page.$("#addToCart").click();
    await page.until(() => page.$("#stockAlert").textContent);
    expect(page.$("#stockAlert").textContent).toContain("only 1 available now");
    expect(page.$("#qty").value).toBe("1");
    expect(page.calls.some(c => c.url === "/cart" && c.method === "POST")).toBe(false);
    page.close();
  });

  test("out of stock: Add to cart disabled", async () => {
    const page = await openPage("Pages/Homepage/product.html", { query: "id=12", api: productApi({ product: fuser({ stock: 0 }) }) });
    expect(page.$("#addToCart").disabled).toBe(true);
    expect(page.$("#addToCart").textContent.trim()).toBe("Out of stock");
    expect(page.$(".product__stock .badge").textContent).toBe("Out of stock");
    page.close();
  });

  test("not found, bad id and error states", async () => {
    const missing = await openPage("Pages/Homepage/product.html", { query: "id=12", api: productApi({ status: 404 }) });
    expect(missing.$("#productView").textContent).toContain("We can't find that part");
    expect(missing.doc.title).toBe("Part not found — Bongalink");
    missing.close();

    const bad = await openPage("Pages/Homepage/product.html", { query: "id=abc", api: productApi() });
    expect(bad.$("#productView").textContent).toContain("We can't find that part");
    expect(bad.calls.some(c => c.url.startsWith("/products/"))).toBe(false);
    bad.close();

    const down = await openPage("Pages/Homepage/product.html", { query: "id=12", api: productApi({ status: 500 }) });
    expect(down.$("#productView").textContent).toContain("Database is down");
    expect(down.$("#retryProduct")).not.toBeNull();
    down.close();
  });

  test("admins see Edit this part instead of buying", async () => {
    const page = await openPage("Pages/Homepage/product.html", { role: "admin", query: "id=12", api: productApi() });
    expect(page.$("#addToCart")).toBeNull();
    expect(page.$('a[href="../Admin/inventory.html?edit=12"]').textContent).toContain("Edit this part");
    page.close();
  });
});

describe("product cards link to the product page", () => {
  test("image and name", async () => {
    const page = await openPage("Pages/Homepage/homepage.html", { role: null, api: async ({ url }) =>
      ({ body: url === "/products" ? [{ id: 7, name: "Ink pad", category: "Printer Parts", price: "90.00", stock: 3, created_at: "2026-10-01" }] : [] }) });
    const card = page.$("#grid .product-card");
    expect(card.querySelector(".product-card__media a").getAttribute("href")).toBe("../Homepage/product.html?id=7");
    expect(card.querySelector(".product-card__name a").getAttribute("href")).toBe("../Homepage/product.html?id=7");
    page.close();
  });
});

describe("admin Edit part dialog", () => {
  const adminProduct = (overrides = {}) => ({
    id: 12, name: "Fuser unit L3110", category: "Printer Parts", brand: "Epson", price: "1250.00", description: "OEM",
    weight_kg: "0.800", image: null, is_active: true, stock_quantity: 10, reserved: 3, available: 7,
    gallery: [{ image_id: 5, image_path: "/uploads/side.jpg" }], ...overrides
  });
  const history = [
    { change_id: 2, field: "price", old_value: "1200.00", new_value: "1250.00", reason: null, changed_at: "2026-10-14T08:00:00Z", changed_by: "AjGo" },
    { change_id: 1, field: "stock", old_value: "5", new_value: "10", reason: "restock: delivery #88", changed_at: "2026-10-13T08:00:00Z", changed_by: "AjGo" }
  ];
  function inventoryApi() {
    const counts = { predictions: 0 };
    const api = async ({ url, method }) => {
      if (url === "/admin/ml/predictions") { counts.predictions++; return { body: [{ product_id: 12, name: "Fuser unit L3110", category: "Printer Parts",
        price: "1250.00", stock_quantity: 10, reserved: 3, available: 7, weight_kg: "0.800", computed_at: null }] }; }
      if (url === "/admin/ml/status") return { body: { state: "up_to_date", worker_online: true, last_update_at: "2026-10-14T08:00:00Z" } };
      if (url === "/admin/ml/products") return { body: [{ product_id: 12, name: "Fuser unit L3110", is_active: 1 }, { product_id: 20, name: "Old scanner", is_active: 0 }] };
      if (url.startsWith("/admin/ml/history")) return { body: { product: { name: "Fuser", is_active: 1 }, series: [{ day: "2026-10-13", units: 1 }] } };
      if (url === "/products/12/admin" || url === "/products/20/admin") return { body: adminProduct(url.includes("20") ? { id: 20, name: "Old scanner", is_active: false } : {}) };
      if (url.endsWith("/history") && url.startsWith("/products/")) return { body: history };
      if (url === "/categories") return { body: [{ name: "Printer Parts" }, { name: "Laptop Parts" }] };
      if (url === "/v1/admin/orders/to-ship") return { body: { count: 0 } };
      if (method === "PATCH" || method === "POST") return { body: {} };
      return { body: [] };
    };
    return { api, counts };
  }
  async function openEditor(query = "") {
    const { api, counts } = inventoryApi();
    const page = await openPage("Pages/Admin/inventory.html", { role: "admin", query, api });
    await page.until(() => page.$('#predRows [data-edit="12"]'));
    if (!query) page.$('#predRows [data-edit="12"]').click();
    await page.until(() => !page.$("#editBody").hidden);
    await page.until(() => page.$$("#historyRows tr").length === 2);
    return { page, counts };
  }

  test("opens with the product's details, photos, stock and history", async () => {
    const { page } = await openEditor();
    expect(page.$("#editDialog").open).toBe(true);
    const f = page.$("#editForm").elements;
    expect([f.name.value, f.brand.value, f.category.value, f.price.value, f.weight_kg.value, f.description.value, f.is_active.checked])
      .toEqual(["Fuser unit L3110", "Epson", "Printer Parts", "1250", "0.8", "OEM", true]);
    expect([page.$("#stockOnHand").textContent, page.$("#stockReserved").textContent, page.$("#stockAvailable").textContent]).toEqual(["10", "3", "7"]);
    expect(page.$$("#gallery .photo-tile")).toHaveLength(1);
    const rows = page.$$("#historyRows tr").map(tr => [...tr.cells].map(td => td.textContent.trim()));
    expect(rows[0]).toEqual([expect.any(String), "AjGo", "Price", "₱1,200.00", "₱1,250.00", "—"]);
    expect(rows[1].slice(1)).toEqual(["AjGo", "Stock on hand", "5", "10", "restock: delivery #88"]);
    // stock is no longer edited in the table
    expect(page.$('#predRows [data-field="stock"]')).toBeNull();
    page.close();
  });

  test("saving sends only the changed fields, then refreshes the table without a reload", async () => {
    const { page, counts } = await openEditor();
    const f = page.$("#editForm").elements;
    f.price.value = "1300";
    f.category.value = "Laptop Parts";
    const before = counts.predictions;
    page.$("#editForm").dispatchEvent(new page.window.Event("submit", { cancelable: true }));
    await page.until(() => counts.predictions > before);
    expect(page.calls.find(c => c.method === "PATCH")).toEqual({ url: "/products/12", method: "PATCH", body: { category: "Laptop Parts", price: 1300 } });
    expect(page.$(".toast-region").textContent).toContain("Product saved.");
    page.close();
  });

  test("client-side checks: price must be above 0", async () => {
    const { page } = await openEditor();
    page.$("#editForm").elements.price.value = "0";
    page.$("#editForm").dispatchEvent(new page.window.Event("submit", { cancelable: true }));
    expect(page.$("#editError").textContent).toBe("Price must be more than ₱0.");
    expect(page.calls.some(c => c.method === "PATCH")).toBe(false);
    page.close();
  });

  test("Adjust stock: reason picks the direction; can't go below reserved", async () => {
    const { page } = await openEditor();
    const f = page.$("#stockForm").elements;
    f.reason.value = "damaged";
    f.reason.dispatchEvent(new page.window.Event("change"));
    f.quantity.value = "8";   // 10 on hand, 3 reserved -> at most 7
    page.$("#stockForm").dispatchEvent(new page.window.Event("submit", { cancelable: true }));
    expect(page.$("#stockError").textContent).toBe("You can remove at most 7: 3 are held by unpaid orders.");
    expect(page.calls.some(c => c.url === "/products/12/stock")).toBe(false);

    f.reason.value = "correction";
    f.reason.dispatchEvent(new page.window.Event("change"));
    expect(page.$("#directionField").hidden).toBe(false);
    f.direction.value = "remove";
    f.quantity.value = "2";
    f.note.value = "Counted shelf";
    page.$("#stockForm").dispatchEvent(new page.window.Event("submit", { cancelable: true }));
    await page.until(() => page.calls.some(c => c.url === "/products/12/stock"));
    expect(page.calls.find(c => c.url === "/products/12/stock").body).toEqual({ change: -2, reason: "correction", note: "Counted shelf" });
    await page.until(() => page.$(".toast-region")?.textContent.includes("Stock reduced by 2"));   // let the save finish before close()
    page.close();
  });

  test("?edit= opens the editor; hidden parts are listed and can be opened", async () => {
    const { page } = await openEditor("edit=12");
    expect(page.$("#editTitle").textContent).toBe("Edit Fuser unit L3110");
    page.$("#editDialog [data-close]").click();
    expect(page.$("#hiddenSection").hidden).toBe(false);
    page.$('#hiddenList [data-edit="20"]').click();
    await page.until(() => page.$("#editTitle").textContent === "Edit Old scanner");
    expect(page.$("#editStatus").textContent).toBe("Hidden");
    expect(page.$("#editForm").elements.is_active.checked).toBe(false);
    page.close();
  });
});
