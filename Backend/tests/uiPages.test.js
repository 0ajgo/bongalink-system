// The redesigned pages, run in jsdom against a stubbed API (see pageHarness.js).
const { openPage } = require("./pageHarness");

const product = (id, stock, extra = {}) => ({
  id, name: `Part ${id}`, category: "Printer Parts", brand: "Epson", price: "250.00", stock,
  image: null, description: "", created_at: `2026-10-0${id}T00:00:00Z`, ...extra
});

describe("homepage catalog", () => {
  const products = [product(1, 10), product(2, 2), product(3, 0), product(4, 5, { name: "Laptop battery", category: "Laptop Parts" })];
  const api = (overrides = {}) => async ({ url }) => {
    if (url in overrides) return overrides[url];
    if (url === "/products") return { body: products };
    if (url === "/categories") return { body: [{ name: "Printer Parts" }, { name: "Laptop Parts" }, { name: "Computer Parts" }] };
    if (url === "/v1/admin/orders/to-ship") return { body: { count: 0 } };
    return { body: [] };
  };
  const card = (page, id) => page.$(`#grid [data-add="${id}"], #grid [data-delete="${id}"]`)?.closest(".product-card");

  test("cards show a stock badge from available stock and disable Add to cart when out", async () => {
    const page = await openPage("Pages/Homepage/homepage.html", { role: "user", api: api() });
    const badge = (id) => card(page, id).querySelector(".badge").textContent;
    expect(badge(1)).toBe("In stock");
    expect(badge(2)).toBe("Low stock");
    expect(badge(3)).toBe("Out of stock");
    expect(card(page, 3).querySelector("[data-add]").disabled).toBe(true);
    expect(card(page, 3).querySelector("[data-add]").textContent.trim()).toBe("Out of stock");
    expect(card(page, 1).querySelector("[data-add]").disabled).toBe(false);
    expect(card(page, 1).querySelector(".product-card__name").textContent).toBe("Part 1");
    expect(card(page, 1).querySelector(".price").textContent).toBe("₱250.00");
    // In stock first, then newest; no emoji placeholder, an icon with alt text instead
    expect(page.$$("#grid [data-add]").map(b => b.dataset.add)).toEqual(["4", "2", "1", "3"]);
    expect(page.$("#grid").textContent).not.toMatch(/📦/);
    expect(page.$("#grid .product-card__placeholder .sr-only").textContent).toBe("No photo yet");
    page.close();
  });

  test("category shortcuts, in-stock row, search and the empty state", async () => {
    const page = await openPage("Pages/Homepage/homepage.html", { role: null, api: api() });
    expect(page.$$("#categoryTiles .category-tile strong").map(t => t.textContent)).toEqual(["Printer Parts", "Laptop Parts"]);
    expect(page.$("#inStockSection").hidden).toBe(false);
    expect(page.$$("#inStockGrid .product-card")).toHaveLength(3);

    page.$("#heroQ").value = "battery";
    page.$("#heroSearch").dispatchEvent(new page.window.Event("submit", { cancelable: true }));
    expect(page.$$("#grid .product-card")).toHaveLength(1);
    expect(page.$("#resultsLabel").textContent).toBe("Results for “battery”");

    page.$("#heroQ").value = "zzz";
    page.$("#heroSearch").dispatchEvent(new page.window.Event("submit", { cancelable: true }));
    expect(page.$("#grid").textContent).toContain("No parts match");
    page.$("[data-reset]").click();
    expect(page.$$("#grid .product-card")).toHaveLength(4);
    page.close();
  });

  test("an API error shows the error state with a retry", async () => {
    const page = await openPage("Pages/Homepage/homepage.html", { role: null,
      api: api({ "/products": { status: 500, body: { error: "Database is down" } } }) });
    expect(page.$("#grid").textContent).toContain("Database is down");
    expect(page.$("#retryProducts")).not.toBeNull();
    page.close();
  });

  test("adding to the cart uses the server cart; visitors are sent to log in instead", async () => {
    const page = await openPage("Pages/Homepage/homepage.html", { role: "user", api: api() });
    page.$('#grid [data-add="1"]').click();
    await page.settle();
    expect(page.calls).toContainEqual({ url: "/cart", method: "POST", body: { productId: "1", quantity: 1 } });
    page.close();

    const visitor = await openPage("Pages/Homepage/homepage.html", { role: null, api: api() });
    visitor.$('#grid [data-add="1"]').click();
    await visitor.settle();
    expect(visitor.calls.some(c => c.method === "POST")).toBe(false);
    expect(visitor.$(".toast-region").textContent).toContain("Log in");
    visitor.close();
  });

  test("admins get remove buttons and the List a product dialog, not Add to cart", async () => {
    const page = await openPage("Pages/Homepage/homepage.html", { role: "admin", api: api() });
    expect(page.$("#grid [data-add]")).toBeNull();
    expect(page.$$("#grid [data-delete]")).toHaveLength(4);
    expect(page.$("#openAddBtn").hidden).toBe(false);
    page.$("#openAddBtn").click();
    expect(page.$("#productDialog").open).toBe(true);
    expect([...page.$("#productCategory").options].map(o => o.textContent)).toEqual(
      ["Choose a category", "Printer Parts", "Laptop Parts", "Computer Parts"]);
    page.close();
  });
});

