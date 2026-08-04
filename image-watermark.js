let _pdfLibPromise = null;
function getPdfLib() {
  if (!_pdfLibPromise) _pdfLibPromise = import("./vendor/pdf-lib.esm.min.js");
  return _pdfLibPromise;
}

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const fileListEl = document.getElementById("fileList");
const actionsEl = document.getElementById("actions");
const watermarkBtn = document.getElementById("watermarkBtn");
const watermarkBtnLabel = document.getElementById("watermarkBtnLabel");
const clearBtn = document.getElementById("clearBtn");
const resultEl = document.getElementById("result");
const wmPanel = document.getElementById("wmPanel");
const wmMeta = document.getElementById("wmMeta");

const imgDropzone = document.getElementById("imgDropzone");
const imgInput = document.getElementById("imgInput");
const imgFileListEl = document.getElementById("imgFileList");

const positionSelect = document.getElementById("positionSelect");
const scaleInput = document.getElementById("scaleInput");
const opacityInput = document.getElementById("opacityInput");

/** @type {{file: File, pageCount: number} | null} */
let loaded = null;
/** @type {{file: File, kind: "png" | "jpg"} | null} */
let logo = null;

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

function renderLogo() {
  imgFileListEl.innerHTML = "";
  if (!logo) return;
  const li = document.createElement("li");
  li.className = "file-row";
  li.innerHTML = `
    <span class="handle" aria-hidden="true">🖼</span>
    <span class="name">${escapeHtml(logo.file.name)} — ${logo.kind.toUpperCase()}</span>
    <span class="size">${formatSize(logo.file.size)}</span>
  `;
  const remove = document.createElement("button");
  remove.className = "remove";
  remove.type = "button";
  remove.setAttribute("aria-label", `Remove ${logo.file.name}`);
  remove.textContent = "✕";
  remove.addEventListener("click", () => {
    logo = null;
    imgInput.value = "";
    renderLogo();
    updateActions();
  });
  li.appendChild(remove);
  imgFileListEl.appendChild(li);
}

function updateActions() {
  actionsEl.hidden = !loaded;
  wmPanel.hidden = !loaded;
  resultEl.hidden = true;
  if (!loaded) return;
  wmMeta.textContent = `${loaded.pageCount} page${loaded.pageCount === 1 ? "" : "s"} detected`;
  watermarkBtn.disabled = !logo;
  watermarkBtnLabel.textContent = logo ? "Stamp image watermark" : "Add a logo image first";
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
    logo = null;
    fileInput.value = "";
    imgInput.value = "";
    renderFile();
    renderLogo();
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

/** Detect PNG vs JPEG by file signature (magic bytes), not just extension/MIME. */
async function detectImageKind(file) {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const isPng =
    head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  const isJpg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (isPng) return "png";
  if (isJpg) return "jpg";
  return null;
}

async function loadLogo(file) {
  const kind = await detectImageKind(file);
  if (!kind) {
    resultEl.hidden = false;
    resultEl.className = "result result-error";
    resultEl.setAttribute("role", "alert");
    resultEl.setAttribute("aria-live", "assertive");
    resultEl.innerHTML = `<span><strong>Couldn't add that logo.</strong> ${escapeHtml(
      file.name
    )} isn't a valid PNG or JPG file (checked by file signature, not just its name).</span>`;
    return;
  }
  logo = { file, kind };
  resultEl.hidden = true;
  renderLogo();
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

imgDropzone.addEventListener("click", () => imgInput.click());
imgDropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    imgInput.click();
  }
});
imgInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) loadLogo(file);
});

["dragenter", "dragover"].forEach((evt) =>
  imgDropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    imgDropzone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((evt) =>
  imgDropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    imgDropzone.classList.remove("dragover");
  })
);
imgDropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) loadLogo(file);
});

clearBtn.addEventListener("click", () => {
  loaded = null;
  logo = null;
  fileInput.value = "";
  imgInput.value = "";
  renderFile();
  renderLogo();
  updateActions();
});

function baseName(fileName) {
  return fileName.replace(/\.pdf$/i, "");
}

function readScalePct() {
  const value = parseFloat(scaleInput.value);
  if (!Number.isFinite(value) || value <= 0 || value > 100) {
    throw new Error("Enter a scale between 1 and 100 (% of page width).");
  }
  return value;
}

