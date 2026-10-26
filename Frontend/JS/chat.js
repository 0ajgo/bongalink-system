/* Chat widget (every customer page). Requires api.js, icons.js and ui.js;
   load after ui.js.
   - Floating button bottom-right; a panel with the conversation, typing
     indicator and suggested questions. Full screen on phones.
   - The conversation stays when moving between pages (sessionStorage,
     this tab only).
   - ChatWidget.askAbout({ id, name }) opens the chat about one product
     (the product page's "Ask about this part").
   - Replies are plain text; the only links are product links.
   Admins don't get the widget. */

const ChatWidget = (() => {
  const STORE_KEY = "bongalink_chat";
  const MAX_MESSAGE = 500;
  const KEEP_MESSAGES = 60;
  const SUGGESTIONS = ["Is this part in stock?", "How much is shipping to Cebu?", "Where is my order?"];
  const PRODUCT_SUGGESTIONS = ["Is this part in stock?", "How much is shipping to Cebu?", "Will this fit my model?"];
  const GREETING = "Hi! I'm Bongalink's AI assistant. Ask me about parts, stock, shipping or your order, in English or Filipino.";

  let state = load();
  let busy = false;
  let els = null;
  let lastFocus = null;

  /* --- storage -------------------------------------------------------- */
  function newSessionId() {
    if (window.crypto?.randomUUID) return crypto.randomUUID();
    return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
  function load() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || "null");
      if (saved && typeof saved.sessionId === "string" && Array.isArray(saved.messages)) return saved;
    } catch (e) { /* storage off or damaged: start fresh */ }
    return { sessionId: newSessionId(), messages: [], open: false, product: null, draft: "" };
  }
  function save() {
    state.messages = state.messages.slice(-KEEP_MESSAGES);
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* private mode: this page only */ }
  }

  /* --- rendering ------------------------------------------------------ */
  function bubble(m, i) {
    if (m.role === "user") {
      return `<div class="chat-msg chat-msg--user"><span class="sr-only">You said: </span><p>${escapeHTML(m.text).replace(/\n/g, "<br>")}</p></div>`;
    }
    const retry = m.error && m.retry ? `<button class="btn btn--secondary btn--sm" type="button" data-retry="${i}">${icon("refresh-cw", { size: 14 })} Try again</button>` : "";
    return `<div class="chat-msg chat-msg--bot${m.error ? " chat-msg--error" : ""}"><span class="sr-only">Assistant: </span>${chatTextHTML(m.text)}${retry}</div>`;
  }

  function renderLog() {
    const greeting = bubble({ role: "bot", text: GREETING });
    const msgs = state.messages.map(bubble).join("");
    const typing = busy ? `<div class="chat-msg chat-msg--bot chat-typing" aria-label="Assistant is typing"><span></span><span></span><span></span></div>` : "";
    els.log.innerHTML = greeting + msgs + typing;
    renderSuggestions();
    els.log.scrollTop = els.log.scrollHeight;
  }

  function renderSuggestions() {
    const asked = new Set(state.messages.filter(m => m.role === "user").map(m => m.text));
    const list = (state.product ? PRODUCT_SUGGESTIONS : SUGGESTIONS).filter(s => !asked.has(s));
    const show = !busy && list.length && state.messages.length < 6;
    els.suggest.hidden = !show;
    els.suggest.innerHTML = show ? list.map(s => `<button class="chip" type="button" data-suggest>${escapeHTML(s)}</button>`).join("") : "";
  }

  function renderContext() {
    els.context.hidden = !state.product;
    els.context.innerHTML = state.product ? `${icon("package", { size: 16 })}
      <span>Asking about <a href="${productUrl(state.product.id)}">${escapeHTML(state.product.name)}</a></span>
      <button class="btn btn--ghost btn--icon btn--sm" type="button" data-clear-product>${icon("x", { size: 14, label: "Stop asking about this part" })}</button>` : "";
  }

  function setBusy(value) {
    busy = value;
    els.send.disabled = value;
    els.panel.setAttribute("aria-busy", String(value));
    renderLog();
  }

  /* --- sending -------------------------------------------------------- */
  async function send(text) {
    text = String(text || "").trim();
    if (!text || busy) return;
    if (text.length > MAX_MESSAGE) {
      showCount(true);
      return;
    }
    state.messages = state.messages.filter(m => !m.error);   // a new message replaces any error
    state.messages.push({ role: "user", text });
    state.draft = "";
    els.input.value = "";
    autosize();
    showCount();
    save();
    await ask(text);
  }

  async function ask(text) {
    setBusy(true);
    try {
      const data = await apiFetch("/v1/chat/messages", { method: "POST", timeout: API_TIMEOUT_CHAT_MS,
        body: JSON.stringify({ session_id: state.sessionId, message: text, ...(state.product ? { product_id: state.product.id } : {}) }) });
      state.messages.push({ role: "bot", text: data.reply || "Sorry, I have no answer for that." });
    } catch (err) {
      const offline = !err.status;
      state.messages.push({ role: "bot", error: true, retry: offline || err.status >= 500,
        text: offline ? "I can't reach the shop right now. Check your connection and try again." : err.message });
    } finally {
      save();
      setBusy(false);
      if (els.panel.contains(document.activeElement) || document.activeElement === document.body) els.input.focus();
    }
  }

  function retry(index) {
    const lastUser = [...state.messages.slice(0, index)].reverse().find(m => m.role === "user");
    state.messages.splice(index, 1);
    if (lastUser) ask(lastUser.text);
  }

  /* --- open / close --------------------------------------------------- */
  const isFullScreen = () => Boolean(window.matchMedia?.("(max-width: 640px)").matches);

  function open({ focus = true } = {}) {
    if (!els) mount();
    lastFocus = document.activeElement;
    state.open = true;
    save();
    els.panel.hidden = false;
    els.launcher.setAttribute("aria-expanded", "true");
    els.launcher.hidden = isFullScreen();
    document.body.classList.toggle("chat-open-full", isFullScreen());
    renderContext();
    renderLog();
    if (focus) els.input.focus();
  }

  function close() {
    state.open = false;
    save();
    els.panel.hidden = true;
    els.launcher.hidden = false;
    els.launcher.setAttribute("aria-expanded", "false");
    document.body.classList.remove("chat-open-full");
    (lastFocus && document.contains(lastFocus) && lastFocus !== document.body ? lastFocus : els.launcher).focus();
  }

  function restart() {
    state = { sessionId: newSessionId(), messages: [], open: true, product: null, draft: "" };
    save();
    renderContext();
    renderLog();
    els.input.focus();
  }

  // Product page: "Ask about this part".
  function askAbout(product) {
    if (!product?.id) return;
    state.product = { id: Number(product.id), name: String(product.name || "this part") };
    save();
    open();
  }

  /* --- input helpers -------------------------------------------------- */
  function autosize() {
    els.input.style.height = "auto";
    els.input.style.height = `${Math.min(els.input.scrollHeight, 120)}px`;
  }
  function showCount(force = false) {
    const n = els.input.value.length;
    const over = n > MAX_MESSAGE;
    els.count.hidden = !force && n < MAX_MESSAGE - 100;
    els.count.textContent = over ? `${n - MAX_MESSAGE} characters too long` : `${MAX_MESSAGE - n} characters left`;
    els.count.classList.toggle("is-over", over);
    els.input.setAttribute("aria-invalid", String(over));
  }

  // Full-screen on phones: keep Tab inside the panel.
  function trapFocus(event) {
    if (event.key !== "Tab" || !isFullScreen()) return;
    const items = [...els.panel.querySelectorAll("button:not([disabled]), a[href], textarea")].filter(el => el.offsetParent !== null || el === els.input);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  /* --- mount ---------------------------------------------------------- */
  function mount() {
    const root = document.createElement("div");
    root.className = "chat-widget";
    root.innerHTML = `
      <button class="chat-launcher" type="button" aria-expanded="false" aria-controls="chatPanel">
        ${icon("message-circle", { size: 24 })}<span class="chat-launcher__label">Ask Bongalink</span>
      </button>
      <section class="chat-panel" id="chatPanel" role="dialog" aria-labelledby="chatTitle" aria-describedby="chatNote" hidden>
        <header class="chat-panel__header">
          <span class="chat-panel__avatar">${icon("bot", { size: 20 })}</span>
          <div class="chat-panel__title">
            <h2 id="chatTitle">Bongalink assistant</h2>
            <span>AI answers from our live stock · 24/7</span>
          </div>
          <button class="btn btn--ghost btn--icon btn--sm" type="button" data-restart title="New chat">${icon("rotate-ccw", { size: 16, label: "Start a new chat" })}</button>
          <button class="btn btn--ghost btn--icon btn--sm" type="button" data-close title="Close">${icon("x", { size: 18, label: "Close chat" })}</button>
        </header>
        <div class="chat-context" data-context hidden></div>
        <div class="chat-log" role="log" aria-live="polite" aria-label="Conversation" tabindex="0"></div>
        <div class="chat-suggest chips" aria-label="Suggested questions" role="group"></div>
        <form class="chat-form" novalidate>
          <label class="sr-only" for="chatInput">Your message</label>
          <textarea class="textarea chat-input" id="chatInput" rows="1" maxlength="${MAX_MESSAGE + 200}"
                    placeholder="Type your question…" aria-describedby="chatCount"></textarea>
          <button class="btn btn--primary btn--icon" type="submit" data-send>${icon("send", { size: 18, label: "Send" })}</button>
        </form>
        <p class="chat-count" id="chatCount" hidden></p>
        <p class="chat-note" id="chatNote">AI can make mistakes; check prices and stock on the product page. Chats are saved to improve our answers.</p>
      </section>`;
    document.body.appendChild(root);

    els = {
      root, launcher: root.querySelector(".chat-launcher"), panel: root.querySelector(".chat-panel"),
      log: root.querySelector(".chat-log"), suggest: root.querySelector(".chat-suggest"),
      context: root.querySelector("[data-context]"), form: root.querySelector(".chat-form"),
      input: root.querySelector(".chat-input"), send: root.querySelector("[data-send]"), count: root.querySelector(".chat-count")
    };

    els.launcher.addEventListener("click", () => (state.open ? close() : open()));
    root.querySelector("[data-close]").addEventListener("click", close);
    root.querySelector("[data-restart]").addEventListener("click", restart);
    els.form.addEventListener("submit", (e) => { e.preventDefault(); send(els.input.value); });
    els.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(els.input.value); }
    });
    els.input.addEventListener("input", () => {
      state.draft = els.input.value;
      save();
      autosize();
      showCount();
    });
    els.panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.stopPropagation(); close(); }
      trapFocus(e);
    });
    els.suggest.addEventListener("click", (e) => {
      const chip = e.target.closest("[data-suggest]");
      if (chip) send(chip.textContent);
    });
    els.log.addEventListener("click", (e) => {
      const r = e.target.closest("[data-retry]");
      if (r) retry(Number(r.dataset.retry));
    });
    els.context.addEventListener("click", (e) => {
      if (!e.target.closest("[data-clear-product]")) return;
      state.product = null;
      save();
      renderContext();
      renderSuggestions();
      els.input.focus();
    });
    window.addEventListener("resize", () => {
      if (!state.open) return;
      els.launcher.hidden = isFullScreen();
      document.body.classList.toggle("chat-open-full", isFullScreen());
    });

    els.input.value = state.draft || "";
    if (state.open) open({ focus: false });
  }

  const enabled = () => !(session.loggedIn && session.role === "admin");
  if (enabled()) mount();

  return { open, close, askAbout, send, get enabled() { return enabled(); } };
})();
