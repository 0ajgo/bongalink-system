/* =====================================================================
   BONGALINK — ADMIN CHAT & FAQs (Pages/Admin/chat.html)
   Requires api.js, icons.js, cart.js and ui.js.
     GET   /api/v1/admin/chat/summary
     GET   /api/v1/admin/chat/logs?view=&q=&days=&customer=&before=
     GET   /api/v1/admin/chat/sessions/:sessionId
     PATCH /api/v1/admin/chat/logs/:id        { resolved }
     GET / POST / PATCH / DELETE /api/v1/admin/faqs
   The loop for the paper's "progressively improve": the bot marks what it
   couldn't answer -> it shows up here -> "Turn into FAQ" -> the bot uses
   the new FAQ from the next message on.
   ===================================================================== */

renderHeader({ active: "chat" });

const $ = (id) => document.getElementById(id);
const REASON = {
  no_information: ["Bot had no answer", "warning"],
  needs_staff: ["Needs the shop", "warning"],
  service_down: ["Assistant was down", "error"],
  off_topic: ["Off-topic", ""]
};
const chatState = { faqs: [], queue: [], logs: [], hasMore: false, faqEditing: null, faqSource: null };

const who = (l) => l.username ? escapeHTML(l.username) : "Guest";
const reasonBadge = (l) => {
  if (l.answered) return `<span class="badge badge--success">Answered</span>`;
  const [label, tone] = REASON[l.unanswered_reason] || ["Not answered", "warning"];
  return `<span class="badge ${tone ? `badge--${tone}` : ""}">${label}</span>`;
};
const fromPage = (l) => l.product_id
  ? ` · from <a href="${productUrl(l.product_id)}">${escapeHTML(l.product_name || `product #${l.product_id}`)}</a>` : "";

/* ---------------------------------------------------------------------
   SUMMARY TILES (the Dashboard shows the same unanswered count)
   --------------------------------------------------------------------- */
function setTile(id, value, sub) {
  $(id).querySelector(".stat__value").innerHTML = value;
  $(id).querySelector(".stat__sub").textContent = sub;
}

async function loadSummary() {
  try {
    const s = await apiFetch("/v1/admin/chat/summary");
    setTile("statOpen", String(s.unanswered_open), s.unanswered_open ? "Questions the assistant couldn't answer" : "All caught up");
    const m = s.last_30_days;
    setTile("statRate", m.messages ? `${Math.round((m.answered / m.messages) * 100)}%` : "—",
      m.messages ? `${m.answered} of ${m.messages} messages · ${m.conversations} conversation${m.conversations === 1 ? "" : "s"}` : "No chats yet");
    setTile("statFaqs", String(s.faqs.active), s.faqs.placeholders ? `${s.faqs.placeholders} still placeholder text` : "All confirmed by the shop");
  } catch (err) {
    ["statOpen", "statRate", "statFaqs"].forEach(id => setTile(id, "—", `Couldn't load: ${err.message}`));
  }
}

/* ---------------------------------------------------------------------
   UNANSWERED QUEUE
   --------------------------------------------------------------------- */
function queueItem(l) {
  return `
    <article class="chat-item" data-chat="${l.chat_id}">
      <div class="chat-item__meta">${reasonBadge(l)}<span>${formatDateTime(l.created_at)} · ${who(l)}${fromPage(l)}</span></div>
      <p class="chat-item__q">${escapeHTML(l.message)}</p>
      <details class="chat-item__reply"><summary>What the assistant replied</summary>
        <div class="chat-msg chat-msg--bot">${chatTextHTML(l.reply)}</div></details>
      <div class="row chat-item__actions">
        <button class="btn btn--primary btn--sm" type="button" data-to-faq="${l.chat_id}">${icon("book-open", { size: 16 })} Turn into FAQ</button>
        <button class="btn btn--secondary btn--sm" type="button" data-convo="${escapeHTML(l.session_id)}">${icon("messages-square", { size: 16 })} View conversation</button>
        <button class="btn btn--ghost btn--sm" type="button" data-dismiss="${l.chat_id}">${icon("check", { size: 16 })} Mark as handled</button>
      </div>
    </article>`;
}

