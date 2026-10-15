// Pins decide the zone, fees explain themselves, Lalamove only inside its area,
// the fee shown is the fee charged, and the rate card is admin-only.
jest.mock("../services/mailer", () => require("./mailerMock")());

const request = require("supertest");
const app = require("../server");
const lalamove = require("../services/lalamove");
const geocode = require("../services/geocode");
const { PINS, installNominatim } = require("./nominatimMock");
const { pool, resetDb, createUser, createProduct, fillCart, orderBody, addressRows } = require("./helpers");

let user, admin, productId;
jest.setTimeout(30000);

const quote = (pin, address = {}, quantity = 3) =>
  request(app).post("/api/v1/shipping/quote").set("Authorization", user.auth).send({
    items: [{ product_id: productId, quantity }],
    address: { region: "NCR", line: "123 Street", ...(pin ? { lat: pin.lat, lng: pin.lng } : {}), ...address }
  });

beforeEach(async () => {
  await resetDb();
  geocode.clearCache();
  installNominatim();
  jest.restoreAllMocks();
  user = await createUser();
  admin = await createUser({ role: "admin" });
  productId = await createProduct({ price: 200, weightKg: 0.5, createdBy: admin.id });   // 3 x 0.5 kg = 1.5 kg
});
afterAll(() => pool.end());

describe("POST /api/v1/shipping/quote with a map pin", () => {
  test.each([
    ["makati", "NCR", "J&T Metro Manila rate", 150],
    ["calamba", "LUZON", "J&T Luzon rate", 180],
    ["cebu", "VISAYAS", "J&T Visayas rate", 230],
    ["davao", "MINDANAO", "J&T Mindanao rate", 250],
    ["puertoPrincesa", "ISLAND_PROVINCE", "J&T island province rate", 290]
  ])("%s pin -> %s zone and fee", async (name, zone, basis, jntFee) => {
    const res = await quote(PINS[name]);
    expect(res.status).toBe(200);
    expect(res.body.zone).toBe(zone);
    expect(res.body.weight_kg).toBe(1.5);
    expect(res.body.location.source).toBe("pin");
    const jnt = res.body.options.find(o => o.courier === "JNT");
    expect(jnt.fee).toBe(jntFee);
    expect(jnt.basis).toBe(`${basis}, 1.5 kg (up to 3 kg)`);
  });

  test("the pin wins over a wrong region choice", async () => {
    const res = await quote(PINS.cebu, { region: "NCR" });   // customer picked Metro Manila, pin is in Cebu
    expect(res.body).toMatchObject({ zone: "VISAYAS", location: { region: "VII", province: "Cebu", city: "Cebu City" } });
  });

  test("without a pin, or if the map lookup is down, the typed region is used", async () => {
    expect((await quote(null, { region: "VII" })).body).toMatchObject({ zone: "VISAYAS", location: { source: "typed" } });
    installNominatim({ down: true });
    jest.spyOn(console, "warn").mockImplementation(() => {});
    expect((await quote(PINS.davao, { region: "VII" })).body).toMatchObject({ zone: "VISAYAS", location: { source: "typed" } });
  });

  test("a pin outside the Philippines is a 400", async () => {
    const res = await quote(PINS.kotaKinabalu);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/outside the Philippines/);
  });
});

