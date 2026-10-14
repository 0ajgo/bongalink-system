// Checkout with a map pin, the admin rate card and the weight flags — in jsdom with a stubbed API.
const { openPage } = require("./pageHarness");

const CEBU = { lat: 10.3157, lng: 123.8854 };
const cebuLocation = { region: "VII", province: "Cebu", city: "Cebu City", barangay: "Guadalupe", postcode: "6000", zone: "VISAYAS" };
const cebuQuote = {
  zone: "VISAYAS", weight_kg: 1.5,
  location: { source: "pin", region: "VII", province: "Cebu", city: "Cebu City", zone: "VISAYAS", ...CEBU },
  options: [
    { courier: "JNT", label: "J&T Express", fee: 230, eta: "3-7 days", source: "rate_table", basis: "J&T Visayas rate, 1.5 kg (up to 3 kg)" },
    { courier: "LBC", label: "LBC Express", fee: 280, eta: "3-7 days", source: "rate_table", basis: "LBC Visayas rate, 1.5 kg (up to 3 kg)" }
  ]
};

function checkoutApi({ orderAnswer } = {}) {
  return async ({ url, method }) => {
    if (url === "/cart") return { body: [{ id: 7, quantity: 3, name: "Fuser unit", price: "200.00", image: null, stock: 5 }] };
    if (url === "/v1/account/me") return { body: { email: "juan@example.com" } };
    if (url === "/v1/account/addresses") return { body: [] };
    if (url === "/v1/geo/reverse") return { body: cebuLocation };
    if (url === "/v1/shipping/quote") return { body: cebuQuote };
    if (url === "/orders" && method === "POST") return orderAnswer || { status: 201, body: { orderId: 9 } };
    if (url === "/v1/payments/checkout") return { body: { checkout_url: "about:blank#paymongo" } };
    return { body: {} };
  };
}

function fillContact(page) {
  const f = page.$("#checkout-form").elements;
  Object.entries({ phone: "09171234567", firstName: "Juan", lastName: "Dela Cruz", street: "1 Street" })
    .forEach(([k, v]) => { f[k].value = v; });
  f.consentRequired.checked = true;
}

