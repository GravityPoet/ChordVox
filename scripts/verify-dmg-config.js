#!/usr/bin/env node
"use strict";

const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const builderConfig = require(path.join(projectRoot, "electron-builder.json"));

const dmgConfig = builderConfig.dmg || {};
const expected = {
  backgroundColor: "#fbf7ef",
  width: 1040,
  height: 560,
};

if (dmgConfig.background) {
  console.error(
    "[verify-dmg-config] electron-builder.json must not set dmg.background. ChordVox DMG releases generate their Finder background in scripts/build-mac-dmg.js."
  );
  process.exit(1);
}

if (dmgConfig.backgroundColor !== expected.backgroundColor) {
  console.error(
    `[verify-dmg-config] electron-builder.json dmg.backgroundColor must be "${expected.backgroundColor}".`
  );
  process.exit(1);
}

if (!dmgConfig.window || dmgConfig.window.width !== expected.width || dmgConfig.window.height !== expected.height) {
  console.error(
    `[verify-dmg-config] electron-builder.json dmg.window must be ${expected.width}x${expected.height}.`
  );
  process.exit(1);
}

console.log("[verify-dmg-config] DMG config matches the custom ivory installer layout.");
