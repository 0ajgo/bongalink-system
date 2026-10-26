// The admin Deliveries page and the customer My Orders page, run in jsdom
// against a stubbed API (see pageHarness.js).
const { openPage } = require("./pageHarness");

const awaitingOrder = (overrides = {}) => ({
  order_id: 41, order_status: "paid", paid_at: "2026-10-14T08:00:00Z", packed_at: null, created_at: "2026-10-14T07:55:00Z",
  total_amount: "600.00", shipping_fee: "100.00", courier_chosen: "LBC", courier_chosen_label: "LBC Express",
  customer_username: "juan", customer_email: "j***@example.com",
  ship_name: "Juan <b>Dela Cruz</b>", ship_phone: "09171234567", ship_address: "123 Street, Pembo, Makati, 1218",
  ship_city: "Makati", ship_region: "NCR", ship_landmark: null, has_map_pin: false, can_book_lalamove: false,
  items: [{ product_id: 1, name: "Fuser unit", quantity: 2, unit_price: "250.00" }],
  ...overrides
});
const packedOrder = (overrides = {}) => awaitingOrder({ order_status: "packed", packed_at: "2026-10-14T09:00:00Z", ...overrides });

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
    if (url.endsWith("/packed")) return { body: { order_id: 41, status: "packed" } };
    if (url.endsWith("/manual") || url.endsWith("/lalamove")) return { status: 201, body: { delivery_id: 9 } };
    if (url.endsWith("/status")) return { body: { ok: true } };
    return { status: 404, body: { error: "unexpected " + url } };
  };
}
const openDeliveries = (state) => openPage("Pages/Admin/deliveries.html", { role: "admin", api: deliveriesApi(state) });
const submit = (page, form) => form.dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));

