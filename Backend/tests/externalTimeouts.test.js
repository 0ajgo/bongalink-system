// Calls to PayMongo, Lalamove and Nominatim give up after a set time (Node's fetch would
// otherwise wait minutes), so the pages' own timeouts are always the longer ones.
// fetch is mocked: nothing here reaches the real services.
const paymongo = require("../services/paymongo");
const lalamove = require("../services/lalamove");
const geocode = require("../services/geocode");

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });
const timedOut = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

const checkout = () => paymongo.createCheckoutSession({ referenceNumber: "BL-1", description: "x", lineItems: [],
  customer: { name: "A", email: "a@example.com" }, successUrl: "http://s", cancelUrl: "http://c" });

describe("PayMongo", () => {
  test("every request carries a timeout signal; a timeout is a PaymentError with a clear message", async () => {
    global.fetch = jest.fn().mockRejectedValue(timedOut());
    await expect(checkout()).rejects.toThrow(new paymongo.PaymentError("PayMongo didn't answer in time. Please try again."));
    expect(global.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    await expect(checkout()).rejects.toBeInstanceOf(paymongo.PaymentError);
  });

  test("getCheckoutSession: open, paid (payments present) or expired", async () => {
    const session = (attrs) => json({ data: { id: "cs_1", attributes: { checkout_url: "https://pay/cs_1", ...attrs } } });
    global.fetch = jest.fn()
      .mockResolvedValueOnce(session({ status: "active", payments: [] }))
      .mockResolvedValueOnce(session({ status: "active", payments: [{ id: "pay_1" }] }))
      .mockResolvedValueOnce(session({ status: "expired", payments: [] }));
    expect(await paymongo.getCheckoutSession("cs_1")).toEqual({ id: "cs_1", checkoutUrl: "https://pay/cs_1", status: "active" });
    expect((await paymongo.getCheckoutSession("cs_1")).status).toBe("paid");
    expect((await paymongo.getCheckoutSession("cs_1")).status).toBe("expired");
    expect(global.fetch.mock.calls[0][0]).toBe("https://api.paymongo.com/v1/checkout_sessions/cs_1");
    expect(global.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe("Lalamove", () => {
  test("a timeout is a LogisticsError, and the request carried a timeout signal", async () => {
    const saved = { key: process.env.LALAMOVE_API_KEY, secret: process.env.LALAMOVE_API_SECRET };
    process.env.LALAMOVE_API_KEY = "k"; process.env.LALAMOVE_API_SECRET = "s";
    try {
      global.fetch = jest.fn().mockRejectedValue(timedOut());
      await expect(lalamove.getQuotation({ pickup: { lat: 14.5, lng: 121, address: "a" }, dropoff: { lat: 14.6, lng: 121, address: "b" } }))
        .rejects.toThrow(new lalamove.LogisticsError("Lalamove didn't answer in time"));
      expect(global.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    } finally {
      process.env.LALAMOVE_API_KEY = saved.key; process.env.LALAMOVE_API_SECRET = saved.secret;
    }
  });
});

describe("Nominatim (map pin lookup)", () => {
  test("a lookup that hangs gives up (it would otherwise hold up every lookup queued behind it)", async () => {
    geocode.clearCache();
    global.fetch = jest.fn().mockRejectedValue(timedOut());
    await expect(geocode.reverse(14.55, 121.02)).rejects.toThrow("The map lookup service is unreachable right now.");
    expect(global.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});
