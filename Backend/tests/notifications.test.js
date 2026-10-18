// The admin notification bell (REQ020, REQ021): each event writes the right notification
// where it happens, read state is per admin, and the live stream only opens with a fresh
// single-use ticket for a working admin login.
jest.mock("../services/mailer", () => require("./mailerMock")());
const mockGenerate = jest.fn();
jest.mock("@google/genai", () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({ models: { generateContent: (req) => mockGenerate(req) } })),
}));

const http = require("http");
const request = require("supertest");
const app = require("../server");
const paymongo = require("../services/paymongo");
const lalamove = require("../services/lalamove");
const notifications = require("../services/notifications");
const { stream } = require("../routes/notifications");
const { startSession, endSession } = require("../middleware/auth");
const { expireStaleOrders } = require("../jobs/expireOrders");
const { pool, resetDb, createUser, createProduct, fillCart, orderBody, paymongoEvent } = require("./helpers");

let customer, admin;

const notes = async (type) => {
  const [rows] = await pool.query(
    "SELECT * FROM admin_notifications WHERE (? IS NULL OR type = ?) ORDER BY notification_id", [type ?? null, type ?? null]);
  return rows;
};

// Personal details from orderBody()/insertAddress(): none may appear in a notification.
const PERSONAL = /buyer@example\.com|@example\.com|09171234567|Juan|Dela Cruz|123 Street|Pembo|Makati|Cebu City/;
const expectNoPersonalData = (rows) => rows.forEach((n) => expect(`${n.title} ${n.body}`).not.toMatch(PERSONAL));

// Places an order (2 x P300 + 1 x P50, LBC) and opens a mocked PayMongo checkout.
async function placeOrder({ sessionId = "cs_test_1", items, body = orderBody({ courier: "LBC" }) } = {}) {
  if (!items) {
    const a = await createProduct({ price: 300, stock: 10, createdBy: admin.id });
    const b = await createProduct({ price: 50, stock: 10, createdBy: admin.id });
    items = [{ productId: a, quantity: 2 }, { productId: b, quantity: 1 }];
  }
  await fillCart(customer.id, items);
  const res = await request(app).post("/api/orders").set("Authorization", customer.auth).send(body);
  expect(res.status).toBe(201);
  paymongo.createCheckoutSession.mockResolvedValueOnce({ id: sessionId, checkoutUrl: "https://x" });
  await request(app).post("/api/v1/payments/checkout").set("Authorization", customer.auth).send({ order_id: res.body.orderId });
  return { orderId: res.body.orderId, amountCentavos: Math.round(res.body.totalAmount * 100), total: res.body.totalAmount };
}

const pay = ({ eventId = "evt_1", sessionId = "cs_test_1", amount }) => {
  const { body, signature } = paymongoEvent({ eventId, sessionId, amount });
  return request(app).post("/api/v1/webhooks/paymongo")
    .set("Content-Type", "application/json").set("Paymongo-Signature", signature).send(body);
};

const api = (method, url, user = admin) => request(app)[method](`/api/v1/admin/notifications${url}`).set("Authorization", user.auth);

beforeEach(async () => {
  await resetDb();
  jest.restoreAllMocks();
  mockGenerate.mockReset();
  jest.spyOn(paymongo, "createCheckoutSession");
  customer = await createUser();
  admin = await createUser({ role: "admin" });
});
afterAll(() => pool.end());

