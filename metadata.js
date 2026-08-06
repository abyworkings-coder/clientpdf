let _pdfLibPromise = null;
function getPdfLib() {
  if (!_pdfLibPromise) _pdfLibPromise = import("./vendor/pdf-lib.esm.min.js");
  return _pdfLibPromise;
}

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const fileListEl = document.getElementById("fileList");
const actionsEl = document.getElementById("actions");
const metaBtn = document.getElementById("metaBtn");
const metaBtnLabel = document.getElementById("metaBtnLabel");
const clearBtn = document.getElementById("clearBtn");
const resultEl = document.getElementById("result");
const metaPanel = document.getElementById("metaPanel");
const metaMeta = document.getElementById("metaMeta");
const titleInput = document.getElementById("metaTitleInput");
const authorInput = document.getElementById("metaAuthorInput");
const subjectInput = document.getElementById("metaSubjectInput");
const keywordsInput = document.getElementById("metaKeywordsInput");
const createdInput = document.getElementById("metaCreatedInput");
const modifiedInput = document.getElementById("metaModifiedInput");

/** @type {{file: File, pageCount: number} | null} */
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

// Convert a JS Date (or undefined) into a value usable by <input type="datetime-local">,
// in local time (the input has no timezone concept, so we just format local wall-clock).
function dateToLocalInputValue(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

// Convert a datetime-local input's string value back into a JS Date, or null if empty/invalid.
function localInputValueToDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (isNaN(date.getTime())) return null;
  return date;
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
  metaPanel.hidden = !loaded;
  resultEl.hidden = true;
  if (!loaded) return;
  metaMeta.textContent = `${loaded.pageCount} page${loaded.pageCount === 1 ? "" : "s"} detected`;
}

async function loadFile(file) {
  try {
    const { PDFDocument } = await getPdfLib();
    const bytes = await file.arrayBuffer();
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    loaded = { file, pageCount: doc.getPageCount() };

    titleInput.value = doc.getTitle() || "";
    authorInput.value = doc.getAuthor() || "";
    subjectInput.value = doc.getSubject() || "";
    const keywords = doc.getKeywords();
    // pdf-lib returns getKeywords() as a single space-joined string; show it
    // comma-separated in the UI for easier editing either way.
    keywordsInput.value = keywords ? keywords.split(/\s+/).filter(Boolean).join(", ") : "";
    createdInput.value = dateToLocalInputValue(doc.getCreationDate());
    modifiedInput.value = dateToLocalInputValue(doc.getModificationDate());

    renderFile();
    updateActions();
  } catch (err) {
    loaded = null;
    fileInput.value = "";
    titleInput.value = "";
    authorInput.value = "";
    subjectInput.value = "";
    keywordsInput.value = "";
    createdInput.value = "";
    modifiedInput.value = "";
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
  titleInput.value = "";
  authorInput.value = "";
  subjectInput.value = "";
  keywordsInput.value = "";
  createdInput.value = "";
  modifiedInput.value = "";
  renderFile();
  updateActions();
});

function baseName(fileName) {
  return fileName.replace(/\.pdf$/i, "");
}

async function saveMetadata() {
  const { PDFDocument, PDFName } = await getPdfLib();
  const doc = await PDFDocument.load(await loaded.file.arrayBuffer(), {
    ignoreEncryption: true,
    updateMetadata: false,
  });

  doc.setTitle(titleInput.value.trim());
  doc.setAuthor(authorInput.value.trim());
  doc.setSubject(subjectInput.value.trim());

  const keywordList = keywordsInput.value
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  doc.setKeywords(keywordList);

  const createdDate = localInputValueToDate(createdInput.value);
  if (createdDate) {
    doc.setCreationDate(createdDate);
  } else {
    doc.getInfoDict().delete(PDFName.of("CreationDate"));
  }

  const modifiedDate = localInputValueToDate(modifiedInput.value);
  if (modifiedDate) {
    doc.setModificationDate(modifiedDate);
  } else {
    doc.getInfoDict().delete(PDFName.of("ModDate"));
  }

  // Note: pdf-lib stamps Producer/Creator/CreationDate/ModificationDate
  // automatically, but only via PDFDocument.load()'s `updateMetadata` option
  // (default true) — not unconditionally on save(). Loading with
  // `updateMetadata: false` above keeps Producer/Creator untouched here
  // (so they're correctly left out of this UI) while letting Created/
  // Modified reflect the PDF's real values and the user's explicit edits.
  const bytes = await doc.save();
  return {
    blob: new Blob([bytes], { type: "application/pdf" }),
    fileName: `${baseName(loaded.file.name)}-metadata.pdf`,
  };
}

metaBtn.addEventListener("click", async () => {
  metaBtn.disabled = true;
  const originalLabel = metaBtnLabel.textContent;
  metaBtnLabel.textContent = "Saving…";
  resultEl.hidden = true;

  const startedAt = performance.now();
  const requestsBefore = requestsSinceLoad;

  try {
    const { blob, fileName } = await saveMetadata();
    const url = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    const elapsedMs = Math.round(performance.now() - startedAt);
    const requestsDuring = requestsSinceLoad - requestsBefore;

    resultEl.hidden = false;
    resultEl.className = "result";
    resultEl.setAttribute("role", "status");
    resultEl.setAttribute("aria-live", "polite");
    resultEl.innerHTML = `
      <span><strong>Done.</strong> Metadata updated —
      ${elapsedMs}ms, ${requestsDuring} network requests, entirely on this device.</span>
      <a class="btn btn-primary" href="${url}" download="${escapeHtml(fileName)}">Download ${escapeHtml(fileName)}</a>
    `;
  } catch (err) {
    resultEl.hidden = false;
    resultEl.className = "result result-error";
    resultEl.setAttribute("role", "alert");
    resultEl.setAttribute("aria-live", "assertive");
    resultEl.innerHTML = `<span><strong>Saving metadata failed.</strong> ${escapeHtml(
      "This file may be corrupted or password-protected."
    )}</span>`;
  } finally {
    metaBtn.disabled = false;
    metaBtn.focus();
    metaBtnLabel.textContent = originalLabel;
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
