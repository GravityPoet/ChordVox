const { normalizeMachineId } = require("./crypto-utils");

const DAY_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 15 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function parsePositiveInt(rawValue, fallback) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function normalizeOptionalText(value, maxLen = 255) {
  const text = String(value || "").trim();
  if (!text) return null;
  return text.slice(0, maxLen);
}

function normalizeProductId(value, fallback) {
  return normalizeOptionalText(value, 80) || fallback;
}

function normalizeIso(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function getImportedTrialWindow(payload, trialDays) {
  const trialStartedAt = normalizeIso(payload.trialStartedAt || payload.trial_started_at);
  const trialExpiresAt = normalizeIso(
    payload.trialExpiresAt ||
      payload.trial_expires_at ||
      payload.expiresAt ||
      payload.expires_at
  );
  if (!trialStartedAt || !trialExpiresAt) return null;

  const nowMs = Date.now();
  const startedMs = Date.parse(trialStartedAt);
  const expiresMs = Date.parse(trialExpiresAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(expiresMs)) return null;
  if (expiresMs <= startedMs) return null;
  if (startedMs > nowMs + CLOCK_SKEW_MS) return null;

  const maxTrialDurationMs = trialDays * DAY_MS + CLOCK_SKEW_MS;
  if (expiresMs - startedMs > maxTrialDurationMs) return null;

  return {
    trialStartedAt,
    trialExpiresAt,
  };
}

function buildTrialPayload(row, trialDays, message) {
  const nowMs = Date.now();
  const expiresMs = Date.parse(row?.expires_at || "");
  const trialActive = Number.isFinite(expiresMs) && expiresMs > nowMs;
  const trialDaysLeft = trialActive
    ? Math.max(1, Math.ceil((expiresMs - nowMs) / (24 * 60 * 60 * 1000)))
    : 0;

  return {
    success: true,
    valid: trialActive,
    status: trialActive ? "active" : "expired",
    plan: "trial",
    expiresAt: row?.expires_at || null,
    trialEnabled: true,
    trialDays,
    trialStartedAt: row?.started_at || null,
    trialExpiresAt: row?.expires_at || null,
    trialDaysLeft,
    trialActive,
    message:
      message ||
      (trialActive
        ? `Pro trial active. ${trialDaysLeft} day(s) remaining.`
        : "Pro trial has expired."),
    error: trialActive ? null : "TRIAL_EXPIRED",
  };
}

class TrialStore {
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.statements = this._prepareStatements();
  }

  _prepareStatements() {
    return {
      findTrial: this.db.prepare(`
        SELECT * FROM trials
        WHERE product_id = ? AND machine_id = ?
      `),
      insertTrial: this.db.prepare(`
        INSERT INTO trials (
          product_id, machine_id, platform, arch, app_version,
          started_at, expires_at, last_seen_at, created_at, updated_at
        ) VALUES (
          @product_id, @machine_id, @platform, @arch, @app_version,
          @started_at, @expires_at, @last_seen_at, @created_at, @updated_at
        )
      `),
      updateTrialSeen: this.db.prepare(`
        UPDATE trials
        SET platform = ?, arch = ?, app_version = ?, last_seen_at = ?, updated_at = ?
        WHERE product_id = ? AND machine_id = ?
      `),
    };
  }

  ensureTrial(payload = {}) {
    const productId = normalizeProductId(payload.productId, this.config.defaultProductId);
    const machineId = normalizeMachineId(payload.machineId);
    const startIfNeeded = payload.startIfNeeded === true;
    const trialDays = parsePositiveInt(this.config.defaultTrialDays, 7);

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

    const platform = normalizeOptionalText(payload.platform, 32);
    const arch = normalizeOptionalText(payload.arch, 32);
    const appVersion = normalizeOptionalText(payload.appVersion, 32);
    const importedTrial = getImportedTrialWindow(payload, trialDays);
    const now = nowIso();

    const runEnsureTrial = this.db.transaction(() => {
      const existing = this.statements.findTrial.get(productId, machineId);
      if (existing) {
        this.statements.updateTrialSeen.run(
          platform,
          arch,
          appVersion,
          now,
          now,
          productId,
          machineId
        );
        return {
          row: {
            ...existing,
            platform,
            arch,
            app_version: appVersion,
            last_seen_at: now,
            updated_at: now,
          },
          startedNow: false,
        };
      }

      if (!startIfNeeded && !importedTrial) {
        return { row: null, startedNow: false };
      }

      const startedAt = importedTrial?.trialStartedAt || now;
      const expiresAt =
        importedTrial?.trialExpiresAt ||
        new Date(Date.parse(startedAt) + trialDays * DAY_MS).toISOString();
      const insertParams = {
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
      this.statements.insertTrial.run(insertParams);
      return {
        row: {
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
        },
        startedNow: !importedTrial,
      };
    });

    const result = runEnsureTrial();
    if (!result.row) {
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

    return buildTrialPayload(
      result.row,
      trialDays,
      result.startedNow
        ? `Pro trial started. ${trialDays} day(s) remaining.`
        : undefined
    );
  }
}

module.exports = {
  TrialStore,
};
