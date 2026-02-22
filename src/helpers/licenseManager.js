const { app } = require("electron");
const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const DEFAULT_STATUS = "unlicensed";
const STATUS_VALUES = new Set(["unlicensed", "active", "expired", "offline_grace", "invalid"]);
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_OFFLINE_GRACE_HOURS = 24 * 7;

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

class LicenseManager {
  constructor() {
    this.statePath = path.join(app.getPath("userData"), "license-state.json");
    this.machineId = this._computeMachineId();
    this._refreshConfig();
  }

  _refreshConfig() {
    this.apiBaseUrl = (process.env.LICENSE_API_BASE_URL || "").trim().replace(/\/+$/, "");
    this.productId = (process.env.LICENSE_PRODUCT_ID || "chordvox-pro").trim();
    this.apiToken = (process.env.LICENSE_API_TOKEN || "").trim();
    this.timeoutMs = parsePositiveInt(process.env.LICENSE_API_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    this.offlineGraceHours = parsePositiveInt(
      process.env.LICENSE_OFFLINE_GRACE_HOURS,
      DEFAULT_OFFLINE_GRACE_HOURS
    );
    this.allowDevKeys =
      process.env.LICENSE_ALLOW_DEV_KEYS === "true" || process.env.NODE_ENV === "development";
  }

  refreshConfig() {
    this._refreshConfig();
    return {
      success: true,
      configured: this._isServerConfigured(),
      apiBaseUrl: this.apiBaseUrl,
      productId: this.productId,
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
      lastValidatedAt: toIso(state.lastValidatedAt),
      offlineGraceUntil: toIso(state.offlineGraceUntil),
      message: extra.message || state.lastMessage || null,
      error: extra.error || null,
    };
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
      plan: payload.plan || payload.tier || null,
      expiresAt: toIso(payload.expiresAt || payload.expires_at),
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

  async getStatus() {
    this._refreshConfig();
    const current = await this._readState();
    return this._serialize(current);
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
        lastValidatedAt: new Date().toISOString(),
        offlineGraceUntil: this._computeOfflineGraceUntil(parsed.graceHours),
        lastMessage: parsed.message || null,
      };

      await this._writeState(nextState);

      if (!parsed.isValid) {
        return this._serialize(nextState, {
          success: false,
          error: "LICENSE_INVALID",
          message: parsed.message || "License key is invalid.",
        });
      }

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
      return {
        success: false,
        configured: this._isServerConfigured(),
        status: "unlicensed",
        isActive: false,
        keyPresent: false,
        error: "LICENSE_KEY_MISSING",
        message: "No license key is currently stored.",
      };
    }

    if (!this._isServerConfigured()) {
      return this._serialize(state, {
        success: state.status === "active" || state.status === "offline_grace",
        message: "License server is not configured. Running in cached/offline mode.",
      });
    }

    try {
      const payload = await this._postJson("/v1/licenses/validate", {
        licenseKey: state.licenseKey,
        productId: this.productId,
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
        lastValidatedAt: new Date().toISOString(),
        offlineGraceUntil: this._computeOfflineGraceUntil(parsed.graceHours),
        lastMessage: parsed.message || null,
      };
      await this._writeState(nextState);

      if (!parsed.isValid) {
        return this._serialize(nextState, {
          success: false,
          error: "LICENSE_INVALID",
          message: parsed.message || "License is not valid.",
        });
      }

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
          lastMessage: "License server unavailable. Using offline grace period.",
        };
        await this._writeState(nextState);
        return this._serialize(nextState, {
          success: true,
          message: nextState.lastMessage,
        });
      }

      return this._serialize(state, {
        success: false,
        error: error.code || "LICENSE_VALIDATION_FAILED",
        message: error.message || "Failed to validate license.",
      });
    }
  }

  async clearLicense() {
    this._refreshConfig();
    try {
      await fs.rm(this.statePath, { force: true });
    } catch {}

    return {
      success: true,
      configured: this._isServerConfigured(),
      status: "unlicensed",
      isActive: false,
      keyPresent: false,
      message: "License removed.",
      error: null,
    };
  }
}

module.exports = LicenseManager;