describe("Lalamove: live quote, only inside its service area", () => {
  beforeEach(() => {
    jest.spyOn(lalamove, "getQuotation").mockResolvedValue({ quotationId: "q", total: 233, stops: [], distanceKm: 8.4 });
  });

  test("Metro Manila pin: offered with distance and price", async () => {
    const res = await quote(PINS.makati);
    expect(res.body.options.find(o => o.courier === "LALAMOVE")).toMatchObject({
      fee: 233, distance_km: 8.4, eta: "Same day", basis: "Live Lalamove quote, 8.4 km"
    });
    expect(lalamove.getQuotation).toHaveBeenCalledWith(expect.objectContaining({
      dropoff: expect.objectContaining({ lat: PINS.makati.lat, lng: PINS.makati.lng })
    }));
  });

  test("Laguna is in the default service area; Cebu, Baguio and Palawan are not", async () => {
    expect((await quote(PINS.calamba)).body.options.map(o => o.courier)).toContain("LALAMOVE");
    for (const name of ["cebu", "baguio", "puertoPrincesa"]) {
      expect((await quote(PINS[name])).body.options.map(o => o.courier)).not.toContain("LALAMOVE");
    }
    expect(lalamove.getQuotation).toHaveBeenCalledTimes(1);
  });

  test("the service area is configurable", async () => {
    process.env.LALAMOVE_SERVICE_AREAS = "NCR,Cebu";
    try {
      expect((await quote(PINS.cebu)).body.options.map(o => o.courier)).toContain("LALAMOVE");
      expect((await quote(PINS.calamba)).body.options.map(o => o.courier)).not.toContain("LALAMOVE");
    } finally {
      delete process.env.LALAMOVE_SERVICE_AREAS;
    }
  });

  test("an out-of-service-area answer from Lalamove just hides it", async () => {
    lalamove.getQuotation.mockRejectedValue(new lalamove.LogisticsError("ERR_OUT_OF_SERVICE_AREA"));
    jest.spyOn(console, "warn").mockImplementation(() => {});
    expect((await quote(PINS.makati)).body.options.map(o => o.courier)).toEqual(["JNT", "LBC"]);
  });

  test("without a route distance, the straight-line distance is shown and labelled", async () => {
    lalamove.getQuotation.mockResolvedValue({ quotationId: "q", total: 180, stops: [], distanceKm: null });
    const option = (await quote(PINS.makati)).body.options.find(o => o.courier === "LALAMOVE");
    expect(option.basis).toMatch(/^Live Lalamove quote, \d+(\.\d)? km \(straight line\)$/);
  });
});

describe("POST /api/orders: the fee shown is the fee charged", () => {
  async function placeOrder(extra) {
    await fillCart(user.id, [{ productId, quantity: 3 }]);
    const body = orderBody({ courier: "JNT", ...extra });
    body.address = { ...body.address, region: "NCR", city: "Cebu City", lat: PINS.cebu.lat, lng: PINS.cebu.lng };
    return request(app).post("/api/orders").set("Authorization", user.auth).send(body);
  }

  test("the quoted fee is charged, and the zone/region come from the pin", async () => {
    const shown = (await quote(PINS.cebu)).body.options.find(o => o.courier === "JNT").fee;
    const res = await placeOrder({ expected_shipping_fee: shown });
    expect(res.status).toBe(201);
    expect(res.body.shippingFee).toBe(shown);
    const [[order]] = await pool.query("SELECT shipping_fee FROM orders");
    expect(order.shipping_fee).toBe("230.00");
    const [address] = await addressRows();   // the pin is stored encrypted
    expect(address).toMatchObject({ region: "VII", province: "Cebu", shipping_zone: "VISAYAS", lat: 10.3157, lng: 123.8854 });
  });

  test("if the fee changed since the quote, the order is refused with the new fee", async () => {
    const res = await placeOrder({ expected_shipping_fee: 150 });   // e.g. a stale NCR quote
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "SHIPPING_FEE_CHANGED", shippingFee: 230 });
    const [orders] = await pool.query("SELECT * FROM orders");
    expect(orders).toHaveLength(0);
  });
});

describe("saved addresses keep their pin", () => {
  test("lat/lng are saved and the pin decides the region and zone", async () => {
    const res = await request(app).post("/api/v1/account/addresses").set("Authorization", user.auth).send({
      recipient_name: "Juan", recipient_phone: "09171234567", street: "1 St", barangay: "San Miguel",
      city: "Puerto Princesa", region: "NCR", postal_code: "5300", lat: PINS.puertoPrincesa.lat, lng: PINS.puertoPrincesa.lng
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ region: "IV-B", province: "Palawan", shipping_zone: "ISLAND_PROVINCE",
                                     lat: 9.7392, lng: 118.7353 });
  });
});

describe("POST /api/v1/geo/reverse", () => {
  test("fills region, province and city for the address form", async () => {
    const res = await request(app).post("/api/v1/geo/reverse").set("Authorization", user.auth).send({ lat: PINS.coron.lat, lng: PINS.coron.lng });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ region: "IV-B", province: "Palawan", city: "Coron", zone: "ISLAND_PROVINCE", postcode: "5316" });
  });

  test("needs login and valid coordinates", async () => {
    expect((await request(app).post("/api/v1/geo/reverse").send({ lat: 14.5, lng: 121 })).status).toBe(401);
    expect((await request(app).post("/api/v1/geo/reverse").set("Authorization", user.auth).send({})).status).toBe(400);
  });
});