async function loadQueue() {
  $("queue").innerHTML = `<div class="card__body"><span class="skeleton skeleton--text"></span><span class="skeleton skeleton--text skeleton--short"></span></div>`;
  try {
    const { logs } = await apiFetch("/v1/admin/chat/logs?view=unanswered&days=all&limit=50");
    chatState.queue = logs;
    $("queue").innerHTML = logs.length ? logs.map(queueItem).join("")
      : UIState.empty({ icon: "check", title: "No unanswered questions", text: "When the assistant can't answer something, it shows up here so you can add an FAQ." });
  } catch (err) {
    $("queue").innerHTML = UIState.error(err.message, "retryQueue");
    $("retryQueue")?.addEventListener("click", loadQueue);
  }
}

/* ---------------------------------------------------------------------
   FAQs
   --------------------------------------------------------------------- */
function faqItem(f) {
  return `
    <article class="chat-item faq-item${f.is_active ? "" : " is-inactive"}" data-faq="${f.faq_id}">
      <div class="faq-item__main">
        <div class="chat-item__meta">
          <span class="badge">${escapeHTML(f.category)}</span>
          ${f.is_active ? "" : `<span class="badge">Hidden from the assistant</span>`}
          ${f.is_placeholder ? `<span class="badge badge--warning">Placeholder: confirm with the shop</span>` : ""}
          ${f.from_questions ? `<span class="muted">from ${f.from_questions} customer question${f.from_questions === 1 ? "" : "s"}</span>` : ""}
        </div>
        <h3 class="faq-item__q">${escapeHTML(f.question)}</h3>
        <p class="faq-item__a">${escapeHTML(f.answer)}</p>
      </div>
      <div class="row chat-item__actions">
        <button class="btn btn--secondary btn--sm" type="button" data-edit-faq="${f.faq_id}" aria-label="Edit FAQ: ${escapeHTML(f.question)}">${icon("pencil", { size: 14 })} Edit</button>
        <button class="btn btn--ghost btn--sm btn--icon" type="button" data-delete-faq="${f.faq_id}" title="Delete">${icon("trash-2", { size: 16, label: `Delete FAQ: ${f.question}` })}</button>
      </div>
    </article>`;
}

function renderFaqs() {
  const list = chatState.faqs;
  const placeholders = list.filter(f => f.is_active && f.is_placeholder).length;
  $("faqNotice").innerHTML = placeholders ? `<div class="card__body"><div class="alert alert--warning">${icon("triangle-alert", { size: 18 })}
    <span>${placeholders} FAQ${placeholders === 1 ? " is" : "s are"} starter text that the shop hasn't confirmed. The assistant tells customers to
    confirm those details. Edit each one and tick <strong>Confirmed by the shop</strong>.</span></div></div>` : "";
  $("faqList").innerHTML = list.length ? list.map(faqItem).join("")
    : UIState.empty({ icon: "book-open", title: "No FAQs yet", text: "Add the answers customers ask for most: payment, delivery, returns, store hours." });
  $("faqCategories").innerHTML = [...new Set(list.map(f => f.category))].map(c => `<option value="${escapeHTML(c)}">`).join("");
}

async function loadFaqs() {
  try {
    chatState.faqs = await apiFetch("/v1/admin/faqs");
    renderFaqs();
  } catch (err) {
    $("faqList").innerHTML = UIState.error(err.message, "retryFaqs");
    $("retryFaqs")?.addEventListener("click", loadFaqs);
  }
}

function faqFieldError(id, message) {
  $(`${id}Error`).textContent = message;
  if (message) $(id).setAttribute("aria-invalid", "true");
  else $(id).removeAttribute("aria-invalid");
}

function openFaqDialog({ faq = null, source = null } = {}) {
  chatState.faqEditing = faq;
  chatState.faqSource = source;
  $("faqDialogTitle").textContent = faq ? "Edit FAQ" : source ? "Turn question into FAQ" : "Add FAQ";
  $("faqQuestion").value = faq ? faq.question : source ? source.message.slice(0, 255) : "";
  $("faqAnswer").value = faq ? faq.answer : "";
  $("faqCategory").value = faq ? faq.category : "";
  $("faqActive").checked = faq ? faq.is_active : true;
  $("faqConfirmed").checked = faq ? !faq.is_placeholder : true;
  $("faqSource").hidden = !source;
  $("faqSource").innerHTML = source ? `${icon("info", { size: 18 })}<span>From a customer question on ${formatDateTime(source.created_at)}.
    Saving marks that question as handled. The assistant replied: “${escapeHTML(source.reply.slice(0, 200))}${source.reply.length > 200 ? "…" : ""}”</span>` : "";
  ["faqQuestion", "faqAnswer"].forEach(id => faqFieldError(id, ""));
  $("faqError").textContent = "";
  $("faqDialog").showModal();
  (source ? $("faqAnswer") : $("faqQuestion")).focus();
}

