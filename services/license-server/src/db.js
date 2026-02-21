const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const CREATE_LICENSES_TABLE = `
CREATE TABLE IF NOT EXISTS licenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash TEXT NOT NULL UNIQUE,
  key_hint TEXT NOT NULL,
  product_id TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'pro',
  status TEXT NOT NULL DEFAULT 'active',
  max_activations INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT NULL,
  customer_email TEXT NULL,
  order_ref TEXT NULL,
  notes TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const CREATE_ACTIVATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS activations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER NOT NULL,
  machine_id TEXT NOT NULL,
  platform TEXT NULL,
  arch TEXT NULL,
  app_version TEXT NULL,
  first_activated_at TEXT NOT NULL,
  last_validated_at TEXT NOT NULL,
  FOREIGN KEY (license_id) REFERENCES licenses(id) ON DELETE CASCADE,
  UNIQUE(license_id, machine_id)
);
`;

const CREATE_INDICES = [
  "CREATE INDEX IF NOT EXISTS idx_licenses_product_status ON licenses(product_id, status);",
  "CREATE INDEX IF NOT EXISTS idx_activations_license_id ON activations(license_id);",
  "CREATE INDEX IF NOT EXISTS idx_activations_machine_id ON activations(machine_id);",
];

function initializeDatabase(dbPath) {
  const parentDir = path.dirname(dbPath);
  fs.mkdirSync(parentDir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");

  db.exec(CREATE_LICENSES_TABLE);
  db.exec(CREATE_ACTIVATIONS_TABLE);
  for (const sql of CREATE_INDICES) {
    db.exec(sql);
  }

  return db;
}

module.exports = {
  initializeDatabase,
};