describe("admin Deliveries page", () => {
  test("non-admins see the locked message and no data is requested", async () => {
    const page = await openPage("Pages/Admin/deliveries.html", { role: "user", api: async () => ({}) });
    expect(page.$("main").textContent).toContain("Admin account required");
    expect(page.$(".pipe")).toBeNull();
    expect(page.calls).toEqual([]);
    page.close();
  });

  test("three tabs with counts; paid orders are To pack, packed ones Ready to ship", async () => {
    const page = await openDeliveries({
      awaiting: [awaitingOrder(), awaitingOrder({ order_id: 42 }), packedOrder({ order_id: 39 })],
      shipments: [delivery()]
    });
    expect(page.$$(".pipe__tab").map(t => t.querySelector(".pipe__title").textContent)).toEqual(["To pack", "Ready to ship", "Outgoing"]);
    expect([page.$("#countPack"), page.$("#countShip"), page.$("#countOut")].map(c => c.textContent)).toEqual(["2", "1", "1"]);
    expect(page.$("#countPack").getAttribute("aria-label")).toBe("2 orders");
    // To pack is open first; the others are hidden.
    expect(page.$("#tab-pack").getAttribute("aria-selected")).toBe("true");
    expect([page.$("#panel-pack").hidden, page.$("#panel-ship").hidden, page.$("#panel-out").hidden]).toEqual([false, true, true]);
    expect(page.$$("#packRows tr[data-order]").map(r => r.dataset.order)).toEqual(["41", "42"]);
    expect(page.$$("#shipList .ship-row").map(r => r.dataset.order)).toEqual(["39"]);

    page.$("#tab-ship").click();
    expect([page.$("#panel-pack").hidden, page.$("#panel-ship").hidden]).toEqual([true, false]);
    expect(page.$("#tab-ship").getAttribute("aria-selected")).toBe("true");
    // Arrow keys move between tabs.
    page.$("#tab-ship").dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(page.$("#panel-out").hidden).toBe(false);

    const badge = page.$("[data-to-ship]");
    expect(badge.textContent).toBe("3 orders to ship");
    page.close();
  });

  test("To pack row: order, paid time, items, ship-to name and city, courier; text is escaped", async () => {
    const page = await openDeliveries({ awaiting: [awaitingOrder()], shipments: [] });
    const row = page.$('#packRows tr[data-order="41"]');
    const text = row.textContent.replace(/\s+/g, " ");
    expect(text).toContain("#41");
    expect(text).toMatch(/Paid Oct 14, 2026/);
    expect(text).toContain("2 × Fuser unit");
    expect(text).toContain("Juan <b>Dela Cruz</b>");
    expect(row.querySelector("b")).toBeNull();
    expect(text).toContain("Makati");
    expect(text).toContain("LBC Express");
    // No shipping form here: packing comes first.
    expect(row.querySelector("form")).toBeNull();
    expect(row.querySelector("[data-pack]").textContent.trim()).toBe("Mark as packed");
    page.close();
  });

  test("Mark as packed posts to the packed endpoint, toasts, and the order moves to Ready to ship", async () => {
    const state = { awaiting: [awaitingOrder()], shipments: [] };
    const page = await openDeliveries(state);
    state.awaiting = [packedOrder()];
    page.$('[data-pack="41"]').click();
    await page.settle();
    expect(page.calls).toContainEqual({ url: "/v1/admin/orders/41/packed", method: "POST", body: undefined });
    expect(page.$(".toast-region").textContent).toContain("Order #41 packed — moved to Ready to ship.");
    expect(page.$("#countPack").textContent).toBe("0");
    expect(page.$("#countShip").textContent).toBe("1");
    expect(page.$("#packRows").textContent).toContain("Nothing to pack");
    page.close();
  });

  test("Ready to ship, J&T/LBC: branch note, courier preset, waybill, optional courier fee, Mark as shipped", async () => {
    const state = { awaiting: [packedOrder()], shipments: [] };
    const page = await openDeliveries(state);
    const row = page.$('.ship-row[data-order="41"]');
    const text = row.textContent.replace(/\s+/g, " ");
    expect(text).toContain("LBC Express — book at the branch, then enter the waybill");
    expect(text).toMatch(/Packed Oct 14, 2026/);
    expect(text).toContain("Shipping fee paid: ₱100.00");
    expect(text).toContain("123 Street, Pembo, Makati, 1218");
    expect(text).toContain("Fee paid to courier (optional)");
    expect(text).not.toContain("Actual fee");
    expect(row.querySelector("[data-lalamove]")).toBeNull();

    const form = row.querySelector("form[data-manual='41']");
    expect(form.hidden).toBe(false);
    expect(form.elements.courier.value).toBe("LBC");
    form.elements.courier.value = "JNT";
    form.elements.tracking.value = " JT0009988776 ";
    form.elements.fee.value = "95.5";
    state.awaiting = [];
    state.shipments = [delivery({ order_id: 41 })];
    submit(page, form);
    await page.settle();
    expect(page.calls).toContainEqual({ url: "/v1/admin/shipments/41/manual", method: "POST",
      body: { courier: "JNT", tracking_number: "JT0009988776", fee_actual: 95.5 } });
    expect(page.$("#shipList").textContent).toMatch(/Nothing ready to ship/);
    expect(page.$("#shipmentRows").textContent).toContain("#41");
    expect(page.$(".toast-region").textContent).toMatch(/marked as shipped/);
    page.close();
  });

  test("an invalid tracking number is not sent", async () => {
    const page = await openDeliveries({ awaiting: [packedOrder()], shipments: [] });
    const form = page.$("form[data-manual='41']");
    form.elements.tracking.value = "x";
    submit(page, form);
    await page.settle();
    expect(page.calls.some(c => c.url.endsWith("/manual"))).toBe(false);
    expect(form.elements.tracking.getAttribute("aria-invalid")).toBe("true");
    page.close();
  });

  test("Ready to ship, Lalamove: Book Lalamove rider, or reveal the J&T/LBC form instead", async () => {
    const page = await openDeliveries({ awaiting: [
      packedOrder({ order_id: 1, courier_chosen: "LALAMOVE", courier_chosen_label: "Lalamove", has_map_pin: true, can_book_lalamove: true }),
      packedOrder({ order_id: 2, courier_chosen: "LALAMOVE", courier_chosen_label: "Lalamove", has_map_pin: false }),
      packedOrder({ order_id: 3, courier_chosen: "LALAMOVE", courier_chosen_label: "Lalamove", has_map_pin: true }),
      packedOrder({ order_id: 4, courier_chosen: "JNT", courier_chosen_label: "J&T Express", has_map_pin: true, can_book_lalamove: true })
    ], shipments: [] });
    const row = (id) => page.$(`.ship-row[data-order="${id}"]`);

    // Bookable: the button and the automatic-updates note; the J&T/LBC form starts hidden.
    expect(row(1).textContent).toContain("Status updates arrive from Lalamove automatically");
    const hiddenForm = row(1).querySelector("form[data-manual]");
    expect(hiddenForm.hidden).toBe(true);
    row(1).querySelector("[data-show-manual]").click();
    expect(hiddenForm.hidden).toBe(false);
    expect(hiddenForm.elements.courier.value).toBe("JNT");

    // Can't be booked: the reason, and the J&T/LBC form right away.
    expect(row(2).querySelector("[data-lalamove]")).toBeNull();
    expect(row(2).textContent).toMatch(/no map pin/);
    expect(row(2).querySelector("form[data-manual]").hidden).toBe(false);
    expect(row(3).textContent).toMatch(/Lalamove isn't configured on the server/);

    // A J&T order never gets the Lalamove button, even when Lalamove could be booked.
    expect(row(4).querySelector("[data-lalamove]")).toBeNull();

    row(1).querySelector("[data-lalamove]").click();
    await page.settle();
    expect(page.calls).toContainEqual(expect.objectContaining({ url: "/v1/admin/shipments/1/lalamove", method: "POST" }));
    page.close();
  });

  test("Outgoing: tracking link, status filter, status update with a note; Lalamove rows update themselves", async () => {
    const page = await openDeliveries({ awaiting: [], shipments: [
      delivery(),
      delivery({ delivery_id: 8, order_id: 39, status: "DELIVERED", delivered_at: "2026-10-13T09:00:00Z" }),
      delivery({ delivery_id: 9, order_id: 38, courier: "LALAMOVE", courier_label: "Lalamove", status: "IN_TRANSIT", tracking_number: null })
    ] });
    const rows = page.$$("#shipmentRows tr");
    expect(rows).toHaveLength(3);
    expect(page.$("#countOut").textContent).toBe("3");
    expect(rows[0].querySelector("a").href).toBe("https://www.jtexpress.ph/track?waybill=JT0001234567");
    expect(rows[0].textContent).toContain("Handed to courier");
    expect(rows[1].querySelector("form")).toBeNull();   // delivered rows can't be changed
    expect(rows[2].querySelector("form")).toBeNull();
    expect(rows[2].textContent).toContain("Updates automatically from Lalamove");
    expect([...rows[0].querySelectorAll("select option")].map(o => o.value))
      .toEqual(["IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "FAILED", "RETURNED"]);

    const form = rows[0].querySelector("form");
    form.elements.status.value = "OUT_FOR_DELIVERY";
    form.elements.note.value = "Rider left the hub";
    submit(page, form);
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

  test("the J&T/LBC vs Lalamove note stays on the page", async () => {
    const page = await openDeliveries({ awaiting: [], shipments: [] });
    expect(page.$(".section-note").textContent).toMatch(/J&T and LBC: book the parcel at the branch/);
    page.close();
  });
});

describe("customer My Orders page", () => {
  const order = (overrides) => ({
    total_amount: "600.00", shipping_fee: "100.00", courier: "JNT", paid_at: null, packed_at: null, shipped_at: null,
    delivered_at: null, shipment_courier: null, created_at: "2026-10-12T09:00:00Z",
    items: [{ name: "Fuser unit", quantity: 2 }], ...overrides
  });
  const orders = [
    order({ order_id: 46, status: "pending_payment", courier: "LBC", created_at: "2026-10-14T10:00:00Z", items: [{ name: "Waste ink pad", quantity: 1 }] }),
    order({ order_id: 45, status: "paid", paid_at: "2026-10-14T09:00:00Z" }),
    order({ order_id: 44, status: "packed", paid_at: "2026-10-13T09:00:00Z", packed_at: "2026-10-13T12:00:00Z" }),
    order({ order_id: 43, status: "shipped", courier: "LALAMOVE", shipment_courier: "LALAMOVE", paid_at: "2026-10-12T09:00:00Z",
      packed_at: "2026-10-12T10:00:00Z", shipped_at: "2026-10-12T11:00:00Z" }),
    order({ order_id: 42, status: "shipped", shipment_courier: "JNT", paid_at: "2026-10-11T09:00:00Z",
      packed_at: "2026-10-11T10:00:00Z", shipped_at: "2026-10-11T11:00:00Z" }),
    order({ order_id: 41, status: "delivered", courier: "LBC", shipment_courier: "LBC", paid_at: "2026-10-01T09:00:00Z",
      packed_at: "2026-10-02T10:00:00Z", shipped_at: "2026-10-02T11:00:00Z", delivered_at: "2026-10-04T15:00:00Z" }),
    order({ order_id: 40, status: "expired" })
  ];
  const tracking = {
    42: { order_id: 42, order_status: "shipped", created_at: "2026-10-11T08:00:00Z", paid_at: "2026-10-11T09:00:00Z",
      packed_at: "2026-10-11T10:00:00Z", courier_chosen: "JNT", courier_chosen_label: "J&T Express", shipped: true,
      courier: "JNT", courier_label: "J&T Express", status: "IN_TRANSIT", tracking_number: "JT0001234567",
      tracking_url: "https://www.jtexpress.ph/track?waybill=JT0001234567", delivered_at: null,
      events: [
        { status: "PICKED_UP", note: "Dropped off at J&T Express", source: "admin", created_at: "2026-10-11T11:00:00Z" },
        { status: "IN_TRANSIT", note: null, source: "admin", created_at: "2026-10-12T08:00:00Z" }
      ] },
    43: { order_id: 43, order_status: "shipped", created_at: "2026-10-12T08:00:00Z", paid_at: "2026-10-12T09:00:00Z",
      packed_at: "2026-10-12T10:00:00Z", courier_chosen: "LALAMOVE", courier_chosen_label: "Lalamove", shipped: true,
      courier: "LALAMOVE", courier_label: "Lalamove", status: "IN_TRANSIT", tracking_number: null,
      tracking_url: "https://share.lalamove.com/LLM1", delivered_at: null,
      events: [{ status: "IN_TRANSIT", note: "Lalamove: ON_GOING", source: "courier_webhook", created_at: "2026-10-12T11:00:00Z" }] },
    44: { order_id: 44, order_status: "packed", created_at: "2026-10-13T08:00:00Z", paid_at: "2026-10-13T09:00:00Z",
      packed_at: "2026-10-13T12:00:00Z", courier_chosen: "JNT", courier_chosen_label: "J&T Express", shipped: false,
      courier: null, courier_label: null, status: null, tracking_number: null, tracking_url: null, delivered_at: null, events: [] }
  };
  const api = async ({ url, method }) => {
    if (url === "/orders") return { body: orders };
    const t = /^\/v1\/orders\/(\d+)\/tracking$/.exec(url);
    if (t && tracking[t[1]]) return { body: tracking[t[1]] };
    if (url === "/v1/payments/checkout" && method === "POST") return { body: { checkout_url: "about:blank#paymongo" } };
    return { status: 404, body: { error: "Order not found" } };
  };
  const cardOf = (page, id) => page.$(`.order-card[data-order="${id}"]`);
  const headlineOf = (page, id) => cardOf(page, id).querySelector(".order-card__headline")?.textContent;
  const stepsOf = (page, id) => [...cardOf(page, id).querySelectorAll(".tracker__step")]
    .map(li => (li.classList.contains("is-done") ? "done" : "todo") + (li.getAttribute("aria-current") ? "*" : ""));

  test("a plain headline for every state, and the meta line: placed date · items · courier", async () => {
    const page = await openPage("Pages/COpage/orders.html", { api });
    expect(page.$$(".order-card").map(c => c.dataset.order)).toEqual(["46", "45", "44", "43", "42", "41", "40"]);
    expect(headlineOf(page, 46)).toBe("Pay to confirm your order");
    expect(headlineOf(page, 45)).toBe("Payment received — we're packing your order");
    expect(headlineOf(page, 44)).toBe("Packed — handing it to the courier soon");
    expect(headlineOf(page, 43)).toBe("Your rider is on the way");
    expect(headlineOf(page, 42)).toBe("Your parcel is with J&T Express");
    expect(headlineOf(page, 41)).toBe("Delivered Oct 4");
    expect(headlineOf(page, 40)).toBeUndefined();
    expect(cardOf(page, 40).textContent).toContain("Expired");
    expect(cardOf(page, 46).querySelector(".order-card__meta").textContent)
      .toBe("Placed Oct 14, 2026 · 1 item · LBC Express · unpaid orders cancel after 24 hours");
    expect(cardOf(page, 45).querySelector(".order-card__meta").textContent).toBe("Placed Oct 12, 2026 · 2 items · J&T Express");
    // The courier actually used, once shipped.
    expect(cardOf(page, 41).querySelector(".order-card__meta").textContent).toContain("LBC Express");
    // No tracking requests until a card is opened.
    expect(page.calls.filter(c => c.url.includes("/tracking"))).toEqual([]);
    page.close();
  });

  test("the 4-step tracker: finished steps green with their date, the current step marked; none when unpaid or expired", async () => {
    const page = await openPage("Pages/COpage/orders.html", { api });
    expect(cardOf(page, 46).querySelector(".tracker")).toBeNull();
    expect(cardOf(page, 40).querySelector(".tracker")).toBeNull();
    expect(stepsOf(page, 45)).toEqual(["done*", "todo", "todo", "todo"]);
    expect(stepsOf(page, 44)).toEqual(["done", "done*", "todo", "todo"]);
    expect(stepsOf(page, 42)).toEqual(["done", "done", "done*", "todo"]);
    expect(stepsOf(page, 41)).toEqual(["done", "done", "done", "done*"]);
    const steps = [...cardOf(page, 41).querySelectorAll(".tracker__step")];
    const label = (li) => [...li.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join("");
    expect(steps.map(label)).toEqual(["Paid", "Packed", "Shipped", "Delivered"]);
    expect(steps.map(li => li.querySelector("small")?.textContent)).toEqual(["Oct 1", "Oct 2", "Oct 2", "Oct 4"]);
    expect(cardOf(page, 45).querySelectorAll(".tracker__step small")).toHaveLength(1);   // only Paid has a date yet
    page.close();
  });

  test("one button per card: Pay now when unpaid, Track, or Details when delivered", async () => {
    const page = await openPage("Pages/COpage/orders.html", { api });
    expect(page.$$("[data-pay]").map(b => b.dataset.pay)).toEqual(["46"]);
    expect(cardOf(page, 46).querySelector("[data-toggle]")).toBeNull();
    expect(cardOf(page, 45).querySelector("[data-toggle]").textContent.trim()).toBe("Track");
    expect(cardOf(page, 41).querySelector("[data-toggle]").textContent.trim()).toBe("Details");
    expect(cardOf(page, 42).querySelector(".order-card__total .price").textContent).toBe("₱600.00");

    page.$("[data-pay]").click();
    await page.settle();
    expect(page.calls).toContainEqual({ url: "/v1/payments/checkout", method: "POST", body: { order_id: 46 } });
    page.close();
  });

  test("Track on a J&T order: tracking number + Copy + courier site, updates newest first, items", async () => {
    const page = await openPage("Pages/COpage/orders.html", { api });
    const button = cardOf(page, 42).querySelector("[data-toggle]");
    const panel = cardOf(page, 42).querySelector(".order-card__details");
    expect(panel.hidden).toBe(true);
    button.click();
    await page.until(() => panel.querySelector(".updates"));
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(panel.hidden).toBe(false);
    expect(page.calls.filter(c => c.url.includes("/tracking")).map(c => c.url)).toEqual(["/v1/orders/42/tracking"]);

    const box = panel.querySelector(".courier-box");
    expect(box.textContent).toContain("J&T Express");
    expect(box.querySelector(".courier-box__tn").textContent).toBe("JT0001234567");
    expect(box.querySelector("[data-copy]").dataset.copy).toBe("JT0001234567");
    const link = box.querySelector("a");
    expect(link.textContent).toBe("Track on J&T's site ↗");
    expect(link.href).toBe("https://www.jtexpress.ph/track?waybill=JT0001234567");
    expect(link.target).toBe("_blank");

    const updates = [...panel.querySelectorAll(".updates li")].map(li => li.querySelector("span").firstChild.textContent);
    expect(updates).toEqual(["In transit", "Handed to courier", "Packed", "Paid", "Order placed"]);
    expect(panel.querySelector(".updates li:nth-child(2) .updates__note").textContent).toBe("Dropped off at J&T Express");
    expect(panel.querySelector(".order-card__items").textContent).toContain("2 × Fuser unit");

    // Copy: the browser's clipboard, then "Copied ✓".
    let copied = null;
    Object.defineProperty(page.window.navigator, "clipboard", { value: { writeText: async (t) => { copied = t; } }, configurable: true });
    box.querySelector("[data-copy]").click();
    await page.settle();
    expect(copied).toBe("JT0001234567");
    expect(box.querySelector("[data-copy]").textContent).toBe("Copied ✓");

    // Closing and opening again doesn't load it twice.
    button.click();
    expect(panel.hidden).toBe(true);
    button.click();
    await page.settle();
    expect(page.calls.filter(c => c.url.includes("/tracking"))).toHaveLength(1);
    page.close();
  });

  test("Track on a Lalamove order: Open live tracking, and Lalamove's raw codes are not shown", async () => {
    const page = await openPage("Pages/COpage/orders.html", { api });
    cardOf(page, 43).querySelector("[data-toggle]").click();
    const panel = cardOf(page, 43).querySelector(".order-card__details");
    await page.until(() => panel.querySelector(".updates"));
    const link = panel.querySelector(".courier-box a");
    expect(link.textContent).toBe("Open live tracking ↗");
    expect(link.href).toBe("https://share.lalamove.com/LLM1");
    expect(panel.textContent).not.toContain("ON_GOING");
    expect(panel.querySelector(".updates li").textContent).toContain("In transit");
    page.close();
  });

  test("Track before shipping: the courier chosen and 'tracking number appears once shipped'", async () => {
    const page = await openPage("Pages/COpage/orders.html", { api });
    cardOf(page, 44).querySelector("[data-toggle]").click();
    const panel = cardOf(page, 44).querySelector(".order-card__details");
    await page.until(() => panel.querySelector(".updates"));
    expect(panel.querySelector(".courier-box").textContent.replace(/\s+/g, " ").trim())
      .toBe("J&T Express · tracking number appears once shipped");
    expect(panel.querySelector(".courier-box a")).toBeNull();
    expect([...panel.querySelectorAll(".updates li span")].map(s => s.textContent)).toEqual(["Packed", "Paid", "Order placed"]);
    page.close();
  });

  test("a tracking error shows inside the panel", async () => {
    const page = await openPage("Pages/COpage/orders.html", { api });
    cardOf(page, 45).querySelector("[data-toggle]").click();   // the stub has no tracking for 45
    const panel = cardOf(page, 45).querySelector(".order-card__details");
    await page.until(() => panel.querySelector(".error-text"));
    expect(panel.textContent).toContain("Couldn't load tracking: Order not found");
    page.close();
  });

  test("opened with #order-<id> (the profile page's Track link): that card is expanded", async () => {
    const page = await openPage("Pages/COpage/orders.html", { api, hash: "order-42" });
    const panel = cardOf(page, 42).querySelector(".order-card__details");
    await page.until(() => panel.querySelector(".updates"));
    expect(panel.hidden).toBe(false);
    expect(cardOf(page, 42).querySelector("[data-toggle]").getAttribute("aria-expanded")).toBe("true");
    expect(cardOf(page, 43).querySelector(".order-card__details").hidden).toBe(true);
    page.close();
  });
});

describe("header navigation and account indicator (every page)", () => {
  const api = async ({ url }) => ({ body: url === "/v1/admin/orders/to-ship" ? { count: 0 } : [] });
  const navLabels = (page) => page.$$("#site-header .site-header__inner .site-nav a:not([data-to-ship])").map(a => a.textContent.trim());

  test("visitors see Log in and Sign up, no account menu", async () => {
    const page = await openPage("Pages/Homepage/homepage.html", { role: null, api });
    expect(navLabels(page)).toEqual(["Shop"]);
    const actions = page.$(".header-actions").textContent;
    expect(actions).toContain("Log in");
    expect(actions).toContain("Sign up");
    expect(page.$(".account")).toBeNull();
    page.close();
  });

  test("customers see My orders, the cart and their account with a Customer badge", async () => {
    const page = await openPage("Pages/Homepage/homepage.html", { role: "user", username: "maria.santos", api });
    expect(navLabels(page)).toEqual(["Shop", "My orders"]);
    expect(page.$(".cart-link")).not.toBeNull();
    expect(page.$(".avatar").textContent).toBe("MA");
    expect(page.$(".account__name").textContent).toBe("maria.santos");
    expect(page.$(".account__role").textContent).toBe("Customer");
    expect(page.$$("#account-menu a").map(a => a.textContent.trim())).toEqual(["My profile", "My orders"]);
    expect(page.$(".header-actions").textContent).not.toContain("Log in");
    page.close();
  });

  test("admins see Dashboard, Inventory, Deliveries, Rates, Chat & FAQs and Accounts, no cart, and an Admin badge", async () => {
    const page = await openPage("Pages/Homepage/homepage.html", { role: "admin", username: "owner", api });
    expect(navLabels(page)).toEqual(["Shop", "Dashboard", "Inventory", "Deliveries", "Rates", "Chat & FAQs", "Accounts"]);
    expect(page.$(".cart-link")).toBeNull();
    expect(page.$(".account__role").textContent).toBe("Admin");
    expect(page.$$("#account-menu a").map(a => [a.textContent.trim(), a.getAttribute("href")]))
      .toEqual([["My profile", "../Account/profile.html"], ["Admin dashboard", "../Admin/dashboard.html"]]);
    page.close();
  });

  test("the account menu opens, closes with Escape, and Log out clears the session", async () => {
    const page = await openPage("Pages/COpage/orders.html", { role: "user", api });
    const button = page.$(".account__button");
    button.click();
    expect(page.$("#account-menu").hidden).toBe(false);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    page.doc.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape" }));
    expect(page.$("#account-menu").hidden).toBe(true);
    page.$("[data-logout]").click();
    expect(page.window.sessionStorage.getItem("bongalink_token")).toBeNull();
    // The server is told too, so this device's session ends there as well.
    await page.until(() => page.calls.some((c) => c.url === "/auth/logout"));
    expect(page.calls.find((c) => c.url === "/auth/logout").method).toBe("POST");
    await page.settle();
    page.close();
  });

  test("mobile menu toggles", async () => {
    const page = await openPage("Pages/Homepage/homepage.html", { role: "user", api });
    const toggle = page.$(".menu-toggle");
    expect(page.$("#mobile-panel").hidden).toBe(true);
    toggle.click();
    expect(page.$("#mobile-panel").hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    page.close();
  });
});