describe("admin shipping rate card", () => {
  const rates = (who) => request(app).get("/api/v1/admin/shipping-rates").set("Authorization", who.auth);

  test("admins list, add, edit and delete brackets; last updated is shown per courier", async () => {
    const list = await rates(admin);
    expect(list.status).toBe(200);
    expect(list.body.rates).toHaveLength(30);
    expect(list.body.last_updated).toEqual({ JNT: expect.any(String), LBC: expect.any(String) });

    const added = await request(app).post("/api/v1/admin/shipping-rates").set("Authorization", admin.auth)
      .send({ courier: "JNT", zone: "VISAYAS", max_weight_kg: 2, fee: 199 });
    expect(added.status).toBe(201);
    // The new 2 kg bracket now prices the 1.5 kg parcel.
    const jnt = (await quote(PINS.cebu)).body.options.find(o => o.courier === "JNT");
    expect(jnt).toMatchObject({ fee: 199, basis: "J&T Visayas rate, 1.5 kg (up to 2 kg)" });

    const row = added.body.rates.find(r => r.courier === "JNT" && r.zone === "VISAYAS" && r.max_weight_kg === 2);
    const edited = await request(app).patch(`/api/v1/admin/shipping-rates/${row.rate_id}`).set("Authorization", admin.auth).send({ fee: 205.5 });
    expect(edited.body.rates.find(r => r.rate_id === row.rate_id).fee).toBe(205.5);

    const deleted = await request(app).delete(`/api/v1/admin/shipping-rates/${row.rate_id}`).set("Authorization", admin.auth);
    expect(deleted.body.rates).toHaveLength(30);
  });

  test("validation and duplicates", async () => {
    const post = (body) => request(app).post("/api/v1/admin/shipping-rates").set("Authorization", admin.auth).send(body);
    expect((await post({ courier: "DHL", zone: "NCR", max_weight_kg: 1, fee: 1 })).status).toBe(400);
    expect((await post({ courier: "JNT", zone: "MARS", max_weight_kg: 1, fee: 1 })).status).toBe(400);
    expect((await post({ courier: "JNT", zone: "NCR", max_weight_kg: 0, fee: 1 })).status).toBe(400);
    expect((await post({ courier: "JNT", zone: "NCR", max_weight_kg: 1, fee: -5 })).status).toBe(400);
    const dup = await post({ courier: "JNT", zone: "NCR", max_weight_kg: 1, fee: 99 });
    expect(dup.status).toBe(409);
  });

  test("customers and visitors can't see or change the rate card", async () => {
    expect((await rates(user)).status).toBe(403);
    expect((await request(app).get("/api/v1/admin/shipping-rates")).status).toBe(401);
    expect((await request(app).post("/api/v1/admin/shipping-rates").set("Authorization", user.auth)
      .send({ courier: "JNT", zone: "NCR", max_weight_kg: 9, fee: 1 })).status).toBe(403);
    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM shipping_rates");
    expect(n).toBe(30);
  });
});

describe("product weights", () => {
  test("admins set a part's weight; it changes the fee bracket", async () => {
    const patch = await request(app).patch(`/api/products/${productId}`).set("Authorization", admin.auth).send({ weight_kg: 1.2 });
    expect(patch.status).toBe(200);
    const res = await quote(PINS.cebu);   // 3 x 1.2 kg = 3.6 kg -> 5 kg bracket
    expect(res.body.weight_kg).toBe(3.6);
    expect(res.body.options.find(o => o.courier === "JNT").fee).toBe(310);

    expect((await request(app).patch(`/api/products/${productId}`).set("Authorization", admin.auth).send({ weight_kg: 0 })).status).toBe(400);
    const predictions = await request(app).get("/api/admin/ml/predictions").set("Authorization", admin.auth);
    expect(predictions.body.find(p => p.product_id === productId).weight_kg).toBe("1.200");
  });
});