describe("cart page (server cart)", () => {
  function cartApi(items) {
    return async ({ url, method, body }) => {
      if (url === "/cart" && method === "GET") return { body: items };
      if (url.startsWith("/cart/") && method === "DELETE") {
        const id = Number(url.split("/")[2]);
        items = items.filter(i => i.id !== id);
        return { body: {} };
      }
      if (url === "/cart" && method === "POST") {
        const row = items.find(i => String(i.id) === String(body.productId));
        if (row) row.quantity += body.quantity;
        else items.push({ id: Number(body.productId), quantity: body.quantity, name: "Part", price: "100.00", image: null, stock: 9 });
        return { body: {} };
      }
      return { body: [] };
    };
  }

  test("shows the server cart; + sets the new quantity on the server; Remove deletes it there", async () => {
    const page = await openPage("Pages/COpage/cart.html", { api: cartApi([
      { id: 7, quantity: 1, name: "Fuser unit", price: "500.00", image: null, stock: 5 },
      { id: 8, quantity: 2, name: "Ink pad", price: "100.00", image: null, stock: 2 }
    ]) });
    expect(page.$$(".line")).toHaveLength(2);
    expect(page.$(".summary-total .price").textContent).toBe("₱700.00");
    // at the stock limit, + is disabled
    expect(page.$('[data-step="1"][data-id="8"]').disabled).toBe(true);

    page.$('[data-step="1"][data-id="7"]').click();
    await page.until(() => page.$(".summary-total .price")?.textContent === "₱1,200.00");
    const changes = page.calls.filter(c => c.method !== "GET").map(c => [c.method, c.url, c.body]);
    expect(changes).toEqual([["DELETE", "/cart/7", undefined], ["POST", "/cart", { productId: "7", quantity: 2 }]]);

    page.$('[data-remove="8"]').click();
    await page.until(() => page.$$(".line").length === 1);
    expect(page.calls.at(-2)).toMatchObject({ method: "DELETE", url: "/cart/8" });
    // the local copy checkout reads follows the server
    expect(JSON.parse(page.window.localStorage.getItem("bongalink.cart")).map(i => [i.productId, i.quantity])).toEqual([["7", 2]]);
    page.close();
  });

  test("an item over available stock blocks checkout; an empty cart shows the empty state", async () => {
    const page = await openPage("Pages/COpage/cart.html", { api: cartApi([
      { id: 9, quantity: 3, name: "Printhead", price: "900.00", image: null, stock: 1 }
    ]) });
    expect(page.$(".line .alert").textContent).toContain("Only 1 available");
    expect(page.$(".summary-actions button").disabled).toBe(true);
    page.close();

    const empty = await openPage("Pages/COpage/cart.html", { api: cartApi([]) });
    expect(empty.$("#cart-body").textContent).toContain("Your cart is empty");
    empty.close();
  });
});

