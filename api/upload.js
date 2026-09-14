const MAX_FILE_SIZE = 3 * 1024 * 1024;
const MAX_FILES = 1000;
const MAX_TOTAL_SIZE = 20 * 1024 * 1024;

function json(res, status, data) {
  return res.status(status).json(data);
}

function cleanPath(input) {
  if (typeof input !== "string") {
    throw new Error("Path tidak valid.");
  }

  let path = input.trim().replace(/\\/g, "/");

  path = path
    .split("/")
    .filter(Boolean)
    .join("/");

  if (!path) {
    return "";
  }

  if (
    path.startsWith("/") ||
    path.includes("../") ||
    path === ".." ||
    path.includes("/..") ||
    path.includes("\0")
  ) {
    throw new Error("Path tidak valid atau mengandung path traversal.");
  }

  return path;
}

function parseRepository(repository) {
  if (typeof repository !== "string") {
    throw new Error("Repository wajib diisi.");
  }

  const value = repository
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");

  const parts = value.split("/");

  if (
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    parts[0].includes(" ") ||
    parts[1].includes(" ")
  ) {
    throw new Error(
      "Format repository harus owner/repo. Contoh: Henkarmazov/produk-topup"
    );
  }

  return {
    owner: parts[0],
    repo: parts[1]
  };
}

function getToken() {
  const token = process.env.GITHUB_TOKEN;

  if (!token) {
    throw new Error(
      "GITHUB_TOKEN belum dikonfigurasi di environment Vercel."
    );
  }

  return token;
}

async function githubRequest(path, options = {}) {
  const token = getToken();

  const response = await fetch(`https://api.github.com${path}`, {
    ...options,

    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "github-uploader",
      ...(options.headers || {})
    }
  });

  let data = null;

  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const error = new Error(
      data?.message || `GitHub API error: ${response.status}`
    );

    error.status = response.status;
    error.githubData = data;

    throw error;
  }

  return data;
}

function safeGithubError(error) {
  const status = error.status || 500;

  if (status === 401) {
    return {
      status: 401,
      message: "GitHub token tidak valid atau sudah kedaluwarsa."
    };
  }

  if (status === 403) {
    return {
      status: 403,
      message:
        "GitHub menolak request. Periksa permission token atau rate limit."
    };
  }

  if (status === 404) {
    return {
      status: 404,
      message:
        "Repository atau branch tidak ditemukan, atau token tidak memiliki akses."
    };
  }

  if (status === 409) {
    return {
      status: 409,
      message:
        "Repository sedang tidak dapat diproses. Jika repository masih kosong, buat minimal satu commit terlebih dahulu."
    };
  }

  if (status === 422) {
    return {
      status: 422,
      message:
        error.message ||
        "GitHub menolak data yang dikirim."
    };
  }

  return {
    status,
    message: error.message || "GitHub API mengalami error."
  };
}

function validateCommon(body) {
  const repository = parseRepository(body.repository);

  const branch =
    typeof body.branch === "string" && body.branch.trim()
      ? body.branch.trim()
      : "main";

  const folder = cleanPath(body.folder || "");

  const commitMessage =
    typeof body.commitMessage === "string" &&
    body.commitMessage.trim()
      ? body.commitMessage.trim().slice(0, 200)
      : "Upload files via GitHub Uploader";

  const mode = body.mode === "skip" ? "skip" : "replace";

  return {
    ...repository,
    branch,
    folder,
    commitMessage,
    mode
  };
}

async function getBranchState(owner, repo, branch) {
  const ref = await githubRequest(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`
  );

  const commitSha = ref.object.sha;

  const commit = await githubRequest(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${commitSha}`
  );

  const treeSha = commit.tree.sha;

  const tree = await githubRequest(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${treeSha}?recursive=1`
  );

  if (tree.truncated) {
    throw new Error(
      "Repository memiliki terlalu banyak file untuk diproses oleh uploader ini."
    );
  }

  const files = new Set();

  for (const item of tree.tree || []) {
    if (item.type === "blob") {
      files.add(item.path);
    }
  }

  return {
    commitSha,
    treeSha,
    files
  };
}

async function createBlob(owner, repo, content) {
  if (typeof content !== "string") {
    throw new Error("Content blob tidak valid.");
  }

  const byteLength = Buffer.byteLength(content, "base64");

  if (byteLength > MAX_FILE_SIZE) {
    throw new Error(
      `File melebihi batas ${MAX_FILE_SIZE / 1024 / 1024} MB.`
    );
  }

  const data = await githubRequest(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`,
    {
      method: "POST",

      body: JSON.stringify({
        content,
        encoding: "base64"
      }),

      headers: {
        "Content-Type": "application/json"
      }
    }
  );

  return data.sha;
}

