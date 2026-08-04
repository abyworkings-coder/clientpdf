let _pdfLibPromise = null;
function getPdfLib() {
  if (!_pdfLibPromise) _pdfLibPromise = import("./vendor/pdf-lib.esm.min.js");
  return _pdfLibPromise;
}

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const fileListEl = document.getElementById("fileList");
const actionsEl = document.getElementById("actions");
const clearBtn = document.getElementById("clearBtn");
const downloadAllBtn = document.getElementById("downloadAllBtn");
const resultEl = document.getElementById("result");
const sectionMeta = document.getElementById("sectionMeta");
const sectionListEl = document.getElementById("sectionList");

/** @type {{file: File, doc: any, pageCount: number} | null} */
let loaded = null;
/** @type {{title: string, startPage: number, endPage: number}[]} */
let sections = [];

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

function slugify(title) {
  return (
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

/**
 * Walks the top-level /Outlines linked list and resolves each item's target
 * page. Bookmarks can point at a page either via a direct /Dest array or via
 * an /A (GoTo action) dict with its own /D array — both are common depending
 * on which tool authored the PDF, so both are handled.
 */
async function readTopLevelOutline(doc) {
  const { PDFName } = await getPdfLib();
  const context = doc.context;
  const catalog = doc.catalog;
  const outlinesRef = catalog.get(PDFName.of("Outlines"));
  if (!outlinesRef) return [];
  const outlines = context.lookup(outlinesRef);
  if (!outlines) return [];

  const pageRefs = doc.getPages().map((p) => p.ref);

  function resolvePageIndex(dest) {
    // Named destinations (a PDFString/PDFName pointing into the /Names tree)
    // aren't resolved — only direct [pageRef, ...] array destinations are.
    if (!dest || typeof dest.get !== "function") return -1;
    try {
      const pageRef = dest.get(0);
      if (!pageRef) return -1;
      return pageRefs.findIndex(
        (r) => r.tag === pageRef.tag && r.objectNumber === pageRef.objectNumber
      );
    } catch (e) {
      return -1;
    }
  }

  const items = [];
  let cur = outlines.get(PDFName.of("First"));
  let guard = 0;
  while (cur && guard++ < 10000) {
    const item = context.lookup(cur);
    if (!item) break;
    const titleObj = item.get(PDFName.of("Title"));
    const title = titleObj && titleObj.decodeText ? titleObj.decodeText() : "Untitled";

    let dest = item.get(PDFName.of("Dest"));
    if (!dest) {
      const actionRef = item.get(PDFName.of("A"));
      if (actionRef) {
        const action = context.lookup(actionRef);
        if (action) dest = action.get(PDFName.of("D"));
      }
    }

    const pageIndex = resolvePageIndex(dest);
    if (pageIndex >= 0) items.push({ title, pageIndex });

    cur = item.get(PDFName.of("Next"));
  }
  return items;
}

function buildSections(items, pageCount) {
  const sorted = [...items].sort((a, b) => a.pageIndex - b.pageIndex);
  return sorted.map((item, i) => {
    const endPage =
      i < sorted.length - 1
        ? Math.max(sorted[i + 1].pageIndex - 1, item.pageIndex)
        : pageCount - 1;
    return { title: item.title, startPage: item.pageIndex, endPage };
  });
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

function renderSections() {
  sectionListEl.innerHTML = "";
  sections.forEach((s, i) => {
    const pageRange =
      s.startPage === s.endPage
        ? `page ${s.startPage + 1}`
        : `pages ${s.startPage + 1}–${s.endPage + 1}`;
    const li = document.createElement("li");
    li.className = "file-row";
    li.innerHTML = `
      <span class="handle">▤</span>
      <span class="name">${escapeHtml(s.title)}</span>
      <span class="size">${pageRange}</span>
      <button class="row-btn" type="button" data-index="${i}">Download</button>
    `;
    sectionListEl.appendChild(li);
  });
  sectionListEl.querySelectorAll(".row-btn").forEach((btn) => {
    btn.addEventListener("click", () => downloadSection(Number(btn.dataset.index)));
  });
}

function updateActions() {
  actionsEl.hidden = !loaded || sections.length === 0;
  resultEl.hidden = true;
  if (!loaded) {
    sectionMeta.textContent = "";
    return;
  }
  sectionMeta.textContent =
    sections.length === 0
      ? `${loaded.pageCount} page${loaded.pageCount === 1 ? "" : "s"} detected — no bookmarks found in this PDF.`
      : `${loaded.pageCount} page${loaded.pageCount === 1 ? "" : "s"} detected — ${sections.length} bookmark section${sections.length === 1 ? "" : "s"} found.`;
}

async function loadFile(file) {
  try {
    const { PDFDocument } = await getPdfLib();
    const bytes = await file.arrayBuffer();
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pageCount = doc.getPageCount();
    const items = await readTopLevelOutline(doc);
    sections = buildSections(items, pageCount);
    loaded = { file, doc, pageCount };
    renderFile();
    renderSections();
    updateActions();
  } catch (err) {
    loaded = null;
    sections = [];
    fileInput.value = "";
    renderFile();
    renderSections();
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
  sections = [];
  fileInput.value = "";
  renderFile();
  renderSections();
  updateActions();
});

async function extractSection(section) {
  const { PDFDocument } = await getPdfLib();
  const bytes = await loaded.file.arrayBuffer();
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const indices = [];
  for (let p = section.startPage; p <= section.endPage; p++) indices.push(p);

  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, indices);
  pages.forEach((page) => out.addPage(page));
  const outBytes = await out.save();

  return {
    blob: new Blob([outBytes], { type: "application/pdf" }),
    fileName: `${baseName(loaded.file.name)}-${slugify(section.title)}.pdf`,
  };
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

async function downloadSection(index) {
  const section = sections[index];
  try {
    const { blob, fileName } = await extractSection(section);
    triggerDownload(blob, fileName);
  } catch (err) {
    resultEl.hidden = false;
    resultEl.className = "result result-error";
    resultEl.innerHTML = `<span><strong>Couldn't extract that section.</strong> ${escapeHtml(
      err instanceof Error ? err.message : "This file may be corrupted or password-protected."
    )}</span>`;
  }
}

downloadAllBtn.addEventListener("click", async () => {
  downloadAllBtn.disabled = true;
  const startedAt = performance.now();
  const requestsBefore = requestsSinceLoad;
  try {
    for (let i = 0; i < sections.length; i++) {
      const { blob, fileName } = await extractSection(sections[i]);
      triggerDownload(blob, fileName);
      // Small stagger between downloads — browsers can drop rapid-fire
      // programmatic downloads triggered outside a fresh user gesture.
      if (i < sections.length - 1) await new Promise((r) => setTimeout(r, 400));
    }
    const elapsedMs = Math.round(performance.now() - startedAt);
    const requestsDuring = requestsSinceLoad - requestsBefore;
    resultEl.hidden = false;
    resultEl.className = "result";
    resultEl.innerHTML = `<span><strong>Done.</strong> ${sections.length} file${
      sections.length === 1 ? "" : "s"
    } downloaded — ${elapsedMs}ms, ${requestsDuring} network requests, entirely on this device. If your browser blocked any of them, allow multiple downloads for this site and click "Download all" again.</span>`;
  } catch (err) {
    resultEl.hidden = false;
    resultEl.className = "result result-error";
    resultEl.innerHTML = `<span><strong>Couldn't extract sections.</strong> ${escapeHtml(
      err instanceof Error ? err.message : "This file may be corrupted or password-protected."
    )}</span>`;
  } finally {
    downloadAllBtn.disabled = false;
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
