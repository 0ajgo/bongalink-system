// TRUST_PROXY: behind a proxy, rate limits count each visitor, not the proxy; without one,
// a visitor can't choose their own IP with X-Forwarded-For.
const express = require("express");
const request = require("supertest");
const { trustProxySetting } = require("../lib/trustProxy");

const ipApp = (setting) => {
  const app = express();
  app.set("trust proxy", trustProxySetting(setting));
  app.get("/ip", (req, res) => res.json({ ip: req.ip }));
  return app;
};
const ipSeen = async (setting, forwarded) =>
  (await request(ipApp(setting)).get("/ip").set("X-Forwarded-For", forwarded)).body.ip;

describe("trustProxySetting", () => {
  test("blank, 0 and false mean no proxy", () => {
    for (const v of [undefined, "", " ", "0", "false", "FALSE"]) expect(trustProxySetting(v)).toBe(false);
  });
  test("a number is the count of proxies in front", () => {
    expect(trustProxySetting("1")).toBe(1);
    expect(trustProxySetting(" 2 ")).toBe(2);
  });
  test("addresses and subnets are passed on as a list", () => {
    expect(trustProxySetting("loopback, 10.0.0.0/8")).toEqual(["loopback", "10.0.0.0/8"]);
  });
  test("true is refused, because it lets anyone fake their IP", () => {
    expect(() => trustProxySetting("true")).toThrow(/fake their IP/);
  });
});

describe("req.ip", () => {
  test("without a proxy setting, X-Forwarded-For is ignored", async () => {
    expect(await ipSeen("", "203.0.113.7")).not.toBe("203.0.113.7");
  });
  test("with one proxy, the visitor's address is the one the proxy added", async () => {
    expect(await ipSeen("1", "198.51.100.1, 203.0.113.7")).toBe("203.0.113.7");
  });
});

test("the API applies TRUST_PROXY from .env", () => {
  process.env.TRUST_PROXY = "1";
  jest.isolateModules(() => {
    const app = require("../server");
    expect(app.get("trust proxy")).toBe(1);
    require("../db").end();
  });
});
