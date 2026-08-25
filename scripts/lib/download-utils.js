const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const tar = require("tar");
const unzipper = require("unzipper");

const REQUEST_TIMEOUT = 30000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;
const MAX_REDIRECTS = 5;
const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/i;

function isPathInside(parentPath, candidatePath) {
  const parent = path.resolve(parentPath);
  const candidate = path.resolve(candidatePath);
  if (candidate === parent) return true;
  const relative = path.relative(parent, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function validateArchiveEntryPath(entryPath, extractDir) {
  const rawPath = String(entryPath || "");
  if (!rawPath || rawPath.includes("\0")) {
    throw new Error("Archive contains an invalid empty path.");
  }

  const normalizedPath = rawPath.replace(/\\/g, "/");
  if (path.posix.isAbsolute(normalizedPath) || normalizedPath.split("/").includes("..")) {
    throw new Error(`Archive contains unsafe path: ${rawPath}`);
  }

  const resolvedPath = path.resolve(extractDir, normalizedPath);
  if (!isPathInside(extractDir, resolvedPath)) {
    throw new Error(`Archive entry escapes extraction directory: ${rawPath}`);
  }
}

function validateArchiveLinkPath(entryPath, linkPath, extractDir) {
  const rawLinkPath = String(linkPath || "");
  if (!rawLinkPath || rawLinkPath.includes("\0")) {
    throw new Error(`Archive contains invalid link target: ${entryPath}`);
  }

  const normalizedLinkPath = rawLinkPath.replace(/\\/g, "/");
  if (path.posix.isAbsolute(normalizedLinkPath) || normalizedLinkPath.split("/").includes("..")) {
    throw new Error(`Archive contains unsafe link target: ${entryPath} -> ${rawLinkPath}`);
  }

  const normalizedEntryPath = String(entryPath || "").replace(/\\/g, "/");
  const resolvedTarget = path.resolve(
    extractDir,
    path.posix.dirname(normalizedEntryPath),
    normalizedLinkPath
  );
  if (!isPathInside(extractDir, resolvedTarget)) {
    throw new Error(`Archive link target escapes extraction directory: ${entryPath}`);
  }
}

async function validateZipArchiveEntries(zipPath, destDir) {
  const directory = await unzipper.Open.file(zipPath);
  for (const entry of directory.files) {
    validateArchiveEntryPath(entry.path, destDir);
    const type = String(entry.type || "").toLowerCase();
    if (type === "symboliclink") {
      throw new Error(`Archive contains unsupported symlink entry: ${entry.path}`);
    }
  }
}

async function validateTarArchiveEntries(tarPath, destDir) {
  await tar.t({
    file: tarPath,
    onentry: (entry) => {
      validateArchiveEntryPath(entry.path, destDir);
      const type = String(entry.type || "").toLowerCase();
      if (entry.linkpath || type === "symboliclink" || type === "link") {
        validateArchiveLinkPath(entry.path, entry.linkpath, destDir);
      }
    },
  });
}

async function assertExtractedTreeSafe(rootDir) {
  const root = path.resolve(rootDir);
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (!isPathInside(root, entryPath)) {
        throw new Error(`Extracted entry escaped target directory: ${entryPath}`);
      }
      if (entry.isSymbolicLink()) {
        const linkTarget = await fs.promises.readlink(entryPath);
        const resolvedTarget = path.resolve(path.dirname(entryPath), linkTarget);
        if (!isPathInside(root, resolvedTarget)) {
          throw new Error(`Archive extracted unsafe symlink: ${entryPath}`);
        }
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(entryPath);
      }
    }
  }
}

function runCommand(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} failed with code ${result.status}`);
  }
}

/**
 * Fetch JSON from a URL with proper error handling.
 * @param {string} url - URL to fetch
 * @param {number} [redirectCount=0] - Current redirect count (internal use)
 * @returns {Promise<object>} - Parsed JSON response
 */
function fetchJson(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > MAX_REDIRECTS) {
      reject(new Error("Too many redirects"));
      return;
    }

    const headers = {
      "User-Agent": "ChordVox-Downloader",
      Accept: "application/vnd.github+json",
    };

    // Use GitHub token if available (increases rate limit from 60 to 5000/hour)
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const options = {
      headers,
      timeout: REQUEST_TIMEOUT,
    };

    https
      .get(url, options, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const redirectUrl = res.headers.location;
          if (!redirectUrl) {
            reject(new Error("Redirect without location header"));
            return;
          }
          fetchJson(redirectUrl, redirectCount + 1)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse JSON: ${e.message}`));
          }
        });
        res.on("error", reject);
      })
      .on("error", reject)
      .on("timeout", () => reject(new Error("Request timeout")));
  });
}

/**
 * Fetch the latest release from a GitHub repository.
 * @param {string} repo - Repository in "owner/repo" format
 * @param {object} options - Options
 * @param {string} [options.exactTag] - Fetch this exact release tag (preferred for helper binaries)
 * @param {string} [options.tagPrefix] - Only match releases with this tag prefix (e.g., "windows-key-listener-v")
 * @param {boolean} [options.includePrerelease=false] - Include prerelease versions
 * @returns {Promise<{tag: string, assets: Array<{name: string, url: string}>, url: string} | null>}
 */
