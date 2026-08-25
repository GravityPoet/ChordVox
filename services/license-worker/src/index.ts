const MAX_BODY_SIZE_BYTES = 64 * 1024;
const CREEM_TIMEOUT_MS = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 15 * 60 * 1000;
const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const FORCED_MAX_ACTIVATIONS = 1;
const LICENSE_STATUSES = new Set(["active", "revoked", "expired"]);

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue | undefined };

type SecretBindings = {
  CREEM_API_KEY?: string;
  CREEM_PRODUCT_ID?: string;
  CREEM_PRODUCT_IDS?: string;
  CREEM_WEBHOOK_SECRET?: string;
  INTERNAL_OWNER_KEY?: string;
  LICENSE_KEY_PEPPER?: string;
  LICENSE_SERVER_ADMIN_TOKEN?: string;
};

type RuntimeEnv = Env & SecretBindings;

type LicenseRow = {
  id: number;
  key_hash: string;
  key_hint: string;
  product_id: string;
  plan: string;
  status: string;
  max_activations: number;
  expires_at: string | null;
  customer_email: string | null;
  order_ref: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type ActivationRow = {
  id?: number;
  license_id?: number;
  machine_id: string;
  platform: string | null;
  arch: string | null;
  app_version: string | null;
  first_activated_at: string;
  last_validated_at: string;
};

type TrialRow = {
  id?: number;
  product_id: string;
  machine_id: string;
  platform: string | null;
  arch: string | null;
  app_version: string | null;
  started_at: string;
  expires_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
};

type LicenseDetails = {
  id: number;
  keyHint: string;
  productId: string;
  plan: string;
  status: string;
  maxActivations: number;
  expiresAt: string | null;
  customerEmail: string | null;
  orderRef: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  activations: ActivationRow[];
};

type ClientLicenseResponse = {
  valid: boolean;
  status: string;
  plan?: string | null;
  expiresAt?: string | null;
  offlineGraceHours?: number;
  message: string;
  error?: string | null;
  instanceId?: string | null;
};

class RelayError extends Error {
  httpStatus: number;
  payload: JsonObject;
  codeName: string | null;

  constructor(message: string, httpStatus: number, payload: JsonObject, codeName: string | null = null) {
    super(message);
    this.httpStatus = httpStatus;
    this.payload = payload;
    this.codeName = codeName;
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRecord(source: JsonObject | undefined, key: string): JsonObject | undefined {
  const value = source?.[key];
  return isRecord(value) ? value : undefined;
}

function getArray(source: JsonObject | undefined, key: string): JsonObject[] {
  const value = source?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function normalizeText(value: unknown, maxLen = 255): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return text.slice(0, maxLen);
}

function normalizeLicenseKey(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "");
}

function normalizeMachineId(value: unknown): string {
  const machineId = String(value ?? "").trim();
  if (!machineId) return "";
  return machineId.slice(0, 128);
}

function readInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function readList(value: unknown): string[] {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readOriginList(value: unknown): string[] {
  return readList(value)
    .map((item) => {
      try {
        return new URL(item).origin;
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

function normalizeIso(value: unknown): string | null {
  const text = normalizeText(value, 80);
  if (!text) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultProductId(env: RuntimeEnv): string {
  return normalizeText(env.LICENSE_DEFAULT_PRODUCT_ID, 80) ?? "chordvox-pro";
}

function defaultOfflineGraceHours(env: RuntimeEnv): number {
  return readInt(env.LICENSE_DEFAULT_OFFLINE_GRACE_HOURS, 168);
}

function defaultTrialDays(env: RuntimeEnv): number {
  return readInt(env.LICENSE_DEFAULT_TRIAL_DAYS, 7);
}

function creemProductIds(env: RuntimeEnv): string[] {
  return readList(env.CREEM_PRODUCT_IDS ?? env.CREEM_PRODUCT_ID);
}

function allowedOrigins(env: RuntimeEnv): string[] {
  return readOriginList(env.LICENSE_SERVER_ALLOWED_ORIGINS ?? "https://chordvox.com,https://www.chordvox.com");
}

function responseHeaders(request: Request, env: RuntimeEnv): Headers {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  headers.set("X-ChordVox-License-Backend", "worker");
  const origin = normalizeText(request.headers.get("origin"), 255);
  if (origin && allowedOrigins(env).includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return headers;
}

function jsonResponse(request: Request, env: RuntimeEnv, status: number, payload: JsonObject): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: responseHeaders(request, env),
  });
}

function optionsResponse(request: Request, env: RuntimeEnv): Response {
  const headers = responseHeaders(request, env);
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  return new Response(null, { status: 204, headers });
}

async function parseJsonBody(request: Request): Promise<JsonObject> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_SIZE_BYTES) {
    throw new Error("Request body too large");
  }
  const text = await request.text();
  if (text.length > MAX_BODY_SIZE_BYTES) {
    throw new Error("Request body too large");
  }
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("JSON body must be an object");
  }
  return parsed;
}

async function parseRawBody(request: Request): Promise<Uint8Array> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_SIZE_BYTES) {
    throw new Error("Request body too large");
  }
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > MAX_BODY_SIZE_BYTES) {
    throw new Error("Request body too large");
  }
  return new Uint8Array(buffer);
}

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSha256Hex(secret: string, message: string | Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8Bytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const payload = typeof message === "string" ? utf8Bytes(message) : message;
  const signature = await crypto.subtle.sign("HMAC", key, payload);
  return bytesToHex(new Uint8Array(signature));
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const leftBytes = utf8Bytes(left);
  const rightBytes = utf8Bytes(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  return crypto.subtle.timingSafeEqual(leftBytes, rightBytes);
}

async function hashLicenseKey(licenseKey: string, pepper: string): Promise<string> {
  return hmacSha256Hex(pepper, normalizeLicenseKey(licenseKey));
}

function maskLicenseKey(licenseKey: string): string {
  const normalized = normalizeLicenseKey(licenseKey);
  if (!normalized) return "";
  if (normalized.length <= 8) return normalized;
  return `${normalized.slice(0, 4)}...${normalized.slice(-4)}`;
}

function randomReadableSegment(length = 4): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let output = "";
  for (const byte of bytes) {
    output += KEY_ALPHABET[byte % KEY_ALPHABET.length] ?? "A";
  }
  return output;
}

