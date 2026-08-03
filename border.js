let _pdfLibPromise = null;
function getPdfLib() {
  if (!_pdfLibPromise) _pdfLibPromise = import("./vendor/pdf-lib.esm.min.js");
  return _pdfLibPromise;
}

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const fileListEl = document.getElementById("fileList");
const actionsEl = document.getElementById("actions");
const borderBtn = document.getElementById("borderBtn");
const borderBtnLabel = document.getElementById("borderBtnLabel");
const clearBtn = document.getElementById("clearBtn");
const resultEl = document.getElementById("result");
const borderPanel = document.getElementById("borderPanel");
const borderMeta = document.getElementById("borderMeta");
const marginInput = document.getElementById("marginInput");
const colorInput = document.getElementById("colorInput");
const widthInput = document.getElementById("widthInput");

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
  return div.innerHTML;
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

function updateActions() {
  actionsEl.hidden = !loaded;
  borderPanel.hidden = !loaded;
  resultEl.hidden = true;
  if (!loaded) return;
  borderMeta.textContent = `${loaded.pageCount} page${loaded.pageCount === 1 ? "" : "s"} detected`;
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
    resultEl.innerHTML = `<span><strong>Couldn't load file.</strong> ${escapeHtml(
      err instanceof Error ? err.message : "This file may be corrupted or password-protected."
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

async function hexToRgb01(hex) {
  const { rgb } = await getPdfLib();
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec((hex || "").trim());
  if (!m) throw new Error("Enter a valid border color.");
  return rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
}

function readMargin() {
  const value = parseFloat(marginInput.value);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Enter a margin of 0 or higher.");
  }
  return value;
}

function readStrokeWidth() {
  const value = parseFloat(widthInput.value);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Enter a stroke width greater than 0.");
  }
  return value;
}

function validateMarginForPage(margin, width, height) {
  const minDim = Math.min(width, height);
  if (margin >= minDim / 2) {
    throw new Error(
      `Margin is too large for a ${Math.round(width)}×${Math.round(height)}pt page — use ${(minDim / 2 - 0.5).toFixed(1)}pt or less.`
    );
  }
}

async function addBordersToPdf() {
  const { PDFDocument } = await getPdfLib();
  const margin = readMargin();
  const strokeWidth = readStrokeWidth();
  const borderColor = await hexToRgb01(colorInput.value);

  const doc = await PDFDocument.load(await loaded.file.arrayBuffer(), { ignoreEncryption: true });
  const pages = doc.getPages();

  pages.forEach((page) => {
    const { width, height } = page.getSize();
    validateMarginForPage(margin, width, height);
    page.drawRectangle({
      x: margin,
      y: margin,
      width: width - margin * 2,
      height: height - margin * 2,
      borderColor,
      borderWidth: strokeWidth,
      color: undefined,
    });
  });

  const bytes = await doc.save();
  return {
    blob: new Blob([bytes], { type: "application/pdf" }),
    fileName: `${baseName(loaded.file.name)}-bordered.pdf`,
    pageCount: pages.length,
  };
}

borderBtn.addEventListener("click", async () => {
  borderBtn.disabled = true;
  const originalLabel = borderBtnLabel.textContent;
  borderBtnLabel.textContent = "Drawing borders…";
  resultEl.hidden = true;

  const startedAt = performance.now();
  const requestsBefore = requestsSinceLoad;

  try {
    const { blob, fileName, pageCount } = await addBordersToPdf();
    const url = URL.createObjectURL(blob);
    const elapsedMs = Math.round(performance.now() - startedAt);
    const requestsDuring = requestsSinceLoad - requestsBefore;

    resultEl.hidden = false;
    resultEl.className = "result";
    resultEl.innerHTML = `
      <span><strong>Done.</strong> ${pageCount} page${pageCount === 1 ? "" : "s"} bordered —
      ${elapsedMs}ms, ${requestsDuring} network requests, entirely on this device.</span>
      <a class="btn btn-primary" href="${url}" download="${fileName}">Download ${fileName}</a>
    `;
  } catch (err) {
    resultEl.hidden = false;
    resultEl.className = "result result-error";
    resultEl.innerHTML = `<span><strong>Border failed.</strong> ${escapeHtml(
      err instanceof Error ? err.message : "This file may be corrupted or password-protected."
    )}</span>`;
  } finally {
    borderBtn.disabled = false;
    borderBtnLabel.textContent = originalLabel;
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
