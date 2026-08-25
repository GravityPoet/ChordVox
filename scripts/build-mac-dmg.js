#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { resolveGitSourceSha } = require("./lib/release-metadata");

const projectRoot = path.resolve(__dirname, "..");
const packageJson = require(path.join(projectRoot, "package.json"));
const builderConfig = require(path.join(projectRoot, "electron-builder.json"));

function parseArgs(argv) {
  const options = {
    arch: process.env.TARGET_ARCH || process.arch,
    builderArgs: [],
    test: false,
    workDir: path.join(projectRoot, "dist", ".mac-dmg-work"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--test") {
      options.test = true;
      continue;
    }
    if (current === "--arch" && argv[index + 1]) {
      options.arch = argv[index + 1];
      index += 1;
      continue;
    }
    if (current === "--workdir" && argv[index + 1]) {
      options.workDir = path.resolve(projectRoot, argv[index + 1]);
      index += 1;
      continue;
    }
    if (current === "--preview-background" && argv[index + 1]) {
      options.previewBackgroundPath = path.resolve(projectRoot, argv[index + 1]);
      index += 1;
      continue;
    }
    options.builderArgs.push(current);
  }

  return options;
}

function log(message) {
  console.log(`[mac-dmg] ${message}`);
}

function fail(message) {
  console.error(`[mac-dmg] ${message}`);
  process.exit(1);
}

const dmgLayout = {
  width: 1040,
  height: 560,
  iconSize: 128,
  textSize: 14,
  appPosition: { x: 250, y: 350 },
  applicationsPosition: { x: 530, y: 350 },
  openErrorHelperFileName: "Fix & Open.command",
  openErrorHelperPosition: { x: 810, y: 350 },
  backgroundFileName: "background.tiff",
  hiddenBackgroundPosition: { x: 920, y: 860 },
};

function assertDmgUsesCustomLayout() {
  const dmgConfig = builderConfig.dmg || {};
  if (dmgConfig.background) {
    fail(
      "electron-builder.json must not set dmg.background. ChordVox DMG releases generate their Finder background in scripts/build-mac-dmg.js."
    );
  }
  if (dmgConfig.backgroundColor !== "#fbf7ef") {
    fail('electron-builder.json dmg.backgroundColor must be "#fbf7ef".');
  }
  if (
    !dmgConfig.window ||
    dmgConfig.window.width !== dmgLayout.width ||
    dmgConfig.window.height !== dmgLayout.height
  ) {
    fail(
      `electron-builder.json dmg.window must be ${dmgLayout.width}x${dmgLayout.height} for the custom ivory installer layout.`
    );
  }
}

function run(command, args, extraEnv = {}) {
  log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      ...extraEnv,
    },
  });

  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status}`);
  }
}

function ensureGlobeListenerBinary(arch) {
  if (process.platform !== "darwin") return;

  const binaryPath = path.join(projectRoot, "resources", "bin", "macos-globe-listener");
  // Keep this gate inside the packaging entry point as well as the npm
  // lifecycle hooks. Developers and release jobs often invoke this script
  // directly, and a cached/missing native helper must never produce a package
  // that only fails after installation.
  run(process.execPath, ["scripts/build-globe-listener.js", "--arch", arch]);

  if (!pathExists(binaryPath)) {
    throw new Error(`macOS Globe listener was not produced: ${binaryPath}`);
  }
  try {
    fs.accessSync(binaryPath, fs.constants.X_OK);
  } catch {
    throw new Error(`macOS Globe listener is not executable: ${binaryPath}`);
  }

  const fileDescription = runCapture("file", [binaryPath]);
  const expectedArchitecture = arch === "arm64" ? "arm64" : "x86_64";
  if (!fileDescription.includes(expectedArchitecture)) {
    throw new Error(
      `macOS Globe listener architecture mismatch: expected ${expectedArchitecture}, found ${fileDescription}`
    );
  }
}

function copyDmgTree(sourcePath, targetPath) {
  // DMG staging does not need source Finder/provenance metadata, and copying it can
  // trigger ditto copyfile temp-file races inside app.asar.unpacked node_modules.
  run("ditto", ["--norsrc", "--noextattr", sourcePath, targetPath]);
}

function runCapture(command, args, extraEnv = {}) {
  log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...extraEnv,
    },
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    const stdout = (result.stdout || "").trim();
    throw new Error(stderr || stdout || `${command} exited with code ${result.status}`);
  }

  return (result.stdout || "").trim();
}

function runCaptureInheritedError(command, args, extraEnv = {}) {
  log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "inherit"],
    env: {
      ...process.env,
      ...extraEnv,
    },
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const stdout = (result.stdout || "").trim();
    throw new Error(stdout || `${command} exited with code ${result.status}`);
  }

  const output = result.stdout || "";
  if (output.trim()) {
    console.log(output.trim());
  }
  return output.trim();
}

function runInput(command, args, input, extraEnv = {}) {
  log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    input,
    stdio: ["pipe", "inherit", "inherit"],
    env: {
      ...process.env,
      ...extraEnv,
    },
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status}`);
  }
}

