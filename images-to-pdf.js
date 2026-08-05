let _pdfLibPromise = null;
function getPdfLib() {
  if (!_pdfLibPromise) _pdfLibPromise = import("./vendor/pdf-lib.esm.min.js");
  return _pdfLibPromise;
}

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const fileListEl = document.getElementById("fileList");
const actionsEl = document.getElementById("actions");
const convertBtn = document.getElementById("convertBtn");
const convertBtnLabel = document.getElementById("convertBtnLabel");
const clearBtn = document.getElementById("clearBtn");
const resultEl = document.getElementById("result");

/** @type {{id: string, file: File}[]} */
let images = [];
let dragIndex = null;

// Live, honest proof: count real network requests made after page load
// (excludes the initial page/asset loads, which already happened by the
// time this script runs). Anything the conversion itself does shows up here.
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

function renderList() {
  fileListEl.innerHTML = "";
  images.forEach((entry, i) => {
    const li = document.createElement("li");
    li.className = "file-row";
    li.draggable = true;
    li.dataset.index = String(i);

    li.innerHTML = `
      <span class="handle" aria-hidden="true">⠿</span>
      <span class="name">${i + 1}. ${escapeHtml(entry.file.name)}</span>
      <span class="size">${formatSize(entry.file.size)}</span>
      <button class="move-up" type="button" aria-label="Move ${escapeHtml(entry.file.name)} up" ${i === 0 ? "disabled" : ""}>↑</button>
      <button class="move-down" type="button" aria-label="Move ${escapeHtml(entry.file.name)} down" ${i === images.length - 1 ? "disabled" : ""}>↓</button>
      <button class="remove" type="button" aria-label="Remove ${escapeHtml(entry.file.name)}">✕</button>
    `;

    li.querySelector(".remove").addEventListener("click", () => {
      images = images.filter((f) => f.id !== entry.id);
      renderList();
      updateActions();
    });

    li.querySelector(".move-up").addEventListener("click", () => {
      if (i === 0) return;
      [images[i - 1], images[i]] = [images[i], images[i - 1]];
      renderList();
    });

    li.querySelector(".move-down").addEventListener("click", () => {
      if (i === images.length - 1) return;
      [images[i], images[i + 1]] = [images[i + 1], images[i]];
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
      const [moved] = images.splice(dragIndex, 1);
      images.splice(i, 0, moved);
      dragIndex = null;
      renderList();
    });

    fileListEl.appendChild(li);
  });
}

function updateActions() {
  actionsEl.hidden = images.length === 0;
  convertBtn.disabled = images.length === 0;
  convertBtnLabel.textContent =
    images.length === 0
      ? "Add at least 1 image"
      : `Convert ${images.length} image${images.length === 1 ? "" : "s"} to PDF`;
  if (images.length === 0) resultEl.hidden = true;
}

function addImages(fileList) {
  const all = Array.from(fileList);
  const incoming = all.filter(
    (f) =>
      f.type === "image/jpeg" ||
      f.type === "image/png" ||
      /\.(jpe?g|png)$/i.test(f.name)
  );
  const skipped = all.length - incoming.length;
  for (const file of incoming) {
    images.push({ id: `${file.name}-${file.size}-${Math.random()}`, file });
  }
  renderList();
  updateActions();
  if (skipped > 0) {
    resultEl.hidden = false;
    resultEl.className = "result result-warning";
    resultEl.setAttribute("role", "status");
    resultEl.setAttribute("aria-live", "polite");
    resultEl.innerHTML = `<span><strong>${skipped} file${skipped === 1 ? "" : "s"} skipped.</strong> ${escapeHtml(
      "Only JPG and PNG images are accepted."
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
fileInput.addEventListener("change", (e) => addImages(e.target.files));

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
  if (e.dataTransfer?.files?.length) addImages(e.dataTransfer.files);
});

clearBtn.addEventListener("click", () => {
  images = [];
  renderList();
  updateActions();
});

async function readImageDimensions(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    const dims = await new Promise((resolve, reject) => {
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new Error(`Couldn't read "${file.name}" as an image.`));
      img.src = url;
    });
    return dims;
  } finally {
    URL.revokeObjectURL(url);
  }
}

convertBtn.addEventListener("click", async () => {
  convertBtn.disabled = true;
  const originalLabel = convertBtnLabel.textContent;
  convertBtnLabel.textContent = "Converting…";
  resultEl.hidden = true;

  const startedAt = performance.now();
  const requestsBefore = requestsSinceLoad;

  try {
    const { PDFDocument } = await getPdfLib();
    const doc = await PDFDocument.create();

    for (const entry of images) {
      const bytes = await entry.file.arrayBuffer();
      const isPng = entry.file.type === "image/png" || /\.png$/i.test(entry.file.name);
      const embedded = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      const { width, height } = await readImageDimensions(entry.file);
      const page = doc.addPage([width, height]);
      page.drawImage(embedded, { x: 0, y: 0, width, height });
    }

    const pdfBytes = await doc.save();
    const blob = new Blob([pdfBytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    const elapsedMs = Math.round(performance.now() - startedAt);
    const requestsDuring = requestsSinceLoad - requestsBefore;

    resultEl.hidden = false;
    resultEl.className = "result";
    resultEl.setAttribute("role", "status");
    resultEl.setAttribute("aria-live", "polite");
    resultEl.innerHTML = `
      <span><strong>Done.</strong> ${images.length} image${images.length === 1 ? "" : "s"} converted, ${doc.getPageCount()} page${doc.getPageCount() === 1 ? "" : "s"} —
      ${elapsedMs}ms, ${requestsDuring} network requests, entirely on this device.</span>
      <a class="btn btn-primary" href="${url}" download="images.pdf">Download images.pdf</a>
    `;
  } catch (err) {
    resultEl.hidden = false;
    resultEl.className = "result result-error";
    resultEl.setAttribute("role", "alert");
    resultEl.setAttribute("aria-live", "assertive");
    resultEl.innerHTML = `<span><strong>Conversion failed.</strong> ${escapeHtml(
      "One of these files may not be a valid JPG or PNG."
    )}</span>`;
  } finally {
    convertBtn.disabled = images.length === 0;
    convertBtn.focus();
    convertBtnLabel.textContent =
      images.length === 0
        ? "Add at least 1 image"
        : `Convert ${images.length} image${images.length === 1 ? "" : "s"} to PDF`;
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
