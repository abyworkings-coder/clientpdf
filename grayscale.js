let _pdfLibPromise = null;
function getPdfLib() {
  if (!_pdfLibPromise) _pdfLibPromise = import("./vendor/pdf-lib.esm.min.js");
  return _pdfLibPromise;
}

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const fileListEl = document.getElementById("fileList");
const actionsEl = document.getElementById("actions");
const grayscaleBtn = document.getElementById("grayscaleBtn");
const grayscaleBtnLabel = document.getElementById("grayscaleBtnLabel");
const clearBtn = document.getElementById("clearBtn");
const resultEl = document.getElementById("result");
const grayscalePanel = document.getElementById("grayscalePanel");
const grayscaleMeta = document.getElementById("grayscaleMeta");

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

function updateActions() {
  actionsEl.hidden = !loaded;
  grayscalePanel.hidden = !loaded;
  resultEl.hidden = true;
  if (!loaded) return;
  grayscaleMeta.textContent = `${loaded.pageCount} page${loaded.pageCount === 1 ? "" : "s"} detected`;
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

function baseName(fileName) {
  return fileName.replace(/\.pdf$/i, "");
}

// --- Grayscale conversion core ------------------------------------------
//
// Content streams are PDF's own little postscript-like language. Color is
// set with operators: "R G B rg" (fill, RGB), "R G B RG" (stroke, RGB),
// "C M Y K k" (fill, CMYK), "C M Y K K" (stroke, CMYK). We decode each
// content stream to a latin1 string (1 byte = 1 char, safe for tokenizing
// binary-safe PDF operator soup), rewrite those four operators to their
// grayscale equivalents ("g" / "G") using the standard luminosity formula,
// and leave everything else — including "g"/"G" (already grayscale),
// "sc"/"SC"/"scn"/"SCN" (pattern/Separation/ICCBased colorspaces, which
// can't be safely reinterpreted without the page's /ColorSpace resource
// dictionary), and image XObject data — untouched.
//
// Re-encoding: rather than re-compressing the rewritten stream (which would
// mean vendoring a deflate implementation or leaning on browser
// Compression/DecompressionStream just to shave a few KB back off), we
// write the modified content stream back uncompressed and drop its
// /Filter entry. pdf-lib updates /Length automatically from the new
// content when the document is saved. This trades a slightly larger file
// for zero new dependencies and zero compression-roundtrip risk — the
// boring, robust choice.

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function luminosityFromRgb(r, g, b) {
  return clamp01(0.3 * r + 0.59 * g + 0.11 * b);
}

function cmykToGray(c, m, y, k) {
  const r = (1 - c) * (1 - k);
  const g = (1 - m) * (1 - k);
  const b = (1 - y) * (1 - k);
  return luminosityFromRgb(r, g, b);
}

function fmtNum(n) {
  n = clamp01(n);
  let s = n.toFixed(4);
  if (s.indexOf(".") !== -1) {
    s = s.replace(/0+$/, "").replace(/\.$/, "");
  }
  if (s === "" || s === "-0") s = "0";
  return s;
}

const NUM = "[+-]?(?:\\d*\\.\\d+|\\d+\\.?\\d*)";

function convertContentToGrayscale(str) {
  const converted = { rg: 0, RG: 0, k: 0, K: 0 };

  const rgRe = new RegExp(`(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+rg(?![A-Za-z0-9])`, "g");
  str = str.replace(rgRe, (m, r, g, b) => {
    converted.rg++;
    const y = luminosityFromRgb(parseFloat(r), parseFloat(g), parseFloat(b));
    return `${fmtNum(y)} g`;
  });

  const RGRe = new RegExp(`(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+RG(?![A-Za-z0-9])`, "g");
  str = str.replace(RGRe, (m, r, g, b) => {
    converted.RG++;
    const y = luminosityFromRgb(parseFloat(r), parseFloat(g), parseFloat(b));
    return `${fmtNum(y)} G`;
  });

  const kRe = new RegExp(`(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+k(?![A-Za-z0-9])`, "g");
  str = str.replace(kRe, (m, c, mm, y, k) => {
    converted.k++;
    const gray = cmykToGray(parseFloat(c), parseFloat(mm), parseFloat(y), parseFloat(k));
    return `${fmtNum(gray)} g`;
  });

  const KRe = new RegExp(`(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})\\s+K(?![A-Za-z0-9])`, "g");
  str = str.replace(KRe, (m, c, mm, y, k) => {
    converted.K++;
    const gray = cmykToGray(parseFloat(c), parseFloat(mm), parseFloat(y), parseFloat(k));
    return `${fmtNum(gray)} G`;
  });

  return { str, converted };
}

function bytesToLatin1(bytes) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return s;
}

