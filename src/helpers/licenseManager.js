const { app } = require("electron");
const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { loadSecretSync, saveSecretsSync } = require("./secureSecrets");
const { atomicWriteFile, readJsonWithBackup } = require("./atomicFile");
const { SerialTaskQueue } = require("./serialTaskQueue");

const DEFAULT_STATUS = "unlicensed";
const STATUS_VALUES = new Set(["unlicensed", "active", "expired", "offline_grace", "invalid"]);
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_OFFLINE_GRACE_HOURS = 24 * 7;
const DEFAULT_TRIAL_DAYS = 7;
const DEFAULT_VALIDATE_TTL_HOURS = 12;
const DAY_MS = 24 * 60 * 60 * 1000;
const LICENSE_STATE_VERSION = 2;
const LICENSE_STATE_SIGNATURE_VERSION = "hmac-sha256:v1";
const LICENSE_STATE_HMAC_KEY_NAME = "__CHORDVOX_LICENSE_STATE_HMAC_KEY_V1";
const LEGACY_MACHINE_ID_VERSION = "legacy";
const STRONG_MACHINE_ID_VERSION = "strong";
const TAMPERED_STATE_MESSAGE = "License state was modified. Please activate again.";

function parsePositiveInt(input, fallback) {
  const value = Number(input);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function parseNonNegativeInt(input, fallback) {
  const value = Number(input);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function toIso(dateLike) {
  if (!dateLike) return null;
  if (dateLike instanceof Date) return dateLike.toISOString();
  const parsed = new Date(dateLike);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function normalizeInstanceId(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  return text.slice(0, 128);
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value);
}

function stripStateMetadata(state) {
  const result = {};
  for (const [key, value] of Object.entries(state || {})) {
    if (key === "signature" || key === "__legacyUnsigned" || key === "__tampered") {
      continue;
    }
    result[key] = value;
  }
  return result;
}

function readCommandOutput(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    }).trim();
  } catch {
    return "";
  }
}

class LicenseManager {
  constructor() {
    this.statePath = path.join(app.getPath("userData"), "license-state.json");
    this.legacyMachineId = this._computeLegacyMachineId();
    this.machineId = this._computeStrongMachineId() || this.legacyMachineId;
    this.machineIdVersion =
      this.machineId === this.legacyMachineId
        ? LEGACY_MACHINE_ID_VERSION
        : STRONG_MACHINE_ID_VERSION;
    this.stateOperationQueue = new SerialTaskQueue();
    this._refreshConfig();
  }

  _refreshConfig() {
    const runtimeOverridesAllowed = !app.isPackaged || process.env.NODE_ENV === "development";
    this.apiBaseUrl = runtimeOverridesAllowed
      ? (process.env.LICENSE_API_BASE_URL || "https://api.chordvox.com").trim().replace(/\/+$/, "")
      : "https://api.chordvox.com";
    this.productId = runtimeOverridesAllowed
      ? (process.env.LICENSE_PRODUCT_ID || "chordvox-pro").trim()
      : "chordvox-pro";
    this.apiToken = runtimeOverridesAllowed ? (process.env.LICENSE_API_TOKEN || "").trim() : "";
    this.timeoutMs = runtimeOverridesAllowed
      ? parsePositiveInt(process.env.LICENSE_API_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;
    this.offlineGraceHours = runtimeOverridesAllowed
      ? parsePositiveInt(process.env.LICENSE_OFFLINE_GRACE_HOURS, DEFAULT_OFFLINE_GRACE_HOURS)
      : DEFAULT_OFFLINE_GRACE_HOURS;
    this.trialEnabled = runtimeOverridesAllowed
      ? process.env.LICENSE_TRIAL_ENABLED !== "false"
      : true;
    this.trialDays = runtimeOverridesAllowed
      ? parsePositiveInt(process.env.LICENSE_TRIAL_DAYS, DEFAULT_TRIAL_DAYS)
      : DEFAULT_TRIAL_DAYS;
    this.trialServerEnabled = runtimeOverridesAllowed
      ? process.env.LICENSE_TRIAL_SERVER_ENABLED === "true"
      : true;
    this.validateTtlHours = runtimeOverridesAllowed
      ? parsePositiveInt(process.env.LICENSE_VALIDATE_TTL_HOURS, DEFAULT_VALIDATE_TTL_HOURS)
      : DEFAULT_VALIDATE_TTL_HOURS;
    this.allowDevKeys =
      !app.isPackaged &&
      (process.env.LICENSE_ALLOW_DEV_KEYS === "true" || process.env.NODE_ENV === "development");
  }

  refreshConfig() {
    this._refreshConfig();
    return {
      success: true,
      configured: this._isServerConfigured(),
      apiBaseUrl: this.apiBaseUrl,
      productId: this.productId,
      trialEnabled: this.trialEnabled,
      trialDays: this.trialDays,
      trialServerEnabled: this.trialServerEnabled,
    };
  }

  _isServerConfigured() {
    return Boolean(this.apiBaseUrl);
  }

  _computeLegacyMachineId() {
    const fingerprint = [
      os.hostname() || "unknown-host",
      os.platform(),
      os.arch(),
      app.getPath("home") || "unknown-home",
    ].join("|");

    return crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 32);
  }

