import {
  PDFDocument,
  PDFTextField,
  PDFCheckBox,
  PDFRadioGroup,
  PDFDropdown,
  PDFOptionList,
} from "./vendor/pdf-lib.esm.min.js";

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
  return div.innerHTML;
}

// Field name -> a DOM-safe id (names can contain dots, spaces, brackets).
function fieldInputId(index) {
  return `fillField-${index}`;
}

function classifyField(field) {
  if (field instanceof PDFTextField) return { kind: "text", multiline: field.isMultiline() };
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
    <span class="handle">◆</span>
    <span class="name">${escapeHtml(loaded.file.name)} — ${loaded.pageCount} page${loaded.pageCount === 1 ? "" : "s"}</span>
    <span class="size">${formatSize(loaded.file.size)}</span>
  `;
  fileListEl.appendChild(li);
}

function renderFields() {
  fieldsContainer.innerHTML = "";
  if (!loaded) return;
  loaded.fields.forEach((f, index) => {
    const row = document.createElement("div");
    row.className = "split-range";
    const id = fieldInputId(index);

    if (f.kind === "text") {
      row.innerHTML = `
        <label for="${id}">${escapeHtml(f.name)}</label>
        ${
          f.multiline
            ? `<textarea id="${id}" rows="3" placeholder="(empty)"></textarea>`
            : `<input type="text" id="${id}" placeholder="(empty)" />`
        }
      `;
    } else if (f.kind === "checkbox") {
      row.innerHTML = `
        <label class="split-mode-option" for="${id}">
          <input type="checkbox" id="${id}" />
          ${escapeHtml(f.name)}
        </label>
      `;
    } else if (f.kind === "radio" || f.kind === "dropdown") {
      const options = (f.options || [])
        .map((opt) => `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`)
        .join("");
      row.innerHTML = `
        <label for="${id}">${escapeHtml(f.name)}</label>
        <select id="${id}"><option value="">(unset)</option>${options}</select>
      `;
    } else if (f.kind === "optionlist") {
      const options = (f.options || [])
        .map((opt) => `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`)
        .join("");
      row.innerHTML = `
        <label for="${id}">${escapeHtml(f.name)} (multi-select)</label>
        <select id="${id}" multiple size="${Math.min(4, Math.max(2, (f.options || []).length))}">${options}</select>
      `;
    } else {
      row.innerHTML = `
        <label>${escapeHtml(f.name)}</label>
        <span class="dropzone-hint">Button/signature field — not fillable as a value, skipped.</span>
      `;
    }
    fieldsContainer.appendChild(row);
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
  const bytes = await file.arrayBuffer();
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const form = doc.getForm();
  const fields = form.getFields().map((field) => ({
    name: field.getName(),
    ...classifyField(field),
  }));
  loaded = { file, pageCount: doc.getPageCount(), fields };
  renderFile();
  renderFields();
  updateActions();
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
  const doc = await PDFDocument.load(await loaded.file.arrayBuffer(), { ignoreEncryption: true });
  const form = doc.getForm();
  let filledCount = 0;

  loaded.fields.forEach((f, index) => {
    const id = fieldInputId(index);
    const el = document.getElementById(id);
    if (!el) return;
    const field = form.getField(f.name);

    if (f.kind === "text") {
      const value = el.value;
      if (value.trim() === "") return;
      field.setText(value);
      filledCount++;
    } else if (f.kind === "checkbox") {
      if (el.checked) field.check();
      else field.uncheck();
      filledCount++;
    } else if (f.kind === "radio" || f.kind === "dropdown") {
      if (!el.value) return;
      field.select(el.value);
      filledCount++;
    } else if (f.kind === "optionlist") {
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
    const elapsedMs = Math.round(performance.now() - startedAt);
    const requestsDuring = requestsSinceLoad - requestsBefore;

    resultEl.hidden = false;
    resultEl.className = "result";
    resultEl.innerHTML = `
      <span><strong>Done.</strong> ${filledCount} field${filledCount === 1 ? "" : "s"} filled —
      ${elapsedMs}ms, ${requestsDuring} network requests, entirely on this device.</span>
      <a class="btn btn-primary" href="${url}" download="${fileName}">Download ${fileName}</a>
    `;
  } catch (err) {
    resultEl.hidden = false;
    resultEl.className = "result result-error";
    resultEl.innerHTML = `<span><strong>Fill failed.</strong> ${escapeHtml(
      err instanceof Error ? err.message : "This file may be corrupted or password-protected."
    )}</span>`;
  } finally {
    fillBtn.disabled = false;
    fillBtnLabel.textContent = originalLabel;
  }
});

const proForm = document.getElementById("proForm");
const proNote = document.getElementById("proNote");
proForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("proEmail").value.trim();
  if (!email) return;
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
