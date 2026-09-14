const MAX_FILE_SIZE = 3 * 1024 * 1024;
const MAX_FILES = 1000;
const MAX_TOTAL_SIZE = 20 * 1024 * 1024;

const state = {
  mode: "files",
  files: [],
  existingFiles: new Set(),
  baseCommitSha: null,
  baseTreeSha: null,
  uploading: false
};

const repositoryInput = document.getElementById("repository");
const branchInput = document.getElementById("branch");
const folderInput = document.getElementById("folder");
const commitInput = document.getElementById("commitMessage");

const fileInput = document.getElementById("fileInput");
const chooseButton = document.getElementById("chooseButton");
const dropZone = document.getElementById("dropZone");
const fileList = document.getElementById("fileList");

const zipOptions = document.getElementById("zipOptions");

const uploadButton = document.getElementById("uploadButton");
const clearButton = document.getElementById("clearButton");

const progressCard = document.getElementById("progressCard");
const progressFill = document.getElementById("progressFill");
const progressPercent = document.getElementById("progressPercent");
const progressText = document.getElementById("progressText");
const progressTitle = document.getElementById("progressTitle");

const statusCard = document.getElementById("statusCard");
const statusIcon = document.getElementById("statusIcon");
const statusTitle = document.getElementById("statusTitle");
const statusMessage = document.getElementById("statusMessage");

const resultCard = document.getElementById("resultCard");
const resultRepository = document.getElementById("resultRepository");
const resultCommit = document.getElementById("resultCommit");
const resultUploaded = document.getElementById("resultUploaded");
const resultSkipped = document.getElementById("resultSkipped");
const resultErrors = document.getElementById("resultErrors");
const githubLink = document.getElementById("githubLink");

const tabs = document.querySelectorAll(".tab");

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );

  return `${(bytes / Math.pow(1024, index)).toFixed(
    index === 0 ? 0 : 1
  )} ${units[index]}`;
}

function normalizePath(path) {
  if (typeof path !== "string") {
    throw new Error("Path file tidak valid.");
  }

  let clean = path
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);

  if (
    clean.includes("..") ||
    clean.some((part) => part === ".") ||
    path.startsWith("/")
  ) {
    throw new Error(`Path tidak aman: ${path}`);
  }

  clean = clean.filter((part) => part.trim() !== "");

  if (!clean.length) {
    throw new Error("Path file kosong.");
  }

  return clean.join("/");
}

function normalizeFolder(folder) {
  if (!folder) {
    return "";
  }

  const clean = normalizePath(folder);

  if (clean.includes("..")) {
    throw new Error("Folder tujuan tidak boleh mengandung ../");
  }

  return clean;
}

function joinPath(folder, filePath) {
  const cleanFile = normalizePath(filePath);

  if (!folder) {
    return cleanFile;
  }

  return `${folder}/${cleanFile}`;
}

function parseRepository(value) {
  const clean = value
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");

  const parts = clean.split("/");

  if (
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1]
  ) {
    throw new Error(
      "Repository harus menggunakan format owner/repo."
    );
  }

  return {
    owner: parts[0],
    repo: parts[1]
  };
}

function getExistingMode() {
  return document.querySelector(
    'input[name="existingMode"]:checked'
  ).value;
}

function getZipMode() {
  return document.querySelector(
    'input[name="zipMode"]:checked'
  ).value;
}

function setStatus(type, title, message) {
  statusCard.classList.remove("hidden");

  statusTitle.textContent = title;
  statusMessage.textContent = message;

  if (type === "success") {
    statusIcon.textContent = "✓";
  } else if (type === "error") {
    statusIcon.textContent = "!";
  } else {
    statusIcon.textContent = "•";
  }
}

function hideStatus() {
  statusCard.classList.add("hidden");
}

function updateProgress(current, total) {
  const percent =
    total > 0
      ? Math.round((current / total) * 100)
      : 0;

  progressFill.style.width = `${percent}%`;
  progressPercent.textContent = `${percent}%`;
  progressText.textContent = `${current} / ${total} files`;
}

function showProgress(title = "Uploading...") {
  progressTitle.textContent = title;
  progressCard.classList.remove("hidden");
  updateProgress(0, state.files.length);
}

function hideProgress() {
  progressCard.classList.add("hidden");
}

function setBusy(value) {
  state.uploading = value;

  uploadButton.disabled = value;
  clearButton.disabled = value;
  chooseButton.disabled = value;

  if (value) {
    uploadButton.textContent = "Uploading...";
  } else {
    uploadButton.textContent = "Upload to GitHub";
  }
}

