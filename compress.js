import { PDFDocument, PDFName, PDFDict, PDFRawStream, PDFRef } from "./vendor/pdf-lib.esm.min.js";

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const fileListEl = document.getElementById("fileList");
const actionsEl = document.getElementById("actions");
const compressBtn = document.getElementById("compressBtn");
const compressBtnLabel = document.getElementById("compressBtnLabel");
const clearBtn = document.getElementById("clearBtn");
const resultEl = document.getElementById("result");
const compressPanel = document.getElementById("compressPanel");
const compressMeta = document.getElementById("compressMeta");

// Tunable knobs for the v1 default — no UI for these, on purpose (ship one
// good default rather than a quality slider nobody asked for yet).
const JPEG_QUALITY = 0.65;
const MAX_DIMENSION = 1600; // longest side, in px, after downscale

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
  return div.innerHTML;
}

function baseName(fileName) {
  return fileName.replace(/\.pdf$/i, "");
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

function updateActions() {
  actionsEl.hidden = !loaded;
  compressPanel.hidden = !loaded;
  resultEl.hidden = true;
  if (!loaded) return;
  compressMeta.textContent = `${loaded.pageCount} page${loaded.pageCount === 1 ? "" : "s"} detected — we'll re-encode any embedded JPEGs`;
}

async function loadFile(file) {
  const bytes = await file.arrayBuffer();
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  loaded = { file, pageCount: doc.getPageCount() };
  renderFile();
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
  renderFile();
  updateActions();
});

/**
 * Reads a Filter entry (a PDFName, a PDFArray of PDFNames, or absent) and
 * returns the filter names as plain strings, e.g. ["/DCTDecode"].
 */
function filterNames(dict) {
  const filter = dict.get(PDFName.of("Filter"));
  if (!filter) return [];
  if (typeof filter.asArray === "function") {
    return filter.asArray().map((f) => String(f));
  }
  return [String(filter)];
}

/**
 * Decodes raw JPEG bytes in an <img>, draws them to an offscreen canvas
 * (downscaling if the longest side exceeds MAX_DIMENSION), and re-encodes
 * as JPEG at JPEG_QUALITY. Resolves to null if decoding fails or the result
 * isn't actually smaller — callers should keep the original bytes in that case.
 */
