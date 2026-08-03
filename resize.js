let _pdfLibPromise = null;
function getPdfLib() {
  if (!_pdfLibPromise) _pdfLibPromise = import("./vendor/pdf-lib.esm.min.js");
  return _pdfLibPromise;
}

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const fileListEl = document.getElementById("fileList");
const actionsEl = document.getElementById("actions");
const resizeBtn = document.getElementById("resizeBtn");
const resizeBtnLabel = document.getElementById("resizeBtnLabel");
const clearBtn = document.getElementById("clearBtn");
const resultEl = document.getElementById("result");
const resizePanel = document.getElementById("resizePanel");
const resizeMeta = document.getElementById("resizeMeta");
const resizeModeSelect = document.getElementById("resizeModeSelect");
const presetRow = document.getElementById("presetRow");
const presetSelect = document.getElementById("presetSelect");
const percentRow = document.getElementById("percentRow");
const percentInput = document.getElementById("percentInput");

const PRESETS = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
  legal: { width: 612, height: 1008 },
  a3: { width: 841.89, height: 1190.55 },
  a5: { width: 419.53, height: 595.28 },
};

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
  resizePanel.hidden = !loaded;
  resultEl.hidden = true;
  if (!loaded) return;
  resizeMeta.textContent = `${loaded.pageCount} page${loaded.pageCount === 1 ? "" : "s"} detected`;
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

resizeModeSelect.addEventListener("change", () => {
  const isPercent = resizeModeSelect.value === "percent";
  presetRow.hidden = isPercent;
  percentRow.hidden = !isPercent;
});

function baseName(fileName) {
  return fileName.replace(/\.pdf$/i, "");
}

function readPercent() {
  const value = parseFloat(percentInput.value);
  if (!Number.isFinite(value) || value <= 0 || value > 1000) {
    throw new Error("Enter a valid scale percentage between 1 and 1000.");
  }
  return value / 100;
}

async function resizePdf() {
  const { PDFDocument } = await getPdfLib();
  const mode = resizeModeSelect.value;
  const doc = await PDFDocument.load(await loaded.file.arrayBuffer(), { ignoreEncryption: true });
  const pages = doc.getPages();

  let suffix;
  if (mode === "percent") {
    const factor = readPercent();
    pages.forEach((page) => page.scale(factor, factor));
    suffix = `-${Math.round(factor * 100)}pct`;
  } else {
    const preset = PRESETS[presetSelect.value];
    pages.forEach((page) => {
      const { width, height } = page.getSize();
      const factor = Math.min(preset.width / width, preset.height / height);
      page.scale(factor, factor);
    });
    suffix = `-${presetSelect.value}`;
  }

  const bytes = await doc.save();

  return {
    blob: new Blob([bytes], { type: "application/pdf" }),
    fileName: `${baseName(loaded.file.name)}${suffix}.pdf`,
    pageCount: pages.length,
  };
}

resizeBtn.addEventListener("click", async () => {
  resizeBtn.disabled = true;
  const originalLabel = resizeBtnLabel.textContent;
  resizeBtnLabel.textContent = "Resizing…";
  resultEl.hidden = true;

  const startedAt = performance.now();
  const requestsBefore = requestsSinceLoad;

  try {
    const { blob, fileName, pageCount } = await resizePdf();
    const url = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    const elapsedMs = Math.round(performance.now() - startedAt);
    const requestsDuring = requestsSinceLoad - requestsBefore;

    resultEl.hidden = false;
    resultEl.className = "result";
    resultEl.innerHTML = `
      <span><strong>Done.</strong> ${pageCount} page${pageCount === 1 ? "" : "s"} resized —
      ${elapsedMs}ms, ${requestsDuring} network requests, entirely on this device.</span>
      <a class="btn btn-primary" href="${url}" download="${fileName}">Download ${fileName}</a>
    `;
  } catch (err) {
    resultEl.hidden = false;
    resultEl.className = "result result-error";
    resultEl.innerHTML = `<span><strong>Resize failed.</strong> ${escapeHtml(
      err instanceof Error ? err.message : "This file may be corrupted or password-protected."
    )}</span>`;
  } finally {
    resizeBtn.disabled = false;
    resizeBtnLabel.textContent = originalLabel;
  }
});

const proForm = document.getElementById("proForm");
const proNote = document.getElementById("proNote");
proForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("proEmail").value.trim();
  if (!email) return;
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
