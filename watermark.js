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
const wmTextInput = document.getElementById("wmTextInput");
const wmOpacityInput = document.getElementById("wmOpacityInput");

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

function currentAngle() {
  return parseInt(document.querySelector('input[name="wmAngle"]:checked').value, 10);
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
  wmPanel.hidden = !loaded;
  resultEl.hidden = true;
  if (!loaded) return;
  wmMeta.textContent = `${loaded.pageCount} page${loaded.pageCount === 1 ? "" : "s"} detected`;
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

/** Marks an error as a known, user-facing validation message (safe to show verbatim),
 * as opposed to a raw pdf-lib/parser exception (which must stay hidden from users). */
class ValidationError extends Error {}

async function watermarkPdf() {
  const { PDFDocument, StandardFonts, rgb, degrees } = await getPdfLib();
  const text = wmTextInput.value.trim();
  if (!text) throw new ValidationError("Enter some watermark text.");

  const opacityPct = parseInt(wmOpacityInput.value, 10);
  if (!Number.isFinite(opacityPct) || opacityPct < 1 || opacityPct > 100) {
    throw new ValidationError("Enter a valid opacity between 1 and 100.");
  }
  const opacity = opacityPct / 100;
  const angle = currentAngle();

  const doc = await PDFDocument.load(await loaded.file.arrayBuffer(), { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.HelveticaBold);

  // The built-in font only supports WinAnsi (Latin/Western) characters. Any other
  // character (CJK, emoji, Cyrillic, Arabic, unicode line separators, etc.) makes
  // pdf-lib throw deep inside drawText — without this pre-check that throw was
  // caught by the generic handler below and shown as "This file may be corrupted
  // or password-protected," which is wrong and confusing for what's actually a
  // watermark-text-input problem, not a file problem.
  try {
    font.widthOfTextAtSize(text, 1);
  } catch (e) {
    throw new ValidationError(
      "Watermark text has a character the built-in font can't render (only Latin/Western characters are supported). Remove emoji, non-Latin script, or special symbols and try again."
    );
  }

  const pages = doc.getPages();
  let stamped = 0;

  pages.forEach((page) => {
    const { width, height } = page.getSize();
    const box = page.getMediaBox();
    // Size the text to the page so it reads clearly without spilling too far
    // off the edges at typical letter/A4 dimensions.
    const fontSize = Math.max(24, Math.min(width, height) * 0.12);
    const textWidth = font.widthOfTextAtSize(text, fontSize);

    // pdf-lib's drawText rotates around the (x, y) anchor itself — the anchor
    // is the *baseline start* of the text, and it does not move when `rotate`
    // is applied (Tm = [cos, sin, -sin, cos, x, y]). So computing x/y for an
    // unrotated, horizontally-centered layout and then just adding `rotate`
    // does NOT keep the text centered: at +-45 degrees (the default angle
    // option in this tool) the visual centroid of the stamped text lands
    // roughly textWidth/2 away from the page center, both horizontally and
    // vertically — a large, visible offset, not a rounding error. To keep
    // the text centered at any angle, solve for the anchor that places the
    // text's local center point (textWidth/2, midY) at the page's true
    // center after the same rotation matrix pdf-lib applies.
    const angleRad = (angle * Math.PI) / 180;
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);
    const ascent = font.heightAtSize(fontSize, { descender: false });
    const fullHeight = font.heightAtSize(fontSize);
    const descent = fullHeight - ascent;
    const midY = (ascent - descent) / 2; // baseline -> visual vertical center
    const cx = box.x + width / 2;
    const cy = box.y + height / 2;
    const x = cx - cos * (textWidth / 2) + sin * midY;
    const y = cy - sin * (textWidth / 2) - cos * midY;

    page.drawText(text, {
      x,
      y,
      size: fontSize,
      font,
      color: rgb(0.4, 0.4, 0.4),
      opacity,
      rotate: degrees(angle),
    });
    stamped++;
  });

  if (stamped === 0) throw new ValidationError("This PDF has no pages to watermark.");

  const bytes = await doc.save();
  return {
    blob: new Blob([bytes], { type: "application/pdf" }),
    fileName: `${baseName(loaded.file.name)}-watermarked.pdf`,
    stamped,
  };
}

watermarkBtn.addEventListener("click", async () => {
  watermarkBtn.disabled = true;
  const originalLabel = watermarkBtnLabel.textContent;
  watermarkBtnLabel.textContent = "Watermarking…";
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
      err instanceof ValidationError ? err.message : "This file may be corrupted or password-protected."
    )}</span>`;
  } finally {
    watermarkBtn.disabled = false;
    watermarkBtn.focus();
    watermarkBtnLabel.textContent = originalLabel;
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
