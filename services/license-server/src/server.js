const http = require("http");
const crypto = require("crypto");
const { URL } = require("url");

const { assertConfig, config } = require("./config");
const { initializeDatabase } = require("./db");
const { LicenseStore } = require("./license-store");
const { normalizeLicenseKey, normalizeMachineId } = require("./crypto-utils");

const MAX_BODY_SIZE_BYTES = 64 * 1024;
const CREEM_TIMEOUT_MS = 10000;

function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(body);
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;

    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > MAX_BODY_SIZE_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          reject(new Error("JSON body must be an object"));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", reject);
  });
}

function parseRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;

    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > MAX_BODY_SIZE_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    req.on("error", reject);
  });
}

function verifyCreemSignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader) return false;

  const secrets = [secret];
  if (secret.startsWith("whsec_")) {
    secrets.push(secret.slice("whsec_".length));
  }

  const cleanSig = signatureHeader.replace(/^(sha256=|v1=)/, "");

  for (const currentSecret of secrets) {
    const expected = crypto
      .createHmac("sha256", currentSecret)
      .update(rawBody)
      .digest("hex");
    try {
      if (
        expected.length === cleanSig.length &&
        crypto.timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(cleanSig, "utf8"))
      ) {
        return true;
      }
    } catch {
      // Ignore length mismatch and try the next variant.
    }
  }

  return false;
}

function readBearerToken(req) {
  const authHeader = String(req.headers.authorization || "").trim();
  if (!authHeader.startsWith("Bearer ")) return "";
  return authHeader.slice("Bearer ".length).trim();
}

function ensureAdminAuthorized(req, res) {
  if (!config.adminToken) {
    jsonResponse(res, 503, {
      error: "ADMIN_TOKEN_NOT_CONFIGURED",
      message: "Set LICENSE_SERVER_ADMIN_TOKEN to use admin endpoints.",
    });
    return false;
  }

  const token = readBearerToken(req);
  if (!token || token !== config.adminToken) {
    jsonResponse(res, 401, { error: "UNAUTHORIZED", message: "Missing or invalid admin token." });
    return false;
  }

  return true;
}

function parseDaysToIso(days) {
  if (days === undefined || days === null || days === "") return null;
  const value = Number(days);
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(Date.now() + value * 24 * 60 * 60 * 1000).toISOString();
}

function ensureLegacyStore(store, res) {
  if (store) return true;
  jsonResponse(res, 503, {
    error: "LEGACY_LICENSE_STORE_DISABLED",
    message: "Legacy AK license storage is disabled on this deployment.",
  });
  return false;
}

function ensureCreemConfigured(res) {
  if (config.creemApiKey) return true;
  jsonResponse(res, 503, {
    valid: false,
    status: "invalid",
    error: "LICENSE_SERVER_NOT_CONFIGURED",
    message: "Creem license relay is not configured yet.",
    offlineGraceHours: config.defaultOfflineGraceHours,
  });
  return false;
}

function isInternalOwnerKey(licenseKey) {
  if (!config.internalOwnerKey) return false;
  return normalizeLicenseKey(licenseKey) === normalizeLicenseKey(config.internalOwnerKey);
}

function getLocalLicenseDetails(store, licenseKey, productId) {
  if (!store || !licenseKey) return null;
  return store.getLicenseDetailsByKey(licenseKey, productId || config.defaultProductId);
}

function normalizeText(value, maxLen = 255) {
  const text = String(value || "").trim();
  if (!text) return null;
  return text.slice(0, maxLen);
}

