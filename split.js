import { createZip } from "./zip.js";

let _pdfLibPromise = null;
function getPdfLib() {
  if (!_pdfLibPromise) _pdfLibPromise = import("./vendor/pdf-lib.esm.min.js");
  return _pdfLibPromise;
}

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const fileListEl = document.getElementById("fileList");
const actionsEl = document.getElementById("actions");
const splitBtn = document.getElementById("splitBtn");
const splitBtnLabel = document.getElementById("splitBtnLabel");
const clearBtn = document.getElementById("clearBtn");
const resultEl = document.getElementById("result");
const splitPanel = document.getElementById("splitPanel");
const splitMeta = document.getElementById("splitMeta");
const rangeRow = document.getElementById("rangeRow");
const rangeInput = document.getElementById("rangeInput");

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

function currentMode() {
  return document.querySelector('input[name="splitMode"]:checked').value;
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
  splitPanel.hidden = !loaded;
  resultEl.hidden = true;
  if (!loaded) return;
  splitMeta.textContent = `${loaded.pageCount} page${loaded.pageCount === 1 ? "" : "s"} detected`;
  syncMode();
}

function syncMode() {
  const mode = currentMode();
  rangeRow.hidden = mode !== "range";
  splitBtnLabel.textContent = mode === "range" ? "Extract pages" : `Split into ${loaded ? loaded.pageCount : 0} PDFs`;
}

document.querySelectorAll('input[name="splitMode"]').forEach((el) =>
  el.addEventListener("change", syncMode)
);

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

/** Marks an error as a known, user-facing validation message (safe to show verbatim),
 * as opposed to a raw pdf-lib/parser exception (which must stay hidden from users). */
class ValidationError extends Error {}

/**
 * Parses "1-3, 5, 8-10" into a 0-based, in-order page index list.
 * Throws with a human-readable message on invalid input.
 */
function parseRanges(input, pageCount) {
  const indices = [];
  const parts = input.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) throw new ValidationError("Enter at least one page or range.");

  for (const part of parts) {
    const match = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) throw new ValidationError(`"${part}" isn't a valid page or range.`);
    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : start;
    if (start < 1 || end < 1 || start > pageCount || end > pageCount) {
      throw new ValidationError(`Page ${Math.max(start, end)} is out of range (1–${pageCount}).`);
    }
    if (start <= end) {
      for (let p = start; p <= end; p++) indices.push(p - 1);
    } else {
      for (let p = start; p >= end; p--) indices.push(p - 1);
    }
  }
  return indices;
}

function baseName(fileName) {
  return fileName.replace(/\.pdf$/i, "");
}

/**
 * Reads the source PDF's own top-level /Outlines linked list (if any) as a
 * flat list of {title, page} entries (1-based page numbers) — building an
 * output via PDFDocument.create()+copyPages() never brings /Outlines along
 * on its own. Only direct [pageRef, ...] /Dest arrays are resolved (not
 * named destinations, not /A GoTo actions) — an entry that can't be resolved
 * to a page is dropped rather than guessed at. Mirrors bookmarks.js/
 * delete-pages.js/duplicate-pages.js.
 */
async function readExistingBookmarks(doc) {
  const { PDFName } = await getPdfLib();
  const context = doc.context;
  const outlinesRef = doc.catalog.get(PDFName.of("Outlines"));
  if (!outlinesRef) return [];
  const outlines = context.lookup(outlinesRef);
  if (!outlines) return [];

  const pageRefs = doc.getPages().map((p) => p.ref);
  function resolvePage(dest) {
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
    const title = titleObj && titleObj.decodeText ? titleObj.decodeText() : "";
    const dest = item.get(PDFName.of("Dest"));
    const pageIndex = resolvePage(dest);
    if (title && pageIndex >= 0) items.push({ title, page: pageIndex + 1 });
    cur = item.get(PDFName.of("Next"));
  }
  return items;
}

/**
 * Rebuilds a flat PDF outline (bookmark) tree on `doc` from a list of
 * {title, page} entries (1-based) via pdf-lib's low-level context API.
 * Mirrors bookmarks.js's/delete-pages.js's addOutline() exactly.
 */
async function addOutline(doc, entries) {
  if (entries.length === 0) return;
  const { PDFName, PDFString, PDFNumber } = await getPdfLib();
  const context = doc.context;
  const sorted = [...entries].sort((a, b) => a.page - b.page);

  const outlineRef = context.nextRef();
  const itemRefs = sorted.map(() => context.nextRef());

  sorted.forEach((entry, i) => {
    const page = doc.getPage(entry.page - 1);
    const dict = {
      Title: PDFString.of(entry.title),
      Parent: outlineRef,
      Dest: context.obj([page.ref, PDFName.of("Fit")]),
    };
    if (i > 0) dict.Prev = itemRefs[i - 1];
    if (i < itemRefs.length - 1) dict.Next = itemRefs[i + 1];
    context.assign(itemRefs[i], context.obj(dict));
  });

  context.assign(
    outlineRef,
    context.obj({
      Type: PDFName.of("Outlines"),
      First: itemRefs[0],
      Last: itemRefs[itemRefs.length - 1],
      Count: PDFNumber.of(itemRefs.length),
    })
  );

  doc.catalog.set(PDFName.of("Outlines"), outlineRef);
}