function readOpacityPct() {
  const value = parseInt(opacityInput.value, 10);
  if (!Number.isFinite(value) || value < 1 || value > 100) {
    throw new Error("Enter a valid opacity between 1 and 100.");
  }
  return value;
}

/** Anchor coordinates for the image's bottom-left corner, given a 9-slot grid. */
function computePosition(position, pageWidth, pageHeight, imgWidth, imgHeight) {
  const margin = Math.max(12, Math.min(pageWidth, pageHeight) * 0.03);
  const [vert, horiz] = position === "center" ? ["middle", "middle"] : position.split("-");

  let x;
  if (horiz === "left") x = margin;
  else if (horiz === "right") x = pageWidth - imgWidth - margin;
  else x = (pageWidth - imgWidth) / 2;

  let y;
  if (vert === "top") y = pageHeight - imgHeight - margin;
  else if (vert === "bottom") y = margin;
  else y = (pageHeight - imgHeight) / 2;

  return { x, y };
}

async function watermarkPdf() {
  const { PDFDocument } = await getPdfLib();
  if (!logo) throw new Error("Add a PNG or JPG logo image to stamp.");

  const scalePct = readScalePct();
  const opacityPct = readOpacityPct();
  const opacity = opacityPct / 100;
  const position = positionSelect.value;

  const doc = await PDFDocument.load(await loaded.file.arrayBuffer(), { ignoreEncryption: true });
  const logoBytes = await logo.file.arrayBuffer();
  const embedded = logo.kind === "png" ? await doc.embedPng(logoBytes) : await doc.embedJpg(logoBytes);
  const aspect = embedded.height / embedded.width;

  const pages = doc.getPages();
  let stamped = 0;

  pages.forEach((page) => {
    const { width, height } = page.getSize();
    const box = page.getMediaBox();
    const imgWidth = width * (scalePct / 100);
    const imgHeight = imgWidth * aspect;
    const { x, y } = computePosition(position, width, height, imgWidth, imgHeight);

    page.drawImage(embedded, {
      x: box.x + x,
      y: box.y + y,
      width: imgWidth,
      height: imgHeight,
      opacity,
    });
    stamped++;
  });

  if (stamped === 0) throw new Error("This PDF has no pages to watermark.");

  const bytes = await doc.save();
  return {
    blob: new Blob([bytes], { type: "application/pdf" }),
    fileName: `${baseName(loaded.file.name)}-image-watermarked.pdf`,
    stamped,
  };
}

watermarkBtn.addEventListener("click", async () => {
  watermarkBtn.disabled = true;
  const originalLabel = watermarkBtnLabel.textContent;
  watermarkBtnLabel.textContent = "Stamping…";
  resultEl.hidden = true;

  const startedAt = performance.now();
  const requestsBefore = requestsSinceLoad;

  try {
    const { blob, fileName, stamped } = await watermarkPdf();
    const url = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    const elapsedMs = Math.round(performance.now() - startedAt);
    const requestsDuring = requestsSinceLoad - requestsBefore;

    resultEl.hidden = false;
    resultEl.className = "result";
    resultEl.setAttribute("role", "status");
    resultEl.setAttribute("aria-live", "polite");
    resultEl.innerHTML = `
      <span><strong>Done.</strong> ${stamped} page${stamped === 1 ? "" : "s"} watermarked —
      ${elapsedMs}ms, ${requestsDuring} network requests, entirely on this device.</span>
      <a class="btn btn-primary" href="${url}" download="${escapeHtml(fileName)}">Download ${escapeHtml(fileName)}</a>
    `;
  } catch (err) {
    resultEl.hidden = false;
    resultEl.className = "result result-error";
    resultEl.setAttribute("role", "alert");
    resultEl.setAttribute("aria-live", "assertive");
    resultEl.innerHTML = `<span><strong>Watermarking failed.</strong> ${escapeHtml(
      err instanceof Error ? err.message : "This file may be corrupted or password-protected."
    )}</span>`;
  } finally {
    watermarkBtn.disabled = !logo;
    watermarkBtn.focus();
    watermarkBtnLabel.textContent = logo ? originalLabel : "Add a logo image first";
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
