const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const writeQueues = new Map();

async function fsyncQuiet(handle) {
  try {
    await handle.sync();
  } catch {
    // best-effort durability; some filesystems may not support fsync
  }
}

async function safeUnlink(filePath) {
  try {
    await fsPromises.unlink(filePath);
  } catch {
    // tempfile already gone or permission failure — nothing to do
  }
}

async function atomicWriteFileOnce(filePath, content, options = {}) {
  const { mode, backup = true } = options;
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  const backupPath = `${filePath}.bak`;

  await fsPromises.mkdir(directory, { recursive: true });

  if (backup) {
    try {
      await fsPromises.copyFile(filePath, backupPath);
      if (mode !== undefined) {
        await fsPromises.chmod(backupPath, mode).catch(() => {});
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        // best-effort backup; do not fail the write because of a backup error
      }
    }
  }

  const handle = await fsPromises.open(tempPath, "w", mode);
  try {
    await handle.writeFile(content, "utf8");
    await fsyncQuiet(handle);
  } catch (error) {
    await handle.close().catch(() => {});
    await safeUnlink(tempPath);
    throw error;
  }
  await handle.close();

  try {
    await fsPromises.rename(tempPath, filePath);
  } catch (error) {
    await safeUnlink(tempPath);
    throw error;
  }

  if (mode !== undefined) {
    await fsPromises.chmod(filePath, mode).catch(() => {});
  }
}

async function atomicWriteFile(filePath, content, options = {}) {
  const resolvedPath = path.resolve(filePath);
  const previousWrite = writeQueues.get(resolvedPath) || Promise.resolve();
  const nextWrite = previousWrite
    .catch(() => {})
    .then(() => atomicWriteFileOnce(resolvedPath, content, options));

  writeQueues.set(resolvedPath, nextWrite);
  try {
    return await nextWrite;
  } finally {
    if (writeQueues.get(resolvedPath) === nextWrite) {
      writeQueues.delete(resolvedPath);
    }
  }
}

function atomicWriteFileSync(filePath, content, options = {}) {
  const { mode, backup = true } = options;
  const resolvedPath = path.resolve(filePath);
  const directory = path.dirname(resolvedPath);
  const tempPath = path.join(
    directory,
    `.${path.basename(resolvedPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  const backupPath = `${resolvedPath}.bak`;

  fs.mkdirSync(directory, { recursive: true });

  if (backup) {
    try {
      fs.copyFileSync(resolvedPath, backupPath);
      if (mode !== undefined) {
        fs.chmodSync(backupPath, mode);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        // Best-effort backup; do not fail the write because of a backup error.
      }
    }
  }

  let handle;
  try {
    handle = fs.openSync(tempPath, "w", mode);
    fs.writeFileSync(handle, content, "utf8");
    try {
      fs.fsyncSync(handle);
    } catch {
      // Best-effort durability; some filesystems may not support fsync.
    }
  } catch (error) {
    try {
      if (handle !== undefined) fs.closeSync(handle);
    } catch {}
    try {
      fs.unlinkSync(tempPath);
    } catch {}
    throw error;
  }

  try {
    fs.closeSync(handle);
    fs.renameSync(tempPath, resolvedPath);
  } catch (error) {
    try {
      fs.closeSync(handle);
    } catch {}
    try {
      fs.unlinkSync(tempPath);
    } catch {}
    throw error;
  }

  if (mode !== undefined) {
    try {
      fs.chmodSync(resolvedPath, mode);
    } catch {}
  }
}

async function readJsonWithBackup(filePath, options = {}) {
  const backupPath = `${filePath}.bak`;
  const recoverCorrupt = options.recoverCorrupt === true;

  try {
    const raw = await fsPromises.readFile(filePath, "utf8");
    return { value: JSON.parse(raw), source: filePath };
  } catch (error) {
    if (error?.code !== "ENOENT" && !recoverCorrupt) {
      throw new Error(`Failed to read JSON from ${filePath}: ${error.message}`, {
        cause: error,
      });
    }
  }

  try {
    const raw = await fsPromises.readFile(backupPath, "utf8");
    return { value: JSON.parse(raw), source: backupPath };
  } catch (error) {
    if (error?.code !== "ENOENT" && !recoverCorrupt) {
      throw new Error(`Failed to read backup JSON from ${backupPath}: ${error.message}`, {
        cause: error,
      });
    }
  }

  return { value: null, source: null };
}

module.exports = {
  atomicWriteFile,
  atomicWriteFileSync,
  readJsonWithBackup,
};