  _readPlatformMachineIdentifier() {
    if (process.platform === "darwin") {
      const output = readCommandOutput("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
      const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      return match?.[1] || "";
    }

    if (process.platform === "win32") {
      const output = readCommandOutput("reg", [
        "query",
        "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
        "/v",
        "MachineGuid",
      ]);
      const match = output.match(/MachineGuid\s+REG_\w+\s+([^\r\n]+)/i);
      return match?.[1]?.trim() || "";
    }

    for (const machineIdPath of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try {
        const value = require("fs").readFileSync(machineIdPath, "utf8").trim();
        if (value) return value;
      } catch {}
    }

    return "";
  }

  _computeStrongMachineId() {
    const platformMachineId = this._readPlatformMachineIdentifier();
    if (!platformMachineId) {
      return "";
    }

    const fingerprint = [
      platformMachineId,
      os.hostname() || "unknown-host",
      os.platform(),
      os.arch(),
    ].join("|");

    return crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 32);
  }

  _loadStateHmacKey(options = {}) {
    const existing = loadSecretSync(LICENSE_STATE_HMAC_KEY_NAME, {
      ...options,
      allowKeychain: false,
    });
    if (existing) {
      return existing;
    }

    return "";
  }

  _getStateHmacKey() {
    const existing = this._loadStateHmacKey();
    if (existing) {
      return existing;
    }

    const generated = crypto.randomBytes(32).toString("hex");
    saveSecretsSync(
      { [LICENSE_STATE_HMAC_KEY_NAME]: generated },
      { merge: true, useKeychain: false }
    );
    return generated;
  }

  _signStatePayload(payload) {
    const hmacKey = this._getStateHmacKey();
    return crypto.createHmac("sha256", hmacKey).update(stableStringify(payload)).digest("hex");
  }

  _verifyStateSignature(state, options = {}) {
    const signature = state?.signature;
    if (!signature || typeof signature !== "string") {
      return false;
    }

    const hmacKey = this._loadStateHmacKey(options);
    if (!hmacKey) {
      return false;
    }

    const payload = stripStateMetadata(state);
    const expected = crypto
      .createHmac("sha256", hmacKey)
      .update(stableStringify(payload))
      .digest("hex");
    const expectedBuffer = Buffer.from(expected, "hex");
    const actualBuffer = Buffer.from(signature, "hex");

    return (
      expectedBuffer.length === actualBuffer.length &&
      crypto.timingSafeEqual(expectedBuffer, actualBuffer)
    );
  }

  _getMachineIdForState(state, purpose = "validate") {
    if (purpose === "activate") {
      return { machineId: this.machineId, machineIdVersion: this.machineIdVersion };
    }

    if (state?.__legacyUnsigned && state?.licenseKey && normalizeInstanceId(state.instanceId)) {
      return { machineId: this.legacyMachineId, machineIdVersion: LEGACY_MACHINE_ID_VERSION };
    }

    if (state?.machineIdVersion === LEGACY_MACHINE_ID_VERSION) {
      return { machineId: this.legacyMachineId, machineIdVersion: LEGACY_MACHINE_ID_VERSION };
    }

    return { machineId: this.machineId, machineIdVersion: this.machineIdVersion };
  }

  _enqueueStateOperation(operation) {
    return this.stateOperationQueue.run(operation);
  }

