let _pdfLibPromise = null;
function getPdfLib() {
  if (!_pdfLibPromise) _pdfLibPromise = import("./vendor/pdf-lib.esm.min.js");
  return _pdfLibPromise;
}

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const fileListEl = document.getElementById("fileList");
const actionsEl = document.getElementById("actions");
const saveBtn = document.getElementById("saveBtn");
const saveBtnLabel = document.getElementById("saveBtnLabel");
const clearBtn = document.getElementById("clearBtn");
const resultEl = document.getElementById("result");
const bookmarkPanel = document.getElementById("bookmarkPanel");
const bookmarkMeta = document.getElementById("bookmarkMeta");
const titleInput = document.getElementById("titleInput");
const pageInput = document.getElementById("pageInput");
const addBookmarkBtn = document.getElementById("addBookmarkBtn");
const bookmarkListEl = document.getElementById("bookmarkList");

/** @type {{file: File, pageCount: number} | null} */
let loaded = null;
/** @type {{title: string, page: number}[]} */
let bookmarks = [];

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
  const kb = bytes / 1024;
  if (Math.round(kb) < 1024) return `${kb.toFixed(0)} KB`;
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

function renderBookmarks() {
  bookmarkListEl.innerHTML = "";
  bookmarks.forEach((b, i) => {
    const li = document.createElement("li");
    li.className = "file-row";
    li.innerHTML = `
      <span class="handle" aria-hidden="true">▤</span>
      <span class="name">${escapeHtml(b.title)}</span>
      <span class="size">page ${b.page}</span>
      <button class="remove" type="button" aria-label="Remove bookmark: ${escapeHtml(b.title)} (page ${b.page})" data-index="${i}">✕</button>
    `;
    bookmarkListEl.appendChild(li);
  });
  bookmarkListEl.querySelectorAll(".remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.index);
      bookmarks.splice(i, 1);
      renderBookmarks();
      updateActions();
      const nextIndex = Math.min(i, bookmarks.length - 1);
      const nextBtn = bookmarkListEl.querySelector(`button.remove[data-index="${nextIndex}"]`);
      (nextBtn || addBookmarkBtn)?.focus();
    });
  });
}

function updateActions() {
  actionsEl.hidden = !loaded;
  bookmarkPanel.hidden = !loaded;
  resultEl.hidden = true;
  if (!loaded) return;
  bookmarkMeta.textContent = `${loaded.pageCount} page${loaded.pageCount === 1 ? "" : "s"} detected — ${bookmarks.length} bookmark${bookmarks.length === 1 ? "" : "s"} queued`;
  saveBtn.disabled = bookmarks.length === 0;
}

/**
 * Reads the PDF's own top-level /Outlines linked list, if any, so pre-existing
 * bookmarks aren't silently destroyed when the user adds a new one — addOutline()
 * below always rebuilds /Outlines from scratch, so whatever isn't in `bookmarks`
 * at save time is gone. Only direct [pageRef, ...] /Dest arrays are resolved
 * (not named destinations via /Names, and not /A GoTo actions) — an entry that
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

async function loadFile(file) {
  try {
    const { PDFDocument } = await getPdfLib();
    const bytes = await file.arrayBuffer();
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    loaded = { file, pageCount: doc.getPageCount() };
    bookmarks = await readExistingBookmarks(doc).catch(() => []);
    renderFile();
    renderBookmarks();
    updateActions();
  } catch (err) {
    loaded = null;
    bookmarks = [];
    fileInput.value = "";
    titleInput.value = "";
    pageInput.value = "";
    renderFile();
    renderBookmarks();
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
  bookmarks = [];
  fileInput.value = "";
  titleInput.value = "";
  pageInput.value = "";
  renderFile();
  renderBookmarks();
  updateActions();
});

/** Marks an error as a known, user-facing validation message (safe to show verbatim),
 * as opposed to a raw pdf-lib/parser exception (which must stay hidden from users). */
class ValidationError extends Error {}

function addBookmark() {
  const title = titleInput.value.trim();
  const pageStr = pageInput.value.trim();
  if (!title) throw new ValidationError("Enter a bookmark title.");
  if (!/^\d+$/.test(pageStr)) throw new ValidationError("Enter a valid page number.");
  const page = parseInt(pageStr, 10);
  if (page < 1 || page > loaded.pageCount) {
    throw new ValidationError(`Page ${page} is out of range (1–${loaded.pageCount}).`);
  }
  bookmarks.push({ title, page });
  titleInput.value = "";
  pageInput.value = "";
  titleInput.focus();
  renderBookmarks();
  updateActions();
}

addBookmarkBtn.addEventListener("click", () => {
  try {
    addBookmark();
  } catch (err) {
    resultEl.hidden = false;
    resultEl.className = "result result-error";
    resultEl.setAttribute("role", "alert");
    resultEl.setAttribute("aria-live", "assertive");
    resultEl.innerHTML = `<span><strong>Couldn't add bookmark.</strong> ${escapeHtml(
      err instanceof ValidationError ? err.message : "Check the title and page number."
    )}</span>`;
  }
});
[titleInput, pageInput].forEach((el) => {
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addBookmarkBtn.click();
    }
  });
});

function baseName(fileName) {
  return fileName.replace(/\.pdf$/i, "");
}

/**
 * Builds a flat PDF outline (bookmark) tree from a list of {title, page}
 * entries via pdf-lib's low-level context API — pdf-lib has no high-level
 * outline API, so the /Outlines dict and each item dict are constructed and
 * linked (Parent/First/Last/Next/Prev/Count) by hand per the PDF spec.
 */
async function addOutline(doc, entries) {
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

async function saveWithBookmarks() {
  const { PDFDocument } = await getPdfLib();
  const doc = await PDFDocument.load(await loaded.file.arrayBuffer(), { ignoreEncryption: true });
  await addOutline(doc, bookmarks);
  const bytes = await doc.save();

  return {
    blob: new Blob([bytes], { type: "application/pdf" }),
    fileName: `${baseName(loaded.file.name)}-bookmarked.pdf`,
    count: bookmarks.length,
  };
}

saveBtn.addEventListener("click", async () => {
  saveBtn.disabled = true;
  const originalLabel = saveBtnLabel.textContent;
  saveBtnLabel.textContent = "Adding…";
  resultEl.hidden = true;

  const startedAt = performance.now();
  const requestsBefore = requestsSinceLoad;

  try {
    const { blob, fileName, count } = await saveWithBookmarks();
    const url = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    const elapsedMs = Math.round(performance.now() - startedAt);
    const requestsDuring = requestsSinceLoad - requestsBefore;

    resultEl.hidden = false;
    resultEl.className = "result";
    resultEl.setAttribute("role", "status");
    resultEl.setAttribute("aria-live", "polite");
    resultEl.innerHTML = `
      <span><strong>Done.</strong> ${count} bookmark${count === 1 ? "" : "s"} saved —
      ${elapsedMs}ms, ${requestsDuring} network requests, entirely on this device.</span>
      <a class="btn btn-primary" href="${url}" download="${escapeHtml(fileName)}">Download ${escapeHtml(fileName)}</a>
    `;
  } catch (err) {
    resultEl.hidden = false;
    resultEl.className = "result result-error";
    resultEl.setAttribute("role", "alert");
    resultEl.setAttribute("aria-live", "assertive");
    resultEl.innerHTML = `<span><strong>Couldn't add bookmarks.</strong> ${escapeHtml(
      "This file may be corrupted or password-protected."
    )}</span>`;
  } finally {
    saveBtn.disabled = false;
    saveBtn.focus();
    saveBtnLabel.textContent = originalLabel;
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
