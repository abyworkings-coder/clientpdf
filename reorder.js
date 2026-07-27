import { PDFDocument } from "./vendor/pdf-lib.esm.min.js";

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const fileListEl = document.getElementById("fileList");
const actionsEl = document.getElementById("actions");
const reorderBtn = document.getElementById("reorderBtn");
const reorderBtnLabel = document.getElementById("reorderBtnLabel");
const clearBtn = document.getElementById("clearBtn");
const resultEl = document.getElementById("result");
const reorderPanel = document.getElementById("reorderPanel");
const reorderMeta = document.getElementById("reorderMeta");

/** @type {{file: File, order: number[]} | null} */
let loaded = null;
let dragIndex = null;

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

function baseName(fileName) {
  return fileName.replace(/\.pdf$/i, "");
}

function renderPages() {
  fileListEl.innerHTML = "";
  if (!loaded) return;

  loaded.order.forEach((pageIndex, position) => {
    const li = document.createElement("li");
    li.className = "file-row";
    li.draggable = true;
    li.dataset.position = String(position);

    li.innerHTML = `
      <span class="handle">⠿</span>
      <span class="name">${position + 1}. Page ${pageIndex + 1} of ${loaded.file.name}</span>
      <button class="remove" type="button" aria-label="Remove page ${pageIndex + 1}">✕</button>
    `;

    li.querySelector(".remove").addEventListener("click", () => {
      loaded.order.splice(position, 1);
      renderPages();
      updateActions();
    });

    li.addEventListener("dragstart", () => {
      dragIndex = position;
      li.classList.add("dragging");
    });
    li.addEventListener("dragend", () => li.classList.remove("dragging"));
    li.addEventListener("dragover", (e) => e.preventDefault());
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      if (dragIndex === null || dragIndex === position) return;
      const [moved] = loaded.order.splice(dragIndex, 1);
      loaded.order.splice(position, 0, moved);
      dragIndex = null;
      renderPages();
    });

    fileListEl.appendChild(li);
  });
}

function updateActions() {
  const hasPages = !!loaded && loaded.order.length > 0;
  actionsEl.hidden = !loaded;
  reorderPanel.hidden = !loaded;
  reorderBtn.disabled = !hasPages;
  resultEl.hidden = true;
  if (!loaded) return;
  reorderMeta.textContent = `${loaded.order.length} of ${loaded.pageCount} page${
    loaded.pageCount === 1 ? "" : "s"
  } kept — drag to reorder, ✕ to drop a page`;
}

async function loadFile(file) {
  const bytes = await file.arrayBuffer();
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pageCount = doc.getPageCount();
  loaded = {
    file,
    pageCount,
    order: Array.from({ length: pageCount }, (_, i) => i),
  };
  renderPages();
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
  renderPages();
  updateActions();
});

reorderBtn.addEventListener("click", async () => {
  reorderBtn.disabled = true;
  const originalLabel = reorderBtnLabel.textContent;
  reorderBtnLabel.textContent = "Rebuilding…";
  resultEl.hidden = true;

  const startedAt = performance.now();
  const requestsBefore = requestsSinceLoad;

  try {
    if (loaded.order.length === 0) throw new Error("Keep at least one page.");

    const src = await PDFDocument.load(await loaded.file.arrayBuffer(), { ignoreEncryption: true });
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, loaded.order);
    pages.forEach((page) => out.addPage(page));

    const bytes = await out.save();
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const fileName = `${baseName(loaded.file.name)}-reordered.pdf`;
    const elapsedMs = Math.round(performance.now() - startedAt);
    const requestsDuring = requestsSinceLoad - requestsBefore;

    resultEl.hidden = false;
    resultEl.className = "result";
    resultEl.innerHTML = `
      <span><strong>Done.</strong> ${pages.length} page${pages.length === 1 ? "" : "s"} rebuilt in new order —
      ${elapsedMs}ms, ${requestsDuring} network requests, entirely on this device.</span>
      <a class="btn btn-primary" href="${url}" download="${fileName}">Download ${fileName}</a>
    `;
  } catch (err) {
    resultEl.hidden = false;
    resultEl.className = "result result-error";
    resultEl.innerHTML = `<span><strong>Reorder failed.</strong> ${escapeHtml(
      err instanceof Error ? err.message : "This file may be corrupted or password-protected."
    )}</span>`;
  } finally {
    reorderBtn.disabled = loaded ? loaded.order.length === 0 : true;
    reorderBtnLabel.textContent = originalLabel;
  }
});

const proForm = document.getElementById("proForm");
const proNote = document.getElementById("proNote");
proForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const email = document.getElementById("proEmail").value.trim();
  if (!email) return;
  const saved = JSON.parse(localStorage.getItem("clientpdf_waitlist") || "[]");
  saved.push({ email, at: new Date().toISOString() });
  localStorage.setItem("clientpdf_waitlist", JSON.stringify(saved));
  proForm.hidden = true;
  proNote.hidden = false;
});
