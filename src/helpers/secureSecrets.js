const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");
const { app } = require("electron");
const { atomicWriteFile, atomicWriteFileSync } = require("./atomicFile");

const SECRET_STORE_VERSION = 1;
const SECRET_STORE_FILE = "secure-secrets.json";
const LOCAL_VALUE_PREFIX = "plain:";
const ENCRYPTED_VALUE_PREFIX = "enc:";
const INTERNAL_SECRET_PREFIX = "__CHORDVOX_";
let warnedLocalSecretStorage = false;
let cachedSafeStorage = null;

function getSafeStorage() {
  if (cachedSafeStorage) {
    return cachedSafeStorage;
  }

  try {
    cachedSafeStorage = require("electron").safeStorage;
  } catch {
    cachedSafeStorage = null;
  }

  return cachedSafeStorage;
}

function getSecretStorePath() {
  return path.join(app.getPath("userData"), SECRET_STORE_FILE);
}

function shouldAllowKeychain(options = {}) {
  return options.allowKeychain !== false;
}

function encodeValue(value, options = {}) {
  const text = String(value ?? "");
  const useKeychain = options.useKeychain !== false;
  const safeStorage = useKeychain ? getSafeStorage() : null;
  if (safeStorage?.isEncryptionAvailable?.()) {
    try {
      return `${ENCRYPTED_VALUE_PREFIX}${safeStorage.encryptString(text).toString("base64")}`;
    } catch {
      // Fall back to the legacy local format when OS encryption is unavailable.
    }
  }
  if (!warnedLocalSecretStorage) {
    warnedLocalSecretStorage = true;
    console.warn(
      "ChordVox secure storage encryption is unavailable; secrets will be stored with local file permissions only."
    );
  }
  return `${LOCAL_VALUE_PREFIX}${Buffer.from(text, "utf8").toString("base64")}`;
}

function decodeValue(storedValue, options = {}) {
  if (!storedValue) {
    return "";
  }

  const encodedValue = String(storedValue);
  if (encodedValue.startsWith(ENCRYPTED_VALUE_PREFIX)) {
    if (!shouldAllowKeychain(options)) {
      return "";
    }
    const safeStorage = getSafeStorage();
    if (!safeStorage) {
      return "";
    }
    try {
      const encrypted = Buffer.from(encodedValue.slice(ENCRYPTED_VALUE_PREFIX.length), "base64");
      return safeStorage.decryptString(encrypted);
    } catch {
      return "";
    }
  }

  if (encodedValue.startsWith(LOCAL_VALUE_PREFIX)) {
    return Buffer.from(encodedValue.slice(LOCAL_VALUE_PREFIX.length), "base64").toString("utf8");
  }

  return "";
}

function normalizeStoredSecrets(
  currentSecrets,
  { internalOnly = false, allowKeychain = true, preserveEncoded = false, useKeychain = true } = {}
) {
  const secrets = {};
  for (const [key, storedValue] of Object.entries(currentSecrets || {})) {
    if (internalOnly && !key.startsWith(INTERNAL_SECRET_PREFIX)) {
      continue;
    }
    if (
      preserveEncoded &&
      typeof storedValue === "string" &&
      (storedValue.startsWith(ENCRYPTED_VALUE_PREFIX) || storedValue.startsWith(LOCAL_VALUE_PREFIX))
    ) {
      secrets[key] = storedValue;
      continue;
    }
    const decoded = decodeValue(storedValue, { allowKeychain });
    if (decoded) {
      secrets[key] = encodeValue(decoded, { useKeychain });
    } else if (
      typeof storedValue === "string" &&
      (storedValue.startsWith(ENCRYPTED_VALUE_PREFIX) || storedValue.startsWith(LOCAL_VALUE_PREFIX))
    ) {
      secrets[key] = storedValue;
    }
  }
  return secrets;
}

async function readStoreFile() {
  try {
    const raw = await fsPromises.readFile(getSecretStorePath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function readStoreFileSync() {
  try {
    const raw = fs.readFileSync(getSecretStorePath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function decryptSecretsFromStore(store, options = {}) {
  const encrypted = store?.secrets && typeof store.secrets === "object" ? store.secrets : {};
  const result = {};
  for (const [key, value] of Object.entries(encrypted)) {
    const decrypted = decodeValue(value, options);
    if (decrypted) {
      result[key] = decrypted;
    }
  }
  return result;
}

function loadSecretsSync(options = {}) {
  return decryptSecretsFromStore(readStoreFileSync(), options);
}

function loadSecretSync(secretName, options = {}) {
  const store = readStoreFileSync();
  const encrypted = store?.secrets && typeof store.secrets === "object" ? store.secrets : {};
  return decodeValue(encrypted[secretName], options);
}

async function saveSecrets(secretMap, options = {}) {
  const useKeychain = options.useKeychain !== false;
  const currentStore = await readStoreFile();
  const currentSecrets =
    currentStore?.secrets && typeof currentStore.secrets === "object" ? currentStore.secrets : {};
  const secrets = normalizeStoredSecrets(currentSecrets, { preserveEncoded: true, useKeychain });

  for (const [key, value] of Object.entries(secretMap || {})) {
    if (value) {
      secrets[key] = encodeValue(value, { useKeychain });
    } else {
      delete secrets[key];
    }
  }

  const storePath = getSecretStorePath();
  await atomicWriteFile(
    storePath,
    JSON.stringify(
      {
        version: SECRET_STORE_VERSION,
        updatedAt: new Date().toISOString(),
        secrets,
      },
      null,
      2
    ),
    { mode: 0o600, backup: true }
  );
  await fsPromises.chmod(storePath, 0o600).catch(() => {});

  return { success: true, path: storePath };
}

function writeStoreFileSync(store) {
  const storePath = getSecretStorePath();
  atomicWriteFileSync(storePath, JSON.stringify(store, null, 2), {
    mode: 0o600,
    backup: true,
  });
}

function saveSecretsSync(secretMap, options = {}) {
  const merge = options.merge === true;
  const useKeychain = options.useKeychain !== false;
  const currentStore = merge ? readStoreFileSync() : {};
  const currentSecrets =
    currentStore?.secrets && typeof currentStore.secrets === "object" ? currentStore.secrets : {};
  const secrets = merge
    ? normalizeStoredSecrets(currentSecrets, { preserveEncoded: true, useKeychain })
    : {};

  for (const [key, value] of Object.entries(secretMap || {})) {
    if (value) {
      secrets[key] = encodeValue(value, { useKeychain });
    } else {
      delete secrets[key];
    }
  }

  writeStoreFileSync({
    version: SECRET_STORE_VERSION,
    updatedAt: new Date().toISOString(),
    secrets,
  });

  return { success: true, path: getSecretStorePath() };
}

module.exports = {
  getSecretStorePath,
  loadSecretSync,
  loadSecretsSync,
  readStoreFile,
  saveSecrets,
  saveSecretsSync,
};
