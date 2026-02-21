const {
  generateLicenseKey,
  hashLicenseKey,
  maskLicenseKey,
  normalizeLicenseKey,
  normalizeMachineId,
} = require("./crypto-utils");

const MAX_GENERATION_RETRIES = 20;
const LICENSE_STATUSES = new Set(["active", "revoked", "expired"]);

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

function isIsoExpired(expiresAt) {
  if (!expiresAt) return false;
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs)) return false;
  return expiresMs <= Date.now();
}

function buildLicensePayload(row, message, graceHours, valid = true) {
  const expired = isIsoExpired(row?.expires_at);
  const status = expired ? "expired" : row?.status === "active" ? "active" : "invalid";
  const isValid = valid && status === "active";

  return {
    valid: isValid,
    status,
    plan: row?.plan || null,
    expiresAt: row?.expires_at || null,
    offlineGraceHours: graceHours,
    message,
  };
}

class LicenseStore {
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.statements = this._prepareStatements();
  }

  _prepareStatements() {
    return {
      insertLicense: this.db.prepare(`
        INSERT INTO licenses (
          key_hash, key_hint, product_id, plan, status, max_activations,
          expires_at, customer_email, order_ref, notes, created_at, updated_at
        ) VALUES (
          @key_hash, @key_hint, @product_id, @plan, @status, @max_activations,
          @expires_at, @customer_email, @order_ref, @notes, @created_at, @updated_at
        )
      `),
      findLicenseByKeyAndProduct: this.db.prepare(`
        SELECT * FROM licenses
        WHERE key_hash = ? AND product_id = ?
      `),
      findLicenseByHash: this.db.prepare(`
        SELECT id FROM licenses
        WHERE key_hash = ?
      `),
      findLicenseById: this.db.prepare(`
        SELECT * FROM licenses
        WHERE id = ?
      `),
      findActivation: this.db.prepare(`
        SELECT * FROM activations
        WHERE license_id = ? AND machine_id = ?
      `),
      countActivations: this.db.prepare(`
        SELECT COUNT(*) AS count FROM activations
        WHERE license_id = ?
      `),
      insertActivation: this.db.prepare(`
        INSERT INTO activations (
          license_id, machine_id, platform, arch, app_version, first_activated_at, last_validated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `),
      updateActivation: this.db.prepare(`
        UPDATE activations
        SET platform = ?, arch = ?, app_version = ?, last_validated_at = ?
        WHERE license_id = ? AND machine_id = ?
      `),
      updateLicenseStatus: this.db.prepare(`
        UPDATE licenses
        SET status = ?, notes = ?, updated_at = ?
        WHERE id = ?
      `),
      listLicenses: this.db.prepare(`
        SELECT l.*, COALESCE(a.activation_count, 0) AS activation_count
        FROM licenses l
        LEFT JOIN (
          SELECT license_id, COUNT(*) AS activation_count
          FROM activations
          GROUP BY license_id
        ) a ON a.license_id = l.id
        ORDER BY l.id DESC
        LIMIT ?
      `),
      listActivationsByLicenseId: this.db.prepare(`
        SELECT machine_id, platform, arch, app_version, first_activated_at, last_validated_at
        FROM activations
        WHERE license_id = ?
        ORDER BY id ASC
      `),
    };
  }

  _buildLicenseInsertParams({
    plainLicenseKey,
    productId,
    plan,
    status,
    maxActivations,
    expiresAt,
    customerEmail,
    orderRef,
    notes,
  }) {
    const normalizedLicenseKey = normalizeLicenseKey(plainLicenseKey);
    const licenseHash = hashLicenseKey(normalizedLicenseKey, this.config.keyPepper);
    const now = nowIso();

    return {
      key_hash: licenseHash,
      key_hint: maskLicenseKey(normalizedLicenseKey),
      product_id: productId,
      plan,
      status,
      max_activations: maxActivations,
      expires_at: expiresAt,
      customer_email: customerEmail,
      order_ref: orderRef,
      notes,
      created_at: now,
      updated_at: now,
    };
  }

  _pickUniqueLicenseKey(prefix) {
    for (let attempt = 0; attempt < MAX_GENERATION_RETRIES; attempt += 1) {
      const candidate = generateLicenseKey(prefix);
      const exists = this.statements.findLicenseByHash.get(
        hashLicenseKey(candidate, this.config.keyPepper)
      );
      if (!exists) {
        return candidate;
      }
    }
    throw new Error("Could not generate a unique license key after multiple attempts.");
  }

  issueLicense(options = {}) {
    const productId = normalizeOptionalText(options.productId, 80) || this.config.defaultProductId;
    const plan = normalizeOptionalText(options.plan, 80) || "pro";
    const statusInput = normalizeOptionalText(options.status, 32) || "active";
    const status = LICENSE_STATUSES.has(statusInput) ? statusInput : "active";
    const maxActivations = parsePositiveInt(options.maxActivations, 1);
    const customerEmail = normalizeOptionalText(options.customerEmail, 255);
    const orderRef = normalizeOptionalText(options.orderRef, 255);
    const notes = normalizeOptionalText(options.notes, 1000);
    const expiresAt = normalizeOptionalText(options.expiresAt, 64);

    const providedKey = normalizeLicenseKey(options.licenseKey);
    if (providedKey) {
      const duplicate = this.statements.findLicenseByHash.get(
        hashLicenseKey(providedKey, this.config.keyPepper)
      );
      if (duplicate) {
        throw new Error("License key already exists.");
      }
    }
    const plainLicenseKey = providedKey || this._pickUniqueLicenseKey("AK");

    const insertParams = this._buildLicenseInsertParams({
      plainLicenseKey,
      productId,
      plan,
      status,
      maxActivations,
      expiresAt,
      customerEmail,
      orderRef,
      notes,
    });

    try {
      const result = this.statements.insertLicense.run(insertParams);
      return {
        id: result.lastInsertRowid,
        licenseKey: plainLicenseKey,
        keyHint: insertParams.key_hint,
        productId,
        plan,
        status,
        maxActivations,
        expiresAt: expiresAt || null,
        customerEmail,
        orderRef,
      };
    } catch (error) {
      if (String(error.message || "").includes("UNIQUE constraint failed")) {
        throw new Error("License key already exists.");
      }
      throw error;
    }
  }

  listLicenses(limit = 20) {
    const safeLimit = Math.max(1, Math.min(parsePositiveInt(limit, 20), 200));
    const rows = this.statements.listLicenses.all(safeLimit);
    return rows.map((row) => ({
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

  getLicenseDetailsByKey(licenseKey, productId) {
    const normalizedKey = normalizeLicenseKey(licenseKey);
    const normalizedProduct = normalizeOptionalText(productId, 80) || this.config.defaultProductId;
    const keyHash = hashLicenseKey(normalizedKey, this.config.keyPepper);
    const row = this.statements.findLicenseByKeyAndProduct.get(keyHash, normalizedProduct);
    if (!row) return null;

    const activations = this.statements.listActivationsByLicenseId.all(row.id);
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
      activations,
    };
  }

  revokeLicenseByKey(licenseKey, productId, reason) {
    const details = this.getLicenseDetailsByKey(licenseKey, productId);
    if (!details) {
      return { updated: false, message: "License not found." };
    }

    const note = normalizeOptionalText(reason, 1000) || details.notes || "Revoked by admin";
    this.statements.updateLicenseStatus.run("revoked", note, nowIso(), details.id);
    return { updated: true, message: "License revoked.", id: details.id };
  }

  _loadLicenseForClientRequest(licenseKey, productId) {
    const normalizedLicenseKey = normalizeLicenseKey(licenseKey);
    const normalizedProductId = normalizeOptionalText(productId, 80) || this.config.defaultProductId;

    if (!normalizedLicenseKey) {
      return { errorPayload: { valid: false, status: "invalid", message: "licenseKey is required." } };
    }

    const keyHash = hashLicenseKey(normalizedLicenseKey, this.config.keyPepper);
    const row = this.statements.findLicenseByKeyAndProduct.get(keyHash, normalizedProductId);
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
        errorPayload: buildLicensePayload(
          row,
          "License has been revoked. Contact support.",
          this.config.defaultOfflineGraceHours,
          false
        ),
      };
    }

    if (isIsoExpired(row.expires_at)) {
      this.statements.updateLicenseStatus.run("expired", row.notes, nowIso(), row.id);
      row.status = "expired";
      return {
        errorPayload: buildLicensePayload(
          row,
          "License has expired.",
          this.config.defaultOfflineGraceHours,
          false
        ),
      };
    }

    if (row.status !== "active") {
      return {
        errorPayload: buildLicensePayload(
          row,
          "License is not active.",
          this.config.defaultOfflineGraceHours,
          false
        ),
      };
    }

    return { row };
  }

  activateLicense(payload = {}) {
    const machineId = normalizeMachineId(payload.machineId);
    if (!machineId) {
      return { valid: false, status: "invalid", message: "machineId is required." };
    }

    const licenseLookup = this._loadLicenseForClientRequest(payload.licenseKey, payload.productId);
    if (licenseLookup.errorPayload) return licenseLookup.errorPayload;
    const row = licenseLookup.row;
    const now = nowIso();
    const platform = normalizeOptionalText(payload.platform, 32);
    const arch = normalizeOptionalText(payload.arch, 32);
    const appVersion = normalizeOptionalText(payload.appVersion, 32);

    const runActivation = this.db.transaction(() => {
      const existingActivation = this.statements.findActivation.get(row.id, machineId);
      if (existingActivation) {
        this.statements.updateActivation.run(platform, arch, appVersion, now, row.id, machineId);
        return { newlyActivated: false };
      }

      const activationCount = this.statements.countActivations.get(row.id)?.count || 0;
      if (activationCount >= row.max_activations) {
        return { newlyActivated: false, blocked: true };
      }

      this.statements.insertActivation.run(row.id, machineId, platform, arch, appVersion, now, now);
      return { newlyActivated: true };
    });

    const activationResult = runActivation();
    if (activationResult.blocked) {
      return buildLicensePayload(
        row,
        `Activation limit reached (${row.max_activations} devices).`,
        this.config.defaultOfflineGraceHours,
        false
      );
    }

    return buildLicensePayload(
      row,
      activationResult.newlyActivated ? "License activated." : "License already active on this device.",
      this.config.defaultOfflineGraceHours,
      true
    );
  }

  validateLicense(payload = {}) {
    const machineId = normalizeMachineId(payload.machineId);
    if (!machineId) {
      return { valid: false, status: "invalid", message: "machineId is required." };
    }

    const licenseLookup = this._loadLicenseForClientRequest(payload.licenseKey, payload.productId);
    if (licenseLookup.errorPayload) return licenseLookup.errorPayload;
    const row = licenseLookup.row;
    const existingActivation = this.statements.findActivation.get(row.id, machineId);
    if (!existingActivation) {
      return buildLicensePayload(
        row,
        "License is not activated on this device.",
        this.config.defaultOfflineGraceHours,
        false
      );
    }

    const platform = normalizeOptionalText(payload.platform, 32);
    const arch = normalizeOptionalText(payload.arch, 32);
    const appVersion = normalizeOptionalText(payload.appVersion, 32);
    this.statements.updateActivation.run(platform, arch, appVersion, nowIso(), row.id, machineId);

    return buildLicensePayload(row, "License validated.", this.config.defaultOfflineGraceHours, true);
  }
}

module.exports = {
  LicenseStore,
};
