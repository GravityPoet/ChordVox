const http = require("http");
const { URL } = require("url");

const { assertConfig, config } = require("./config");
const { initializeDatabase } = require("./db");
const { LicenseStore } = require("./license-store");

const MAX_BODY_SIZE_BYTES = 64 * 1024;

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

function createServer() {
  assertConfig();
  const db = initializeDatabase(config.dbPath);
  const store = new LicenseStore(db, config);

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
          service: "ariakey-license-server",
          productId: config.defaultProductId,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/licenses/activate") {
        const body = await parseJsonBody(req);
        const result = store.activateLicense(body);
        jsonResponse(res, 200, result);
        return;
      }

      if (req.method === "POST" && pathname === "/v1/licenses/validate") {
        const body = await parseJsonBody(req);
        const result = store.validateLicense(body);
        jsonResponse(res, 200, result);
        return;
      }

      if (pathname.startsWith("/v1/admin/")) {
        if (!ensureAdminAuthorized(req, res)) return;

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

      jsonResponse(res, 404, { error: "NOT_FOUND", message: "Route not found." });
    } catch (error) {
      jsonResponse(res, 400, {
        error: "REQUEST_FAILED",
        message: error.message || "Request failed.",
      });
    }
  });
}

function start() {
  const server = createServer();
  server.listen(config.port, config.host, () => {
    console.log(
      `[license-server] running on http://${config.host}:${config.port} (db: ${config.dbPath})`
    );
  });
}

if (require.main === module) {
  start();
}

module.exports = {
  createServer,
  start,
};

