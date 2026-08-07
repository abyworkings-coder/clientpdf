let _pdfLibPromise = null;
function getPdfLib() {
  if (!_pdfLibPromise) _pdfLibPromise = import("./vendor/pdf-lib.esm.min.js");
  return _pdfLibPromise;
}

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const fileListEl = document.getElementById("fileList");
const actionsEl = document.getElementById("actions");
const insertBtn = document.getElementById("insertBtn");
const insertBtnLabel = document.getElementById("insertBtnLabel");
const clearBtn = document.getElementById("clearBtn");
const resultEl = document.getElementById("result");
const insertPanel = document.getElementById("insertPanel");
const insertMeta = document.getElementById("insertMeta");
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
  insertPanel.hidden = !loaded;
  resultEl.hidden = true;
  if (!loaded) return;
  insertMeta.textContent = `${loaded.pageCount} page${loaded.pageCount === 1 ? "" : "s"} detected`;
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
    rangeInput.value = "";
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
  rangeInput.value = "";
  renderFile();
  updateActions();
});

/** Marks an error as a known, user-facing validation message (safe to show verbatim),
 * as opposed to a raw pdf-lib/parser exception (which must stay hidden from users). */
class ValidationError extends Error {}

/**
 * Parses "0, 3, 5" into a sorted array of unique insert positions, where
 * position N means "insert a blank page after original page N" (0 means
 * before the first page, pageCount means after the last page).
 * Throws with a human-readable message on invalid input or out-of-range values.
 */
function parseInsertList(input, pageCount) {
  const positions = new Set();
  const parts = input.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) throw new ValidationError("Enter at least one position to insert a blank page after.");

  for (const part of parts) {
    if (!/^\d+$/.test(part)) throw new ValidationError(`"${part}" isn't a valid page number.`);
    const pos = parseInt(part, 10);
    if (pos < 0 || pos > pageCount) {
      throw new ValidationError(`Position ${pos} is out of range (0–${pageCount}).`);
    }
    positions.add(pos);
  }
  return [...positions].sort((a, b) => b - a);
}

function baseName(fileName) {
  return fileName.replace(/\.pdf$/i, "");
}

/**
 * Reads the source PDF's own top-level /Outlines linked list (if any) as a
 * flat list of {title, page} entries (1-based page numbers), so a bookmark
 * can be carried over into the output instead of silently dropped — building
 * `out` via PDFDocument.create()+copyPages() never brings /Outlines along on
 * its own. Only direct [pageRef, ...] /Dest arrays are resolved (not named
 * destinations, not /A GoTo actions) — an entry that can't be resolved to a
 * page is dropped rather than guessed at.
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
 * {title, page} entries (1-based) via pdf-lib's low-level context API —
 * pdf-lib has no high-level outline API, so /Outlines and each item dict
 * are constructed and linked (Parent/First/Last/Next/Prev/Count) by hand.
 * Mirrors bookmarks.js's addOutline() exactly.
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

async function insertPages() {
  const { PDFDocument } = await getPdfLib();
  // Descending order so each insertPage() call doesn't shift the indices
  // of positions still queued to be inserted.
  const insertList = parseInsertList(rangeInput.value, loaded.pageCount);

  const src = await PDFDocument.load(await loaded.file.arrayBuffer(), { ignoreEncryption: true });
  const existingBookmarks = await readExistingBookmarks(src).catch(() => []);

  // Each original page shifts right by however many insert positions land
  // at or before its own (0-based) index.
  const remappedBookmarks = existingBookmarks.map((b) => {
    const oldIndex = b.page - 1;
    const shift = insertList.filter((pos) => pos <= oldIndex).length;
    return { title: b.title, page: oldIndex + shift + 1 };
  });

  const out = await PDFDocument.create();
  const copies = await out.copyPages(src, src.getPageIndices());
  copies.forEach((page) => out.addPage(page));

  for (const pos of insertList) {
    const neighborIndex = pos < out.getPageCount() ? pos : out.getPageCount() - 1;
    const { width, height } = out.getPage(neighborIndex).getSize();
    out.insertPage(pos, [width, height]);
  }

  await addOutline(out, remappedBookmarks);

  const bytes = await out.save();

  return {
    blob: new Blob([bytes], { type: "application/pdf" }),
    fileName: `${baseName(loaded.file.name)}-inserted.pdf`,
    pageCount: out.getPageCount(),
  };
}

insertBtn.addEventListener("click", async () => {
  insertBtn.disabled = true;
  const originalLabel = insertBtnLabel.textContent;
  insertBtnLabel.textContent = "Inserting…";
  resultEl.hidden = true;

  const startedAt = performance.now();
  const requestsBefore = requestsSinceLoad;

  try {
    const { blob, fileName, pageCount } = await insertPages();
    const url = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    const elapsedMs = Math.round(performance.now() - startedAt);
    const requestsDuring = requestsSinceLoad - requestsBefore;

    resultEl.hidden = false;
    resultEl.className = "result";
    resultEl.setAttribute("role", "status");
    resultEl.setAttribute("aria-live", "polite");
    resultEl.innerHTML = `
      <span><strong>Done.</strong> ${pageCount} page${pageCount === 1 ? "" : "s"} total —
      ${elapsedMs}ms, ${requestsDuring} network requests, entirely on this device.</span>
      <a class="btn btn-primary" href="${url}" download="${escapeHtml(fileName)}">Download ${escapeHtml(fileName)}</a>
    `;
  } catch (err) {
    resultEl.hidden = false;
    resultEl.className = "result result-error";
    resultEl.setAttribute("role", "alert");
    resultEl.setAttribute("aria-live", "assertive");
    resultEl.innerHTML = `<span><strong>Insert failed.</strong> ${escapeHtml(
      err instanceof ValidationError ? err.message : "This file may be corrupted or password-protected."
    )}</span>`;
  } finally {
    insertBtn.disabled = false;
    insertBtn.focus();
    insertBtnLabel.textContent = originalLabel;
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