function normalizeIso(dateLike) {
  if (!dateLike) return null;
  const parsed = new Date(dateLike);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function buildInstanceName({ machineId, platform, arch }) {
  const safeMachineId = normalizeMachineId(machineId) || "unknown-machine";
  const safePlatform = normalizeText(platform, 32) || "unknown-platform";
  const safeArch = normalizeText(arch, 32) || "unknown-arch";
  return `ChordVox-${safePlatform}-${safeArch}-${safeMachineId.slice(0, 12)}`.slice(0, 100);
}

function buildInternalInstanceId(machineId) {
  const safeMachineId = normalizeMachineId(machineId) || "unknown-machine";
  return `local-${safeMachineId.slice(0, 16)}`;
}

function extractCreemLicense(payload = {}) {
  const candidates = [
    payload.license,
    payload.data?.license,
    payload.data,
    payload,
  ];

  for (const candidate of candidates) {
    if (
      candidate &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      (candidate.status || candidate.key || candidate.product_id || candidate.productId)
    ) {
      return candidate;
    }
  }

  return {};
}

function extractCreemInstanceId(payload = {}) {
  const candidates = [
    payload.instance_id,
    payload.instanceId,
    payload.instance?.id,
    payload.instance?.instance_id,
    payload.data?.instance_id,
    payload.data?.instanceId,
    payload.data?.instance?.id,
    payload.data?.instance?.instance_id,
    payload.activation?.instance_id,
    payload.activation?.id,
    Array.isArray(payload.instances) ? payload.instances[0]?.id : null,
    Array.isArray(payload.data?.instances) ? payload.data.instances[0]?.id : null,
  ];

  for (const candidate of candidates) {
    const value = normalizeText(candidate, 128);
    if (value) return value;
  }

  return null;
}

function getCreemStatus(payload = {}) {
  const license = extractCreemLicense(payload);
  return String(license.status || payload.status || "").trim().toLowerCase();
}

function getCreemProductId(payload = {}) {
  const license = extractCreemLicense(payload);
  return normalizeText(
    license.product_id ||
    license.productId ||
    license.product?.id ||
    payload.product_id ||
    payload.productId,
    120
  );
}

function mapCreemStatusToClientStatus(rawStatus) {
  switch (rawStatus) {
    case "active":
      return "active";
    case "expired":
      return "expired";
    default:
      return "invalid";
  }
}

function mapCreemStatusToError(rawStatus) {
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

function buildClientLicenseResponse(payload = {}, overrides = {}) {
  const rawStatus = String(overrides.rawStatus || getCreemStatus(payload)).trim().toLowerCase();
  const status = overrides.status || mapCreemStatusToClientStatus(rawStatus);
  const error = overrides.error || (status === "active" ? null : mapCreemStatusToError(rawStatus));
  const license = extractCreemLicense(payload);
  const valid =
    typeof overrides.valid === "boolean"
      ? overrides.valid
      : status === "active";

  return {
    valid,
    status,
    plan: normalizeText(license.plan || payload.plan || payload.tier, 80),
    expiresAt: normalizeIso(
      overrides.expiresAt ||
      license.expires_at ||
      license.expiresAt ||
      payload.expires_at ||
      payload.expiresAt
    ),
    offlineGraceHours: config.defaultOfflineGraceHours,
    message:
      overrides.message ||
      normalizeText(payload.message, 1000) ||
      normalizeText(payload.error?.message || payload.error, 1000) ||
      (valid ? "License validated." : "License is not valid."),
    error,
    instanceId: overrides.instanceId || extractCreemInstanceId(payload),
  };
}

async function postCreemJson(endpoint, payload) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), CREEM_TIMEOUT_MS);

  try {
    const response = await fetch(`${config.creemApiBaseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.creemApiKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await response.text();
    let parsed = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { message: text };
      }
    }

    if (!response.ok) {
      const error = new Error(
        parsed?.error?.message ||
        parsed?.message ||
        `Creem API returned ${response.status} ${response.statusText}`
      );
      error.httpStatus = response.status;
      error.payload = parsed;
      throw error;
    }

    return parsed;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("Creem API request timed out.");
      timeoutError.code = "TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function mapCreemActivateFailure(error) {
  const httpStatus = Number(error.httpStatus || 0);
  const payload = error.payload || {};
  const message =
    normalizeText(payload?.error?.message || payload?.message || error.message, 1000) ||
    "Failed to activate license.";

  let code = "LICENSE_ACTIVATION_FAILED";
  if (httpStatus === 404) {
    code = "LICENSE_INVALID";
  } else if (
    httpStatus === 403 ||
    /activation/i.test(message) ||
    /device/i.test(message) ||
    /instance/i.test(message)
  ) {
    code = "LICENSE_ACTIVATION_LIMIT";
  } else if (httpStatus === 401) {
    code = "LICENSE_SERVER_NOT_CONFIGURED";
  }

  return buildClientLicenseResponse(payload, {
    valid: false,
    status: "invalid",
    error: code,
    message,
  });
}

function mapCreemValidateFailure(error) {
  const httpStatus = Number(error.httpStatus || 0);
  const payload = error.payload || {};
  const message =
    normalizeText(payload?.error?.message || payload?.message || error.message, 1000) ||
    "Failed to validate license.";

  let code = "LICENSE_VALIDATION_FAILED";
  if (httpStatus === 404 && /instance|device/i.test(message)) {
    code = "LICENSE_DEVICE_NOT_ACTIVATED";
  } else if (httpStatus === 404) {
    code = "LICENSE_INVALID";
  } else if (httpStatus === 401) {
    code = "LICENSE_SERVER_NOT_CONFIGURED";
  }

  return buildClientLicenseResponse(payload, {
    valid: false,
    status: "invalid",
    error: code,
    message,
  });
}

function mapCreemDeactivateFailure(error) {
  const httpStatus = Number(error.httpStatus || 0);
  const payload = error.payload || {};
  const message =
    normalizeText(payload?.error?.message || payload?.message || error.message, 1000) ||
    "Failed to deactivate license instance.";

  if (httpStatus === 404) {
    return {
      success: true,
      message: "Remote activation was already cleared.",
    };
  }

  return {
    success: false,
    error: httpStatus === 401 ? "LICENSE_SERVER_NOT_CONFIGURED" : "LICENSE_DEACTIVATION_FAILED",
    message,
  };
}

async function createServer() {
  assertConfig();
  const db = config.keyPepper ? initializeDatabase(config.dbPath) : null;
  const store = db ? new LicenseStore(db, config) : null;

  if (store && config.internalOwnerKey) {
    store.upsertInternalLicense({
      licenseKey: config.internalOwnerKey,
      productId: config.defaultProductId,
      plan: config.internalOwnerPlan,
      status: "active",
      maxActivations: config.internalOwnerMaxActivations,
      expiresAt: null,
      notes: "Internal owner license",
    });
  }

  return http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      });
      res.end();
      return;
    }

    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = requestUrl.pathname;

    try {
      if (req.method === "GET" && pathname === "/health") {
        jsonResponse(res, 200, {
          ok: true,
          service: "chordvox-license-server",
          provider: config.creemApiKey ? "creem" : "legacy-local",
          creemConfigured: Boolean(config.creemApiKey),
          productId: config.defaultProductId,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/licenses/activate") {
        const body = await parseJsonBody(req);
        const licenseKey = normalizeLicenseKey(body.licenseKey);
        const machineId = normalizeMachineId(body.machineId);
        const localLicense = getLocalLicenseDetails(store, licenseKey, body.productId);

        if (localLicense) {
          if (!ensureLegacyStore(store, res)) return;
          const result = store.activateLicense({
            licenseKey,
            productId: body.productId,
            machineId,
            appVersion: body.appVersion,
            platform: body.platform,
            arch: body.arch,
          });
          if (result.valid) {
            result.instanceId = buildInternalInstanceId(machineId);
          }
          jsonResponse(res, 200, result);
          return;
        }

        if (!ensureCreemConfigured(res)) return;

        if (!licenseKey) {
          jsonResponse(
            res,
            200,
            buildClientLicenseResponse({}, {
              valid: false,
              status: "invalid",
              error: "LICENSE_KEY_REQUIRED",
              message: "License key is required.",
            })
          );
          return;
        }

        if (!machineId) {
          jsonResponse(
            res,
            200,
            buildClientLicenseResponse({}, {
              valid: false,
              status: "invalid",
              error: "LICENSE_DEVICE_NOT_ACTIVATED",
              message: "machineId is required.",
            })
          );
          return;
        }

        try {
          const payload = await postCreemJson("/v1/licenses/activate", {
            key: licenseKey,
            instance_name: buildInstanceName({
              machineId,
              platform: body.platform,
              arch: body.arch,
            }),
          });

          const result = buildClientLicenseResponse(payload, {
            valid: true,
            status: "active",
            message: normalizeText(payload.message, 1000) || "License activated.",
          });

          if (!result.instanceId) {
            jsonResponse(
              res,
              200,
              buildClientLicenseResponse(payload, {
                valid: false,
                status: "invalid",
                error: "LICENSE_DEVICE_NOT_ACTIVATED",
                message: "Creem activation succeeded but instance_id was missing.",
              })
            );
            return;
          }

          jsonResponse(res, 200, result);
        } catch (error) {
          jsonResponse(res, 200, mapCreemActivateFailure(error));
        }
        return;
      }

      if (req.method === "POST" && pathname === "/v1/licenses/validate") {
        const body = await parseJsonBody(req);
        const licenseKey = normalizeLicenseKey(body.licenseKey);
        const instanceId = normalizeText(body.instanceId, 128);
        const localLicense = getLocalLicenseDetails(store, licenseKey, body.productId);

        if (localLicense) {
          if (!ensureLegacyStore(store, res)) return;
          const result = store.validateLicense({
            licenseKey,
            productId: body.productId,
            machineId: body.machineId,
            appVersion: body.appVersion,
            platform: body.platform,
            arch: body.arch,
          });
          if (result.valid) {
            result.instanceId = instanceId || buildInternalInstanceId(body.machineId);
          }
          jsonResponse(res, 200, result);
          return;
        }

        if (!ensureCreemConfigured(res)) return;

        if (!licenseKey) {
          jsonResponse(
            res,
            200,
            buildClientLicenseResponse({}, {
              valid: false,
              status: "invalid",
              error: "LICENSE_KEY_REQUIRED",
              message: "License key is required.",
            })
          );
          return;
        }

        if (!instanceId) {
          jsonResponse(
            res,
            200,
            buildClientLicenseResponse({}, {
              valid: false,
              status: "invalid",
              error: "LICENSE_DEVICE_NOT_ACTIVATED",
              message: "License is not activated on this device.",
            })
          );
          return;
        }

        try {
          const payload = await postCreemJson("/v1/licenses/validate", {
            key: licenseKey,
            instance_id: instanceId,
          });

          const result = buildClientLicenseResponse(payload, {
            valid: getCreemStatus(payload) === "active",
            message: normalizeText(payload.message, 1000) || "License validated.",
          });
          jsonResponse(res, 200, result);
        } catch (error) {
          jsonResponse(res, 200, mapCreemValidateFailure(error));
        }
        return;
      }

      if (req.method === "POST" && pathname === "/v1/licenses/deactivate") {
        const body = await parseJsonBody(req);
        const licenseKey = normalizeLicenseKey(body.licenseKey);
        const instanceId = normalizeText(body.instanceId, 128);
        const machineId = normalizeMachineId(body.machineId);
        const localLicense = getLocalLicenseDetails(store, licenseKey, body.productId);

        if (localLicense) {
          if (!ensureLegacyStore(store, res)) return;
          const result = store.resetActivationByKey(
            licenseKey,
            body.productId,
            machineId
          );
          jsonResponse(res, 200, {
            success: result.updated,
            message: result.message,
            error: result.updated ? null : "LICENSE_DEVICE_NOT_ACTIVATED",
          });
          return;
        }

        if (!ensureCreemConfigured(res)) return;

        if (!licenseKey || !instanceId) {
          jsonResponse(res, 200, {
            success: false,
            error: "LICENSE_DEVICE_NOT_ACTIVATED",
            message: "licenseKey and instanceId are required.",
          });
          return;
        }

        try {
          await postCreemJson("/v1/licenses/deactivate", {
            key: licenseKey,
            instance_id: instanceId,
          });

          jsonResponse(res, 200, {
            success: true,
            message: "License deactivated.",
          });
        } catch (error) {
          jsonResponse(res, 200, mapCreemDeactivateFailure(error));
        }
        return;
      }

      if (pathname.startsWith("/v1/admin/")) {
        if (!ensureAdminAuthorized(req, res)) return;
        if (!ensureLegacyStore(store, res)) return;

        if (req.method === "POST" && pathname === "/v1/admin/licenses/issue") {
          const body = await parseJsonBody(req);
          const issued = store.issueLicense({
            licenseKey: body.licenseKey,
            productId: body.productId,
            plan: body.plan,
            status: body.status,
            maxActivations: body.maxActivations,
            expiresAt: body.expiresAt || parseDaysToIso(body.days),
            customerEmail: body.customerEmail || body.email,
            orderRef: body.orderRef || body.orderId,
            notes: body.notes,
          });
          jsonResponse(res, 201, { success: true, license: issued });
          return;
        }

        if (req.method === "POST" && pathname === "/v1/admin/licenses/revoke") {
          const body = await parseJsonBody(req);
          const result = store.revokeLicenseByKey(body.licenseKey, body.productId, body.reason);
          jsonResponse(res, 200, { success: result.updated, ...result });
          return;
        }

        if (req.method === "POST" && pathname === "/v1/admin/licenses/reset-activation") {
          const body = await parseJsonBody(req);
          const result = store.resetActivationByKey(
            body.licenseKey,
            body.productId,
            body.machineId
          );
          jsonResponse(res, 200, { success: result.updated, ...result });
          return;
        }

        if (req.method === "GET" && pathname === "/v1/admin/licenses") {
          const limit = requestUrl.searchParams.get("limit");
          const licenses = store.listLicenses(limit ? Number(limit) : 20);
          jsonResponse(res, 200, { success: true, items: licenses });
          return;
        }

        if (req.method === "GET" && pathname === "/v1/admin/licenses/inspect") {
          const licenseKey = requestUrl.searchParams.get("licenseKey") || "";
          const productId = requestUrl.searchParams.get("productId") || undefined;
          const details = store.getLicenseDetailsByKey(licenseKey, productId);
          jsonResponse(res, details ? 200 : 404, {
            success: Boolean(details),
            item: details,
            message: details ? undefined : "License not found.",
          });
          return;
        }
      }

      if (req.method === "POST" && pathname === "/v1/webhooks/creem") {
        const rawBody = await parseRawBody(req);
        const signature = String(req.headers["creem-signature"] || "").trim();

        if (!config.creemWebhookSecret) {
          jsonResponse(res, 503, { error: "WEBHOOK_NOT_CONFIGURED" });
          return;
        }

        if (!verifyCreemSignature(rawBody, signature, config.creemWebhookSecret)) {
          jsonResponse(res, 401, { error: "INVALID_SIGNATURE" });
          return;
        }

        let event;
        try {
          event = JSON.parse(rawBody.toString("utf8"));
        } catch {
          jsonResponse(res, 400, { error: "INVALID_JSON" });
          return;
        }

        const eventType = event.eventType || event.event_type || event.type || "";
        if (eventType !== "checkout.completed") {
          jsonResponse(res, 200, { received: true, skipped: eventType });
          return;
        }

        const checkout = event.object || event.data || event;
        const order = checkout.order || checkout;
        const productId =
          checkout.product?.id ||
          order.product?.id ||
          order.product_id ||
          order.product ||
          "";
        const customerEmail =
          checkout.customer?.email ||
          order.customer?.email ||
          checkout.customer_email ||
          order.customer_email ||
          "";
        const orderId = order.id || checkout.id || event.id || "";

        console.log(
          `[webhook] checkout.completed acknowledged product=${productId} email=${customerEmail} order=${orderId}`
        );

        jsonResponse(res, 200, {
          received: true,
          eventType,
          customerEmail,
          orderId,
          productId,
        });
        return;
      }

      jsonResponse(res, 404, { error: "NOT_FOUND", message: "Route not found." });
    } catch (error) {
      jsonResponse(res, 400, {
        error: "REQUEST_FAILED",
        message: error.message || "Request failed.",
      });
    }
  });
}

async function start() {
  const server = await createServer();
  server.listen(config.port, config.host, () => {
    console.log(
      `[license-server] running on http://${config.host}:${config.port} (provider: ${config.creemApiKey ? "creem" : "legacy-local"})`
    );
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error("[license-server] failed to start", error);
    process.exitCode = 1;
  });
}

module.exports = {
  createServer,
  start,
};
