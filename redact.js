import { PDFDocument, decodePDFRawStream, PDFRawStream, PDFName, rgb } from "./vendor/pdf-lib.esm.min.js";
import { redactContentStream } from "./redact-engine.js";

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const fileListEl = document.getElementById("fileList");
const actionsEl = document.getElementById("actions");
const redactBtn = document.getElementById("redactBtn");
const redactBtnLabel = document.getElementById("redactBtnLabel");
const clearBtn = document.getElementById("clearBtn");
const resultEl = document.getElementById("result");
const redactPanel = document.getElementById("redactPanel");
const redactMeta = document.getElementById("redactMeta");
const pageInput = document.getElementById("pageInput");
const xInput = document.getElementById("xInput");
const yInput = document.getElementById("yInput");
const wInput = document.getElementById("wInput");
const hInput = document.getElementById("hInput");
const addRectBtn = document.getElementById("addRectBtn");
const rectListEl = document.getElementById("rectList");
const pageSizeHint = document.getElementById("pageSizeHint");

/** @type {{file: File, pageCount: number, pageSizes: {w:number,h:number}[]} | null} */
let loaded = null;
/** @type {{page: number, x: number, y: number, w: number, h: number}[]} */
let rects = [];

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
    <span class="handle">◆</span>
    <span class="name">${escapeHtml(loaded.file.name)} — ${loaded.pageCount} page${loaded.pageCount === 1 ? "" : "s"}</span>
    <span class="size">${formatSize(loaded.file.size)}</span>
  `;
  fileListEl.appendChild(li);
}

function renderRects() {
  rectListEl.innerHTML = "";
  rects.forEach((r, i) => {
    const li = document.createElement("li");
    li.className = "file-row";
    li.innerHTML = `
      <span class="handle">▪</span>
      <span class="name">Page ${r.page} — x:${r.x}, y:${r.y}, w:${r.w}, h:${r.h} pt</span>
      <button class="remove" type="button" data-idx="${i}" aria-label="Remove area">✕</button>
    `;
    rectListEl.appendChild(li);
  });
  redactBtn.disabled = rects.length === 0;
}

rectListEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-idx]");
  if (!btn) return;
  rects.splice(parseInt(btn.dataset.idx, 10), 1);
  renderRects();
});

function updatePageSizeHint() {
  if (!loaded) return;
  const p = parseInt(pageInput.value, 10);
  const size = loaded.pageSizes[p - 1];
  pageSizeHint.textContent = size
    ? `Page ${p} is ${Math.round(size.w)} × ${Math.round(size.h)} pt (origin bottom-left).`
    : `Page number out of range (1–${loaded.pageCount}).`;
}
pageInput.addEventListener("input", updatePageSizeHint);

function updateActions() {
  actionsEl.hidden = !loaded;
  redactPanel.hidden = !loaded;
  resultEl.hidden = true;
  rects = [];
  renderRects();
  if (!loaded) return;
  redactMeta.textContent = `${loaded.pageCount} page${loaded.pageCount === 1 ? "" : "s"} detected`;
  pageInput.value = "1";
  updatePageSizeHint();
}

async function loadFile(file) {
  try {
    const bytes = await file.arrayBuffer();
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pageSizes = doc.getPages().map((p) => {
      const { width, height } = p.getSize();
      return { w: width, h: height };
    });
    loaded = { file, pageCount: doc.getPageCount(), pageSizes };
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

addRectBtn.addEventListener("click", () => {
  if (!loaded) return;
  const page = parseInt(pageInput.value, 10);
  const x = parseFloat(xInput.value);
  const y = parseFloat(yInput.value);
  const w = parseFloat(wInput.value);
  const h = parseFloat(hInput.value);
  if (!Number.isFinite(page) || page < 1 || page > loaded.pageCount) {
    return showError(`Page must be between 1 and ${loaded.pageCount}.`);
  }
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) {
    return showError("x, y, width, and height must be numbers, with width and height greater than 0.");
  }
  rects.push({ page, x, y, w, h });
  renderRects();
});

function showError(message) {
  resultEl.hidden = false;
  resultEl.className = "result result-error";
  resultEl.innerHTML = `<span><strong>Couldn't add that area.</strong> ${escapeHtml(message)}</span>`;
}

function baseName(fileName) {
  return fileName.replace(/\.pdf$/i, "");
}

async function redactPdf() {
  const src = await PDFDocument.load(await loaded.file.arrayBuffer(), { ignoreEncryption: true });

  const byPage = new Map();
  for (const r of rects) {
    const idx = r.page - 1;
    if (!byPage.has(idx)) byPage.set(idx, []);
    byPage.get(idx).push([r.x, r.y, r.x + r.w, r.y + r.h]);
  }

  let totalRemoved = 0;

  for (const [pageIndex, pageRects] of byPage.entries()) {
    const page = src.getPage(pageIndex);
    const contentsField = page.node.Contents();
    const refs = contentsField.array ? contentsField.array : [contentsField];

    let combined = "";
    for (const ref of refs) {
      const streamObj = src.context.lookup(ref);
      combined += new TextDecoder("latin1").decode(decodePDFRawStream(streamObj).decode()) + "\n";
    }

    const { text, removedCount } = redactContentStream(combined, pageRects);
    totalRemoved += removedCount;

    const encodedBytes = Uint8Array.from([...text].map((c) => c.charCodeAt(0)));
    const dict = src.context.obj({ Length: encodedBytes.length });
    const newStream = PDFRawStream.of(dict, encodedBytes);
    const newRef = src.context.register(newStream);
    page.node.set(PDFName.of("Contents"), newRef);

    for (const [x0, y0, x1, y1] of pageRects) {
      page.drawRectangle({
        x: x0,
        y: y0,
        width: x1 - x0,
        height: y1 - y0,
        color: rgb(0, 0, 0),
      });
    }
  }

  const bytes = await src.save();

  return {
    blob: new Blob([bytes], { type: "application/pdf" }),
    fileName: `${baseName(loaded.file.name)}-redacted.pdf`,
    areaCount: rects.length,
    removedCount: totalRemoved,
  };
}

redactBtn.addEventListener("click", async () => {
  redactBtn.disabled = true;
  const originalLabel = redactBtnLabel.textContent;
  redactBtnLabel.textContent = "Redacting…";
  resultEl.hidden = true;

  const startedAt = performance.now();
  const requestsBefore = requestsSinceLoad;

  try {
    const { blob, fileName, areaCount, removedCount } = await redactPdf();
    const url = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    const elapsedMs = Math.round(performance.now() - startedAt);
    const requestsDuring = requestsSinceLoad - requestsBefore;

    resultEl.hidden = false;
    resultEl.className = "result";
    resultEl.innerHTML = `
      <span><strong>Done.</strong> ${areaCount} area${areaCount === 1 ? "" : "s"} redacted
      (${removedCount} text run${removedCount === 1 ? "" : "s"} removed from the file, plus black boxes drawn) —
      ${elapsedMs}ms, ${requestsDuring} network requests, entirely on this device.</span>
      <a class="btn btn-primary" href="${url}" download="${escapeHtml(fileName)}">Download ${escapeHtml(fileName)}</a>
    `;
  } catch (err) {
    resultEl.hidden = false;
    resultEl.className = "result result-error";
    resultEl.innerHTML = `<span><strong>Redaction failed.</strong> ${escapeHtml(
      err instanceof Error ? err.message : "This file may be corrupted or password-protected."
    )}</span>`;
  } finally {
    redactBtn.disabled = rects.length === 0;
    redactBtnLabel.textContent = originalLabel;
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