  async _readState(options = {}) {
    const allowKeychain = options.allowKeychain !== false;
    try {
      const { value: parsed, source } = await readJsonWithBackup(this.statePath, {
        recoverCorrupt: true,
      });
      if (!parsed || typeof parsed !== "object") {
        return {};
      }

      if (!parsed.signature) {
        return { ...parsed, __legacyUnsigned: true };
      }

      if (!allowKeychain) {
        return { ...stripStateMetadata(parsed), __signatureDeferred: true };
      }

      if (!this._loadStateHmacKey({ allowKeychain: true })) {
        return { ...stripStateMetadata(parsed), __legacyUnsigned: true };
      }

      if (!this._verifyStateSignature(parsed, { allowKeychain: true })) {
        return {
          status: "invalid",
          lastMessage: TAMPERED_STATE_MESSAGE,
          __tampered: true,
        };
      }

      const verifiedState = stripStateMetadata(parsed);
      if (allowKeychain && source === `${this.statePath}.bak`) {
        try {
          await this._writeState(verifiedState);
          await fs.rm(`${this.statePath}.bak`, { force: true });
        } catch {
          // Keep serving the verified backup state; repair can be retried later.
        }
      }
      return verifiedState;
    } catch {
      return {};
    }
  }

  async _writeState(nextState, options = {}) {
    const stateMetadata = {
      stateVersion: LICENSE_STATE_VERSION,
      signatureVersion: LICENSE_STATE_SIGNATURE_VERSION,
      machineIdVersion:
        options.machineIdVersion ||
        nextState.machineIdVersion ||
        (nextState.__legacyUnsigned ? LEGACY_MACHINE_ID_VERSION : this.machineIdVersion),
      signedAt: new Date().toISOString(),
    };
    const payload = {
      ...stripStateMetadata(nextState),
      ...stateMetadata,
    };
    const signedState = {
      ...payload,
      signature: this._signStatePayload(payload),
    };

    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    await atomicWriteFile(this.statePath, JSON.stringify(signedState, null, 2), {
      mode: 0o600,
      backup: true,
    });
  }

  _normalizeStatus(input, expiresAt) {
    const now = Date.now();
    const normalized = STATUS_VALUES.has(input) ? input : DEFAULT_STATUS;
    const expiresMs = expiresAt ? Date.parse(expiresAt) : NaN;

    if (normalized === "active" && Number.isFinite(expiresMs) && expiresMs <= now) {
      return "expired";
    }

    return normalized;
  }

  _serialize(state, extra = {}) {
    const status = this._normalizeStatus(state.status, state.expiresAt);
    const now = Date.now();
    const offlineGraceMs = state.offlineGraceUntil ? Date.parse(state.offlineGraceUntil) : NaN;
    const offlineGraceValid = Number.isFinite(offlineGraceMs) && offlineGraceMs > now;
    const trialExpiresMs = state.trialExpiresAt ? Date.parse(state.trialExpiresAt) : NaN;
    const trialActive =
      !state.licenseKey &&
      this.trialEnabled &&
      Number.isFinite(trialExpiresMs) &&
      trialExpiresMs > now;
    const trialDaysLeft = trialActive ? Math.max(1, Math.ceil((trialExpiresMs - now) / DAY_MS)) : 0;
    const isActive = status === "active" || (status === "offline_grace" && offlineGraceValid);

    return {
      success: extra.success ?? true,
      configured: this._isServerConfigured(),
      requiresServerValidation: this._isServerConfigured(),
      status,
      isActive,
      keyPresent: Boolean(state.licenseKey),
      plan: state.plan || null,
      expiresAt: toIso(state.expiresAt),
      trialEnabled: this.trialEnabled,
      trialDays: this.trialDays,
      trialServerEnabled: this.trialServerEnabled,
      trialRequiresServerValidation: this._shouldUseServerTrial(),
      trialStartedAt: toIso(state.trialStartedAt),
      trialExpiresAt: toIso(state.trialExpiresAt),
      trialDaysLeft,
      trialActive,
      lastValidatedAt: toIso(state.lastValidatedAt),
      offlineGraceUntil: toIso(state.offlineGraceUntil),
      message: extra.message || state.lastMessage || null,
      error: extra.error || null,
    };
  }

  _computeTrialDates(state) {
    const now = Date.now();
    const trialStartedAt = toIso(state.trialStartedAt) || new Date(now).toISOString();
    const trialExpiresAt =
      toIso(state.trialExpiresAt) ||
      new Date(Date.parse(trialStartedAt) + this.trialDays * DAY_MS).toISOString();
    const trialExpiresMs = Date.parse(trialExpiresAt);
    const trialActive = Number.isFinite(trialExpiresMs) && trialExpiresMs > now;
    const trialDaysLeft = trialActive ? Math.max(1, Math.ceil((trialExpiresMs - now) / DAY_MS)) : 0;

    return {
      trialStartedAt,
      trialExpiresAt,
      trialActive,
      trialDaysLeft,
    };
  }

