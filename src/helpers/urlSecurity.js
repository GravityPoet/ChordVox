const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["https:", "http:", "mailto:"]);

function getSafeExternalUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    throw new Error("External URL is empty");
  }

  if (/[\u0000-\u001F\u007F]/.test(raw)) {
    throw new Error("External URL contains control characters");
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("External URL is invalid");
  }

  if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`External URL protocol is not allowed: ${parsed.protocol || "unknown"}`);
  }

  if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.hostname) {
    throw new Error("External URL host is missing");
  }

  if (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    (parsed.username || parsed.password)
  ) {
    throw new Error("External URL credentials are not allowed");
  }

  return parsed.toString();
}

async function openSafeExternalUrl(shell, input) {
  const safeUrl = getSafeExternalUrl(input);
  await shell.openExternal(safeUrl);
  return safeUrl;
}

module.exports = {
  ALLOWED_EXTERNAL_PROTOCOLS,
  getSafeExternalUrl,
  openSafeExternalUrl,
};
