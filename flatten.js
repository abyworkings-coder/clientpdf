let _pdfLibPromise = null;
function getPdfLib() {
  if (!_pdfLibPromise) _pdfLibPromise = import("./vendor/pdf-lib.esm.min.js");
  return _pdfLibPromise;
}

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const fileListEl = document.getElementById("fileList");
const actionsEl = document.getElementById("actions");
const flattenBtn = document.getElementById("flattenBtn");
const flattenBtnLabel = document.getElementById("flattenBtnLabel");
const clearBtn = document.getElementById("clearBtn");
const resultEl = document.getElementById("result");
const flattenPanel = document.getElementById("flattenPanel");
const flattenMeta = document.getElementById("flattenMeta");

/** @type {{file: File, pageCount: number, fieldCount: number} | null} */
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

function updateActions() {
  actionsEl.hidden = !loaded;
  flattenPanel.hidden = !loaded;
  resultEl.hidden = true;
  if (!loaded) return;
  const fieldText =
    loaded.fieldCount === 0
      ? "no fillable form fields detected"
      : `${loaded.fieldCount} form field${loaded.fieldCount === 1 ? "" : "s"} detected`;
  flattenMeta.textContent = `${loaded.pageCount} page${loaded.pageCount === 1 ? "" : "s"} · ${fieldText}`;
}

async function loadFile(file) {
  try {
    const { PDFDocument } = await getPdfLib();
    const bytes = await file.arrayBuffer();
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const form = doc.getForm();
    loaded = { file, pageCount: doc.getPageCount(), fieldCount: form.getFields().length };
    renderFile();
    updateActions();
  } catch (err) {
    loaded = null;
    fileInput.value = "";
    renderFile();
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
  updateActions();
});

function baseName(fileName) {
  return fileName.replace(/\.pdf$/i, "");
}

class ValidationError extends Error {}

async function flattenPdf() {
  const { PDFDocument, StandardFonts, PDFTextField, PDFDropdown, PDFOptionList } = await getPdfLib();
  const doc = await PDFDocument.load(await loaded.file.arrayBuffer(), { ignoreEncryption: true });
  const form = doc.getForm();
  const fieldCount = form.getFields().length;

  if (fieldCount === 0) {
    return { noop: true };
  }

  // form.flatten() regenerates appearance streams (using this same default
  // font) for any field lacking a valid one — including fields the user never
  // touched, e.g. a PDF authored by another tool that set field values but
  // relied on NeedAppearances instead of writing its own appearance streams.
  // Pre-checking every field's own pre-existing value here catches unrenderable
  // characters (CJK, emoji, other non-Latin scripts) before flatten()'s
  // internal save-time throw, which would otherwise be misread as a
  // corrupted/password-protected file.
  const font = await doc.embedFont(StandardFonts.Helvetica);
  function assertEncodable(text, fieldName) {
    if (!text) return;
    try {
      font.widthOfTextAtSize(text, 1);
    } catch (e) {
      throw new ValidationError(
        `The value for "${fieldName}" has a character the form's font can't render (likely emoji, CJK, or another non-Latin script) — flattening would fail. Fix it in Fill Form first, or remove the field's value, and try again.`
      );
    }
  }
  form.getFields().forEach((field) => {
    if (field instanceof PDFTextField) {
      assertEncodable(field.getText(), field.getName());
    } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      field.getSelected().forEach((value) => assertEncodable(value, field.getName()));
    }
  });

  form.flatten();
  const bytes = await doc.save();

  return {
    noop: false,
    blob: new Blob([bytes], { type: "application/pdf" }),
    fileName: `${baseName(loaded.file.name)}-flattened.pdf`,
    fieldCount,
  };
}

flattenBtn.addEventListener("click", async () => {
  flattenBtn.disabled = true;
  const originalLabel = flattenBtnLabel.textContent;
  flattenBtnLabel.textContent = "Flattening…";
  resultEl.hidden = true;

  const startedAt = performance.now();
  const requestsBefore = requestsSinceLoad;

  try {
    const outcome = await flattenPdf();

    if (outcome.noop) {
      resultEl.hidden = false;
      resultEl.className = "result";
      resultEl.setAttribute("role", "status");
      resultEl.setAttribute("aria-live", "polite");
      resultEl.innerHTML = `<span><strong>Nothing to flatten.</strong> This PDF has no fillable form fields — there's no AcroForm data to convert, so no new file was generated.</span>`;
      return;
    }

    const { blob, fileName, fieldCount } = outcome;
    const url = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    const elapsedMs = Math.round(performance.now() - startedAt);
    const requestsDuring = requestsSinceLoad - requestsBefore;

    resultEl.hidden = false;
    resultEl.className = "result";
    resultEl.setAttribute("role", "status");
    resultEl.setAttribute("aria-live", "polite");
    resultEl.innerHTML = `
      <span><strong>Done.</strong> ${fieldCount} form field${fieldCount === 1 ? "" : "s"} flattened —
      ${elapsedMs}ms, ${requestsDuring} network requests, entirely on this device.</span>
      <a class="btn btn-primary" href="${url}" download="${escapeHtml(fileName)}">Download ${escapeHtml(fileName)}</a>
    `;
  } catch (err) {
    resultEl.hidden = false;
    resultEl.className = "result result-error";
    resultEl.setAttribute("role", "alert");
    resultEl.setAttribute("aria-live", "assertive");
    resultEl.innerHTML = `<span><strong>Flatten failed.</strong> ${escapeHtml(
      err instanceof ValidationError ? err.message : "This file may be corrupted or password-protected."
    )}</span>`;
  } finally {
    flattenBtn.disabled = false;
    flattenBtn.focus();
    flattenBtnLabel.textContent = originalLabel;
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