  _resolveTrialState(state, options = {}) {
    if (state.licenseKey) {
      return { state, changed: false, justStarted: false };
    }

    const startIfNeeded = options.startIfNeeded === true;
    const existingTrialStartedAt = toIso(state.trialStartedAt);
    const existingTrialExpiresAt = toIso(state.trialExpiresAt);
    const hasStartedTrial = Boolean(existingTrialStartedAt || existingTrialExpiresAt);

    if (!hasStartedTrial && !startIfNeeded) {
      const message = this.trialEnabled
        ? `Free local transcription is available. Your ${this.trialDays}-day Pro trial starts the first time you use a Pro feature.`
        : "Free local transcription is available. Enter a Pro license key to unlock paid features.";
      const nextState = {
        ...state,
        status: "unlicensed",
        plan: null,
        expiresAt: null,
        lastMessage: message,
      };

      const changed =
        state.status !== nextState.status ||
        state.plan !== nextState.plan ||
        state.expiresAt !== nextState.expiresAt ||
        state.lastMessage !== nextState.lastMessage;

      return { state: nextState, changed, justStarted: false };
    }

    const justStarted = !hasStartedTrial && startIfNeeded;
    const normalizedState = {
      ...state,
      trialStartedAt:
        existingTrialStartedAt ||
        (existingTrialExpiresAt
          ? new Date(Date.parse(existingTrialExpiresAt) - this.trialDays * DAY_MS).toISOString()
          : new Date().toISOString()),
      trialExpiresAt: existingTrialExpiresAt || null,
    };
    const trialMeta = this._computeTrialDates(normalizedState);
    const nextState = {
      ...state,
      trialStartedAt: trialMeta.trialStartedAt,
      trialExpiresAt: trialMeta.trialExpiresAt,
      plan: "trial",
      expiresAt: trialMeta.trialExpiresAt,
      status: this.trialEnabled && trialMeta.trialActive ? "active" : "expired",
      lastMessage:
        this.trialEnabled && trialMeta.trialActive
          ? `Pro trial active. ${trialMeta.trialDaysLeft} day(s) remaining.`
          : "Free local transcription remains available. Enter a Pro license key to unlock paid features again.",
    };

    const changed =
      state.trialStartedAt !== nextState.trialStartedAt ||
      state.trialExpiresAt !== nextState.trialExpiresAt ||
      state.status !== nextState.status ||
      state.expiresAt !== nextState.expiresAt ||
      state.plan !== nextState.plan ||
      state.lastMessage !== nextState.lastMessage;

    return { state: nextState, changed, justStarted };
  }

  _shouldUseServerTrial() {
    return this.trialEnabled && this.trialServerEnabled && this._isServerConfigured();
  }

  _parseTrialResponse(payload = {}) {
    const rawStatus = typeof payload.status === "string" ? payload.status.toLowerCase() : "";
    const status = STATUS_VALUES.has(rawStatus)
      ? rawStatus
      : payload.trialActive || payload.valid || payload.active
        ? "active"
        : "expired";
    const trialStartedAt = toIso(payload.trialStartedAt || payload.trial_started_at);
    const trialExpiresAt = toIso(
      payload.trialExpiresAt || payload.trial_expires_at || payload.expiresAt || payload.expires_at
    );
    const trialExpiresMs = trialExpiresAt ? Date.parse(trialExpiresAt) : NaN;
    const computedDaysLeft =
      Number.isFinite(trialExpiresMs) && trialExpiresMs > Date.now()
        ? Math.max(1, Math.ceil((trialExpiresMs - Date.now()) / DAY_MS))
        : 0;
    const trialActive =
      status === "active" && Number.isFinite(trialExpiresMs) && trialExpiresMs > Date.now();

    return {
      success: payload.success !== false,
      isValid: trialActive,
      status,
      error: typeof payload.error === "string" ? payload.error : null,
      plan: status === "unlicensed" ? null : payload.plan || "trial",
      expiresAt: trialExpiresAt,
      trialStartedAt,
      trialExpiresAt,
      trialDays: parsePositiveInt(payload.trialDays || payload.trial_days, this.trialDays),
      trialDaysLeft: parseNonNegativeInt(
        payload.trialDaysLeft || payload.trial_days_left,
        computedDaysLeft
      ),
      trialActive,
      message: typeof payload.message === "string" ? payload.message : "",
    };
  }

