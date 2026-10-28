/* =====================================================================
   product-editor.js — admin "Edit part" dialog (on Pages/Admin/inventory.html)
   Requires api.js, icons.js, ui.js and the #editDialog markup.

     openProductEditor(productId, { onChange })   onChange() runs after every save

   Sections: Details (name, brand, category, price, weight, description,
   shown/hidden), Photos (cover + gallery), Stock (change with a reason,
   never below reserved) and History (who changed what, when).
   The server validates everything; checks here are for quick feedback.
   ===================================================================== */

const PE = {
  dialog: document.getElementById("editDialog"),
  product: null,
  categories: [],
  onChange: () => {}
};
const pe$ = (id) => document.getElementById(id);

const FIELD_LABEL = {
  created: "Created", name: "Name", brand: "Brand", description: "Description", category: "Category",
  price: "Price", stock: "Stock on hand", weight: "Weight (kg)", image: "Cover photo", active: "Shown in shop",
  photo_added: "Photo added", photo_removed: "Photo removed"
};
const REASON_HELP = {
  restock: "Units added from a delivery.", return: "A customer returned units to stock.",
  damaged: "Units removed because they're damaged or lost.", correction: "Fix a counting mistake (add or remove)."
};
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_PHOTO_MB = 5;

function peBusy(button, on) {
  button.disabled = on;
  button.classList.toggle("is-loading", on);
}

function peHistoryValue(field, value) {
  if (value === null || value === undefined || value === "") return `<span class="muted">—</span>`;
  if (field === "active") return value === "1" ? "Shown" : "Hidden";
  if (field === "price") return formatMoney(value);
  if (["image", "photo_added", "photo_removed"].includes(field)) {
    return `<a href="${escapeHTML(imageUrl(value))}" target="_blank" rel="noopener">view photo</a>`;
  }
  const text = String(value);
  return escapeHTML(text.length > 80 ? `${text.slice(0, 80)}…` : text);
}

/* ---------------------------------------------------------------- render */
function peRenderEditor() {
  const p = PE.product;
  pe$("editTitle").textContent = `Edit ${p.name}`;
  pe$("editStatus").className = `badge ${p.is_active ? "badge--success" : ""}`;
  pe$("editStatus").textContent = p.is_active ? "Shown in shop" : "Hidden";
  pe$("editViewLink").hidden = !p.is_active;
  pe$("editViewLink").href = productUrl(p.id);

  const f = pe$("editForm").elements;
  f.name.value = p.name;
  f.brand.value = p.brand || "";
  f.category.innerHTML = PE.categories.map(c => `<option${c.name === p.category ? " selected" : ""}>${escapeHTML(c.name)}</option>`).join("");
  f.price.value = Number(p.price);
  f.weight_kg.value = Number(p.weight_kg);
  f.description.value = p.description || "";
  f.is_active.checked = Boolean(p.is_active);
  pe$("editError").textContent = "";

  pe$("coverPreview").innerHTML = p.image ? `<img src="${escapeHTML(imageUrl(p.image))}" alt="Current cover photo">` : icon("package", { size: 40 });
  pe$("gallery").innerHTML = p.gallery.map(g => `
    <div class="photo-tile frame">
      <img src="${escapeHTML(imageUrl(g.image_path))}" alt="">
      <button class="btn btn--danger btn--sm btn--icon" type="button" data-remove-photo="${g.image_id}">${icon("trash-2", { size: 14, label: "Remove photo" })}</button>
    </div>`).join("") || `<p class="muted">No extra photos.</p>`;

  pe$("stockOnHand").textContent = p.stock_quantity;
  pe$("stockReserved").textContent = p.reserved;
  pe$("stockAvailable").textContent = p.available;
  peClearStockErrors();
}

