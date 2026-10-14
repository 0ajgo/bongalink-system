// The admin Deliveries page and the customer My Orders page, run in jsdom
// against a stubbed API (see pageHarness.js).
const { openPage } = require("./pageHarness");

const awaitingOrder = (overrides = {}) => ({
  order_id: 41, order_status: "paid", paid_at: "2026-10-14T08:00:00Z", created_at: "2026-10-14T07:55:00Z",
  total_amount: "600.00", shipping_fee: "100.00", courier_chosen: "LBC", courier_chosen_label: "LBC Express",
  customer_username: "juan", customer_email: "juan@example.com",
  ship_name: "Juan <b>Dela Cruz</b>", ship_phone: "09171234567", ship_address: "123 Street, Pembo, Makati, 1218",
  ship_region: "NCR", ship_landmark: null, has_map_pin: false, can_book_lalamove: false,
  items: [{ product_id: 1, name: "Fuser unit", quantity: 2, unit_price: "250.00" }],
  ...overrides
});

const delivery = (overrides = {}) => ({
  delivery_id: 7, order_id: 40, courier: "JNT", courier_label: "J&T Express", tracking_number: "JT0001234567",
  tracking_url: "https://www.jtexpress.ph/track?waybill=JT0001234567", fee_charged: "100.00", fee_actual: null,
  status: "PICKED_UP", updated_at: "2026-10-14T09:00:00Z", delivered_at: null,
  customer_username: "maria", ship_name: "Maria", ship_phone: "0917", ship_address: "Cebu City",
  items: [{ name: "Printhead", quantity: 1 }],
  ...overrides
});

// A stub API for the deliveries page; `state` can be changed between calls.
function deliveriesApi(state) {
  return async ({ url }) => {
    if (url === "/v1/admin/orders/to-ship") return { body: { count: state.awaiting.length } };
    if (url === "/v1/admin/orders/awaiting-shipment") return { body: state.awaiting };
    if (url.startsWith("/v1/admin/shipments?") || url === "/v1/admin/shipments") return { body: state.shipments };
    if (url.endsWith("/manual") || url.endsWith("/lalamove")) return { status: 201, body: { delivery_id: 9 } };
    if (url.endsWith("/status")) return { body: { ok: true } };
    return { status: 404, body: { error: "unexpected " + url } };
  };
}