  async _resolveServerTrialState(state, options = {}) {
    const startIfNeeded = options.startIfNeeded === true;
    try {
      const payload = await this._postJson("/v1/trials/ensure", {
        productId: this.productId,
        machineId: this.machineId,
        startIfNeeded,
        trialStartedAt: toIso(state.trialStartedAt),
        trialExpiresAt: toIso(state.trialExpiresAt),
        appVersion: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
      });
      const parsed = this._parseTrialResponse(payload);
      const nextState = {
        ...stripStateMetadata(state),
        licenseKey: null,
        instanceId: null,
        status: parsed.status,
        plan: parsed.plan,
        expiresAt: parsed.expiresAt,
        trialStartedAt: parsed.trialStartedAt,
        trialExpiresAt: parsed.trialExpiresAt,
        lastValidatedAt: null,
        offlineGraceUntil: null,
        lastMessage:
          parsed.message ||
          (parsed.status === "active"
            ? `Pro trial active. ${parsed.trialDaysLeft} day(s) remaining.`
            : parsed.status === "expired"
              ? "Free local transcription remains available. Enter a Pro license key to unlock paid features again."
              : `Free local transcription is available. Your ${parsed.trialDays}-day Pro trial starts the first time you use a Pro feature.`),
      };

      const changed = stableStringify(stripStateMetadata(state)) !== stableStringify(nextState);
      return {
        state: nextState,
        changed,
        justStarted: startIfNeeded && Boolean(parsed.trialStartedAt) && parsed.status === "active",
        error: parsed.trialActive ? null : parsed.error || "LICENSE_TRIAL_SERVER_UNAVAILABLE",
      };
    } catch (error) {
      const hasCachedTrial = Boolean(state.trialStartedAt || state.trialExpiresAt);
      if (hasCachedTrial) {
        const localTrialState = this._resolveTrialState(state, { startIfNeeded: false });
        return {
          ...localTrialState,
          error:
            localTrialState.state.status === "active" ? null : "LICENSE_TRIAL_SERVER_UNAVAILABLE",
        };
      }

      const nextState = {
        ...stripStateMetadata(state),
        status: "unlicensed",
        plan: null,
        expiresAt: null,
        trialStartedAt: null,
        trialExpiresAt: null,
        lastMessage: startIfNeeded
          ? "Starting a Pro trial requires an online license check. Please try again when the license service is reachable."
          : `Free local transcription is available. Your ${this.trialDays}-day Pro trial starts the first time you use a Pro feature.`,
      };

      const changed = stableStringify(stripStateMetadata(state)) !== stableStringify(nextState);
      return {
        state: nextState,
        changed,
        justStarted: false,
        error: "LICENSE_TRIAL_SERVER_UNAVAILABLE",
      };
    }
  }

  async _resolveTrialAccessState(state, options = {}) {
    if (!this._shouldUseServerTrial()) {
      return this._resolveTrialState(state, options);
    }

    return this._resolveServerTrialState(state, options);
  }

  _parseResponse(payload = {}) {
    const rawStatus = typeof payload.status === "string" ? payload.status.toLowerCase() : "";
    const status = STATUS_VALUES.has(rawStatus)
      ? rawStatus
      : payload.valid || payload.success || payload.active
        ? "active"
        : "invalid";

    const isValid = status === "active" || status === "offline_grace";

    return {
      isValid,
      status,
      error: typeof payload.error === "string" ? payload.error : null,
      plan: payload.plan || payload.tier || null,
      expiresAt: toIso(payload.expiresAt || payload.expires_at),
      instanceId: normalizeInstanceId(
        payload.instanceId ||
          payload.instance_id ||
          payload.instance?.id ||
          payload.instance?.instance_id
      ),
      graceHours: parsePositiveInt(
        payload.offlineGraceHours || payload.offline_grace_hours,
        this.offlineGraceHours
      ),
      message: typeof payload.message === "string" ? payload.message : "",
    };
  }

  async _postJson(endpoint, body) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers = {
        "Content-Type": "application/json",
      };
      if (this.apiToken) {
        headers.Authorization = `Bearer ${this.apiToken}`;
      }