describe("checkout with a map pin", () => {
  test("dropping a pin fills the address, quotes from the pin and explains each fee", async () => {
    const page = await openPage("Pages/COpage/checkout.html", { api: checkoutApi() });
    expect(page.$("#mapPicker .leaflet-container")).not.toBeNull();
    page.window.eval(`picker.setPin(${JSON.stringify(CEBU)})`);
    await page.until(() => page.$('input[name="courier"]'));

    const f = page.$("#checkout-form").elements;
    expect([page.$("#region").value, f.province.value, f.city.value, f.barangay.value, f.postalCode.value])
      .toEqual(["VII", "Cebu", "Cebu City", "Guadalupe", "6000"]);
    expect(page.$("#mapPicker").textContent).toContain("Pinned: Cebu City, Cebu, Central Visayas");
    expect(page.calls).toContainEqual({ url: "/v1/geo/reverse", method: "POST", body: CEBU });
    const q = page.calls.find(c => c.url === "/v1/shipping/quote").body;
    expect(q.address).toMatchObject({ lat: CEBU.lat, lng: CEBU.lng, region: "VII", city: "Cebu City" });

    const choices = page.$$("#courier-choices .choice").map(c => c.textContent.replace(/\s+/g, " ").trim());
    expect(choices[0]).toBe("J&T Express Arrives in 3-7 days J&T Visayas rate, 1.5 kg (up to 3 kg) ₱230.00");
    expect(page.$("#quote-meta").textContent).toMatch(/Parcel weight: 1\.5 kg/);
    expect(page.$("#quote-meta").textContent).toMatch(/Fees for your pin: Cebu City, Cebu, Central Visayas/);
    page.close();
  });

  test("the order carries the pin and the fee shown", async () => {
    const page = await openPage("Pages/COpage/checkout.html", { api: checkoutApi() });
    page.window.eval(`picker.setPin(${JSON.stringify(CEBU)})`);
    await page.until(() => page.$('input[name="courier"]'));
    fillContact(page);
    page.$('input[name="courier"][value="LBC"]').click();
    expect(page.$("#sum-shipping").textContent).toBe("₱280.00");
    page.$("#checkout-form").dispatchEvent(new page.window.Event("submit", { cancelable: true }));
    // wait for the whole flow (order, then PayMongo) so nothing is still running after close()
    await page.until(() => page.calls.some(c => c.url === "/v1/payments/checkout"));
    const order = page.calls.find(c => c.url === "/orders").body;
    expect(order).toMatchObject({ courier: "LBC", expected_shipping_fee: 280,
      address: { lat: CEBU.lat, lng: CEBU.lng, region: "VII", province: "Cebu", city: "Cebu City" } });
    page.close();
  });

  test("if the fee changed, the new quote is loaded and the customer is told", async () => {
    const page = await openPage("Pages/COpage/checkout.html", { api: checkoutApi({ orderAnswer: { status: 409,
      body: { error: "The shipping fee for this courier is now ₱250.00. Please review it and place the order again.", code: "SHIPPING_FEE_CHANGED", shippingFee: 250 } } }) });
    page.window.eval(`picker.setPin(${JSON.stringify(CEBU)})`);
    await page.until(() => page.$('input[name="courier"]'));
    fillContact(page);
    page.$('input[name="courier"][value="JNT"]').click();
    const quotesBefore = page.calls.filter(c => c.url === "/v1/shipping/quote").length;
    page.$("#checkout-form").dispatchEvent(new page.window.Event("submit", { cancelable: true }));
    await page.until(() => page.$("#order-error").textContent);
    expect(page.$("#order-error").textContent).toContain("now ₱250.00");
    expect(page.calls.filter(c => c.url === "/v1/shipping/quote").length).toBe(quotesBefore + 1);
    expect(page.calls.some(c => c.url === "/v1/payments/checkout")).toBe(false);
    page.close();
  });

  test("without a pin the fee note says it's based on the chosen region", async () => {
    const page = await openPage("Pages/COpage/checkout.html", { api: async (call) =>
      call.url === "/v1/shipping/quote"
        ? { body: { ...cebuQuote, location: { source: "typed", region: "VII", province: null, zone: "VISAYAS" } } }
        : checkoutApi()(call) });
    page.$("#region").value = "VII";
    page.$("#region").dispatchEvent(new page.window.Event("change"));
    await page.until(() => page.$('input[name="courier"]'));
    expect(page.$("#quote-meta").textContent).toContain("Fees for the region you chose. Pin your location for exact fees.");
    expect(page.calls.find(c => c.url === "/v1/shipping/quote").body.address.lat).toBeUndefined();
    page.close();
  });
});

