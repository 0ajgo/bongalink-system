/* =====================================================================
   BONGALINK — ADMIN SHIPPING RATES (Pages/Admin/rates.html)
   Requires api.js, icons.js, cart.js and ui.js.
     GET    /api/v1/admin/shipping-rates      rate card + last updated per courier
     POST   /api/v1/admin/shipping-rates      add a bracket
     PATCH  /api/v1/admin/shipping-rates/:id  edit a bracket
     DELETE /api/v1/admin/shipping-rates/:id  delete a bracket
   ===================================================================== */

renderHeader({ active: "rates" });

const COURIERS = [["JNT", "J&T Express"], ["LBC", "LBC Express"]];
const ZONES = [["NCR", "Metro Manila"], ["LUZON", "Luzon"], ["VISAYAS", "Visayas"], ["MINDANAO", "Mindanao"], ["ISLAND_PROVINCE", "Island provinces"]];
const zoneName = Object.fromEntries(ZONES);
const cards = document.getElementById("rateCards");
let data = null;

function rowMarkup(r, firstOfZone) {
  return `
    <tr data-rate="${r.rate_id}">
      <td>${firstOfZone ? `<strong>${zoneName[r.zone]}</strong>` : ""}</td>
      <td class="num"><label class="sr-only" for="w-${r.rate_id}">Up to (kg)</label>
        <input class="input input--sm" id="w-${r.rate_id}" type="number" min="0.01" step="0.01" value="${r.max_weight_kg}" data-field="max_weight_kg"></td>
      <td class="num"><label class="sr-only" for="f-${r.rate_id}">Fee (₱)</label>
        <input class="input input--sm" id="f-${r.rate_id}" type="number" min="0" step="0.01" value="${r.fee}" data-field="fee"></td>
      <td class="actions">
        <button class="btn btn--primary btn--sm" type="button" data-save="${r.rate_id}" disabled>Save</button>
        <button class="btn btn--danger btn--sm" type="button" data-delete="${r.rate_id}">${icon("trash-2", { size: 14, label: "Delete bracket" })}</button>
      </td>
    </tr>`;
}

function courierCard([code, label]) {
  const rows = data.rates.filter(r => r.courier === code);
  let lastZone = null;
  const body = rows.map(r => { const html = rowMarkup(r, r.zone !== lastZone); lastZone = r.zone; return html; }).join("");
  const missing = ZONES.filter(([z]) => !rows.some(r => r.zone === z)).map(([, n]) => n);
  return `
    <section class="card section-card" aria-labelledby="title-${code}">
      <div class="card__header">
        <h2 id="title-${code}">${label}</h2>
        <span class="muted">Last updated ${data.last_updated[code] ? formatDateTime(data.last_updated[code]) : "never"}</span>
      </div>
      ${missing.length ? `<div class="card__body"><div class="alert alert--warning">${icon("triangle-alert", { size: 18 })}
        <span>No rates for ${missing.join(", ")} — ${label} won't be offered there.</span></div></div>` : ""}
      <div class="table-wrap">
        <table class="table table--compact">
          <thead><tr><th>Zone</th><th class="num">Up to (kg)</th><th class="num">Fee (₱)</th><th></th></tr></thead>
          <tbody>${body || `<tr><td colspan="4">${UIState.empty({ icon: "truck", title: "No rates yet" })}</td></tr>`}</tbody>
        </table>
      </div>
      <form class="card__footer ship-actions" data-add="${code}" novalidate>
        <div class="field">
          <label class="label" for="z-${code}">Zone</label>
          <select class="select" id="z-${code}" name="zone">${ZONES.map(([z, n]) => `<option value="${z}">${n}</option>`).join("")}</select>
        </div>
        <div class="field">
          <label class="label" for="nw-${code}">Up to (kg)</label>
          <input class="input fee" id="nw-${code}" name="max_weight_kg" type="number" min="0.01" step="0.01" required>
        </div>
        <div class="field">
          <label class="label" for="nf-${code}">Fee (₱)</label>
          <input class="input fee" id="nf-${code}" name="fee" type="number" min="0" step="0.01" required>
        </div>
        <button class="btn btn--secondary" type="submit">${icon("plus", { size: 16 })} Add bracket</button>
      </form>
    </section>`;
}

function render() {
  cards.innerHTML = COURIERS.map(courierCard).join("");
}

async function act(button, work, message) {
  button.disabled = true;
  button.classList.add("is-loading");
  try {
    data = await work();
    render();
    toast(message, "success");
  } catch (err) {
    toast(err.message, "error");
    button.disabled = false;
    button.classList.remove("is-loading");
  }
}

cards.addEventListener("input", (event) => {
  const row = event.target.closest("tr[data-rate]");
  if (row && event.target.dataset.field) row.querySelector("[data-save]").disabled = false;
});

cards.addEventListener("click", (event) => {
  const save = event.target.closest("[data-save]");
  if (save) {
    const row = save.closest("tr");
    const body = {
      max_weight_kg: row.querySelector('[data-field="max_weight_kg"]').value,
      fee: row.querySelector('[data-field="fee"]').value
    };
    return act(save, () => apiFetch(`/v1/admin/shipping-rates/${save.dataset.save}`, { method: "PATCH", body: JSON.stringify(body) }), "Rate saved.");
  }
  const del = event.target.closest("[data-delete]");
  if (del && confirm("Delete this weight bracket?")) {
    act(del, () => apiFetch(`/v1/admin/shipping-rates/${del.dataset.delete}`, { method: "DELETE" }), "Bracket deleted.");
  }
});

cards.addEventListener("submit", (event) => {
  const form = event.target.closest("form[data-add]");
  if (!form) return;
  event.preventDefault();
  const body = {
    courier: form.dataset.add, zone: form.elements.zone.value,
    max_weight_kg: form.elements.max_weight_kg.value, fee: form.elements.fee.value
  };
  act(form.querySelector("button[type=submit]"),
    () => apiFetch("/v1/admin/shipping-rates", { method: "POST", body: JSON.stringify(body) }), "Bracket added.");
});

async function load() {
  cards.innerHTML = `<div class="card"><table class="table"><tbody>${UIState.rowSkeletons(4, 5)}</tbody></table></div>`;
  try {
    data = await apiFetch("/v1/admin/shipping-rates");
    render();
  } catch (err) {
    cards.innerHTML = `<div class="card">${UIState.error(err.message, "retryRates")}</div>`;
    document.getElementById("retryRates").addEventListener("click", load);
  }
}

if (requireAdminPage()) load();
