let _pdfLibPromise = null;
function getPdfLib() {
  if (!_pdfLibPromise) _pdfLibPromise = import("./vendor/pdf-lib.esm.min.js");
  return _pdfLibPromise;
}

/**
 * Reads a source PDF's own top-level /Outlines linked list, if any, so its
 * bookmarks can be carried into the merged output instead of silently
 * dropped (plain copyPages/addPage never touches /Outlines). Only direct
 * [pageRef, ...] /Dest arrays are resolved (not named destinations via
 * /Names, and not /A GoTo actions) — an entry that can't be resolved to a
 * page is dropped rather than guessed at. Mirrors bookmarks.js's reader.
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
 * Builds a flat PDF outline (bookmark) tree in the merged doc from a list of
 * {title, page} entries (page numbers already relative to the merged doc) via
 * pdf-lib's low-level context API. Mirrors bookmarks.js's writer.
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

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const fileListEl = document.getElementById("fileList");
const actionsEl = document.getElementById("actions");
const mergeBtn = document.getElementById("mergeBtn");
const mergeBtnLabel = document.getElementById("mergeBtnLabel");
const clearBtn = document.getElementById("clearBtn");
const resultEl = document.getElementById("result");

/** @type {{id: string, file: File}[]} */
let files = [];
let dragIndex = null;

// Live, honest proof: count real network requests made after page load
// (excludes the initial page/asset loads, which already happened by the
// time this script runs). Anything the merge tool itself does shows up here.
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

function focusRow(index, selector, fallback) {
  const row = fileListEl.querySelector(`li[data-index="${index}"]`);
  const el = row ? row.querySelector(selector) : null;
  (el || fallback || clearBtn)?.focus();
}

function renderList() {
  fileListEl.innerHTML = "";
  files.forEach((entry, i) => {
    const li = document.createElement("li");
    li.className = "file-row";
    li.draggable = true;
    li.dataset.index = String(i);

    li.innerHTML = `
      <span class="handle" aria-hidden="true">⠿</span>
      <span class="name">${i + 1}. ${escapeHtml(entry.file.name)}</span>
      <span class="size">${formatSize(entry.file.size)}</span>
      <button class="move-up" type="button" aria-label="Move ${escapeHtml(entry.file.name)} up" ${i === 0 ? "disabled" : ""}>↑</button>
      <button class="move-down" type="button" aria-label="Move ${escapeHtml(entry.file.name)} down" ${i === files.length - 1 ? "disabled" : ""}>↓</button>
      <button class="remove" type="button" aria-label="Remove ${escapeHtml(entry.file.name)}">✕</button>
    `;

    li.querySelector(".remove").addEventListener("click", () => {
      files = files.filter((f) => f.id !== entry.id);
      renderList();
      updateActions();
      focusRow(Math.min(i, files.length - 1), ".remove", dropzone);
    });

    li.querySelector(".move-up").addEventListener("click", () => {
      if (i === 0) return;
      [files[i - 1], files[i]] = [files[i], files[i - 1]];
      renderList();
      focusRow(i - 1, ".move-up");
    });

    li.querySelector(".move-down").addEventListener("click", () => {
      if (i === files.length - 1) return;
      [files[i], files[i + 1]] = [files[i + 1], files[i]];
      renderList();
      focusRow(i + 1, ".move-down");
    });

    li.addEventListener("dragstart", () => {
      dragIndex = i;
      li.classList.add("dragging");
    });
    li.addEventListener("dragend", () => li.classList.remove("dragging"));
    li.addEventListener("dragover", (e) => e.preventDefault());
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      if (dragIndex === null || dragIndex === i) return;
      const [moved] = files.splice(dragIndex, 1);
      files.splice(i, 0, moved);
      dragIndex = null;
      renderList();
    });

    fileListEl.appendChild(li);
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function updateActions() {
  actionsEl.hidden = files.length === 0;
  mergeBtn.disabled = files.length < 2;
  mergeBtnLabel.textContent =
    files.length < 2 ? "Add at least 2 PDFs" : `Merge ${files.length} PDFs`;
  if (files.length === 0) resultEl.hidden = true;
}

function addFiles(fileList) {
  const all = Array.from(fileList);
  const incoming = all.filter(
    (f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf")
  );
  const skipped = all.length - incoming.length;
  for (const file of incoming) {
    files.push({ id: `${file.name}-${file.size}-${Math.random()}`, file });
  }
  renderList();
  updateActions();
  if (skipped > 0) {
    resultEl.hidden = false;
    resultEl.className = "result result-warning";
    resultEl.setAttribute("role", "status");
    resultEl.setAttribute("aria-live", "polite");
    resultEl.innerHTML = `<span><strong>${skipped} file${skipped === 1 ? "" : "s"} skipped.</strong> ${escapeHtml(
      "Only PDF files are accepted."
    )}</span>`;
  } else if (
    resultEl.classList.contains("result-warning") ||
    resultEl.classList.contains("result-error")
  ) {
    resultEl.hidden = true;
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
  addFiles(e.target.files);
  fileInput.value = "";
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
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});

clearBtn.addEventListener("click", () => {
  files = [];
  renderList();
  updateActions();
});

mergeBtn.addEventListener("click", async () => {
  mergeBtn.disabled = true;
  mergeBtnLabel.textContent = "Merging…";
  resultEl.hidden = true;

  const startedAt = performance.now();
  const requestsBefore = requestsSinceLoad;

  try {
    const { PDFDocument } = await getPdfLib();
    const merged = await PDFDocument.create();
    const allBookmarks = [];
    let pageOffset = 0;

    for (const entry of files) {
      const bytes = await entry.file.arrayBuffer();
      const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const srcBookmarks = await readExistingBookmarks(src).catch(() => []);
      srcBookmarks.forEach((b) => allBookmarks.push({ title: b.title, page: b.page + pageOffset }));
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach((page) => merged.addPage(page));
      pageOffset += src.getPageCount();
    }

    if (allBookmarks.length > 0) {
      await addOutline(merged, allBookmarks);
    }

    const mergedBytes = await merged.save();
    const blob = new Blob([mergedBytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    const elapsedMs = Math.round(performance.now() - startedAt);
    const requestsDuringMerge = requestsSinceLoad - requestsBefore;

    resultEl.hidden = false;
    resultEl.className = "result";
    resultEl.setAttribute("role", "status");
    resultEl.setAttribute("aria-live", "polite");
    resultEl.innerHTML = `
      <span><strong>Done.</strong> ${files.length} files merged, ${merged.getPageCount()} pages total —
      ${elapsedMs}ms, ${requestsDuringMerge} network requests, entirely on this device.</span>
      <a class="btn btn-primary" href="${url}" download="merged.pdf">Download merged.pdf</a>
    `;
  } catch (err) {
    resultEl.hidden = false;
    resultEl.className = "result result-error";
    resultEl.setAttribute("role", "alert");
    resultEl.setAttribute("aria-live", "assertive");
    resultEl.innerHTML = `<span><strong>Merge failed.</strong> ${escapeHtml(
      "One of these files may be corrupted or password-protected."
    )}</span>`;
  } finally {
    mergeBtn.disabled = files.length < 2;
    mergeBtn.focus();
    mergeBtnLabel.textContent = `Merge ${files.length} PDFs`;
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
  // Keep a local copy so the signal isn't lost if the network request fails.
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