describe("checkout page", () => {
  test("loads the server cart and fills in the default saved address", async () => {
    const page = await openPage("Pages/COpage/checkout.html", { api: async ({ url }) => {
      if (url === "/cart") return { body: [{ id: 7, quantity: 2, name: "Fuser unit", price: "500.00", image: null, stock: 5 }] };
      if (url === "/v1/account/me") return { body: { email: "juan@example.com" } };
      if (url === "/v1/account/addresses") return { body: [{ address_id: 3, recipient_name: "Juan Dela Cruz", recipient_phone: "09171234567",
        street: "123 Street", barangay: "Pembo", city: "Makati", province: null, region: "NCR", postal_code: "1218", landmark: null, is_default: true }] };
      if (url === "/v1/shipping/quote") return { body: { zone: "NCR", options: [{ courier: "JNT", label: "J&T Express", fee: 100, eta: "1-3 days" }] } };
      return { body: {} };
    } });
    await page.until(() => page.$('input[name="courier"]'));
    const f = page.$("#checkout-form").elements;
    expect([f.email.value, f.firstName.value, f.lastName.value, f.city.value, page.$("#region").value])
      .toEqual(["juan@example.com", "Juan", "Dela Cruz", "Makati", "NCR"]);
    expect(page.$("#sum-subtotal").textContent).toBe("₱1,000.00");
    expect(page.calls.find(c => c.url === "/v1/shipping/quote").body.items).toEqual([{ product_id: 7, quantity: 2 }]);
    page.close();
  });
});