function recompressJpeg(bytes) {
  return new Promise((resolve) => {
    let url;
    try {
      url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
    } catch (e) {
      resolve(null);
      return;
    }

    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (!w || !h) {
          resolve(null);
          return;
        }
        const scale = Math.min(1, MAX_DIMENSION / Math.max(w, h));
        const outW = Math.max(1, Math.round(w * scale));
        const outH = Math.max(1, Math.round(h * scale));

        const canvas = document.createElement("canvas");
        canvas.width = outW;
        canvas.height = outH;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, 0, 0, outW, outH);

        canvas.toBlob(
          (outBlob) => {
            if (!outBlob) {
              resolve(null);
              return;
            }
            outBlob
              .arrayBuffer()
              .then((buf) => resolve(new Uint8Array(buf)))
              .catch(() => resolve(null));
          },
          "image/jpeg",
          JPEG_QUALITY
        );
      } catch (e) {
        resolve(null);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

/**
 * Walks every page's Resources -> XObject dict, finds JPEG-encoded image
 * streams (Filter /DCTDecode), and swaps each one's indirect object in place
 * for a re-encoded, smaller version. Overwriting the same ref (rather than
 * rewriting every XObject dict entry that points at it) means every page
 * sharing that image gets the compressed version automatically, and no
 * reference in the document is ever left dangling.
 */
async function compressImages(doc) {
  const processedRefs = new Set();
  let compressedCount = 0;
  let skippedCount = 0;

  for (const page of doc.getPages()) {
    let xObjects;
    try {
      const resources = page.node.Resources();
      xObjects = resources.lookupMaybe(PDFName.of("XObject"), PDFDict);
    } catch (e) {
      continue;
    }
    if (!xObjects) continue;

    for (const [, ref] of xObjects.entries()) {
      if (!(ref instanceof PDFRef)) continue; // inline (non-indirect) images: skip, rare
      const refKey = ref.toString();
      if (processedRefs.has(refKey)) continue;
      processedRefs.add(refKey);

      try {
        const stream = doc.context.lookup(ref);
        if (!(stream instanceof PDFRawStream)) continue;

        const dict = stream.dict;
        if (String(dict.get(PDFName.of("Subtype"))) !== "/Image") continue;
        if (!filterNames(dict).includes("/DCTDecode")) {
          skippedCount++;
          continue;
        }
        // Skip images with an SMask (soft-mask transparency) — flattening
        // through <canvas> would silently discard the alpha channel.
        if (dict.get(PDFName.of("SMask"))) {
          skippedCount++;
          continue;
        }
        // Skip CMYK JPEGs — browser <img>/<canvas> decoding of CMYK JPEG
        // data is unreliable and can shift colors badly.
        const colorSpace = dict.get(PDFName.of("ColorSpace"));
        if (colorSpace && String(colorSpace) === "/DeviceCMYK") {
          skippedCount++;
          continue;
        }

        const originalBytes = stream.getContents();
        const newBytes = await recompressJpeg(originalBytes);
        if (!newBytes || newBytes.length >= originalBytes.length) {
          skippedCount++;
          continue;
        }

        const newImage = await doc.embedJpg(newBytes);
        await newImage.embed(); // force the lazy embedder to materialize now
        const newObject = doc.context.lookup(newImage.ref);
        if (!newObject) {
          skippedCount++;
          continue;
        }
        doc.context.assign(ref, newObject);
        doc.context.delete(newImage.ref);
        compressedCount++;
      } catch (e) {
        skippedCount++;
      }
    }
  }

  return { compressedCount, skippedCount };
}

async function compressPdf() {
  const doc = await PDFDocument.load(await loaded.file.arrayBuffer(), { ignoreEncryption: true });
  const { compressedCount, skippedCount } = await compressImages(doc);

  // Even with zero compressible images, re-serializing through pdf-lib
  // (object streams on) often shaves some size off text/vector-only PDFs.
  const bytes = await doc.save({ useObjectStreams: true });

  return {
    blob: new Blob([bytes], { type: "application/pdf" }),
    fileName: `${baseName(loaded.file.name)}-compressed.pdf`,
    compressedCount,
    skippedCount,
    originalSize: loaded.file.size,
    newSize: bytes.length,
  };
}

compressBtn.addEventListener("click", async () => {
  compressBtn.disabled = true;
  const originalLabel = compressBtnLabel.textContent;
  compressBtnLabel.textContent = "Compressing…";
  resultEl.hidden = true;

  const startedAt = performance.now();
  const requestsBefore = requestsSinceLoad;

  try {
    const { blob, fileName, compressedCount, skippedCount, originalSize, newSize } = await compressPdf();
    const url = URL.createObjectURL(blob);
    const elapsedMs = Math.round(performance.now() - startedAt);
    const requestsDuring = requestsSinceLoad - requestsBefore;

    const reduced = originalSize - newSize;
    const pct = originalSize > 0 ? Math.round((reduced / originalSize) * 100) : 0;

    let sizeLine;
    if (reduced > 0) {
      sizeLine = `<strong>${formatSize(originalSize)} → ${formatSize(newSize)}</strong> (${pct}% smaller)`;
    } else {
      sizeLine = `<strong>${formatSize(originalSize)} → ${formatSize(newSize)}</strong> — no meaningful size reduction found for this file`;
    }

    const imageLine =
      compressedCount > 0
        ? `${compressedCount} image${compressedCount === 1 ? "" : "s"} re-encoded${
            skippedCount > 0 ? `, ${skippedCount} left as-is (not a compressible JPEG)` : ""
          }.`
        : `No compressible JPEG images found in this PDF — only re-serialized the file structure.`;

    resultEl.hidden = false;
    resultEl.className = "result";
    resultEl.innerHTML = `
      <span><strong>Done.</strong> ${sizeLine}. ${imageLine}
      ${elapsedMs}ms, ${requestsDuring} network requests, entirely on this device.</span>
      <a class="btn btn-primary" href="${url}" download="${fileName}">Download ${fileName}</a>
    `;
  } catch (err) {
    resultEl.hidden = false;
    resultEl.className = "result result-error";
    resultEl.innerHTML = `<span><strong>Compress failed.</strong> ${escapeHtml(
      err instanceof Error ? err.message : "This file may be corrupted or password-protected."
    )}</span>`;
  } finally {
    compressBtn.disabled = false;
    compressBtnLabel.textContent = originalLabel;
  }
});

const proForm = document.getElementById("proForm");
const proNote = document.getElementById("proNote");
proForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("proEmail").value.trim();
  if (!email) return;
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