async function peLoadHistory() {
  const body = pe$("historyRows");
  body.innerHTML = UIState.rowSkeletons(5, 3);
  try {
    const rows = await apiFetch(`/products/${PE.product.id}/history`);
    body.innerHTML = rows.length ? rows.map(h => `
      <tr>
        <td>${formatDateTime(h.changed_at)}</td>
        <td>${escapeHTML(h.changed_by)}</td>
        <td>${escapeHTML(FIELD_LABEL[h.field] || h.field)}</td>
        <td>${h.field === "created" ? "" : peHistoryValue(h.field, h.old_value)}</td>
        <td>${peHistoryValue(h.field, h.new_value)}</td>
        <td>${h.reason ? escapeHTML(h.reason) : `<span class="muted">—</span>`}</td>
      </tr>`).join("")
      : `<tr><td colspan="6">${UIState.empty({ icon: "clipboard-list", title: "No changes recorded yet" })}</td></tr>`;
  } catch (err) {
    body.innerHTML = `<tr><td colspan="6">${UIState.error(err.message)}</td></tr>`;
  }
}

async function peRefreshProduct() {
  PE.product = await apiFetch(`/products/${PE.product.id}/admin`);
  peRenderEditor();
  peLoadHistory();
  PE.onChange();
}

/* ---------------------------------------------------------------- open */
async function openProductEditor(productId, { onChange = () => {} } = {}) {
  PE.onChange = onChange;
  PE.dialog.showModal();
  pe$("editBody").hidden = true;
  pe$("editLoading").hidden = false;
  pe$("editLoading").innerHTML = `<span class="skeleton skeleton--title"></span><span class="skeleton skeleton--text"></span>`;
  try {
    const [product, categories] = await Promise.all([
      apiFetch(`/products/${productId}/admin`),
      PE.categories.length ? PE.categories : apiFetch("/categories")
    ]);
    PE.product = product;
    PE.categories = categories;
  } catch (err) {
    pe$("editLoading").innerHTML = err.status === 404
      ? UIState.empty({ icon: "package-open", title: "Part not found" })
      : UIState.error(err.message);
    return;
  }
  pe$("editLoading").hidden = true;
  pe$("editBody").hidden = false;
  ["coverFile", "galleryFile"].forEach(id => { pe$(id).value = ""; });
  ["coverUpload", "galleryUpload"].forEach(id => { pe$(id).hidden = true; });
  pe$("stockForm").reset();
  peUpdateReasonHelp();
  peRenderEditor();
  peLoadHistory();
}

PE.dialog.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => PE.dialog.close()));

/* ---------------------------------------------------------------- details */
pe$("editForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const f = event.target.elements;
  const p = PE.product;
  const price = Number(f.price.value), weight = Number(f.weight_kg.value);
  if (!f.name.value.trim()) return (pe$("editError").textContent = "Product name is required.");
  if (!(price > 0)) return (pe$("editError").textContent = "Price must be more than ₱0.");
  if (!(weight > 0)) return (pe$("editError").textContent = "Weight must be more than 0 kg.");

  // Send only what changed, so the history shows real changes.
  const next = { name: f.name.value.trim(), brand: f.brand.value.trim(), category: f.category.value, price,
                 weight_kg: weight, description: f.description.value.trim(), is_active: f.is_active.checked };
  const before = { name: p.name, brand: p.brand || "", category: p.category, price: Number(p.price),
                   weight_kg: Number(p.weight_kg), description: p.description || "", is_active: Boolean(p.is_active) };
  const body = Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== before[k]));
  if (!Object.keys(body).length) return toast("Nothing changed.", "info");
  if (body.is_active === false && !confirm(`Hide "${p.name}"? It leaves the shop and customers' carts. You can show it again any time.`)) return;

  const button = pe$("editSave");
  peBusy(button, true);
  pe$("editError").textContent = "";
  try {
    await apiFetch(`/products/${p.id}`, { method: "PATCH", body: JSON.stringify(body) });
    toast("Product saved.", "success");
    await peRefreshProduct();
  } catch (err) {
    pe$("editError").textContent = err.message;
  } finally {
    peBusy(button, false);
  }
});

