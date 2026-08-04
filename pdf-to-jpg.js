import { createZip } from "./zip.js";

// pdf.js core (~454KB) is only needed once a user actually drops/selects a
// file, so it's dynamically imported on first use instead of eagerly on page
// load — the worker was already lazy, this closes the gap for the core lib.
let pdfjsLibPromise = null;
function getPdfjsLib() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import("./vendor/pdf.min.mjs").then((pdfjsLib) => {
      // Point at the local worker file, never a CDN — matches the site's
      // zero-network-call rule that every other tool here already follows.
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdf.worker.min.mjs", import.meta.url).href;
      return pdfjsLib;
    });
  }
  return pdfjsLibPromise;
}

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const fileListEl = document.getElementById("fileList");
const actionsEl = document.getElementById("actions");
const convertBtn = document.getElementById("convertBtn");
const convertBtnLabel = document.getElementById("convertBtnLabel");
const clearBtn = document.getElementById("clearBtn");
const resultEl = document.getElementById("result");
const convertPanel = document.getElementById("convertPanel");
const convertMeta = document.getElementById("convertMeta");

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

function baseName(fileName) {
  return fileName.replace(/\.pdf$/i, "");
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
  convertPanel.hidden = !loaded;
  resultEl.hidden = true;
  if (!loaded) return;
  convertMeta.textContent = `${loaded.pageCount} page${loaded.pageCount === 1 ? "" : "s"} detected — each will be rendered as its own image`;
}

async function loadFile(file) {
  try {
    const bytes = await file.arrayBuffer();
    // A separate pdf.js parse just to read the page count; the actual render
    // pass re-parses from the original bytes so nothing here is mutated.
    const pdfjsLib = await getPdfjsLib();
    const pdf = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
    const pageCount = pdf.numPages;
    pdf.loadingTask.destroy();
    loaded = { file, pageCount };
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

function getFormat() {
  const checked = document.querySelector('input[name="format"]:checked');
  return checked ? checked.value : "jpg";
}

function getScale() {
  const checked = document.querySelector('input[name="resolution"]:checked');
  return checked ? Number(checked.value) : 1.5;
}

/** Renders one pdf.js page to a canvas and resolves the canvas element. */
async function renderPageToCanvas(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  // JPG has no alpha channel — paint white first so transparent PDF
  // backgrounds don't render as black once exported to JPG.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

function canvasToBytes(canvas, format) {
  const mime = format === "png" ? "image/png" : "image/jpeg";
  const quality = format === "png" ? undefined : 0.9;
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Couldn't encode a rendered page as an image."));
          return;
        }
        blob
          .arrayBuffer()
          .then((buf) => resolve(new Uint8Array(buf)))
          .catch(reject);
      },
      mime,
      quality
    );
  });
}

/**
 * Renders every page of the loaded PDF to an image, calling onProgress after
 * each page so the UI can show "page X of Y" without freezing on large files
 * (each page still renders synchronously on the main thread via canvas, but
 * yielding the microtask queue between pages keeps the button label live).
 */
async function convertAllPages(format, scale, onProgress) {
  const bytes = await loaded.file.arrayBuffer();
  const pdfjsLib = await getPdfjsLib();
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  const ext = format === "png" ? "png" : "jpg";
  const name = baseName(loaded.file.name);
  const digits = String(pdf.numPages).length;
  const entries = [];

  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      onProgress(i, pdf.numPages);
      const page = await pdf.getPage(i);
      const canvas = await renderPageToCanvas(page, scale);
      const imageBytes = await canvasToBytes(canvas, format);
      entries.push({
        name: `${name}-page-${String(i).padStart(digits, "0")}.${ext}`,
        data: imageBytes,
      });
      page.cleanup();
      // Yield to the event loop between pages so the tab stays responsive.
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    pdf.loadingTask.destroy();
  }

  return entries;
}

function triggerDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

convertBtn.addEventListener("click", async () => {
  convertBtn.disabled = true;
  const originalLabel = convertBtnLabel.textContent;
  resultEl.hidden = true;

  const startedAt = performance.now();
  const requestsBefore = requestsSinceLoad;
  const format = getFormat();
  const scale = getScale();

  try {
    const entries = await convertAllPages(format, scale, (current, total) => {
      convertBtnLabel.textContent = total > 1 ? `Rendering page ${current} of ${total}…` : "Rendering page…";
    });

    const elapsedMs = Math.round(performance.now() - startedAt);
    const requestsDuring = requestsSinceLoad - requestsBefore;
    const formatLabel = format === "png" ? "PNG" : "JPG";

    if (entries.length === 1) {
      const mime = format === "png" ? "image/png" : "image/jpeg";
      const blob = new Blob([entries[0].data], { type: mime });
      const url = URL.createObjectURL(blob);
      resultEl.hidden = false;
      resultEl.className = "result";
      resultEl.setAttribute("role", "status");
      resultEl.setAttribute("aria-live", "polite");
      resultEl.innerHTML = `
        <span><strong>Done.</strong> 1 page rendered as ${formatLabel} —
        ${elapsedMs}ms, ${requestsDuring} network requests, entirely on this device.</span>
        <a class="btn btn-primary" href="${url}" download="${escapeHtml(entries[0].name)}">Download ${escapeHtml(entries[0].name)}</a>
      `;
    } else {
      const zipBlob = createZip(entries);
      const zipName = `${baseName(loaded.file.name)}-images.zip`;
      triggerDownload(zipBlob, zipName);
      resultEl.hidden = false;
      resultEl.className = "result";
      resultEl.setAttribute("role", "status");
      resultEl.setAttribute("aria-live", "polite");
      resultEl.innerHTML = `
        <span><strong>Done.</strong> ${entries.length} pages rendered as ${formatLabel} and packed into ${escapeHtml(zipName)} —
        ${elapsedMs}ms, ${requestsDuring} network requests, entirely on this device.</span>
      `;
    }
  } catch (err) {
    resultEl.hidden = false;
    resultEl.className = "result result-error";
    resultEl.setAttribute("role", "alert");
    resultEl.setAttribute("aria-live", "assertive");
    resultEl.innerHTML = `<span><strong>Conversion failed.</strong> ${escapeHtml(
      err instanceof Error ? err.message : "This file may be corrupted or password-protected."
    )}</span>`;
  } finally {
    convertBtn.disabled = false;
    convertBtnLabel.textContent = originalLabel;
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
