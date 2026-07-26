import { PDFDocument } from "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm";

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
      <span class="handle">⠿</span>
      <span class="name">${i + 1}. ${escapeHtml(entry.file.name)}</span>
      <span class="size">${formatSize(entry.file.size)}</span>
      <button class="remove" type="button" aria-label="Remove ${escapeHtml(entry.file.name)}">✕</button>
    `;

    li.querySelector(".remove").addEventListener("click", () => {
      files = files.filter((f) => f.id !== entry.id);
      renderList();
      updateActions();
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
  return div.innerHTML;
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

  try {
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

    resultEl.hidden = false;
    resultEl.className = "result";
    resultEl.innerHTML = `
      <span><strong>Done.</strong> ${files.length} files merged, ${merged.getPageCount()} pages total.</span>
      <a class="btn btn-primary" href="${url}" download="merged.pdf">Download merged.pdf</a>
    `;
  } catch (err) {
    resultEl.hidden = false;
    resultEl.className = "result result-error";
    resultEl.innerHTML = `<span><strong>Merge failed.</strong> ${escapeHtml(
      err instanceof Error ? err.message : "One of these files may be corrupted or password-protected."
    )}</span>`;
  } finally {
    mergeBtn.disabled = files.length < 2;
    mergeBtnLabel.textContent = `Merge ${files.length} PDFs`;
  }
});

const proForm = document.getElementById("proForm");
const proNote = document.getElementById("proNote");
proForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const email = document.getElementById("proEmail").value.trim();
  if (!email) return;
  const saved = JSON.parse(localStorage.getItem("clientpdf_waitlist") || "[]");
  saved.push({ email, at: new Date().toISOString() });
  localStorage.setItem("clientpdf_waitlist", JSON.stringify(saved));
  proForm.hidden = true;
  proNote.hidden = false;
});
