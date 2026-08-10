let _pdfLibPromise = null;
function getPdfLib() {
  if (!_pdfLibPromise) _pdfLibPromise = import("./vendor/pdf-lib.esm.min.js");
  return _pdfLibPromise;
}

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const fileListEl = document.getElementById("fileList");
const actionsEl = document.getElementById("actions");
const numberBtn = document.getElementById("numberBtn");
const numberBtnLabel = document.getElementById("numberBtnLabel");
const clearBtn = document.getElementById("clearBtn");
const resultEl = document.getElementById("result");
const numPanel = document.getElementById("numPanel");
const numMeta = document.getElementById("numMeta");
const numStartInput = document.getElementById("numStartInput");
const numSkipFirst = document.getElementById("numSkipFirst");

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
  const kb = bytes / 1024;
  if (Math.round(kb) < 1024) return `${kb.toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function currentPosition() {
  return document.querySelector('input[name="numPosition"]:checked').value;
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
  numPanel.hidden = !loaded;
  resultEl.hidden = true;
  if (!loaded) return;
  numMeta.textContent = `${loaded.pageCount} page${loaded.pageCount === 1 ? "" : "s"} detected`;
}

async function loadFile(file) {
  try {
    const { PDFDocument } = await getPdfLib();
    const bytes = await file.arrayBuffer();
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    loaded = { file, pageCount: doc.getPageCount() };
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

function marginFor(position, textWidth, pageWidth, pageHeight) {
  const margin = 24;
  const y = position.startsWith("top") ? pageHeight - margin - 10 : margin;
  let x;
  if (position.endsWith("right")) x = pageWidth - margin - textWidth;
  else if (position.endsWith("left")) x = margin;
  else x = (pageWidth - textWidth) / 2;
  return { x, y };
}

/** Marks an error as a known, user-facing validation message (safe to show verbatim),
 * as opposed to a raw pdf-lib/parser exception (which must stay hidden from users). */
class ValidationError extends Error {}

async function numberPdf() {
  const { PDFDocument, StandardFonts, rgb } = await getPdfLib();
  const position = currentPosition();
  const start = parseInt(numStartInput.value, 10);
  if (!Number.isFinite(start) || start < 0) {
    throw new ValidationError("Enter a valid starting number (0 or higher).");
  }
  const skipFirst = numSkipFirst.checked;

  const doc = await PDFDocument.load(await loaded.file.arrayBuffer(), { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const fontSize = 10;
  let stamped = 0;

  pages.forEach((page, i) => {
    if (skipFirst && i === 0) return;
    const number = start + (skipFirst ? i - 1 : i);
    const text = String(number);
    const textWidth = font.widthOfTextAtSize(text, fontSize);
    const { width, height } = page.getSize();
    const box = page.getMediaBox();
    const { x, y } = marginFor(position, textWidth, width, height);
    page.drawText(text, { x: box.x + x, y: box.y + y, size: fontSize, font, color: rgb(0.35, 0.35, 0.35) });
    stamped++;
  });

  if (stamped === 0) throw new ValidationError("No pages left to number after skipping the cover page.");

  const bytes = await doc.save();
  return {
    blob: new Blob([bytes], { type: "application/pdf" }),
    fileName: `${baseName(loaded.file.name)}-numbered.pdf`,
    stamped,
  };
}

numberBtn.addEventListener("click", async () => {
  numberBtn.disabled = true;
  const originalLabel = numberBtnLabel.textContent;
  numberBtnLabel.textContent = "Numbering…";
  resultEl.hidden = true;

  const startedAt = performance.now();
  const requestsBefore = requestsSinceLoad;

  try {
    const { blob, fileName, stamped } = await numberPdf();
    const url = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    const elapsedMs = Math.round(performance.now() - startedAt);
    const requestsDuring = requestsSinceLoad - requestsBefore;

    resultEl.hidden = false;
    resultEl.className = "result";
    resultEl.setAttribute("role", "status");
    resultEl.setAttribute("aria-live", "polite");
    resultEl.innerHTML = `
      <span><strong>Done.</strong> ${stamped} page${stamped === 1 ? "" : "s"} numbered —
      ${elapsedMs}ms, ${requestsDuring} network requests, entirely on this device.</span>
      <a class="btn btn-primary" href="${url}" download="${escapeHtml(fileName)}">Download ${escapeHtml(fileName)}</a>
    `;
  } catch (err) {
    resultEl.hidden = false;
    resultEl.className = "result result-error";
    resultEl.setAttribute("role", "alert");
    resultEl.setAttribute("aria-live", "assertive");
    resultEl.innerHTML = `<span><strong>Numbering failed.</strong> ${escapeHtml(
      err instanceof ValidationError ? err.message : "This file may be corrupted or password-protected."
    )}</span>`;
  } finally {
    numberBtn.disabled = false;
    numberBtn.focus();
    numberBtnLabel.textContent = originalLabel;
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
