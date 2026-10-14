// Inventory forecast table: inline price/weight autosave, the row "More actions"
// menu, and the Adjust stock field errors. jsdom with a stubbed API.
const { openPage } = require("./pageHarness");

const row = (id, overrides = {}) => ({ product_id: id, name: `Part ${id}`, category: "Printer Parts", price: "100.00",
  stock_quantity: 5, reserved: 0, available: 5, weight_kg: "1.000", computed_at: null, ...overrides });

function inventoryApi({ patchStatus = 200 } = {}) {
  return async ({ url, method }) => {
    if (url === "/admin/ml/predictions") return { body: [row(1), row(2, { reserved: 2 })] };
    if (url === "/admin/ml/status") return { body: { state: "up_to_date", worker_online: true, last_update_at: "2026-10-14T08:00:00Z" } };
    if (url === "/admin/ml/products") return { body: [{ product_id: 1, name: "Part 1", is_active: 1 }] };
    if (url.startsWith("/admin/ml/history")) return { body: { product: { name: "Part 1", is_active: 1 }, series: [{ day: "2026-10-13", units: 0 }] } };
    if (url === "/products/1" && method === "PATCH") return patchStatus === 200 ? { body: {} } : { status: patchStatus, body: { error: "Price must be more than ₱0." } };
    if (url === "/products/1" && method === "DELETE") return { body: {} };
    if (url === "/products/1/admin") return { body: { id: 1, name: "Part 1", category: "Printer Parts", brand: null, price: "100.00", description: null,
      weight_kg: "1.000", image: null, is_active: true, stock_quantity: 5, reserved: 2, available: 3, gallery: [] } };
    if (url === "/products/1/history") return { body: [] };
    if (url === "/categories") return { body: [{ name: "Printer Parts" }] };
    if (url === "/v1/admin/orders/to-ship") return { body: { count: 0 } };
    return { body: [] };
  };
}

async function openInventory(opts) {
  const page = await openPage("Pages/Admin/inventory.html", { role: "admin", api: inventoryApi(opts) });
  await page.until(() => page.$('#predRows tr[data-id="1"]'));
  return page;
}
const patches = (page) => page.calls.filter(c => c.method === "PATCH");
const change = (page, input, value) => { input.value = value; input.dispatchEvent(new page.window.Event("change", { bubbles: true })); };

describe("inventory table: compact actions", () => {
  test("each row has Edit and a More actions button, and no Save or Hide buttons", async () => {
    const page = await openInventory();
    const actions = page.$('#predRows tr[data-id="1"] td.actions');
    expect(actions.querySelector("[data-edit]").getAttribute("aria-label")).toBe("Edit Part 1");
    expect(actions.querySelector("[data-more]").getAttribute("aria-haspopup")).toBe("menu");
    expect(actions.querySelector("[data-save], [data-remove]")).toBeNull();
    expect(page.$("#forecasts table").classList.contains("table--sticky-first")).toBe(true);
    page.close();
  });

  test("More actions > Hide from shop asks, then hides; Escape closes the menu", async () => {
    const page = await openInventory();
    const more = page.$('#predRows [data-more="1"]');
    more.click();
    expect(page.$("#rowMenu").hidden).toBe(false);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(page.$("#rowMenu [data-menu-title]").textContent).toBe("Part 1");
    page.doc.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape" }));
    expect(page.$("#rowMenu").hidden).toBe(true);

    page.$('#predRows [data-more="1"]').click();
    page.$('#rowMenu [data-menu-action="hide"]').click();
    await page.until(() => page.calls.some(c => c.method === "DELETE"));
    expect(page.calls).toContainEqual({ url: "/products/1", method: "DELETE", body: undefined });
    // let the toast and reload finish before closing the page
    await page.until(() => page.doc.body.textContent.includes("Part hidden."));
    await page.settle();
    page.close();
  });
});

describe("inventory table: price and weight save automatically", () => {
  test("a changed price is saved on blur with a Saved indicator, sending only that field", async () => {
    const page = await openInventory();
    const input = page.$('#predRows tr[data-id="1"] [data-field="price"]');
    change(page, input, "125.5");
    await page.until(() => page.$("#qs-price-1").textContent.includes("Saved"));
    expect(patches(page)).toEqual([{ url: "/products/1", method: "PATCH", body: { price: 125.5 } }]);
    expect(input.dataset.original).toBe("125.5");
    expect(input.disabled).toBe(false);
    page.close();
  });

  test("nothing is sent when the value didn't change", async () => {
    const page = await openInventory();
    change(page, page.$('#predRows tr[data-id="1"] [data-field="price"]'), "100");
    await page.settle();
    expect(patches(page)).toEqual([]);
    page.close();
  });

  test("0 or empty is refused on the spot and the old value comes back", async () => {
    const page = await openInventory();
    const input = page.$('#predRows tr[data-id="1"] [data-field="weight"]');
    change(page, input, "0");
    expect(input.value).toBe("1");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(page.$("#qs-weight-1").textContent).toBe("Weight must be more than 0. Kept 1 kg.");
    change(page, input, "");
    expect(input.value).toBe("1");
    expect(patches(page)).toEqual([]);
    page.close();
  });

  test("a server error undoes the edit and says why", async () => {
    const page = await openInventory({ patchStatus: 400 });
    const input = page.$('#predRows tr[data-id="1"] [data-field="price"]');
    change(page, input, "130");
    await page.until(() => page.$("#qs-price-1").textContent.startsWith("Not saved"));
    expect(input.value).toBe("100");
    expect(page.$("#qs-price-1").textContent).toBe("Not saved: Price must be more than ₱0.");
    expect(page.$(".toast-region").textContent).toContain("Price not saved");
    page.close();
  });

  test("Escape puts the saved value back without saving", async () => {
    const page = await openInventory();
    const input = page.$('#predRows tr[data-id="1"] [data-field="price"]');
    input.value = "999";
    input.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(input.value).toBe("100");
    await page.settle();
    expect(patches(page)).toEqual([]);
    page.close();
  });
});

describe("Adjust stock: required reason, errors next to the field", () => {
  test("missing reason and units are flagged on their own fields; nothing is sent", async () => {
    const page = await openInventory();
    page.$('#predRows [data-edit="1"]').click();
    await page.until(() => !page.$("#editBody").hidden);
    expect(page.$('label[for="sReason"]').textContent).toContain("(required)");
    expect(page.$("#sReason").getAttribute("aria-required")).toBe("true");

    page.$("#stockForm").dispatchEvent(new page.window.Event("submit", { cancelable: true }));
    expect(page.$("#stockReasonError").textContent).toBe("Choose a reason for this change.");
    expect(page.$("#stockReasonError").closest(".field")).toBe(page.$("#sReason").closest(".field"));
    expect(page.$("#sReason").getAttribute("aria-invalid")).toBe("true");
    expect(page.$("#stockError").closest(".field")).toBe(page.$("#sQty").closest(".field"));
    expect(page.doc.activeElement.id).toBe("sReason");

    // choosing a reason clears its error
    page.$("#sReason").value = "restock";
    page.$("#sReason").dispatchEvent(new page.window.Event("change"));
    expect(page.$("#stockReasonError").textContent).toBe("");
    expect(page.$("#sReason").hasAttribute("aria-invalid")).toBe(false);
    expect(page.calls.some(c => c.url.endsWith("/stock"))).toBe(false);
    page.close();
  });
});