async function createCommit({
  owner,
  repo,
  branch,
  baseCommitSha,
  baseTreeSha,
  entries,
  commitMessage
}) {
  const treeData = await githubRequest(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`,
    {
      method: "POST",

      body: JSON.stringify({
        base_tree: baseTreeSha,

        tree: entries.map((entry) => ({
          path: entry.path,
          mode: "100644",
          type: "blob",
          sha: entry.sha
        }))
      }),

      headers: {
        "Content-Type": "application/json"
      }
    }
  );

  const commitData = await githubRequest(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`,
    {
      method: "POST",

      body: JSON.stringify({
        message: commitMessage,
        tree: treeData.sha,
        parents: [baseCommitSha]
      }),

      headers: {
        "Content-Type": "application/json"
      }
    }
  );

  await githubRequest(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/heads/${encodeURIComponent(branch)}`,
    {
      method: "PATCH",

      body: JSON.stringify({
        sha: commitData.sha,
        force: false
      }),

      headers: {
        "Content-Type": "application/json"
      }
    }
  );

  return {
    commitSha: commitData.sha,
    treeSha: treeData.sha
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return json(res, 405, {
      success: false,
      message: "Method tidak diizinkan."
    });
  }

  try {
    const body = req.body || {};

    if (!body.action) {
      return json(res, 400, {
        success: false,
        message: "Action tidak ditemukan."
      });
    }

    const config = validateCommon(body);

    /*
     * PREPARE
     */

    if (body.action === "prepare") {
      const state = await getBranchState(
        config.owner,
        config.repo,
        config.branch
      );

      return json(res, 200, {
        success: true,
        owner: config.owner,
        repo: config.repo,
        branch: config.branch,
        folder: config.folder,
        baseCommitSha: state.commitSha,
        baseTreeSha: state.treeSha,
        existingFiles: Array.from(state.files)
      });
    }

    /*
     * BLOB
     */

    if (body.action === "blob") {
      const path = cleanPath(body.path);

      if (!path) {
        return json(res, 400, {
          success: false,
          message: "Path file kosong."
        });
      }

      const content = body.content;

      if (typeof content !== "string") {
        return json(res, 400, {
          success: false,
          message: "Content file tidak valid."
        });
      }

      const byteLength = Buffer.byteLength(content, "base64");

      if (byteLength > MAX_FILE_SIZE) {
        return json(res, 413, {
          success: false,
          message:
            `File "${path}" melebihi batas ` +
            `${MAX_FILE_SIZE / 1024 / 1024} MB.`
        });
      }

      const sha = await createBlob(
        config.owner,
        config.repo,
        content
      );

      return json(res, 200, {
        success: true,
        path,
        sha
      });
    }

    /*
     * COMMIT
     */

    if (body.action === "commit") {
      const entries = Array.isArray(body.entries)
        ? body.entries
        : [];

      if (!entries.length) {
        return json(res, 400, {
          success: false,
          message: "Tidak ada file yang akan di-commit."
        });
      }

      if (entries.length > MAX_FILES) {
        return json(res, 400, {
          success: false,
          message: `Maksimum ${MAX_FILES} file per upload.`
        });
      }

      const baseCommitSha = body.baseCommitSha;
      const baseTreeSha = body.baseTreeSha;

      if (
        typeof baseCommitSha !== "string" ||
        typeof baseTreeSha !== "string"
      ) {
        return json(res, 400, {
          success: false,
          message: "Informasi base commit tidak valid."
        });
      }

      const normalizedEntries = [];
      const seen = new Set();

      for (const entry of entries) {
        if (
          !entry ||
          typeof entry.path !== "string" ||
          typeof entry.sha !== "string"
        ) {
          return json(res, 400, {
            success: false,
            message: "Entry commit tidak valid."
          });
        }

        const path = cleanPath(entry.path);

        if (!path) {
          return json(res, 400, {
            success: false,
            message: "Path commit kosong."
          });
        }

        if (seen.has(path)) {
          return json(res, 400, {
            success: false,
            message: `Path duplikat: ${path}`
          });
        }

        seen.add(path);

        normalizedEntries.push({
          path,
          sha: entry.sha
        });
      }

      const result = await createCommit({
        owner: config.owner,
        repo: config.repo,
        branch: config.branch,
        baseCommitSha,
        baseTreeSha,
        entries: normalizedEntries,
        commitMessage: config.commitMessage
      });

      return json(res, 200, {
        success: true,
        ...result,
        repository: `${config.owner}/${config.repo}`,
        branch: config.branch,
        githubUrl:
          `https://github.com/${config.owner}/${config.repo}` +
          `/commit/${result.commitSha}`
      });
    }

    return json(res, 400, {
      success: false,
      message: "Action tidak dikenal."
    });

  } catch (error) {
    console.error("GitHub Uploader Error:", error);

    const safe = safeGithubError(error);

    return json(res, safe.status, {
      success: false,
      message: safe.message
    });
  }
};
