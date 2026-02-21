const { assertConfig, config } = require("../src/config");
const { initializeDatabase } = require("../src/db");

function main() {
  assertConfig();
  const db = initializeDatabase(config.dbPath);
  db.close();
  console.log(`[license-server] database initialized: ${config.dbPath}`);
}

main();