describe("admin Deliveries page", () => {
  test("non-admins see the locked message and no data is requested", async () => {
    const page = await openPage("Pages/Admin/deliveries.html", { role: "user", api: async () => ({}) });
    expect(page.$("#locked").hidden).toBe(false);
    expect(page.$("#dashboard").hidden).toBe(true);
    expect(page.calls).toEqual([]);
    page.close();
  });

  test("shows each paid order with customer, address, items, chosen courier and fee", async () => {
    const page = await openPage("Pages/Admin/deliveries.html",
      { role: "admin", api: deliveriesApi({ awaiting: [awaitingOrder()], shipments: [] }) });
    const card = page.$(".ship-card");
    const text = card.textContent.replace(/\s+/g, " ");
    expect(text).toContain("Order #41");
    expect(text).toContain("juan@example.com");
    expect(text).toContain("123 Street, Pembo, Makati, 1218");
    expect(text).toContain("2 × Fuser unit");
    expect(text).toContain("LBC Express");
    expect(text).toContain("Shipping fee paid: ₱100.00");
    // customer text is escaped, not rendered as HTML
    expect(card.querySelector("b")).toBeNull();
    expect(text).toContain("Juan <b>Dela Cruz</b>");
    // the courier chosen at checkout is preselected
    expect(card.querySelector("select[name=courier]").value).toBe("LBC");
    // badge next to the nav link
    expect(page.$("#to-ship-badge").textContent).toBe("1 paid order to ship");
    expect(page.$("#to-ship-badge").getAttribute("href")).toBe("deliveries.html");
    page.close();
  });

  test("Lalamove button only when the server says it can be booked", async () => {
    const page = await openPage("Pages/Admin/deliveries.html", { role: "admin", api: deliveriesApi({
      awaiting: [
        awaitingOrder({ order_id: 1, courier_chosen: "LALAMOVE", has_map_pin: true, can_book_lalamove: true }),
        awaitingOrder({ order_id: 2, courier_chosen: "LALAMOVE", has_map_pin: false, can_book_lalamove: false }),
        awaitingOrder({ order_id: 3, courier_chosen: "JNT", has_map_pin: true, can_book_lalamove: false })
      ],
      shipments: []
    }) });
    const card = (id) => page.$(`.ship-card[data-order="${id}"]`);
    expect(card(1).querySelector("[data-lalamove]")).not.toBeNull();
    expect(card(2).querySelector("[data-lalamove]")).toBeNull();
    expect(card(2).textContent).toMatch(/no map pin/);
    expect(card(3).querySelector("[data-lalamove]")).toBeNull();

    card(1).querySelector("[data-lalamove]").click();
    await page.settle();
    expect(page.calls).toContainEqual(expect.objectContaining({ url: "/v1/admin/shipments/1/lalamove", method: "POST" }));
    page.close();
  });

  test("ship with J&T/LBC posts the tracking number and optional actual fee, then reloads", async () => {
    const state = { awaiting: [awaitingOrder()], shipments: [] };
    const page = await openPage("Pages/Admin/deliveries.html", { role: "admin", api: deliveriesApi(state) });
    const form = page.$("form[data-manual='41']");
    form.elements.courier.value = "JNT";
    form.elements.tracking.value = " JT0009988776 ";
    form.elements.fee.value = "95.5";
    state.awaiting = [];
    state.shipments = [delivery({ order_id: 41 })];
    form.dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
    await page.settle();

    expect(page.calls).toContainEqual({ url: "/v1/admin/shipments/41/manual", method: "POST",
      body: { courier: "JNT", tracking_number: "JT0009988776", fee_actual: 95.5 } });
    expect(page.$("#awaitingList").textContent).toMatch(/No paid orders waiting/);
    expect(page.$("#shipmentRows").textContent).toContain("#41");
    expect(page.$("#toast").textContent).toMatch(/marked as shipped/);
    page.close();
  });

  test("an invalid tracking number is not sent", async () => {
    const page = await openPage("Pages/Admin/deliveries.html",
      { role: "admin", api: deliveriesApi({ awaiting: [awaitingOrder()], shipments: [] }) });
    const form = page.$("form[data-manual='41']");
    form.elements.tracking.value = "x";
    form.dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
    await page.settle();
    expect(page.calls.some(c => c.url.endsWith("/manual"))).toBe(false);
    page.close();
  });

  test("outgoing deliveries: tracking link, status filter, and status update with a note", async () => {
    const page = await openPage("Pages/Admin/deliveries.html", { role: "admin", api: deliveriesApi({
      awaiting: [], shipments: [delivery(), delivery({ delivery_id: 8, order_id: 39, status: "DELIVERED", delivered_at: "2026-10-13T09:00:00Z" })]
    }) });
    const rows = page.$$("#shipmentRows tr");
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector("a").href).toBe("https://www.jtexpress.ph/track?waybill=JT0001234567");
    expect(rows[0].textContent).toContain("Handed to courier");
    // delivered rows can't be changed
    expect(rows[1].querySelector("form")).toBeNull();
    // the five statuses the admin can set
    expect([...rows[0].querySelectorAll("select option")].map(o => o.value))
      .toEqual(["IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "FAILED", "RETURNED"]);

    const form = rows[0].querySelector("form");
    form.elements.status.value = "OUT_FOR_DELIVERY";
    form.elements.note.value = "Rider left the hub";
    form.dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
    await page.settle();
    expect(page.calls).toContainEqual({ url: "/v1/admin/shipments/7/status", method: "PATCH",
      body: { status: "OUT_FOR_DELIVERY", note: "Rider left the hub" } });

    const filter = page.$("#statusFilter");
    filter.value = "IN_TRANSIT";
    filter.dispatchEvent(new page.window.Event("change"));
    await page.settle();
    expect(page.calls.at(-1)).toMatchObject({ url: "/v1/admin/shipments?status=IN_TRANSIT", method: "GET" });
    page.close();
  });
});

describe("customer My Orders page", () => {
  const orders = [
    { order_id: 45, status: "pending_payment", total_amount: "230.00", shipping_fee: "130.00", courier: "LBC",
      paid_at: null, created_at: "2026-10-14T10:00:00Z", items: [{ name: "Waste ink pad", quantity: 1 }] },
    { order_id: 44, status: "shipped", total_amount: "600.00", shipping_fee: "100.00", courier: "JNT",
      paid_at: "2026-10-13T10:00:00Z", created_at: "2026-10-13T09:00:00Z", items: [{ name: "Fuser unit", quantity: 2 }] },
    { order_id: 43, status: "paid", total_amount: "300.00", shipping_fee: "100.00", courier: "JNT",
      paid_at: "2026-10-12T10:00:00Z", created_at: "2026-10-12T09:00:00Z", items: [{ name: "Printhead", quantity: 1 }] }
  ];
  const tracking = {
    courier: "JNT", courier_label: "J&T Express", status: "IN_TRANSIT", tracking_number: "JT0001234567",
    tracking_url: "https://www.jtexpress.ph/track?waybill=JT0001234567",
    events: [
      { status: "PICKED_UP", note: "Dropped off at J&T Express", created_at: "2026-10-13T11:00:00Z" },
      { status: "IN_TRANSIT", note: null, created_at: "2026-10-14T08:00:00Z" }
    ]
  };
  const api = async ({ url, method }) => {
    if (url === "/orders") return { body: orders };
    if (url === "/v1/orders/44/tracking") return { body: tracking };
    if (url === "/v1/payments/checkout" && method === "POST") return { body: { checkout_url: "about:blank#paymongo" } };
    return { status: 404, body: { error: "No shipment yet for this order" } };
  };

  test("lists orders with status, items and totals; tracking timeline for shipped orders", async () => {
    const page = await openPage("Pages/COpage/orders.html", { api });
    const cards = page.$$(".order");
    expect(cards.map(c => c.dataset.order)).toEqual(["45", "44", "43"]);
    expect(cards[0].textContent).toContain("Waiting for payment");
    expect(cards[1].textContent).toContain("2 × Fuser unit");
    expect(cards[1].textContent).toMatch(/Total\s*₱600\.00/);

    // only shipped/delivered orders ask for tracking
    expect(page.calls.filter(c => c.url.includes("/tracking")).map(c => c.url)).toEqual(["/v1/orders/44/tracking"]);
    const t = cards[1].querySelector(".tracking");
    expect(t.hidden).toBe(false);
    expect(t.textContent).toContain("J&T Express");
    expect(t.textContent).toContain("JT0001234567");
    expect(t.querySelector("a").href).toBe("https://www.jtexpress.ph/track?waybill=JT0001234567");
    const steps = [...t.querySelectorAll(".timeline li")];
    expect(steps.map(li => li.querySelector(".timeline__status").textContent))
      .toEqual(["In transit", "Handed to the courier"]);   // newest first
    expect(steps[0].classList.contains("is-latest")).toBe(true);
    expect(steps[1].querySelector(".timeline__note").textContent).toBe("Dropped off at J&T Express");
    expect(steps.every(li => li.querySelector(".timeline__time").textContent.trim().length > 0)).toBe(true);

    // a paid order not yet shipped shows no tracking box
    expect(cards[2].querySelector(".tracking").hidden).toBe(true);
    page.close();
  });

  test("Pay now only on unpaid orders, and it opens PayMongo for that order", async () => {
    const page = await openPage("Pages/COpage/orders.html", { api });
    const buttons = page.$$("[data-pay]");
    expect(buttons.map(b => b.dataset.pay)).toEqual(["45"]);
    buttons[0].click();
    await page.settle();
    expect(page.calls).toContainEqual({ url: "/v1/payments/checkout", method: "POST", body: { order_id: 45 } });
    page.close();
  });
});

describe("homepage navigation", () => {
  const catalogApi = async ({ url }) => ({ body: url === "/cart" ? [] : [] });

  test.each([
    ["user", { ordersLink: false, inventoryLink: true, deliveriesLink: true }],
    ["admin", { ordersLink: true, inventoryLink: false, deliveriesLink: false }]
  ])("%s sees the right links", async (role, hidden) => {
    const page = await openPage("Pages/Homepage/homepage.html", { role, api: catalogApi });
    for (const [id, isHidden] of Object.entries(hidden)) {
      expect([id, page.$(`#${id}`).hidden]).toEqual([id, isHidden]);
    }
    page.close();
  });
});
