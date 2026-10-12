jest.mock("../services/mailer", () => require("./mailerMock")());

const request = require("supertest");
const app = require("../server");
const lalamove = require("../services/lalamove");
const { pool, resetDb, createUser, createProduct } = require("./helpers");

let user, productId;

beforeEach(async () => {
  await resetDb();
  jest.restoreAllMocks();
  user = await createUser();
  productId = await createProduct({ weightKg: 0.5 });
});
afterAll(() => pool.end());

const quote = (address, quantity = 2) =>
  request(app).post("/api/v1/shipping/quote").set("Authorization", user.auth)
    .send({ items: [{ product_id: productId, quantity }], address });

describe("POST /api/v1/shipping/quote", () => {
  test("NCR with a map pin: J&T, LBC and a live Lalamove quote", async () => {
    const getQuotation = jest.spyOn(lalamove, "getQuotation")
      .mockResolvedValue({ quotationId: "q1", total: 165, currency: "PHP", stops: [] });

    const res = await quote({ region: "NCR", line: "123 Street, Makati", lat: 14.548, lng: 121.057 });
    expect(res.status).toBe(200);
    expect(res.body.zone).toBe("NCR");
    expect(res.body.weight_kg).toBe(1);
    expect(res.body.options).toEqual([
      expect.objectContaining({ courier: "JNT", fee: 100, source: "rate_table" }),
      expect.objectContaining({ courier: "LBC", fee: 130, source: "rate_table" }),
      expect.objectContaining({ courier: "LALAMOVE", fee: 165, eta: "Same day", source: "live_quote" })
    ]);
    expect(getQuotation).toHaveBeenCalledWith({
      pickup: { lat: "14.5547", lng: "121.0244", address: "Test shop" },
      dropoff: { lat: 14.548, lng: 121.057, address: "123 Street, Makati" }
    });
  });

  test("NCR without a pin: no Lalamove", async () => {
    const getQuotation = jest.spyOn(lalamove, "getQuotation");
    const res = await quote({ region: "NCR", line: "123 Street, Makati" });
    expect(res.body.options.map(o => o.courier)).toEqual(["JNT", "LBC"]);
    expect(getQuotation).not.toHaveBeenCalled();
  });

  test("NCR when Lalamove is down: falls back to J&T and LBC", async () => {
    jest.spyOn(lalamove, "getQuotation").mockRejectedValue(new lalamove.LogisticsError("timeout"));
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const res = await quote({ region: "NCR", line: "x", lat: 14.5, lng: 121 });
    expect(res.status).toBe(200);
    expect(res.body.options.map(o => o.courier)).toEqual(["JNT", "LBC"]);
  });

  test("Visayas: rate table only, even with a pin", async () => {
    const getQuotation = jest.spyOn(lalamove, "getQuotation");
    const res = await quote({ region: "VII", line: "Cebu City", lat: 10.3, lng: 123.9 });
    expect(res.status).toBe(200);
    expect(res.body.zone).toBe("VISAYAS");
    expect(res.body.options).toEqual([
      expect.objectContaining({ courier: "JNT", fee: 150, eta: "3-7 days" }),
      expect.objectContaining({ courier: "LBC", fee: 190, eta: "3-7 days" })
    ]);
    expect(getQuotation).not.toHaveBeenCalled();
  });

  test("heavier carts move up the weight bracket", async () => {
    const res = await quote({ region: "VII", line: "Cebu City" }, 5); // 2.5 kg -> 3 kg bracket
    expect(res.body.options.map(o => o.fee)).toEqual([230, 280]);
  });

  test.each([
    ["Palawan", "IV-B"], ["tawi tawi", "BARMM"], ["Dinagat", "XIII"], ["Siquijor", "NIR"]
  ])("island province %s -> ISLAND_PROVINCE", async (province, region) => {
    const res = await quote({ region, province, line: "x" });
    expect(res.body.zone).toBe("ISLAND_PROVINCE");
    expect(res.body.options.map(o => o.fee)).toEqual([190, 230]);
  });

  test("unknown region and bad input are 400s with a message", async () => {
    expect((await quote({ region: "ZZ", line: "x" })).body).toEqual({ error: "Unknown region" });
    const bad = await request(app).post("/api/v1/shipping/quote").set("Authorization", user.auth)
      .send({ items: [{ product_id: productId, quantity: 0 }], address: { region: "NCR", line: "x" } });
    expect(bad.status).toBe(400);
  });

  test("requires login", async () => {
    const res = await request(app).post("/api/v1/shipping/quote").send({});
    expect(res.status).toBe(401);
  });
});