function generateLicenseKey(prefix = "AK", groups = 4, groupLength = 4): string {
  const normalizedPrefix = String(prefix || "AK")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const segments: string[] = [];
  for (let index = 0; index < groups; index += 1) {
    segments.push(randomReadableSegment(groupLength));
  }
  return `${normalizedPrefix || "AK"}-${segments.join("-")}`;
}

function safeSqlLimit(value: unknown, fallback = 20): number {
  return Math.max(1, Math.min(readInt(value, fallback), 200));
}

async function getLicenseByHash(env: RuntimeEnv, keyHash: string, productId: string): Promise<LicenseRow | null> {
  return env.DB.prepare("SELECT * FROM licenses WHERE key_hash = ? AND product_id = ?")
    .bind(keyHash, productId)
    .first<LicenseRow>();
}

async function getLicenseByKey(env: RuntimeEnv, licenseKey: string, productIdInput: unknown): Promise<LicenseRow | null> {
  const pepper = normalizeText(env.LICENSE_KEY_PEPPER, 512);
  const normalizedKey = normalizeLicenseKey(licenseKey);
  if (!pepper || !normalizedKey) return null;
  const productId = normalizeText(productIdInput, 80) ?? defaultProductId(env);
  const keyHash = await hashLicenseKey(normalizedKey, pepper);
  return getLicenseByHash(env, keyHash, productId);
}

function isIsoExpired(value: string | null | undefined): boolean {
  if (!value) return false;
  const expiresMs = Date.parse(value);
  if (!Number.isFinite(expiresMs)) return false;
  return expiresMs <= Date.now();
}

function buildLicensePayload(
  row: LicenseRow | null,
  message: string,
  graceHours: number,
  valid = true,
  error: string | null = null,
): ClientLicenseResponse {
  const expired = isIsoExpired(row?.expires_at);
  const status = expired ? "expired" : row?.status === "active" ? "active" : "invalid";
  const isValid = valid && status === "active";
  return {
    valid: isValid,
    status,
    plan: row?.plan ?? null,
    expiresAt: row?.expires_at ?? null,
    offlineGraceHours: graceHours,
    message,
    error,
  };
}

async function loadLicenseForClientRequest(
  env: RuntimeEnv,
  licenseKey: unknown,
  productId: unknown,
): Promise<{ row: LicenseRow } | { errorPayload: ClientLicenseResponse }> {
  const normalizedKey = normalizeLicenseKey(licenseKey);
  if (!normalizedKey) {
    return { errorPayload: { valid: false, status: "invalid", message: "licenseKey is required." } };
  }

  const row = await getLicenseByKey(env, normalizedKey, productId);
  if (!row) {
    return {
      errorPayload: {
        valid: false,
        status: "invalid",
        message: "License key is invalid for this product.",
      },
    };
  }

  if (row.status === "revoked") {
    return {
      errorPayload: buildLicensePayload(row, "License has been revoked. Contact support.", defaultOfflineGraceHours(env), false, "LICENSE_REVOKED"),
    };
  }

  if (isIsoExpired(row.expires_at)) {
    await env.DB.prepare("UPDATE licenses SET status = ?, notes = ?, updated_at = ? WHERE id = ?")
      .bind("expired", row.notes, nowIso(), row.id)
      .run();
    return {
      errorPayload: buildLicensePayload(
        { ...row, status: "expired" },
        "License has expired.",
        defaultOfflineGraceHours(env),
        false,
        "LICENSE_EXPIRED",
      ),
    };
  }

  if (row.status !== "active") {
    return {
      errorPayload: buildLicensePayload(row, "License is not active.", defaultOfflineGraceHours(env), false, "LICENSE_NOT_ACTIVE"),
    };
  }

  return { row };
}

export const INSERT_ACTIVATION_IF_SLOT_AVAILABLE_SQL =
  "INSERT OR IGNORE INTO activations (license_id, machine_id, platform, arch, app_version, first_activated_at, last_validated_at) " +
  "SELECT ?, ?, ?, ?, ?, ?, ? " +
  "WHERE NOT EXISTS (SELECT 1 FROM activations WHERE license_id = ? AND machine_id = ?) " +
  "AND (SELECT COUNT(*) FROM activations WHERE license_id = ?) < ?";

async function loadExistingActivation(
  env: RuntimeEnv,
  licenseId: number,
  machineId: string,
): Promise<ActivationRow | null> {
  const existing = await env.DB.prepare("SELECT * FROM activations WHERE license_id = ? AND machine_id = ?")
    .bind(licenseId, machineId)
    .first<ActivationRow>();
  return existing ?? null;
}

async function touchExistingActivation(
  env: RuntimeEnv,
  row: LicenseRow,
  machineId: string,
  platform: string | null,
  arch: string | null,
  appVersion: string | null,
  now: string,
): Promise<ClientLicenseResponse> {
  await env.DB.prepare(
    "UPDATE activations SET platform = ?, arch = ?, app_version = ?, last_validated_at = ? WHERE license_id = ? AND machine_id = ?",
  )
    .bind(platform, arch, appVersion, now, row.id, machineId)
    .run();
  return buildLicensePayload(row, "License already active on this device.", defaultOfflineGraceHours(env), true);
}

async function activateLocalLicense(env: RuntimeEnv, payload: JsonObject): Promise<ClientLicenseResponse> {
  const machineId = normalizeMachineId(payload.machineId);
  if (!machineId) {
    return { valid: false, status: "invalid", message: "machineId is required." };
  }

  const lookup = await loadLicenseForClientRequest(env, payload.licenseKey, payload.productId);
  if ("errorPayload" in lookup) return lookup.errorPayload;

  const row = lookup.row;
  const now = nowIso();
  const platform = normalizeText(payload.platform, 32);
  const arch = normalizeText(payload.arch, 32);
  const appVersion = normalizeText(payload.appVersion, 32);

  const existing = await loadExistingActivation(env, row.id, machineId);
  if (existing) {
    return touchExistingActivation(env, row, machineId, platform, arch, appVersion, now);
  }

  const insertResult = await env.DB.prepare(INSERT_ACTIVATION_IF_SLOT_AVAILABLE_SQL)
    .bind(row.id, machineId, platform, arch, appVersion, now, now, row.id, machineId, row.id, row.max_activations)
    .run();
  if (resultChanges(insertResult) <= 0) {
    const racedExisting = await loadExistingActivation(env, row.id, machineId);
    if (racedExisting) {
      return touchExistingActivation(env, row, machineId, platform, arch, appVersion, now);
    }

    return buildLicensePayload(
      row,
      "This license key supports only 1 device. To switch devices, contact support to reset activation.",
      defaultOfflineGraceHours(env),
      false,
      "LICENSE_ACTIVATION_LIMIT",
    );
  }

  return buildLicensePayload(row, "License activated.", defaultOfflineGraceHours(env), true);
}

