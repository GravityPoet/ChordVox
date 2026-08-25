const crypto = require("crypto");
const secureSecrets = require("./secureSecrets");

const ENCRYPTED_TEXT_PREFIX = "encv1:";
const DATA_KEY_SECRET_NAME = "__CHORDVOX_TRANSCRIPTION_DATA_KEY_V1";

let cachedKey = null;

function loadOrCreateTranscriptionKey(options = {}) {
  if (cachedKey) {
    return cachedKey;
  }

  const existingKey = secureSecrets.loadSecretSync(DATA_KEY_SECRET_NAME, {
    ...options,
    allowKeychain: options.allowKeychain === true,
  });
  if (existingKey) {
    const decoded = Buffer.from(existingKey, "base64");
    if (decoded.length === 32) {
      cachedKey = decoded;
      return cachedKey;
    }
  }

  if (options.allowCreate === false) {
    return null;
  }

  cachedKey = crypto.randomBytes(32);
  secureSecrets.saveSecretsSync(
    {
      [DATA_KEY_SECRET_NAME]: cachedKey.toString("base64"),
    },
    { merge: true, useKeychain: false }
  );
  return cachedKey;
}

function isEncryptedText(value) {
  return typeof value === "string" && value.startsWith(ENCRYPTED_TEXT_PREFIX);
}

function encryptTranscriptionText(value) {
  const text = String(value ?? "");
  if (!text || isEncryptedText(text)) {
    return text;
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", loadOrCreateTranscriptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENCRYPTED_TEXT_PREFIX}${Buffer.concat([iv, tag, encrypted]).toString("base64")}`;
}

function decryptTranscriptionText(value, options = {}) {
  if (!isEncryptedText(value)) {
    return typeof value === "string" ? value : "";
  }

  try {
    const payload = Buffer.from(value.slice(ENCRYPTED_TEXT_PREFIX.length), "base64");
    if (payload.length <= 28) {
      return "";
    }
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const encrypted = payload.subarray(28);
    const key = loadOrCreateTranscriptionKey({ ...options, allowCreate: false });
    if (!key) {
      return "";
    }
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

function decryptTranscriptionRow(row, options = {}) {
  if (!row || typeof row !== "object") {
    return row;
  }
  return {
    ...row,
    text: decryptTranscriptionText(row.text, options),
  };
}

module.exports = {
  decryptTranscriptionRow,
  decryptTranscriptionText,
  encryptTranscriptionText,
  isEncryptedText,
};