describe("events", () => {
  test("sale: the PayMongo webhook records order number, total and item count, once", async () => {
    const { orderId, amountCentavos } = await placeOrder();
    expect((await pay({ amount: amountCentavos })).status).toBe(200);
    expect((await pay({ amount: amountCentavos })).status).toBe(200);              // PayMongo retry: same event
    expect((await pay({ eventId: "evt_2", amount: amountCentavos })).status).toBe(200);   // a second event for the same session

    const sales = await notes("sale");
    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({ title: `New sale: order #${orderId}`, link: "Admin/deliveries.html", order_id: orderId });
    const total = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(amountCentavos / 100);
    expect(sales[0].body).toBe(`${total} · 3 items`);
    expectNoPersonalData(await notes());
  });

  test("payment needs review: a different amount, or paid after the order expired; no sale", async () => {
    const { orderId, amountCentavos } = await placeOrder();
    await pay({ amount: amountCentavos - 100 });
    let review = await notes("payment_review");
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ title: `Payment needs review: order #${orderId}`, order_id: orderId });
    expect(review[0].body).toMatch(/^Paid ₱.*, expected ₱.*\. Check it in PayMongo before shipping\.$/);

    const late = await placeOrder({ sessionId: "cs_test_2" });
    await pool.query("UPDATE orders SET status = 'expired' WHERE order_id = ?", [late.orderId]);
    await pay({ eventId: "evt_2", sessionId: "cs_test_2", amount: late.amountCentavos });
    review = await notes("payment_review");
    expect(review.map((n) => n.order_id)).toEqual([orderId, late.orderId]);
    expect(review[1].body).toBe("Paid after the order expired or was cancelled. Refund it or restore the order by hand.");
    expect(await notes("sale")).toEqual([]);
  });

  test("expired unpaid orders: one notification per run with the count", async () => {
    await placeOrder({ sessionId: "cs_a" });
    await placeOrder({ sessionId: "cs_b" });
    await pool.query("UPDATE orders SET created_at = NOW() - INTERVAL 25 HOUR");
    expect(await expireStaleOrders()).toBe(2);
    expect(await expireStaleOrders()).toBe(0);
    const expired = await notes("orders_expired");
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ title: "2 unpaid orders expired", body: "Not paid within 24 hours. The units they held are back on sale." });
  });

  test("shipments: booked, then DELIVERED or FAILED only; in-between statuses and repeats are skipped", async () => {
    const { orderId } = await placeOrder();
    await pool.query("UPDATE orders SET status = 'paid' WHERE order_id = ?", [orderId]);
    const booked = await request(app).post(`/api/v1/admin/shipments/${orderId}/manual`).set("Authorization", admin.auth)
      .send({ courier: "JNT", tracking_number: "JT0001234567" });
    expect(booked.status).toBe(201);
    const id = booked.body.delivery_id;
    const status = (s) => request(app).patch(`/api/v1/admin/shipments/${id}/status`).set("Authorization", admin.auth).send({ status: s });

    expect((await status("IN_TRANSIT")).status).toBe(200);
    expect((await status("OUT_FOR_DELIVERY")).status).toBe(200);
    expect((await status("FAILED")).status).toBe(200);
    expect((await status("FAILED")).status).toBe(200);     // same status again: no second alert
    expect((await status("DELIVERED")).status).toBe(200);

    const rows = (await notes()).filter((n) => n.type.startsWith("shipment_"));
    expect(rows.map((n) => [n.type, n.title, n.body, n.shipment_id])).toEqual([
      ["shipment_booked", `Shipment booked: order #${orderId}`, "J&T Express · waybill JT0001234567", id],
      ["shipment_failed", `Delivery failed: order #${orderId}`, "J&T Express · waybill JT0001234567. Contact the courier and the customer.", id],
      ["shipment_delivered", `Delivered: order #${orderId}`, "J&T Express · waybill JT0001234567", id]
    ]);
    expectNoPersonalData(rows);
  });

  test("shipments: Lalamove booking and its webhook", async () => {
    const body = orderBody({ courier: "LALAMOVE" });
    body.address = { ...body.address, lat: 14.548, lng: 121.057 };
    jest.spyOn(lalamove, "getQuotation").mockResolvedValue({ quotationId: "q1", total: 180, currency: "PHP", stops: [{ stopId: "s1" }, { stopId: "s2" }] });
    const { orderId } = await placeOrder({ body });
    await pool.query("UPDATE orders SET status = 'paid' WHERE order_id = ?", [orderId]);
    jest.spyOn(lalamove, "placeOrder").mockResolvedValue({ orderId: "LLM1", shareLink: "https://share.lalamove.com/LLM1", status: "ASSIGNING_DRIVER" });
    expect((await request(app).post(`/api/v1/admin/shipments/${orderId}/lalamove`).set("Authorization", admin.auth)).status).toBe(201);

    jest.spyOn(lalamove, "getOrder").mockResolvedValue({ status: "ON_GOING" });
    await request(app).post("/api/v1/webhooks/lalamove").send({ apiKey: process.env.LALAMOVE_API_KEY, data: { order: { orderId: "LLM1" } } });
    lalamove.getOrder.mockResolvedValue({ status: "COMPLETED" });
    await request(app).post("/api/v1/webhooks/lalamove").send({ apiKey: process.env.LALAMOVE_API_KEY, data: { order: { orderId: "LLM1" } } });
    await request(app).post("/api/v1/webhooks/lalamove").send({ apiKey: process.env.LALAMOVE_API_KEY, data: { order: { orderId: "LLM1" } } });

    const rows = (await notes()).filter((n) => n.type.startsWith("shipment_"));
    expect(rows.map((n) => [n.type, n.body])).toEqual([
      ["shipment_booked", "Lalamove (same-day) · rider requested"],
      ["shipment_delivered", "Lalamove (same-day)"]
    ]);
  });

  test("stock adjustments: only crossing into low stock or out of stock, never again while already low", async () => {
    const id = await createProduct({ price: 100, stock: 5, createdBy: admin.id });
    await pool.query("UPDATE products SET name = 'Epson L3210 printhead' WHERE product_id = ?", [id]);
    const adjust = (change, reason = "correction") =>
      request(app).post(`/api/products/${id}/stock`).set("Authorization", admin.auth).send({ change, reason });

    for (const change of [-1, -1, -1, -2]) expect((await adjust(change)).status).toBe(200);   // 5 -> 4 -> 3 -> 2 -> 0
    expect((await notes()).map((n) => [n.type, n.title, n.body])).toEqual([
      ["low_stock", "Low stock: Epson L3210 printhead", "3 available to sell (low stock is 3 or fewer)."],
      ["out_of_stock", "Out of stock: Epson L3210 printhead", "0 available to sell. Restock it in Inventory."]
    ]);
    expect((await notes())[0]).toMatchObject({ link: `Admin/inventory.html?edit=${id}`, product_id: id });

    await adjust(10, "restock");    // 0 -> 10: nothing
    await adjust(-9, "damaged");    // 10 -> 1: low again (a new crossing)
    await adjust(-1, "damaged");    // 1 -> 0: out again
    expect((await notes()).map((n) => n.type)).toEqual(["low_stock", "out_of_stock", "low_stock", "out_of_stock"]);
  });

  test("stock: an order that holds the last units crosses the threshold too; hidden products are skipped", async () => {
    const shown = await createProduct({ price: 100, stock: 4, createdBy: admin.id });
    const big = await createProduct({ price: 100, stock: 20, createdBy: admin.id });
    await placeOrder({ items: [{ productId: shown, quantity: 1 }, { productId: big, quantity: 1 }] });   // 4 -> 3 available
    expect((await notes()).map((n) => [n.type, n.product_id])).toEqual([["low_stock", shown]]);

    const hidden = await createProduct({ price: 100, stock: 1, createdBy: admin.id });
    await pool.query("UPDATE products SET is_active = 0 WHERE product_id = ?", [hidden]);
    await request(app).post(`/api/products/${hidden}/stock`).set("Authorization", admin.auth).send({ change: -1, reason: "damaged" });
    expect(await notes("out_of_stock")).toEqual([]);
  });

  test("a new customer account, without their email", async () => {
    const res = await request(app).post("/api/auth/register")
      .send({ username: "newbuyer", email: "newbuyer@example.com", password: "secret123", privacy_consent: true });
    expect(res.status).toBe(201);
    const [n] = await notes("new_customer");
    const [[user]] = await pool.query("SELECT user_id FROM users WHERE username = 'newbuyer'");
    expect(n).toMatchObject({ title: "New customer: newbuyer", body: "Signed up for an account.", link: "Admin/accounts.html", user_id: user.user_id });
    expect(`${n.title} ${n.body}`).not.toMatch(/newbuyer@/);
  });

  test("chat questions the assistant couldn't answer (not off-topic ones), without the customer's message", async () => {
    let n = 0;
    const send = (message) => request(app).post("/api/v1/chat/messages").send({ session_id: `notif-test-${Date.now()}-${++n}`, message });
    const toolCall = (name, args) => ({
      functionCalls: [{ id: `call-${name}`, name, args }],
      candidates: [{ content: { role: "model", parts: [{ functionCall: { id: `call-${name}`, name, args } }] } }], text: undefined });
    const say = (text) => ({ functionCalls: undefined, text, candidates: [{ content: { role: "model", parts: [{ text }] } }] });

    mockGenerate.mockResolvedValueOnce(toolCall("mark_unanswered", { reason: "no_information" })).mockResolvedValueOnce(say("Sorry, I don't know."));
    await send("Do you have a part for my Juan Dela Cruz printer? Call 09171234567");
    mockGenerate.mockResolvedValueOnce(toolCall("mark_unanswered", { reason: "off_topic" })).mockResolvedValueOnce(say("I can only help with the shop."));
    await send("What's the weather?");
    mockGenerate.mockRejectedValue(Object.assign(new Error("down"), { status: 503 }));
    await send("Is the fuser in stock?");

    const rows = await notes("chat_unanswered");
    expect(rows.map((n) => n.body)).toEqual([
      "The assistant had no answer. Add an FAQ for it.",
      "The assistant was down, so the customer got the fallback reply."
    ]);
    expect(rows[0]).toMatchObject({ title: "Chat question the assistant couldn't answer", link: "Admin/chat.html#unanswered" });
    expect(rows[0].chat_id).toEqual(expect.any(Number));
    expectNoPersonalData(rows);
  });

  test("a notification that can't be written never breaks the flow", async () => {
    const { orderId, amountCentavos } = await placeOrder();
    await pool.query("RENAME TABLE admin_notifications TO admin_notifications_off");
    try {
      expect((await pay({ amount: amountCentavos })).status).toBe(200);
    } finally {
      await pool.query("RENAME TABLE admin_notifications_off TO admin_notifications");
    }
    const [[o]] = await pool.query("SELECT status FROM orders WHERE order_id = ?", [orderId]);
    expect(o.status).toBe("paid");
    expect(await notes()).toEqual([]);
  });
});