async function validateLocalLicense(env: RuntimeEnv, payload: JsonObject): Promise<ClientLicenseResponse> {
  const machineId = normalizeMachineId(payload.machineId);
  if (!machineId) {
    return { valid: false, status: "invalid", message: "machineId is required." };
  }

  const lookup = await loadLicenseForClientRequest(env, payload.licenseKey, payload.productId);
  if ("errorPayload" in lookup) return lookup.errorPayload;
  const row = lookup.row;

  const existing = await env.DB.prepare("SELECT * FROM activations WHERE license_id = ? AND machine_id = ?")
    .bind(row.id, machineId)
    .first<ActivationRow>();
  if (!existing) {
    return buildLicensePayload(row, "License is not activated on this device.", defaultOfflineGraceHours(env), false, "LICENSE_DEVICE_NOT_ACTIVATED");
  }

  await env.DB.prepare(
    "UPDATE activations SET platform = ?, arch = ?, app_version = ?, last_validated_at = ? WHERE license_id = ? AND machine_id = ?",
  )
    .bind(normalizeText(payload.platform, 32), normalizeText(payload.arch, 32), normalizeText(payload.appVersion, 32), nowIso(), row.id, machineId)
    .run();
  return buildLicensePayload(row, "License validated.", defaultOfflineGraceHours(env), true);
}

async function resetActivationByKey(env: RuntimeEnv, licenseKey: unknown, productId: unknown, machineIdInput: unknown): Promise<JsonObject> {
  const row = await getLicenseByKey(env, normalizeLicenseKey(licenseKey), productId);
  if (!row) {
    return { updated: false, deleted: 0, message: "License not found." };
  }

  const normalizedMachineId = machineIdInput ? normalizeMachineId(machineIdInput) : "";
  const result = normalizedMachineId
    ? await env.DB.prepare("DELETE FROM activations WHERE license_id = ? AND machine_id = ?").bind(row.id, normalizedMachineId).run()
    : await env.DB.prepare("DELETE FROM activations WHERE license_id = ?").bind(row.id).run();
  const deleted = resultChanges(result);
  if (deleted > 0) {
    await env.DB.prepare("UPDATE licenses SET updated_at = ? WHERE id = ?").bind(nowIso(), row.id).run();
  }
  return {
    updated: deleted > 0,
    deleted,
    id: row.id,
    machineId: normalizedMachineId || null,
    message:
      deleted > 0
        ? normalizedMachineId
          ? "Activation reset for machine."
          : "All activations reset for this license."
        : normalizedMachineId
          ? "No activation found for this machine."
          : "No activations found for this license.",
  };
}

async function deactivateLocalLicense(env: RuntimeEnv, payload: JsonObject): Promise<JsonObject> {
  const licenseKey = normalizeLicenseKey(payload.licenseKey);
  const machineId = normalizeMachineId(payload.machineId);
  const instanceId = normalizeText(payload.instanceId, 128);
  if (!licenseKey || !machineId) {
    return {
      success: false,
      error: "LICENSE_DEVICE_NOT_ACTIVATED",
      message: "licenseKey and machineId are required.",
    };
  }
  if (instanceId && instanceId !== buildInternalInstanceId(machineId)) {
    return {
      success: false,
      error: "LICENSE_DEVICE_NOT_ACTIVATED",
      message: "License is not activated on this device.",
    };
  }
  const result = await resetActivationByKey(env, licenseKey, payload.productId, machineId);
  const updated = Boolean(result.updated);
  return {
    success: updated,
    message: normalizeText(result.message, 500) ?? "Activation reset.",
    error: updated ? null : "LICENSE_DEVICE_NOT_ACTIVATED",
  };
}

function buildInternalInstanceId(machineId: unknown): string {
  const safeMachineId = normalizeMachineId(machineId) || "unknown-machine";
  return `local-${safeMachineId.slice(0, 16)}`;
}

function buildInstanceName(payload: JsonObject): string {
  const safeMachineId = normalizeMachineId(payload.machineId) || "unknown-machine";
  const safePlatform = normalizeText(payload.platform, 32) ?? "unknown-platform";
  const safeArch = normalizeText(payload.arch, 32) ?? "unknown-arch";
  return `ChordVox-${safePlatform}-${safeArch}-${safeMachineId.slice(0, 12)}`.slice(0, 100);
}

function extractCreemLicense(payload: JsonObject = {}): JsonObject {
  const data = getRecord(payload, "data");
  const candidates = [getRecord(payload, "license"), getRecord(data, "license"), data, payload];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (
      normalizeText(candidate.status, 80) ||
      normalizeText(candidate.key, 128) ||
      normalizeText(candidate.product_id, 128) ||
      normalizeText(candidate.productId, 128)
    ) {
      return candidate;
    }
  }
  return {};
}

function extractCreemInstanceId(payload: JsonObject = {}): string | null {
  const data = getRecord(payload, "data");
  const instance = getRecord(payload, "instance");
  const dataInstance = getRecord(data, "instance");
  const activation = getRecord(payload, "activation");
  const instances = getArray(payload, "instances");
  const dataInstances = getArray(data, "instances");
  const candidates: unknown[] = [
    payload.instance_id,
    payload.instanceId,
    instance?.id,
    instance?.instance_id,
    data?.instance_id,
    data?.instanceId,
    dataInstance?.id,
    dataInstance?.instance_id,
    activation?.instance_id,
    activation?.id,
    instances[0]?.id,
    dataInstances[0]?.id,
  ];
  for (const candidate of candidates) {
    const value = normalizeText(candidate, 128);
    if (value) return value;
  }
  return null;
}