$("faqForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = $("faqQuestion").value.trim();
  const answer = $("faqAnswer").value.trim();
  faqFieldError("faqQuestion", question.length < 5 ? "Write the question (at least 5 characters)." : "");
  faqFieldError("faqAnswer", answer.length < 5 ? "Write the answer (at least 5 characters)." : "");
  if (question.length < 5) return $("faqQuestion").focus();
  if (answer.length < 5) return $("faqAnswer").focus();

  const body = { question, answer, category: $("faqCategory").value.trim() || "General",
                 is_active: $("faqActive").checked, is_placeholder: !$("faqConfirmed").checked };
  const editing = chatState.faqEditing;
  if (!editing && chatState.faqSource) body.source_chat_id = chatState.faqSource.chat_id;
  const submit = $("faqSubmit");
  submit.disabled = true;
  submit.classList.add("is-loading");
  try {
    await apiFetch(editing ? `/v1/admin/faqs/${editing.faq_id}` : "/v1/admin/faqs",
      { method: editing ? "PATCH" : "POST", body: JSON.stringify(body) });
    $("faqDialog").close();
    toast(editing ? "FAQ saved. The assistant uses it from the next message." : "FAQ added. The assistant uses it from the next message.", "success");
    await Promise.all([loadFaqs(), loadSummary(), chatState.faqSource ? loadQueue() : null]);
  } catch (err) {
    $("faqError").textContent = err.message;
  } finally {
    submit.disabled = false;
    submit.classList.remove("is-loading");
  }
});

$("addFaq").addEventListener("click", () => openFaqDialog());

$("faqList").addEventListener("click", async (event) => {
  const edit = event.target.closest("[data-edit-faq]");
  if (edit) return openFaqDialog({ faq: chatState.faqs.find(f => String(f.faq_id) === edit.dataset.editFaq) });
  const del = event.target.closest("[data-delete-faq]");
  if (!del) return;
  const faq = chatState.faqs.find(f => String(f.faq_id) === del.dataset.deleteFaq);
  if (!confirm(`Delete this FAQ?\n\n“${faq.question}”\n\nThe assistant stops using it right away. To keep it for later, edit it and untick Active instead.`)) return;
  try {
    await apiFetch(`/v1/admin/faqs/${faq.faq_id}`, { method: "DELETE" });
    toast("FAQ deleted.", "success");
    await Promise.all([loadFaqs(), loadSummary()]);
  } catch (err) {
    toast(err.message, "error");
  }
});

/* ---------------------------------------------------------------------
   QUEUE ACTIONS
   --------------------------------------------------------------------- */
$("queue").addEventListener("click", async (event) => {
  const toFaq = event.target.closest("[data-to-faq]");
  if (toFaq) return openFaqDialog({ source: chatState.queue.find(l => String(l.chat_id) === toFaq.dataset.toFaq) });
  const convo = event.target.closest("[data-convo]");
  if (convo) return openConversation(convo.dataset.convo);
  const dismiss = event.target.closest("[data-dismiss]");
  if (!dismiss) return;
  dismiss.disabled = true;
  try {
    await apiFetch(`/v1/admin/chat/logs/${dismiss.dataset.dismiss}`, { method: "PATCH", body: JSON.stringify({ resolved: true }) });
    toast("Marked as handled.", "success");
    await Promise.all([loadQueue(), loadSummary()]);
  } catch (err) {
    dismiss.disabled = false;
    toast(err.message, "error");
  }
});

/* ---------------------------------------------------------------------
   CONVERSATION HISTORY
   --------------------------------------------------------------------- */
