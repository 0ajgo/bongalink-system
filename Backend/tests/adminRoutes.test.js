// Every admin route checks the login on the server. The admin pages' JavaScript can be downloaded by
// anyone, like any website's; what protects the data is that the API refuses admin requests without an
// admin login. This walks Express's own route table, so a new unguarded admin route fails here.
const request = require("supertest");
const app = require("../server");
const { pool, createUser, resetDb } = require("./helpers");

afterAll(() => pool.end());

// Mount path of a router layer, e.g. /^\/api\/v1\/admin\/accounts\/?(?=\/|$)/i -> "/api/v1/admin/accounts".
const mountOf = (layer) => layer.regexp.source
  .replace(/^\^/, "").replace(/\\\/\?\(\?=\\\/\|\$\)$/, "").replace(/\\\//g, "/");

function routes() {
  const out = [];
  for (const layer of app._router.stack) {
    if (layer.name !== "router" || !layer.handle.stack) continue;
    const base = mountOf(layer);
    for (const inner of layer.handle.stack) {
      if (!inner.route) continue;
      const p = (base + inner.route.path)
        .replace(/:(\w+)\([^)]*\)/g, "1")   // :id(\d+) -> 1
        .replace(/:\w+/g, "1");
      for (const method of Object.keys(inner.route.methods)) out.push({ method, path: p });
    }
  }
  return out;
}

const admin = routes().filter((r) => /\/admin(\/|$)/.test(r.path));

test("the route table was read (there are admin routes to check)", () => {
  expect(admin.length).toBeGreaterThan(40);
  expect(admin).toContainEqual({ method: "post", path: "/api/v1/admin/orders/1/packed" });
});

describe("every admin route refuses a visitor and a customer", () => {
  let customer;
  beforeAll(async () => {
    await resetDb();
    customer = await createUser();
  });

  test.each(admin.map((r) => [r.method.toUpperCase(), r.path]))("%s %s", async (method, p) => {
    const anonymous = await request(app)[method.toLowerCase()](p).send({});
    expect(anonymous.status).toBe(401);
    // The live notification stream takes a single-use ticket instead of the login header.
    if (p.endsWith("/notifications/stream")) return;
    const asCustomer = await request(app)[method.toLowerCase()](p).set("Authorization", customer.auth).send({});
    expect(asCustomer.status).toBe(403);
  });
});
