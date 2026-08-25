const fs = require("fs");
const fsPromises = require("fs/promises");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const { isPathInside } = require("./pathSecurity");
let app = null;

try {
  ({ app } = require("electron"));
} catch {}

const SERVICE_DIR_NAMES = {
  whisper: "whisper-models",
  streaming: "streaming-models",
  parakeet: "parakeet-models",
  paraformer: "paraformer-models",
  granite: "granite-models",
  cohere: "cohere-models",
  punctuation: "punctuation-models",
};

const migratedTargets = new Set();

function getHomeDir() {
  return app?.getPath?.("home") || os.homedir();
}

function getLegacyModelsRoot() {
  return path.join(getHomeDir(), ".cache", "chordvox");
}

function getDefaultSpeechModelsRoot() {
  const homeDir = getHomeDir();

  if (process.platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "ChordVox", "models");
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local");
    return path.join(localAppData, "ChordVox", "models");
  }

  const cacheRoot = process.env.XDG_CACHE_HOME || path.join(homeDir, ".cache");
  return path.join(cacheRoot, "chordvox", "models");
}

function normalizeModelsRootPath(rootPath) {
  const trimmed = String(rootPath || "").trim();
  if (!trimmed) return "";
  return path.resolve(trimmed);
}

function normalizeForCompare(targetPath) {
  const resolved = path.resolve(targetPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathsEqual(leftPath, rightPath) {
  return normalizeForCompare(leftPath) === normalizeForCompare(rightPath);
}

function pathInsideForCompare(parentPath, candidatePath) {
  if (isPathInside(parentPath, candidatePath)) return true;
  if (process.platform !== "win32") return false;

  const parent = normalizeForCompare(parentPath);
  const candidate = normalizeForCompare(candidatePath);
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function isExpectedServiceModelsDir(service, targetDir) {
  return path.basename(path.resolve(targetDir)) === getServiceDirName(service);
}

function isRootLevelPath(targetDir) {
  const resolved = path.resolve(targetDir);
  return pathsEqual(path.dirname(resolved), path.parse(resolved).root);
}

function isFilesystemRootPath(targetDir) {
  const resolved = path.resolve(targetDir);
  return pathsEqual(resolved, path.parse(resolved).root);
}

function normalizeModelsStorageRootPath(rootPath) {
  const resolved = normalizeModelsRootPath(rootPath);
  if (!resolved) return "";

  if (process.platform === "win32" && isFilesystemRootPath(resolved)) {
    return path.join(resolved, "ChordVox", "models");
  }

  return resolved;
}

function isDedicatedRootLevelModelsPath(targetDir) {
  if (!isRootLevelPath(targetDir)) return true;

  const basename = path.basename(path.resolve(targetDir)).toLowerCase();
  return basename.includes("chordvox") || basename === "models" || basename.endsWith("models");
}

function assertNoSymlinkedExistingPath(targetDir) {
  const resolved = path.resolve(targetDir);
  const root = path.parse(resolved).root;
  const pathSegments = path.relative(root, resolved).split(path.sep).filter(Boolean);
  let currentPath = root;

  for (const segment of pathSegments) {
    currentPath = path.join(currentPath, segment);
    if (!fs.existsSync(currentPath)) return;

    const stat = fs.lstatSync(currentPath);
    if (stat.isSymbolicLink()) {
      throw new Error("Model directory cannot include a symbolic link.");
    }

    const realPath = fs.realpathSync.native(currentPath);
    if (!pathsEqual(realPath, currentPath)) {
      throw new Error("Model directory cannot resolve through a symbolic link.");
    }
  }
}

function validateModelsStorageRoot(rootPath) {
  const resolved = normalizeModelsStorageRootPath(rootPath);
  if (!resolved) {
    return "";
  }

  if (isFilesystemRootPath(resolved)) {
    throw new Error("Model storage root must not be at the filesystem root.");
  }

  if (!isDedicatedRootLevelModelsPath(resolved)) {
    throw new Error(
      "Model storage root must be a dedicated ChordVox models folder, not a top-level system folder."
    );
  }

  const homeDir = getHomeDir();
  if (homeDir && pathsEqual(resolved, homeDir)) {
    throw new Error("Model storage root must be a dedicated folder, not your home directory.");
  }

  assertNoSymlinkedExistingPath(resolved);
  return resolved;
}

function getConfiguredSpeechModelsRoot() {
  try {
    return validateModelsStorageRoot(process.env.MODEL_STORAGE_ROOT);
  } catch {
    return "";
  }
}

function getSpeechModelsRoot() {
  return getConfiguredSpeechModelsRoot() || getDefaultSpeechModelsRoot();
}

function getServiceDirName(service) {
  return SERVICE_DIR_NAMES[service] || `${service}-models`;
}

function getServiceModelsDir(rootDir, service) {
  return path.join(rootDir, getServiceDirName(service));
}

function removePathSync(targetPath) {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch {}
}

function moveOrCopyPathSync(sourcePath, targetPath) {
  try {
    fs.renameSync(sourcePath, targetPath);
    return true;
  } catch {}

  try {
    fs.cpSync(sourcePath, targetPath, { recursive: true, force: false, errorOnExist: false });
    removePathSync(sourcePath);
    return true;
  } catch {}

  return false;
}

function migrateLegacyModelDirSync(service, targetDir) {
  const cacheKey = `${service}:${path.resolve(targetDir)}`;
  if (migratedTargets.has(cacheKey)) return;
  migratedTargets.add(cacheKey);

  const legacyDir = path.join(getLegacyModelsRoot(), getServiceDirName(service));
  if (!fs.existsSync(legacyDir)) return;

  try {
    if (fs.lstatSync(legacyDir).isSymbolicLink()) {
      return;
    }
  } catch {
    return;
  }

  if (path.resolve(legacyDir) === path.resolve(targetDir)) {
    return;
  }

  fs.mkdirSync(path.dirname(targetDir), { recursive: true });

  if (!fs.existsSync(targetDir)) {
    if (moveOrCopyPathSync(legacyDir, targetDir)) {
      return;
    }
  }

  fs.mkdirSync(targetDir, { recursive: true });

  for (const entry of fs.readdirSync(legacyDir)) {
    const sourcePath = path.join(legacyDir, entry);
    const targetPath = path.join(targetDir, entry);

    if (fs.existsSync(targetPath)) {
      continue;
    }

    moveOrCopyPathSync(sourcePath, targetPath);
  }

  try {
    if (fs.readdirSync(legacyDir).length === 0) {
      fs.rmdirSync(legacyDir);
    }
  } catch {}
}

function getModelsDirForService(service) {
  const targetDir = getServiceModelsDir(getSpeechModelsRoot(), service);
  migrateLegacyModelDirSync(service, targetDir);
  return targetDir;
}

function getAllowedServiceModelsDirs(service) {
  const roots = [
    getDefaultSpeechModelsRoot(),
    getConfiguredSpeechModelsRoot(),
    getLegacyModelsRoot(),
  ].filter(Boolean);

  return [...new Set(roots.map((root) => normalizeForCompare(getServiceModelsDir(root, service))))];
}

function validateServiceModelsDir(service, modelsDir) {
  const resolved = normalizeModelsRootPath(modelsDir);
  if (!resolved) {
    throw new Error("Model directory is required.");
  }

  if (isRootLevelPath(resolved)) {
    throw new Error("Model directory must not be at the filesystem root.");
  }

  if (!isExpectedServiceModelsDir(service, resolved)) {
    throw new Error(`Model directory must be the ${getServiceDirName(service)} folder.`);
  }

  const allowedDirs = getAllowedServiceModelsDirs(service);
  const normalizedResolved = normalizeForCompare(resolved);
  const isKnownModelsDir = allowedDirs.includes(normalizedResolved);
  const defaultRoot = getDefaultSpeechModelsRoot();
  const configuredRoot = getConfiguredSpeechModelsRoot();
  const legacyRoot = getLegacyModelsRoot();
  const allowedParentRoots = [defaultRoot, configuredRoot, legacyRoot].filter(Boolean);

  if (
    !isKnownModelsDir &&
    !allowedParentRoots.some((root) => pathInsideForCompare(root, path.dirname(resolved)))
  ) {
    throw new Error("Model directory must be under the configured ChordVox model storage root.");
  }

  assertNoSymlinkedExistingPath(resolved);
  return resolved;
}

function resolveModelsDirForService(service, customDir = "") {
  const normalized = String(customDir || "").trim();
  if (!normalized) {
    return getModelsDirForService(service);
  }

  return validateServiceModelsDir(service, normalized);
}

async function pathExists(targetPath) {
  try {
    await fsPromises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function hashFile(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function assertMigrationTreeIsSafe(targetPath) {
  const stat = await fsPromises.lstat(targetPath);
  if (stat.isSymbolicLink()) {
    const error = new Error(`Model migration cannot copy symbolic links: ${targetPath}`);
    error.code = "MODEL_MIGRATION_SYMLINK";
    throw error;
  }
  if (!stat.isDirectory()) return;

  const entries = await fsPromises.readdir(targetPath);
  for (const entry of entries) {
    await assertMigrationTreeIsSafe(path.join(targetPath, entry));
  }
}

async function filesMatch(sourcePath, targetPath) {
  const [sourceStat, targetStat] = await Promise.all([
    fsPromises.stat(sourcePath),
    fsPromises.stat(targetPath),
  ]);
  if (!sourceStat.isFile() || !targetStat.isFile() || sourceStat.size !== targetStat.size) {
    return false;
  }
  const [sourceHash, targetHash] = await Promise.all([hashFile(sourcePath), hashFile(targetPath)]);
  return sourceHash === targetHash;
}

async function sourceTreeExistsInTarget(sourcePath, targetPath) {
  if (!(await pathExists(targetPath))) return false;
  const [sourceStat, targetStat] = await Promise.all([
    fsPromises.lstat(sourcePath),
    fsPromises.lstat(targetPath),
  ]);
  if (sourceStat.isSymbolicLink() || targetStat.isSymbolicLink()) return false;
  if (sourceStat.isFile() || targetStat.isFile()) {
    return sourceStat.isFile() && targetStat.isFile() && filesMatch(sourcePath, targetPath);
  }
  if (!sourceStat.isDirectory() || !targetStat.isDirectory()) return false;

  const sourceEntries = await fsPromises.readdir(sourcePath);
  for (const entry of sourceEntries) {
    if (
      !(await sourceTreeExistsInTarget(path.join(sourcePath, entry), path.join(targetPath, entry)))
    ) {
      return false;
    }
  }
  return true;
}

async function mergeVerifiedStagingPath(stagingPath, targetPath) {
  if (!(await pathExists(targetPath))) {
    await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
    await fsPromises.rename(stagingPath, targetPath);
    return;
  }

  const [stagingStat, targetStat] = await Promise.all([
    fsPromises.lstat(stagingPath),
    fsPromises.lstat(targetPath),
  ]);
  if (stagingStat.isSymbolicLink() || targetStat.isSymbolicLink()) {
    const error = new Error(`Model migration found a symbolic-link conflict at ${targetPath}`);
    error.code = "MODEL_MIGRATION_SYMLINK";
    throw error;
  }

  if (stagingStat.isFile() && targetStat.isFile()) {
    if (!(await filesMatch(stagingPath, targetPath))) {
      const error = new Error(
        `A different model file already exists at ${targetPath}. Choose an empty folder or remove the conflicting copy.`
      );
      error.code = "MODEL_MIGRATION_CONFLICT";
      throw error;
    }
    await fsPromises.rm(stagingPath, { force: true });
    return;
  }

  if (!stagingStat.isDirectory() || !targetStat.isDirectory()) {
    const error = new Error(
      `A different model item already exists at ${targetPath}. Choose an empty folder or remove the conflict.`
    );
    error.code = "MODEL_MIGRATION_CONFLICT";
    throw error;
  }

  const entries = await fsPromises.readdir(stagingPath);
  for (const entry of entries) {
    await mergeVerifiedStagingPath(path.join(stagingPath, entry), path.join(targetPath, entry));
  }
  await fsPromises.rmdir(stagingPath);
}

async function migrateSpeechModelsRoot(fromRoot, toRoot, options = {}) {
  const normalizedSource = normalizeModelsRootPath(fromRoot);
  const normalizedTarget = normalizeModelsRootPath(toRoot);

  if (!normalizedSource || !normalizedTarget || pathsEqual(normalizedSource, normalizedTarget)) {
    return { success: true, migratedServices: [], cleanupWarnings: [] };
  }

  if (!(await pathExists(normalizedSource))) {
    await fsPromises.mkdir(normalizedTarget, { recursive: true });
    return { success: true, migratedServices: [], cleanupWarnings: [] };
  }

  const pendingServices = [];
  for (const service of Object.keys(SERVICE_DIR_NAMES)) {
    const sourceDir = getServiceModelsDir(normalizedSource, service);
    if (await pathExists(sourceDir)) {
      pendingServices.push({
        service,
        sourceDir,
        targetDir: getServiceModelsDir(normalizedTarget, service),
      });
    }
  }

  if (
    pendingServices.length > 0 &&
    (pathInsideForCompare(normalizedSource, normalizedTarget) ||
      pathInsideForCompare(normalizedTarget, normalizedSource))
  ) {
    const error = new Error(
      "The new model folder cannot be inside the current folder, or contain it."
    );
    error.code = "MODEL_MIGRATION_NESTED_ROOT";
    throw error;
  }

  if (pendingServices.length === 0) {
    await fsPromises.mkdir(normalizedTarget, { recursive: true });
    assertNoSymlinkedExistingPath(normalizedTarget);
    return { success: true, migratedServices: [], cleanupWarnings: [] };
  }

  await assertMigrationTreeIsSafe(normalizedSource);
  await fsPromises.mkdir(normalizedTarget, { recursive: true });
  assertNoSymlinkedExistingPath(normalizedTarget);

  const stagingRoot = path.join(
    normalizedTarget,
    `.chordvox-migration-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
  );
  const emitProgress = (phase, service, completed) => {
    options.onProgress?.({
      phase,
      service,
      completed,
      total: pendingServices.length,
    });
  };

  try {
    await fsPromises.mkdir(stagingRoot, { recursive: false });
    for (let index = 0; index < pendingServices.length; index += 1) {
      const item = pendingServices[index];
      emitProgress("copying", item.service, index);
      const stagingDir = path.join(stagingRoot, getServiceDirName(item.service));
      await fsPromises.cp(item.sourceDir, stagingDir, {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true,
      });
      if (!(await sourceTreeExistsInTarget(item.sourceDir, stagingDir))) {
        const error = new Error(`Model copy verification failed for ${item.service}.`);
        error.code = "MODEL_MIGRATION_VERIFY_FAILED";
        throw error;
      }
      emitProgress("verified", item.service, index + 1);
    }

    for (let index = 0; index < pendingServices.length; index += 1) {
      const item = pendingServices[index];
      emitProgress("merging", item.service, index);
      const stagingDir = path.join(stagingRoot, getServiceDirName(item.service));
      await mergeVerifiedStagingPath(stagingDir, item.targetDir);
      if (!(await sourceTreeExistsInTarget(item.sourceDir, item.targetDir))) {
        const error = new Error(`Final model verification failed for ${item.service}.`);
        error.code = "MODEL_MIGRATION_VERIFY_FAILED";
        throw error;
      }
      emitProgress("merged", item.service, index + 1);
    }

    const cleanupWarnings = [];
    for (let index = 0; index < pendingServices.length; index += 1) {
      const item = pendingServices[index];
      emitProgress("cleaning", item.service, index);
      try {
        await fsPromises.rm(item.sourceDir, { recursive: true, force: false });
      } catch (error) {
        cleanupWarnings.push({ service: item.service, error: error?.message || String(error) });
      }
      emitProgress("cleaned", item.service, index + 1);
    }

    return {
      success: true,
      migratedServices: pendingServices.map((item) => item.service),
      cleanupWarnings,
    };
  } finally {
    await fsPromises.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  getModelsDirForService,
  getDefaultSpeechModelsRoot,
  getConfiguredSpeechModelsRoot,
  getSpeechModelsRoot,
  getLegacyModelsRoot,
  getServiceDirName,
  getServiceModelsDir,
  normalizeModelsRootPath,
  normalizeModelsStorageRootPath,
  validateModelsStorageRoot,
  resolveModelsDirForService,
  validateServiceModelsDir,
  migrateSpeechModelsRoot,
};
