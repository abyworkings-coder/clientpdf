let _pdfLibPromise = null;
function getPdfLib() {
  if (!_pdfLibPromise) _pdfLibPromise = import("./vendor/pdf-lib.esm.min.js");
  return _pdfLibPromise;
}

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const fileListEl = document.getElementById("fileList");
const actionsEl = document.getElementById("actions");
const fillBtn = document.getElementById("fillBtn");
const fillBtnLabel = document.getElementById("fillBtnLabel");
const clearBtn = document.getElementById("clearBtn");
const resultEl = document.getElementById("result");
const fillPanel = document.getElementById("fillPanel");
const fillMeta = document.getElementById("fillMeta");
const fieldsContainer = document.getElementById("fieldsContainer");

/** @type {{file: File, pageCount: number, fields: Array<{name: string, kind: string, options?: string[]}>} | null} */
let loaded = null;

// Live, honest proof: count real network requests made after page load.
const proofLiveText = document.getElementById("proofLiveText");
let requestsSinceLoad = 0;
if ("PerformanceObserver" in window) {
  try {
    new PerformanceObserver((list) => {
      requestsSinceLoad += list.getEntries().length;
      if (proofLiveText) {
        proofLiveText.textContent = `${requestsSinceLoad} network request${
          requestsSinceLoad === 1 ? "" : "s"
        } since page load · verified live, not our word for it`;
      }
    }).observe({ type: "resource", buffered: false });
  } catch (e) {
    // observer unsupported — static claim stays as-is
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Field name -> a DOM-safe id (names can contain dots, spaces, brackets).
function fieldInputId(index) {
  return `fillField-${index}`;
}

function classifyField(field, { PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList }) {
  if (field instanceof PDFTextField)
    return { kind: "text", multiline: field.isMultiline(), maxLength: field.getMaxLength() };
  if (field instanceof PDFCheckBox) return { kind: "checkbox" };
  if (field instanceof PDFRadioGroup) return { kind: "radio", options: field.getOptions() };
  if (field instanceof PDFDropdown) return { kind: "dropdown", options: field.getOptions() };
  if (field instanceof PDFOptionList) return { kind: "optionlist", options: field.getOptions() };
  return { kind: "unsupported" };
}

function renderFile() {
  fileListEl.innerHTML = "";
  if (!loaded) return;
  const li = document.createElement("li");
  li.className = "file-row";
  li.innerHTML = `
    <span class="handle" aria-hidden="true">◆</span>
    <span class="name">${escapeHtml(loaded.file.name)} — ${loaded.pageCount} page${loaded.pageCount === 1 ? "" : "s"}</span>
    <span class="size">${formatSize(loaded.file.size)}</span>
  `;
  fileListEl.appendChild(li);
}

function renderFields() {
  fieldsContainer.innerHTML = "";
  if (!loaded) return;

  const fillableFields = loaded.fields.filter((f) => f.kind !== "unsupported");
  if (fillableFields.length === 0) {
    const empty = document.createElement("p");
    empty.className = "field-empty";
    empty.textContent = "No fillable form fields detected in this PDF.";
    fieldsContainer.appendChild(empty);
    return;
  }

  loaded.fields.forEach((f, index) => {
    const id = fieldInputId(index);

    if (f.kind === "text") {
      const row = document.createElement("div");
      row.className = "field-row";
      const maxLengthAttr = f.maxLength !== undefined ? ` maxlength="${f.maxLength}"` : "";
      row.innerHTML = `
        <label for="${id}">${escapeHtml(f.name)}</label>
        ${
          f.multiline
            ? `<textarea id="${id}" rows="3" placeholder="(empty)"${maxLengthAttr}></textarea>`
            : `<input type="text" id="${id}" placeholder="(empty)"${maxLengthAttr} />`
        }
      `;
      fieldsContainer.appendChild(row);
    } else if (f.kind === "checkbox") {
      const label = document.createElement("label");
      label.className = "field-check";
      label.setAttribute("for", id);
      label.innerHTML = `<input type="checkbox" id="${id}" /> ${escapeHtml(f.name)}`;
      fieldsContainer.appendChild(label);
    } else if (f.kind === "radio") {
      const row = document.createElement("div");
      row.className = "field-row";
      const options = (f.options || [])
        .map((opt, optIndex) => {
          const optId = `${id}-${optIndex}`;
          return `
            <label>
              <input type="radio" name="${id}" id="${optId}" value="${escapeHtml(opt)}" />
              ${escapeHtml(opt)}
            </label>
          `;
        })
        .join("");
      row.innerHTML = `
        <label>${escapeHtml(f.name)}</label>
        <div class="field-radio-group" role="radiogroup" aria-label="${escapeHtml(f.name)}">${options}</div>
      `;
      fieldsContainer.appendChild(row);
    } else if (f.kind === "dropdown") {
      const row = document.createElement("div");
      row.className = "field-row";
      const options = (f.options || [])
        .map((opt) => `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`)
        .join("");
      row.innerHTML = `
        <label for="${id}">${escapeHtml(f.name)}</label>
        <select id="${id}"><option value="">(unset)</option>${options}</select>
      `;
      fieldsContainer.appendChild(row);
    } else if (f.kind === "optionlist") {
      const row = document.createElement("div");
      row.className = "field-row";
      const options = (f.options || [])
        .map((opt) => `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`)
        .join("");
      row.innerHTML = `
        <label for="${id}">${escapeHtml(f.name)} (multi-select)</label>
        <select id="${id}" multiple size="${Math.min(4, Math.max(2, (f.options || []).length))}">${options}</select>
      `;
      fieldsContainer.appendChild(row);
    } else {
      const row = document.createElement("div");
      row.className = "field-row";
      row.innerHTML = `
        <label>${escapeHtml(f.name)}</label>
        <span class="field-empty">Button/signature field — not fillable as a value, skipped.</span>
      `;
      fieldsContainer.appendChild(row);
    }
  });
}

function updateActions() {
  actionsEl.hidden = !loaded;
  fillPanel.hidden = !loaded;
  resultEl.hidden = true;
  if (!loaded) return;
  const fillableCount = loaded.fields.filter((f) => f.kind !== "unsupported").length;
  const fieldText =
    fillableCount === 0
      ? "no fillable form fields detected"
      : `${fillableCount} form field${fillableCount === 1 ? "" : "s"} detected`;
  fillMeta.textContent = `${loaded.pageCount} page${loaded.pageCount === 1 ? "" : "s"} · ${fieldText}`;
  fillBtn.disabled = fillableCount === 0;
}

async function loadFile(file) {
  try {
    const pdfLib = await getPdfLib();
    const { PDFDocument } = pdfLib;
    const bytes = await file.arrayBuffer();
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const form = doc.getForm();
    const fields = form.getFields().map((field) => ({
      name: field.getName(),
      ...classifyField(field, pdfLib),
    }));
    loaded = { file, pageCount: doc.getPageCount(), fields };
    renderFile();
    renderFields();
    updateActions();
  } catch (err) {
    loaded = null;
    fileInput.value = "";
    renderFile();
    renderFields();
    updateActions();
    resultEl.hidden = false;
    resultEl.className = "result result-error";
    resultEl.setAttribute("role", "alert");
    resultEl.setAttribute("aria-live", "assertive");
    resultEl.innerHTML = `<span><strong>Couldn't load file.</strong> ${escapeHtml(
      "This file may be corrupted or password-protected."
    )}</span>`;
  }
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) loadFile(file);
});

