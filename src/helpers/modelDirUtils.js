const fs = require("fs");
const { app } = require("electron");
const os = require("os");
const path = require("path");

const SERVICE_DIR_NAMES = {
  whisper: "whisper-models",
  streaming: "streaming-models",
  parakeet: "parakeet-models",
  sensevoice: "sensevoice-models",
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
    const localAppData =
      process.env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local");
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

function getConfiguredSpeechModelsRoot() {
  return normalizeModelsRootPath(process.env.MODEL_STORAGE_ROOT);
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

function maybeCleanupDuplicateLegacyEntry(sourcePath, targetPath) {
  try {
    if (!fs.existsSync(sourcePath) || !fs.existsSync(targetPath)) return;

    const sourceStat = fs.statSync(sourcePath);
    const targetStat = fs.statSync(targetPath);

    if (sourceStat.isDirectory() && targetStat.isDirectory()) {
      removePathSync(sourcePath);
      return;
    }

    if (sourceStat.isFile() && targetStat.isFile() && sourceStat.size === targetStat.size) {
      removePathSync(sourcePath);
    }
  } catch {}
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

function migrateSpeechModelsRootSync(fromRoot, toRoot) {
  const normalizedSource = normalizeModelsRootPath(fromRoot);
  const normalizedTarget = normalizeModelsRootPath(toRoot);

  if (!normalizedSource || !normalizedTarget) return;
  if (normalizedSource === normalizedTarget) return;
  if (!fs.existsSync(normalizedSource)) return;

  fs.mkdirSync(normalizedTarget, { recursive: true });

  for (const service of Object.keys(SERVICE_DIR_NAMES)) {
    const sourceDir = getServiceModelsDir(normalizedSource, service);
    const targetDir = getServiceModelsDir(normalizedTarget, service);

    if (!fs.existsSync(sourceDir)) continue;

    if (!fs.existsSync(targetDir)) {
      moveOrCopyPathSync(sourceDir, targetDir);
      continue;
    }

    for (const entry of fs.readdirSync(sourceDir)) {
      const sourcePath = path.join(sourceDir, entry);
      const targetPath = path.join(targetDir, entry);

      if (!fs.existsSync(targetPath)) {
        moveOrCopyPathSync(sourcePath, targetPath);
        continue;
      }

      maybeCleanupDuplicateLegacyEntry(sourcePath, targetPath);
    }

    try {
      if (fs.readdirSync(sourceDir).length === 0) {
        fs.rmdirSync(sourceDir);
      }
    } catch {}
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
  migrateSpeechModelsRootSync,
};
