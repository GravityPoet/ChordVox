"use strict";

const MACOS_SIGNING_IDENTITY = "ChordVox Local Code Signing";
const MACOS_BUNDLE_ID = "com.gravitypoet.chordvox";
const MACOS_SIGNING_CERTIFICATE_SHA1 = "630b4ea9c8bd702bd0340fb266a2cc5428a77d84";
const MACOS_SIGNING_CERTIFICATE_SHA256 =
  "c21e979bc792e4453f46b65b900702c4a3c9a00967273376193a678742b2944f";

function macosCodeRequirement(bundleId) {
  return `identifier "${bundleId}" and certificate root = H"${MACOS_SIGNING_CERTIFICATE_SHA1}"`;
}

module.exports = {
  MACOS_SIGNING_IDENTITY,
  MACOS_BUNDLE_ID,
  MACOS_SIGNING_CERTIFICATE_SHA1,
  MACOS_SIGNING_CERTIFICATE_SHA256,
  macosCodeRequirement,
};