describe("profile page", () => {
  const me = (overrides = {}) => ({ user_id: 5, username: "juan", email: "juan@example.com", role: "user",
    created_at: "2026-01-15T00:00:00Z", email_verified_at: "2026-01-15T00:00:00Z", ...overrides });
  const profileApi = (user, extra = {}) => async (call) => {
    if (extra[call.url]) return extra[call.url](call);
    if (call.url === "/v1/account/me") return { body: user };
    if (call.url === "/v1/account/addresses") return { body: [] };
    if (call.url === "/orders") return { body: [{ order_id: 44, status: "shipped", total_amount: "600.00", shipping_fee: "100.00",
      courier: "JNT", paid_at: null, created_at: "2026-10-13T09:00:00Z", items: [{ name: "Fuser unit", quantity: 2 }] }] };
    if (call.url === "/v1/admin/orders/to-ship") return { body: { count: 0 } };
    return { body: {} };
  };

  test("header card, verified status and the customer's recent orders with a tracking link", async () => {
    const page = await openPage("Pages/Account/profile.html", { api: profileApi(me()) });
    await page.until(() => page.$("#profileName"));
    const head = page.$("#profileHead").textContent;
    expect(head).toContain("juan@example.com");
    expect(head).toContain("Customer");
    expect(head).toContain("Email verified");
    expect(head).toMatch(/Member since Jan 15, 2026/);
    expect(page.$("#verifyPanel").hidden).toBe(true);
    await page.until(() => page.$("#recentOrders [data-order]"));
    expect(page.$("#ordersSection").hidden).toBe(false);
    expect(page.$('#recentOrders a[href$="#order-44"]').textContent).toContain("Track");
    expect(page.$("#addressList").textContent).toContain("No saved addresses");
    page.close();
  });

  test("unverified email: verify panel with resend", async () => {
    const page = await openPage("Pages/Account/profile.html", { api: profileApi(me({ email_verified_at: null }),
      { "/v1/auth/verify-email/send": () => ({ body: { message: "Code sent." } }) }) });
    await page.until(() => page.$("#profileName"));
    expect(page.$("#profileHead").textContent).toContain("Email not verified");
    expect(page.$("#verifyPanel").hidden).toBe(false);
    page.$("#resendCode").click();
    await page.settle();
    expect(page.calls).toContainEqual({ url: "/v1/auth/verify-email/send", method: "POST", body: { email: "juan@example.com" } });
    page.close();
  });

  test("admins get the same layout without the order list", async () => {
    const page = await openPage("Pages/Account/profile.html", { role: "admin", api: profileApi(me({ role: "admin", username: "owner" })) });
    await page.until(() => page.$("#profileName"));
    expect(page.$("#profileHead").textContent).toContain("Admin");
    expect(page.$("#ordersSection").hidden).toBe(true);
    expect(page.calls.some(c => c.url === "/orders")).toBe(false);
    page.close();
  });

  test("changing the email asks for the password; addresses and passwords are sent as entered", async () => {
    const page = await openPage("Pages/Account/profile.html", { api: profileApi(me(), {
      "/v1/account/addresses": ({ method }) => ({ status: method === "POST" ? 201 : 200, body: method === "POST" ? {} : [] })
    }) });
    await page.until(() => page.$("#profileName"));
    expect(page.$("#infoPasswordField").hidden).toBe(true);
    page.$("#infoEmail").value = "new@example.com";
    page.$("#infoEmail").dispatchEvent(new page.window.Event("input"));
    expect(page.$("#infoPasswordField").hidden).toBe(false);

    page.$("#newPassword").value = "abcdef";
    page.$("#confirmPassword").value = "abcdeg";
    page.$("#passwordForm").dispatchEvent(new page.window.Event("submit", { cancelable: true }));
    expect(page.$("#passwordError").textContent).toBe("The new passwords don't match.");
    expect(page.calls.some(c => c.url === "/v1/account/password")).toBe(false);

    page.$("#addAddress").click();
    expect(page.$("#addressDialog").open).toBe(true);
    const form = page.$("#addressForm");
    Object.assign(form.elements, {});
    form.elements.recipient_name.value = "Juan";
    form.elements.recipient_phone.value = "09171234567";
    form.elements.street.value = "1 St";
    form.elements.barangay.value = "Pembo";
    form.elements.city.value = "Makati";
    form.elements.region.value = "NCR";
    form.elements.postal_code.value = "1218";
    form.dispatchEvent(new page.window.Event("submit", { cancelable: true }));
    await page.settle();
    expect(page.calls).toContainEqual(expect.objectContaining({ url: "/v1/account/addresses", method: "POST",
      body: expect.objectContaining({ recipient_name: "Juan", region: "NCR", postal_code: "1218", is_default: false }) }));
    page.close();
  });
});