function latin1ToBytes(str) {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
  return bytes;
}

async function collectContentStreams(page) {
  const { PDFArray, PDFStream } = await getPdfLib();
  const contentsObj = page.node.Contents();
  if (!contentsObj) return [];
  if (contentsObj instanceof PDFArray) {
    const streams = [];
    for (let i = 0; i < contentsObj.size(); i++) {
      const s = contentsObj.lookup(i, PDFStream);
      if (s) streams.push(s);
    }
    return streams;
  }
  return [contentsObj];
}

/** Marks an error as a known, user-facing validation message (safe to show verbatim),
 * as opposed to a raw pdf-lib/parser exception (which must stay hidden from users). */
class ValidationError extends Error {}

async function grayscalePdf() {
  const { PDFDocument, PDFRawStream, PDFName, decodePDFRawStream } = await getPdfLib();
  const doc = await PDFDocument.load(await loaded.file.arrayBuffer(), { ignoreEncryption: true });
  const pages = doc.getPages();

  let opsConverted = 0;
  let streamsTouched = 0;

  for (const page of pages) {
    const streams = await collectContentStreams(page);
    for (const stream of streams) {
      if (!(stream instanceof PDFRawStream)) continue;

      const decoded = decodePDFRawStream(stream).decode();
      const text = bytesToLatin1(decoded);
      const { str: newText, converted } = convertContentToGrayscale(text);
      const total = converted.rg + converted.RG + converted.k + converted.K;
      if (total === 0) continue;

      stream.contents = latin1ToBytes(newText);
      stream.dict.delete(PDFName.of("Filter"));
      stream.dict.delete(PDFName.of("DecodeParms"));

      opsConverted += total;
      streamsTouched++;
    }
  }

  if (opsConverted === 0) {
    throw new ValidationError(
      "No RGB or CMYK color operators found to convert — this PDF may already be grayscale, or its color comes from patterns/spot colors/embedded images, which this tool intentionally leaves untouched."
    );
  }

  const bytes = await doc.save();

  return {
    blob: new Blob([bytes], { type: "application/pdf" }),
    fileName: `${baseName(loaded.file.name)}-grayscale.pdf`,
    pageCount: pages.length,
    opsConverted,
    streamsTouched,
  };
}

grayscaleBtn.addEventListener("click", async () => {
  grayscaleBtn.disabled = true;
  const originalLabel = grayscaleBtnLabel.textContent;
  grayscaleBtnLabel.textContent = "Converting…";
  resultEl.hidden = true;

  const startedAt = performance.now();
  const requestsBefore = requestsSinceLoad;

  try {
    const { blob, fileName, pageCount, opsConverted } = await grayscalePdf();
    const url = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    const elapsedMs = Math.round(performance.now() - startedAt);
    const requestsDuring = requestsSinceLoad - requestsBefore;

    resultEl.hidden = false;
    resultEl.className = "result";
    resultEl.setAttribute("role", "status");
    resultEl.setAttribute("aria-live", "polite");
    resultEl.innerHTML = `
      <span><strong>Done.</strong> ${opsConverted} color operator${opsConverted === 1 ? "" : "s"} converted across ${pageCount} page${pageCount === 1 ? "" : "s"} —
      ${elapsedMs}ms, ${requestsDuring} network requests, entirely on this device.</span>
      <a class="btn btn-primary" href="${url}" download="${escapeHtml(fileName)}">Download ${escapeHtml(fileName)}</a>
    `;
  } catch (err) {
    resultEl.hidden = false;
    resultEl.className = "result result-error";
    resultEl.setAttribute("role", "alert");
    resultEl.setAttribute("aria-live", "assertive");
    resultEl.innerHTML = `<span><strong>Grayscale conversion failed.</strong> ${escapeHtml(
      err instanceof ValidationError ? err.message : "This file may be corrupted or password-protected."
    )}</span>`;
  } finally {
    grayscaleBtn.disabled = false;
    grayscaleBtn.focus();
    grayscaleBtnLabel.textContent = originalLabel;
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