function getCreemStatus(payload: JsonObject = {}): string {
  const license = extractCreemLicense(payload);
  return String(license.status ?? payload.status ?? "").trim().toLowerCase();
}

function getCreemProductId(payload: JsonObject = {}): string | null {
  const license = extractCreemLicense(payload);
  const product = getRecord(license, "product");
  const payloadProduct = getRecord(payload, "product");
  const data = getRecord(payload, "data");
  const dataProduct = getRecord(data, "product");
  return normalizeText(
    license.product_id ??
      license.productId ??
      product?.id ??
      payload.product_id ??
      payload.productId ??
      payloadProduct?.id ??
      data?.product_id ??
      data?.productId ??
      dataProduct?.id,
    120,
  );
}

function mapCreemStatusToClientStatus(rawStatus: string): string {
  if (rawStatus === "active") return "active";
  if (rawStatus === "expired") return "expired";
  return "invalid";
}

function mapCreemStatusToError(rawStatus: string): string {
  switch (rawStatus) {
    case "expired":
      return "LICENSE_EXPIRED";
    case "disabled":
    case "revoked":
      return "LICENSE_REVOKED";
    case "inactive":
      return "LICENSE_NOT_ACTIVE";
    default:
      return "LICENSE_INVALID";
  }
}

function buildClientLicenseResponse(env: RuntimeEnv, payload: JsonObject = {}, overrides: JsonObject = {}): JsonObject {
  const rawStatus = String(overrides.rawStatus ?? getCreemStatus(payload)).trim().toLowerCase();
  const status = normalizeText(overrides.status, 32) ?? mapCreemStatusToClientStatus(rawStatus);
  const valid = typeof overrides.valid === "boolean" ? overrides.valid : status === "active";
  const license = extractCreemLicense(payload);
  const error = normalizeText(overrides.error, 120) ?? (status === "active" ? null : mapCreemStatusToError(rawStatus));
  return {
    valid,
    status,
    plan: normalizeText(license.plan ?? payload.plan ?? payload.tier, 80),
    expiresAt: normalizeIso(overrides.expiresAt ?? license.expires_at ?? license.expiresAt ?? payload.expires_at ?? payload.expiresAt),
    offlineGraceHours: defaultOfflineGraceHours(env),
    message:
      normalizeText(overrides.message, 1000) ??
      normalizeText(payload.message, 1000) ??
      normalizeText(getRecord(payload, "error")?.message ?? payload.error, 1000) ??
      (valid ? "License validated." : "License is not valid."),
    error,
    instanceId: normalizeText(overrides.instanceId, 128) ?? extractCreemInstanceId(payload),
  };
}

function buildCreemProductMismatchResponse(env: RuntimeEnv, payload: JsonObject = {}): JsonObject | null {
  const allowed = creemProductIds(env);
  if (allowed.length === 0) return null;
  const actualProductId = getCreemProductId(payload);
  if (actualProductId && allowed.includes(actualProductId)) return null;
  return buildClientLicenseResponse(env, payload, {
    valid: false,
    status: "invalid",
    error: "LICENSE_PRODUCT_MISMATCH",
    message: actualProductId ? "License belongs to a different product." : "Creem license response did not include a product id.",
  });
}

async function postCreemJson(env: RuntimeEnv, endpoint: string, payload: JsonObject): Promise<JsonObject> {
  const apiKey = normalizeText(env.CREEM_API_KEY, 2048);
  if (!apiKey) {
    throw new RelayError("Creem API key is not configured.", 401, {}, null);
  }
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), CREEM_TIMEOUT_MS);
  try {
    const baseUrl = (normalizeText(env.CREEM_API_BASE_URL, 255) ?? "https://api.creem.io").replace(/\/+$/, "");
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: JsonObject = {};
    if (text) {
      const raw = JSON.parse(text) as unknown;
      parsed = isRecord(raw) ? raw : { message: text };
    }
    if (!response.ok) {
      const message =
        normalizeText(getRecord(parsed, "error")?.message, 1000) ??
        normalizeText(parsed.message, 1000) ??
        `Creem API returned ${response.status} ${response.statusText}`;
      throw new RelayError(message, response.status, parsed);
    }
    return parsed;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new RelayError("Creem API request timed out.", 0, {}, "TIMEOUT");
    }
    if (error instanceof RelayError) throw error;
    throw new RelayError(error instanceof Error ? error.message : "Creem API request failed.", 0, {});
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function mapCreemActivateFailure(env: RuntimeEnv, error: RelayError): JsonObject {
  const httpStatus = Number(error.httpStatus || 0);
  const message =
    normalizeText(getRecord(error.payload, "error")?.message ?? error.payload.message ?? error.message, 1000) ??
    "Failed to activate license.";
  let code = "LICENSE_ACTIVATION_FAILED";
  if (httpStatus === 404) {
    code = "LICENSE_INVALID";
  } else if (httpStatus === 403 || /activation|device|instance/i.test(message)) {
    code = "LICENSE_ACTIVATION_LIMIT";
  } else if (httpStatus === 401) {
    code = "LICENSE_SERVER_NOT_CONFIGURED";
  }
  return buildClientLicenseResponse(env, error.payload, {
    valid: false,
    status: "invalid",
    error: code,
    message,
  });
}

function mapCreemValidateFailure(env: RuntimeEnv, error: RelayError): JsonObject {
  const httpStatus = Number(error.httpStatus || 0);
  const message =
    normalizeText(getRecord(error.payload, "error")?.message ?? error.payload.message ?? error.message, 1000) ??
    "Failed to validate license.";
  let code = "LICENSE_VALIDATION_FAILED";
  if (httpStatus === 404 && /instance|device/i.test(message)) {
    code = "LICENSE_DEVICE_NOT_ACTIVATED";
  } else if (httpStatus === 404) {
    code = "LICENSE_INVALID";
  } else if (httpStatus === 401) {
    code = "LICENSE_SERVER_NOT_CONFIGURED";
  }
  return buildClientLicenseResponse(env, error.payload, {
    valid: false,
    status: "invalid",
    error: code,
    message,
  });
}