describe("admin dashboard", () => {
  const days = Array.from({ length: 30 }, (_, i) => ({ day: `2026-09-${String(i + 1).padStart(2, "0")}`, units: i % 7 === 0 ? 2 : 0, revenue: i % 7 === 0 ? 500 : 0 }));
  // 12 ISO weeks (Mondays) ending with the week of Oct 5, 2026, and 6 months ending September 2026.
  const weeks = Array.from({ length: 12 }, (_, i) => ({ day: new Date(Date.UTC(2026, 6, 20 + 7 * i)).toISOString().slice(0, 10), units: i === 11 ? 4 : 0, revenue: i === 11 ? 1200 : 0 }));
  const months = ["2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01"].map((day, i) => ({ day, units: i, revenue: i * 100 }));
  const tile = (revenue, previous, orders) => ({ revenue, previous_revenue: previous, orders, units: orders,
    change_pct: previous ? Math.round(((revenue - previous) / previous) * 1000) / 10 : null });
  const sales = { today: tile(0, 0, 0), week: tile(12400, 10508.47, 5), month: tile(30000, 40000, 12) };
  const api = (dashboard) => async ({ url }) => {
    if (url.startsWith("/admin/ml/dashboard")) {
      const params = new URL(url, "http://x").searchParams;
      const group = params.get("group") || "day";
      const range = Number(params.get("range"));
      if (group === "week") return { body: { ...dashboard, group, range, trend: weeks } };
      if (group === "month") return { body: { ...dashboard, group, range, trend: months } };
      return { body: dashboard };
    }
    if (url === "/v1/admin/orders/to-ship") return { body: { count: 3 } };
    if (url === "/admin/ml/status") return { body: { state: "up_to_date", worker_online: true, last_update_at: "2026-10-14T08:00:00Z", active_model: { version: "v7" } } };
    return { body: {} };
  };
  const data = {
    group: "day", range: 30, days: 30, today: "2026-10-14", low_stock_threshold: 3, stock: { active_products: 66, low_stock: 4, out_of_stock: 60 },
    sales, month: { orders: 12, units: 12, revenue: 30000 }, trend: days,
    top_products: [{ product_id: 1, name: "Printhead L3210", category: "Printer Parts", units: 6, revenue: 16800 }]
  };

  test("summary tiles, sales chart with a table view, top products and quick links", async () => {
    const page = await openPage("Pages/Admin/dashboard.html", { role: "admin", api: api(data) });
    await page.until(() => page.$("#trendChart svg"));
    const value = (id) => page.$(`#${id} .stat__value`).textContent.trim();
    expect(value("statToShip")).toBe("3");
    expect(value("statLow")).toBe("4");
    expect(value("statOut")).toBe("60");
    expect(value("statOrders")).toBe("12");
    expect(page.$("#statOrders .stat__sub").textContent).toBe("October: 12 units sold");
    expect(value("statModel")).toBe("Up to date");
    expect(page.$$("#trendChart .bar")).toHaveLength(30);
    expect(page.$("#trendTable table").rows).toHaveLength(31);
    expect(page.$("#trendTable th").textContent).toBe("Day");
    expect(page.$("#topProducts").textContent).toContain("Printhead L3210");
    expect(page.$("#topPeriod").textContent).toBe("Last 30 days");
    expect(page.$$(".page-head a").map(a => a.getAttribute("href"))).toEqual(["inventory.html", "deliveries.html", "accounts.html", "inventory.html#forecasts"]);

    page.$('[data-metric="units"]').click();
    expect(page.$('[data-metric="units"]').getAttribute("aria-pressed")).toBe("true");
    expect(page.$("#trendNote").textContent).toMatch(/^Units in the last 30 days: 10 units/);
    page.close();
  });

  test("revenue tiles: today, this week and this month with the change vs the previous period", async () => {
    const page = await openPage("Pages/Admin/dashboard.html", { role: "admin", api: api(data) });
    await page.until(() => !page.$("#revWeek .skeleton"));
    const tileText = (id) => [page.$(`#${id} .stat__label`).textContent.trim(), page.$(`#${id} .stat__value`).textContent.trim(),
                              page.$(`#${id} .stat__sub`).textContent.trim()];
    expect(tileText("revToday")).toEqual(["Revenue today", "₱0", "No sales yesterday · 0 orders"]);
    expect(tileText("revWeek")).toEqual(["Revenue this week", "₱12,400", "+18% vs last week · 5 orders"]);
    expect(tileText("revMonth")).toEqual(["Revenue this month", "₱30,000", "-25% vs last month · 12 orders"]);
    expect(page.$("#revWeek .delta").className).toBe("delta delta--up");
    expect(page.$("#revMonth .delta").className).toBe("delta delta--down");
    expect(page.$("#revMonth").title).toBe("Last month: ₱40,000");
    page.close();
  });

  test("Day / Week / Month switch: grouped bars, per-grouping ranges, and a table that follows", async () => {
    const page = await openPage("Pages/Admin/dashboard.html", { role: "admin", api: api(data) });
    await page.until(() => page.$("#trendChart svg"));
    const options = () => page.$$("#trendRange option").map(o => o.textContent);
    const lastDashboardCall = () => page.calls.filter(c => c.url.startsWith("/admin/ml/dashboard")).at(-1).url;
    expect(options()).toEqual(["Last 30 days", "Last 90 days", "Last 180 days"]);
    expect(lastDashboardCall()).toBe("/admin/ml/dashboard?group=day&range=30");

    page.$('[data-group="week"]').click();
    await page.until(() => page.$$("#trendChart .bar").length === 12);
    expect(lastDashboardCall()).toBe("/admin/ml/dashboard?group=week&range=12");
    expect(page.$('[data-group="week"]').getAttribute("aria-pressed")).toBe("true");
    expect(page.$('[data-group="day"]').getAttribute("aria-pressed")).toBe("false");
    expect(options()).toEqual(["Last 12 weeks", "Last 26 weeks", "Last 52 weeks"]);
    expect(page.$("#trendNote").textContent).toBe("Revenue in the last 12 weeks: ₱1,200.00. Excludes this week and unpaid or expired orders.");
    expect(page.$("#trendTable th").textContent).toBe("Week");
    // Newest first, with the ISO week number and its Monday to Sunday; empty weeks are rows too.
    expect(page.$("#trendTable tbody tr").cells[0].textContent).toBe("Week 41 · Oct 5–Oct 11");
    expect(page.$("#trendTable tbody tr").cells[1].textContent).toBe("₱1,200.00");
    expect(page.$$("#trendTable tbody tr")).toHaveLength(12);
    expect(page.$("#topPeriod").textContent).toBe("Last 12 weeks");

    page.$("#trendRange").value = "52";
    page.$("#trendRange").dispatchEvent(new page.window.Event("change"));
    await page.until(() => lastDashboardCall() === "/admin/ml/dashboard?group=week&range=52");

    page.$('[data-group="month"]').click();
    await page.until(() => page.$$("#trendChart .bar").length === 6);
    expect(lastDashboardCall()).toBe("/admin/ml/dashboard?group=month&range=6");
    expect(options()).toEqual(["Last 6 months", "Last 12 months", "Last 24 months"]);
    expect(page.$("#trendTable th").textContent).toBe("Month");
    expect(page.$$("#trendTable tbody tr").map(r => r.cells[0].textContent)).toEqual(
      ["September 2026", "August 2026", "July 2026", "June 2026", "May 2026", "April 2026"]);
    expect(page.$("#trendTable tbody tr").cells[1].textContent).toBe("₱500.00");
    expect(page.$("#trendNote").textContent).toMatch(/Excludes this month/);

    page.$('[data-group="day"]').click();
    await page.until(() => page.$$("#trendChart .bar").length === 30);
    expect(lastDashboardCall()).toBe("/admin/ml/dashboard?group=day&range=30");
    page.close();
  });

  test("no sales in the period shows an empty state instead of a flat chart", async () => {
    const page = await openPage("Pages/Admin/dashboard.html", { role: "admin",
      api: api({ ...data, trend: days.map(d => ({ ...d, units: 0, revenue: 0 })), top_products: [] }) });
    await page.until(() => page.$("#trendChart .state"));
    expect(page.$("#trendChart").textContent).toContain("No sales in this period");
    expect(page.$("#topProducts").textContent).toContain("No sales yet");
    page.close();
  });

  test("customers get the admin-required message", async () => {
    const page = await openPage("Pages/Admin/dashboard.html", { role: "user", api: api(data) });
    expect(page.$("main").textContent).toContain("Admin account required");
    expect(page.calls.some(c => c.url.startsWith("/admin"))).toBe(false);
    page.close();
  });
});

describe("login page", () => {
  test("one form, no role switch; sends the username, password and the Remember me choice", async () => {
    const page = await openPage("Pages/Homepage/login.html", { role: null, api: async () => ({ status: 401, body: { error: "Invalid username or password." } }) });
    expect(page.$("#userRoleBtn")).toBeNull();
    page.$("#username").value = "juan";
    page.$("#password").value = "secret123";
    page.$("#loginForm").dispatchEvent(new page.window.Event("submit", { cancelable: true }));
    await page.until(() => !page.$("#loginMessage").hidden);
    expect(page.calls).toEqual([{ url: "/auth/login", method: "POST", body: { username: "juan", password: "secret123", remember: false } }]);
    expect(page.$("#loginMessage").textContent).toContain("Invalid username or password.");
    page.close();
  });
});
