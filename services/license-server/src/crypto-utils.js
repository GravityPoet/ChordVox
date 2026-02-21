const crypto = require("crypto");

const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function normalizeLicenseKey(rawValue) {
  return String(rawValue || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "");
}

function hashLicenseKey(licenseKey, pepper) {
  return crypto.createHmac("sha256", pepper).update(normalizeLicenseKey(licenseKey)).digest("hex");
}

function generateReadableSegment(length = 4) {
  const bytes = crypto.randomBytes(length);
  let output = "";
  for (let i = 0; i < length; i += 1) {
    output += KEY_ALPHABET[bytes[i] % KEY_ALPHABET.length];
  }
  return output;
}

function generateLicenseKey(prefix = "AK", groups = 4, groupLength = 4) {
  const normalizedPrefix = String(prefix || "AK")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  const segments = [];
  for (let i = 0; i < groups; i += 1) {
    segments.push(generateReadableSegment(groupLength));
  }

  return `${normalizedPrefix}-${segments.join("-")}`;
}

function maskLicenseKey(licenseKey) {
  const normalized = normalizeLicenseKey(licenseKey);
  if (!normalized) return "";
  if (normalized.length <= 8) return normalized;
  return `${normalized.slice(0, 4)}...${normalized.slice(-4)}`;
}

function normalizeMachineId(rawMachineId) {
  const machineId = String(rawMachineId || "").trim();
  if (!machineId) return "";
  return machineId.slice(0, 128);
}

module.exports = {
  generateLicenseKey,
  hashLicenseKey,
  maskLicenseKey,
  normalizeLicenseKey,
  normalizeMachineId,
};

