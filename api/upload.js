const { Octokit } = require("@octokit/rest");

const MAX_FILE_SIZE = 3 * 1024 * 1024;
const MAX_FILES = 1000;
const MAX_TOTAL_SIZE = 20 * 1024 * 1024;

function json(res, status, data) {
  res.status(status).json(data);
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

function getOctokit() {
  const token = process.env.GITHUB_TOKEN;

  if (!token) {
    throw new Error(
      "GITHUB_TOKEN belum dikonfigurasi di environment Vercel."
    );
  }

  return new Octokit({
    auth: token,
    request: {
      timeout: 30000
    },
    headers: {
      "X-GitHub-Api-Version": "2026-03-10"
    }
  });
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
        "GitHub menolak data yang dikirim. Periksa branch, path, atau struktur repository."
    };
  }

  return {
    status,
    message: "GitHub API mengalami error saat memproses request."
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

async function getBranchState(octokit, owner, repo, branch) {
  const refResponse = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${branch}`
  });

  const commitSha = refResponse.data.object.sha;

  const commitResponse = await octokit.rest.git.getCommit({
    owner,
    repo,
    commit_sha: commitSha
  });

  const treeSha = commitResponse.data.tree.sha;

  const treeResponse = await octokit.rest.git.getTree({
    owner,
    repo,
    tree_sha: treeSha,
    recursive: "true"
  });

  if (treeResponse.data.truncated) {
    throw new Error(
      "Repository memiliki terlalu banyak file untuk diproses dengan aman oleh uploader ini."
    );
  }

  const files = new Set();

  for (const item of treeResponse.data.tree) {
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

async function createBlob(octokit, owner, repo, content) {
  if (typeof content !== "string") {
    throw new Error("Content blob tidak valid.");
  }

  const byteLength = Buffer.byteLength(content, "base64");

  if (byteLength > MAX_FILE_SIZE) {
    throw new Error(
      `File melebihi batas ${MAX_FILE_SIZE / 1024 / 1024} MB.`
    );
  }

  const response = await octokit.rest.git.createBlob({
    owner,
    repo,
    content,
    encoding: "base64"
  });

  return response.data.sha;
}

async function createCommit(
  octokit,
  {
    owner,
    repo,
    branch,
    baseCommitSha,
    baseTreeSha,
    entries,
    commitMessage
  }
) {
  const treeResponse = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseTreeSha,
    tree: entries.map((entry) => ({
      path: entry.path,
      mode: "100644",
      type: "blob",
      sha: entry.sha
    }))
  });

  const commitResponse = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: commitMessage,
    tree: treeResponse.data.sha,
    parents: [baseCommitSha]
  });

  await octokit.rest.git.updateRef({
    owner,
    repo,
    ref: `heads/${branch}`,
    sha: commitResponse.data.sha,
    force: false
  });

  return {
    commitSha: commitResponse.data.sha,
    treeSha: treeResponse.data.sha
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
    const action = body.action;

    if (!action) {
      return json(res, 400, {
        success: false,
        message: "Action tidak ditemukan."
      });
    }

    const octokit = getOctokit();
    const config = validateCommon(body);

    if (action === "prepare") {
      const state = await getBranchState(
        octokit,
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

    if (action === "blob") {
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
          message: `File "${path}" melebihi batas ${MAX_FILE_SIZE / 1024 / 1024} MB.`
        });
      }

      const sha = await createBlob(
        octokit,
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

    if (action === "commit") {
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

      const result = await createCommit(octokit, {
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
        githubUrl: `https://github.com/${config.owner}/${config.repo}/commit/${result.commitSha}`
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