function mapCreemDeactivateFailure(error: RelayError): JsonObject {
  const httpStatus = Number(error.httpStatus || 0);
  const message =
    normalizeText(getRecord(error.payload, "error")?.message ?? error.payload.message ?? error.message, 1000) ??
    "Failed to deactivate license instance.";
  if (httpStatus === 404) {
    return { success: true, message: "Remote activation was already cleared." };
  }
  return {
    success: false,
    error: httpStatus === 401 ? "LICENSE_SERVER_NOT_CONFIGURED" : "LICENSE_DEACTIVATION_FAILED",
    message,
  };
}

async function getLocalLicenseDetails(env: RuntimeEnv, licenseKey: unknown, productId: unknown): Promise<LicenseDetails | null> {
  await ensureInternalOwnerLicense(env);
  const row = await getLicenseByKey(env, normalizeLicenseKey(licenseKey), productId);
  if (!row) return null;
  const activations = await env.DB.prepare(
    "SELECT machine_id, platform, arch, app_version, first_activated_at, last_validated_at FROM activations WHERE license_id = ? ORDER BY id ASC",
  )
    .bind(row.id)
    .all<ActivationRow>();
  return {
    id: row.id,
    keyHint: row.key_hint,
    productId: row.product_id,
    plan: row.plan,
    status: row.status,
    maxActivations: row.max_activations,
    expiresAt: row.expires_at,
    customerEmail: row.customer_email,
    orderRef: row.order_ref,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activations: activations.results ?? [],
  };
}

function resultChanges(result: D1Result): number {
  const meta = result.meta as { changes?: number; rows_written?: number };
  return Number(meta.changes ?? meta.rows_written ?? 0);
}

async function ensureInternalOwnerLicense(env: RuntimeEnv): Promise<void> {
  const ownerKey = normalizeLicenseKey(env.INTERNAL_OWNER_KEY);
  const pepper = normalizeText(env.LICENSE_KEY_PEPPER, 512);
  if (!ownerKey || !pepper) return;

  const keyHash = await hashLicenseKey(ownerKey, pepper);
  const existing = await getLicenseByHash(env, keyHash, defaultProductId(env));
  const now = nowIso();
  if (existing) {
    await env.DB.prepare(
      "UPDATE licenses SET plan = ?, status = ?, max_activations = ?, expires_at = NULL, notes = ?, updated_at = ? WHERE id = ?",
    )
      .bind(
        normalizeText(env.INTERNAL_OWNER_PLAN, 80) ?? "owner",
        "active",
        readInt(env.INTERNAL_OWNER_MAX_ACTIVATIONS, 5),
        "Internal owner license",
        now,
        existing.id,
      )
      .run();
    return;
  }

  await env.DB.prepare(
    "INSERT INTO licenses (key_hash, key_hint, product_id, plan, status, max_activations, expires_at, customer_email, order_ref, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)",
  )
    .bind(
      keyHash,
      maskLicenseKey(ownerKey),
      defaultProductId(env),
      normalizeText(env.INTERNAL_OWNER_PLAN, 80) ?? "owner",
      "active",
      readInt(env.INTERNAL_OWNER_MAX_ACTIVATIONS, 5),
      "Internal owner license",
      now,
      now,
    )
    .run();
}

