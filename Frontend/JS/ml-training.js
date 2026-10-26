/* "Update forecasts & trends" panel: full on Inventory (with the run
   history), compact on the Dashboard. Requires api.js, icons.js and ui.js.
   Polls for progress (every 3 s while a run is queued or training, every
   30 s otherwise) and calls onFinished(run) when a run ends.

   MLTraining.mount(element, { compact, onFinished }) */

const MLTraining = (() => {
  const FAST_MS = 3000;
  const SLOW_MS = 30000;

  const STEPS = ["queued", "training", "done"];
  const STEP_LABEL = { queued: "Queued", training: "Training", done: "Done", failed: "Failed" };
  const OUTCOME = {
    promoted: ["New model in use", "success"],
    rejected: ["Kept the current model (new one was less accurate)", "info"],
    skipped: ["Skipped: not enough sales history yet", "warning"],
    failed: ["Failed: kept the current model", "error"],
  };
  const TRIGGER = {
    manual: (r) => `${escapeHTML(r.requested_by || "An admin")} (button)`,
    nightly: () => "Nightly schedule",
    new_data: (r) => `New data: ${escapeHTML(r.trigger_detail || "")}`,
    command_line: () => "Command line",
  };

  const num = (n) => Number(n).toLocaleString("en-PH");
  const units = (v, digits = 2) => (v === null || v === undefined ? "—" : Number(v).toFixed(digits));
  function ago(value) {
    if (!value) return "";
    const s = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
    if (s < 60) return `${s} s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    const days = Math.round(s / 86400);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }

  function mount(root, { compact = false, onFinished = () => {} } = {}) {
    let data = null;
    let watching = null;     // run_id being followed until it finishes
    let timer = null;
    let busy = false;

    root.classList.add("ml-training");
    if (compact) root.classList.add("ml-training--compact");

    function progressHTML(run) {
      const at = run.status === "failed" ? 2 : STEPS.indexOf(run.status);
      return `<ol class="ml-steps" aria-label="Progress">${STEPS.map((step, i) => {
        const label = i === 2 && run.status === "failed" ? STEP_LABEL.failed : STEP_LABEL[step];
        const state = i < at ? "done" : i === at ? "current" : "todo";
        return `<li class="ml-step ml-step--${state}${i === 2 && run.status === "failed" ? " ml-step--failed" : ""}"
                    ${i === at ? 'aria-current="step"' : ""}>${state === "current" && run.status !== "done" && run.status !== "failed"
                      ? `<span class="ml-spinner" aria-hidden="true"></span>` : ""}${label}</li>`;
      }).join("")}</ol>`;
    }

    function runningText(run) {
      const who = run.trigger_type === "manual" ? `by ${escapeHTML(run.requested_by || "an admin")}` : "automatically";
      if (run.status === "queued") {
        return data.worker_online
          ? `Queued ${who} ${ago(run.queued_at)}. The ML worker picks it up within a few seconds.`
          : `Queued ${who}. <strong>The ML worker isn't running</strong>, so it will start when the worker is back.`;
      }
      return `Training ${who}, started ${ago(run.started_at)}. This usually takes under a minute; you can keep working.`;
    }

    function accuracyHTML() {
      const r = data.last_completed;
      const m = data.model;
      if (!m) return `<span class="muted">No model yet</span>`;
      const mae = r && r.model_version === m.version ? r.val_mae : m.val_mae;
      if (mae === null || mae === undefined) return `<span class="muted">Not measured (initial model)</span>`;
      const naive = r && r.model_version === m.version ? r.naive_val_mae : null;
      const better = naive ? Math.round((1 - mae / naive) * 100) : null;
      return `Off by <strong>${units(mae)}</strong> units per part per week on average
        ${better !== null ? `<span class="muted">(${better >= 0 ? `${better}% better than` : `${-better}% worse than`} a simple average, ${units(naive)})</span>` : ""}`;
    }

    function dataHTML() {
      const r = data.last_completed;
      if (!r) return `<span class="muted">No training run recorded yet</span>`;
      return `${num(r.sales_records)} sales records from ${num(r.orders_used)} orders, ${num(r.products_used)} products
        <span class="muted">(${formatDate(r.data_from)} to ${formatDate(r.data_to)})</span>`;
    }

    function autoHTML() {
      const a = data.auto;
      const parts = [];
      if (a.nightly_hour !== null) parts.push(`nightly after ${String(a.nightly_hour).padStart(2, "0")}:00`);
      if (a.new_orders.threshold !== null) parts.push(`after ${num(a.new_orders.threshold)} new paid orders (${num(a.new_orders.since_last)} so far)`);
      if (a.stock_changes.threshold !== null) parts.push(`after ${num(a.stock_changes.threshold)} stock changes (${num(a.stock_changes.since_last)} so far)`);
      return parts.length ? `Also updates by itself: ${parts.join(" · ")}.` : "Automatic updates are off.";
    }

    function historyHTML() {
      if (!data.runs.length) return "";
      return `<details class="ml-history" open>
        <summary>Training history</summary>
        <div class="table-wrap"><table class="table table--compact">
          <thead><tr><th scope="col">When</th><th scope="col">Started by</th><th scope="col">Data used</th>
            <th scope="col" class="num">Avg. error</th><th scope="col">Result</th></tr></thead>
          <tbody>${data.runs.map((r) => {
            const [label, tone] = r.status === "queued" || r.status === "training"
              ? [STEP_LABEL[r.status], "info"] : (OUTCOME[r.outcome] || [r.status, ""]);
            return `<tr>
              <td>${formatDateTime(r.finished_at || r.started_at || r.queued_at)}</td>
              <td>${(TRIGGER[r.trigger_type] || (() => r.trigger_type))(r)}</td>
              <td>${r.sales_records !== null ? `${num(r.sales_records)} sales, ${num(r.products_used)} products` : `<span class="muted">—</span>`}</td>
              <td class="num">${units(r.val_mae, 3)}${r.baseline_val_mae !== null ? `<br><span class="muted">was ${units(r.baseline_val_mae, 3)}</span>` : ""}</td>
              <td><span class="badge${tone ? ` badge--${tone}` : ""}">${label}</span>
                ${r.message && (r.outcome === "failed" || r.outcome === "skipped") ? `<br><span class="muted ml-history__msg">${escapeHTML(r.message)}</span>` : ""}</td>
            </tr>`;
          }).join("")}</tbody></table></div>
      </details>`;
    }

    function render() {
      const run = data.current;
      const failed = !run && data.last_result && data.last_result.status === "failed";
      root.innerHTML = `
        <div class="ml-training__head">
          <div>
            <h2 class="ml-training__title" id="${root.id}-title">${compact ? "Forecasts & trends" : "Forecast model"}</h2>
            <p class="ml-training__updated">Last updated: <strong>${data.last_trained_at ? `${formatDateTime(data.last_trained_at)}` : "never"}</strong>
              ${data.last_trained_at ? `<span class="muted">(${ago(data.last_trained_at)})</span>` : ""}</p>
          </div>
          <button class="btn btn--primary" type="button" data-retrain ${run || busy ? "disabled" : ""}
                  aria-describedby="${root.id}-status">${icon("refresh-cw", { size: 18 })} Update forecasts &amp; trends</button>
        </div>
        <div class="ml-training__status" id="${root.id}-status" role="status" aria-live="polite">
          ${run ? `${progressHTML(run)}<p>${runningText(run)}</p>` : ""}
          ${failed ? `<div class="alert alert--error">${icon("circle-alert", { size: 18 })}<span><strong>The last update failed.</strong>
              ${escapeHTML(data.last_result.message)} The forecasts still use the previous model.</span></div>` : ""}
          ${!run && !data.worker_online ? `<div class="alert alert--warning">${icon("triangle-alert", { size: 18 })}<span>The ML worker isn't running.
              You can still ask for an update; it starts when the worker is back.</span></div>` : ""}
        </div>
        <dl class="ml-facts">
          <div><dt>Data used</dt><dd>${dataHTML()}</dd></div>
          <div><dt>Accuracy</dt><dd>${accuracyHTML()}</dd></div>
          ${compact ? "" : `<div><dt>Model</dt><dd>${data.model ? `${escapeHTML(data.model.version)} <span class="muted">${escapeHTML(data.model.trained_with)}</span>` : "—"}</dd></div>`}
        </dl>
        <p class="ml-training__auto muted">${autoHTML()}${compact ? ` <a href="inventory.html#modelTraining">Training history</a>` : ""}</p>
        ${compact ? "" : historyHTML()}`;
    }

    async function load() {
      clearTimeout(timer);
      try {
        data = await apiFetch("/admin/ml/training");
        // The run we were following has ended: tell the page and the admin.
        if (watching && (!data.current || data.current.run_id !== watching)) {
          const finished = data.runs.find((r) => r.run_id === watching);
          watching = null;
          if (finished) {
            const [label, tone] = OUTCOME[finished.outcome] || ["Finished", "info"];
            toast(`Forecast update: ${label}.`, tone === "error" ? "error" : "success");
            onFinished(finished);
          }
        }
        if (data.current) watching = data.current.run_id;
        render();
      } catch (err) {
        if (!data) root.innerHTML = UIState.error(err.message);
      }
      timer = setTimeout(load, data && data.current ? FAST_MS : SLOW_MS);
    }

    root.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-retrain]");
      if (!button || button.disabled) return;
      busy = true;
      button.disabled = true;
      button.classList.add("is-loading");
      try {
        const res = await apiFetch("/admin/ml/training", { method: "POST" });
        watching = res.run.run_id;
        toast(res.worker_online ? "Update queued. Training starts in a few seconds." : "Update queued. It starts when the ML worker is running.", "info");
      } catch (err) {
        toast(err.message, "error");
      } finally {
        busy = false;
        await load();
      }
    });

    load();
    return { reload: load, stop: () => clearTimeout(timer) };
  }

  return { mount };
})();