async function extractRange() {
  const { PDFDocument } = await getPdfLib();
  const indices = parseRanges(rangeInput.value, loaded.pageCount);
  const src = await PDFDocument.load(await loaded.file.arrayBuffer(), { ignoreEncryption: true });
  const existingBookmarks = await readExistingBookmarks(src).catch(() => []);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, indices);
  pages.forEach((page) => out.addPage(page));

  // A bookmark whose page appears in the extracted range is carried over,
  // remapped to that page's new position in the output — the FIRST index
  // in `indices` that resolves to a given old page wins if the user's range
  // list caused the same page to be included more than once (e.g. "1-3, 2").
  const oldToNewIndex = new Map();
  indices.forEach((oldIndex, newIndex) => {
    if (!oldToNewIndex.has(oldIndex)) oldToNewIndex.set(oldIndex, newIndex);
  });
  const remappedBookmarks = existingBookmarks
    .filter((b) => oldToNewIndex.has(b.page - 1))
    .map((b) => ({ title: b.title, page: oldToNewIndex.get(b.page - 1) + 1 }));
  await addOutline(out, remappedBookmarks);

  const bytes = await out.save();
  return {
    blob: new Blob([bytes], { type: "application/pdf" }),
    fileName: `${baseName(loaded.file.name)}-extract.pdf`,
    pageCount: pages.length,
  };
}

async function splitEveryPage() {
  const { PDFDocument } = await getPdfLib();
  const src = await PDFDocument.load(await loaded.file.arrayBuffer(), { ignoreEncryption: true });
  const existingBookmarks = await readExistingBookmarks(src).catch(() => []);
  const bookmarksByPage = new Map();
  for (const b of existingBookmarks) {
    if (!bookmarksByPage.has(b.page)) bookmarksByPage.set(b.page, []);
    bookmarksByPage.get(b.page).push(b.title);
  }

  const name = baseName(loaded.file.name);
  const digits = String(loaded.pageCount).length;
  const entries = [];
  for (let i = 0; i < loaded.pageCount; i++) {
    const out = await PDFDocument.create();
    const [page] = await out.copyPages(src, [i]);
    out.addPage(page);
    // Each output PDF has exactly one page, so a bookmark on source page
    // i+1 unambiguously maps to page 1 of this file — no remap ambiguity.
    const titles = bookmarksByPage.get(i + 1) || [];
    await addOutline(out, titles.map((title) => ({ title, page: 1 })));
    const bytes = await out.save();
    entries.push({ name: `${name}-page-${String(i + 1).padStart(digits, "0")}.pdf`, data: bytes });
  }
  const blob = createZip(entries);
  return { blob, fileName: `${name}-split.zip`, pageCount: loaded.pageCount };
}

splitBtn.addEventListener("click", async () => {
  splitBtn.disabled = true;
  const mode = currentMode();
  const originalLabel = splitBtnLabel.textContent;
  splitBtnLabel.textContent = mode === "range" ? "Extracting…" : "Splitting…";
  resultEl.hidden = true;

  const startedAt = performance.now();
  const requestsBefore = requestsSinceLoad;

  try {
    const { blob, fileName, pageCount } = mode === "range" ? await extractRange() : await splitEveryPage();
    const url = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    const elapsedMs = Math.round(performance.now() - startedAt);
    const requestsDuring = requestsSinceLoad - requestsBefore;

    resultEl.hidden = false;
    resultEl.className = "result";
    resultEl.setAttribute("role", "status");
    resultEl.setAttribute("aria-live", "polite");
    resultEl.innerHTML = `
      <span><strong>Done.</strong> ${pageCount} page${pageCount === 1 ? "" : "s"} —
      ${elapsedMs}ms, ${requestsDuring} network requests, entirely on this device.</span>
      <a class="btn btn-primary" href="${url}" download="${escapeHtml(fileName)}">Download ${escapeHtml(fileName)}</a>
    `;
  } catch (err) {
    resultEl.hidden = false;
    resultEl.className = "result result-error";
    resultEl.setAttribute("role", "alert");
    resultEl.setAttribute("aria-live", "assertive");
    resultEl.innerHTML = `<span><strong>Split failed.</strong> ${escapeHtml(
      err instanceof ValidationError ? err.message : "This file may be corrupted or password-protected."
    )}</span>`;
  } finally {
    splitBtn.disabled = false;
    splitBtn.focus();
    splitBtnLabel.textContent = originalLabel;
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