function pathExists(targetPath) {
  try {
    fs.accessSync(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function ensureCleanDir(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
  fs.mkdirSync(targetPath, { recursive: true });
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderDmgBackgroundSvg(layout, scale = 1) {
  const title = "Install ChordVox";
  const subtitle = "1. Drag ChordVox.app to Applications.";
  const helperStep = `2. If blocked, double-click ${layout.openErrorHelperFileName}.`;
  const helperExplanation =
    "Only removes macOS quarantine from the installed app, then opens ChordVox.";
  const chineseHelperLine1 =
    "温馨提示：如果出现“非 App Store 软件”拦截提醒，请先拖进 Applications。";
  const chineseHelperLine2 = `再双击右侧 ${layout.openErrorHelperFileName}。ChordVox Pro 使用商业许可，并随包附带开源组件声明。`;
  const canvasWidth = layout.width * scale;
  const canvasHeight = layout.height * scale;
  const applicationsGlowX = layout.applicationsPosition.x - 86;
  const applicationsGlowY = layout.applicationsPosition.y - 74;
  const arrowStartX = layout.appPosition.x + 96;
  const arrowEndX = layout.applicationsPosition.x - 96;
  const arrowY = layout.appPosition.y - 10;
  const flowStartX = layout.appPosition.x + 118;
  const flowEndX = layout.applicationsPosition.x - 118;
  const helperArrowStartX = layout.applicationsPosition.x + 108;
  const helperArrowEndX = layout.openErrorHelperPosition.x - 88;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}">
  <defs>
    <linearGradient id="paper" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fffdf8"/>
      <stop offset="0.52" stop-color="#faf5ed"/>
      <stop offset="1" stop-color="#f2ecdf"/>
    </linearGradient>
    <linearGradient id="brandFlow" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#f35aa5"/>
      <stop offset="0.48" stop-color="#9b6cff"/>
      <stop offset="1" stop-color="#58c7ee"/>
    </linearGradient>
    <linearGradient id="brandFlowSoft" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#f35aa5" stop-opacity="0"/>
      <stop offset="0.22" stop-color="#f35aa5" stop-opacity="0.18"/>
      <stop offset="0.52" stop-color="#9b6cff" stop-opacity="0.18"/>
      <stop offset="0.82" stop-color="#58c7ee" stop-opacity="0.18"/>
      <stop offset="1" stop-color="#58c7ee" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="topSheen" cx="50%" cy="18%" r="72%">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.78"/>
      <stop offset="0.52" stop-color="#ffffff" stop-opacity="0.18"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="edgeShade" cx="50%" cy="52%" r="72%">
      <stop offset="0.55" stop-color="#8b6f4a" stop-opacity="0"/>
      <stop offset="1" stop-color="#8b6f4a" stop-opacity="0.11"/>
    </radialGradient>
    <radialGradient id="voiceGlow" cx="50%" cy="60%" r="58%">
      <stop offset="0" stop-color="#f35aa5" stop-opacity="0.08"/>
      <stop offset="0.45" stop-color="#8d74ff" stop-opacity="0.055"/>
      <stop offset="1" stop-color="#58c7ee" stop-opacity="0"/>
    </radialGradient>
    <filter id="tileShadow" x="-25%" y="-25%" width="150%" height="150%">
      <feDropShadow dx="0" dy="8" stdDeviation="8" flood-color="#816f59" flood-opacity="0.18"/>
      <feDropShadow dx="0" dy="1" stdDeviation="1" flood-color="#ffffff" flood-opacity="0.72"/>
    </filter>
    <filter id="softShadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="4" stdDeviation="5" flood-color="#8c7b62" flood-opacity="0.16"/>
    </filter>
  </defs>

  <g transform="scale(${scale})">
  <rect x="0" y="0" width="${layout.width}" height="${layout.height}" fill="#fbf7ef"/>
  <rect x="0" y="0" width="${layout.width}" height="${layout.height}" fill="url(#paper)"/>
  <rect x="0" y="0" width="${layout.width}" height="${layout.height}" fill="url(#topSheen)"/>
  <rect x="0" y="0" width="${layout.width}" height="${layout.height}" fill="url(#voiceGlow)"/>
  <rect x="0" y="0" width="${layout.width}" height="${layout.height}" fill="url(#edgeShade)"/>

  <path d="M 302 244 C 392 224, 462 260, 520 244 S 648 224, 738 244"
    fill="none" stroke="url(#brandFlowSoft)" stroke-width="16" stroke-linecap="round"/>
  <path d="M 330 245 C 410 232, 470 256, 520 245 S 632 232, 712 245"
    fill="none" stroke="url(#brandFlow)" stroke-width="2" stroke-linecap="round" opacity="0.36"/>

  <text x="${layout.width / 2}" y="68" text-anchor="middle"
    font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', Helvetica, Arial, sans-serif" font-size="30" font-weight="700"
    letter-spacing="0" fill="#38322b">${escapeXml(title)}</text>
  <text x="${layout.width / 2}" y="106" text-anchor="middle"
    font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', Helvetica, Arial, sans-serif" font-size="18" font-weight="650"
    letter-spacing="0" fill="#4c463d">${escapeXml(subtitle)}</text>
  <text x="${layout.width / 2}" y="134" text-anchor="middle"
    font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', Helvetica, Arial, sans-serif" font-size="15" font-weight="700"
    letter-spacing="0" fill="#665f56" opacity="0.94">${escapeXml(helperStep)}</text>
  <text x="${layout.width / 2}" y="158" text-anchor="middle"
    font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', Helvetica, Arial, sans-serif" font-size="12.5" font-weight="500"
    letter-spacing="0" fill="#7f776d" opacity="0.86">${escapeXml(helperExplanation)}</text>
  <text x="${layout.width / 2}" y="188" text-anchor="middle"
    font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', 'SF Pro Text', Helvetica, Arial, sans-serif" font-size="16" font-weight="800"
    letter-spacing="0" fill="#d5488f" opacity="0.98">${escapeXml(chineseHelperLine1)}</text>
  <text x="${layout.width / 2}" y="211" text-anchor="middle"
    font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', 'SF Pro Text', Helvetica, Arial, sans-serif" font-size="16" font-weight="800"
    letter-spacing="0" fill="#d5488f" opacity="0.98">${escapeXml(chineseHelperLine2)}</text>

  <ellipse cx="${layout.applicationsPosition.x}" cy="${layout.applicationsPosition.y + 58}" rx="92" ry="18" fill="#6d5a42" opacity="0.10"/>
  <rect x="${applicationsGlowX}" y="${applicationsGlowY}" width="172" height="148" rx="26" fill="#dceef6" opacity="0.16" filter="url(#softShadow)"/>

  <path d="M ${flowStartX} ${arrowY - 34} C ${layout.width / 2 - 36} ${arrowY - 58}, ${layout.width / 2 + 36} ${arrowY - 10}, ${flowEndX} ${arrowY - 34}"
    fill="none" stroke="url(#brandFlowSoft)" stroke-width="3" stroke-linecap="round" opacity="0.52"/>
  <path d="M ${flowStartX} ${arrowY + 33} C ${layout.width / 2 - 36} ${arrowY + 57}, ${layout.width / 2 + 36} ${arrowY + 10}, ${flowEndX} ${arrowY + 33}"
    fill="none" stroke="url(#brandFlowSoft)" stroke-width="3" stroke-linecap="round" opacity="0.44"/>

  <path d="M ${arrowStartX} ${arrowY} C ${layout.width / 2 - 16} ${arrowY}, ${layout.width / 2 + 16} ${arrowY}, ${arrowEndX} ${arrowY}"
    fill="none" stroke="url(#brandFlow)" stroke-width="3" stroke-linecap="round" opacity="0.92"/>
  <path d="M ${arrowEndX - 30} ${arrowY - 14} L ${arrowEndX} ${arrowY} L ${arrowEndX - 30} ${arrowY + 14}"
    fill="none" stroke="#58bfe7" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity="0.92"/>

  <path d="M ${helperArrowStartX} ${arrowY} C ${helperArrowStartX + 24} ${arrowY}, ${helperArrowEndX - 24} ${arrowY}, ${helperArrowEndX} ${arrowY}"
    fill="none" stroke="#a59b8f" stroke-width="2" stroke-dasharray="6 7" stroke-linecap="round" opacity="0.38"/>
  <path d="M ${helperArrowEndX - 18} ${arrowY - 9} L ${helperArrowEndX} ${arrowY} L ${helperArrowEndX - 18} ${arrowY + 9}"
    fill="none" stroke="#a59b8f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.42"/>
  </g>
</svg>
`;
}

function renderSvgToPng({ svgPath, pngPath, width, height }) {
  const outputDir = path.dirname(svgPath);
  const qlmanageOutputPath = path.join(outputDir, `${path.basename(svgPath)}.png`);
  fs.rmSync(qlmanageOutputPath, { force: true });
  fs.rmSync(pngPath, { force: true });

  run("qlmanage", ["-t", "-x", "-s", String(width), "-o", outputDir, svgPath]);

  if (!pathExists(qlmanageOutputPath)) {
    throw new Error(`Quick Look did not render expected PNG: ${qlmanageOutputPath}`);
  }

  moveFileSync(qlmanageOutputPath, pngPath);

  const dimensions = runCapture("sips", ["-g", "pixelWidth", "-g", "pixelHeight", pngPath]);
  if (
    !dimensions.includes(`pixelWidth: ${width}`) ||
    !dimensions.includes(`pixelHeight: ${height}`)
  ) {
    throw new Error(`Rendered DMG background PNG is not ${width}x${height}: ${pngPath}`);
  }
}

function writeDmgBackgroundImage(targetPath, layout) {
  const backgroundDir = path.dirname(targetPath);
  const oneXSvgPath = path.join(backgroundDir, "background-1x.svg");
  const twoXSvgPath = path.join(backgroundDir, "background-2x.svg");
  const oneXPngPath = path.join(backgroundDir, "background-1x.png");
  const twoXPngPath = path.join(backgroundDir, "background-2x.png");
  const oneXTiffPath = path.join(backgroundDir, "background-1x.tiff");
  const twoXTiffPath = path.join(backgroundDir, "background-2x.tiff");

  fs.mkdirSync(backgroundDir, { recursive: true });
  fs.writeFileSync(oneXSvgPath, renderDmgBackgroundSvg(layout, 1));
  fs.writeFileSync(twoXSvgPath, renderDmgBackgroundSvg(layout, 2));
  renderSvgToPng({
    svgPath: oneXSvgPath,
    pngPath: oneXPngPath,
    width: layout.width,
    height: layout.height,
  });
  renderSvgToPng({
    svgPath: twoXSvgPath,
    pngPath: twoXPngPath,
    width: layout.width * 2,
    height: layout.height * 2,
  });

  run("sips", [
    "-s",
    "format",
    "tiff",
    "-s",
    "dpiWidth",
    "72",
    "-s",
    "dpiHeight",
    "72",
    oneXPngPath,
    "--out",
    oneXTiffPath,
  ]);
  run("sips", [
    "-s",
    "format",
    "tiff",
    "-s",
    "dpiWidth",
    "144",
    "-s",
    "dpiHeight",
    "144",
    twoXPngPath,
    "--out",
    twoXTiffPath,
  ]);
  run("tiffutil", ["-cathidpicheck", oneXTiffPath, twoXTiffPath, "-out", targetPath]);

  fs.rmSync(oneXSvgPath, { force: true });
  fs.rmSync(twoXSvgPath, { force: true });
  fs.rmSync(oneXPngPath, { force: true });
  fs.rmSync(twoXPngPath, { force: true });
  fs.rmSync(oneXTiffPath, { force: true });
  fs.rmSync(twoXTiffPath, { force: true });
}

function writePreviewBackgroundPng(targetPath, layout) {
  const previewDir = path.dirname(targetPath);
  const previewSvgPath = path.join(previewDir, "background-preview.svg");
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(previewSvgPath, renderDmgBackgroundSvg(layout, 2));
  renderSvgToPng({
    svgPath: previewSvgPath,
    pngPath: targetPath,
    width: layout.width * 2,
    height: layout.height * 2,
  });
  fs.rmSync(previewSvgPath, { force: true });
}

function cleanupMountedDmgMetadata(mountDir) {
  for (const name of [".fseventsd", ".Spotlight-V100", ".Trashes", ".TemporaryItems"]) {
    fs.rmSync(path.join(mountDir, name), { recursive: true, force: true });
  }

  for (const name of [".background", ".DS_Store"]) {
    const targetPath = path.join(mountDir, name);
    if (!pathExists(targetPath)) continue;
    spawnSync("chflags", ["hidden", targetPath], { stdio: "ignore" });
  }
}

function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function configureDmgFinderLayout({ mountedVolumeName, appName, layout }) {
  const windowLeft = 140;
  const windowTop = 120;
  const windowRight = windowLeft + layout.width;
  const windowBottom = windowTop + layout.height;
  const script = `
tell application "Finder"
  tell disk ${appleScriptString(mountedVolumeName)}
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set pathbar visible of container window to false
    set the bounds of container window to {${windowLeft}, ${windowTop}, ${windowRight}, ${windowBottom}}
    set viewOptions to the icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to ${layout.iconSize}
    set text size of viewOptions to ${layout.textSize}
    set background picture of viewOptions to file ".background:${layout.backgroundFileName}"
    set position of item ${appleScriptString(appName)} of container window to {${layout.appPosition.x}, ${layout.appPosition.y}}
    set position of item "Applications" of container window to {${layout.applicationsPosition.x}, ${layout.applicationsPosition.y}}
    if exists item ${appleScriptString(layout.openErrorHelperFileName)} of container window then
      set position of item ${appleScriptString(layout.openErrorHelperFileName)} of container window to {${layout.openErrorHelperPosition.x}, ${layout.openErrorHelperPosition.y}}
    end if
    if exists item ".background" of container window then
      set position of item ".background" of container window to {${layout.hiddenBackgroundPosition.x}, ${layout.hiddenBackgroundPosition.y}}
    end if
    update without registering applications
    delay 2
    close
  end tell
end tell
`;

  runInput("osascript", [], script);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function formatTimestampForFilename(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("") +
    "-" +
    [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join("")
  );
}

function buildDmgPaths({ distRoot, scratchDir, dmgName }) {
  const dmgBaseName = dmgName.replace(/\.dmg$/i, "");
  const tempSuffix = `${formatTimestampForFilename()}-${process.pid}`;

  return {
    canonicalDmgPath: path.join(distRoot, dmgName),
    tempDmgPath: path.join(scratchDir, `${dmgBaseName}.tmp-${tempSuffix}.dmg`),
    fallbackDmgPath: path.join(distRoot, `${dmgBaseName}-${formatTimestampForFilename()}.dmg`),
  };
}

function writeOpenErrorHelper(stageDir, helperFileName) {
  const helperPath = path.join(stageDir, helperFileName);
  const script = `#!/bin/bash
set -euo pipefail

APP_PATH="/Applications/ChordVox.app"
SETTINGS_URL="x-apple.systempreferences:com.apple.preference.security?Privacy"

echo "ChordVox first-launch helper"
echo
echo "ChordVox Pro 使用商业许可，并随包附带第三方开源组件声明。"
echo "ChordVox Pro is commercially licensed and includes third-party open-source components."
echo "This only removes macOS quarantine from ChordVox.app, then opens it."
echo "It does not read or modify your files, settings, keychain, recordings, license, or app data."
echo

if [ ! -d "$APP_PATH" ]; then
  echo "ChordVox.app was not found in /Applications."
  echo "Drag ChordVox.app to Applications first, then run this helper again."
  echo
  read -r -p "Press Return to close this window..."
  exit 1
fi

echo "If macOS asks for your password, it is only to update the installed app bundle."
sudo xattr -rd com.apple.quarantine "$APP_PATH" 2>/dev/null || true

echo
echo "Opening ChordVox..."
if open "$APP_PATH"; then
  echo "Done. ChordVox should be opening now."
else
  echo "macOS still blocked ChordVox."
  echo "Opening Privacy & Security so you can choose Open Anyway."
  open "$SETTINGS_URL" || true
fi
echo
read -r -p "Press Return to close this window..."
`;

  fs.writeFileSync(helperPath, script, { mode: 0o755 });
  fs.chmodSync(helperPath, 0o755);
}

function isRetryableFsError(error) {
  const code = error && typeof error === "object" ? error.code : "";
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
}

function moveFileSync(sourcePath, targetPath) {
  try {
    fs.renameSync(sourcePath, targetPath);
    return;
  } catch (error) {
    if (!(error && typeof error === "object") || error.code !== "EXDEV") {
      throw error;
    }
  }

  fs.rmSync(targetPath, { force: true });
  fs.copyFileSync(sourcePath, targetPath);
  fs.rmSync(sourcePath, { force: true });
}

function getDirectorySizeKb(targetPath) {
  const output = runCapture("du", ["-sk", targetPath]);
  const match = output.match(/^(\d+)/);
  if (!match) {
    throw new Error(`Unable to determine directory size for ${targetPath}`);
  }
  return Number(match[1]);
}

function estimateWritableImageSizeKb(stageDir) {
  const sourceSizeKb = getDirectorySizeKb(stageDir);
  return sourceSizeKb + Math.ceil(sourceSizeKb * 0.2) + 262144;
}

function detachWithRetries(targetPath) {
  const retryDelays = [0, 500, 1200, 2000];
  let lastError = null;

  for (let index = 0; index < retryDelays.length; index += 1) {
    const delay = retryDelays[index];
    if (delay > 0) {
      log(
        `DMG mount is still busy. Waiting ${delay}ms before detach retry ${index + 1}/${retryDelays.length}...`
      );
      sleep(delay);
    }

    const shouldForce = index >= 1;
    const args = shouldForce ? ["detach", "-force", targetPath] : ["detach", targetPath];
    const result = spawnSync("hdiutil", args, {
      cwd: projectRoot,
      stdio: "inherit",
      env: process.env,
    });

    if (result.status === 0) {
      return;
    }

    lastError = new Error(
      `hdiutil detach${shouldForce ? " -force" : ""} exited with code ${result.status}`
    );
  }

  throw lastError || new Error(`Unable to detach DMG mount at ${targetPath}`);
}

function parseHdiutilMountPath(output) {
  const mountCandidates = output
    .split(/\r?\n/)
    .map((line) => {
      const tabParts = line
        .split(/\t+/)
        .map((part) => part.trim())
        .filter(Boolean);
      return tabParts.find((part) => part.startsWith("/Volumes/")) || "";
    })
    .filter(Boolean);

  if (mountCandidates.length === 0) {
    throw new Error("Unable to parse mounted volume path from hdiutil attach output.");
  }

  return mountCandidates[mountCandidates.length - 1];
}

function getMountedVolumeName(mountDir) {
  const volumeName = path.basename(mountDir);
  if (!volumeName) {
    throw new Error(`Unable to determine mounted volume name from path: ${mountDir}`);
  }
  return volumeName;
}

function runAppleScriptCapture(script) {
  log("$ osascript");
  const result = spawnSync("osascript", [], {
    cwd: projectRoot,
    input: script,
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    const stdout = (result.stdout || "").trim();
    throw new Error(stderr || stdout || `osascript exited with code ${result.status}`);
  }

  return (result.stdout || "").trim();
}

function finderShowsHiddenFiles() {
  const result = spawnSync("defaults", ["read", "com.apple.finder", "AppleShowAllFiles"], {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  });
  const value = (result.stdout || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function finderPositionMatches(actual, expected, hiddenFilesYOffset) {
  if (actual === `${expected.x},${expected.y}`) return true;
  return hiddenFilesYOffset > 0 && actual === `${expected.x},${expected.y + hiddenFilesYOffset}`;
}

function verifyDmgVisualLayout({ dmgPath, appName, layout }) {
  let mountDir = "";
  const attachOutput = runCaptureInheritedError("hdiutil", [
    "attach",
    "-readonly",
    "-nobrowse",
    "-noverify",
    "-noautoopen",
    dmgPath,
  ]);
  mountDir = parseHdiutilMountPath(attachOutput);
  const mountedVolumeName = getMountedVolumeName(mountDir);

  try {
    const backgroundPath = path.join(mountDir, ".background", layout.backgroundFileName);
    const dsStorePath = path.join(mountDir, ".DS_Store");
    const appPath = path.join(mountDir, appName);
    const applicationsPath = path.join(mountDir, "Applications");
    const openErrorHelperPath = path.join(mountDir, layout.openErrorHelperFileName);

    for (const requiredPath of [
      backgroundPath,
      dsStorePath,
      appPath,
      applicationsPath,
      openErrorHelperPath,
    ]) {
      if (!pathExists(requiredPath)) {
        throw new Error(`DMG visual layout verification failed. Missing: ${requiredPath}`);
      }
    }

    const applicationsStat = fs.lstatSync(applicationsPath);
    if (
      !applicationsStat.isSymbolicLink() ||
      fs.readlinkSync(applicationsPath) !== "/Applications"
    ) {
      throw new Error(
        "DMG visual layout verification failed. Applications is not a /Applications symlink."
      );
    }

    const dimensions = runCapture("sips", [
      "-g",
      "pixelWidth",
      "-g",
      "pixelHeight",
      backgroundPath,
    ]);
    if (
      !dimensions.includes(`pixelWidth: ${layout.width}`) ||
      !dimensions.includes(`pixelHeight: ${layout.height}`)
    ) {
      throw new Error(
        `DMG visual layout verification failed. Background image is not ${layout.width}x${layout.height}.`
      );
    }

    const script = `
tell application "Finder"
  tell disk ${appleScriptString(mountedVolumeName)}
    open
    delay 1
    set appPosition to position of item ${appleScriptString(appName)} of container window
    set applicationsPosition to position of item "Applications" of container window
    set openErrorHelperPosition to position of item ${appleScriptString(layout.openErrorHelperFileName)} of container window
    set hiddenBackgroundPosition to position of item ".background" of container window
    set toolbarState to toolbar visible of container window
    set statusbarState to statusbar visible of container window
    set pathbarState to pathbar visible of container window
    set viewOptions to the icon view options of container window
    set iconSizeValue to icon size of viewOptions
    set textSizeValue to text size of viewOptions
    close
    return ((item 1 of appPosition) as text) & "," & ((item 2 of appPosition) as text) & linefeed & ((item 1 of applicationsPosition) as text) & "," & ((item 2 of applicationsPosition) as text) & linefeed & ((item 1 of openErrorHelperPosition) as text) & "," & ((item 2 of openErrorHelperPosition) as text) & linefeed & ((item 1 of hiddenBackgroundPosition) as text) & "," & ((item 2 of hiddenBackgroundPosition) as text) & linefeed & (toolbarState as text) & "," & (statusbarState as text) & "," & (pathbarState as text) & linefeed & (iconSizeValue as text) & "," & (textSizeValue as text)
  end tell
end tell
`;
    const finderLayout = runAppleScriptCapture(script);
    const [
      appPosition,
      applicationsPosition,
      openErrorHelperPosition,
      hiddenBackgroundPosition,
      chromeState,
      iconMetrics,
    ] = finderLayout.split(/\r?\n/).map((line) => line.trim());

    const expectedIconMetrics = `${layout.iconSize},${layout.textSize}`;
    // Finder reports icon positions 45px lower when the local build machine has
    // AppleShowAllFiles enabled. The persisted DMG layout is still written to
    // the canonical coordinates used by normal Finder views.
    const hiddenFilesYOffset = finderShowsHiddenFiles() ? 45 : 0;
    if (!finderPositionMatches(appPosition, layout.appPosition, hiddenFilesYOffset)) {
      throw new Error(
        `DMG visual layout verification failed. ${appName} position is ${appPosition}.`
      );
    }
    if (
      !finderPositionMatches(applicationsPosition, layout.applicationsPosition, hiddenFilesYOffset)
    ) {
      throw new Error(
        `DMG visual layout verification failed. Applications position is ${applicationsPosition}.`
      );
    }
    if (
      !finderPositionMatches(
        openErrorHelperPosition,
        layout.openErrorHelperPosition,
        hiddenFilesYOffset
      )
    ) {
      throw new Error(
        `DMG visual layout verification failed. ${layout.openErrorHelperFileName} position is ${openErrorHelperPosition}.`
      );
    }
    if (
      !finderPositionMatches(
        hiddenBackgroundPosition,
        layout.hiddenBackgroundPosition,
        hiddenFilesYOffset
      )
    ) {
      throw new Error(
        `DMG visual layout verification failed. .background position is ${hiddenBackgroundPosition}.`
      );
    }
    if (chromeState !== "false,false,false") {
      throw new Error(
        "DMG visual layout verification failed. Finder toolbar/statusbar/pathbar are visible."
      );
    }
    if (iconMetrics !== expectedIconMetrics) {
      throw new Error(
        `DMG visual layout verification failed. Icon/text metrics are ${iconMetrics}.`
      );
    }

    log(`Verified DMG visual layout: ${dmgPath}`);
  } finally {
    if (mountDir) {
      detachWithRetries(mountDir);
    }
  }
}

function promoteDmg(tempDmgPath, canonicalDmgPath, fallbackDmgPath) {
  const retryDelays = [0, 800, 1600];
  let lastError = null;

  for (let index = 0; index < retryDelays.length; index += 1) {
    const delay = retryDelays[index];
    if (delay > 0) {
      log(
        `Canonical DMG path is still busy. Waiting ${delay}ms before retry ${index + 1}/${retryDelays.length}...`
      );
      sleep(delay);
    }

    try {
      moveFileSync(tempDmgPath, canonicalDmgPath);
      return {
        finalDmgPath: canonicalDmgPath,
        usedFallbackPath: false,
      };
    } catch (error) {
      if (!isRetryableFsError(error)) {
        throw error;
      }
      lastError = error;
    }
  }

  fs.rmSync(fallbackDmgPath, { force: true });
  moveFileSync(tempDmgPath, fallbackDmgPath);
  log(
    `Canonical DMG path remained busy after retries. Kept timestamped DMG instead: ${fallbackDmgPath}`
  );

  if (lastError) {
    log(`Last canonical-path error: ${lastError.message}`);
  }

  return {
    finalDmgPath: fallbackDmgPath,
    usedFallbackPath: true,
  };
}

function copyArtifactsToDist(workDir, distRoot) {
  const artifactNames = fs.readdirSync(workDir).filter((name) => {
    return name === "latest-mac.yml" || name.endsWith(".zip") || name.endsWith(".zip.blockmap");
  });

  for (const name of artifactNames) {
    const sourcePath = path.join(workDir, name);
    const destPath = path.join(distRoot, name);
    fs.rmSync(destPath, { recursive: true, force: true });
    fs.copyFileSync(sourcePath, destPath);
    log(`Copied ${name} -> dist/`);
  }
}

function resolveAppPath(workDir, productName, arch) {
  const directCandidate = path.join(workDir, `mac-${arch}`, `${productName}.app`);
  if (pathExists(directCandidate)) {
    return directCandidate;
  }

  const macDirCandidates = fs
    .readdirSync(workDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("mac"))
    .map((entry) => path.join(workDir, entry.name, `${productName}.app`))
    .filter((candidate) => pathExists(candidate));

  if (macDirCandidates.length > 0) {
    return macDirCandidates[0];
  }

  throw new Error(`Unable to locate packaged app in ${workDir}`);
}

function createStableDmg({
  appPath,
  stageDir,
  tempDmgPath,
  canonicalDmgPath,
  fallbackDmgPath,
  volumeName,
}) {
  ensureCleanDir(stageDir);
  const scratchDir = path.dirname(stageDir);

  const stagedAppPath = path.join(stageDir, path.basename(appPath));
  copyDmgTree(appPath, stagedAppPath);

  const backgroundDir = path.join(stageDir, ".background");
  const backgroundPath = path.join(backgroundDir, dmgLayout.backgroundFileName);
  writeDmgBackgroundImage(backgroundPath, dmgLayout);
  writePreviewBackgroundPng(path.join(scratchDir, "background-preview.png"), dmgLayout);

  const applicationsAlias = path.join(stageDir, "Applications");
  if (!pathExists(applicationsAlias)) {
    fs.symlinkSync("/Applications", applicationsAlias);
  }
  writeOpenErrorHelper(stageDir, dmgLayout.openErrorHelperFileName);

  let mountDir = "";
  const rwDmgPath = path.join(
    scratchDir,
    `${path.basename(tempDmgPath).replace(/\.dmg$/i, "")}.rw.dmg`
  );
  const imageSizeKb = estimateWritableImageSizeKb(stageDir);

  fs.rmSync(rwDmgPath, { force: true });
  fs.rmSync(tempDmgPath, { force: true });

  try {
    run("hdiutil", [
      "create",
      "-size",
      `${imageSizeKb}k`,
      "-fs",
      "HFS+",
      "-volname",
      volumeName,
      "-type",
      "UDIF",
      "-ov",
      rwDmgPath,
    ]);

    const attachOutput = runCaptureInheritedError("hdiutil", [
      "attach",
      "-readwrite",
      "-noverify",
      "-noautoopen",
      rwDmgPath,
    ]);
    mountDir = parseHdiutilMountPath(attachOutput);

    try {
      copyDmgTree(stageDir, mountDir);
      configureDmgFinderLayout({
        mountedVolumeName: getMountedVolumeName(mountDir),
        appName: path.basename(appPath),
        layout: dmgLayout,
      });
      cleanupMountedDmgMetadata(mountDir);
      run("sync", []);
      sleep(1200);
    } finally {
      detachWithRetries(mountDir);
    }

    run("hdiutil", [
      "convert",
      rwDmgPath,
      "-format",
      "UDZO",
      "-imagekey",
      "zlib-level=9",
      "-ov",
      "-o",
      tempDmgPath,
    ]);
    run("hdiutil", ["verify", tempDmgPath]);
  } finally {
    fs.rmSync(rwDmgPath, { force: true });
  }

  return promoteDmg(tempDmgPath, canonicalDmgPath, fallbackDmgPath);
}

async function createBlockmap(inputPath, outputPath) {
  const { buildBlockMap } = require("app-builder-lib/out/targets/blockmap/blockmap.js");
  fs.rmSync(outputPath, { force: true });
  log(`Building blockmap: ${outputPath}`);
  await buildBlockMap(inputPath, "gzip", outputPath);
  if (!pathExists(outputPath) || fs.statSync(outputPath).size === 0) {
    throw new Error(`DMG blockmap was not created: ${outputPath}`);
  }
}

async function main() {
  assertDmgUsesCustomLayout();

  const options = parseArgs(process.argv.slice(2));
  if (options.previewBackgroundPath) {
    writePreviewBackgroundPng(options.previewBackgroundPath, dmgLayout);
    log(`DMG background preview ready: ${options.previewBackgroundPath}`);
    return;
  }

  const arch = options.arch === "arm64" ? "arm64" : "x64";
  ensureGlobeListenerBinary(arch);
  run(process.execPath, ["scripts/build-electron.js"]);
  run("/bin/bash", ["scripts/ensure-macos-signing-identity.sh"]);

  const distRoot = path.join(projectRoot, "dist");
  const productName = builderConfig.productName || "ChordVox";
  const version = packageJson.version;
  const dmgName = `${productName}-${version}-${arch}.dmg`;
  const workDir = options.workDir;
  const scratchPrefix = `${productName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-dmg-`;
  const scratchDir = fs.mkdtempSync(path.join("/tmp", scratchPrefix));
  const stageDir = path.join(scratchDir, "stage");
  const { canonicalDmgPath, tempDmgPath, fallbackDmgPath } = buildDmgPaths({
    distRoot,
    scratchDir,
    dmgName,
  });

  run(process.execPath, [
    "scripts/download-llama-server.js",
    "--current",
    "--platform",
    "darwin",
    "--arch",
    arch,
  ]);
  ensureCleanDir(workDir);

  const builderArgs = ["--mac", "zip", `-c.directories.output=${workDir}`, "--publish=never"];

  if (arch === "arm64") {
    builderArgs.push("--arm64");
  } else if (arch === "x64") {
    builderArgs.push("--x64");
  }

  if (options.test) {
    log("Legacy --test flag keeps the same pinned ChordVox signing identity.");
  }
  const hasSourceMetadataOverride = options.builderArgs.some((argument) =>
    argument.startsWith("--config.extraMetadata.releaseSourceSha=")
  );
  if (!hasSourceMetadataOverride) {
    const sourceSha = process.env.CHORDVOX_RELEASE_SOURCE_SHA || resolveGitSourceSha(projectRoot);
    builderArgs.push(`--config.extraMetadata.releaseSourceSha=${sourceSha}`);
    log(`Binding packaged releaseSourceSha=${sourceSha}`);
  }
  builderArgs.push(...options.builderArgs);

  run(path.join(projectRoot, "node_modules", ".bin", "electron-builder"), builderArgs);

  copyArtifactsToDist(workDir, distRoot);

  const appPath = resolveAppPath(workDir, productName, arch);
  run("node", ["scripts/verify-mac-package.js", "--platform", "mac", appPath]);

  try {
    const { finalDmgPath, usedFallbackPath } = createStableDmg({
      appPath,
      stageDir,
      tempDmgPath,
      canonicalDmgPath,
      fallbackDmgPath,
      volumeName: productName,
    });
    verifyDmgVisualLayout({
      dmgPath: finalDmgPath,
      appName: path.basename(appPath),
      layout: dmgLayout,
    });
    const finalDmgBlockmapPath = `${finalDmgPath}.blockmap`;
    await createBlockmap(finalDmgPath, finalDmgBlockmapPath);

    if (usedFallbackPath) {
      log(`Stable DMG ready with fallback filename: ${finalDmgPath}`);
    } else {
      log(`Stable DMG ready: ${finalDmgPath}`);
    }
    log(`DMG blockmap ready: ${finalDmgBlockmapPath}`);
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
