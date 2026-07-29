import { PDFDocument } from "./vendor/pdf-lib.esm.min.js";

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const fileListEl = document.getElementById("fileList");
const actionsEl = document.getElementById("actions");
const nupBtn = document.getElementById("nupBtn");
const nupBtnLabel = document.getElementById("nupBtnLabel");
const clearBtn = document.getElementById("clearBtn");
const resultEl = document.getElementById("result");
const nupPanel = document.getElementById("nupPanel");
const nupMeta = document.getElementById("nupMeta");

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

function currentCount() {
  return parseInt(document.querySelector('input[name="nupCount"]:checked').value, 10);
}

function currentOrientation() {
  return document.querySelector('input[name="nupOrientation"]:checked').value;
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
  nupPanel.hidden = !loaded;
  resultEl.hidden = true;
  if (!loaded) return;
  nupMeta.textContent = `${loaded.pageCount} page${loaded.pageCount === 1 ? "" : "s"} detected`;
}

async function loadFile(file) {
  const bytes = await file.arrayBuffer();
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  loaded = { file, pageCount: doc.getPageCount() };
  renderFile();
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
  updateActions();
});

function baseName(fileName) {
  return fileName.replace(/\.pdf$/i, "");
}

// A4 in points, either orientation.
const A4 = { w: 595.28, h: 841.89 };
const GAP = 12;

function gridFor(count, orientation) {
  const sheet = orientation === "landscape" ? { width: A4.h, height: A4.w } : { width: A4.w, height: A4.h };
  const cols = count === 4 ? 2 : orientation === "landscape" ? 2 : 1;
  const rows = count === 4 ? 2 : orientation === "landscape" ? 1 : 2;
  return { sheet, cols, rows };
}

async function nupPdf() {
  const count = currentCount();
  const orientation = currentOrientation();
  const { sheet, cols, rows } = gridFor(count, orientation);

  const srcDoc = await PDFDocument.load(await loaded.file.arrayBuffer(), { ignoreEncryption: true });
  const srcPages = srcDoc.getPages();
  const outDoc = await PDFDocument.create();
  const embedded = await outDoc.embedPages(srcPages);

  const cellW = (sheet.width - GAP * (cols + 1)) / cols;
  const cellH = (sheet.height - GAP * (rows + 1)) / rows;

  let sheetsMade = 0;
  for (let i = 0; i < embedded.length; i += count) {
    const chunk = embedded.slice(i, i + count);
    const page = outDoc.addPage([sheet.width, sheet.height]);
    chunk.forEach((embeddedPage, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const scale = Math.min(cellW / embeddedPage.width, cellH / embeddedPage.height);
      const drawW = embeddedPage.width * scale;
      const drawH = embeddedPage.height * scale;
      const cellX = GAP + col * (cellW + GAP);
      const cellTopY = sheet.height - GAP - row * (cellH + GAP);
      const x = cellX + (cellW - drawW) / 2;
      const y = cellTopY - cellH + (cellH - drawH) / 2;
      page.drawPage(embeddedPage, { x, y, xScale: scale, yScale: scale });
    });
    sheetsMade++;
  }

  const bytes = await outDoc.save();
  return {
    blob: new Blob([bytes], { type: "application/pdf" }),
    fileName: `${baseName(loaded.file.name)}-${count}up.pdf`,
    sheetsMade,
    originalPages: srcPages.length,
  };
}

nupBtn.addEventListener("click", async () => {
  nupBtn.disabled = true;
  const originalLabel = nupBtnLabel.textContent;
  nupBtnLabel.textContent = "Combining…";
  resultEl.hidden = true;

  const startedAt = performance.now();
  const requestsBefore = requestsSinceLoad;

  try {
    const { blob, fileName, sheetsMade, originalPages } = await nupPdf();
    const url = URL.createObjectURL(blob);
    const elapsedMs = Math.round(performance.now() - startedAt);
    const requestsDuring = requestsSinceLoad - requestsBefore;

    resultEl.hidden = false;
    resultEl.className = "result";
    resultEl.innerHTML = `
      <span><strong>Done.</strong> ${originalPages} page${originalPages === 1 ? "" : "s"} laid out onto ${sheetsMade} sheet${sheetsMade === 1 ? "" : "s"} —
      ${elapsedMs}ms, ${requestsDuring} network requests, entirely on this device.</span>
      <a class="btn btn-primary" href="${url}" download="${fileName}">Download ${fileName}</a>
    `;
  } catch (err) {
    resultEl.hidden = false;
    resultEl.className = "result result-error";
    resultEl.innerHTML = `<span><strong>Combining failed.</strong> ${escapeHtml(
      err instanceof Error ? err.message : "This file may be corrupted or password-protected."
    )}</span>`;
  } finally {
    nupBtn.disabled = false;
    nupBtnLabel.textContent = originalLabel;
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
