const MAX_HISTORY_CURSOR_LENGTH = 512;

function encodeHistoryCursor(row) {
  const id = Number(row?.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;

  const timestamp = String(row?.timestamp || row?.created_at || "").trim();
  if (!timestamp) return null;

  return Buffer.from(JSON.stringify({ t: timestamp, i: id }), "utf8").toString("base64url");
}

function decodeHistoryCursor(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > MAX_HISTORY_CURSOR_LENGTH) return null;

  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    const id = Number(parsed?.i);
    const timestamp = String(parsed?.t || "").trim();
    if (!Number.isSafeInteger(id) || id <= 0 || !timestamp) return null;
    return { timestamp, id };
  } catch {
    return null;
  }
}

module.exports = {
  MAX_HISTORY_CURSOR_LENGTH,
  encodeHistoryCursor,
  decodeHistoryCursor,
};
