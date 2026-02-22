#!/usr/bin/env node
const { assertConfig, config } = require("../src/config");
const { initializeDatabase } = require("../src/db");
const { LicenseStore } = require("../src/license-store");

function usage() {
  console.log(`
ChordVox License Admin CLI

Usage:
  node scripts/license-admin.js issue [options]
  node scripts/license-admin.js revoke --key <LICENSE_KEY> [--product <PRODUCT_ID>] [--reason <TEXT>]
  node scripts/license-admin.js inspect --key <LICENSE_KEY> [--product <PRODUCT_ID>]
  node scripts/license-admin.js list [--limit 20]

Issue options:
  --key <LICENSE_KEY>            Optional fixed key (default auto-generated)
  --product <PRODUCT_ID>         Default: ${config.defaultProductId}
  --plan <PLAN>                  Default: pro
  --max <N>                      Max activations (default: 1)
  --days <N>                     Expire in N days
  --expires-at <ISO_TIME>        Expire at exact ISO timestamp
  --email <EMAIL>
  --order <ORDER_REF>
  --notes <TEXT>

Examples:
  node scripts/license-admin.js issue --email user@example.com --order ord_123 --days 365 --max 2
  node scripts/license-admin.js revoke --key AK-XXXX-XXXX-XXXX-XXXX --reason "Refunded"
  node scripts/license-admin.js inspect --key AK-XXXX-XXXX-XXXX-XXXX
  `);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function parseDaysToIso(days) {
  if (days === undefined || days === null || days === "") return null;
  const value = Number(days);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("--days must be a positive number.");
  }
  return new Date(Date.now() + value * 24 * 60 * 60 * 1000).toISOString();
}

function requireKey(options) {
  const key = String(options.key || "").trim();
  if (!key) {
    throw new Error("--key is required.");
  }
  return key;
}

function main() {
  const command = process.argv[2];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    process.exit(0);
  }

  assertConfig();
  const db = initializeDatabase(config.dbPath);
  const store = new LicenseStore(db, config);
  const options = parseArgs(process.argv.slice(3));

  try {
    if (command === "issue") {
      const issued = store.issueLicense({
        licenseKey: options.key,
        productId: options.product,
        plan: options.plan,
        status: options.status,
        maxActivations: options.max,
        expiresAt: options["expires-at"] || parseDaysToIso(options.days),
        customerEmail: options.email,
        orderRef: options.order,
        notes: options.notes,
      });
      console.log(JSON.stringify(issued, null, 2));
      console.log(`\nLICENSE_KEY=${issued.licenseKey}`);
      process.exit(0);
    }

    if (command === "revoke") {
      const result = store.revokeLicenseByKey(
        requireKey(options),
        options.product,
        options.reason || options.notes
      );
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.updated ? 0 : 1);
    }

    if (command === "inspect") {
      const details = store.getLicenseDetailsByKey(requireKey(options), options.product);
      if (!details) {
        console.error("License not found.");
        process.exit(1);
      }
      console.log(JSON.stringify(details, null, 2));
      process.exit(0);
    }

    if (command === "list") {
      const limit = options.limit ? Number(options.limit) : 20;
      const items = store.listLicenses(limit);
      console.log(JSON.stringify(items, null, 2));
      process.exit(0);
    }

    usage();
    process.exit(1);
  } finally {
    db.close();
  }
}

main();

