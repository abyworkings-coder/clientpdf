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
const clearBtn = document.getElementById("clearBtn");
const downloadAllBtn = document.getElementById("downloadAllBtn");
const resultEl = document.getElementById("result");
const imageMeta = document.getElementById("imageMeta");
const imageListEl = document.getElementById("imageList");

/** @type {{file: File, pageCount: number} | null} */
let loaded = null;
/** @type {{pageIndex: number, key: string, bytes: Uint8Array, url: string, supported: true}[]} */
let images = [];
let skippedCount = 0;

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

/**
 * Walks each page's /Resources /XObject dict for Image subtype entries.
 * Only extracts images whose Filter resolves to /DCTDecode (JPEG) — the raw
 * compressed bytes are already a valid, byte-identical JPEG file. Images
 * encoded with other filters (FlateDecode raw pixels, JPXDecode, CCITTFax)
 * would need re-encoding to produce a usable file, so they're reported as
 * skipped rather than silently dropped or falsely claimed as extracted.
 * Images inside nested Form XObjects aren't walked — only images that are
 * direct page resources.
 */
async function extractImages(doc) {
  const { PDFName } = await getPdfLib();
  const found = [];
  let skipped = 0;
  const pages = doc.getPages();
  pages.forEach((page, pageIndex) => {
    const resources = page.node.Resources();
    if (!resources) return;
    const xobjDict = resources.lookup(PDFName.of("XObject"));
    if (!xobjDict || typeof xobjDict.keys !== "function") return;
    for (const key of xobjDict.keys()) {
      const ref = xobjDict.get(key);
      const stream = doc.context.lookup(ref);
      if (!stream || !stream.dict) continue;
      const subtype = stream.dict.get(PDFName.of("Subtype"));
      if (!subtype || subtype.toString() !== "/Image") continue;

      const filterObj = stream.dict.get(PDFName.of("Filter"));
      let filterName = null;
      if (filterObj) {
        filterName =
          typeof filterObj.asArray === "function"
            ? (() => {
                const arr = filterObj.asArray();
                return arr.length ? arr[arr.length - 1].toString() : null;
              })()
            : filterObj.toString();
      }

      if (filterName !== "/DCTDecode") {
        skipped++;
        continue;
      }

      const bytes = stream.getContents();
      found.push({ pageIndex, key: key.toString(), bytes });
    }
  });
  return { found, skipped };
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

function renderImages() {
  imageListEl.innerHTML = "";
  images.forEach((img, i) => {
    const li = document.createElement("li");
    li.className = "file-row";
    li.innerHTML = `
      <img class="thumb" src="${img.url}" alt="" width="32" height="32" />
      <span class="name">Page ${img.pageIndex + 1} — image ${i + 1}</span>
      <span class="size">${formatSize(img.bytes.length)}</span>
      <button class="row-btn" type="button" data-index="${i}">Download</button>
    `;
    imageListEl.appendChild(li);
  });
  imageListEl.querySelectorAll(".row-btn").forEach((btn) => {
    btn.addEventListener("click", () => downloadImage(Number(btn.dataset.index)));
  });
}

function updateActions() {
  actionsEl.hidden = !loaded || images.length === 0;
  resultEl.hidden = true;
  if (!loaded) {
    imageMeta.textContent = "";
    return;
  }
  const parts = [];
  parts.push(
    images.length === 0
      ? "no JPEG images found in this PDF"
      : `${images.length} JPEG image${images.length === 1 ? "" : "s"} found`
  );
  if (skippedCount > 0) {
    parts.push(
      `${skippedCount} other image${skippedCount === 1 ? "" : "s"} skipped — unsupported encoding (only JPEG-encoded images can be extracted as-is)`
    );
  }
  imageMeta.textContent = `${loaded.pageCount} page${loaded.pageCount === 1 ? "" : "s"} scanned — ${parts.join(", ")}.`;
}

function revokeAll() {
  images.forEach((img) => URL.revokeObjectURL(img.url));
}

async function loadFile(file) {
  try {
    const { PDFDocument } = await getPdfLib();
    revokeAll();
    const bytes = await file.arrayBuffer();
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pageCount = doc.getPageCount();
    const { found, skipped } = await extractImages(doc);
    images = found.map((img) => ({
      ...img,
      url: URL.createObjectURL(new Blob([img.bytes], { type: "image/jpeg" })),
    }));
    skippedCount = skipped;
    loaded = { file, pageCount };
    renderFile();
    renderImages();
    updateActions();
  } catch (err) {
    revokeAll();
    loaded = null;
    images = [];
    skippedCount = 0;
    fileInput.value = "";
    renderFile();
    renderImages();
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
  revokeAll();
  loaded = null;
  images = [];
  skippedCount = 0;
  fileInput.value = "";
  renderFile();
  renderImages();
  updateActions();
});

function imageFileName(img, index) {
  return `${baseName(loaded.file.name)}-p${img.pageIndex + 1}-img${index + 1}.jpg`;
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

function downloadImage(index) {
  const img = images[index];
  triggerDownload(new Blob([img.bytes], { type: "image/jpeg" }), imageFileName(img, index));
}

downloadAllBtn.addEventListener("click", async () => {
  downloadAllBtn.disabled = true;
  try {
    const entries = images.map((img, i) => ({
      name: imageFileName(img, i),
      data: img.bytes,
    }));
    const zipBlob = createZip(entries);
    triggerDownload(zipBlob, `${baseName(loaded.file.name)}-images.zip`);
    resultEl.hidden = false;
    resultEl.className = "result";
    resultEl.setAttribute("role", "status");
    resultEl.setAttribute("aria-live", "polite");
    resultEl.innerHTML = `<span><strong>Done.</strong> ${images.length} image${
      images.length === 1 ? "" : "s"
    } packed into one .zip, entirely on this device.</span>`;
  } catch (err) {
    resultEl.hidden = false;
    resultEl.className = "result result-error";
    resultEl.setAttribute("role", "alert");
    resultEl.setAttribute("aria-live", "assertive");
    resultEl.innerHTML = `<span><strong>Couldn't build the zip.</strong> ${escapeHtml(
      err instanceof Error ? err.message : "This file may be corrupted."
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