function renderFiles() {
  fileList.innerHTML = "";

  if (!state.files.length) {
    return;
  }

  for (const item of state.files) {
    const row = document.createElement("div");
    row.className = "file-item";

    const info = document.createElement("div");
    info.className = "file-info";

    const name = document.createElement("div");
    name.className = "file-name";
    name.textContent = item.path;

    const size = document.createElement("div");
    size.className = "file-size";
    size.textContent = formatBytes(item.file.size);

    info.appendChild(name);
    info.appendChild(size);

    const remove = document.createElement("button");
    remove.className = "remove-file";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "Remove file";

    remove.addEventListener("click", () => {
      state.files = state.files.filter(
        (entry) => entry.id !== item.id
      );

      renderFiles();
    });

    row.appendChild(info);
    row.appendChild(remove);

    fileList.appendChild(row);
  }
}

function addFile(file, path = null) {
  if (!(file instanceof File)) {
    return;
  }

  if (!file.size) {
    throw new Error(`File kosong tidak dapat diupload: ${file.name}`);
  }

  if (file.size > MAX_FILE_SIZE) {
    throw new Error(
      `${file.name} terlalu besar. Maksimum ${formatBytes(MAX_FILE_SIZE)} per file.`
    );
  }

  let cleanPath = path;

  if (!cleanPath) {
    cleanPath = file.webkitRelativePath || file.name;
  }

  cleanPath = normalizePath(cleanPath);

  const duplicate = state.files.some(
    (entry) => entry.path === cleanPath
  );

  if (duplicate) {
    return;
  }

  state.files.push({
    id: crypto.randomUUID(),
    file,
    path: cleanPath
  });
}