async function fetchLatestRelease(repo, options = {}) {
  const { exactTag, tagPrefix, includePrerelease = false } = options;

  try {
    if (exactTag) {
      const url = `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(exactTag)}`;
      const release = await fetchJson(url);
      return formatRelease(release);
    }

    // If no tag prefix, use the simple /latest endpoint
    if (!tagPrefix) {
      const url = `https://api.github.com/repos/${repo}/releases/latest`;
      const release = await fetchJson(url);
      return formatRelease(release);
    }

    // Otherwise, fetch all releases and filter by prefix
    const url = `https://api.github.com/repos/${repo}/releases?per_page=50`;
    const releases = await fetchJson(url);

    if (!Array.isArray(releases)) {
      return null;
    }

    // Find the latest release matching the prefix
    for (const release of releases) {
      if (release.draft) continue;
      if (!includePrerelease && release.prerelease) continue;
      if (release.tag_name && release.tag_name.startsWith(tagPrefix)) {
        return formatRelease(release);
      }
    }

    return null;
  } catch (error) {
    console.error(`  Failed to fetch latest release for ${repo}: ${error.message}`);
    return null;
  }
}

async function fetchLatestReleaseFromRepos(repos, options = {}) {
  for (const repo of repos) {
    const normalizedRepo = String(repo || "").trim();
    if (!normalizedRepo) continue;
    const release = await fetchLatestRelease(normalizedRepo, options);
    if (release) {
      return { ...release, repo: normalizedRepo };
    }
  }
  return null;
}

function parseRepoList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeRepoList(repos) {
  const seen = new Set();
  const normalized = [];

  for (const repo of repos || []) {
    const normalizedRepo = String(repo || "").trim();
    if (!normalizedRepo || seen.has(normalizedRepo)) continue;
    seen.add(normalizedRepo);
    normalized.push(normalizedRepo);
  }

  return normalized;
}

async function fetchReleaseWithLegacyFallback({
  primaryRepos,
  legacyRepos = [],
  options = {},
  componentLabel = "downloader",
}) {
  const normalizedPrimaryRepos = normalizeRepoList(primaryRepos);
  const normalizedLegacyRepos = normalizeRepoList(legacyRepos).filter(
    (repo) => !normalizedPrimaryRepos.includes(repo)
  );

  const primaryRelease = await fetchLatestReleaseFromRepos(normalizedPrimaryRepos, options);
  if (primaryRelease) {
    return {
      release: primaryRelease,
      sourceType: "primary",
      reposChecked: normalizedPrimaryRepos,
      legacyReposChecked: normalizedLegacyRepos,
    };
  }

  if (normalizedLegacyRepos.length === 0) {
    return {
      release: null,
      sourceType: "none",
      reposChecked: normalizedPrimaryRepos,
      legacyReposChecked: normalizedLegacyRepos,
    };
  }

  console.warn(
    `[${componentLabel}] Primary ChordVox release sources did not contain a matching asset. Trying legacy fallback repo(s): ${normalizedLegacyRepos.join(", ")}`
  );

  const legacyRelease = await fetchLatestReleaseFromRepos(normalizedLegacyRepos, options);
  return {
    release: legacyRelease,
    sourceType: legacyRelease ? "legacy" : "none",
    reposChecked: [...normalizedPrimaryRepos, ...normalizedLegacyRepos],
    legacyReposChecked: normalizedLegacyRepos,
  };
}

/**
 * Format a GitHub release response into a simplified object.
 * @param {object} release - GitHub release API response
 * @returns {{tag: string, assets: Array<{name: string, url: string}>, url: string}}
 */