["dragenter", "dragover"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  })
);
dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});

clearBtn.addEventListener("click", () => {
  loaded = null;
  fileInput.value = "";
  renderFile();
  renderFields();
  updateActions();
});

function baseName(fileName) {
  return fileName.replace(/\.pdf$/i, "");
}

async function fillForm() {
  const { PDFDocument } = await getPdfLib();
  const doc = await PDFDocument.load(await loaded.file.arrayBuffer(), { ignoreEncryption: true });
  const form = doc.getForm();
  let filledCount = 0;

  loaded.fields.forEach((f, index) => {
    const id = fieldInputId(index);
    const field = form.getField(f.name);

    if (f.kind === "text") {
      const el = document.getElementById(id);
      if (!el) return;
      const value = el.value;
      if (value.trim() === "") return;
      field.setText(value);
      filledCount++;
    } else if (f.kind === "checkbox") {
      const el = document.getElementById(id);
      if (!el) return;
      if (el.checked) field.check();
      else field.uncheck();
      filledCount++;
    } else if (f.kind === "radio") {
      const checked = document.querySelector(`input[name="${id}"]:checked`);
      if (!checked) return;
      field.select(checked.value);
      filledCount++;
    } else if (f.kind === "dropdown") {
      const el = document.getElementById(id);
      if (!el || !el.value) return;
      field.select(el.value);
      filledCount++;
    } else if (f.kind === "optionlist") {
      const el = document.getElementById(id);
      if (!el) return;
      const selected = Array.from(el.selectedOptions).map((o) => o.value);
      if (selected.length === 0) return;
      field.select(selected);
      filledCount++;
    }
  });

  const bytes = await doc.save();
  return {
    blob: new Blob([bytes], { type: "application/pdf" }),
    fileName: `${baseName(loaded.file.name)}-filled.pdf`,
    filledCount,
  };
}