function logItem(l) {
  return `
    <article class="chat-item">
      <div class="chat-item__meta">${reasonBadge(l)}<span>${formatDateTime(l.created_at)} · ${who(l)}${fromPage(l)}</span>
        ${l.tools.filter(t => t !== "mark_unanswered").length ? `<span class="muted">checked: ${l.tools.filter(t => t !== "mark_unanswered").map(t => t.replace(/_/g, " ")).join(", ")}</span>` : ""}</div>
      <p class="chat-item__q">${escapeHTML(l.message)}</p>
      <div class="chat-item__a">${chatTextHTML(l.reply)}</div>
      <div class="row chat-item__actions">
        <button class="btn btn--secondary btn--sm" type="button" data-convo="${escapeHTML(l.session_id)}">${icon("messages-square", { size: 16 })} View conversation${l.session_messages > 1 ? ` (${l.session_messages})` : ""}</button>
        ${l.answered ? "" : `<button class="btn btn--ghost btn--sm" type="button" data-to-faq="${l.chat_id}">${icon("book-open", { size: 16 })} Turn into FAQ</button>`}
      </div>
    </article>`;
}

function historyQuery(before) {
  const p = new URLSearchParams({ view: $("fView").value, customer: $("fCustomer").value, days: $("fDays").value, limit: "30" });
  if ($("fQ").value.trim()) p.set("q", $("fQ").value.trim());
  if (before) p.set("before", before);
  return `/v1/admin/chat/logs?${p}`;
}

async function loadHistory({ more = false } = {}) {
  if (!more) $("logList").innerHTML = `<div class="card__body"><span class="skeleton skeleton--text"></span><span class="skeleton skeleton--text skeleton--short"></span></div>`;
  try {
    const last = chatState.logs[chatState.logs.length - 1];
    const { logs, has_more: hasMore } = await apiFetch(historyQuery(more && last ? last.chat_id : null));
    chatState.logs = more ? chatState.logs.concat(logs) : logs;
    chatState.hasMore = hasMore;
    $("logList").innerHTML = chatState.logs.length ? chatState.logs.map(logItem).join("")
      : UIState.empty({ icon: "messages-square", title: "No messages match", text: "Try another period or clear the search." });
    $("moreWrap").hidden = !hasMore;
  } catch (err) {
    $("logList").innerHTML = UIState.error(err.message, "retryHistory");
    $("retryHistory")?.addEventListener("click", () => loadHistory());
  }
}

let searchTimer = null;
$("filters").addEventListener("submit", (e) => { e.preventDefault(); loadHistory(); });
$("filters").addEventListener("change", () => loadHistory());
$("fQ").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadHistory(), 350); });
$("loadMore").addEventListener("click", () => loadHistory({ more: true }));
$("logList").addEventListener("click", (event) => {
  const convo = event.target.closest("[data-convo]");
  if (convo) return openConversation(convo.dataset.convo);
  const toFaq = event.target.closest("[data-to-faq]");
  if (toFaq) openFaqDialog({ source: chatState.logs.find(l => String(l.chat_id) === toFaq.dataset.toFaq) });
});

async function openConversation(sessionId) {
  $("convoMeta").textContent = "Loading…";
  $("convoLog").innerHTML = "";
  $("convoDialog").showModal();
  try {
    const { messages } = await apiFetch(`/v1/admin/chat/sessions/${encodeURIComponent(sessionId)}`);
    const first = messages[0];
    $("convoMeta").innerHTML = `${who(first)} · ${formatDateTime(first.created_at)} · ${messages.length} message${messages.length === 1 ? "" : "s"}${fromPage(first)}`;
    $("convoLog").innerHTML = messages.map(m => `
      <div class="chat-msg chat-msg--user"><span class="sr-only">Customer: </span><p>${escapeHTML(m.message).replace(/\n/g, "<br>")}</p></div>
      <div class="chat-msg chat-msg--bot"><span class="sr-only">Assistant: </span>${chatTextHTML(m.reply)}
        <div class="convo-meta">${reasonBadge(m)}<span>${formatDateTime(m.created_at)}</span></div></div>`).join("");
  } catch (err) {
    $("convoMeta").textContent = "";
    $("convoLog").innerHTML = UIState.error(err.message);
  }
}

document.querySelectorAll("dialog [data-close]").forEach(b => b.addEventListener("click", () => b.closest("dialog").close()));

if (requireAdminPage()) {
  loadSummary();
  loadQueue();
  loadFaqs();
  loadHistory();
}
