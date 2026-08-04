let _pdfLibPromise = null;
function getPdfLib() {
  if (!_pdfLibPromise) _pdfLibPromise = import("./vendor/pdf-lib.esm.min.js");
  return _pdfLibPromise;
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
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
    });

    li.querySelector(".move-up").addEventListener("click", () => {
      if (i === 0) return;
      [files[i - 1], files[i]] = [files[i], files[i - 1]];
      renderList();
    });

    li.querySelector(".move-down").addEventListener("click", () => {
      if (i === files.length - 1) return;
      [files[i], files[i + 1]] = [files[i + 1], files[i]];
      renderList();
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
  const incoming = Array.from(fileList).filter(
    (f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf")
  );
  for (const file of incoming) {
    files.push({ id: `${file.name}-${file.size}-${Math.random()}`, file });
  }
  renderList();
  updateActions();
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener("change", (e) => addFiles(e.target.files));

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

    for (const entry of files) {
      const bytes = await entry.file.arrayBuffer();
      const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach((page) => merged.addPage(page));
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
      err instanceof Error ? err.message : "One of these files may be corrupted or password-protected."
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
