const path = require("path");
const dotenv = require("dotenv");

const SERVICE_ROOT = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(SERVICE_ROOT, ".env") });

function readInt(rawValue, fallback) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function readList(rawValue) {
  return String(rawValue || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function readOriginList(rawValue) {
  return readList(rawValue)
    .map((value) => {
      try {
        return new URL(value).origin;
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

const config = {
  host: (process.env.HOST || "0.0.0.0").trim(),
  port: readInt(process.env.PORT, 8787),
  dbPath: path.resolve(SERVICE_ROOT, process.env.LICENSE_DB_PATH || "./data/licenses.db"),
  keyPepper: (process.env.LICENSE_KEY_PEPPER || "").trim(),
  defaultProductId: (process.env.LICENSE_DEFAULT_PRODUCT_ID || "chordvox-pro").trim(),
  defaultOfflineGraceHours: readInt(process.env.LICENSE_DEFAULT_OFFLINE_GRACE_HOURS, 168),
  defaultTrialDays: readInt(process.env.LICENSE_DEFAULT_TRIAL_DAYS, 7),
  adminToken: (process.env.LICENSE_SERVER_ADMIN_TOKEN || "").trim(),
  creemApiBaseUrl: (process.env.CREEM_API_BASE_URL || "https://api.creem.io")
    .trim()
    .replace(/\/+$/, ""),
  creemApiKey: (process.env.CREEM_API_KEY || "").trim(),
  creemProductIds: readList(process.env.CREEM_PRODUCT_IDS || process.env.CREEM_PRODUCT_ID),
  creemWebhookSecret: (process.env.CREEM_WEBHOOK_SECRET || "").trim(),
  internalOwnerKey: (process.env.INTERNAL_OWNER_KEY || "").trim(),
  internalOwnerPlan: (process.env.INTERNAL_OWNER_PLAN || "owner").trim(),
  internalOwnerMaxActivations: readInt(process.env.INTERNAL_OWNER_MAX_ACTIVATIONS, 5),
  allowedOrigins: readOriginList(
    process.env.LICENSE_SERVER_ALLOWED_ORIGINS || "https://chordvox.com,https://www.chordvox.com"
  ),
  rateLimitWindowMs: readInt(process.env.LICENSE_SERVER_RATE_LIMIT_WINDOW_MS, 60_000),
  rateLimitMaxRequests: readInt(process.env.LICENSE_SERVER_RATE_LIMIT_MAX_REQUESTS, 600),
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
