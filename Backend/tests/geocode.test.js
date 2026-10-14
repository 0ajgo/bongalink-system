// services/geocode.js against a fake Nominatim (no network).
const geocode = require("../services/geocode");
const { PINS, installNominatim } = require("./nominatimMock");

beforeEach(() => geocode.clearCache());

describe("pin -> PSGC region, province and shipping zone", () => {
  test.each([
    ["makati", { region: "NCR", province: null, city: "Makati", zone: "NCR", postcode: "1226" }],
    ["calamba", { region: "IV-A", province: "Laguna", city: "Calamba", zone: "LUZON" }],
    ["baguio", { region: "CAR", province: "Benguet", city: "Baguio", zone: "LUZON" }],
    ["cebu", { region: "VII", province: "Cebu", city: "Cebu City", zone: "VISAYAS" }],
    ["bacolod", { region: "NIR", province: "Negros Occidental", city: "Bacolod", zone: "VISAYAS" }],
    ["davao", { region: "XI", province: "Davao del Sur", city: "Davao City", zone: "MINDANAO" }],
    ["puertoPrincesa", { region: "IV-B", province: "Palawan", city: "Puerto Princesa", zone: "ISLAND_PROVINCE" }],
    ["coron", { region: "IV-B", province: "Palawan", zone: "ISLAND_PROVINCE" }],
    ["jolo", { region: "BARMM", province: "Sulu", zone: "ISLAND_PROVINCE" }],
    ["siquijor", { region: "NIR", province: "Siquijor", zone: "ISLAND_PROVINCE" }]
  ])("%s", (name, expected) => {
    expect(geocode.mapToPsgc(PINS[name].address)).toMatchObject(expected);
  });

  test("a pin outside the Philippines is rejected with a 400", () => {
    expect(() => geocode.mapToPsgc(PINS.kotaKinabalu.address)).toThrow(/outside the Philippines/);
    try { geocode.mapToPsgc(PINS.kotaKinabalu.address); } catch (e) { expect(e.status).toBe(400); }
  });

  test("a region can be recognised by name when the ISO code is missing", () => {
    expect(geocode.mapToPsgc({ country_code: "ph", region: "Northern Mindanao", city: "Iligan" }))
      .toMatchObject({ region: "X", province: "Lanao del Norte", zone: "MINDANAO" });
  });
});

describe("Nominatim client", () => {
  test("identifies the shop in the User-Agent and asks for English", async () => {
    process.env.ADMIN_ALERT_EMAIL = "shop@example.com";
    const requests = installNominatim();
    await geocode.reverse(PINS.makati.lat, PINS.makati.lng);
    expect(requests).toHaveLength(1);
    expect(requests[0].headers["User-Agent"]).toBe("Bongalink-Shop/1.0 (online ordering system; shop@example.com)");
    expect(requests[0].headers["Accept-Language"]).toBe("en");
    expect(requests[0].url).toMatch(/^https:\/\/nominatim\.openstreetmap\.org\/reverse\?format=jsonv2&addressdetails=1/);
  });

  test("caches results: the same pin (to ~11 m) is looked up once", async () => {
    const requests = installNominatim();
    const a = await geocode.reverse(PINS.cebu.lat, PINS.cebu.lng);
    const b = await geocode.reverse(PINS.cebu.lat + 0.00001, PINS.cebu.lng - 0.00001);
    expect(b).toEqual(a);
    expect(requests).toHaveLength(1);
  });

  test("concurrent lookups of one pin share one request", async () => {
    const requests = installNominatim();
    await Promise.all([1, 2, 3].map(() => geocode.reverse(PINS.davao.lat, PINS.davao.lng)));
    expect(requests).toHaveLength(1);
  });

  test("never more than 1 request per second", async () => {
    const requests = installNominatim();
    await Promise.all([PINS.makati, PINS.cebu, PINS.davao].map(p => geocode.reverse(p.lat, p.lng)));
    expect(requests).toHaveLength(3);
    for (let i = 1; i < requests.length; i++) {
      expect(requests[i].at - requests[i - 1].at).toBeGreaterThanOrEqual(geocode.MIN_INTERVAL_MS - 5);
    }
  }, 10000);

  test("service down -> 503 GeocodeError; coordinates outside the country -> 400 without a request", async () => {
    const requests = installNominatim({ down: true });
    await expect(geocode.reverse(PINS.makati.lat, PINS.makati.lng)).rejects.toMatchObject({ status: 503 });
    await expect(geocode.reverse(35.68, 139.69)).rejects.toMatchObject({ status: 400 });
    expect(requests).toHaveLength(1);
  });
});
