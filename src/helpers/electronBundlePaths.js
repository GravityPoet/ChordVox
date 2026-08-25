const fs = require("fs");
const path = require("path");

function resolveElectronEntry(fileName) {
  const bundledSibling = path.join(__dirname, fileName);
  if (fs.existsSync(bundledSibling)) {
    return bundledSibling;
  }

  return path.resolve(__dirname, "..", "..", fileName);
}

module.exports = {
  resolveElectronEntry,
};