fillBtn.addEventListener("click", async () => {
  fillBtn.disabled = true;
  const originalLabel = fillBtnLabel.textContent;
  fillBtnLabel.textContent = "Filling…";
  resultEl.hidden = true;

  const startedAt = performance.now();
  const requestsBefore = requestsSinceLoad;

  try {
    const { blob, fileName, filledCount } = await fillForm();
    const url = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    const elapsedMs = Math.round(performance.now() - startedAt);
    const requestsDuring = requestsSinceLoad - requestsBefore;

    resultEl.hidden = false;
    resultEl.className = "result";
    resultEl.setAttribute("role", "status");
    resultEl.setAttribute("aria-live", "polite");
    resultEl.innerHTML = `
      <span><strong>Done.</strong> ${filledCount} field${filledCount === 1 ? "" : "s"} filled —
      ${elapsedMs}ms, ${requestsDuring} network requests, entirely on this device.</span>
      <a class="btn btn-primary" href="${url}" download="${escapeHtml(fileName)}">Download ${escapeHtml(fileName)}</a>
    `;
  } catch (err) {
    resultEl.hidden = false;
    resultEl.className = "result result-error";
    resultEl.setAttribute("role", "alert");
    resultEl.setAttribute("aria-live", "assertive");
    resultEl.innerHTML = `<span><strong>Fill failed.</strong> ${escapeHtml(
      "This file may be corrupted or password-protected."
    )}</span>`;
  } finally {
    fillBtn.disabled = false;
    fillBtn.focus();
    fillBtnLabel.textContent = originalLabel;
  }
});

const proForm = document.getElementById("proForm");
const proNote = document.getElementById("proNote");
proForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("proEmail").value.trim();
  if (!email) return;
  const proSubmitBtn = proForm.querySelector('button[type="submit"]');
  proSubmitBtn.disabled = true;
  // Keep a local copy so the signal is not lost if the network request fails.
  const saved = JSON.parse(localStorage.getItem("clientpdf_waitlist") || "[]");
  saved.push({ email, at: new Date().toISOString() });
  localStorage.setItem("clientpdf_waitlist", JSON.stringify(saved));
  try {
    await fetch("https://formsubmit.co/ajax/analytics@antikode.com", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        email,
        _subject: "ClientPDF Pro waitlist signup",
        source: location.pathname,
      }),
    });
  } catch (err) {
    // Local copy above already preserves the signup even if this fails.
  }
  proForm.hidden = true;
  proNote.hidden = false;
});