async function issueLicense(env: RuntimeEnv, payload: JsonObject): Promise<JsonObject> {
  const pepper = normalizeText(env.LICENSE_KEY_PEPPER, 512);
  if (!pepper) throw new Error("LICENSE_KEY_PEPPER is required.");

  const productId = normalizeText(payload.productId, 80) ?? defaultProductId(env);
  const plan = normalizeText(payload.plan, 80) ?? "pro";
  const statusInput = normalizeText(payload.status, 32) ?? "active";
  const status = LICENSE_STATUSES.has(statusInput) ? statusInput : "active";
  const expiresAt = normalizeText(payload.expiresAt, 64);
  const customerEmail = normalizeText(payload.customerEmail ?? payload.email, 255);
  const orderRef = normalizeText(payload.orderRef ?? payload.orderId, 255);
  const notes = normalizeText(payload.notes, 1000);
  const providedKey = normalizeLicenseKey(payload.licenseKey);
  let plainLicenseKey = providedKey;
  for (let attempt = 0; attempt < 20 && !plainLicenseKey; attempt += 1) {
    const candidate = generateLicenseKey("AK");
    const duplicate = await env.DB.prepare("SELECT id FROM licenses WHERE key_hash = ?")
      .bind(await hashLicenseKey(candidate, pepper))
      .first<{ id: number }>();
    if (!duplicate) plainLicenseKey = candidate;
  }
  if (!plainLicenseKey) throw new Error("Could not generate a unique license key after multiple attempts.");

  const keyHash = await hashLicenseKey(plainLicenseKey, pepper);
  const duplicate = await env.DB.prepare("SELECT id FROM licenses WHERE key_hash = ?").bind(keyHash).first<{ id: number }>();
  if (duplicate) throw new Error("License key already exists.");

  const now = nowIso();
  const result = await env.DB.prepare(
    "INSERT INTO licenses (key_hash, key_hint, product_id, plan, status, max_activations, expires_at, customer_email, order_ref, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(keyHash, maskLicenseKey(plainLicenseKey), productId, plan, status, FORCED_MAX_ACTIVATIONS, expiresAt, customerEmail, orderRef, notes, now, now)
    .run();
  const meta = result.meta as { last_row_id?: number };
  return {
    success: true,
    license: {
      id: meta.last_row_id ?? null,
      licenseKey: plainLicenseKey,
      keyHint: maskLicenseKey(plainLicenseKey),
      productId,
      plan,
      status,
      maxActivations: FORCED_MAX_ACTIVATIONS,
      expiresAt: expiresAt ?? null,
      customerEmail,
      orderRef,
    },
  };
}

function parseDaysToIso(days: unknown): string | null {
  if (days === undefined || days === null || days === "") return null;
  const value = Number(days);
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(Date.now() + value * DAY_MS).toISOString();
}

async function listLicenses(env: RuntimeEnv, limitInput: unknown): Promise<JsonObject[]> {
  const limit = safeSqlLimit(limitInput, 20);
  const rows = await env.DB.prepare(
    `SELECT l.*, COALESCE(a.activation_count, 0) AS activation_count
     FROM licenses l
     LEFT JOIN (
       SELECT license_id, COUNT(*) AS activation_count
       FROM activations
       GROUP BY license_id
     ) a ON a.license_id = l.id
     ORDER BY l.id DESC
     LIMIT ?`,
  )
    .bind(limit)
    .all<LicenseRow & { activation_count: number }>();
  return (rows.results ?? []).map((row) => ({
    id: row.id,
    keyHint: row.key_hint,
    productId: row.product_id,
    plan: row.plan,
    status: row.status,
    maxActivations: row.max_activations,
    activationCount: row.activation_count,
    expiresAt: row.expires_at,
    customerEmail: row.customer_email,
    orderRef: row.order_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

async function ensureTrial(env: RuntimeEnv, payload: JsonObject): Promise<JsonObject> {
  const productId = normalizeText(payload.productId, 80) ?? defaultProductId(env);
  const machineId = normalizeMachineId(payload.machineId);
  const trialDays = defaultTrialDays(env);

  if (!machineId) {
    return {
      success: false,
      valid: false,
      status: "invalid",
      plan: null,
      trialEnabled: true,
      trialDays,
      trialStartedAt: null,
      trialExpiresAt: null,
      trialDaysLeft: 0,
      trialActive: false,
      error: "TRIAL_DEVICE_REQUIRED",
      message: "machineId is required.",
    };
  }

  const existing = await env.DB.prepare("SELECT * FROM trials WHERE product_id = ? AND machine_id = ?")
    .bind(productId, machineId)
    .first<TrialRow>();
  const now = nowIso();
  const platform = normalizeText(payload.platform, 32);
  const arch = normalizeText(payload.arch, 32);
  const appVersion = normalizeText(payload.appVersion, 32);
  if (existing) {
    await env.DB.prepare(
      "UPDATE trials SET platform = ?, arch = ?, app_version = ?, last_seen_at = ?, updated_at = ? WHERE product_id = ? AND machine_id = ?",
    )
      .bind(platform, arch, appVersion, now, now, productId, machineId)
      .run();
    return buildTrialPayload({ ...existing, platform, arch, app_version: appVersion, last_seen_at: now, updated_at: now }, trialDays);
  }

  const importedTrial = getImportedTrialWindow(payload, trialDays);
  if (payload.startIfNeeded !== true && !importedTrial) {
    return {
      success: true,
      valid: false,
      status: "unlicensed",
      plan: null,
      expiresAt: null,
      trialEnabled: true,
      trialDays,
      trialStartedAt: null,
      trialExpiresAt: null,
      trialDaysLeft: 0,
      trialActive: false,
      error: null,
      message: `Your ${trialDays}-day Pro trial starts the first time you use a Pro feature.`,
    };
  }

  const startedAt = importedTrial?.trialStartedAt ?? now;
  const expiresAt = importedTrial?.trialExpiresAt ?? new Date(Date.parse(startedAt) + trialDays * DAY_MS).toISOString();
  const row: TrialRow = {
    product_id: productId,
    machine_id: machineId,
    platform,
    arch,
    app_version: appVersion,
    started_at: startedAt,
    expires_at: expiresAt,
    last_seen_at: now,
    created_at: now,
    updated_at: now,
  };
  await env.DB.prepare(
    "INSERT INTO trials (product_id, machine_id, platform, arch, app_version, started_at, expires_at, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(productId, machineId, platform, arch, appVersion, startedAt, expiresAt, now, now, now)
    .run();
  return buildTrialPayload(row, trialDays, importedTrial ? undefined : `Pro trial started. ${trialDays} day(s) remaining.`);
}

function getImportedTrialWindow(payload: JsonObject, trialDays: number): { trialStartedAt: string; trialExpiresAt: string } | null {
  const trialStartedAt = normalizeIso(payload.trialStartedAt ?? payload.trial_started_at);
  const trialExpiresAt = normalizeIso(payload.trialExpiresAt ?? payload.trial_expires_at ?? payload.expiresAt ?? payload.expires_at);
  if (!trialStartedAt || !trialExpiresAt) return null;
  const nowMs = Date.now();
  const startedMs = Date.parse(trialStartedAt);
  const expiresMs = Date.parse(trialExpiresAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(expiresMs)) return null;
  if (expiresMs <= startedMs) return null;
  if (startedMs > nowMs + CLOCK_SKEW_MS) return null;
  if (expiresMs - startedMs > trialDays * DAY_MS + CLOCK_SKEW_MS) return null;
  return { trialStartedAt, trialExpiresAt };
}

function buildTrialPayload(row: TrialRow, trialDays: number, message?: string): JsonObject {
  const nowMs = Date.now();
  const expiresMs = Date.parse(row.expires_at);
  const trialActive = Number.isFinite(expiresMs) && expiresMs > nowMs;
  const trialDaysLeft = trialActive ? Math.max(1, Math.ceil((expiresMs - nowMs) / DAY_MS)) : 0;
  return {
    success: true,
    valid: trialActive,
    status: trialActive ? "active" : "expired",
    plan: "trial",
    expiresAt: row.expires_at,
    trialEnabled: true,
    trialDays,
    trialStartedAt: row.started_at,
    trialExpiresAt: row.expires_at,
    trialDaysLeft,
    trialActive,
    message: message ?? (trialActive ? `Pro trial active. ${trialDaysLeft} day(s) remaining.` : "Pro trial has expired."),
    error: trialActive ? null : "TRIAL_EXPIRED",
  };
}

function readBearerToken(request: Request): string {
  const header = normalizeText(request.headers.get("authorization"), 4096) ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
}

async function ensureAdminAuthorized(request: Request, env: RuntimeEnv): Promise<JsonObject | null> {
  const adminToken = normalizeText(env.LICENSE_SERVER_ADMIN_TOKEN, 4096);
  if (!adminToken) {
    return {
      error: "ADMIN_TOKEN_NOT_CONFIGURED",
      message: "Set LICENSE_SERVER_ADMIN_TOKEN to use admin endpoints.",
    };
  }
  const token = readBearerToken(request);
  if (!token || !(await constantTimeEqual(token, adminToken))) {
    return { error: "UNAUTHORIZED", message: "Missing or invalid admin token." };
  }
  return null;
}

async function verifyCreemSignature(rawBody: Uint8Array, signatureHeader: string, secret: string): Promise<boolean> {
  if (!secret || !signatureHeader) return false;
  const cleanSig = signatureHeader.replace(/^(sha256=|v1=)/, "");
  const secrets = secret.startsWith("whsec_") ? [secret, secret.slice("whsec_".length)] : [secret];
  for (const currentSecret of secrets) {
    const expected = await hmacSha256Hex(currentSecret, rawBody);
    if (await constantTimeEqual(expected, cleanSig)) return true;
  }
  return false;
}

async function handleWebhook(request: Request, env: RuntimeEnv): Promise<JsonObject> {
  const secret = normalizeText(env.CREEM_WEBHOOK_SECRET, 4096);
  if (!secret) return { error: "WEBHOOK_NOT_CONFIGURED" };
  const rawBody = await parseRawBody(request);
  const signature = normalizeText(request.headers.get("creem-signature"), 4096) ?? "";
  if (!(await verifyCreemSignature(rawBody, signature, secret))) {
    return { error: "INVALID_SIGNATURE" };
  }
  const text = new TextDecoder().decode(rawBody);
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) return { error: "INVALID_JSON" };
  const eventType = normalizeText(parsed.eventType ?? parsed.event_type ?? parsed.type, 120) ?? "";
  if (eventType !== "checkout.completed") {
    return { received: true, skipped: eventType };
  }
  const checkout = getRecord(parsed, "object") ?? getRecord(parsed, "data") ?? parsed;
  const order = getRecord(checkout, "order") ?? checkout;
  const product = getRecord(checkout, "product");
  const orderProduct = getRecord(order, "product");
  const customer = getRecord(checkout, "customer");
  const orderCustomer = getRecord(order, "customer");
  return {
    received: true,
    eventType,
    customerEmail: normalizeText(customer?.email ?? orderCustomer?.email ?? checkout.customer_email ?? order.customer_email, 255),
    orderId: normalizeText(order.id ?? checkout.id ?? parsed.id, 255),
    productId: normalizeText(product?.id ?? orderProduct?.id ?? order.product_id ?? order.product, 255),
  };
}

async function handleRequest(request: Request, env: RuntimeEnv): Promise<Response> {
  if (request.method === "OPTIONS") return optionsResponse(request, env);

  const url = new URL(request.url);
  const pathname = url.pathname;

  if (request.method === "GET" && (pathname === "/" || pathname === "/health")) {
    return jsonResponse(request, env, 200, {
      ok: true,
      service: "chordvox-license-server",
      provider: normalizeText(env.CREEM_API_KEY, 2048) ? "creem" : "legacy-local",
      creemConfigured: Boolean(normalizeText(env.CREEM_API_KEY, 2048)),
      productId: defaultProductId(env),
      trialDays: defaultTrialDays(env),
      timestamp: nowIso(),
    });
  }

  if (request.method === "POST" && pathname === "/v1/trials/ensure") {
    return jsonResponse(request, env, 200, await ensureTrial(env, await parseJsonBody(request)));
  }

  if (request.method === "POST" && pathname === "/v1/licenses/activate") {
    const body = await parseJsonBody(request);
    await ensureInternalOwnerLicense(env);
    const licenseKey = normalizeLicenseKey(body.licenseKey);
    const machineId = normalizeMachineId(body.machineId);
    const localLicense = await getLocalLicenseDetails(env, licenseKey, body.productId);
    if (localLicense) {
      const result = await activateLocalLicense(env, { ...body, licenseKey, machineId });
      if (result.valid) result.instanceId = buildInternalInstanceId(machineId);
      return jsonResponse(request, env, 200, result as JsonObject);
    }
    if (!normalizeText(env.CREEM_API_KEY, 2048)) {
      return jsonResponse(request, env, 503, {
        valid: false,
        status: "invalid",
        error: "LICENSE_SERVER_NOT_CONFIGURED",
        message: "Creem license relay is not configured yet.",
        offlineGraceHours: defaultOfflineGraceHours(env),
      });
    }
    if (!licenseKey) {
      return jsonResponse(
        request,
        env,
        200,
        buildClientLicenseResponse(env, {}, { valid: false, status: "invalid", error: "LICENSE_KEY_REQUIRED", message: "License key is required." }),
      );
    }
    if (!machineId) {
      return jsonResponse(
        request,
        env,
        200,
        buildClientLicenseResponse(env, {}, { valid: false, status: "invalid", error: "LICENSE_DEVICE_NOT_ACTIVATED", message: "machineId is required." }),
      );
    }
    try {
      const payload = await postCreemJson(env, "/v1/licenses/activate", {
        key: licenseKey,
        instance_name: buildInstanceName({ machineId, platform: body.platform, arch: body.arch }),
      });
      const productMismatch = buildCreemProductMismatchResponse(env, payload);
      if (productMismatch) return jsonResponse(request, env, 200, productMismatch);
      const result = buildClientLicenseResponse(env, payload, {
        valid: true,
        status: "active",
        message: normalizeText(payload.message, 1000) ?? "License activated.",
      });
      if (!normalizeText(result.instanceId, 128)) {
        return jsonResponse(
          request,
          env,
          200,
          buildClientLicenseResponse(env, payload, {
            valid: false,
            status: "invalid",
            error: "LICENSE_DEVICE_NOT_ACTIVATED",
            message: "Creem activation succeeded but instance_id was missing.",
          }),
        );
      }
      return jsonResponse(request, env, 200, result);
    } catch (error) {
      return jsonResponse(request, env, 200, mapCreemActivateFailure(env, error instanceof RelayError ? error : new RelayError("Failed to activate license.", 0, {})));
    }
  }

  if (request.method === "POST" && pathname === "/v1/licenses/validate") {
    const body = await parseJsonBody(request);
    await ensureInternalOwnerLicense(env);
    const licenseKey = normalizeLicenseKey(body.licenseKey);
    const instanceId = normalizeText(body.instanceId, 128);
    const localLicense = await getLocalLicenseDetails(env, licenseKey, body.productId);
    if (localLicense) {
      const result = await validateLocalLicense(env, { ...body, licenseKey });
      if (result.valid) result.instanceId = instanceId ?? buildInternalInstanceId(body.machineId);
      return jsonResponse(request, env, 200, result as JsonObject);
    }
    if (!normalizeText(env.CREEM_API_KEY, 2048)) {
      return jsonResponse(request, env, 503, {
        valid: false,
        status: "invalid",
        error: "LICENSE_SERVER_NOT_CONFIGURED",
        message: "Creem license relay is not configured yet.",
        offlineGraceHours: defaultOfflineGraceHours(env),
      });
    }
    if (!licenseKey) {
      return jsonResponse(
        request,
        env,
        200,
        buildClientLicenseResponse(env, {}, { valid: false, status: "invalid", error: "LICENSE_KEY_REQUIRED", message: "License key is required." }),
      );
    }
    if (!instanceId) {
      return jsonResponse(
        request,
        env,
        200,
        buildClientLicenseResponse(env, {}, { valid: false, status: "invalid", error: "LICENSE_DEVICE_NOT_ACTIVATED", message: "License is not activated on this device." }),
      );
    }
    try {
      const payload = await postCreemJson(env, "/v1/licenses/validate", { key: licenseKey, instance_id: instanceId });
      const creemStatus = getCreemStatus(payload);
      const productMismatch = creemStatus === "active" ? buildCreemProductMismatchResponse(env, payload) : null;
      if (productMismatch) return jsonResponse(request, env, 200, productMismatch);
      return jsonResponse(
        request,
        env,
        200,
        buildClientLicenseResponse(env, payload, {
          valid: creemStatus === "active",
          message: normalizeText(payload.message, 1000) ?? "License validated.",
        }),
      );
    } catch (error) {
      return jsonResponse(request, env, 200, mapCreemValidateFailure(env, error instanceof RelayError ? error : new RelayError("Failed to validate license.", 0, {})));
    }
  }

  if (request.method === "POST" && pathname === "/v1/licenses/deactivate") {
    const body = await parseJsonBody(request);
    await ensureInternalOwnerLicense(env);
    const licenseKey = normalizeLicenseKey(body.licenseKey);
    const instanceId = normalizeText(body.instanceId, 128);
    const localLicense = await getLocalLicenseDetails(env, licenseKey, body.productId);
    if (localLicense) {
      return jsonResponse(request, env, 200, await deactivateLocalLicense(env, { ...body, licenseKey }));
    }
    if (!normalizeText(env.CREEM_API_KEY, 2048)) {
      return jsonResponse(request, env, 503, {
        success: false,
        error: "LICENSE_SERVER_NOT_CONFIGURED",
        message: "Creem license relay is not configured yet.",
      });
    }
    if (!licenseKey || !instanceId) {
      return jsonResponse(request, env, 200, {
        success: false,
        error: "LICENSE_DEVICE_NOT_ACTIVATED",
        message: "licenseKey and instanceId are required.",
      });
    }
    try {
      await postCreemJson(env, "/v1/licenses/deactivate", { key: licenseKey, instance_id: instanceId });
      return jsonResponse(request, env, 200, { success: true, message: "License deactivated." });
    } catch (error) {
      return jsonResponse(request, env, 200, mapCreemDeactivateFailure(error instanceof RelayError ? error : new RelayError("Failed to deactivate license instance.", 0, {})));
    }
  }

  if (pathname.startsWith("/v1/admin/")) {
    const authError = await ensureAdminAuthorized(request, env);
    if (authError) {
      const status = normalizeText(authError.error, 120) === "ADMIN_TOKEN_NOT_CONFIGURED" ? 503 : 401;
      return jsonResponse(request, env, status, authError);
    }
    await ensureInternalOwnerLicense(env);
    if (request.method === "POST" && pathname === "/v1/admin/licenses/issue") {
      const body = await parseJsonBody(request);
      return jsonResponse(request, env, 201, await issueLicense(env, { ...body, expiresAt: body.expiresAt ?? parseDaysToIso(body.days) }));
    }
    if (request.method === "POST" && pathname === "/v1/admin/licenses/revoke") {
      const body = await parseJsonBody(request);
      const details = await getLocalLicenseDetails(env, body.licenseKey, body.productId);
      if (!details) return jsonResponse(request, env, 200, { success: false, updated: false, message: "License not found." });
      const note = normalizeText(body.reason, 1000) ?? details.notes ?? "Revoked by admin";
      await env.DB.prepare("UPDATE licenses SET status = ?, notes = ?, updated_at = ? WHERE id = ?").bind("revoked", note, nowIso(), details.id).run();
      return jsonResponse(request, env, 200, { success: true, updated: true, message: "License revoked.", id: details.id });
    }
    if (request.method === "POST" && pathname === "/v1/admin/licenses/reset-activation") {
      const body = await parseJsonBody(request);
      const result = await resetActivationByKey(env, body.licenseKey, body.productId, body.machineId);
      return jsonResponse(request, env, 200, { success: Boolean(result.updated), ...result });
    }
    if (request.method === "GET" && pathname === "/v1/admin/licenses") {
      return jsonResponse(request, env, 200, { success: true, items: await listLicenses(env, url.searchParams.get("limit")) });
    }
    if (request.method === "GET" && pathname === "/v1/admin/licenses/inspect") {
      const details = await getLocalLicenseDetails(env, url.searchParams.get("licenseKey") ?? "", url.searchParams.get("productId") ?? undefined);
      return jsonResponse(request, env, details ? 200 : 404, {
        success: Boolean(details),
        item: details,
        message: details ? undefined : "License not found.",
      });
    }
  }

  if (request.method === "POST" && pathname === "/v1/webhooks/creem") {
    const result = await handleWebhook(request, env);
    const status = normalizeText(result.error, 120) === "INVALID_SIGNATURE" ? 401 : normalizeText(result.error, 120) ? 503 : 200;
    return jsonResponse(request, env, status, result);
  }

  return jsonResponse(request, env, 404, { error: "NOT_FOUND", message: "Route not found." });
}

export default {
  async fetch(request: Request, env: RuntimeEnv, _ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      return jsonResponse(request, env, 400, {
        error: "REQUEST_FAILED",
        message: error instanceof Error ? error.message : "Request failed.",
      });
    }
  },
};