describe("admin Shipping rates page", () => {
  const rateData = {
    rates: [
      { rate_id: 1, courier: "JNT", zone: "NCR", max_weight_kg: 1, fee: 100, updated_at: "2026-10-14T08:00:00Z" },
      { rate_id: 2, courier: "JNT", zone: "NCR", max_weight_kg: 3, fee: 150, updated_at: "2026-10-14T08:00:00Z" },
      { rate_id: 3, courier: "LBC", zone: "VISAYAS", max_weight_kg: 3, fee: 280, updated_at: "2026-10-12T08:00:00Z" }
    ],
    last_updated: { JNT: "2026-10-14T08:00:00Z", LBC: "2026-10-12T08:00:00Z" }
  };
  const api = async ({ url }) => {
    if (url.startsWith("/v1/admin/shipping-rates")) return { body: rateData };
    if (url === "/v1/admin/orders/to-ship") return { body: { count: 0 } };
    return { body: {} };
  };

  test("one card per courier with last updated, brackets and missing zones", async () => {
    const page = await openPage("Pages/Admin/rates.html", { role: "admin", api });
    const cards = page.$$("#rateCards section");
    expect(cards.map(c => c.querySelector("h2").textContent)).toEqual(["J&T Express", "LBC Express"]);
    expect(cards[0].querySelector(".card__header").textContent).toMatch(/Last updated Oct 14, 2026/);
    expect(cards[0].querySelectorAll("tbody tr")).toHaveLength(2);
    expect(cards[0].textContent).toContain("No rates for Luzon, Visayas, Mindanao, Island provinces");
    expect(cards[1].textContent).toContain("No rates for Metro Manila, Luzon, Mindanao, Island provinces");
    page.close();
  });

  test("editing a fee and adding a bracket send the right requests", async () => {
    const page = await openPage("Pages/Admin/rates.html", { role: "admin", api });
    const row = page.$('tr[data-rate="2"]');
    row.querySelector('[data-field="fee"]').value = "165";
    row.querySelector('[data-field="fee"]').dispatchEvent(new page.window.Event("input", { bubbles: true }));
    expect(row.querySelector("[data-save]").disabled).toBe(false);
    row.querySelector("[data-save]").click();
    await page.settle();
    expect(page.calls).toContainEqual({ url: "/v1/admin/shipping-rates/2", method: "PATCH", body: { max_weight_kg: "3", fee: "165" } });

    const form = page.$('form[data-add="LBC"]');
    form.elements.zone.value = "ISLAND_PROVINCE";
    form.elements.max_weight_kg.value = "1";
    form.elements.fee.value = "230";
    form.dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
    await page.settle();
    expect(page.calls).toContainEqual({ url: "/v1/admin/shipping-rates", method: "POST",
      body: { courier: "LBC", zone: "ISLAND_PROVINCE", max_weight_kg: "1", fee: "230" } });
    page.close();
  });

  test("customers get the admin-required message", async () => {
    const page = await openPage("Pages/Admin/rates.html", { role: "user", api });
    expect(page.$("main").textContent).toContain("Admin account required");
    expect(page.calls.some(c => c.url.includes("shipping-rates"))).toBe(false);
    page.close();
  });
});

describe("inventory weight flags", () => {
  const prediction = (id, weight) => ({ product_id: id, name: `Part ${id}`, category: "Printer Parts", price: "100.00",
    stock_quantity: 3, reserved: 0, available: 3, weight_kg: weight, computed_at: null });
  const api = async ({ url, method, body }) => {
    if (url === "/admin/ml/predictions") return { body: [prediction(1, "0.500"), prediction(2, "1.250"), prediction(3, "0.500")] };
    if (url === "/admin/ml/status") return { body: { state: "up_to_date", worker_online: true, last_update_at: "2026-10-14T08:00:00Z" } };
    if (url.startsWith("/admin/ml/history")) return { body: { product: { name: "Part 1", is_active: 1 }, series: [{ day: "2026-10-13", units: 1 }] } };
    if (url === "/admin/ml/products") return { body: [{ product_id: 1, name: "Part 1", is_active: 1 }] };
    if (url === "/v1/admin/orders/to-ship") return { body: { count: 0 } };
    return { body: method === "GET" ? [] : {} };
  };

  test("parts on the 0.5 kg default are flagged and the weight can be saved", async () => {
    const page = await openPage("Pages/Admin/inventory.html", { role: "admin", api });
    await page.until(() => page.$('#predRows tr[data-id="1"]'));
    expect(page.$("#weightNotice").hidden).toBe(false);
    expect(page.$("#weightNotice").textContent).toContain("2 parts still use the default 0.5 kg weight");
    expect(page.$('tr[data-id="1"]').textContent).toContain("Default");
    expect(page.$('tr[data-id="2"]').textContent).not.toContain("Default");

    // Saved automatically when the field loses focus (change event); the Default flag goes away.
    const input = page.$('tr[data-id="1"] [data-field="weight"]');
    input.value = "0.8";
    input.dispatchEvent(new page.window.Event("change", { bubbles: true }));
    await page.until(() => page.calls.some(c => c.method === "PATCH"));
    expect(page.calls).toContainEqual({ url: "/products/1", method: "PATCH", body: { weight_kg: 0.8 } });
    await page.until(() => page.$("#qs-weight-1").textContent.includes("Saved"));
    expect(page.$('tr[data-id="1"]').textContent).not.toContain("Default");
    expect(page.$("#weightNotice").textContent).toContain("1 part still uses the default 0.5 kg weight");
    page.close();
  });
});