/* ---------------------------------------------------------------- photos */
function peWirePhotoPicker(inputId, previewId, uploadId, url, message) {
  const input = pe$(inputId);
  input.addEventListener("change", () => {
    const file = input.files[0];
    pe$(uploadId).hidden = true;
    if (!file) return;
    if (!IMAGE_TYPES.includes(file.type)) { input.value = ""; return toast("Photos must be JPEG, PNG, WebP or GIF.", "error"); }
    if (file.size > MAX_PHOTO_MB * 1024 * 1024) { input.value = ""; return toast(`Photos must be ${MAX_PHOTO_MB} MB or smaller.`, "error"); }
    const reader = new FileReader();
    reader.onload = (e) => { pe$(previewId).innerHTML = `<img src="${e.target.result}" alt="Preview of the new photo">`; };
    reader.readAsDataURL(file);
    pe$(uploadId).hidden = false;
  });
  pe$(uploadId).addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const form = new FormData();
    form.append("image", input.files[0]);
    peBusy(button, true);
    try {
      await apiFetch(url(), { method: "POST", body: form });
      input.value = "";
      button.hidden = true;
      toast(message, "success");
      await peRefreshProduct();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      peBusy(button, false);
    }
  });
}
peWirePhotoPicker("coverFile", "coverPreview", "coverUpload", () => `/products/${PE.product.id}/image`, "Cover photo saved.");
peWirePhotoPicker("galleryFile", "galleryNew", "galleryUpload", () => `/products/${PE.product.id}/images`, "Photo added.");

pe$("gallery").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-remove-photo]");
  if (!button || !confirm("Remove this photo from the product?")) return;
  peBusy(button, true);
  try {
    await apiFetch(`/products/${PE.product.id}/images/${button.dataset.removePhoto}`, { method: "DELETE" });
    toast("Photo removed.", "success");
    await peRefreshProduct();
  } catch (err) {
    toast(err.message, "error");
    peBusy(button, false);
  }
});

/* ---------------------------------------------------------------- stock */
function peUpdateReasonHelp() {
  const reason = pe$("stockForm").elements.reason.value;
  pe$("reasonHelp").textContent = REASON_HELP[reason] || "";
  // correction can go either way; the others have a fixed direction
  pe$("directionField").hidden = reason !== "correction";
}
// Errors sit next to the field they're about: Reason, or Units (amounts and
// "below reserved" from the server). The field is marked invalid until fixed.
function peFieldError(field, message) {
  const slot = pe$(field === "reason" ? "stockReasonError" : "stockError");
  const input = pe$("stockForm").elements[field];
  slot.textContent = message || "";
  if (message) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
}
function peClearStockErrors() {
  peFieldError("reason", "");
  peFieldError("quantity", "");
}

pe$("stockForm").elements.reason.addEventListener("change", () => { peFieldError("reason", ""); peUpdateReasonHelp(); });
pe$("stockForm").elements.quantity.addEventListener("input", () => peFieldError("quantity", ""));

pe$("stockForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const f = event.target.elements;
  const reason = f.reason.value;
  const qty = Number(f.quantity.value);
  peClearStockErrors();
  let firstBad = null;
  if (!reason) { peFieldError("reason", "Choose a reason for this change."); firstBad = f.reason; }
  if (!Number.isInteger(qty) || qty <= 0) { peFieldError("quantity", "Enter how many units (a whole number above 0)."); firstBad ??= f.quantity; }
  if (firstBad) return firstBad.focus();
  const sign = reason === "damaged" || (reason === "correction" && f.direction.value === "remove") ? -1 : 1;
  const change = sign * qty;
  if (PE.product.stock_quantity + change < PE.product.reserved) {
    const removable = Math.max(PE.product.stock_quantity - PE.product.reserved, 0);
    peFieldError("quantity", `You can remove at most ${removable}: ${PE.product.reserved} are held by unpaid orders.`);
    return f.quantity.focus();
  }
  const button = pe$("stockSave");
  peBusy(button, true);
  try {
    await apiFetch(`/products/${PE.product.id}/stock`, {
      method: "POST", body: JSON.stringify({ change, reason, note: f.note.value.trim() || undefined })
    });
    event.target.reset();
    peUpdateReasonHelp();
    toast(`Stock ${change > 0 ? "increased" : "reduced"} by ${Math.abs(change)}.`, "success");
    await peRefreshProduct();
  } catch (err) {
    // Server answers are about the amount (sign rules, below reserved) unless they name the reason.
    peFieldError(/reason/i.test(err.message) ? "reason" : "quantity", err.message);
  } finally {
    peBusy(button, false);
  }
});