function addFiles(files) {
  const incoming = Array.from(files);

  if (!incoming.length) {
    return;
  }

  let totalSize =
    state.files.reduce(
      (total, item) => total + item.file.size,
      0
    );

  for (const file of incoming) {
    if (state.files.length >= MAX_FILES) {
      throw new Error(
        `Maksimum ${MAX_FILES} file per upload.`
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      throw new Error(
        `${file.name} terlalu besar. Maksimum ${formatBytes(MAX_FILE_SIZE)}.`
      );
    }

    totalSize += file.size;

    if (totalSize > MAX_TOTAL_SIZE) {
      throw new Error(
        `Total upload melebihi ${formatBytes(MAX_TOTAL_SIZE)}.`
      );
    }

    const relativePath =
      file.webkitRelativePath || file.name;

    addFile(file, relativePath);
  }

  renderFiles();
}

async function extractZip(zipFile) {
  if (!window.JSZip) {
    throw new Error("Library ZIP belum siap. Coba lagi.");
  }

  let zip;

  try {
    zip = await JSZip.loadAsync(zipFile);
  } catch {
    throw new Error(
      "ZIP tidak dapat dibaca. Pastikan file ZIP tidak rusak."
    );
  }

  const entries = Object.values(zip.files);

  const files = [];

  for (const entry of entries) {
    if (entry.dir) {
      continue;
    }

    let path;

    try {
      path = normalizePath(entry.name);
    } catch {
      throw new Error(
        `ZIP mengandung path yang tidak aman: ${entry.name}`
      );
    }

    const blob = await entry.async("blob");

    if (blob.size > MAX_FILE_SIZE) {
      throw new Error(
        `${path} terlalu besar setelah diekstrak. Maksimum ${formatBytes(MAX_FILE_SIZE)}.`
      );
    }

    const file = new File(
      [blob],
      path.split("/").pop() || "file",
      {
        type: blob.type || "application/octet-stream"
      }
    );

    files.push({
      file,
      path
    });
  }

  if (!files.length) {
    throw new Error("ZIP tidak memiliki file.");
  }

  if (files.length > MAX_FILES) {
    throw new Error(
      `ZIP memiliki terlalu banyak file. Maksimum ${MAX_FILES}.`
    );
  }

  const totalSize = files.reduce(
    (sum, item) => sum + item.file.size,
    0
  );

  if (totalSize > MAX_TOTAL_SIZE) {
    throw new Error(
      `Total file hasil ekstraksi melebihi ${formatBytes(MAX_TOTAL_SIZE)}.`
    );
  }

  return files;
}

async function handleSelectedFiles(files) {
  if (!files || !files.length) {
    return;
  }

  try {
    hideStatus();

    if (state.mode === "zip") {
      if (files.length !== 1) {
        throw new Error(
          "Mode ZIP hanya menerima satu file ZIP."
        );
      }

      const zipFile = files[0];

      if (!zipFile.name.toLowerCase().endsWith(".zip")) {
        throw new Error("File yang dipilih bukan ZIP.");
      }

      if (getZipMode() === "extract") {
        const extracted = await extractZip(zipFile);

        state.files = [];

        for (const item of extracted) {
          addFile(item.file, item.path);
        }
      } else {
        state.files = [];

        addFile(zipFile, zipFile.name);
      }

      renderFiles();
      return;
    }

    addFiles(files);
  } catch (error) {
    setStatus(
      "error",
      "Upload tidak dapat diproses",
      error.message
    );
  }
}

function setInputMode(mode) {
  state.mode = mode;

  tabs.forEach((tab) => {
    tab.classList.toggle(
      "active",
      tab.dataset.mode === mode
    );
  });

  fileInput.value = "";

  if (mode === "files") {
    fileInput.multiple = true;
    fileInput.removeAttribute("webkitdirectory");

    document.getElementById("dropTitle").textContent =
      "Drop files here";

    document.getElementById("dropDescription").textContent =
      "Atau pilih satu atau beberapa file.";

    chooseButton.textContent = "Choose files";

    zipOptions.classList.add("hidden");
  }

  if (mode === "folder") {
    fileInput.multiple = true;
    fileInput.setAttribute("webkitdirectory", "");

    document.getElementById("dropTitle").textContent =
      "Choose a folder";

    document.getElementById("dropDescription").textContent =
      "Struktur folder akan dipertahankan.";

    chooseButton.textContent = "Choose folder";

    zipOptions.classList.add("hidden");
  }

  if (mode === "zip") {
    fileInput.multiple = false;
    fileInput.removeAttribute("webkitdirectory");

    document.getElementById("dropTitle").textContent =
      "Choose ZIP file";

    document.getElementById("dropDescription").textContent =
      "ZIP dapat diekstrak atau diupload sebagai file.";

    chooseButton.textContent = "Choose ZIP";

    zipOptions.classList.remove("hidden");
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);

  let binary = "";

  const chunkSize = 0x8000;

  for (
    let i = 0;
    i < bytes.length;
    i += chunkSize
  ) {
    const chunk = bytes.subarray(
      i,
      Math.min(i + chunkSize, bytes.length)
    );

    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

async function fileToBase64(file) {
  const buffer = await file.arrayBuffer();

  return arrayBufferToBase64(buffer);
}

async function apiRequest(payload) {
  const response = await fetch("/api/upload", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error(
      `Server mengembalikan response tidak valid (${response.status}).`
    );
  }

  if (!response.ok || !data.success) {
    throw new Error(
      data.message ||
      `Request gagal (${response.status}).`
    );
  }

  return data;
}

async function prepareUpload() {
  const repository = repositoryInput.value.trim();
  const branch = branchInput.value.trim();
  const folder = normalizeFolder(
    folderInput.value.trim()
  );

  if (!repository) {
    throw new Error("Repository wajib diisi.");
  }

  parseRepository(repository);

  if (!branch) {
    throw new Error("Branch wajib diisi.");
  }

  if (!state.files.length) {
    throw new Error("Pilih minimal satu file.");
  }

  return apiRequest({
    action: "prepare",
    repository,
    branch,
    folder
  });
}

async function uploadBlob({
  repository,
  branch,
  folder,
  item
}) {
  const content = await fileToBase64(item.file);

  const path = joinPath(folder, item.path);

  return apiRequest({
    action: "blob",
    repository,
    branch,
    folder,
    path,
    content
  });
}

async function commitUpload({
  repository,
  branch,
  folder,
  entries,
  baseCommitSha,
  baseTreeSha,
  commitMessage
}) {
  return apiRequest({
    action: "commit",
    repository,
    branch,
    folder,
    entries,
    baseCommitSha,
    baseTreeSha,
    commitMessage,
    mode: getExistingMode()
  });
}

async function uploadAll() {
  if (state.uploading) {
    return;
  }

  resultCard.classList.add("hidden");
  hideStatus();

  setBusy(true);

  try {
    const repository = repositoryInput.value.trim();
    const branch = branchInput.value.trim();
    const folder = normalizeFolder(
      folderInput.value.trim()
    );

    const commitMessage =
      commitInput.value.trim() ||
      "Upload files via GitHub Uploader";

    if (!repository) {
      throw new Error("Repository wajib diisi.");
    }

    parseRepository(repository);

    if (!branch) {
      throw new Error("Branch wajib diisi.");
    }

    if (!state.files.length) {
      throw new Error("Pilih minimal satu file.");
    }

    showProgress("Checking repository...");

    const prepared = await prepareUpload();

    state.existingFiles = new Set(
      prepared.existingFiles || []
    );

    state.baseCommitSha = prepared.baseCommitSha;
    state.baseTreeSha = prepared.baseTreeSha;

    const mode = getExistingMode();

    const uploadQueue = [];
    const skipped = [];

    for (const item of state.files) {
      const finalPath = joinPath(
        folder,
        item.path
      );

      if (
        mode === "skip" &&
        state.existingFiles.has(finalPath)
      ) {
        skipped.push({
          path: finalPath
        });

        continue;
      }

      uploadQueue.push({
        ...item,
        finalPath
      });
    }

    if (!uploadQueue.length) {
      hideProgress();

      setStatus(
        "success",
        "Tidak ada file yang diupload",
        `${skipped.length} file dilewati karena sudah ada.`
      );

      showResult({
        repository,
        commitSha: null,
        uploaded: 0,
        skipped: skipped.length,
        errors: 0,
        githubUrl: `https://github.com/${repository}`
      });

      return;
    }

    showProgress("Uploading files...");

    const entries = [];
    const errors = [];

    let completed = 0;

    for (const item of uploadQueue) {
      try {
        const result = await uploadBlob({
          repository,
          branch,
          folder,
          item
        });

        entries.push({
          path: item.finalPath,
          sha: result.sha
        });
      } catch (error) {
        errors.push({
          path: item.finalPath,
          message: error.message
        });
      }

      completed++;

      updateProgress(
        completed,
        uploadQueue.length
      );
    }

    if (!entries.length) {
      throw new Error(
        "Semua file gagal diupload sebagai Git blob."
      );
    }

    progressTitle.textContent =
      "Creating GitHub commit...";

    const result = await commitUpload({
      repository,
      branch,
      folder,
      entries,
      baseCommitSha: state.baseCommitSha,
      baseTreeSha: state.baseTreeSha,
      commitMessage
    });

    hideProgress();

    showResult({
      repository,
      commitSha: result.commitSha,
      uploaded: entries.length,
      skipped: skipped.length,
      errors: errors.length,
      githubUrl: result.githubUrl
    });

    if (errors.length) {
      setStatus(
        "success",
        "Upload selesai dengan beberapa error",
        errors
          .map(
            (error) =>
              `${error.path}: ${error.message}`
          )
          .join(" | ")
      );
    } else {
      setStatus(
        "success",
        "Upload completed",
        `${entries.length} file berhasil diupload.`
      );
    }
  } catch (error) {
    hideProgress();

    setStatus(
      "error",
      "Upload gagal",
      error.message
    );
  } finally {
    setBusy(false);
  }
}

function showResult({
  repository,
  commitSha,
  uploaded,
  skipped,
  errors,
  githubUrl
}) {
  resultCard.classList.remove("hidden");

  resultRepository.textContent = repository;

  resultCommit.textContent =
    commitSha || "-";

  resultUploaded.textContent =
    `${uploaded} files`;

  resultSkipped.textContent =
    `${skipped} files`;

  resultErrors.textContent =
    `${errors} files`;

  githubLink.href = githubUrl;
}

function clearAll() {
  if (state.uploading) {
    return;
  }

  state.files = [];
  state.existingFiles = new Set();
  state.baseCommitSha = null;
  state.baseTreeSha = null;

  fileInput.value = "";

  renderFiles();
  hideStatus();
  hideProgress();

  resultCard.classList.add("hidden");
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    setInputMode(tab.dataset.mode);
  });
});

chooseButton.addEventListener("click", () => {
  fileInput.click();
});

fileInput.addEventListener("change", async () => {
  await handleSelectedFiles(fileInput.files);
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("dragging");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("dragging");
});

dropZone.addEventListener("drop", async (event) => {
  event.preventDefault();

  dropZone.classList.remove("dragging");

  await handleSelectedFiles(
    event.dataTransfer.files
  );
});

uploadButton.addEventListener(
  "click",
  uploadAll
);

clearButton.addEventListener(
  "click",
  clearAll
);

setInputMode("files");
renderFiles();