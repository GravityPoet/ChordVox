const { app } = require("electron");
const { spawnSync } = require("child_process");
const {
  MACOS_SIGNING_CERTIFICATE_SHA1,
  MACOS_SIGNING_IDENTITY,
} = require("../config/macosSigningIdentity");

let cachedGuidance = null;

function computeMacAccessibilityGuidance() {
  if (process.platform !== "darwin") {
    return {
      platform: process.platform,
      packaged: app.isPackaged,
      signed: true,
      trustedSignature: true,
      shouldRegrantAfterUpdate: false,
      reason: "non_macos",
    };
  }

  const packaged = app.isPackaged && process.env.NODE_ENV !== "development";
  if (!packaged) {
    return {
      platform: "darwin",
      packaged: false,
      signed: false,
      trustedSignature: false,
      shouldRegrantAfterUpdate: false,
      reason: "development",
    };
  }

  const forcedHint = process.env.CHORDVOX_FORCE_UNSIGNED_ACCESSIBILITY_HINT;
  if (forcedHint === "1") {
    return {
      platform: "darwin",
      packaged: true,
      signed: false,
      trustedSignature: false,
      shouldRegrantAfterUpdate: true,
      reason: "forced",
    };
  }

  const executablePath = app.getPath("exe") || process.execPath;

  try {
    const result = spawnSync("codesign", ["-d", "-r-", "--verbose=4", executablePath], {
      encoding: "utf8",
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    const signed = result.status === 0;
    const hasAuthority = /^Authority=/m.test(output);
    const hasTeamIdentifier = /^TeamIdentifier=(?!not set$).+/m.test(output);
    const isAdhoc = /Signature=adhoc/i.test(output) || /Authority=adhoc/i.test(output);
    const hasPinnedAuthority = output.includes(`Authority=${MACOS_SIGNING_IDENTITY}`);
    const hasPinnedRequirement = ["leaf", "root"].some((slot) =>
      output.includes(`certificate ${slot} = H"${MACOS_SIGNING_CERTIFICATE_SHA1}"`)
    );
    const stableSelfSignedSignature =
      signed && !isAdhoc && hasPinnedAuthority && hasPinnedRequirement;
    const developerIdSignature = signed && !isAdhoc && hasAuthority && hasTeamIdentifier;
    const trustedSignature = stableSelfSignedSignature || developerIdSignature;

    return {
      platform: "darwin",
      packaged: true,
      signed,
      trustedSignature,
      shouldRegrantAfterUpdate: !trustedSignature,
      reason: stableSelfSignedSignature
        ? "stable_self_signed_signature"
        : developerIdSignature
          ? "trusted_signature"
          : signed
            ? "adhoc_or_untrusted"
            : "unsigned",
    };
  } catch {
    return {
      platform: "darwin",
      packaged: true,
      signed: false,
      trustedSignature: false,
      shouldRegrantAfterUpdate: true,
      reason: "codesign_check_failed",
    };
  }
}

function getMacAccessibilityGuidance() {
  if (!cachedGuidance) {
    cachedGuidance = computeMacAccessibilityGuidance();
  }
  return cachedGuidance;
}

module.exports = {
  getMacAccessibilityGuidance,
};