      const response = await fetch(`${this.apiBaseUrl}${endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      let payload = {};
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { message: text };
        }
      }

      if (!response.ok) {
        const error = new Error(
          payload.message || `License server returned ${response.status} ${response.statusText}`
        );
        error.code = `HTTP_${response.status}`;
        error.payload = payload;
        throw error;
      }

      return payload;
    } catch (error) {
      if (error.name === "AbortError") {
        const timeoutError = new Error("License server request timed out.");
        timeoutError.code = "TIMEOUT";
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  _computeOfflineGraceUntil(hours) {
    return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  }

  _validationSessionKey(state) {
    if (!state?.licenseKey) return "";
    return [
      state.licenseKey,
      state.instanceId || "",
      state.status || "",
      state.machineIdVersion || "",
    ].join("|");
  }

  _isTamperedState(state) {
    return Boolean(state?.__tampered);
  }

  _serializeLegacyUnsignedState(state, extra = {}) {
    return this._serialize(
      {
        ...state,
        status: "invalid",
        offlineGraceUntil: null,
        lastMessage:
          extra.message ||
          "Please validate your existing license once to finish the license state security upgrade.",
      },
      {
        success: false,
        error: "LICENSE_REVALIDATION_REQUIRED",
        ...extra,
      }
    );
  }

  _shouldRevalidate(state) {
    if (!state?.licenseKey || !this._isServerConfigured()) {
      return false;
    }

    if (!normalizeInstanceId(state.instanceId)) {
      return true;
    }

    if (state.status !== "active" && state.status !== "offline_grace") {
      return false;
    }

    const sessionKey = this._validationSessionKey(state);
    if (!this.lastValidatedSessionKey || this.lastValidatedSessionKey !== sessionKey) {
      return true;
    }

    const lastValidatedMs = state.lastValidatedAt ? Date.parse(state.lastValidatedAt) : NaN;
    if (!Number.isFinite(lastValidatedMs)) {
      return true;
    }

    const validateTtlMs = this.validateTtlHours * 60 * 60 * 1000;
    return Date.now() - lastValidatedMs >= validateTtlMs;
  }

  getStatus(options = {}) {
    return this._enqueueStateOperation(() => this._getStatus(options));
  }

  async _getStatus(options = {}) {
    this._refreshConfig();
    const passive = options.passive === true || options.allowKeychain === false;
    const allowKeychain = !passive;
    let current = await this._readState({ allowKeychain });
    let trialError = null;
    if (this._isTamperedState(current)) {
      this.lastValidatedSessionKey = null;
      return this._serialize(current, {
        success: false,
        error: "LICENSE_STATE_TAMPERED",
        message: TAMPERED_STATE_MESSAGE,
      });
    }

    if (!current.licenseKey) {
      const trialState = passive
        ? this._resolveTrialState(current, { startIfNeeded: false })
        : await this._resolveTrialAccessState(current, { startIfNeeded: false });
      current = trialState.state;
      trialError = trialState.error || null;
      if (!passive && trialState.changed) {
        await this._writeState(current);
      }
    }

    if (
      !passive &&
      current.__legacyUnsigned &&
      current.licenseKey &&
      normalizeInstanceId(current.instanceId) &&
      this._isServerConfigured()
    ) {
      return this._validateLicense();
    }

    if (current.__legacyUnsigned) {
      return this._serializeLegacyUnsignedState(current);
    }

    return this._serialize(current, {
      success: !trialError,
      error: trialError,
      message: current.lastMessage,
    });
  }

  ensureProAccess() {
    return this._enqueueStateOperation(() => this._ensureProAccess());
  }

  async _ensureProAccess() {
    this._refreshConfig();
    let current = await this._readState();
    let trialError = null;
    if (this._isTamperedState(current)) {
      this.lastValidatedSessionKey = null;
      return this._serialize(current, {
        success: false,
        error: "LICENSE_STATE_TAMPERED",
        message: TAMPERED_STATE_MESSAGE,
      });
    }

    if (!current.licenseKey) {
      const trialState = await this._resolveTrialAccessState(current, { startIfNeeded: true });
      current = trialState.state;
      trialError = trialState.error || null;
      if (trialState.changed) {
        await this._writeState(current);
      }
    }

    if (current.licenseKey && this._shouldRevalidate(current)) {
      const validated = await this._validateLicense();
      return validated;
    }

    if (current.status === "active" || current.status === "offline_grace") {
      this.lastValidatedSessionKey = this._validationSessionKey(current);
      return this._serialize(current, {
        success: true,
        message: current.lastMessage,
      });
    }

    return this._serialize(current, {
      success: false,
      error: trialError || "LICENSE_REQUIRED",
      message: current.lastMessage,
    });
  }

  activateLicense(rawLicenseKey) {
    return this._enqueueStateOperation(() => this._activateLicense(rawLicenseKey));
  }

  async _activateLicense(rawLicenseKey) {
    this._refreshConfig();
    const licenseKey = String(rawLicenseKey || "").trim();
    if (!licenseKey) {
      return {
        success: false,
        configured: this._isServerConfigured(),
        status: "unlicensed",
        isActive: false,
        keyPresent: false,
        error: "LICENSE_KEY_REQUIRED",
        message: "License key is required.",
      };
    }

    if (!this._isServerConfigured()) {
      if (!this.allowDevKeys || !licenseKey.startsWith("DEV-")) {
        return {
          success: false,
          configured: false,
          status: "invalid",
          isActive: false,
          keyPresent: true,
          error: "LICENSE_SERVER_NOT_CONFIGURED",
          message:
            "Set LICENSE_API_BASE_URL before activation. DEV- keys are only accepted when LICENSE_ALLOW_DEV_KEYS=true.",
        };
      }

      const localState = {
        licenseKey,
        status: "active",
        plan: "dev",
        expiresAt: null,
        machineIdVersion: this.machineIdVersion,
        lastValidatedAt: new Date().toISOString(),
        offlineGraceUntil: this._computeOfflineGraceUntil(this.offlineGraceHours),
        lastMessage: "Activated in local development mode.",
      };
      await this._writeState(localState);
      this.lastValidatedSessionKey = this._validationSessionKey(localState);
      return this._serialize(localState, { success: true });
    }

    try {
      const activationMachine = this._getMachineIdForState(null, "activate");
      const payload = await this._postJson("/v1/licenses/activate", {
        licenseKey,
        productId: this.productId,
        machineId: activationMachine.machineId,
        appVersion: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
      });

      const parsed = this._parseResponse(payload);
      const nextState = {
        licenseKey,
        status: parsed.status,
        plan: parsed.plan,
        expiresAt: parsed.expiresAt,
        instanceId: parsed.instanceId,
        machineIdVersion: activationMachine.machineIdVersion,
        lastValidatedAt: new Date().toISOString(),
        offlineGraceUntil: this._computeOfflineGraceUntil(parsed.graceHours),
        lastMessage: parsed.message || null,
      };

      if (parsed.isValid && !parsed.instanceId) {
        return {
          success: false,
          configured: true,
          status: "invalid",
          isActive: false,
          keyPresent: true,
          error: "LICENSE_DEVICE_NOT_ACTIVATED",
          message: "License activated but the activation instance was missing. Please try again.",
        };
      }

      await this._writeState(nextState, {
        machineIdVersion: activationMachine.machineIdVersion,
      });

      if (!parsed.isValid) {
        this.lastValidatedSessionKey = null;
        return this._serialize(nextState, {
          success: false,
          error: parsed.error || "LICENSE_INVALID",
          message: parsed.message || "License key is invalid.",
        });
      }

      this.lastValidatedSessionKey = this._validationSessionKey(nextState);
      return this._serialize(nextState, {
        success: true,
        message: parsed.message || "License activated.",
      });
    } catch (error) {
      return {
        success: false,
        configured: true,
        status: "invalid",
        isActive: false,
        keyPresent: true,
        error: error.code || "LICENSE_ACTIVATION_FAILED",
        message: error.message || "Failed to activate license.",
      };
    }
  }

  validateLicense() {
    return this._enqueueStateOperation(() => this._validateLicense());
  }

  async _validateLicense() {
    this._refreshConfig();
    const state = await this._readState();
    if (this._isTamperedState(state)) {
      this.lastValidatedSessionKey = null;
      return this._serialize(state, {
        success: false,
        error: "LICENSE_STATE_TAMPERED",
        message: TAMPERED_STATE_MESSAGE,
      });
    }

    if (!state.licenseKey) {
      const trialState = await this._resolveTrialAccessState(state, { startIfNeeded: false });
      if (trialState.changed) {
        await this._writeState(trialState.state);
      }
      if (trialState.state.status === "active") {
        return this._serialize(trialState.state, {
          success: true,
          message: trialState.state.lastMessage,
        });
      }
      return this._serialize(trialState.state, {
        success: false,
        error: trialState.error || "LICENSE_REQUIRED",
        message: trialState.state.lastMessage,
      });
    }

    if (!this._isServerConfigured()) {
      return this._serialize(state, {
        success: state.status === "active" || state.status === "offline_grace",
        message: "License server is not configured. Running in cached/offline mode.",
      });
    }

    if (!normalizeInstanceId(state.instanceId)) {
      return this._serialize(state, {
        success: false,
        error: "LICENSE_DEVICE_NOT_ACTIVATED",
        message: "This license is not activated on this device. Please activate it again.",
      });
    }

    try {
      const validationMachine = this._getMachineIdForState(state, "validate");
      const payload = await this._postJson("/v1/licenses/validate", {
        licenseKey: state.licenseKey,
        productId: this.productId,
        instanceId: state.instanceId,
        machineId: validationMachine.machineId,
        appVersion: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
      });

      const parsed = this._parseResponse(payload);
      const nextState = {
        ...state,
        status: parsed.status,
        plan: parsed.plan || state.plan || null,
        expiresAt: parsed.expiresAt || state.expiresAt || null,
        instanceId: parsed.instanceId || state.instanceId || null,
        machineIdVersion: validationMachine.machineIdVersion,
        lastValidatedAt: new Date().toISOString(),
        offlineGraceUntil: this._computeOfflineGraceUntil(parsed.graceHours),
        lastMessage: parsed.message || null,
      };
      await this._writeState(nextState, {
        machineIdVersion: validationMachine.machineIdVersion,
      });

      if (!parsed.isValid) {
        this.lastValidatedSessionKey = null;
        return this._serialize(nextState, {
          success: false,
          error: parsed.error || "LICENSE_INVALID",
          message: parsed.message || "License is not valid.",
        });
      }

      this.lastValidatedSessionKey = this._validationSessionKey(nextState);
      return this._serialize(nextState, {
        success: true,
        message: parsed.message || "License validated.",
      });
    } catch (error) {
      const graceMs = state.offlineGraceUntil ? Date.parse(state.offlineGraceUntil) : NaN;
      const graceStillValid = Number.isFinite(graceMs) && graceMs > Date.now();
      const stateCanUseOfflineGrace = !state.__legacyUnsigned;

      if (
        stateCanUseOfflineGrace &&
        graceStillValid &&
        (state.status === "active" || state.status === "offline_grace")
      ) {
        const nextState = {
          ...state,
          status: "offline_grace",
          machineIdVersion: state.machineIdVersion || this.machineIdVersion,
          lastValidatedAt: new Date().toISOString(),
          lastMessage: "License server unavailable. Using offline grace period.",
        };
        await this._writeState(nextState, {
          machineIdVersion: nextState.machineIdVersion,
        });
        this.lastValidatedSessionKey = this._validationSessionKey(nextState);
        return this._serialize(nextState, {
          success: true,
          message: nextState.lastMessage,
        });
      }

      this.lastValidatedSessionKey = null;
      return this._serialize(state, {
        success: false,
        error: error.code || "LICENSE_VALIDATION_FAILED",
        message: error.message || "Failed to validate license.",
      });
    }
  }

  clearLicense() {
    return this._enqueueStateOperation(() => this._clearLicense());
  }

  async _clearLicense() {
    this._refreshConfig();
    const current = await this._readState();
    if (this._isTamperedState(current)) {
      try {
        await this._writeState({ status: "unlicensed", lastMessage: "License removed." });
        await fs.rm(`${this.statePath}.bak`, { force: true });
      } catch (error) {
        return this._serialize(current, {
          success: false,
          error: error?.code || "LICENSE_CLEAR_FAILED",
          message: "Failed to replace the local license state.",
        });
      }
      this.lastValidatedSessionKey = null;
      return this._serialize(
        { status: "unlicensed", lastMessage: "License removed." },
        {
          success: true,
          message: "License removed.",
        }
      );
    }

    if (
      this._isServerConfigured() &&
      current.licenseKey &&
      normalizeInstanceId(current.instanceId)
    ) {
      try {
        const clearMachine = this._getMachineIdForState(current, "deactivate");
        await this._postJson("/v1/licenses/deactivate", {
          licenseKey: current.licenseKey,
          productId: this.productId,
          instanceId: current.instanceId,
          machineId: clearMachine.machineId,
        });
      } catch {
        // Best effort only. Local clear should still proceed.
      }
    }

    const preservedState = {};
    if (current.trialStartedAt) preservedState.trialStartedAt = current.trialStartedAt;
    if (current.trialExpiresAt) preservedState.trialExpiresAt = current.trialExpiresAt;

    const trialState = await this._resolveTrialAccessState(preservedState, {
      startIfNeeded: false,
    });
    try {
      await this._writeState(trialState.state);
      await fs.rm(`${this.statePath}.bak`, { force: true });
    } catch (error) {
      return this._serialize(current, {
        success: false,
        error: error?.code || "LICENSE_CLEAR_FAILED",
        message: "Failed to replace the local license state.",
      });
    }
    this.lastValidatedSessionKey = null;
    return this._serialize(trialState.state, {
      success: true,
      message: "License removed.",
    });
  }
}

module.exports = LicenseManager;
