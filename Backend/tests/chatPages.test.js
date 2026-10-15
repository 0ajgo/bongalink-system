// Chat widget on customer pages and the admin Chat & FAQs page, in jsdom with a stubbed API.
const { openPage } = require("./pageHarness");

const HOME = "Pages/Homepage/homepage.html";
const PRINTHEAD = { id: 7, name: "Epson L3110 Printhead", category: "Printer Parts", brand: "Epson", price: "1850.00",
  stock: 7, image: null, description: "For L3110.", weight_kg: "0.300", images: [] };

// reply: what POST /v1/chat/messages answers (a function gets the call).
function shopApi({ reply = { body: { reply: "Hello!", products: [] } } } = {}) {
  return async (call) => {
    if (call.url === "/v1/chat/messages") return typeof reply === "function" ? reply(call) : reply;
    if (call.url === "/products/7") return { body: PRINTHEAD };
    if (call.url === "/cart") return { body: [] };
    return { body: call.method === "GET" ? [] : {} };
  };
}

const chat = (page) => ({
  launcher: page.$(".chat-launcher"),
  panel: page.$(".chat-panel"),
  input: page.$("#chatInput"),
  bubbles: () => page.$$(".chat-log .chat-msg").map(b => b.textContent.replace(/\s+/g, " ").trim()),
  stored: () => JSON.parse(page.window.sessionStorage.getItem("bongalink_chat")),
});
const type = (page, text) => {
  const input = page.$("#chatInput");
  input.value = text;
  input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
};
const pressEnter = (page, opts = {}) => page.$("#chatInput").dispatchEvent(
  new page.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...opts }));
// Bot bubbles, not counting the typing indicator.
const replies = (page) => page.$(".chat-msg--bot:not(.chat-typing)").length;
const chatCalls = (page) => page.calls.filter(c => c.url === "/v1/chat/messages");