function formatRelease(release) {
  return {
    tag: release.tag_name,
    url: release.html_url,
    assets: (release.assets || []).map((asset) => ({
      name: asset.name,
      url: asset.browser_download_url,
      digest: asset.digest || "",
    })),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSha256(value) {
  return String(value || "")
    .trim()
    .replace(/^sha256:/i, "")
    .toLowerCase();
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function verifyFileSha256(filePath, expectedSha256) {
  const expected = normalizeSha256(expectedSha256);
  if (!expected) return "";
  if (!SHA256_HEX_REGEX.test(expected)) {
    throw new Error(`Invalid SHA-256 checksum for ${path.basename(filePath)}`);
  }
  const actual = sha256File(filePath);
  if (actual !== expected) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    throw new Error(
      `Checksum mismatch for ${path.basename(filePath)}: expected ${expected}, got ${actual}`
    );
  }
  return actual;
}

async function downloadFileVerified(url, dest, expectedSha256) {
  await downloadFile(url, dest);
  return verifyFileSha256(dest, expectedSha256);
}

function downloadFile(url, dest, retryCount = 0) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let activeRequest = null;

    const cleanup = () => {
      if (activeRequest) {
        activeRequest.destroy();
        activeRequest = null;
      }
      file.close();
    };

    const request = (currentUrl, redirectCount = 0) => {
      if (redirectCount > MAX_REDIRECTS) {
        cleanup();
        reject(new Error("Too many redirects"));
        return;
      }

      activeRequest = https.get(currentUrl, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          const redirectUrl = response.headers.location;
          if (!redirectUrl) {
            cleanup();
            reject(new Error("Redirect without location header"));
            return;
          }
          request(redirectUrl, redirectCount + 1);
          return;
        }

        if (response.statusCode !== 200) {
          cleanup();
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        const total = parseInt(response.headers["content-length"], 10);
        let downloaded = 0;

        response.on("data", (chunk) => {
          downloaded += chunk.length;
          const pct = total ? Math.round((downloaded / total) * 100) : 0;
          process.stdout.write(`\r  Downloading: ${pct}%`);
        });

        response.on("error", (err) => {
          cleanup();
          reject(err);
        });

        response.pipe(file);
        file.on("finish", () => {
          file.close();
          console.log(" Done");
          resolve();
        });

        file.on("error", (err) => {
          cleanup();
          reject(err);
        });
      });

      activeRequest.on("error", (err) => {
        cleanup();
        reject(err);
      });

      activeRequest.setTimeout(REQUEST_TIMEOUT, () => {
        cleanup();
        reject(new Error("Connection timed out"));
      });
    };

    request(url);
  }).catch(async (error) => {
    const isTransient =
      error.message.includes("timed out") ||
      error.code === "ECONNRESET" ||
      error.code === "ETIMEDOUT";

    if (isTransient && retryCount < MAX_RETRIES) {
      console.log(`\n  Retry ${retryCount + 1}/${MAX_RETRIES}: ${error.message}`);
      await sleep(RETRY_DELAY);
      if (fs.existsSync(dest)) {
        fs.unlinkSync(dest);
      }
      return downloadFile(url, dest, retryCount + 1);
    }
    throw error;
  });
}

async function extractZip(zipPath, destDir) {
  await validateZipArchiveEntries(zipPath, destDir);
  if (process.platform === "win32") {
    await fs
      .createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: destDir }))
      .promise();
  } else {
    runCommand("unzip", ["-o", zipPath, "-d", destDir]);
  }
  await assertExtractedTreeSafe(destDir);
}

async function extractTarGz(tarPath, destDir) {
  await validateTarArchiveEntries(tarPath, destDir);
  runCommand("tar", ["-xzf", tarPath, "-C", destDir]);
  await assertExtractedTreeSafe(destDir);
}

async function extractArchive(archivePath, destDir) {
  if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
    await extractTarGz(archivePath, destDir);
  } else {
    await extractZip(archivePath, destDir);
  }
}

function findBinaryInDir(dir, binaryName, maxDepth = 5, currentDepth = 0) {
  if (currentDepth >= maxDepth) return null;

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const found = findBinaryInDir(fullPath, binaryName, maxDepth, currentDepth + 1);
      if (found) return found;
    } else if (entry.name === binaryName) {
      return fullPath;
    }
  }

  return null;
}

function parseArgs() {
  const args = process.argv;
  let targetPlatform = process.env.TARGET_PLATFORM || process.platform;
  let targetArch = process.env.TARGET_ARCH || process.arch;

  const platformIndex = args.indexOf("--platform");
  if (platformIndex !== -1 && args[platformIndex + 1]) {
    targetPlatform = args[platformIndex + 1];
  }

  const archIndex = args.indexOf("--arch");
  if (archIndex !== -1 && args[archIndex + 1]) {
    targetArch = args[archIndex + 1];
  }

  return {
    targetPlatform,
    targetArch,
    platformArch: `${targetPlatform}-${targetArch}`,
    isCurrent: args.includes("--current"),
    isAll: args.includes("--all"),
    isForce: args.includes("--force"),
    shouldCleanup:
      args.includes("--clean") ||
      process.env.CI === "true" ||
      process.env.GITHUB_ACTIONS === "true",
  };
}

function setExecutable(filePath) {
  if (process.platform !== "win32") {
    fs.chmodSync(filePath, 0o755);
  }
}

function cleanupFiles(binDir, prefix, keepPrefix) {
  const files = fs.readdirSync(binDir).filter((f) => f.startsWith(prefix));
  files.forEach((file) => {
    if (!file.startsWith(keepPrefix)) {
      const filePath = path.join(binDir, file);
      console.log(`Removing old binary: ${file}`);
      fs.unlinkSync(filePath);
    }
  });
}

module.exports = {
  downloadFile,
  downloadFileVerified,
  extractArchive,
  extractZip,
  fetchLatestRelease,
  fetchLatestReleaseFromRepos,
  fetchReleaseWithLegacyFallback,
  findBinaryInDir,
  parseArgs,
  parseRepoList,
  setExecutable,
  verifyFileSha256,
  cleanupFiles,
};
