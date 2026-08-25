"use strict";

const baseConfig = require("./electron-builder.json");

const FIXED_WINDOWS_PUBLISHER = "ChordVox Local Code Signing";
const publisherName = String(process.env.WINDOWS_PUBLISHER_NAME || "").trim();

if (!publisherName) {
  throw new Error(
    "WINDOWS_PUBLISHER_NAME is required for Windows release builds and must exactly match the Authenticode certificate common name."
  );
}

if (publisherName !== FIXED_WINDOWS_PUBLISHER) {
  throw new Error(
    `WINDOWS_PUBLISHER_NAME must remain '${FIXED_WINDOWS_PUBLISHER}' so Windows updates keep the fixed self-signed Authenticode identity.`
  );
}

module.exports = {
  ...baseConfig,
  win: {
    ...baseConfig.win,
    forceCodeSigning: true,
    signtoolOptions: {
      ...(baseConfig.win.signtoolOptions || {}),
      publisherName: [publisherName],
      signingHashAlgorithms: ["sha256"],
    },
  },
};
