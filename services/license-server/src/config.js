const path = require("path");
const dotenv = require("dotenv");

const SERVICE_ROOT = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(SERVICE_ROOT, ".env") });

function readInt(rawValue, fallback) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

const config = {
  host: (process.env.HOST || "0.0.0.0").trim(),
  port: readInt(process.env.PORT, 8787),
  dbPath: path.resolve(SERVICE_ROOT, process.env.LICENSE_DB_PATH || "./data/licenses.db"),
  keyPepper: (process.env.LICENSE_KEY_PEPPER || "").trim(),
  defaultProductId: (process.env.LICENSE_DEFAULT_PRODUCT_ID || "chordvox-pro").trim(),
  defaultOfflineGraceHours: readInt(process.env.LICENSE_DEFAULT_OFFLINE_GRACE_HOURS, 168),
  adminToken: (process.env.LICENSE_SERVER_ADMIN_TOKEN || "").trim(),
  creemApiBaseUrl: (process.env.CREEM_API_BASE_URL || "https://api.creem.io")
    .trim()
    .replace(/\/+$/, ""),
  creemApiKey: (process.env.CREEM_API_KEY || "").trim(),
  creemWebhookSecret: (process.env.CREEM_WEBHOOK_SECRET || "").trim(),
  internalOwnerKey: (process.env.INTERNAL_OWNER_KEY || "").trim(),
  internalOwnerPlan: (process.env.INTERNAL_OWNER_PLAN || "owner").trim(),
  internalOwnerMaxActivations: readInt(process.env.INTERNAL_OWNER_MAX_ACTIVATIONS, 5),
};

function assertConfig() {
  const errors = [];

  if (!config.defaultProductId) {
    errors.push("LICENSE_DEFAULT_PRODUCT_ID is required.");
  }

  if (config.internalOwnerKey && (!config.keyPepper || config.keyPepper.length < 16)) {
    errors.push("LICENSE_KEY_PEPPER is required when INTERNAL_OWNER_KEY is enabled.");
  }

  if (errors.length > 0) {
    const error = new Error(`Invalid license server configuration:\n- ${errors.join("\n- ")}`);
    error.code = "INVALID_CONFIG";
    throw error;
  }
}

module.exports = {
  SERVICE_ROOT,
  config,
  assertConfig,
};
