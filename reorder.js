let _pdfLibPromise = null;
function getPdfLib() {
  if (!_pdfLibPromise) _pdfLibPromise = import("./vendor/pdf-lib.esm.min.js");
  return _pdfLibPromise;
}

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

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function baseName(fileName) {
  return fileName.replace(/\.pdf$/i, "");
}

/** Marks an error as a known, user-facing validation message (safe to show verbatim),
 * as opposed to a raw pdf-lib/parser exception (which must stay hidden from users). */
class ValidationError extends Error {}

/**
 * Reads the source PDF's own top-level /Outlines linked list (if any) as a
 * flat list of {title, page} entries (1-based page numbers), so a bookmark
 * can be carried over into the reordered output instead of silently dropped
 * — building `out` via PDFDocument.create()+copyPages() never brings
 * /Outlines along on its own. Only direct [pageRef, ...] /Dest arrays are
 * resolved (not named destinations, not /A GoTo actions) — an entry that
 * can't be resolved to a page is dropped rather than guessed at.
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

function focusRow(position, selector, fallback) {
  const row = fileListEl.querySelector(`li[data-position="${position}"]`);
  const el = row ? row.querySelector(selector) : null;
  (el || fallback || clearBtn)?.focus();
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
      <span class="handle" aria-hidden="true">⠿</span>
      <span class="name">${position + 1}. Page ${pageIndex + 1} of ${escapeHtml(loaded.file.name)}</span>
      <button class="move-up" type="button" aria-label="Move page ${pageIndex + 1} up" ${position === 0 ? "disabled" : ""}>↑</button>
      <button class="move-down" type="button" aria-label="Move page ${pageIndex + 1} down" ${position === loaded.order.length - 1 ? "disabled" : ""}>↓</button>
      <button class="remove" type="button" aria-label="Remove page ${pageIndex + 1}">✕</button>
    `;

    li.querySelector(".remove").addEventListener("click", () => {
      loaded.order.splice(position, 1);
      renderPages();
      updateActions();
      focusRow(Math.min(position, loaded.order.length - 1), ".remove", dropzone);
    });

    li.querySelector(".move-up").addEventListener("click", () => {
      if (position === 0) return;
      const [moved] = loaded.order.splice(position, 1);
      loaded.order.splice(position - 1, 0, moved);
      renderPages();
      focusRow(position - 1, ".move-up");
    });

    li.querySelector(".move-down").addEventListener("click", () => {
      if (position === loaded.order.length - 1) return;
      const [moved] = loaded.order.splice(position, 1);
      loaded.order.splice(position + 1, 0, moved);
      renderPages();
      focusRow(position + 1, ".move-down");
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
  try {
    const { PDFDocument } = await getPdfLib();
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
  } catch (err) {
    loaded = null;
    fileInput.value = "";
    renderPages();
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
    if (loaded.order.length === 0) throw new ValidationError("Keep at least one page.");

    const { PDFDocument } = await getPdfLib();
    const src = await PDFDocument.load(await loaded.file.arrayBuffer(), { ignoreEncryption: true });
    const existingBookmarks = await readExistingBookmarks(src).catch(() => []);

    // Remap each bookmark's old (1-based) page number to its new position
    // under the reordered page list.
    const oldToNewIndex = new Map();
    loaded.order.forEach((oldIndex, newIndex) => oldToNewIndex.set(oldIndex, newIndex));
    const remappedBookmarks = existingBookmarks
      .filter((b) => oldToNewIndex.has(b.page - 1))
      .map((b) => ({ title: b.title, page: oldToNewIndex.get(b.page - 1) + 1 }));

    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, loaded.order);
    pages.forEach((page) => out.addPage(page));
    await addOutline(out, remappedBookmarks);

    const bytes = await out.save();
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    const fileName = `${baseName(loaded.file.name)}-reordered.pdf`;
    const elapsedMs = Math.round(performance.now() - startedAt);
    const requestsDuring = requestsSinceLoad - requestsBefore;

    resultEl.hidden = false;
    resultEl.className = "result";
    resultEl.setAttribute("role", "status");
    resultEl.setAttribute("aria-live", "polite");
    resultEl.innerHTML = `
      <span><strong>Done.</strong> ${pages.length} page${pages.length === 1 ? "" : "s"} rebuilt in new order —
      ${elapsedMs}ms, ${requestsDuring} network requests, entirely on this device.</span>
      <a class="btn btn-primary" href="${url}" download="${escapeHtml(fileName)}">Download ${escapeHtml(fileName)}</a>
    `;
  } catch (err) {
    resultEl.hidden = false;
    resultEl.className = "result result-error";
    resultEl.setAttribute("role", "alert");
    resultEl.setAttribute("aria-live", "assertive");
    resultEl.innerHTML = `<span><strong>Reorder failed.</strong> ${escapeHtml(
      err instanceof ValidationError ? err.message : "This file may be corrupted or password-protected."
    )}</span>`;
  } finally {
    reorderBtn.disabled = loaded ? loaded.order.length === 0 : true;
    reorderBtn.focus();
    reorderBtnLabel.textContent = originalLabel;
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