describe("reading: per-admin read state", () => {
  const add = (title) => notifications.notify(pool, { type: "sale", title, body: "₱1.00 · 1 item", link: "Admin/deliveries.html" });

  test("each admin has their own unread count; mark one, mark all", async () => {
    const other = await createUser({ role: "admin" });
    const first = await add("one");
    await add("two");
    await add("three");

    expect((await api("get", "/unread-count")).body).toEqual({ unread: 3 });
    const read = await api("post", `/${first}/read`);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ unread: 2 });
    expect((await api("post", `/${first}/read`)).body).toEqual({ unread: 2 });   // again: no change
    expect((await api("get", "/unread-count", other)).body).toEqual({ unread: 3 });

    const list = await api("get", "");
    expect(list.body.items.map((n) => [n.title, n.read])).toEqual([["three", false], ["two", false], ["one", true]]);
    expect(list.body.items[0]).toMatchObject({ type: "sale", body: "₱1.00 · 1 item", link: "Admin/deliveries.html", created_at: expect.any(String) });
    expect(list.body.unread).toBe(2);

    expect((await api("post", "/read-all")).body).toEqual({ unread: 0 });
    expect((await api("get", "")).body.items.every((n) => n.read)).toBe(true);
    expect((await api("get", "/unread-count", other)).body).toEqual({ unread: 3 });

    await add("four");   // after "mark all": unread again
    expect((await api("get", "/unread-count")).body).toEqual({ unread: 1 });
    expect((await api("get", "")).body.items.map((n) => n.read)).toEqual([false, true, true, true]);
    expect((await api("post", "/999999/read")).status).toBe(404);
  });

  test("newest first, paginated", async () => {
    for (let i = 1; i <= 25; i++) await add(`n${i}`);
    const p1 = await api("get", "?per_page=10");
    expect(p1.body).toMatchObject({ page: 1, per_page: 10, has_more: true, unread: 25 });
    expect(p1.body.items.map((n) => n.title)).toEqual(["n25", "n24", "n23", "n22", "n21", "n20", "n19", "n18", "n17", "n16"]);
    const p3 = await api("get", "?per_page=10&page=3");
    expect(p3.body.items.map((n) => n.title)).toEqual(["n5", "n4", "n3", "n2", "n1"]);
    expect(p3.body.has_more).toBe(false);
  });

  test("admins only", async () => {
    for (const [method, url] of [["get", ""], ["get", "/unread-count"], ["post", "/1/read"], ["post", "/read-all"], ["post", "/stream-ticket"]]) {
      expect((await api(method, url, customer)).status).toBe(403);
      expect((await request(app)[method](`/api/v1/admin/notifications${url}`)).status).toBe(401);
    }
  });
});

