const { app } = require("electron");
const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const DEFAULT_STATUS = "unlicensed";
const STATUS_VALUES = new Set(["unlicensed", "active", "expired", "offline_grace", "invalid"]);
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_OFFLINE_GRACE_HOURS = 24 * 7;
const DEFAULT_TRIAL_DAYS = 7;
const DEFAULT_VALIDATE_TTL_HOURS = 12;
const DAY_MS = 24 * 60 * 60 * 1000;

function parsePositiveInt(input, fallback) {
  const value = Number(input);
  if (!Number.isFinite(value) || value <= 0) return fallback;
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

class LicenseManager {
  constructor() {
    this.statePath = path.join(app.getPath("userData"), "license-state.json");
    this.machineId = this._computeMachineId();
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
    };
  }

  _isServerConfigured() {
    return Boolean(this.apiBaseUrl);
  }

  _computeMachineId() {
    const fingerprint = [
      os.hostname() || "unknown-host",
      os.platform(),
      os.arch(),
      app.getPath("home") || "unknown-home",
    ].join("|");

    return crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 32);
  }

  async _readState() {
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw);
      return typeof parsed === "object" && parsed ? parsed : {};
    } catch {
      return {};
    }
  }

  async _writeState(nextState) {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.writeFile(this.statePath, JSON.stringify(nextState, null, 2), "utf8");
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
      status:
        this.trialEnabled && trialMeta.trialActive
          ? "active"
          : "expired",
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
    return [state.licenseKey, state.instanceId || "", state.status || ""].join("|");
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

  async getStatus() {
    this._refreshConfig();
    let current = await this._readState();
    if (!current.licenseKey) {
      const trialState = this._resolveTrialState(current, { startIfNeeded: false });
      current = trialState.state;
      if (trialState.changed) {
        await this._writeState(current);
      }
    }
    return this._serialize(current);
  }

  async ensureProAccess() {
    this._refreshConfig();
    let current = await this._readState();
    if (!current.licenseKey) {
      const trialState = this._resolveTrialState(current, { startIfNeeded: true });
      current = trialState.state;
      if (trialState.changed) {
        await this._writeState(current);
      }
    }

    if (current.licenseKey && this._shouldRevalidate(current)) {
      const validated = await this.validateLicense();
      if (validated?.isActive) {
        this.lastValidatedSessionKey = this._validationSessionKey({
          licenseKey: current.licenseKey,
          instanceId: current.instanceId,
          status: validated.status,
        });
      }
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
      error: "LICENSE_REQUIRED",
      message: current.lastMessage,
    });
  }

  async activateLicense(rawLicenseKey) {
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
        lastValidatedAt: new Date().toISOString(),
        offlineGraceUntil: this._computeOfflineGraceUntil(this.offlineGraceHours),
        lastMessage: "Activated in local development mode.",
      };
      await this._writeState(localState);
      this.lastValidatedSessionKey = this._validationSessionKey(localState);
      return this._serialize(localState, { success: true });
    }

    try {
      const payload = await this._postJson("/v1/licenses/activate", {
        licenseKey,
        productId: this.productId,
        machineId: this.machineId,
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

      await this._writeState(nextState);

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

  async validateLicense() {
    this._refreshConfig();
    const state = await this._readState();
    if (!state.licenseKey) {
      const trialState = this._resolveTrialState(state, { startIfNeeded: false });
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
        error: "LICENSE_REQUIRED",
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
      const payload = await this._postJson("/v1/licenses/validate", {
        licenseKey: state.licenseKey,
        productId: this.productId,
        instanceId: state.instanceId,
        machineId: this.machineId,
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
        lastValidatedAt: new Date().toISOString(),
        offlineGraceUntil: this._computeOfflineGraceUntil(parsed.graceHours),
        lastMessage: parsed.message || null,
      };
      await this._writeState(nextState);

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

      if (graceStillValid && (state.status === "active" || state.status === "offline_grace")) {
        const nextState = {
          ...state,
          status: "offline_grace",
          lastValidatedAt: new Date().toISOString(),
          lastMessage: "License server unavailable. Using offline grace period.",
        };
        await this._writeState(nextState);
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

  async clearLicense() {
    this._refreshConfig();
    const current = await this._readState();

    if (this._isServerConfigured() && current.licenseKey && normalizeInstanceId(current.instanceId)) {
      try {
        await this._postJson("/v1/licenses/deactivate", {
          licenseKey: current.licenseKey,
          productId: this.productId,
          instanceId: current.instanceId,
          machineId: this.machineId,
        });
      } catch {
        // Best effort only. Local clear should still proceed.
      }
    }

    const preservedState = {};
    if (current.trialStartedAt) preservedState.trialStartedAt = current.trialStartedAt;
    if (current.trialExpiresAt) preservedState.trialExpiresAt = current.trialExpiresAt;

    if (Object.keys(preservedState).length > 0) {
      await this._writeState(preservedState);
    } else {
      try {
        await fs.rm(this.statePath, { force: true });
      } catch { }
    }

    const trialState = this._resolveTrialState(preservedState, { startIfNeeded: false });
    if (trialState.changed) {
      await this._writeState(trialState.state);
    }
    this.lastValidatedSessionKey = null;
    return this._serialize(trialState.state, {
      success: true,
      message: "License removed.",
    });
  }
}

module.exports = LicenseManager;