describe("chat widget", () => {
  test("a floating button opens the chat with a greeting and the suggested questions", async () => {
    const page = await openPage(HOME, { role: null, api: shopApi() });
    const c = chat(page);
    expect(c.launcher.textContent).toContain("Ask Bongalink");
    expect(c.panel.hidden).toBe(true);
    c.launcher.click();
    expect(c.panel.hidden).toBe(false);
    expect(c.launcher.getAttribute("aria-expanded")).toBe("true");
    expect(page.doc.activeElement).toBe(c.input);
    expect(c.bubbles()[0]).toMatch(/Bongalink's AI assistant/);
    expect(page.$$(".chat-suggest [data-suggest]").map(b => b.textContent))
      .toEqual(["Is this part in stock?", "How much is shipping to Cebu?", "Where is my order?"]);
    expect(page.$(".chat-log").getAttribute("role")).toBe("log");
    page.close();
  });

  test("Enter sends; a typing indicator shows; product names link to their page and nothing else becomes HTML", async () => {
    let answer;
    const page = await openPage(HOME, { role: "user", api: shopApi({ reply: () => new Promise(r => { answer = r; }) }) });
    const c = chat(page);
    c.launcher.click();
    type(page, "May stock ba ng printhead?");
    pressEnter(page, { shiftKey: true });      // Shift+Enter is a new line, not send
    expect(chatCalls(page)).toHaveLength(0);
    pressEnter(page);
    await page.until(() => answer);
    expect(chatCalls(page)[0].body).toEqual({ session_id: c.stored().sessionId, message: "May stock ba ng printhead?" });
    expect(page.$(".chat-typing")).not.toBeNull();
    expect(page.$("[data-send]").disabled).toBe(true);
    expect(c.input.value).toBe("");

    answer({ body: { reply: "Meron po! [Epson L3110 Printhead](product:7) — **7 available**.\n- ₱1,850.00\n<img src=x onerror=alert(1)>", products: [{ id: 7 }] } });
    await page.until(() => !page.$(".chat-typing"));
    const reply = page.$$(".chat-msg--bot").pop();
    expect(reply.querySelector("a").getAttribute("href")).toBe("../Homepage/product.html?id=7");
    expect(reply.querySelector("strong").textContent).toBe("7 available");
    expect(reply.querySelector("li").textContent).toBe("₱1,850.00");
    expect(reply.querySelector("img")).toBeNull();
    expect(reply.textContent).toContain("<img src=x onerror=alert(1)>");
    page.close();
  });

  test("a suggested question is sent with one click", async () => {
    const page = await openPage(HOME, { role: null, api: shopApi() });
    chat(page).launcher.click();
    page.$$(".chat-suggest [data-suggest]")[1].click();
    await page.until(() => replies(page) === 2 && !page.$(".chat-typing"));
    expect(chatCalls(page)[0].body.message).toBe("How much is shipping to Cebu?");
    page.close();
  });

  test("the conversation and open panel carry over to the next page (sessionStorage)", async () => {
    const first = await openPage(HOME, { role: null, api: shopApi() });
    chat(first).launcher.click();
    type(first, "Hi");
    pressEnter(first);
    await first.until(() => replies(first) === 2 && !first.$(".chat-typing"));
    const saved = first.window.sessionStorage.getItem("bongalink_chat");
    first.close();

    const next = await openPage("Pages/COpage/orders.html", { role: "user", api: shopApi(), storage: { bongalink_chat: saved } });
    const c = chat(next);
    expect(c.panel.hidden).toBe(false);
    expect(c.bubbles().slice(1)).toEqual(["You said: Hi", "Assistant: Hello!"]);
    type(next, "And shipping?");
    pressEnter(next);
    await next.until(() => chatCalls(next).length);
    expect(chatCalls(next)[0].body.session_id).toBe(JSON.parse(saved).sessionId);
    await next.until(() => replies(next) === 3 && !next.$(".chat-typing"));
    next.close();
  });

  test("Escape closes the chat and gives focus back; New chat starts a new session", async () => {
    const page = await openPage(HOME, { role: null, api: shopApi() });
    const c = chat(page);
    c.launcher.focus();
    c.launcher.click();
    const oldSession = c.stored().sessionId;
    c.input.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(c.panel.hidden).toBe(true);
    expect(page.doc.activeElement).toBe(c.launcher);
    expect(c.stored().open).toBe(false);

    c.launcher.click();
    page.$("[data-restart]").click();
    expect(c.stored().sessionId).not.toBe(oldSession);
    expect(c.bubbles()).toHaveLength(1);
    page.close();
  });

  test("too fast (429) shows the server's message; no connection offers Try again", async () => {
    let mode = "limited";
    const page = await openPage(HOME, { role: null, api: shopApi({ reply: () => {
      if (mode === "limited") return { status: 429, body: { error: "You're sending messages too quickly. Please wait a minute and try again." } };
      if (mode === "offline") throw new TypeError("Failed to fetch");
      return { body: { reply: "Back online.", products: [] } };
    } }) });
    chat(page).launcher.click();
    type(page, "Hello");
    pressEnter(page);
    await page.until(() => page.$(".chat-msg--error"));
    expect(page.$(".chat-msg--error").textContent).toContain("sending messages too quickly");
    expect(page.$(".chat-msg--error [data-retry]")).toBeNull();

    mode = "offline";
    type(page, "Hello again");
    pressEnter(page);
    await page.until(() => page.$(".chat-msg--error [data-retry]"));
    expect(page.$$(".chat-msg--error")).toHaveLength(1);   // the older error went away
    expect(page.$(".chat-msg--error").textContent).toContain("can't reach the shop");

    mode = "ok";
    page.$("[data-retry]").click();
    await page.until(() => chat(page).bubbles().some(b => b.includes("Back online.")));
    expect(chatCalls(page).pop().body.message).toBe("Hello again");
    expect(page.$(".chat-msg--error")).toBeNull();
    page.close();
  });

  test("messages over 500 characters are not sent", async () => {
    const page = await openPage(HOME, { role: null, api: shopApi() });
    chat(page).launcher.click();
    type(page, "x".repeat(510));
    expect(page.$("#chatCount").hidden).toBe(false);
    expect(page.$("#chatCount").textContent).toBe("10 characters too long");
    pressEnter(page);
    await page.settle();
    expect(chatCalls(page)).toHaveLength(0);
    page.close();
  });

  test("admins don't get the widget", async () => {
    const page = await openPage(HOME, { role: "admin", api: shopApi() });
    expect(page.$(".chat-launcher")).toBeNull();
    page.close();
  });

  test("product page: Ask about this part starts the chat about that product", async () => {
    const page = await openPage("Pages/Homepage/product.html", { role: "user", query: "id=7", api: shopApi() });
    await page.until(() => page.$("#askAbout"));
    page.$("#askAbout").click();
    expect(page.$(".chat-panel").hidden).toBe(false);
    expect(page.$(".chat-context").textContent).toContain("Asking about Epson L3110 Printhead");
    expect(page.$$(".chat-suggest [data-suggest]").map(b => b.textContent)).toContain("Will this fit my model?");
    page.$$(".chat-suggest [data-suggest]")[0].click();
    await page.until(() => chatCalls(page).length);
    expect(chatCalls(page)[0].body).toMatchObject({ message: "Is this part in stock?", product_id: 7 });
    await page.until(() => replies(page) === 2 && !page.$(".chat-typing"));

    page.$("[data-clear-product]").click();
    expect(page.$(".chat-context").hidden).toBe(true);
    page.close();
  });
});

/* ------------------------------------------------------------- admin */
const summary = { unanswered_open: 2, last_30_days: { messages: 40, answered: 34, conversations: 15 }, faqs: { active: 3, placeholders: 2 } };
const log = (id, extra = {}) => ({ chat_id: id, session_id: `sess-${id}`, user_id: null, username: null, product_id: null, product_name: null,
  message: `Question ${id}`, reply: "I'm not sure. Please contact the shop.", tools: ["mark_unanswered"], answered: false,
  unanswered_reason: "no_information", resolved_at: null, faq_id: null, model: "m", response_ms: 900,
  created_at: "2026-10-14T08:00:00Z", session_messages: 1, ...extra });
const faq = (id, extra = {}) => ({ faq_id: id, question: `FAQ question ${id}?`, answer: `Answer ${id}.`, category: "Payment",
  is_active: true, is_placeholder: false, from_questions: 0, ...extra });

function adminApi() {
  return async (call) => {
    const { url, method } = call;
    if (url === "/v1/admin/chat/summary") return { body: summary };
    if (url.startsWith("/v1/admin/chat/logs?view=unanswered")) {
      return { body: { logs: [log(12, { unanswered_reason: "needs_staff", username: "juan", user_id: 3 }), log(11, { product_id: 7, product_name: "Epson L3110 Printhead" })], has_more: false } };
    }
    if (url.startsWith("/v1/admin/chat/logs?")) {
      return { body: { logs: [log(13, { answered: true, unanswered_reason: null, reply: "Yes, [Epson L3110 Printhead](product:7) is in stock.", tools: ["search_products"], session_messages: 3 }), log(12)], has_more: true } };
    }
    if (url.startsWith("/v1/admin/chat/logs/") && method === "PATCH") return { body: { ok: true } };
    if (url.startsWith("/v1/admin/chat/sessions/")) {
      return { body: { messages: [log(1, { message: "Hi", reply: "Hello!", answered: true, unanswered_reason: null }), log(2, { message: "Warranty?" })] } };
    }
    if (url === "/v1/admin/faqs" && method === "GET") return { body: [faq(1, { is_placeholder: true }), faq(2, { is_placeholder: true, category: "Store" }), faq(3, { is_active: false })] };
    if (url === "/v1/admin/faqs" && method === "POST") return { status: 201, body: faq(9) };
    if (url.startsWith("/v1/admin/faqs/")) return { body: method === "DELETE" ? { ok: true } : faq(1) };
    if (url === "/v1/admin/orders/to-ship") return { body: { count: 0 } };
    return { body: {} };
  };
}

describe("admin Chat & FAQs page", () => {
  const open = async () => {
    const page = await openPage("Pages/Admin/chat.html", { role: "admin", api: adminApi() });
    await page.until(() => page.$("#queue [data-to-faq]") && page.$("#faqList [data-edit-faq]") && page.$("#logList [data-convo]"));
    return page;
  };

  test("tiles, then unanswered questions, FAQs (with the placeholder warning) and history", async () => {
    const page = await open();
    expect(page.$('.site-nav a[aria-current="page"]').textContent.trim()).toBe("Chat & FAQs");
    expect(page.$("#statOpen .stat__value").textContent).toBe("2");
    expect(page.$("#statRate .stat__value").textContent).toBe("85%");
    expect(page.$("#statRate .stat__sub").textContent).toBe("34 of 40 messages · 15 conversations");
    expect(page.$("#statFaqs .stat__sub").textContent).toBe("2 still placeholder text");

    const sections = page.$$("main section").map(s => s.id);
    expect(sections).toEqual(["unanswered", "faqs", "history"]);
    const first = page.$("#queue .chat-item");
    expect(first.textContent).toContain("Question 12");
    expect(first.textContent).toContain("Needs the shop");
    expect(first.textContent).toContain("juan");
    expect(page.$$("#queue .chat-item")[1].querySelector("a").textContent).toBe("Epson L3110 Printhead");

    expect(page.$("#faqNotice").textContent).toContain("2 FAQs are starter text that the shop hasn't confirmed");
    expect(page.$$("#faqList .faq-item")[2].textContent).toContain("Hidden from the assistant");

    const history = page.$("#logList .chat-item");
    expect(history.querySelector(".chat-item__a a").getAttribute("href")).toBe("../Homepage/product.html?id=7");
    expect(history.textContent).toContain("checked: search products");
    expect(history.textContent).toContain("View conversation (3)");
    expect(page.$("#moreWrap").hidden).toBe(false);
    page.close();
  });

  test("Turn into FAQ: pre-filled from the question; saving links it to that question", async () => {
    const page = await open();
    page.$('#queue [data-to-faq="11"]').click();
    expect(page.$("#faqDialog").open).toBe(true);
    expect(page.$("#faqDialogTitle").textContent).toBe("Turn question into FAQ");
    expect(page.$("#faqQuestion").value).toBe("Question 11");
    expect(page.$("#faqSource").hidden).toBe(false);
    expect(page.doc.activeElement.id).toBe("faqAnswer");

    page.$("#faqForm").dispatchEvent(new page.window.Event("submit", { cancelable: true }));
    expect(page.$("#faqAnswerError").textContent).toBe("Write the answer (at least 5 characters).");
    expect(page.$("#faqAnswer").getAttribute("aria-invalid")).toBe("true");
    expect(page.calls.some(c => c.method === "POST")).toBe(false);

    page.$("#faqAnswer").value = "Yes, we sell genuine Epson ink bottles.";
    page.$("#faqCategory").value = "Products";
    page.$("#faqForm").dispatchEvent(new page.window.Event("submit", { cancelable: true }));
    await page.until(() => page.calls.some(c => c.method === "POST"));
    expect(page.calls.find(c => c.method === "POST")).toEqual({ url: "/v1/admin/faqs", method: "POST", body: {
      question: "Question 11", answer: "Yes, we sell genuine Epson ink bottles.", category: "Products",
      is_active: true, is_placeholder: false, source_chat_id: 11 } });
    await page.until(() => !page.$("#faqDialog").open);
    await page.until(() => page.calls.filter(c => c.url.startsWith("/v1/admin/chat/logs?view=unanswered")).length === 2);
    await page.settle();
    page.close();
  });

  test("editing a placeholder FAQ and confirming it; deleting asks first", async () => {
    const page = await open();
    page.$('[data-edit-faq="1"]').click();
    expect(page.$("#faqDialogTitle").textContent).toBe("Edit FAQ");
    expect(page.$("#faqConfirmed").checked).toBe(false);
    page.$("#faqConfirmed").checked = true;
    page.$("#faqForm").dispatchEvent(new page.window.Event("submit", { cancelable: true }));
    await page.until(() => page.calls.some(c => c.method === "PATCH"));
    expect(page.calls.find(c => c.method === "PATCH")).toEqual({ url: "/v1/admin/faqs/1", method: "PATCH",
      body: { question: "FAQ question 1?", answer: "Answer 1.", category: "Payment", is_active: true, is_placeholder: false } });
    await page.until(() => !page.$("#faqDialog").open);

    page.$('[data-delete-faq="3"]').click();
    await page.until(() => page.calls.some(c => c.method === "DELETE"));
    expect(page.calls).toContainEqual({ url: "/v1/admin/faqs/3", method: "DELETE", body: undefined });
    await page.until(() => page.doc.body.textContent.includes("FAQ deleted."));
    await page.settle();
    page.close();
  });

  test("Mark as handled, a whole conversation, and the history filters", async () => {
    const page = await open();
    page.$('#queue [data-dismiss="12"]').click();
    await page.until(() => page.calls.some(c => c.method === "PATCH"));
    expect(page.calls).toContainEqual({ url: "/v1/admin/chat/logs/12", method: "PATCH", body: { resolved: true } });

    page.$('#logList [data-convo="sess-13"]').click();
    await page.until(() => page.$$("#convoLog .chat-msg").length === 4);
    expect(page.calls.some(c => c.url === "/v1/admin/chat/sessions/sess-13")).toBe(true);
    expect(page.$("#convoMeta").textContent).toContain("Guest · ");
    expect(page.$("#convoLog").textContent).toContain("Bot had no answer");

    page.$("#fView").value = "not_answered";
    page.$("#fCustomer").value = "guest";
    page.$("#fDays").value = "7";
    page.$("#fView").dispatchEvent(new page.window.Event("change", { bubbles: true }));
    await page.until(() => page.calls.some(c => c.url.includes("view=not_answered")));
    expect(page.calls.find(c => c.url.includes("view=not_answered")).url)
      .toBe("/v1/admin/chat/logs?view=not_answered&customer=guest&days=7&limit=30");

    page.$("#loadMore").click();
    await page.until(() => page.calls.some(c => c.url.includes("before=")));
    expect(page.calls.find(c => c.url.includes("before=")).url).toContain("before=12");
    await page.settle();
    page.close();
  });

  test("customers see 'Admin account required' and no chat data is loaded", async () => {
    const page = await openPage("Pages/Admin/chat.html", { role: "user", api: adminApi() });
    expect(page.$("main").textContent).toContain("Admin account required");
    expect(page.calls.some(c => c.url.includes("/admin/chat") || c.url.includes("/admin/faqs"))).toBe(false);
    page.close();
  });

  test("the Dashboard shows the unanswered count, linking to Chat & FAQs", async () => {
    const page = await openPage("Pages/Admin/dashboard.html", { role: "admin", api: async (call) =>
      call.url === "/v1/admin/chat/summary" ? { body: summary } : { status: 500, body: { error: "not stubbed" } } });
    await page.until(() => page.$("#statChat .stat__value").textContent === "2");
    expect(page.$("#statChat").getAttribute("href")).toBe("chat.html#unanswered");
    expect(page.$("#statChat .stat__sub").textContent).toBe("The assistant couldn't answer: add FAQs");
    page.close();
  });
});