describe("live stream", () => {
  let server, port;
  const open = [];
  beforeAll((done) => {
    server = app.listen(0, "127.0.0.1", () => { port = server.address().port; done(); });
  });
  afterEach(() => { open.splice(0).forEach((s) => s.close()); stream.heartbeatMs = 25000; });
  afterAll((done) => { server.close(done); });

  // Opens the stream like EventSource would and collects its events.
  function openStream(ticket) {
    const query = ticket === undefined ? "" : `?ticket=${encodeURIComponent(ticket)}`;
    return new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/api/v1/admin/notifications/stream${query}`, { headers: { Accept: "text/event-stream" } }, (res) => {
        const s = { status: res.statusCode, headers: res.headers, events: [], text: "", ended: false, close: () => req.destroy() };
        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          s.text += chunk;
          buffer += chunk;
          let i;
          while ((i = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            const ev = {};
            for (const line of block.split("\n")) {
              if (line.startsWith("event: ")) ev.event = line.slice(7);
              if (line.startsWith("data: ")) ev.data = JSON.parse(line.slice(6));
            }
            if (ev.event) s.events.push(ev);
          }
        });
        res.on("end", () => { s.ended = true; });
        s.until = async (fn, ms = 5000) => {
          for (const t0 = Date.now(); !fn(s) && Date.now() - t0 < ms;) await new Promise((r) => setTimeout(r, 20));
          return fn(s);
        };
        open.push(s);
        resolve(s);
      });
      req.on("error", reject);
    });
  }
  const ticketFor = async (user = admin) => {
    const res = await api("post", "/stream-ticket", user);
    expect(res.status).toBe(200);
    expect(res.body.expires_in).toBe(60);
    return res.body.ticket;
  };

  test("pushes new notifications as they're created, including ones written inside a transaction", async () => {
    await notifications.notify(pool, { type: "sale", title: "before", link: "Admin/deliveries.html" });
    const s = await openStream(await ticketFor());
    expect(s.status).toBe(200);
    expect(s.headers["content-type"]).toMatch(/^text\/event-stream/);
    expect(s.headers["cache-control"]).toMatch(/no-cache/);
    expect(s.headers["x-accel-buffering"]).toBe("no");
    expect(await s.until((x) => x.events.length >= 1)).toBe(true);
    expect(s.events[0]).toEqual({ event: "ready", data: { unread: 1 } });

    const id = await notifications.notify(pool, { type: "sale", title: "New sale: order #7", body: "₱650.00 · 3 items", link: "Admin/deliveries.html" });
    expect(await s.until((x) => x.events.length >= 2, 2000)).toBe(true);
    expect(s.events[1]).toEqual({ event: "notification", data: expect.objectContaining({ id, type: "sale", title: "New sale: order #7", read: false }) });

    // Registration writes its notification inside its transaction: it arrives after the commit.
    await request(app).post("/api/auth/register").send({ username: "livebuyer", email: "live@example.com", password: "secret123", privacy_consent: true });
    expect(await s.until((x) => x.events.length >= 3, 3000)).toBe(true);
    expect(s.events[2].data).toMatchObject({ type: "new_customer", title: "New customer: livebuyer" });
  });

  test("refuses a missing, unknown, expired or reused ticket", async () => {
    expect((await openStream()).status).toBe(401);
    expect((await openStream("not-a-real-ticket")).status).toBe(401);

    const expired = await ticketFor();
    await pool.query("UPDATE admin_stream_tickets SET expires_at = NOW() - INTERVAL 1 SECOND");
    const e = await openStream(expired);
    expect(e.status).toBe(401);
    await e.until((x) => x.ended);
    expect(JSON.parse(e.text)).toMatchObject({ code: "STREAM_TICKET_INVALID" });

    const ticket = await ticketFor();
    expect((await openStream(ticket)).status).toBe(200);
    expect((await openStream(ticket)).status).toBe(401);

    // Only the ticket's hash is stored.
    const [rows] = await pool.query("SELECT ticket_hash FROM admin_stream_tickets");
    expect(rows.map((r) => r.ticket_hash)).not.toContain(ticket);
  });

  test("refuses a suspended admin, and a ticket whose admin was demoted", async () => {
    const ticket = await ticketFor();
    await pool.query("UPDATE users SET status = 'suspended' WHERE user_id = ?", [admin.id]);
    const s = await openStream(ticket);
    expect(s.status).toBe(403);
    await s.until((x) => x.ended);
    expect(JSON.parse(s.text)).toMatchObject({ code: "ACCOUNT_SUSPENDED" });

    const other = await createUser({ role: "admin" });
    const t2 = await ticketFor(other);
    await pool.query("UPDATE users SET role = 'user' WHERE user_id = ?", [other.id]);
    expect((await openStream(t2)).status).toBe(403);
  });

  test("ends the stream when the admin is suspended or logs out (checked with every heartbeat)", async () => {
    stream.heartbeatMs = 100;
    const s = await openStream(await ticketFor());
    expect(await s.until((x) => x.events.length >= 1)).toBe(true);
    expect(await s.until((x) => x.text.includes(": ping"), 2000)).toBe(true);
    await pool.query("UPDATE users SET status = 'suspended', token_version = token_version + 1 WHERE user_id = ?", [admin.id]);
    expect(await s.until((x) => x.ended, 2000)).toBe(true);
    expect(s.events.at(-1)).toEqual({ event: "end", data: { code: "ACCOUNT_SUSPENDED" } });

    // A "Remember me"-style login (011 session): logging out ends its stream.
    const other = await createUser({ role: "admin" });
    const { token } = await startSession({ user_id: other.id, username: other.username, role: "admin", token_version: 0 });
    const res = await request(app).post("/api/v1/admin/notifications/stream-ticket").set("Authorization", `Bearer ${token}`);
    const s2 = await openStream(res.body.ticket);
    expect(await s2.until((x) => x.events.length >= 1)).toBe(true);
    await endSession(token);
    expect(await s2.until((x) => x.ended, 2000)).toBe(true);
    expect(s2.events.at(-1)).toEqual({ event: "end", data: { code: "SESSION_ENDED" } });
  });
});
