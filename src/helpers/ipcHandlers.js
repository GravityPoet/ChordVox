const { ipcMain, app, shell, BrowserWindow, dialog, nativeImage, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fsPromises = require("fs/promises");
const AppUtils = require("../utils");
const debugLogger = require("./debugLogger");
const { atomicWriteFile, readJsonWithBackup } = require("./atomicFile");
const { resolveElectronEntry } = require("./electronBundlePaths");
const GnomeShortcutManager = require("./gnomeShortcut");
const MacPermissionHelperManager = require("./macPermissionHelperManager");
const AssemblyAiStreaming = require("./assemblyAiStreaming");
const { i18nMain, changeLanguage } = require("./i18nMain");
const DeepgramStreaming = require("./deepgramStreaming");
const SherpaStreamingManager = require("./sherpaStreamingProcessManager");
const DoubaoAsrClient = require("./doubaoAsr");
const SonioxAsrClient = require("./sonioxAsr");
const DeepgramAsrClient = require("./deepgramAsr");
const GoogleCloudSttClient = require("./googleCloudStt");
const { getMacAccessibilityGuidance } = require("./macosAccessibilityGuidance");
const { DEFAULT_STREAMING_MODEL_ID } = require("../config/streamingModels");
const {
  getSpeechModelsRoot,
  normalizeModelsRootPath,
  validateModelsStorageRoot,
} = require("./modelDirUtils");
const {
  deletePunctuationModels,
  ensurePunctuationModelInBackground,
} = require("./punctuationModel");
const { openSafeExternalUrl } = require("./urlSecurity");
const {
  checkExternalAsrRuntime,
  transcribeExternalAsrRuntime,
  transcribeExternalAsrRuntimeFile,
} = require("./externalAsrRuntime");
const { createE2eEventRecorder, getE2eStubTranscriptionText, isE2eMode } = require("./e2eEvents");
const { normalizeOnboardingFunnelEventName } = require("../utils/onboardingTelemetry");
const {
  buildAnthropicReasoningRequestBody,
  normalizeAnthropicOutputEffort,
} = require("./reasoningRequestBodies");
const { shouldHideDictationWindowBeforePaste } = require("./pasteTargetFocus");

// No ChordVox-hosted transcription, reasoning, usage, or billing service is
// currently shipped. Keep IPC names for compatibility, but fail closed so a
// stale renderer setting cannot upload user data to an unfinished endpoint.
const HOSTED_CLOUD_FEATURES_ENABLED = false;
const hostedCloudUnavailableResponse = () => ({
  success: false,
  code: "HOSTED_CLOUD_UNAVAILABLE",
  error: "ChordVox hosted cloud is not available. Use local mode or configure BYOK.",
});

const MAX_IPC_AUDIO_BUFFER_BYTES = 25 * 1024 * 1024;
const MAX_CLOUD_AUDIO_FILE_BYTES = 100 * 1024 * 1024;
const MAX_STREAMING_AUDIO_CHUNK_BYTES = 1024 * 1024;
const MAX_IPC_TEXT_LENGTH = 1024 * 1024; // 1M chars hard cap on IPC string payloads
const MAX_IPC_CLIPBOARD_TEXT_LENGTH = 256 * 1024;
const MAX_IPC_TRANSCRIPTION_TEXT_LENGTH = 128 * 1024;
const MAX_COMPLETION_ALERT_TEXT_LENGTH = 128 * 1024;
const MAX_COMPLETION_ALERT_LABEL_LENGTH = 512;
const MAX_IPC_REASONING_PROMPT_LENGTH = 256 * 1024;
const MAX_IPC_REASONING_ID_LENGTH = 256;
const MAX_IPC_REASONING_LANGUAGE_LENGTH = 32;
const MAX_IPC_HISTORY_ITEMS = 50_000;
const MAX_IPC_HISTORY_OFFSET = 10_000_000;
const MAX_IPC_HISTORY_CURSOR_LENGTH = 512;
const MAX_SETTINGS_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_DICTIONARY_WORD_LENGTH = 64;
const MAX_DICTIONARY_WORDS = 200;
const DICTIONARY_CONTROL_CHARS_REGEX = /[\x00-\x1F\x7F]/g;
const MAX_REASONING_MAX_TOKENS = 65_536;
const MAX_REASONING_CONTEXT_SIZE = 262_144;
const MAX_REASONING_PROXY_BODY_BYTES = 2 * 1024 * 1024;
const MAX_REASONING_PROXY_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_REASONING_PROXY_URL_LENGTH = 2048;
const MAX_REASONING_PROXY_HEADER_LENGTH = 16 * 1024;
const MAX_REASONING_PROXY_DURATION_MS = 65_000;
const ANTHROPIC_REASONING_TIMEOUT_MS = 60_000;
const EMPTY_TRANSCRIPTION_STATS = Object.freeze({
  todayUnits: 0,
  totalUnits: 0,
  todayEntries: 0,
  totalEntries: 0,
  totalRecordingDurationMs: 0,
  estimatedTimeSavedMs: 0,
  averageDictationUnitsPerMinute: 0,
  lastUpdatedAt: null,
});
const REASONING_PROXY_ALLOWED_HEADERS = new Set([
  "accept",
  "anthropic-beta",
  "anthropic-version",
  "api-key", // Azure OpenAI deployments
  "authorization",
  "content-type",
  "openai-beta",
  "openai-organization",
  "openai-project",
  "x-api-key",
  "x-goog-api-key",
]);
// E2E stub hooks are dev/test-only. Hard-gate on !app.isPackaged so a stray
// CHORDVOX_E2E env var can never short-circuit transcription/paste/save or
// capture user transcription text into globalThis in a shipped build.
const E2E_MODE = isE2eMode(app);
const E2E_STUB_TRANSCRIPTION_TEXT = getE2eStubTranscriptionText();
const recordE2eEvent = createE2eEventRecorder(E2E_MODE);

let macPrivacyDragHelperWindow = null;
let macPrivacyHelperWatchTimer = null;
// Native drag-to-grant helper (preferred). Falls back to the BrowserWindow
// helper below if its binary is missing (e.g. dev without `npm run compile:native`).
const macPermissionHelper = new MacPermissionHelperManager();

const MAC_PRIVACY_HELPER_WIDTH = 360;
const MAC_PRIVACY_HELPER_HEIGHT = 224;
const MAC_PRIVACY_DRAG_ICON_SIZE = 56;

function allowKeychainAccess(options) {
  return Boolean(options && typeof options === "object" && options.allowKeychain === true);
}

function getMacAppBundlePath() {
  if (process.platform !== "darwin") return null;

  const executablePath = app.getPath("exe") || process.execPath || "";
  const bundleMatch = executablePath.match(/^(.+?\.app)(?:\/Contents\/MacOS\/[^/]+)?$/);
  if (!bundleMatch?.[1]) return null;

  return path.normalize(bundleMatch[1]);
}

function getPreferredMacAppBundlePath() {
  const currentBundlePath = getMacAppBundlePath();
  if (process.platform !== "darwin") return currentBundlePath;

  const appName = app.getName() || "ChordVox";
  const stableCandidates = [
    path.join("/Applications", `${appName}.app`),
    path.join(app.getPath("home") || "", "Applications", `${appName}.app`),
  ];
  const currentLooksInstalled =
    currentBundlePath &&
    (currentBundlePath.startsWith("/Applications/") ||
      currentBundlePath.startsWith(
        path.join(app.getPath("home") || "", "Applications") + path.sep
      ));

  if (currentLooksInstalled) return currentBundlePath;

  for (const candidate of stableCandidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return path.normalize(candidate);
    } catch {
      // Keep the current running bundle as fallback.
    }
  }

  return currentBundlePath;
}

function resizeMacDragIcon(image, size = MAC_PRIVACY_DRAG_ICON_SIZE) {
  if (!image || image.isEmpty()) return image || nativeImage.createEmpty();

  const resized = image.resize({ width: size, height: size, quality: "best" });
  return resized && !resized.isEmpty() ? resized : image;
}

function getMacDragIcon(size = MAC_PRIVACY_DRAG_ICON_SIZE) {
  const candidates = [
    path.join(process.resourcesPath || "", "src", "assets", "icon.png"),
    path.join(app.getAppPath(), "src", "assets", "icon.png"),
    path.join(__dirname, "..", "assets", "icon.png"),
  ];

  for (const candidate of candidates) {
    try {
      const image = nativeImage.createFromPath(candidate);
      if (!image.isEmpty()) return resizeMacDragIcon(image, size);
    } catch {
      // Try the next packaged/dev asset location.
    }
  }

  return nativeImage.createEmpty();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildMacPrivacyDragHelperHtml(options = {}) {
  const info = getMacAppBundleDragInfo();
  const icon = getMacDragIcon();
  const iconDataUrl = icon.isEmpty() ? "" : icon.toDataURL();
  const appName = escapeHtml(info.appName || "ChordVox");
  const title = escapeHtml(options.title || "Grant ChordVox Permission");
  const description = escapeHtml(
    options.description ||
      "Drag ChordVox.app into the list. If it is already listed, turn on its switch; if the drag bounces back, use the + button."
  );
  const cardLabel = escapeHtml(options.dragLabel || "Drag ChordVox.app");
  const settingsLabel = escapeHtml(options.revealLabel || "Open Accessibility");
  const closeLabel = escapeHtml(options.closeLabel || "Close");
  const unavailableLabel = escapeHtml(
    options.unavailableLabel ||
      "Install ChordVox from the packaged app first, then add it manually."
  );
  const actionHint = escapeHtml(
    options.dragHint || options.dragLabel || "Drag the icon, or use + to add ChordVox.app."
  );
  const statusText = info.available ? actionHint : unavailableLabel;
  const disabledAttr = info.available ? "" : ' aria-disabled="true"';
  const draggableAttr = info.available ? "true" : "false";
  const appCardClass = info.available ? "app-card" : "app-card app-card--disabled";
  const iconHtml = iconDataUrl
    ? `<img src="${iconDataUrl}" alt="" draggable="false" />`
    : `<div class="icon-fallback" aria-hidden="true">CV</div>`;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
  <style>
    :root {
      color-scheme: light;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Noto Sans", Roboto,
        "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif;
      background: #fbf7ef;
      color: #302b26;
    }

    html,
    body {
      margin: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      user-select: none;
      -webkit-user-select: none;
    }

    body {
      box-sizing: border-box;
      border: 1px solid rgba(93, 80, 66, 0.16);
      border-radius: 14px;
      background:
        linear-gradient(145deg, rgba(255, 255, 255, 0.92), rgba(250, 241, 227, 0.96)),
        #fbf7ef;
      box-shadow: 0 16px 40px rgba(46, 37, 27, 0.18);
    }

    .shell {
      box-sizing: border-box;
      height: 100%;
      padding: 13px 13px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .top {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      min-width: 0;
    }

    .copy {
      min-width: 0;
      flex: 1;
      -webkit-app-region: drag;
    }

    h1 {
      margin: 0;
      font-size: 13px;
      line-height: 18px;
      font-weight: 700;
      letter-spacing: 0;
      color: #2d2823;
    }

    p {
      margin: 4px 0 0;
      font-size: 11px;
      line-height: 15px;
      color: rgba(48, 43, 38, 0.72);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    button,
    .close,
    .settings,
    .app-card,
    .drag-source {
      -webkit-app-region: no-drag;
    }

    .close {
      width: 28px;
      height: 28px;
      border: 0;
      border-radius: 999px;
      background: rgba(78, 67, 55, 0.08);
      color: rgba(48, 43, 38, 0.72);
      font-size: 18px;
      line-height: 28px;
      cursor: pointer;
      flex: 0 0 auto;
    }

    .close:hover {
      background: rgba(78, 67, 55, 0.14);
      color: #302b26;
    }

    .app-card {
      box-sizing: border-box;
      display: grid;
      grid-template-columns: 58px minmax(0, 1fr) 20px;
      align-items: center;
      gap: 9px;
      min-height: 70px;
      padding: 8px 9px;
      border-radius: 11px;
      border: 1px solid rgba(89, 112, 245, 0.28);
      background: rgba(255, 255, 255, 0.78);
      box-shadow: 0 9px 20px rgba(72, 90, 180, 0.1);
      cursor: default;
    }

    .drag-source {
      width: 56px;
      height: 56px;
      display: grid;
      place-items: center;
      border-radius: 14px;
      cursor: grab;
    }

    .drag-source:active {
      cursor: grabbing;
    }

    .app-card--disabled {
      cursor: default;
      opacity: 0.72;
      border-color: rgba(93, 80, 66, 0.18);
      box-shadow: none;
    }

    .app-card--disabled .drag-source {
      cursor: default;
    }

    .app-card {
      -webkit-user-select: none;
      user-select: none;
    }

    .app-card:not(.app-card--disabled) {
      cursor: grab;
    }

    .app-card:not(.app-card--disabled):active {
      cursor: grabbing;
    }

    img,
    .icon-fallback {
      width: 56px;
      height: 56px;
      border-radius: 13px;
      pointer-events: none;
      box-shadow: 0 8px 18px rgba(45, 55, 110, 0.18);
    }

    .icon-fallback {
      display: grid;
      place-items: center;
      background: linear-gradient(135deg, #5d64f5, #7c68f0);
      color: white;
      font-size: 16px;
      font-weight: 800;
    }

    .app-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 14px;
      line-height: 19px;
      font-weight: 700;
      color: #2d2823;
    }

    .app-hint {
      margin-top: 2px;
      font-size: 11px;
      line-height: 15px;
      color: rgba(48, 43, 38, 0.62);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .grip {
      color: #7c68f0;
      font-size: 18px;
      text-align: right;
    }

    .actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 26px;
    }

    .settings {
      height: 26px;
      border: 0;
      border-radius: 8px;
      padding: 0 10px;
      background: #6d63f6;
      color: white;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 8px 18px rgba(109, 99, 246, 0.24);
    }

    .settings:hover {
      background: #5e55e8;
    }

    .settings:disabled {
      cursor: default;
      opacity: 0.45;
      box-shadow: none;
    }

    .footer {
      font-size: 10px;
      line-height: 14px;
      color: rgba(48, 43, 38, 0.52);
      text-align: right;
      min-width: 0;
      flex: 1;
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="top">
      <div class="copy">
        <h1>${title}</h1>
        <p>${description}</p>
      </div>
      <button class="close" type="button" aria-label="${closeLabel}" title="${closeLabel}">&times;</button>
    </div>
    <div class="${appCardClass}" role="group" draggable="${draggableAttr}" aria-label="${cardLabel}" title="${cardLabel}"${disabledAttr}>
      <div class="drag-source" aria-label="${cardLabel}" title="${cardLabel}"${disabledAttr}>${iconHtml}</div>
      <div>
        <div class="app-title">${appName}.app</div>
        <div class="app-hint">${statusText}</div>
      </div>
      <div class="grip">&#8599;</div>
    </div>
    <div class="actions">
      <button class="settings" type="button">${settingsLabel}</button>
      <div class="footer">${escapeHtml(options.footer || "")}</div>
    </div>
  </div>
  <script>
    const dragCard = document.querySelector(".app-card");
    const canDrag = ${info.available ? "true" : "false"};
    dragCard?.addEventListener("dragstart", (event) => {
      if (!canDrag) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      window.macPrivacyHelper?.startDrag?.();
    });
    let closeRequested = false;
    const requestClose = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (closeRequested) return;
      closeRequested = true;
      Promise.resolve(window.macPrivacyHelper?.close?.()).finally(() => {
        window.setTimeout(() => {
          try {
            window.close();
          } catch {}
          closeRequested = false;
        }, 20);
      });
    };
    document.querySelector(".close")?.addEventListener("pointerdown", requestClose);
    document.querySelector(".close")?.addEventListener("click", requestClose);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") requestClose(event);
    });
    document.querySelector(".settings")?.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await window.macPrivacyHelper?.openSettings?.("${options.watchPermission === "screenRecording" ? "screenRecording" : "accessibility"}");
      } finally {
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

function clearMacPrivacyHelperWatch() {
  if (macPrivacyHelperWatchTimer) {
    clearInterval(macPrivacyHelperWatchTimer);
    macPrivacyHelperWatchTimer = null;
  }
}

function isMacPrivacyPermissionGranted(watchPermission) {
  try {
    const { systemPreferences } = require("electron");
    if (watchPermission === "screenRecording") {
      return systemPreferences.getMediaAccessStatus("screen") === "granted";
    }
    // Query only (pass false) so polling never re-triggers the system prompt.
    return Boolean(systemPreferences.isTrustedAccessibilityClient(false));
  } catch {
    return false;
  }
}

function notifyMacPrivacyPermissionGranted(permission) {
  for (const targetWindow of BrowserWindow.getAllWindows()) {
    if (!targetWindow.isDestroyed()) {
      targetWindow.webContents.send("mac-privacy-permission-granted", {
        permission,
        granted: true,
      });
    }
  }
}

async function showMacPrivacyDragHelper(options = {}) {
  if (process.platform !== "darwin") {
    return { success: false, error: "Not macOS" };
  }

  const watchPermission =
    options.watchPermission === "screenRecording" ? "screenRecording" : "accessibility";

  // Preferred path: native nonactivating-panel helper. It receives the click
  // that starts the drag (and panel button clicks) even while System Settings is the
  // key app — which the Electron transparent/showInactive() panel below cannot
  // reliably do. Grant DETECTION stays here in the parent (only the ChordVox
  // process can truthfully query its own TCC trust); on grant we tell the helper
  // to flash "granted" and exit via stdin.
  const dragInfo = getMacAppBundleDragInfo();
  const startedNative = macPermissionHelper.start({
    kind: watchPermission,
    bundlePath: dragInfo.bundlePath || "",
    appName: dragInfo.appName,
    title: options.title || "",
    description: options.description || "",
    dragHint: options.dragHint || options.dragLabel || "",
    revealLabel: options.revealLabel || "",
    unavailableLabel: options.unavailableLabel || "",
    closeLabel: options.closeLabel || "",
    grantedLabel: options.grantedLabel || "",
    canDrag: dragInfo.available,
  });

  if (startedNative) {
    macPermissionHelper.removeAllListeners("closed");
    macPermissionHelper.removeAllListeners("exit");
    macPermissionHelper.on("closed", () => clearMacPrivacyHelperWatch());
    macPermissionHelper.on("exit", () => clearMacPrivacyHelperWatch());

    clearMacPrivacyHelperWatch();
    const grantedAtOpen = isMacPrivacyPermissionGranted(watchPermission);
    macPrivacyHelperWatchTimer = setInterval(() => {
      if (!macPermissionHelper.isRunning()) {
        clearMacPrivacyHelperWatch();
        return;
      }
      if (!grantedAtOpen && isMacPrivacyPermissionGranted(watchPermission)) {
        macPermissionHelper.signalGranted();
        notifyMacPrivacyPermissionGranted(watchPermission);
        clearMacPrivacyHelperWatch();
      }
    }, 1000);

    return { success: true, available: dragInfo.available, native: true };
  }

  const width = MAC_PRIVACY_HELPER_WIDTH;
  const height = MAC_PRIVACY_HELPER_HEIGHT;
  const focusedWindow = BrowserWindow.getFocusedWindow?.();
  const display = focusedWindow
    ? screen.getDisplayMatching(focusedWindow.getBounds())
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const workArea = display.workArea || display.bounds;
  const x = Math.max(workArea.x + 16, Math.round(workArea.x + workArea.width - width - 24));
  const y = Math.max(workArea.y + 16, Math.round(workArea.y + 74));

  if (!macPrivacyDragHelperWindow || macPrivacyDragHelperWindow.isDestroyed()) {
    macPrivacyDragHelperWindow = new BrowserWindow({
      width,
      height,
      x,
      y,
      title: options.title || "ChordVox Permission Helper",
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      visibleOnAllWorkspaces: false,
      movable: true,
      focusable: true,
      transparent: true,
      hasShadow: true,
      acceptFirstMouse: true,
      type: "panel",
      webPreferences: {
        preload: resolveElectronEntry("macPrivacyDragHelperPreload.js"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    macPrivacyDragHelperWindow.on("closed", () => {
      clearMacPrivacyHelperWatch();
      macPrivacyDragHelperWindow = null;
    });
  } else {
    macPrivacyDragHelperWindow.setBounds({ x, y, width, height });
  }

  await macPrivacyDragHelperWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(buildMacPrivacyDragHelperHtml(options))}`
  );

  macPrivacyDragHelperWindow.setAlwaysOnTop(true, "floating");
  if (typeof macPrivacyDragHelperWindow.setVisibleOnAllWorkspaces === "function") {
    macPrivacyDragHelperWindow.setVisibleOnAllWorkspaces(false);
  }
  if (typeof macPrivacyDragHelperWindow.showInactive === "function") {
    macPrivacyDragHelperWindow.showInactive();
  } else {
    macPrivacyDragHelperWindow.show();
  }
  if (typeof macPrivacyDragHelperWindow.moveTop === "function") {
    macPrivacyDragHelperWindow.moveTop();
  }

  // Auto-dismiss the helper the moment the user grants the permission, so they
  // never have to find the close button after flipping the switch. Only dismiss
  // on a not-granted -> granted transition: if the permission was already granted
  // when the helper opened (stale TCC entry, re-entry, or another app instance),
  // keep the window so it never vanishes from under the user's cursor while they
  // are still trying to drag the app in or read the instructions.
  clearMacPrivacyHelperWatch();
  const grantedAtOpen = isMacPrivacyPermissionGranted(watchPermission);
  macPrivacyHelperWatchTimer = setInterval(() => {
    if (!macPrivacyDragHelperWindow || macPrivacyDragHelperWindow.isDestroyed()) {
      clearMacPrivacyHelperWatch();
      return;
    }
    if (!grantedAtOpen && isMacPrivacyPermissionGranted(watchPermission)) {
      hideMacPrivacyDragHelper();
      notifyMacPrivacyPermissionGranted(watchPermission);
    }
  }, 1000);

  return { success: true, available: getMacAppBundleDragInfo().available };
}

function hideMacPrivacyDragHelper() {
  clearMacPrivacyHelperWatch();
  macPermissionHelper.stop();
  if (macPrivacyDragHelperWindow && !macPrivacyDragHelperWindow.isDestroyed()) {
    macPrivacyDragHelperWindow.destroy();
  }
  macPrivacyDragHelperWindow = null;
  return { success: true };
}

function getMacAppBundleDragInfo() {
  const bundlePath = getPreferredMacAppBundlePath();
  const packaged = app.isPackaged && process.env.NODE_ENV !== "development";
  const iconAvailable = !getMacDragIcon().isEmpty();
  const bundleAvailable = Boolean(process.platform === "darwin" && packaged && bundlePath);
  const available = Boolean(bundleAvailable && iconAvailable);

  return {
    platform: process.platform,
    packaged,
    available,
    revealAvailable: bundleAvailable,
    bundlePath,
    appName: app.getName() || "ChordVox",
    reason: available
      ? undefined
      : process.platform !== "darwin"
        ? "non_macos"
        : !packaged || !bundlePath
          ? "not_packaged"
          : "missing_icon",
  };
}

function sanitizeDictionaryWords(rawWords) {
  if (!Array.isArray(rawWords)) return [];
  const seen = new Set();
  const sanitized = [];
  for (const word of rawWords) {
    if (sanitized.length >= MAX_DICTIONARY_WORDS) break;
    if (typeof word !== "string") continue;
    const cleaned = word.replace(DICTIONARY_CONTROL_CHARS_REGEX, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) continue;
    const capped =
      cleaned.length > MAX_DICTIONARY_WORD_LENGTH
        ? cleaned.slice(0, MAX_DICTIONARY_WORD_LENGTH)
        : cleaned;
    const key = capped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    sanitized.push(capped);
  }
  return sanitized;
}

function getAudioBufferByteLength(value) {
  if (!value) return 0;
  if (Buffer.isBuffer(value)) return value.length;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof value === "string") return Buffer.byteLength(value);
  if (Number.isFinite(Number(value.byteLength))) return Number(value.byteLength);
  if (Number.isFinite(Number(value.length))) return Number(value.length);
  return 0;
}

function toBoundedAudioBuffer(value, label = "audioBuffer", maxBytes = MAX_IPC_AUDIO_BUFFER_BYTES) {
  const byteLength = getAudioBufferByteLength(value);
  if (byteLength === 0) {
    throw Object.assign(new Error(`${label} is empty`), { code: "ERR_AUDIO_BUFFER_EMPTY" });
  }
  if (byteLength > maxBytes) {
    throw Object.assign(
      new Error(`${label} exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit`),
      { code: "ERR_AUDIO_BUFFER_TOO_LARGE", sizeBytes: byteLength, maxBytes }
    );
  }
  const buffer = Buffer.from(value);
  return buffer;
}

function normalizeOperationId(value) {
  const operationId = String(value || "").trim();
  return operationId.length > 0 && operationId.length <= 128 ? operationId : "";
}

async function validateReadableAudioFilePath(filePath, options = {}) {
  const sourceFilePath = String(filePath || "").trim();
  if (!sourceFilePath) {
    return {
      ok: false,
      response: {
        success: false,
        error: "file_path_required",
        message: "Selected file path is unavailable. Please choose the file again.",
      },
    };
  }

  try {
    const stats = await fsPromises.stat(sourceFilePath);
    if (!stats.isFile()) {
      return {
        ok: false,
        response: {
          success: false,
          error: "invalid_file",
          message: "Selected audio path is not a file.",
        },
      };
    }
    const maxBytes = Number(options?.maxBytes);
    if (Number.isFinite(maxBytes) && maxBytes > 0 && stats.size > maxBytes) {
      return {
        ok: false,
        response: {
          success: false,
          error: "file_too_large",
          code: "ERR_AUDIO_FILE_TOO_LARGE",
          message: `This cloud provider supports files up to ${Math.round(maxBytes / (1024 * 1024))}MB in ChordVox. Choose a smaller file or switch to a local model.`,
          sizeBytes: stats.size,
          maxBytes,
        },
      };
    }
  } catch (error) {
    return {
      ok: false,
      response: {
        success: false,
        error: error.code || "file_not_readable",
        message: "Selected file is not readable. Please choose the file again.",
      },
    };
  }

  return { ok: true, filePath: sourceFilePath };
}

function isAudioBufferTooLargeError(error) {
  return error?.code === "ERR_AUDIO_BUFFER_TOO_LARGE";
}

function toBoundedString(value, label = "text", maxLength = MAX_IPC_TEXT_LENGTH) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") {
    throw Object.assign(new Error(`${label} must be a string`), {
      code: "ERR_IPC_TEXT_INVALID",
    });
  }
  if (value.length > maxLength) {
    throw Object.assign(new Error(`${label} exceeds ${maxLength} character limit`), {
      code: "ERR_IPC_TEXT_TOO_LARGE",
      length: value.length,
      maxLength,
    });
  }
  return value;
}

function toOptionalBoundedString(value, label = "text", maxLength = MAX_IPC_TEXT_LENGTH) {
  if (value === null || value === undefined || value === "") return undefined;
  return toBoundedString(value, label, maxLength);
}

function sanitizeControlPanelSection(value) {
  const section = String(value || "").trim();
  const allowedSections = new Set([
    "account",
    "general",
    "hotkeys",
    "transcription",
    "fileTranscription",
    "transcriptionHistory",
    "dictionary",
    "aiModels",
    "callRecords",
    "agentConfig",
    "prompts",
    "permissions",
    "privacy",
    "developer",
  ]);
  return allowedSections.has(section) ? section : "account";
}

function sanitizeCompletionAlertPayload(payload = {}) {
  const source = payload && typeof payload === "object" ? payload : {};
  return {
    id: Number.isFinite(Number(source.id)) ? Number(source.id) : null,
    text: toBoundedString(
      source.text || "",
      "completion alert transcription text",
      MAX_COMPLETION_ALERT_TEXT_LENGTH
    ),
    title: toBoundedString(
      source.title || "",
      "completion alert title",
      MAX_COMPLETION_ALERT_LABEL_LENGTH
    ),
    description: toBoundedString(
      source.description || "",
      "completion alert description",
      MAX_COMPLETION_ALERT_LABEL_LENGTH
    ),
    fileName: toBoundedString(
      source.fileName || "",
      "completion alert file name",
      MAX_COMPLETION_ALERT_LABEL_LENGTH
    ),
  };
}

function toBoundedNumber(value, label, { min, max, fallback }) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw Object.assign(new Error(`${label} must be a finite number`), {
      code: "ERR_IPC_NUMBER_INVALID",
    });
  }
  if (number < min || number > max) {
    throw Object.assign(new Error(`${label} must be between ${min} and ${max}`), {
      code: "ERR_IPC_NUMBER_OUT_OF_RANGE",
      value: number,
      min,
      max,
    });
  }
  return number;
}

function isPrivateReasoningProxyHost(hostname) {
  const h = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");

  if (h === "localhost" || h === "0.0.0.0" || h.startsWith("127.")) return true;
  if (h === "::1") return true;
  if (h.startsWith("10.") || h.startsWith("192.168.")) return true;
  if (h.startsWith("172.")) {
    const octet = parseInt(h.split(".")[1], 10);
    if (octet >= 16 && octet <= 31) return true;
  }
  if (h.includes(":") && /^f[cd][0-9a-f]{2}:/i.test(h)) {
    return true;
  }
  return false;
}

function isReasoningProxyModelsUrl(parsedUrl) {
  const pathname = parsedUrl.pathname || "";
  return (
    /\/(?:v\d+(?:beta)?\/)?models$/i.test(pathname) || /\/openai\/v\d+\/models$/i.test(pathname)
  );
}

function isAllowedReasoningProxyUrl(parsedUrl) {
  if (parsedUrl.protocol !== "https:" && !isPrivateReasoningProxyHost(parsedUrl.hostname)) {
    return false;
  }

  const pathname = parsedUrl.pathname || "";
  const isOpenAiCompatible =
    /\/(?:v\d+(?:beta)?\/)?(?:chat\/completions|responses)$/i.test(pathname) ||
    /\/openai\/v\d+\/chat\/completions$/i.test(pathname);
  const isAnthropicMessages = /\/(?:v\d+\/)?messages$/i.test(pathname);
  // Gemini accepts `?alt=sse` for streaming and `?key=...` for legacy
  // query-string auth; allow both (anything else is rejected to keep the
  // surface tight).
  let isGemini = false;
  if (/\/models\/[^/]+:(?:generateContent|streamGenerateContent)$/i.test(pathname)) {
    const params = parsedUrl.searchParams;
    let onlyAllowedParams = true;
    for (const name of params.keys()) {
      if (name !== "alt" && name !== "key") {
        onlyAllowedParams = false;
        break;
      }
    }
    const altValue = params.get("alt");
    isGemini = onlyAllowedParams && (altValue === null || altValue === "sse");
  }

  return (
    isOpenAiCompatible || isAnthropicMessages || isGemini || isReasoningProxyModelsUrl(parsedUrl)
  );
}

function getLoggableReasoningProxyUrl(urlText) {
  try {
    const parsedUrl = new URL(urlText);
    return `${parsedUrl.origin}${parsedUrl.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}

function sanitizeReasoningProxyHeaders(rawHeaders = {}) {
  if (!rawHeaders || typeof rawHeaders !== "object" || Array.isArray(rawHeaders)) {
    return { headers: {}, droppedHeaders: [] };
  }

  const headers = {};
  const droppedHeaders = [];
  for (const [rawName, rawValue] of Object.entries(rawHeaders)) {
    const name = String(rawName || "")
      .trim()
      .toLowerCase();
    if (!name) continue;
    if (!REASONING_PROXY_ALLOWED_HEADERS.has(name)) {
      droppedHeaders.push(name);
      continue;
    }
    if (rawValue === null || rawValue === undefined) continue;
    const value = String(rawValue);
    if (!value || value.length > MAX_REASONING_PROXY_HEADER_LENGTH) continue;
    headers[name] = value;
  }

  return { headers, droppedHeaders };
}

function sanitizeReasoningProxyPayload(payload = {}) {
  const source = payload && typeof payload === "object" ? payload : {};
  const requestId = toBoundedString(source.requestId || "", "reasoning proxy request id", 128);
  const urlText = toBoundedString(
    source.url,
    "reasoning proxy url",
    MAX_REASONING_PROXY_URL_LENGTH
  ).trim();

  if (!urlText) {
    throw Object.assign(new Error("reasoning proxy url is required"), {
      code: "ERR_REASONING_PROXY_URL_REQUIRED",
    });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(urlText);
  } catch {
    throw Object.assign(new Error("reasoning proxy url is invalid"), {
      code: "ERR_REASONING_PROXY_URL_INVALID",
    });
  }

  if (!isAllowedReasoningProxyUrl(parsedUrl)) {
    throw Object.assign(new Error("reasoning proxy url is not allowed"), {
      code: "ERR_REASONING_PROXY_URL_NOT_ALLOWED",
    });
  }

  const method = String(source.method || "POST").toUpperCase();
  if (method !== "POST" && method !== "GET") {
    throw Object.assign(new Error("reasoning proxy method is not allowed"), {
      code: "ERR_REASONING_PROXY_METHOD_NOT_ALLOWED",
    });
  }

  const isModelsUrl = isReasoningProxyModelsUrl(parsedUrl);
  if (method === "GET" && !isModelsUrl) {
    throw Object.assign(new Error("reasoning proxy GET is only allowed for model lists"), {
      code: "ERR_REASONING_PROXY_METHOD_NOT_ALLOWED",
    });
  }
  if (method === "POST" && isModelsUrl) {
    throw Object.assign(new Error("reasoning proxy models endpoint must use GET"), {
      code: "ERR_REASONING_PROXY_METHOD_NOT_ALLOWED",
    });
  }

  const body =
    method === "GET"
      ? undefined
      : typeof source.body === "string"
        ? source.body
        : JSON.stringify(source.body ?? {});
  if (body && Buffer.byteLength(body) > MAX_REASONING_PROXY_BODY_BYTES) {
    throw Object.assign(new Error("reasoning proxy body exceeds 2MB limit"), {
      code: "ERR_REASONING_PROXY_BODY_TOO_LARGE",
    });
  }

  const { headers, droppedHeaders } = sanitizeReasoningProxyHeaders(source.headers);

  return {
    requestId,
    url: parsedUrl.toString(),
    method,
    headers,
    droppedHeaders,
    body,
    isModelsRequest: isModelsUrl,
    stream: source.stream === true,
  };
}

function sanitizeReasoningConfig(config = {}) {
  const source = config && typeof config === "object" ? config : {};
  const sanitized = {};

  const requestId = toOptionalBoundedString(
    source.requestId,
    "reasoning request id",
    MAX_IPC_REASONING_ID_LENGTH
  );
  if (requestId !== undefined) sanitized.requestId = requestId;

  const systemPrompt = toOptionalBoundedString(
    source.systemPrompt,
    "reasoning system prompt",
    MAX_IPC_REASONING_PROMPT_LENGTH
  );
  if (systemPrompt !== undefined) sanitized.systemPrompt = systemPrompt;

  const maxTokens = toBoundedNumber(source.maxTokens, "reasoning maxTokens", {
    min: 1,
    max: MAX_REASONING_MAX_TOKENS,
    fallback: undefined,
  });
  if (maxTokens !== undefined) sanitized.maxTokens = Math.floor(maxTokens);

  const temperature = toBoundedNumber(source.temperature, "reasoning temperature", {
    min: 0,
    max: 2,
    fallback: undefined,
  });
  if (temperature !== undefined) sanitized.temperature = temperature;

  const contextSize = toBoundedNumber(source.contextSize, "reasoning contextSize", {
    min: 1,
    max: MAX_REASONING_CONTEXT_SIZE,
    fallback: undefined,
  });
  if (contextSize !== undefined) sanitized.contextSize = Math.floor(contextSize);

  const effort = normalizeAnthropicOutputEffort(source.effort);
  if (effort !== undefined) sanitized.effort = effort;

  const thinkingBudgetTokens = toBoundedNumber(
    source.thinkingBudgetTokens,
    "reasoning thinkingBudgetTokens",
    {
      min: 0,
      max: MAX_REASONING_MAX_TOKENS,
      fallback: undefined,
    }
  );
  if (thinkingBudgetTokens !== undefined) {
    sanitized.thinkingBudgetTokens = Math.floor(thinkingBudgetTokens);
  }

  return sanitized;
}

function sanitizeCloudReasonOptions(opts = {}) {
  const source = opts && typeof opts === "object" ? opts : {};
  const sanitized = {};

  sanitized.model = toOptionalBoundedString(
    source.model,
    "cloud reasoning model",
    MAX_IPC_REASONING_ID_LENGTH
  );
  sanitized.agentName = toOptionalBoundedString(
    source.agentName,
    "cloud reasoning agent name",
    MAX_IPC_REASONING_ID_LENGTH
  );
  sanitized.customPrompt = toOptionalBoundedString(
    source.customPrompt,
    "cloud reasoning custom prompt",
    MAX_IPC_REASONING_PROMPT_LENGTH
  );
  sanitized.language = toOptionalBoundedString(
    source.language,
    "cloud reasoning language",
    MAX_IPC_REASONING_LANGUAGE_LENGTH
  );
  sanitized.locale = toOptionalBoundedString(
    source.locale,
    "cloud reasoning locale",
    MAX_IPC_REASONING_LANGUAGE_LENGTH
  );
  sanitized.customDictionary = sanitizeDictionaryWords(source.customDictionary);
  sanitized.disableThinking = source.disableThinking === false ? false : true;

  const temperature = toBoundedNumber(source.temperature, "cloud reasoning temperature", {
    min: 0,
    max: 2,
    fallback: 0.1,
  });
  sanitized.temperature = temperature;

  return sanitized;
}

function normalizeCloudMultipartField(value, maxLength) {
  if (value === undefined || value === null || value === "") {
    return "";
  }

  const text = String(value);
  if (text.length > maxLength) {
    return text.slice(0, maxLength);
  }
  return text;
}

function getCookieLookupUrls(rawUrls) {
  const lookupUrls = new Set();

  for (const rawUrl of rawUrls) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;

      lookupUrls.add(parsed.origin);

      const hostname = parsed.hostname.toLowerCase();
      const parts = hostname.split(".").filter(Boolean);
      if (parts.length > 2) {
        const parentHost = parts.slice(-2).join(".");
        lookupUrls.add(`${parsed.protocol}//${parentHost}`);
      }
    } catch {
      // Ignore invalid runtime URLs; callers already fail later if API URL is invalid.
    }
  }

  return [...lookupUrls];
}

function appendMultipartField(parts, boundary, name, value) {
  const fieldName = String(name || "");
  const fieldValue = String(value);
  if (!/^[A-Za-z0-9_-]+$/.test(fieldName)) {
    throw new Error("Invalid multipart field name");
  }
  if (fieldValue.includes(boundary)) {
    throw new Error("Multipart field contains reserved boundary marker");
  }

  parts.push(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"\r\n\r\n` +
      `${fieldValue}\r\n`
  );
}

function normalizeModelDownloadRequest(payload, fallbackModelName = "") {
  if (payload && typeof payload === "object") {
    return {
      modelName: String(payload.modelName || payload.model || fallbackModelName || "").trim(),
      options: {
        uiLanguage: String(payload.uiLanguage || payload.locale || "")
          .trim()
          .slice(0, 32),
        locale: String(payload.locale || payload.uiLanguage || "")
          .trim()
          .slice(0, 32),
      },
    };
  }

  return {
    modelName: String(payload || fallbackModelName || "").trim(),
    options: {},
  };
}

function getCustomerDownloadError(error, fallbackCode = "DOWNLOAD_FAILED") {
  const code = error?.code || fallbackCode;
  const sources = Array.isArray(error?.sources) ? error.sources : [];
  const manualDownloadUrl = String(error?.manualDownloadUrl || "").trim();
  const resultExtras = {
    ...(manualDownloadUrl ? { manualDownloadUrl } : {}),
    ...(sources.length > 0 ? { sources } : {}),
  };
  const friendlyCodes = new Set([
    "DOWNLOAD_FAILED",
    "DOWNLOAD_SOURCES_EXHAUSTED",
    "NO_DOWNLOAD_SOURCE",
    "ERR_FILE_CHECKSUM_MISMATCH",
    "ERR_FILE_SIZE_MISMATCH",
    "ERR_FILE_TOO_SMALL",
    "ERR_FILE_TOO_LARGE",
    "ERR_DOWNLOAD_INCOMPLETE",
    "ETIMEDOUT",
    "ETIMEOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNRESET",
    "ECONNREFUSED",
    "EPIPE",
    "ERR_HTTP_RESPONSE",
  ]);
  const message = String(error?.message || "");

  if (
    friendlyCodes.has(code) ||
    /github\.com|huggingface\.co|http:\/\/|https:\/\//i.test(message)
  ) {
    return {
      code,
      message:
        "Download nodes are temporarily unavailable or the model package failed verification. Please try again later.",
      ...resultExtras,
    };
  }

  return {
    code,
    message: error?.message || "Download failed. Please try again later.",
    ...resultExtras,
  };
}

const CLOUD_REASON_LOW_LATENCY_FALLBACK_TTL_MS = 24 * 60 * 60 * 1000;

function isCloudReasonLowLatencyFallbackError(status, errorData) {
  if (status !== 400 && status !== 422) {
    return false;
  }

  const message = String(
    errorData?.error?.message || errorData?.message || errorData?.error || errorData?.code || ""
  ).toLowerCase();

  if (!message) {
    return false;
  }

  const mentionsLowLatencyParam =
    message.includes("disablethinking") ||
    message.includes("disable thinking") ||
    message.includes("temperature") ||
    message.includes("reasoning") ||
    message.includes("thinking");

  const saysUnsupported = [
    "unknown parameter",
    "unsupported",
    "not supported",
    "unrecognized",
    "invalid",
    "not permitted",
    "extra_forbidden",
    "extra inputs are not permitted",
    "cannot find field",
    "unknown name",
  ].some((token) => message.includes(token));

  return mentionsLowLatencyParam && saysUnsupported;
}

class IPCHandlers {
  constructor(managers) {
    this.environmentManager = managers.environmentManager;
    this.databaseManager = managers.databaseManager;
    this.clipboardManager = managers.clipboardManager;
    this.whisperManager = managers.whisperManager;
    this.parakeetManager = managers.parakeetManager;
    this.paraformerManager = managers.paraformerManager;
    this.graniteRuntimeManager = managers.graniteRuntimeManager;
    this.licenseManager = managers.licenseManager;
    this.windowManager = managers.windowManager;
    this.updateManager = managers.updateManager;
    this.windowsKeyManager = managers.windowsKeyManager;
    this.getTrayManager = managers.getTrayManager;
    this.reportOnboardingFunnelEvent = managers.reportOnboardingFunnelEvent;
    this.sessionId = crypto.randomUUID();
    this.assemblyAiStreaming = null;
    this.assemblyAiStreamingAuthorized = false;
    this.deepgramStreaming = null;
    this.deepgramStreamingAuthorized = false;
    this.sherpaStreaming = null;
    this.doubaoAsrClient = new DoubaoAsrClient();
    this.sonioxAsrClient = new SonioxAsrClient();
    this.deepgramAsrClient = new DeepgramAsrClient();
    this.googleCloudSttClient = new GoogleCloudSttClient();
    this.workflowHotkeysSuspendedForCapture = false;
    this.onboardingDictationSecret = crypto.randomBytes(32).toString("hex");
    this.latestOnboardingDictationSuccess = null;
    this.onboardingStatePath = path.join(app.getPath("userData"), "onboarding-state.json");
    this.onboardingStateWriteQueue = Promise.resolve();
    this.cloudReasonLowLatencyFallbacks = new Map();
    this.activeFileTranscriptions = new Map();
    this.activeTranscriptionLease = null;
    this.historyQueryVersions = new Map();
    // Tracks in-flight reasoning proxy requests so the renderer can cancel them
    // before the main process hits its own 65s timeout.
    this.activeReasoningProxyControllers = new Map();
    this.shuttingDown = false;
    this.shutdownPromise = null;
    this.setupHandlers();
  }

  /**
   * Build an ownership-scoped key for an in-flight IPC operation.
   *
   * Renderer supplied ids are only unique inside a renderer session.  Keeping
   * the sender id and operation domain in the key prevents a second window (or
   * a different kind of request) from replacing the first request's cancel
   * callback.
   */
  getOwnedOperationKey(domain, operationId, senderOrId) {
    const senderId =
      typeof senderOrId === "number" && Number.isFinite(senderOrId)
        ? senderOrId
        : Number(senderOrId?.id);
    const owner = Number.isFinite(senderId) ? senderId : "unowned";
    return `${owner}:${String(domain || "operation")}:${String(operationId || "")}`;
  }

  getSenderId(sender) {
    const senderId = Number(sender?.id);
    return Number.isFinite(senderId) ? senderId : null;
  }

  async recoverAfterSystemResume() {
    const tasks = [];

    for (const [key, entry] of this.activeFileTranscriptions.entries()) {
      tasks.push(
        Promise.resolve()
          .then(() => entry.cancel("system_resume"))
          .finally(() => {
            if (this.activeFileTranscriptions.get(key) === entry) {
              this.activeFileTranscriptions.delete(key);
            }
            entry.sender?.removeListener?.("destroyed", entry.onSenderDestroyed);
          })
      );
    }

    for (const [key, entry] of this.activeReasoningProxyControllers.entries()) {
      try {
        entry.cancel("system_resume");
      } catch {}
      if (this.activeReasoningProxyControllers.get(key) === entry) {
        this.activeReasoningProxyControllers.delete(key);
      }
      entry.sender?.removeListener?.("destroyed", entry.onSenderDestroyed);
    }
    this.releaseTranscriptionLeaseEntry(this.activeTranscriptionLease);

    if (this.sherpaStreaming) {
      tasks.push(Promise.resolve().then(() => this.sherpaStreaming.stopStream()));
    }
    if (this.assemblyAiStreaming) {
      tasks.push(
        Promise.resolve()
          .then(() => this.assemblyAiStreaming.disconnect(false))
          .finally(() => this.assemblyAiStreaming?.cleanupAll?.())
      );
      this.assemblyAiStreamingAuthorized = false;
    }
    if (this.deepgramStreaming) {
      tasks.push(Promise.resolve().then(() => this.deepgramStreaming.disconnect(false)));
      this.deepgramStreamingAuthorized = false;
    }

    return Promise.allSettled(tasks);
  }

  /**
   * Stop accepting/servicing cancellable work before the database and model
   * managers are closed by main.js.  The method is idempotent so both
   * before-quit and an explicit shutdown path can safely call it.
   */
  beginShutdown(reason = "app_quit") {
    if (this.shutdownPromise) return this.shutdownPromise;

    this.shuttingDown = true;
    debugLogger.info("IPC shutdown gate opened", { reason });
    const tasks = [];

    for (const [key, entry] of this.activeFileTranscriptions.entries()) {
      if (this.activeFileTranscriptions.get(key) === entry) {
        this.activeFileTranscriptions.delete(key);
      }
      entry.sender?.removeListener?.("destroyed", entry.onSenderDestroyed);
      tasks.push(
        Promise.resolve()
          .then(() => entry.cancel(reason))
          .catch((error) => {
            debugLogger.warn("File transcription shutdown cancellation failed", {
              provider: entry.provider,
              error: error?.message || String(error),
            });
          })
      );
    }

    for (const [key, entry] of this.activeReasoningProxyControllers.entries()) {
      if (this.activeReasoningProxyControllers.get(key) === entry) {
        this.activeReasoningProxyControllers.delete(key);
      }
      entry.sender?.removeListener?.("destroyed", entry.onSenderDestroyed);
      try {
        entry.cancel(reason);
      } catch (error) {
        debugLogger.warn("Reasoning shutdown cancellation failed", {
          error: error?.message || String(error),
        });
      }
    }

    // Invalidate every in-flight history query. Their cooperative checkpoints
    // will observe the missing/new version before the DB is closed.
    for (const [queryKey, version] of this.historyQueryVersions.entries()) {
      this.historyQueryVersions.set(queryKey, version + 1);
    }
    this.releaseTranscriptionLeaseEntry(this.activeTranscriptionLease);

    if (this.sherpaStreaming) {
      tasks.push(Promise.resolve().then(() => this.sherpaStreaming.stopStream?.()));
    }
    if (this.assemblyAiStreaming) {
      tasks.push(
        Promise.resolve()
          .then(() => this.assemblyAiStreaming.disconnect(false))
          .finally(() => this.assemblyAiStreaming?.cleanupAll?.())
      );
      this.assemblyAiStreamingAuthorized = false;
    }
    if (this.deepgramStreaming) {
      tasks.push(Promise.resolve().then(() => this.deepgramStreaming.disconnect(false)));
      this.deepgramStreamingAuthorized = false;
    }

    this.shutdownPromise = Promise.allSettled(tasks).then(() => ({ success: true, reason }));
    return this.shutdownPromise;
  }

  registerFileTranscription(operationId, provider, cancel, sender = null) {
    const normalizedOperationId = normalizeOperationId(operationId);
    if (!normalizedOperationId || typeof cancel !== "function") {
      return () => {};
    }

    const senderId = this.getSenderId(sender);
    const key = this.getOwnedOperationKey("file-transcription", normalizedOperationId, senderId);
    const existing = this.activeFileTranscriptions.get(key);
    if (existing) {
      // Do not replace the active operation.  Abort the duplicate immediately
      // so callers receive the normal cancellation envelope instead of
      // silently losing the first request's cancel handle.
      try {
        cancel("duplicate_operation_id");
      } catch {}
      debugLogger.warn("Duplicate file transcription operation rejected", {
        operationId: normalizedOperationId,
        provider,
        senderId,
      });
      return () => {};
    }

    const entry = {
      provider,
      cancel,
      operationId: normalizedOperationId,
      sender,
      senderId,
      key,
      onSenderDestroyed: null,
    };
    entry.onSenderDestroyed = () => {
      try {
        cancel("renderer_destroyed");
      } catch {}
      if (this.activeFileTranscriptions.get(key) === entry) {
        this.activeFileTranscriptions.delete(key);
      }
    };
    sender?.once?.("destroyed", entry.onSenderDestroyed);
    this.activeFileTranscriptions.set(key, entry);
    return () => {
      sender?.removeListener?.("destroyed", entry.onSenderDestroyed);
      if (this.activeFileTranscriptions.get(key) === entry) {
        this.activeFileTranscriptions.delete(key);
      }
    };
  }

  async cancelFileTranscription(eventOrOperationId, maybeOperationId) {
    const event =
      eventOrOperationId && typeof eventOrOperationId === "object" && "sender" in eventOrOperationId
        ? eventOrOperationId
        : null;
    const operationId = event ? maybeOperationId : eventOrOperationId;
    const normalizedOperationId = normalizeOperationId(operationId);
    if (!normalizedOperationId) {
      return { success: false, error: "invalid_operation_id" };
    }

    const senderId = this.getSenderId(event?.sender);
    const candidates = [...this.activeFileTranscriptions.values()].filter(
      (entry) =>
        entry.operationId === normalizedOperationId &&
        (senderId === null ? entry.senderId === null : entry.senderId === senderId)
    );
    if (candidates.length > 1) {
      return { success: false, error: "ambiguous_operation_id" };
    }
    const entry = candidates[0];
    if (!entry) {
      return { success: false, error: "not_found", message: "No active transcription to cancel" };
    }

    if (this.activeFileTranscriptions.get(entry.key) === entry) {
      this.activeFileTranscriptions.delete(entry.key);
    }
    entry.sender?.removeListener?.("destroyed", entry.onSenderDestroyed);
    await entry.cancel("renderer_cancel");
    return { success: true, provider: entry.provider };
  }

  releaseTranscriptionLeaseEntry(entry) {
    if (!entry || this.activeTranscriptionLease !== entry) {
      return false;
    }

    this.activeTranscriptionLease = null;
    entry.sender?.removeListener?.("destroyed", entry.onSenderDestroyed);
    return true;
  }

  acquireTranscriptionLease(event, payload = {}) {
    const leaseId = normalizeOperationId(payload?.leaseId);
    if (!leaseId) {
      return { success: false, code: "INVALID_LEASE_ID", error: "invalid_lease_id" };
    }

    const sender = event?.sender;
    const senderId = Number(sender?.id);
    const active = this.activeTranscriptionLease;
    if (active && active.sender?.isDestroyed?.()) {
      this.releaseTranscriptionLeaseEntry(active);
    }

    const current = this.activeTranscriptionLease;
    if (current) {
      if (current.leaseId === leaseId && current.senderId === senderId) {
        return { success: true, leaseId, acquired: false };
      }
      return {
        success: false,
        code: "TRANSCRIPTION_BUSY",
        error: "transcription_busy",
        activeKind: current.kind,
        startedAt: current.startedAt,
      };
    }

    const entry = {
      leaseId,
      sender,
      senderId,
      kind: String(payload?.kind || "transcription").slice(0, 32),
      startedAt: Date.now(),
      onSenderDestroyed: null,
    };
    entry.onSenderDestroyed = () => {
      this.releaseTranscriptionLeaseEntry(entry);
    };
    sender?.once?.("destroyed", entry.onSenderDestroyed);
    this.activeTranscriptionLease = entry;
    return { success: true, leaseId, acquired: true };
  }

  releaseTranscriptionLease(event, leaseId) {
    const normalizedLeaseId = normalizeOperationId(leaseId);
    const active = this.activeTranscriptionLease;
    if (!active) {
      return { success: true, released: false };
    }
    if (
      !normalizedLeaseId ||
      active.leaseId !== normalizedLeaseId ||
      active.senderId !== Number(event?.sender?.id)
    ) {
      return { success: false, code: "LEASE_NOT_OWNED", error: "lease_not_owned" };
    }

    return { success: true, released: this.releaseTranscriptionLeaseEntry(active) };
  }

  getCloudReasonLowLatencyFallbackKey(apiUrl, model) {
    return [
      String(apiUrl || "")
        .trim()
        .toLowerCase(),
      String(model || "auto")
        .trim()
        .toLowerCase(),
    ].join("|");
  }

  isCloudReasonLowLatencyFallbackActive(key) {
    const expiresAt = this.cloudReasonLowLatencyFallbacks.get(key);
    if (!expiresAt) {
      return false;
    }

    if (expiresAt <= Date.now()) {
      this.cloudReasonLowLatencyFallbacks.delete(key);
      return false;
    }

    return true;
  }

  rememberCloudReasonLowLatencyFallback(key, meta = {}) {
    const expiresAt = Date.now() + CLOUD_REASON_LOW_LATENCY_FALLBACK_TTL_MS;
    this.cloudReasonLowLatencyFallbacks.set(key, expiresAt);
    debugLogger.debug(
      "Cloud reasoning low-latency params disabled for compatibility",
      {
        ...meta,
        expiresAt: new Date(expiresAt).toISOString(),
      },
      "cloud-api"
    );
  }

  async checkLicenseGate() {
    if (!this.licenseManager?.ensureProAccess) {
      return { allowed: true, status: null };
    }

    try {
      const status = await this.licenseManager.ensureProAccess();
      return {
        allowed: Boolean(status?.isActive),
        status: status || null,
      };
    } catch (error) {
      debugLogger.error("License gate check failed:", error);
      return {
        allowed: false,
        status: {
          success: false,
          status: "invalid",
          isActive: false,
          keyPresent: false,
          error: "LICENSE_CHECK_FAILED",
          message: "Failed to verify license status. Please open Settings > Account and retry.",
        },
      };
    }
  }

  buildLicenseDeniedResponse(status) {
    const message =
      status?.message ||
      "This feature requires Pro. Free local transcription remains available. Open Settings > Account to continue.";

    return {
      success: false,
      error: "LICENSE_REQUIRED",
      code: "LICENSE_REQUIRED",
      message,
      licenseStatus: status || null,
    };
  }

  async requireLicenseGate() {
    const licenseGate = await this.checkLicenseGate();
    if (licenseGate.allowed) return;

    const response = this.buildLicenseDeniedResponse(licenseGate.status);
    const error = new Error(response.message || response.error || "License required");
    error.code = "LICENSE_REQUIRED";
    error.response = response;
    throw error;
  }

  normalizeOpenAiCompatibleBaseUrl(value) {
    let normalized = String(value || "").trim();
    if (!normalized) return "";

    const suffixReplacements = [
      [/\/v1\/audio\/transcriptions$/i, "/v1"],
      [/\/audio\/transcriptions$/i, ""],
      [/\/v1\/audio\/translations$/i, "/v1"],
      [/\/audio\/translations$/i, ""],
      [/\/v1\/models$/i, "/v1"],
      [/\/models$/i, ""],
    ];

    for (const [pattern, replacement] of suffixReplacements) {
      if (pattern.test(normalized)) {
        normalized = normalized.replace(pattern, replacement);
      }
    }

    return normalized.replace(/\/+$/, "");
  }

  async proxyReasoningRequest(event, payload = {}) {
    if (this.shuttingDown) {
      return {
        success: false,
        error: "Application is shutting down",
        code: "ERR_APP_SHUTTING_DOWN",
      };
    }

    let safePayload;
    try {
      safePayload = sanitizeReasoningProxyPayload(payload);
    } catch (error) {
      return { success: false, error: error.message, code: error.code };
    }

    if (!safePayload.isModelsRequest) {
      const licenseGate = await this.checkLicenseGate();
      if (!licenseGate.allowed) {
        return this.buildLicenseDeniedResponse(licenseGate.status);
      }
    }

    if (safePayload.droppedHeaders && safePayload.droppedHeaders.length > 0) {
      debugLogger.warn("Reasoning proxy dropped disallowed headers", {
        requestId: safePayload.requestId,
        url: getLoggableReasoningProxyUrl(safePayload.url),
        droppedHeaders: safePayload.droppedHeaders,
      });
    }

    const controller = new AbortController();
    // Pass abort() without a reason string — Node/Electron's fetch rejects
    // with the raw reason value when one is supplied, which would make our
    // `error.name === "AbortError"` branch miss and the caller would see
    // `{ error: undefined, code: undefined }`. We keep the human-readable
    // reason in `abortReason` instead.
    let abortReason = null;
    const timeoutId = setTimeout(() => {
      abortReason = "timeout";
      controller.abort();
    }, MAX_REASONING_PROXY_DURATION_MS);

    const sender = event && event.sender ? event.sender : null;
    const senderId = sender && typeof sender.id === "number" ? sender.id : null;
    let onSenderDestroyed = null;
    const cancelActiveRequest = (reason) => {
      abortReason = reason || "cancelled";
      try {
        controller.abort();
      } catch {
        /* already aborted */
      }
    };

    // Register so cancelReasoningProxyRequest IPC can abort this in flight.
    // Scope the id to the renderer sender and request domain.  A renderer can
    // retry with the same id, but it must not replace an existing request.
    const requestKey = safePayload.requestId
      ? this.getOwnedOperationKey("reasoning-proxy", safePayload.requestId, senderId)
      : null;
    if (requestKey) {
      if (this.activeReasoningProxyControllers.has(requestKey)) {
        clearTimeout(timeoutId);
        cancelActiveRequest("duplicate_request_id");
        return {
          success: false,
          error: "request_in_progress",
          code: "ERR_REASONING_REQUEST_IN_PROGRESS",
        };
      }
      this.activeReasoningProxyControllers.set(requestKey, {
        senderId,
        requestId: safePayload.requestId,
        domain: "reasoning-proxy",
        sender,
        cancel: cancelActiveRequest,
        onSenderDestroyed: null,
      });

      if (sender && typeof sender.once === "function") {
        onSenderDestroyed = () => {
          cancelActiveRequest("renderer_destroyed");
          const tracked = this.activeReasoningProxyControllers.get(requestKey);
          if (tracked) {
            this.activeReasoningProxyControllers.delete(requestKey);
          }
        };
        const tracked = this.activeReasoningProxyControllers.get(requestKey);
        if (tracked) tracked.onSenderDestroyed = onSenderDestroyed;
        sender.once("destroyed", onSenderDestroyed);
      }
    }

    try {
      const response = await fetch(safePayload.url, {
        method: safePayload.method,
        headers: safePayload.headers,
        body: safePayload.body,
        signal: controller.signal,
        redirect: "error",
      });

      const headers = Object.fromEntries(response.headers.entries());

      if (!safePayload.stream) {
        const body = await response.text();
        if (Buffer.byteLength(body) > MAX_REASONING_PROXY_RESPONSE_BYTES) {
          throw new Error("reasoning proxy response exceeds 4MB limit");
        }
        return {
          success: true,
          status: response.status,
          statusText: response.statusText,
          headers,
          body,
        };
      }

      if (!response.body) {
        throw new Error("reasoning proxy response has no body");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let body = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          body += chunk;
          if (Buffer.byteLength(body) > MAX_REASONING_PROXY_RESPONSE_BYTES) {
            throw new Error("reasoning proxy response exceeds 4MB limit");
          }
          if (!event.sender.isDestroyed()) {
            event.sender.send("reasoning-proxy-chunk", {
              requestId: safePayload.requestId,
              chunk,
            });
          }
        }

        const tail = decoder.decode();
        if (tail) {
          body += tail;
          if (!event.sender.isDestroyed()) {
            event.sender.send("reasoning-proxy-chunk", {
              requestId: safePayload.requestId,
              chunk: tail,
            });
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* reader already released */
        }
      }

      return {
        success: true,
        status: response.status,
        statusText: response.statusText,
        headers,
        body,
      };
    } catch (error) {
      // Normalize: fetch implementations may reject with non-Error values
      // (e.g. AbortController.abort(reason) propagates `reason` as-is).
      const errObj =
        error instanceof Error
          ? error
          : new Error(typeof error === "string" ? error : "reasoning proxy request failed");
      const isAbort =
        abortReason !== null || errObj.name === "AbortError" || errObj.code === "ABORT_ERR";

      let message;
      let code = errObj.code || errObj.name;
      if (isAbort) {
        if (abortReason && abortReason !== "timeout") {
          message = `reasoning proxy cancelled (${abortReason})`;
          code = "ERR_REASONING_PROXY_CANCELLED";
        } else {
          message = `reasoning proxy timed out after ${Math.round(
            MAX_REASONING_PROXY_DURATION_MS / 1000
          )}s`;
          code = "ERR_REASONING_PROXY_TIMEOUT";
        }
      } else {
        message = errObj.message || "reasoning proxy request failed";
      }
      return { success: false, error: message, code };
    } finally {
      clearTimeout(timeoutId);
      if (sender && onSenderDestroyed && typeof sender.removeListener === "function") {
        sender.removeListener("destroyed", onSenderDestroyed);
      }
      if (requestKey) {
        const tracked = this.activeReasoningProxyControllers.get(requestKey);
        if (tracked?.cancel === cancelActiveRequest) {
          this.activeReasoningProxyControllers.delete(requestKey);
        }
      }
    }
  }

  cancelReasoningProxyRequest(event, payload = {}) {
    const requestId =
      payload && typeof payload === "object" && typeof payload.requestId === "string"
        ? payload.requestId.trim()
        : "";
    if (!requestId) return { success: false, error: "missing_request_id" };
    const senderId = this.getSenderId(event?.sender);
    const proxyKey = this.getOwnedOperationKey("reasoning-proxy", requestId, senderId);
    const entry = this.activeReasoningProxyControllers.get(proxyKey);
    if (!entry) return { success: false, error: "not_found" };

    // Bind cancel to the sender that started the request so a different
    // renderer context cannot cancel an unrelated in-flight proxy call if it
    // somehow learns the request id.
    const callerSenderId = senderId;
    if (entry.senderId !== null && callerSenderId !== entry.senderId) {
      debugLogger.warn("Reasoning proxy cancel rejected: sender mismatch", {
        requestId,
        callerSenderId,
        ownerSenderId: entry.senderId,
      });
      return { success: false, error: "sender_mismatch" };
    }

    entry.cancel("renderer_cancel");
    return { success: true };
  }

  trackCancellableReasoningTask(event, requestId, controller) {
    const normalizedRequestId = String(requestId || "").trim();
    if (!normalizedRequestId) return () => {};

    const sender = event?.sender;
    const senderId = typeof sender?.id === "number" ? sender.id : null;
    const cancel = () => {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    };
    let key = null;
    const onSenderDestroyed = () => {
      cancel();
      if (key) {
        const tracked = this.activeReasoningProxyControllers.get(key);
        if (tracked?.cancel === cancel) {
          this.activeReasoningProxyControllers.delete(key);
        }
      }
    };

    key = this.getOwnedOperationKey("local-reasoning", normalizedRequestId, senderId);
    const existing = this.activeReasoningProxyControllers.get(key);
    if (existing) {
      // Keep the first request registered and cancel this duplicate.  This
      // preserves the existing handler contract while preventing map overwrite
      // and wrong-request cancellation.
      cancel("duplicate_request_id");
      debugLogger.warn("Duplicate cancellable reasoning request rejected", {
        requestId: normalizedRequestId,
        senderId,
      });
      return () => {};
    }

    this.activeReasoningProxyControllers.set(key, {
      senderId,
      requestId: normalizedRequestId,
      domain: "local-reasoning",
      sender,
      cancel,
      onSenderDestroyed,
    });
    sender?.once?.("destroyed", onSenderDestroyed);

    return () => {
      sender?.removeListener?.("destroyed", onSenderDestroyed);
      const tracked = this.activeReasoningProxyControllers.get(key);
      if (tracked?.cancel === cancel) {
        this.activeReasoningProxyControllers.delete(key);
      }
    };
  }

  getCloudTranscriptionTestConfig(provider, apiKeyOverride, endpointOverride) {
    const normalizedProvider = String(provider || "").trim();
    let apiKey = String(apiKeyOverride || "").trim();

    if (normalizedProvider === "openai") {
      if (!apiKey) {
        apiKey = String(this.environmentManager.getOpenAIKey() || "").trim();
      }
      return {
        provider: normalizedProvider,
        apiKey,
        endpoint: "https://api.openai.com/v1/audio/transcriptions",
        defaultModel: "gpt-4o-mini-transcribe",
      };
    }

    if (normalizedProvider === "groq") {
      if (!apiKey) {
        apiKey = String(this.environmentManager.getGroqKey() || "").trim();
      }
      return {
        provider: normalizedProvider,
        apiKey,
        endpoint: "https://api.groq.com/openai/v1/audio/transcriptions",
        defaultModel: "whisper-large-v3-turbo",
      };
    }

    if (normalizedProvider === "custom") {
      if (!apiKey) {
        apiKey = String(this.environmentManager.getCustomTranscriptionKey() || "").trim();
      }

      const baseUrl = this.normalizeOpenAiCompatibleBaseUrl(endpointOverride);
      if (!baseUrl) {
        throw new Error("Custom endpoint URL not configured");
      }

      return {
        provider: normalizedProvider,
        apiKey,
        endpoint: `${baseUrl}/audio/transcriptions`,
        defaultModel: "",
      };
    }

    throw new Error(`Unsupported transcription provider: ${normalizedProvider}`);
  }

  async testCloudTranscriptionConnection({ provider, apiKey, model, endpoint }) {
    const config = this.getCloudTranscriptionTestConfig(provider, apiKey, endpoint);

    if (!config.apiKey && config.provider !== "custom") {
      throw new Error(`${config.provider === "openai" ? "OpenAI" : "Groq"} API key not configured`);
    }

    const headers = {};
    if (config.apiKey) {
      headers.Authorization = `Bearer ${config.apiKey}`;
    }

    const resolvedModel = String(model || config.defaultModel || "").trim();
    if (!resolvedModel) {
      throw new Error("Transcription model not configured");
    }

    // Exercise the endpoint customers will actually use. A valid one-second
    // PCM WAV keeps the request tiny while catching model, auth, multipart,
    // and /audio/transcriptions compatibility problems that GET /models misses.
    const sampleRate = 16000;
    const sampleCount = sampleRate;
    const audioDataBytes = sampleCount * 2;
    const wav = Buffer.alloc(44 + audioDataBytes);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(36 + audioDataBytes, 4);
    wav.write("WAVE", 8);
    wav.write("fmt ", 12);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(sampleRate * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(audioDataBytes, 40);

    const formData = new FormData();
    formData.append("file", new Blob([wav], { type: "audio/wav" }), "connection-test.wav");
    formData.append("model", resolvedModel);
    formData.append("response_format", "json");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await fetch(config.endpoint, {
        method: "POST",
        headers,
        body: formData,
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error("Transcription connection test timed out after 15s");
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    const rawText = await response.text();
    let parsed = null;

    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const message =
        parsed?.error?.message ||
        parsed?.message ||
        rawText ||
        `${config.provider} API error: ${response.status}`;
      throw new Error(message);
    }

    return {
      success: true,
      provider: config.provider,
      modelFound: true,
      model: resolvedModel,
    };
  }

  _syncStartupEnv(setVars, clearVars = []) {
    let changed = false;
    for (const [key, value] of Object.entries(setVars)) {
      if (process.env[key] !== value) {
        process.env[key] = value;
        changed = true;
      }
    }
    for (const key of clearVars) {
      if (process.env[key]) {
        delete process.env[key];
        changed = true;
      }
    }
    if (changed) {
      debugLogger.debug("Synced startup env vars", {
        set: Object.keys(setVars),
        cleared: clearVars.filter((k) => !process.env[k]),
      });
      this.environmentManager.saveAllKeysToEnvFile().catch(() => {});
    }
  }

  _broadcastToRendererWindows(channel, payload) {
    const seenWebContents = new Set();
    const targets = [this.windowManager?.mainWindow, this.windowManager?.controlPanelWindow];

    for (const target of targets) {
      if (!target || target.isDestroyed?.()) {
        continue;
      }

      const webContentsId = target.webContents?.id;
      if (!webContentsId || seenWebContents.has(webContentsId)) {
        continue;
      }

      seenWebContents.add(webContentsId);
      target.webContents.send(channel, payload);
    }
  }

  _signOnboardingDictationEvent(payload) {
    return crypto
      .createHmac("sha256", this.onboardingDictationSecret)
      .update(
        JSON.stringify({
          id: payload.id,
          issuedAt: payload.issuedAt,
          previewText: payload.previewText,
          durationMs: payload.durationMs,
          recognitionDurationMs: payload.recognitionDurationMs,
        })
      )
      .digest("hex");
  }

  _buildOnboardingDictationEvent({
    previewText = "",
    durationMs = null,
    recognitionDurationMs = null,
  } = {}) {
    const safePreviewText = String(previewText || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 280);
    const safeDurationMs =
      Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs) : null;
    const safeRecognitionDurationMs =
      Number.isFinite(recognitionDurationMs) && recognitionDurationMs >= 0
        ? Math.round(recognitionDurationMs)
        : null;
    const payload = {
      id: crypto.randomUUID(),
      issuedAt: Date.now(),
      previewText: safePreviewText,
      durationMs: safeDurationMs,
      recognitionDurationMs: safeRecognitionDurationMs,
    };

    return {
      ...payload,
      signature: this._signOnboardingDictationEvent(payload),
    };
  }

  _sanitizeOnboardingStatePatch(patch = {}) {
    if (!patch || typeof patch !== "object") {
      return {};
    }

    const sanitized = {};

    if (Number.isFinite(patch.flowVersion)) {
      sanitized.flowVersion = Math.max(0, Math.trunc(Number(patch.flowVersion)));
    }

    if (Number.isFinite(patch.currentStep)) {
      sanitized.currentStep = Math.min(2, Math.max(0, Math.trunc(Number(patch.currentStep))));
    }

    if (typeof patch.uiLanguage === "string") {
      sanitized.uiLanguage = patch.uiLanguage.trim().slice(0, 32);
    }

    if (typeof patch.hasCompletedDictationTest === "boolean") {
      sanitized.hasCompletedDictationTest = patch.hasCompletedDictationTest;
    }

    if (typeof patch.activationStepSkipped === "boolean") {
      sanitized.activationStepSkipped = patch.activationStepSkipped;
    }

    if (typeof patch.completed === "boolean") {
      sanitized.completed = patch.completed;
    }

    if (patch.dictationDurationMs === null) {
      sanitized.dictationDurationMs = null;
    } else if (Number.isFinite(patch.dictationDurationMs) && patch.dictationDurationMs >= 0) {
      sanitized.dictationDurationMs = Math.round(Number(patch.dictationDurationMs));
    }

    if (patch.recognitionDurationMs === null) {
      sanitized.recognitionDurationMs = null;
    } else if (Number.isFinite(patch.recognitionDurationMs) && patch.recognitionDurationMs >= 0) {
      sanitized.recognitionDurationMs = Math.round(Number(patch.recognitionDurationMs));
    }

    if (
      typeof patch.activationStatus === "string" &&
      ["idle", "listening", "processing", "success"].includes(patch.activationStatus)
    ) {
      sanitized.activationStatus = patch.activationStatus;
    }

    return sanitized;
  }

  async _readOnboardingStateFile() {
    const { value, source } = await readJsonWithBackup(this.onboardingStatePath);
    if (value === null) {
      return null;
    }
    if (source && source !== this.onboardingStatePath) {
      debugLogger.warn(
        `Onboarding state recovered from backup (${source}); primary file was missing.`
      );
    }
    return this._sanitizeOnboardingStatePatch(value);
  }

  async _writeOnboardingStateFile(nextState) {
    await atomicWriteFile(this.onboardingStatePath, `${JSON.stringify(nextState, null, 2)}\n`, {
      backup: false,
      mode: 0o600,
    });
    await fsPromises.rm(`${this.onboardingStatePath}.bak`, { force: true });
    return nextState;
  }

  async _mergeOnboardingState(patch = {}) {
    const merge = async () => {
      const currentState = (await this._readOnboardingStateFile()) || {};
      const nextState = {
        ...currentState,
        ...this._sanitizeOnboardingStatePatch(patch),
        updatedAt: Date.now(),
      };
      return this._writeOnboardingStateFile(nextState);
    };

    const nextWrite = this.onboardingStateWriteQueue.then(merge, merge);
    this.onboardingStateWriteQueue = nextWrite.catch(() => {});
    return nextWrite;
  }

  async _clearOnboardingStateFile() {
    for (const statePath of [this.onboardingStatePath, `${this.onboardingStatePath}.bak`]) {
      try {
        await fsPromises.rm(statePath, { force: true });
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }

  setupHandlers() {
    // Window control handlers
    ipcMain.handle("window-minimize", () => {
      if (this.windowManager.controlPanelWindow) {
        this.windowManager.controlPanelWindow.minimize();
      }
    });

    ipcMain.handle("window-maximize", () => {
      if (this.windowManager.controlPanelWindow) {
        if (this.windowManager.controlPanelWindow.isMaximized()) {
          this.windowManager.controlPanelWindow.unmaximize();
        } else {
          this.windowManager.controlPanelWindow.maximize();
        }
      }
    });

    ipcMain.handle("window-close", () => {
      if (this.windowManager.controlPanelWindow) {
        this.windowManager.controlPanelWindow.close();
      }
    });

    ipcMain.handle("window-is-maximized", () => {
      if (this.windowManager.controlPanelWindow) {
        return this.windowManager.controlPanelWindow.isMaximized();
      }
      return false;
    });

    // Native glass capability detection
    ipcMain.handle("get-native-glass-capability", () => {
      const { detectCapability } = require("./nativeGlass");
      return detectCapability();
    });

    ipcMain.handle("app-quit", () => {
      app.quit();
    });

    ipcMain.handle("hide-window", () => {
      recordE2eEvent("hide-window");
      this.windowManager.hideDictationPanel();

      if (process.platform === "darwin") {
        const controlPanelWindow = this.windowManager?.controlPanelWindow;
        const isControlPanelVisible =
          controlPanelWindow && !controlPanelWindow.isDestroyed() && controlPanelWindow.isVisible();

        if (!isControlPanelVisible) {
          this.windowManager?.applyMacPresentationMode?.({ preferDock: false });
        }
      }
    });

    ipcMain.handle("show-dictation-panel", () => {
      this.windowManager.showDictationPanel({ focus: false });
    });

    ipcMain.on("local-storage-changed", (event, payload = {}) => {
      const key = typeof payload?.key === "string" ? payload.key : "";
      if (!key) {
        return;
      }
      this.broadcastToWindows("local-storage-changed", { key }, event.sender.id);
    });

    ipcMain.handle("open-control-panel-section", async (_event, section = "account") => {
      const safeSection = sanitizeControlPanelSection(section);
      await this.windowManager.createControlPanelWindow();
      if (
        this.windowManager.controlPanelWindow &&
        !this.windowManager.controlPanelWindow.isDestroyed()
      ) {
        this.windowManager.controlPanelWindow.webContents.send("open-settings-section", {
          section: safeSection,
        });
      }
      return { success: true };
    });

    ipcMain.handle("show-file-transcription-completion-alert", async (_event, payload = {}) => {
      try {
        const safePayload = sanitizeCompletionAlertPayload(payload);
        return await this.windowManager.showFileTranscriptionCompletionAlert(safePayload);
      } catch (error) {
        return {
          success: false,
          error: error?.message || "Invalid completion alert payload",
          code: error?.code || "ERR_COMPLETION_ALERT_INVALID",
        };
      }
    });

    ipcMain.handle("get-file-transcription-completion-alert", async () => {
      return this.windowManager.getCompletionAlertPayload();
    });

    ipcMain.handle("hide-file-transcription-completion-alert", async () => {
      this.windowManager.hideCompletionAlertWindow();
      return { success: true };
    });

    ipcMain.handle("open-transcription-history", async () => {
      await this.windowManager.createControlPanelWindow();
      if (
        this.windowManager.controlPanelWindow &&
        !this.windowManager.controlPanelWindow.isDestroyed()
      ) {
        this.windowManager.controlPanelWindow.webContents.send("open-transcription-history", {});
      }
      this.windowManager.hideCompletionAlertWindow();
      return { success: true };
    });

    ipcMain.handle("toggle-command-menu", async (_event, state = {}) => {
      return this.windowManager.toggleCommandMenuWindow(state || {});
    });

    ipcMain.handle("hide-command-menu", () => {
      this.windowManager.hideCommandMenuWindow();
      return { success: true };
    });

    ipcMain.handle("command-menu-start", async () => {
      this.windowManager.hideCommandMenuWindow();
      this.windowManager.showDictationPanel({ focus: false });
      this.windowManager.sendStartDictation("primary");
      return { success: true };
    });

    ipcMain.handle("command-menu-stop", async () => {
      this.windowManager.hideCommandMenuWindow();
      this.windowManager.sendStopDictation("primary");
      return { success: true };
    });

    ipcMain.handle("command-menu-hide-panel", async () => {
      this.windowManager.hideCommandMenuWindow();
      this.windowManager.hideDictationPanel();
      return { success: true };
    });

    ipcMain.handle("update-command-menu-state", (_event, state = {}) => {
      this.windowManager.syncCommandMenuState(state || {});
      return { success: true };
    });

    ipcMain.handle("test-hotkey-wake", async (_event, profileId = "primary") => {
      const callback = this.windowManager.createHotkeyCallback(
        profileId === "secondary" ? "secondary" : "primary"
      );
      await callback();
      return { success: true };
    });

    ipcMain.handle("force-stop-dictation", () => {
      if (this.windowManager?.forceStopMacCompoundPush) {
        this.windowManager.forceStopMacCompoundPush("manual");
      }
      return { success: true };
    });

    ipcMain.handle("set-main-window-interactivity", (event, shouldCapture, options) => {
      this.windowManager.setMainWindowInteractivity(Boolean(shouldCapture), options);
      return { success: true };
    });

    ipcMain.handle("resize-main-window", (event, sizeKeyOrSize) => {
      return this.windowManager.resizeMainWindow(sizeKeyOrSize);
    });

    ipcMain.on("dictation-ui-ready", (event, payload = {}) => {
      const mainWindow = this.windowManager?.mainWindow;
      if (
        !mainWindow ||
        mainWindow.isDestroyed() ||
        event.sender.id !== mainWindow.webContents.id
      ) {
        return;
      }
      this.windowManager.completeDictationUiPreparation(payload);
    });

    // Environment handlers
    ipcMain.handle("get-openai-key", async (_event, options) => {
      return this.environmentManager.getOpenAIKey({
        allowKeychain: allowKeychainAccess(options),
      });
    });

    ipcMain.handle("save-openai-key", async (event, key) => {
      return this.environmentManager.saveOpenAIKey(key);
    });

    ipcMain.handle("create-production-env-file", async (event, apiKey) => {
      return this.environmentManager.createProductionEnvFile(apiKey);
    });

    ipcMain.handle("db-save-transcription", async (event, text, metadata = {}) => {
      let safeText;
      try {
        safeText = toBoundedString(text, "transcription text", MAX_IPC_TRANSCRIPTION_TEXT_LENGTH);
      } catch (error) {
        return {
          success: false,
          error: error?.message || "Invalid transcription payload",
          code: error?.code || "ERR_IPC_TEXT_INVALID",
        };
      }
      const safeMetadata = metadata && typeof metadata === "object" ? metadata : {};
      if (E2E_MODE && process.env.CHORDVOX_E2E_STUB_SAVE_TRANSCRIPTION === "1") {
        recordE2eEvent("db-save-transcription", { text: safeText, metadata: safeMetadata });
        return {
          success: true,
          transcription: {
            id: 1,
            text: safeText,
            timestamp: new Date().toISOString(),
            ...safeMetadata,
          },
        };
      }
      const result = this.databaseManager.saveTranscription(safeText, safeMetadata);
      recordE2eEvent("db-save-transcription", { text: safeText, metadata: safeMetadata });
      if (result?.success && result?.transcription) {
        setImmediate(() => {
          this.broadcastToWindows("transcription-added", result.transcription);
        });
      }
      return result;
    });

    ipcMain.handle("db-get-transcriptions", async (event, limit = 50) => {
      try {
        const safeLimit = Math.round(
          toBoundedNumber(limit, "history limit", {
            min: 1,
            max: MAX_IPC_HISTORY_ITEMS,
            fallback: 50,
          })
        );
        return this.databaseManager.getTranscriptions(safeLimit);
      } catch (error) {
        debugLogger.error("Failed to load transcription history:", {
          error: error?.message || String(error),
        });
        return [];
      }
    });

    ipcMain.handle("db-search-transcriptions", async (event, query, limit) => {
      try {
        const safeQuery = String(query || "").slice(0, 200);
        const safeLimit = Math.floor(
          toBoundedNumber(limit, "search limit", {
            min: 1,
            max: MAX_IPC_HISTORY_ITEMS,
            fallback: 50,
          })
        );
        return this.databaseManager.searchTranscriptions(safeQuery, safeLimit);
      } catch (error) {
        debugLogger.error("Failed to search transcription history:", {
          error: error?.message || String(error),
        });
        return { items: [], truncated: false };
      }
    });

    ipcMain.handle("db-query-transcription-history", async (event, options = {}) => {
      if (this.shuttingDown) {
        return {
          items: [],
          hasMore: false,
          totalCount: 0,
          truncated: false,
          cancelled: true,
          error: "Application is shutting down",
        };
      }

      const senderId = Number(event?.sender?.id);
      const requestKey = String(options?.requestKey || "default")
        .replace(/[^a-zA-Z0-9:_-]/g, "")
        .slice(0, 64);
      const queryKey = `${senderId}:${requestKey || "default"}`;
      const queryVersion = (this.historyQueryVersions.get(queryKey) || 0) + 1;
      this.historyQueryVersions.set(queryKey, queryVersion);

      try {
        const safeQuery = String(options?.query || "").slice(0, 200);
        const safeLimit = Math.floor(
          toBoundedNumber(options?.limit, "history page limit", {
            min: 1,
            max: 200,
            fallback: 50,
          })
        );
        const safeOffset = Math.floor(
          toBoundedNumber(options?.offset, "history page offset", {
            min: 0,
            max: MAX_IPC_HISTORY_OFFSET,
            fallback: 0,
          })
        );
        const safeCursor =
          typeof options?.cursor === "string"
            ? options.cursor.trim().slice(0, MAX_IPC_HISTORY_CURSOR_LENGTH)
            : "";
        const parsedSince = options?.since ? new Date(String(options.since)) : null;
        const safeSince =
          parsedSince && !Number.isNaN(parsedSince.getTime()) ? parsedSince.toISOString() : null;

        return await this.databaseManager.queryTranscriptionHistory({
          query: safeQuery,
          limit: safeLimit,
          offset: safeOffset,
          cursor: safeCursor || null,
          favoriteOnly: options?.favoriteOnly === true,
          since: safeSince,
          shouldCancel: () =>
            event.sender.isDestroyed() || this.historyQueryVersions.get(queryKey) !== queryVersion,
        });
      } catch (error) {
        debugLogger.error("Failed to query transcription history:", {
          error: error?.message || String(error),
        });
        return {
          items: [],
          hasMore: false,
          totalCount: 0,
          truncated: false,
          cancelled: false,
          error: error?.message || String(error),
        };
      } finally {
        if (this.historyQueryVersions.get(queryKey) === queryVersion) {
          this.historyQueryVersions.delete(queryKey);
        }
      }
    });

    ipcMain.handle("db-get-transcription-stats", async () => {
      try {
        return this.databaseManager.getTranscriptionStats();
      } catch (error) {
        debugLogger.error("Failed to load transcription stats:", {
          error: error?.message || String(error),
        });
        return { ...EMPTY_TRANSCRIPTION_STATS };
      }
    });

    ipcMain.handle("db-clear-transcriptions", async (event) => {
      const result = this.databaseManager.clearTranscriptions();
      if (result?.success) {
        setImmediate(() => {
          this.broadcastToWindows("transcriptions-cleared", {
            cleared: result.cleared,
          });
        });
      }
      return result;
    });

    ipcMain.handle("db-delete-transcription", async (event, id) => {
      const result = this.databaseManager.deleteTranscription(id);
      if (result?.success) {
        setImmediate(() => {
          this.broadcastToWindows("transcription-deleted", { id });
        });
      }
      return result;
    });

    ipcMain.handle("db-set-transcription-favorite", async (event, id, favorite) => {
      const result = this.databaseManager.setTranscriptionFavorite(id, favorite);
      if (result?.success) {
        setImmediate(() => {
          this.broadcastToWindows("transcription-updated", {
            id,
            patch: { favorite: favorite ? 1 : 0 },
          });
        });
      }
      return result;
    });

    // Dictionary handlers
    ipcMain.handle("db-get-dictionary", async () => {
      return this.databaseManager.getDictionary();
    });

    ipcMain.handle("db-set-dictionary", async (event, words) => {
      if (!Array.isArray(words)) {
        throw new Error("words must be an array");
      }
      const sanitized = sanitizeDictionaryWords(words);
      return this.databaseManager.setDictionary(sanitized);
    });

    ipcMain.handle("track-onboarding-event", async (event, eventName) => {
      const normalized = normalizeOnboardingFunnelEventName(eventName);
      if (!normalized) {
        const displayName = typeof eventName === "string" ? eventName.trim() : "";
        return { success: false, error: `Unknown onboarding event: ${displayName || "(empty)"}` };
      }
      const result = this.databaseManager.trackOnboardingEvent(normalized);
      if (result?.recorded) {
        this.reportOnboardingFunnelEvent?.(normalized);
      }
      return result;
    });

    ipcMain.handle("get-onboarding-events", async () => {
      return this.databaseManager.getOnboardingEvents();
    });

    // Clipboard handlers
    ipcMain.handle("paste-text", async (event, text, options) => {
      let safeText;
      try {
        safeText = toBoundedString(text, "paste text", MAX_IPC_CLIPBOARD_TEXT_LENGTH);
      } catch (error) {
        return {
          success: false,
          error: {
            message: error?.message || "Invalid paste payload",
            code: error?.code || "ERR_IPC_TEXT_INVALID",
          },
        };
      }
      // Error-path stub: force a paste failure so E2E can assert the renderer's
      // paste-failure handling. The preload pasteText wrapper turns this
      // { success: false, error: {...} } envelope into a thrown Error, which
      // audioManager.safePaste catches and surfaces via onError({ code:
      // "PASTE_FAILED" }). Gated by E2E_MODE so it can never fire when packaged.
      if (E2E_MODE && process.env.CHORDVOX_E2E_STUB_PASTE_FAIL === "1") {
        recordE2eEvent("paste-text", {
          text: safeText,
          options: options && typeof options === "object" ? options : {},
          stub: "fail",
          success: false,
        });
        return {
          success: false,
          error: {
            message: "e2e_stub_paste_failure",
            code: "PASTE_FAILED",
          },
        };
      }

      if (E2E_MODE && process.env.CHORDVOX_E2E_STUB_PASTE === "1") {
        recordE2eEvent("paste-text", {
          text: safeText,
          options: options && typeof options === "object" ? options : {},
        });
        return { success: true };
      }
      // Hide the floating panel before paste when it may own the foreground so
      // the keystroke lands in the user's target app instead of the overlay.
      const mainWindow = this.windowManager?.mainWindow;
      if (shouldHideDictationWindowBeforePaste(mainWindow)) {
        mainWindow.hide();
        await new Promise((resolve) => setTimeout(resolve, 140));
      }
      try {
        await this.clipboardManager.pasteText(safeText, { ...options, webContents: event.sender });
        recordE2eEvent("paste-text", {
          text: safeText,
          options: options && typeof options === "object" ? options : {},
          success: true,
        });
        return { success: true };
      } catch (error) {
        recordE2eEvent("paste-text", {
          text: safeText,
          options: options && typeof options === "object" ? options : {},
          success: false,
          error: {
            message: error?.message || "Paste failed",
            code: error?.code || null,
          },
        });
        return {
          success: false,
          error: {
            message: error?.message || "Paste failed",
            code: error?.code || null,
            requiresAccessibilityPermission: error?.requiresAccessibilityPermission === true,
            handledBySystemDialog: error?.handledBySystemDialog === true,
            suppressRendererToast: error?.suppressRendererToast === true,
          },
        };
      }
    });

    ipcMain.handle("cancel-paste-text", async (_event, pasteRequestId) => {
      return this.clipboardManager.cancelPasteRequest(pasteRequestId);
    });

    ipcMain.handle("read-clipboard", async (event) => {
      return this.clipboardManager.readClipboard();
    });

    ipcMain.handle("write-clipboard", async (event, text) => {
      let safeText;
      try {
        safeText = toBoundedString(text, "clipboard text", MAX_IPC_CLIPBOARD_TEXT_LENGTH);
      } catch (error) {
        return {
          success: false,
          error: {
            message: error?.message || "Invalid clipboard payload",
            code: error?.code || "ERR_IPC_TEXT_INVALID",
          },
        };
      }
      return this.clipboardManager.writeClipboard(safeText, event.sender);
    });

    ipcMain.handle("check-paste-tools", async () => {
      return this.clipboardManager.checkPasteTools();
    });

    ipcMain.handle("check-accessibility-permission", async () => {
      return this.clipboardManager.checkAccessibilityPermissions({ showDialog: false });
    });

    ipcMain.handle("request-accessibility-permission", async () => {
      if (process.platform !== "darwin") {
        return { granted: true };
      }

      try {
        ipcMain.emit("mac-accessibility-prompt-state", null, true);
        const { systemPreferences } = require("electron");
        const granted = Boolean(systemPreferences.isTrustedAccessibilityClient(true));
        return { granted };
      } catch (error) {
        debugLogger.error("Failed to request accessibility permission:", error);
        return { granted: false, error: error?.message || "ACCESSIBILITY_PROMPT_FAILED" };
      } finally {
        ipcMain.emit("mac-accessibility-prompt-state", null, false);
      }
    });

    ipcMain.handle("get-onboarding-state", async () => {
      return this._readOnboardingStateFile();
    });

    ipcMain.handle("save-onboarding-state", async (_event, patch = {}) => {
      return this._mergeOnboardingState(patch);
    });

    ipcMain.handle("clear-onboarding-state", async () => {
      this.latestOnboardingDictationSuccess = null;
      await this._clearOnboardingStateFile();
      if (process.platform === "darwin") {
        ipcMain.emit("mac-native-hotkey-eligibility-changed", null, true);
      }
      return { success: true };
    });

    ipcMain.handle("emit-onboarding-dictation-success", async (_event, payload = {}) => {
      const successEvent = this._buildOnboardingDictationEvent({
        previewText: payload?.text,
        durationMs: payload?.durationMs,
        recognitionDurationMs: payload?.recognitionDurationMs,
      });

      this.latestOnboardingDictationSuccess = successEvent;
      this._broadcastToRendererWindows("onboarding-dictation-success", successEvent);
      await this._mergeOnboardingState({
        hasCompletedDictationTest: true,
        dictationDurationMs: successEvent.durationMs,
        recognitionDurationMs: successEvent.recognitionDurationMs,
        activationStatus: "success",
      });

      return { success: true, event: successEvent };
    });

    ipcMain.handle("consume-onboarding-dictation-success", async () => {
      return this.latestOnboardingDictationSuccess;
    });

    ipcMain.on("onboarding-audio-level", (_event, payload = {}) => {
      const numericLevel = Number(payload?.level);
      const safeLevel = Number.isFinite(numericLevel) ? Math.max(0, Math.min(1, numericLevel)) : 0;
      const safeMicState =
        typeof payload?.micState === "string" ? payload.micState.slice(0, 24) : undefined;

      this._broadcastToRendererWindows("onboarding-audio-level", {
        level: safeLevel,
        active: payload?.active === true,
        micState: safeMicState,
        issuedAt: Date.now(),
      });
    });

    ipcMain.handle("cancel-file-transcription", async (event, operationId) => {
      try {
        return await this.cancelFileTranscription(event, operationId);
      } catch (error) {
        debugLogger.warn("Failed to cancel file transcription", {
          operationId: normalizeOperationId(operationId),
          error: error.message,
        });
        return {
          success: false,
          error: error.code || "cancel_failed",
          message: error.message || "Failed to cancel file transcription",
        };
      }
    });

    ipcMain.handle("acquire-transcription-lease", (event, payload = {}) => {
      return this.acquireTranscriptionLease(event, payload);
    });

    ipcMain.handle("release-transcription-lease", (event, leaseId) => {
      return this.releaseTranscriptionLease(event, leaseId);
    });

    // Whisper handlers
    ipcMain.handle("transcribe-local-whisper", async (event, audioBlob, options = {}) => {
      if (this.shuttingDown) {
        return { success: false, error: "ERR_APP_SHUTTING_DOWN" };
      }
      try {
        toBoundedAudioBuffer(audioBlob, "Whisper audio buffer");
      } catch (error) {
        return { success: false, error: error.code || "invalid_audio", message: error.message };
      }
      debugLogger.log("transcribe-local-whisper called", {
        audioBlobType: typeof audioBlob,
        audioBlobSize: audioBlob?.byteLength || audioBlob?.length || 0,
        options,
      });

      // Error-path stub: force a transcription failure so E2E can assert the
      // renderer's failure handling (audioManager rethrows -> onError ->
      // triggerErrorFeedback). Mirrors the real failure envelope
      // ({ success: false, error: <string> }). Gated by E2E_MODE so it can never
      // fire in a packaged build.
      if (E2E_MODE && process.env.CHORDVOX_E2E_STUB_TRANSCRIPTION_FAIL === "1") {
        recordE2eEvent("transcribe-local-whisper", {
          audioSizeBytes: audioBlob?.byteLength || audioBlob?.length || 0,
          options: options && typeof options === "object" ? options : {},
          stub: "fail",
          success: false,
        });
        return { success: false, error: "e2e_stub_transcription_failure" };
      }

      if (E2E_MODE && process.env.CHORDVOX_E2E_STUB_TRANSCRIPTION === "1") {
        recordE2eEvent("transcribe-local-whisper", {
          audioSizeBytes: audioBlob?.byteLength || audioBlob?.length || 0,
          options: options && typeof options === "object" ? options : {},
        });
        return {
          success: true,
          text: E2E_STUB_TRANSCRIPTION_TEXT,
          source: "local",
          timings: {
            transcriptionProcessingDurationMs: 1,
            reasoningProcessingDurationMs: 0,
          },
        };
      }

      const abortController = new AbortController();
      const unregister = this.registerFileTranscription(
        options?.operationId,
        "whisper",
        () => abortController.abort(),
        event.sender
      );
      try {
        const result = await this.whisperManager.transcribeLocalWhisper(audioBlob, {
          ...options,
          signal: abortController.signal,
        });
        recordE2eEvent("transcribe-local-whisper", {
          audioSizeBytes: audioBlob?.byteLength || audioBlob?.length || 0,
          options: options && typeof options === "object" ? options : {},
          success: result?.success === true,
          hasText: typeof result?.text === "string" && result.text.trim().length > 0,
          text: result?.text || "",
          error: result?.error || null,
          message: result?.message || null,
        });

        debugLogger.log("Whisper result", {
          success: result.success,
          hasText: !!result.text,
          message: result.message,
          error: result.error,
        });

        // Check if no audio was detected and send appropriate event
        if (!result.success && result.message === "No audio detected") {
          debugLogger.log("Sending no-audio-detected event to renderer");
          event.sender.send("no-audio-detected");
        }

        return result;
      } catch (error) {
        debugLogger.error("Local Whisper transcription error", error);
        const errorMessage = error.message || "Unknown error";

        // Return specific error types for better user feedback
        if (errorMessage.includes("FFmpeg not found")) {
          return {
            success: false,
            error: "ffmpeg_not_found",
            message: "FFmpeg is missing. Please reinstall the app or install FFmpeg manually.",
          };
        }
        if (
          errorMessage.includes("FFmpeg conversion failed") ||
          errorMessage.includes("FFmpeg process error")
        ) {
          return {
            success: false,
            error: "ffmpeg_error",
            message: "Audio conversion failed. The recording may be corrupted.",
          };
        }
        if (
          errorMessage.includes("whisper.cpp not found") ||
          errorMessage.includes("whisper-cpp")
        ) {
          return {
            success: false,
            error: "whisper_not_found",
            message: "Whisper binary is missing. Please reinstall the app.",
          };
        }
        if (
          errorMessage.includes("Audio buffer is empty") ||
          errorMessage.includes("Audio data too small")
        ) {
          return {
            success: false,
            error: "no_audio_data",
            message: "No audio detected",
          };
        }
        if (
          (errorMessage.includes("model") && errorMessage.includes("not downloaded")) ||
          errorMessage.includes("model directory not found or invalid")
        ) {
          return {
            success: false,
            error: "model_not_found",
            message: errorMessage,
          };
        }

        throw error;
      } finally {
        unregister();
      }
    });

    ipcMain.handle("transcribe-local-whisper-file", async (event, filePath, options = {}) => {
      if (this.shuttingDown) {
        return { success: false, error: "ERR_APP_SHUTTING_DOWN" };
      }
      const validation = await validateReadableAudioFilePath(filePath);
      if (!validation.ok) return validation.response;

      debugLogger.log("transcribe-local-whisper-file called", {
        sourceFilePath: validation.filePath,
        options,
      });

      const abortController = new AbortController();
      const unregister = this.registerFileTranscription(
        options?.operationId,
        "whisper",
        () => abortController.abort(),
        event.sender
      );
      try {
        const result = await this.whisperManager.transcribeLocalWhisperFile(validation.filePath, {
          ...options,
          signal: abortController.signal,
        });

        debugLogger.log("Whisper file result", {
          success: result.success,
          hasText: !!result.text,
          message: result.message,
          error: result.error,
        });

        if (!result.success && result.message === "No audio detected") {
          debugLogger.log("Sending no-audio-detected event to renderer");
          event.sender.send("no-audio-detected");
        }

        return result;
      } catch (error) {
        debugLogger.error("Local Whisper file transcription error", error);
        const errorMessage = error.message || "Unknown error";

        if (errorMessage.includes("FFmpeg not found")) {
          return {
            success: false,
            error: "ffmpeg_not_found",
            message: "FFmpeg is missing. Please reinstall the app or install FFmpeg manually.",
          };
        }
        if (
          errorMessage.includes("FFmpeg conversion failed") ||
          errorMessage.includes("FFmpeg process error") ||
          errorMessage.includes("FFmpeg exited")
        ) {
          return {
            success: false,
            error: "ffmpeg_error",
            message: "Audio conversion failed. The selected file may be corrupted.",
          };
        }
        if (
          errorMessage.includes("whisper.cpp not found") ||
          errorMessage.includes("whisper-cpp") ||
          errorMessage.includes("whisper-server binary not found")
        ) {
          return {
            success: false,
            error: "whisper_not_found",
            message: "Whisper binary is missing. Please reinstall the app.",
          };
        }
        if (
          (errorMessage.includes("model") && errorMessage.includes("not downloaded")) ||
          errorMessage.includes("model file not found")
        ) {
          return {
            success: false,
            error: "model_not_found",
            message: errorMessage,
          };
        }

        return {
          success: false,
          error: error.code || "WHISPER_FILE_TRANSCRIPTION_FAILED",
          message: errorMessage,
        };
      } finally {
        unregister();
      }
    });

    ipcMain.handle("check-whisper-installation", async (event) => {
      return this.whisperManager.checkWhisperInstallation();
    });

    ipcMain.handle("get-audio-diagnostics", async () => {
      return this.whisperManager.getDiagnostics();
    });

    ipcMain.handle("download-whisper-model", async (event, payload) => {
      const { modelName, options } = normalizeModelDownloadRequest(payload);
      try {
        const result = await this.whisperManager.downloadWhisperModel(
          modelName,
          (progressData) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send("whisper-download-progress", progressData);
            }
          },
          options
        );
        return result;
      } catch (error) {
        const customerError = getCustomerDownloadError(error);
        if (!event.sender.isDestroyed()) {
          event.sender.send("whisper-download-progress", {
            type: "error",
            model: modelName,
            error: customerError.message,
            code: customerError.code,
            manualDownloadUrl: customerError.manualDownloadUrl,
            source_count: customerError.sources?.length,
          });
        }
        return {
          success: false,
          error: customerError.message,
          code: customerError.code,
          manualDownloadUrl: customerError.manualDownloadUrl,
          sources: customerError.sources,
        };
      }
    });

    ipcMain.handle("check-model-status", async (event, modelName) => {
      // Stubbed transcription E2E runs do not need a real Whisper artifact.
      // Report the selected model as available so the advisory preflight does
      // not replace the nebula completion surface with a model-download notice.
      if (E2E_MODE && process.env.CHORDVOX_E2E_STUB_TRANSCRIPTION === "1") {
        return { success: true, downloaded: true, model: modelName };
      }
      return this.whisperManager.checkModelStatus(modelName);
    });

    ipcMain.handle("list-whisper-models", async (event) => {
      return this.whisperManager.listWhisperModels();
    });

    ipcMain.handle("delete-whisper-model", async (event, modelName) => {
      return this.whisperManager.deleteWhisperModel(modelName);
    });

    ipcMain.handle("delete-all-whisper-models", async () => {
      return this.whisperManager.deleteAllWhisperModels();
    });

    ipcMain.handle("cancel-whisper-download", async (event) => {
      return this.whisperManager.cancelDownload();
    });

    // Whisper server handlers (for faster repeated transcriptions)
    ipcMain.handle("whisper-server-start", async (event, modelName) => {
      return this.whisperManager.startServer(modelName);
    });

    ipcMain.handle("whisper-server-stop", async () => {
      return this.whisperManager.stopServer();
    });

    ipcMain.handle("whisper-server-status", async () => {
      return this.whisperManager.getServerStatus();
    });

    ipcMain.handle("check-ffmpeg-availability", async (event) => {
      return this.whisperManager.checkFFmpegAvailability();
    });

    // Parakeet (NVIDIA) handlers
    ipcMain.handle("transcribe-local-parakeet", async (event, audioBlob, options = {}) => {
      if (this.shuttingDown) {
        return { success: false, error: "ERR_APP_SHUTTING_DOWN" };
      }
      try {
        toBoundedAudioBuffer(audioBlob, "Parakeet audio buffer");
      } catch (error) {
        return { success: false, error: error.code || "invalid_audio", message: error.message };
      }
      debugLogger.log("transcribe-local-parakeet called", {
        audioBlobType: typeof audioBlob,
        audioBlobSize: audioBlob?.byteLength || audioBlob?.length || 0,
        options,
      });

      const abortController = new AbortController();
      const unregister = this.registerFileTranscription(
        options?.operationId,
        "parakeet",
        () => abortController.abort(),
        event.sender
      );
      try {
        const result = await this.parakeetManager.transcribeLocalParakeet(audioBlob, {
          ...options,
          signal: abortController.signal,
        });

        debugLogger.log("Parakeet result", {
          success: result.success,
          hasText: !!result.text,
          message: result.message,
          error: result.error,
        });

        if (!result.success && result.message === "No audio detected") {
          debugLogger.log("Sending no-audio-detected event to renderer");
          event.sender.send("no-audio-detected");
        }

        return result;
      } catch (error) {
        debugLogger.error("Local Parakeet transcription error", error);
        const errorMessage = error.message || "Unknown error";

        if (errorMessage.includes("sherpa-onnx") && errorMessage.includes("not found")) {
          return {
            success: false,
            error: "parakeet_not_found",
            message: "Parakeet binary is missing. Please reinstall the app.",
          };
        }
        if (errorMessage.includes("model") && errorMessage.includes("not downloaded")) {
          return {
            success: false,
            error: "model_not_found",
            message: errorMessage,
          };
        }

        throw error;
      } finally {
        unregister();
      }
    });

    ipcMain.handle("transcribe-local-parakeet-file", async (event, filePath, options = {}) => {
      if (this.shuttingDown) {
        return { success: false, error: "ERR_APP_SHUTTING_DOWN" };
      }
      const validation = await validateReadableAudioFilePath(filePath);
      if (!validation.ok) return validation.response;

      debugLogger.log("transcribe-local-parakeet-file called", {
        sourceFilePath: validation.filePath,
        options,
      });

      const abortController = new AbortController();
      const unregister = this.registerFileTranscription(
        options?.operationId,
        "parakeet",
        () => abortController.abort(),
        event.sender
      );
      try {
        const result = await this.parakeetManager.transcribeLocalParakeetFile(validation.filePath, {
          ...options,
          signal: abortController.signal,
        });

        debugLogger.log("Parakeet file result", {
          success: result.success,
          hasText: !!result.text,
          message: result.message,
          error: result.error,
        });

        if (!result.success && result.message === "No audio detected") {
          debugLogger.log("Sending no-audio-detected event to renderer");
          event.sender.send("no-audio-detected");
        }

        return result;
      } catch (error) {
        debugLogger.error("Local Parakeet file transcription error", error);
        const errorMessage = error.message || "Unknown error";

        if (errorMessage.includes("sherpa-onnx") && errorMessage.includes("not found")) {
          return {
            success: false,
            error: "parakeet_not_found",
            message: "Parakeet binary is missing. Please reinstall the app.",
          };
        }
        if (errorMessage.includes("model") && errorMessage.includes("not downloaded")) {
          return {
            success: false,
            error: "model_not_found",
            message: errorMessage,
          };
        }
        if (
          errorMessage.includes("FFmpeg exited") ||
          errorMessage.includes("FFmpeg process error") ||
          errorMessage.includes("conversion")
        ) {
          return {
            success: false,
            error: "ffmpeg_error",
            message: "Audio conversion failed. The selected file may be corrupted.",
          };
        }

        return {
          success: false,
          error: error.code || "PARAKEET_FILE_TRANSCRIPTION_FAILED",
          message: errorMessage,
        };
      } finally {
        unregister();
      }
    });

    ipcMain.handle("check-parakeet-installation", async () => {
      return this.parakeetManager.checkInstallation();
    });

    ipcMain.handle("download-parakeet-model", async (event, payload) => {
      const { modelName, options } = normalizeModelDownloadRequest(payload);
      try {
        const result = await this.parakeetManager.downloadParakeetModel(
          modelName,
          (progressData) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send("parakeet-download-progress", progressData);
            }
          },
          options
        );
        return result;
      } catch (error) {
        const customerError = getCustomerDownloadError(error);
        if (!event.sender.isDestroyed()) {
          event.sender.send("parakeet-download-progress", {
            type: "error",
            model: modelName,
            error: customerError.message,
            code: customerError.code,
            manualDownloadUrl: customerError.manualDownloadUrl,
            source_count: customerError.sources?.length,
          });
        }
        return {
          success: false,
          error: customerError.message,
          code: customerError.code,
          manualDownloadUrl: customerError.manualDownloadUrl,
          sources: customerError.sources,
        };
      }
    });

    ipcMain.handle("check-parakeet-model-status", async (_event, modelName) => {
      return this.parakeetManager.checkModelStatus(modelName);
    });

    ipcMain.handle("list-parakeet-models", async () => {
      return this.parakeetManager.listParakeetModels();
    });

    ipcMain.handle("delete-parakeet-model", async (_event, modelName) => {
      return this.parakeetManager.deleteParakeetModel(modelName);
    });

    ipcMain.handle("delete-all-parakeet-models", async () => {
      return this.parakeetManager.deleteAllParakeetModels();
    });

    ipcMain.handle("cancel-parakeet-download", async () => {
      return this.parakeetManager.cancelDownload();
    });

    ipcMain.handle("get-parakeet-diagnostics", async () => {
      return this.parakeetManager.getDiagnostics();
    });

    // Parakeet server handlers (for faster repeated transcriptions)
    ipcMain.handle("parakeet-server-start", async (event, modelName) => {
      try {
        const result = await this.parakeetManager.startServer(modelName);
        if (result?.success) {
          process.env.LOCAL_TRANSCRIPTION_PROVIDER = "nvidia";
          process.env.PARAKEET_MODEL = modelName;
          await this.environmentManager.saveAllKeysToEnvFile();
        }
        return result;
      } catch (error) {
        debugLogger.error("Failed to start Parakeet server", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("parakeet-server-stop", async () => {
      try {
        const result = await this.parakeetManager.stopServer();
        delete process.env.LOCAL_TRANSCRIPTION_PROVIDER;
        delete process.env.PARAKEET_MODEL;
        await this.environmentManager.saveAllKeysToEnvFile();
        return result;
      } catch (error) {
        debugLogger.error("Failed to stop Parakeet server", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("parakeet-server-status", async () => {
      return this.parakeetManager.getServerStatus();
    });

    // Paraformer handlers
    ipcMain.handle("transcribe-local-paraformer", async (event, audioBlob, options = {}) => {
      if (this.shuttingDown) {
        return { success: false, error: "ERR_APP_SHUTTING_DOWN" };
      }
      try {
        toBoundedAudioBuffer(audioBlob, "Paraformer audio buffer");
      } catch (error) {
        return { success: false, error: error.code || "invalid_audio", message: error.message };
      }
      debugLogger.log("transcribe-local-paraformer called", {
        audioBlobType: typeof audioBlob,
        audioBlobSize: audioBlob?.byteLength || audioBlob?.length || 0,
        options,
      });

      const abortController = new AbortController();
      const unregister = this.registerFileTranscription(
        options?.operationId,
        "paraformer",
        () => abortController.abort(),
        event.sender
      );
      try {
        const result = await this.paraformerManager.transcribeLocalParaformer(audioBlob, {
          ...options,
          signal: abortController.signal,
        });

        debugLogger.log("Paraformer result", {
          success: result.success,
          hasText: !!result.text,
          message: result.message,
          error: result.error,
        });

        if (!result.success && result.message === "No audio detected") {
          debugLogger.log("Sending no-audio-detected event to renderer");
          event.sender.send("no-audio-detected");
        }

        return result;
      } catch (error) {
        debugLogger.error("Local Paraformer transcription error", error);
        const errorMessage = error.message || "Unknown error";

        if (errorMessage.includes("sherpa-onnx") && errorMessage.includes("not found")) {
          return {
            success: false,
            error: "paraformer_not_found",
            message: "Paraformer binary is missing. Please reinstall the app.",
          };
        }
        if (errorMessage.includes("model") && errorMessage.includes("not downloaded")) {
          return {
            success: false,
            error: "model_not_found",
            message: errorMessage,
          };
        }

        throw error;
      } finally {
        unregister();
      }
    });

    ipcMain.handle("transcribe-local-paraformer-file", async (event, filePath, options = {}) => {
      if (this.shuttingDown) {
        return { success: false, error: "ERR_APP_SHUTTING_DOWN" };
      }
      const validation = await validateReadableAudioFilePath(filePath);
      if (!validation.ok) return validation.response;

      debugLogger.log("transcribe-local-paraformer-file called", {
        sourceFilePath: validation.filePath,
        options,
      });

      const abortController = new AbortController();
      const unregister = this.registerFileTranscription(
        options?.operationId,
        "paraformer",
        () => abortController.abort(),
        event.sender
      );
      try {
        const result = await this.paraformerManager.transcribeLocalParaformerFile(
          validation.filePath,
          { ...options, signal: abortController.signal }
        );

        debugLogger.log("Paraformer file result", {
          success: result.success,
          hasText: !!result.text,
          message: result.message,
          error: result.error,
        });

        if (!result.success && result.message === "No audio detected") {
          debugLogger.log("Sending no-audio-detected event to renderer");
          event.sender.send("no-audio-detected");
        }

        return result;
      } catch (error) {
        debugLogger.error("Local Paraformer file transcription error", error);
        const errorMessage = error.message || "Unknown error";

        if (errorMessage.includes("FFmpeg not found")) {
          return {
            success: false,
            error: "ffmpeg_not_found",
            message: "FFmpeg is missing. Please reinstall the app or install FFmpeg manually.",
          };
        }

        if (
          errorMessage.includes("FFmpeg exited") ||
          errorMessage.includes("FFmpeg process error") ||
          errorMessage.includes("conversion")
        ) {
          return {
            success: false,
            error: "ffmpeg_error",
            message: "Audio conversion failed. The selected file may be corrupted.",
          };
        }

        if (errorMessage.includes("sherpa-onnx") && errorMessage.includes("not found")) {
          return {
            success: false,
            error: "paraformer_not_found",
            message: "Paraformer binary is missing. Please reinstall the app.",
          };
        }
        if (errorMessage.includes("model") && errorMessage.includes("not downloaded")) {
          return {
            success: false,
            error: "model_not_found",
            message: errorMessage,
          };
        }

        return {
          success: false,
          error: error.code || "PARAFORMER_FILE_TRANSCRIPTION_FAILED",
          message: errorMessage,
        };
      } finally {
        unregister();
      }
    });

    ipcMain.handle("transcribe-external-asr", async (event, audioBlob, options = {}) => {
      if (this.shuttingDown) {
        return { success: false, error: "ERR_APP_SHUTTING_DOWN" };
      }
      const provider = String(options?.provider || "")
        .trim()
        .toLowerCase();
      const model = String(options?.model || "").trim();
      debugLogger.log("transcribe-external-asr called", {
        audioBlobType: typeof audioBlob,
        audioBlobSize: audioBlob?.byteLength || audioBlob?.length || 0,
        provider,
        model,
        hasRuntimeUrl: Boolean(String(options?.runtimeUrl || "").trim()),
        hasApiKey: Boolean(String(options?.apiKey || "").trim()),
        language: options?.language || "",
      });

      const abortController = new AbortController();
      const unregister = this.registerFileTranscription(
        options?.operationId,
        "external-asr",
        () => {
          abortController.abort();
        },
        event.sender
      );
      try {
        const result = await transcribeExternalAsrRuntime(audioBlob, {
          ...options,
          signal: abortController.signal,
        });

        debugLogger.log("External ASR result", {
          success: result.success,
          provider: result.provider,
          model: result.model,
          hasText: Boolean(result.text),
          statusCode: result.statusCode,
        });

        return result;
      } catch (error) {
        debugLogger.error("External ASR transcription error", {
          provider,
          model,
          code: error.code || "external_asr_failed",
          statusCode: error.statusCode,
          message: error.message,
        });

        return {
          success: false,
          error: error.code || "external_asr_failed",
          message: error.message || "External ASR runtime transcription failed.",
        };
      } finally {
        unregister();
      }
    });

    ipcMain.handle("transcribe-external-asr-file", async (event, filePath, options = {}) => {
      if (this.shuttingDown) {
        return { success: false, error: "ERR_APP_SHUTTING_DOWN" };
      }
      const validation = await validateReadableAudioFilePath(filePath);
      if (!validation.ok) return validation.response;

      const provider = String(options?.provider || "")
        .trim()
        .toLowerCase();
      const model = String(options?.model || "").trim();
      debugLogger.log("transcribe-external-asr-file called", {
        sourceFilePath: validation.filePath,
        provider,
        model,
        hasRuntimeUrl: Boolean(String(options?.runtimeUrl || "").trim()),
        hasApiKey: Boolean(String(options?.apiKey || "").trim()),
        language: options?.language || "",
      });

      const abortController = new AbortController();
      const unregister = this.registerFileTranscription(
        options?.operationId,
        "external-asr",
        () => {
          abortController.abort();
        },
        event.sender
      );
      try {
        const result = await transcribeExternalAsrRuntimeFile(validation.filePath, {
          ...options,
          signal: abortController.signal,
        });

        debugLogger.log("External ASR file result", {
          success: result.success,
          provider: result.provider,
          model: result.model,
          hasText: Boolean(result.text),
          statusCode: result.statusCode,
        });

        return result;
      } catch (error) {
        debugLogger.error("External ASR file transcription error", {
          provider,
          model,
          code: error.code || "external_asr_failed",
          statusCode: error.statusCode,
          message: error.message,
        });

        return {
          success: false,
          error: error.code || "external_asr_failed",
          message: error.message || "External ASR runtime transcription failed.",
        };
      } finally {
        unregister();
      }
    });

    ipcMain.handle("check-external-asr-runtime", async (event, options = {}) => {
      const provider = String(options?.provider || "")
        .trim()
        .toLowerCase();
      const model = String(options?.model || "").trim();
      debugLogger.log("check-external-asr-runtime called", {
        provider,
        model,
        hasRuntimeUrl: Boolean(String(options?.runtimeUrl || "").trim()),
        hasApiKey: Boolean(String(options?.apiKey || "").trim()),
      });

      try {
        const result = await checkExternalAsrRuntime(options);

        debugLogger.log("External ASR runtime check result", {
          success: result.success,
          provider: result.provider,
          model: result.model,
          status: result.status,
          statusCode: result.statusCode,
          modelFound: result.modelFound,
        });

        return result;
      } catch (error) {
        debugLogger.error("External ASR runtime check error", {
          provider,
          model,
          code: error.code || "external_asr_runtime_check_failed",
          message: error.message,
        });

        return {
          success: false,
          provider,
          model,
          status: "invalid",
          error: error.code || "external_asr_runtime_check_failed",
          message: error.message || "External ASR runtime check failed.",
        };
      }
    });

    ipcMain.handle("transcribe-local-granite", async (event, audioBlob, options = {}) => {
      if (this.shuttingDown) {
        return { success: false, error: "ERR_APP_SHUTTING_DOWN" };
      }
      try {
        toBoundedAudioBuffer(audioBlob, "Granite audio buffer");
      } catch (error) {
        return { success: false, error: error.code || "invalid_audio", message: error.message };
      }
      const model = String(options?.model || "granite-4.0-1b-speech").trim();
      debugLogger.log("transcribe-local-granite called", {
        audioBlobType: typeof audioBlob,
        audioBlobSize: audioBlob?.byteLength || audioBlob?.length || 0,
        model,
        language: options?.language || "",
      });

      const abortController = new AbortController();
      const unregister = this.registerFileTranscription(
        options?.operationId,
        "granite",
        () => abortController.abort(),
        event.sender
      );
      try {
        const result = await this.graniteRuntimeManager.transcribeLocalGranite(audioBlob, {
          ...options,
          signal: abortController.signal,
        });

        debugLogger.log("Granite local result", {
          success: result.success,
          hasText: Boolean(result.text),
          message: result.message,
          error: result.error,
          endpoint: result.endpoint,
        });

        if (!result.success && result.message === "No audio detected") {
          event.sender.send("no-audio-detected");
        }

        return result;
      } catch (error) {
        debugLogger.error("Local Granite transcription error", {
          model,
          code: error.code || "granite_transcription_failed",
          message: error.message,
        });

        return {
          success: false,
          error: error.code || "granite_transcription_failed",
          message: error.message || "Granite transcription failed.",
        };
      } finally {
        unregister();
      }
    });

    ipcMain.handle("transcribe-local-granite-file", async (event, filePath, options = {}) => {
      if (this.shuttingDown) {
        return { success: false, error: "ERR_APP_SHUTTING_DOWN" };
      }
      const validation = await validateReadableAudioFilePath(filePath);
      if (!validation.ok) return validation.response;

      const model = String(options?.model || "granite-4.0-1b-speech").trim();
      debugLogger.log("transcribe-local-granite-file called", {
        sourceFilePath: validation.filePath,
        model,
        language: options?.language || "",
      });

      const abortController = new AbortController();
      const unregister = this.registerFileTranscription(
        options?.operationId,
        "granite",
        () => abortController.abort(),
        event.sender
      );
      try {
        const result = await this.graniteRuntimeManager.transcribeLocalGraniteFile(
          validation.filePath,
          { ...options, signal: abortController.signal }
        );

        debugLogger.log("Granite local file result", {
          success: result.success,
          hasText: Boolean(result.text),
          message: result.message,
          error: result.error,
          endpoint: result.endpoint,
        });

        if (!result.success && result.message === "No audio detected") {
          event.sender.send("no-audio-detected");
        }

        return result;
      } catch (error) {
        debugLogger.error("Local Granite file transcription error", {
          model,
          code: error.code || "granite_transcription_failed",
          message: error.message,
        });

        return {
          success: false,
          error: error.code || "granite_transcription_failed",
          message: error.message || "Granite transcription failed.",
        };
      } finally {
        unregister();
      }
    });

    ipcMain.handle("check-granite-runtime", async () => {
      return this.graniteRuntimeManager.checkInstallation();
    });

    ipcMain.handle("install-granite-runtime", async (event, payload = {}) => {
      const { options } = normalizeModelDownloadRequest(payload, "granite-4.0-1b-speech");
      try {
        return await this.graniteRuntimeManager.installRuntime((progressData) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send("granite-download-progress", progressData);
          }
        }, options);
      } catch (error) {
        const customerError = getCustomerDownloadError(error, "RUNTIME_INSTALL_FAILED");
        if (!event.sender.isDestroyed()) {
          event.sender.send("granite-download-progress", {
            type: "error",
            model: "granite-4.0-1b-speech",
            error: customerError.message,
            code: customerError.code,
            manualDownloadUrl: customerError.manualDownloadUrl,
            source_count: customerError.sources?.length,
          });
        }
        return {
          success: false,
          error: customerError.message,
          code: customerError.code,
          manualDownloadUrl: customerError.manualDownloadUrl,
          sources: customerError.sources,
        };
      }
    });

    ipcMain.handle("download-granite-model", async (event, payload) => {
      const { modelName, options } = normalizeModelDownloadRequest(
        payload,
        "granite-4.0-1b-speech"
      );
      try {
        const result = await this.graniteRuntimeManager.downloadGraniteModel(
          modelName,
          (progressData) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send("granite-download-progress", progressData);
            }
          },
          options
        );
        return result;
      } catch (error) {
        const customerError = getCustomerDownloadError(error);
        if (!event.sender.isDestroyed()) {
          event.sender.send("granite-download-progress", {
            type: "error",
            model: modelName,
            error: customerError.message,
            code: customerError.code,
            manualDownloadUrl: customerError.manualDownloadUrl,
            source_count: customerError.sources?.length,
          });
        }
        return {
          success: false,
          error: customerError.message,
          code: customerError.code,
          manualDownloadUrl: customerError.manualDownloadUrl,
          sources: customerError.sources,
        };
      }
    });

    ipcMain.handle("check-granite-model-status", async (_event, modelName) => {
      return this.graniteRuntimeManager.checkModelStatus(modelName);
    });

    ipcMain.handle("list-granite-models", async () => {
      return this.graniteRuntimeManager.listGraniteModels();
    });

    ipcMain.handle("delete-granite-model", async (_event, modelName) => {
      return this.graniteRuntimeManager.deleteGraniteModel(modelName);
    });

    ipcMain.handle("delete-all-granite-models", async () => {
      return this.graniteRuntimeManager.deleteAllGraniteModels();
    });

    ipcMain.handle("delete-punctuation-models", async () => {
      return deletePunctuationModels();
    });

    ipcMain.handle("cancel-granite-download", async () => {
      return this.graniteRuntimeManager.cancelDownload();
    });

    ipcMain.handle("get-granite-diagnostics", async () => {
      return this.graniteRuntimeManager.getDiagnostics();
    });

    ipcMain.handle("granite-server-start", async (_event, modelName) => {
      try {
        const result = await this.graniteRuntimeManager.startServer(modelName);
        process.env.LOCAL_TRANSCRIPTION_PROVIDER = "granite";
        process.env.GRANITE_MODEL = modelName;
        delete process.env.GRANITE_RUNTIME_URL;
        await this.environmentManager.saveAllKeysToEnvFile();
        return result;
      } catch (error) {
        debugLogger.error("Failed to start Granite server", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("granite-server-stop", async () => {
      try {
        const result = await this.graniteRuntimeManager.stopServer();
        delete process.env.LOCAL_TRANSCRIPTION_PROVIDER;
        delete process.env.GRANITE_MODEL;
        delete process.env.GRANITE_RUNTIME_URL;
        await this.environmentManager.saveAllKeysToEnvFile();
        return result;
      } catch (error) {
        debugLogger.error("Failed to stop Granite server", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("granite-server-status", async () => {
      return this.graniteRuntimeManager.getServerStatus();
    });

    ipcMain.handle("check-paraformer-installation", async () => {
      return this.paraformerManager.checkInstallation();
    });

    ipcMain.handle("download-paraformer-model", async (event, payload) => {
      const { modelName, options } = normalizeModelDownloadRequest(payload);
      try {
        const result = await this.paraformerManager.downloadParaformerModel(
          modelName,
          (progressData) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send("paraformer-download-progress", progressData);
            }
          },
          options
        );
        // Paraformer is Chinese ASR and emits unpunctuated text. Now that its
        // model is installed, fetch the ML punctuation model in the background so
        // the first Chinese dictation already has real punctuation — no toggle,
        // no waiting on the first utterance. Idempotent; stays on heuristic if it
        // fails.
        ensurePunctuationModelInBackground().catch(() => {});
        return result;
      } catch (error) {
        const customerError = getCustomerDownloadError(error);
        if (!event.sender.isDestroyed()) {
          event.sender.send("paraformer-download-progress", {
            type: "error",
            model: modelName,
            error: customerError.message,
            code: customerError.code,
            manualDownloadUrl: customerError.manualDownloadUrl,
            source_count: customerError.sources?.length,
          });
        }
        return {
          success: false,
          error: customerError.message,
          code: customerError.code,
          manualDownloadUrl: customerError.manualDownloadUrl,
          sources: customerError.sources,
        };
      }
    });

    ipcMain.handle("check-paraformer-model-status", async (_event, modelName) => {
      return this.paraformerManager.checkModelStatus(modelName);
    });

    ipcMain.handle("list-paraformer-models", async () => {
      return this.paraformerManager.listParaformerModels();
    });

    ipcMain.handle("delete-paraformer-model", async (_event, modelName) => {
      return this.paraformerManager.deleteParaformerModel(modelName);
    });

    ipcMain.handle("delete-all-paraformer-models", async () => {
      return this.paraformerManager.deleteAllParaformerModels();
    });

    ipcMain.handle("cancel-paraformer-download", async () => {
      return this.paraformerManager.cancelDownload();
    });

    ipcMain.handle("get-paraformer-diagnostics", async () => {
      return this.paraformerManager.getDiagnostics();
    });

    ipcMain.handle("paraformer-server-start", async (event, modelName) => {
      try {
        const result = await this.paraformerManager.startServer(modelName);
        if (result?.success) {
          process.env.LOCAL_TRANSCRIPTION_PROVIDER = "paraformer";
          process.env.PARAFORMER_MODEL = modelName;
          await this.environmentManager.saveAllKeysToEnvFile();
        }
        return result;
      } catch (error) {
        debugLogger.error("Failed to start Paraformer server", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("paraformer-server-stop", async () => {
      try {
        const result = await this.paraformerManager.stopServer();
        delete process.env.LOCAL_TRANSCRIPTION_PROVIDER;
        delete process.env.PARAFORMER_MODEL;
        await this.environmentManager.saveAllKeysToEnvFile();
        return result;
      } catch (error) {
        debugLogger.error("Failed to stop Paraformer server", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("paraformer-server-status", async () => {
      return this.paraformerManager.getServerStatus();
    });

    ipcMain.handle("pick-whisper-model-file", async (event, defaultPath = "") => {
      try {
        const targetWindow = BrowserWindow.fromWebContents(event.sender);
        const options = {
          title: "Select Whisper model",
          defaultPath: defaultPath || undefined,
          properties: ["openFile"],
          filters: [
            { name: "Whisper model", extensions: ["bin"] },
            { name: "All files", extensions: ["*"] },
          ],
        };
        const result = targetWindow
          ? await dialog.showOpenDialog(targetWindow, options)
          : await dialog.showOpenDialog(options);

        if (result.canceled || !result.filePaths?.length) {
          return { success: true, path: null, cancelled: true };
        }

        return { success: true, path: result.filePaths[0], cancelled: false };
      } catch (error) {
        return { success: false, error: error.message, path: null, cancelled: false };
      }
    });

    ipcMain.handle("pick-parakeet-model-directory", async (event, defaultPath = "") => {
      try {
        const targetWindow = BrowserWindow.fromWebContents(event.sender);
        const options = {
          title: "Select Parakeet model directory",
          defaultPath: defaultPath || undefined,
          properties: ["openDirectory"],
        };
        const result = targetWindow
          ? await dialog.showOpenDialog(targetWindow, options)
          : await dialog.showOpenDialog(options);

        if (result.canceled || !result.filePaths?.length) {
          return { success: true, path: null, cancelled: true };
        }

        return { success: true, path: result.filePaths[0], cancelled: false };
      } catch (error) {
        return { success: false, error: error.message, path: null, cancelled: false };
      }
    });

    ipcMain.handle("pick-paraformer-model-directory", async (event, defaultPath = "") => {
      try {
        const targetWindow = BrowserWindow.fromWebContents(event.sender);
        const options = {
          title: "Select Paraformer model directory",
          defaultPath: defaultPath || undefined,
          properties: ["openDirectory"],
        };
        const result = targetWindow
          ? await dialog.showOpenDialog(targetWindow, options)
          : await dialog.showOpenDialog(options);

        if (result.canceled || !result.filePaths?.length) {
          return { success: true, path: null, cancelled: true };
        }

        return { success: true, path: result.filePaths[0], cancelled: false };
      } catch (error) {
        return { success: false, error: error.message, path: null, cancelled: false };
      }
    });

    ipcMain.handle("pick-streaming-model-directory", async (event, defaultPath = "") => {
      try {
        const targetWindow = BrowserWindow.fromWebContents(event.sender);
        const options = {
          title: "Select streaming model directory",
          defaultPath: defaultPath || undefined,
          properties: ["openDirectory", "createDirectory"],
        };
        const result = targetWindow
          ? await dialog.showOpenDialog(targetWindow, options)
          : await dialog.showOpenDialog(options);

        if (result.canceled || !result.filePaths?.length) {
          return { success: true, path: null, cancelled: true };
        }

        return { success: true, path: result.filePaths[0], cancelled: false };
      } catch (error) {
        return { success: false, error: error.message, path: null, cancelled: false };
      }
    });

    ipcMain.handle("export-settings-file", async (event, payload = {}) => {
      try {
        const targetWindow = BrowserWindow.fromWebContents(event.sender);
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const options = {
          title: "Export ChordVox Settings",
          defaultPath: `ChordVox-settings-${timestamp}.json`,
          filters: [{ name: "JSON", extensions: ["json"] }],
        };

        const result = targetWindow
          ? await dialog.showSaveDialog(targetWindow, options)
          : await dialog.showSaveDialog(options);

        if (result.canceled || !result.filePath) {
          return { success: true, cancelled: true };
        }

        await fsPromises.writeFile(result.filePath, JSON.stringify(payload, null, 2), "utf8");
        return { success: true, cancelled: false, filePath: result.filePath };
      } catch (error) {
        debugLogger.error("Failed to export settings file:", error);
        return { success: false, cancelled: false, error: error.message };
      }
    });

    ipcMain.handle("export-transcription-history", async (event, payload = {}) => {
      try {
        const targetWindow = BrowserWindow.fromWebContents(event.sender);
        const ALLOWED_FORMATS = ["txt", "md", "csv", "json"];
        const rawFormat =
          typeof payload?.format === "string" ? payload.format.toLowerCase() : "txt";
        const format = ALLOWED_FORMATS.includes(rawFormat) ? rawFormat : "txt";
        const requestedScope = ["items", "all", "query"].includes(payload?.scope)
          ? payload.scope
          : "items";
        const suppliedItems = Array.isArray(payload?.items) ? payload.items : [];
        if (requestedScope === "items" && suppliedItems.length > MAX_IPC_HISTORY_ITEMS) {
          return {
            success: false,
            cancelled: false,
            error: {
              message: `history items exceed ${MAX_IPC_HISTORY_ITEMS} limit`,
              code: "ERR_IPC_HISTORY_TOO_LARGE",
            },
          };
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

        const extensionLabels = {
          txt: { name: "Plain text", extensions: ["txt"] },
          md: { name: "Markdown", extensions: ["md"] },
          csv: { name: "CSV", extensions: ["csv"] },
          json: { name: "JSON", extensions: ["json"] },
        };

        const result = targetWindow
          ? await dialog.showSaveDialog(targetWindow, {
              title: "Export Transcription History",
              defaultPath: `ChordVox-history-${timestamp}.${format}`,
              filters: [extensionLabels[format]],
            })
          : await dialog.showSaveDialog({
              title: "Export Transcription History",
              defaultPath: `ChordVox-history-${timestamp}.${format}`,
              filters: [extensionLabels[format]],
            });

        if (result.canceled || !result.filePath) {
          return { success: true, cancelled: true };
        }

        let rawItems = suppliedItems;
        if (requestedScope === "all" || requestedScope === "query") {
          const rawQuery = requestedScope === "query" ? payload?.query || {} : {};
          const parsedSince = rawQuery?.since ? new Date(String(rawQuery.since)) : null;
          const queryResult = await this.databaseManager.queryTranscriptionHistory({
            query: String(rawQuery?.query || "").slice(0, 200),
            favoriteOnly: requestedScope === "query" && rawQuery?.favoriteOnly === true,
            since:
              requestedScope === "query" && parsedSince && !Number.isNaN(parsedSince.getTime())
                ? parsedSince.toISOString()
                : null,
            limit: MAX_IPC_HISTORY_ITEMS,
            limitCap: MAX_IPC_HISTORY_ITEMS,
            offset: 0,
            shouldCancel: () => event.sender.isDestroyed(),
          });

          if (queryResult?.cancelled) {
            return { success: true, cancelled: true };
          }
          if (queryResult?.hasMore) {
            return {
              success: false,
              cancelled: false,
              error: `History export exceeds the ${MAX_IPC_HISTORY_ITEMS} item limit. Narrow the filters and try again.`,
            };
          }
          rawItems = queryResult?.items || [];
        }

        const items = rawItems
          .map((item) => {
            if (!item || typeof item !== "object") return null;
            const safeText =
              typeof item.text === "string"
                ? item.text.length > MAX_IPC_TRANSCRIPTION_TEXT_LENGTH
                  ? item.text.slice(0, MAX_IPC_TRANSCRIPTION_TEXT_LENGTH)
                  : item.text
                : "";
            return {
              id: item.id ?? null,
              timestamp: item.timestamp ?? item.created_at ?? null,
              created_at: item.created_at ?? item.timestamp ?? null,
              text: safeText,
            };
          })
          .filter(Boolean);

        const sanitize = (value) => (value === null || value === undefined ? "" : String(value));
        let body = "";
        if (format === "json") {
          body = JSON.stringify(items, null, 2);
        } else if (format === "csv") {
          const escapeCsv = (value) => {
            const text = sanitize(value);
            return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
          };
          const header = ["id", "timestamp", "text"].join(",");
          const rows = items.map((item) =>
            [
              escapeCsv(item?.id),
              escapeCsv(item?.timestamp || item?.created_at),
              escapeCsv(item?.text),
            ].join(",")
          );
          body = [header, ...rows].join("\n");
        } else if (format === "md") {
          body = items
            .map((item) => {
              const ts = sanitize(item?.timestamp || item?.created_at).trim();
              const text = sanitize(item?.text).trim();
              return `## ${ts || "(no timestamp)"}\n\n${text}\n`;
            })
            .join("\n");
        } else {
          body = items
            .map((item) => {
              const ts = sanitize(item?.timestamp || item?.created_at).trim();
              const text = sanitize(item?.text).trim();
              return ts ? `[${ts}] ${text}` : text;
            })
            .join("\n");
        }

        await fsPromises.writeFile(result.filePath, body, "utf8");
        return { success: true, cancelled: false, filePath: result.filePath, count: items.length };
      } catch (error) {
        debugLogger.error("Failed to export transcription history:", error);
        return { success: false, cancelled: false, error: error.message };
      }
    });

    ipcMain.handle("show-item-in-folder", async (_event, filePath = "") => {
      try {
        const rawPath = typeof filePath === "string" ? filePath.trim() : "";
        if (!rawPath || !path.isAbsolute(rawPath)) {
          return { success: false, error: "Invalid file path" };
        }

        const targetPath = path.normalize(rawPath);
        await fsPromises.access(targetPath);
        shell.showItemInFolder(targetPath);
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to show item in folder:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-mac-app-bundle-drag-info", async () => getMacAppBundleDragInfo());
    ipcMain.handle("show-mac-privacy-drag-helper", async (_event, options = {}) =>
      showMacPrivacyDragHelper(options)
    );
    ipcMain.handle("hide-mac-privacy-drag-helper", async () => hideMacPrivacyDragHelper());

    ipcMain.on("start-mac-app-bundle-drag", (event) => {
      try {
        const info = getMacAppBundleDragInfo();
        const bundlePath = getPreferredMacAppBundlePath();
        if (!info.available || !bundlePath) {
          debugLogger.warn("macOS app bundle drag unavailable", { reason: info.reason });
          return;
        }

        event.sender.startDrag({
          file: bundlePath,
          files: [bundlePath],
          icon: getMacDragIcon(MAC_PRIVACY_DRAG_ICON_SIZE),
        });
      } catch (error) {
        debugLogger.error("Failed to start macOS app bundle drag:", error);
      }
    });

    ipcMain.handle("reveal-mac-app-bundle", async () => {
      try {
        const info = getMacAppBundleDragInfo();
        const bundlePath = getPreferredMacAppBundlePath();
        if (!info.revealAvailable || !bundlePath) {
          return { success: false, error: info.reason || "App bundle is not available" };
        }

        await fsPromises.access(bundlePath);
        shell.showItemInFolder(bundlePath);
        const folderResult = await shell.openPath(path.dirname(bundlePath));
        if (folderResult) {
          debugLogger.warn("Finder folder fallback returned a warning", {
            folderResult,
            bundlePath,
          });
        }
        return { success: true, path: bundlePath };
      } catch (error) {
        debugLogger.error("Failed to reveal macOS app bundle:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("import-settings-file", async (event) => {
      try {
        const targetWindow = BrowserWindow.fromWebContents(event.sender);
        const options = {
          title: "Import ChordVox Settings",
          properties: ["openFile"],
          filters: [{ name: "JSON", extensions: ["json"] }],
        };

        const result = targetWindow
          ? await dialog.showOpenDialog(targetWindow, options)
          : await dialog.showOpenDialog(options);

        if (result.canceled || !result.filePaths?.length) {
          return { success: true, cancelled: true };
        }

        const filePath = result.filePaths[0];
        const stats = await fsPromises.stat(filePath);
        if (!stats.isFile()) {
          return {
            success: false,
            cancelled: false,
            error: "Selected settings path is not a file.",
          };
        }
        if (stats.size > MAX_SETTINGS_IMPORT_FILE_BYTES) {
          return {
            success: false,
            cancelled: false,
            error: `Settings file exceeds ${Math.round(MAX_SETTINGS_IMPORT_FILE_BYTES / (1024 * 1024))}MB limit.`,
          };
        }

        const raw = await fsPromises.readFile(filePath, "utf8");
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (parseError) {
          return {
            success: false,
            cancelled: false,
            error: `Invalid JSON file: ${parseError.message}`,
          };
        }

        return { success: true, cancelled: false, filePath, data: parsed };
      } catch (error) {
        debugLogger.error("Failed to import settings file:", error);
        return { success: false, cancelled: false, error: error.message };
      }
    });

    // Utility handlers
    ipcMain.handle("cleanup-app", async (event) => {
      try {
        return await AppUtils.cleanup({
          mainWindow: BrowserWindow.fromWebContents(event.sender) || this.windowManager.mainWindow,
          databaseManager: this.databaseManager,
          whisperManager: this.whisperManager,
          parakeetManager: this.parakeetManager,
          paraformerManager: this.paraformerManager,
          graniteRuntimeManager: this.graniteRuntimeManager,
          sherpaStreaming: this.sherpaStreaming,
          environmentManager: this.environmentManager,
        });
      } catch (error) {
        return {
          success: false,
          message: "Application data cleanup failed.",
          errors: [{ step: "cleanup", error: error.message }],
          requiresRestart: true,
        };
      }
    });

    ipcMain.handle("restart-app", async () => {
      setTimeout(() => {
        app.relaunch();
        app.quit();
      }, 100);
      return { success: true };
    });

    ipcMain.handle("update-hotkey", async (event, hotkey) => {
      return await this.windowManager.updateHotkey(hotkey);
    });

    ipcMain.handle("update-secondary-hotkey", async (event, hotkey) => {
      return await this.windowManager.updateSecondaryHotkey(hotkey);
    });

    ipcMain.handle("sync-hotkey-workflows", async (_event, workflows) => {
      return await this.windowManager.syncHotkeyWorkflows(workflows);
    });

    ipcMain.handle("check-hotkey-availability", async (_event, hotkey) => {
      try {
        const { checkHotkeyAvailability } = require("./hotkeyManager");
        return checkHotkeyAvailability(hotkey);
      } catch (error) {
        debugLogger.error("Failed to check hotkey availability:", error);
        return { available: false, reason: "error", ownedByApp: false };
      }
    });

    ipcMain.handle(
      "set-hotkey-listening-mode",
      async (event, enabled, newHotkey = null, scope = "primary") => {
        this.windowManager.setHotkeyListeningMode(enabled);
        if (process.platform === "darwin") {
          ipcMain.emit("mac-hotkey-capture-mode-changed", null, Boolean(enabled));
        }
        const hotkeyManager = this.windowManager.hotkeyManager;
        const captureScope = typeof scope === "string" && scope !== "primary" ? scope : "primary";

        // When exiting capture mode with a new hotkey, use that to avoid reading stale state
        const effectiveHotkey =
          !enabled && captureScope === "primary" && newHotkey
            ? newHotkey
            : hotkeyManager.getCurrentHotkey();

        const {
          getHotkeyAccelerator,
          isModifierOnlyHotkey,
          usesNativeHotkeyListener,
        } = require("./hotkeyManager");
        const usesNativeListener = (hotkey) => !hotkey || usesNativeHotkeyListener(hotkey);

        if (enabled) {
          if (this.windowManager.workflowHotkeys.size > 0) {
            await this.windowManager.unregisterWorkflowHotkeys({ clearDefinitions: false });
            this.workflowHotkeysSuspendedForCapture = true;
          }

          // Entering capture mode - unregister globalShortcut so it doesn't consume key events
          const currentHotkey = hotkeyManager.getCurrentHotkey();
          if (currentHotkey && !usesNativeListener(currentHotkey)) {
            const accelerator = getHotkeyAccelerator(currentHotkey);
            debugLogger.log(
              `[IPC] Unregistering globalShortcut "${accelerator}" for hotkey capture mode`
            );
            const { globalShortcut } = require("electron");
            globalShortcut.unregister(accelerator);
          }

          // On Windows, stop the Windows key listener
          if (process.platform === "win32" && this.windowsKeyManager) {
            debugLogger.log("[IPC] Stopping Windows key listener for hotkey capture mode");
            this.windowsKeyManager.stop();
          }

          // On GNOME Wayland, unregister the keybinding during capture
          if (hotkeyManager.isUsingGnome() && hotkeyManager.gnomeManager) {
            debugLogger.log("[IPC] Unregistering GNOME keybinding for hotkey capture mode");
            await hotkeyManager.gnomeManager.unregisterKeybinding().catch((err) => {
              debugLogger.warn("[IPC] Failed to unregister GNOME keybinding:", err.message);
            });
          }
        } else {
          if (this.workflowHotkeysSuspendedForCapture) {
            const workflowRestore = this.windowManager.resumeWorkflowHotkeys();
            if (!workflowRestore.success) {
              debugLogger.warn("[IPC] Failed to restore workflow hotkeys after capture mode");
            }
            this.workflowHotkeysSuspendedForCapture = false;
          }

          // Exiting capture mode - re-register globalShortcut if not already registered
          if (effectiveHotkey && !usesNativeListener(effectiveHotkey)) {
            const { globalShortcut } = require("electron");
            const accelerator = getHotkeyAccelerator(effectiveHotkey);
            if (!globalShortcut.isRegistered(accelerator)) {
              debugLogger.log(
                `[IPC] Re-registering globalShortcut "${accelerator}" after capture mode`
              );
              const callback = this.windowManager.createHotkeyCallback();
              const registered = globalShortcut.register(accelerator, callback);
              if (!registered) {
                debugLogger.warn(
                  `[IPC] Failed to re-register globalShortcut "${accelerator}" after capture mode`
                );
              }
            }
          }

          if (process.platform === "win32" && this.windowsKeyManager) {
            const activationMode = this.windowManager.getActivationMode();
            debugLogger.log(
              `[IPC] Exiting hotkey capture mode, activationMode="${activationMode}", hotkey="${effectiveHotkey}"`
            );
            const needsListener =
              effectiveHotkey &&
              effectiveHotkey !== "GLOBE" &&
              (activationMode === "push" || isModifierOnlyHotkey(effectiveHotkey));
            if (needsListener) {
              debugLogger.log(
                `[IPC] Restarting Windows key listener for hotkey: ${effectiveHotkey}`
              );
              this.windowsKeyManager.start(effectiveHotkey);
            }
          }

          // On GNOME Wayland, re-register the keybinding with the effective hotkey
          if (hotkeyManager.isUsingGnome() && hotkeyManager.gnomeManager && effectiveHotkey) {
            const gnomeHotkey = GnomeShortcutManager.convertToGnomeFormat(effectiveHotkey);
            debugLogger.log(
              `[IPC] Re-registering GNOME keybinding "${gnomeHotkey}" after capture mode`
            );
            const success = await hotkeyManager.gnomeManager.registerKeybinding(gnomeHotkey);
            if (success) {
              hotkeyManager.currentHotkey = effectiveHotkey;
            }
          }
        }

        return { success: true };
      }
    );

    ipcMain.handle("get-hotkey-mode-info", async () => {
      const {
        getHotkeyAccelerator,
        getDefaultHotkeyForPlatform,
        isModifierOnlyHotkey,
        isRightSideModifier,
      } = require("./hotkeyManager");
      const { globalShortcut } = require("electron");
      const primaryHotkey = this.windowManager.hotkeyManager.getCurrentHotkey?.() || "";
      const secondaryHotkey = this.windowManager.secondaryHotkey || "";
      const activationMode = this.windowManager.getActivationMode?.() || "tap";
      const isUsingGnome = this.windowManager.isUsingGnomeHotkeys();

      let backend = "globalShortcut";
      if (primaryHotkey === "GLOBE") {
        backend = "globe";
      } else if (isUsingGnome) {
        backend = "gnome-wayland";
      } else if (
        process.platform === "win32" &&
        (activationMode === "push" ||
          isRightSideModifier(primaryHotkey) ||
          isModifierOnlyHotkey(primaryHotkey))
      ) {
        backend = "windows-native";
      } else if (isRightSideModifier(primaryHotkey)) {
        backend = "native-modifier";
      }

      const primaryAccelerator = getHotkeyAccelerator(primaryHotkey);
      const secondaryAccelerator = getHotkeyAccelerator(secondaryHotkey);
      const primaryRegistered =
        primaryHotkey === "GLOBE"
          ? process.platform === "darwin"
          : isUsingGnome
            ? Boolean(this.windowManager.hotkeyManager.gnomeManager?.isRegistered)
            : backend === "windows-native" || backend === "native-modifier"
              ? true
              : Boolean(primaryAccelerator && globalShortcut.isRegistered(primaryAccelerator));
      const secondaryRegistered = Boolean(
        secondaryAccelerator && globalShortcut.isRegistered(secondaryAccelerator)
      );

      return {
        isUsingGnome,
        platform: process.platform,
        sessionType: process.env.XDG_SESSION_TYPE || "",
        desktopSession:
          process.env.XDG_CURRENT_DESKTOP ||
          process.env.DESKTOP_SESSION ||
          process.env.GDMSESSION ||
          "",
        backend,
        activationMode,
        primaryHotkey,
        secondaryHotkey,
        primaryRegistered,
        secondaryRegistered,
        recommendedPrimaryHotkey: getDefaultHotkeyForPlatform(process.platform),
      };
    });

    ipcMain.handle("start-window-drag", async (event) => {
      return await this.windowManager.startWindowDrag();
    });

    ipcMain.handle("stop-window-drag", async (event) => {
      return await this.windowManager.stopWindowDrag();
    });

    // External link handler
    ipcMain.handle("open-external", async (event, url, options = {}) => {
      try {
        await openSafeExternalUrl(shell, url);
        return { success: true };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (options?.showError === true) {
          dialog.showErrorBox(
            i18nMain.t("dialog.openLink.title"),
            i18nMain.t("dialog.openLink.message", {
              url,
              error: errorMessage,
            })
          );
        }
        return { success: false, error: errorMessage };
      }
    });

    // Auto-start handlers
    ipcMain.handle("get-auto-start-enabled", async () => {
      try {
        return this.environmentManager.getAutoStartEnabled();
      } catch (error) {
        // Default to false on error so we never silently register the app at
        // login. Matches the "no implicit opt-in" semantics of the rest of
        // the auto-start logic.
        debugLogger.error("Error getting auto-start status:", error);
        return false;
      }
    });

    ipcMain.handle("set-auto-start-enabled", async (event, enabled) => {
      try {
        const persisted = await this.environmentManager.saveAutoStartEnabled(enabled);
        if (!persisted?.success) {
          return persisted;
        }
        app.setLoginItemSettings({
          openAtLogin: enabled,
          openAsHidden: true, // Start minimized to tray
          ...(process.platform === "win32" ? { args: ["--hidden"] } : {}),
        });
        debugLogger.debug("Auto-start setting updated", {
          enabled,
          packaged: app.isPackaged,
        });
        return { success: true };
      } catch (error) {
        debugLogger.error("Error setting auto-start:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-tray-icon-enabled", async () => {
      try {
        return this.environmentManager.getTrayIconEnabled();
      } catch (error) {
        debugLogger.error("Error getting tray icon status:", error);
        return true;
      }
    });

    ipcMain.handle("set-tray-icon-enabled", async (event, enabled) => {
      try {
        const normalized = enabled !== false;
        const persisted = await this.environmentManager.saveTrayIconEnabled(normalized);
        if (!persisted?.success) {
          return { ...persisted, enabled: normalized };
        }
        process.env.TRAY_ICON_ENABLED = String(normalized);

        const trayManager = this.getTrayManager?.();
        let trayReady = true;

        if (normalized) {
          trayReady = (await trayManager?.recreateTray?.()) !== false;
        } else {
          trayManager?.destroyTray?.();
        }

        this.windowManager?.applyMacPresentationMode?.({
          preferDock: !normalized || !trayReady,
        });

        if (
          this.windowManager?.controlPanelWindow &&
          !this.windowManager.controlPanelWindow.isDestroyed()
        ) {
          this.windowManager.controlPanelWindow.show();
          this.windowManager.controlPanelWindow.focus();
        }

        return {
          success: trayReady && persisted.success,
          enabled: normalized,
          error: trayReady ? undefined : "TRAY_CREATE_FAILED",
        };
      } catch (error) {
        debugLogger.error("Error setting tray icon status:", error);
        return { success: false, error: error.message };
      }
    });

    // Auto-check-update handlers
    ipcMain.handle("get-auto-check-update", async () => {
      try {
        return this.environmentManager.getAutoCheckUpdate();
      } catch (error) {
        debugLogger.error("Error getting auto-check-update status:", error);
        return true; // default to enabled
      }
    });

    ipcMain.handle("set-auto-check-update", async (event, enabled) => {
      try {
        const persisted = await this.environmentManager.saveAutoCheckUpdate(enabled);
        if (!persisted?.success) {
          return persisted;
        }
        debugLogger.debug("Auto-check-update setting updated", { enabled });
        return { success: true };
      } catch (error) {
        debugLogger.error("Error setting auto-check-update:", error);
        return { success: false, error: error.message };
      }
    });

    // Model management handlers
    ipcMain.handle("model-get-all", async () => {
      try {
        debugLogger.debug("model-get-all called", undefined, "ipc");
        const modelManager = require("./modelManagerBridge").default;
        const models = await modelManager.getModelsWithStatus();
        debugLogger.debug("Returning models", { count: models.length }, "ipc");
        return models;
      } catch (error) {
        debugLogger.error("Error in model-get-all:", error);
        throw error;
      }
    });

    ipcMain.handle("model-check", async (_, modelId) => {
      const modelManager = require("./modelManagerBridge").default;
      return modelManager.isModelDownloaded(modelId);
    });

    ipcMain.handle("model-download", async (event, modelId) => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        const result = await modelManager.downloadModel(
          modelId,
          (progress, downloadedSize, totalSize) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send("model-download-progress", {
                modelId,
                progress,
                downloadedSize,
                totalSize,
              });
            }
          }
        );
        return { success: true, path: result };
      } catch (error) {
        const customerError = getCustomerDownloadError(error);
        return {
          success: false,
          error: customerError.message,
          code: customerError.code,
          manualDownloadUrl: customerError.manualDownloadUrl,
          sources: customerError.sources,
        };
      }
    });

    ipcMain.handle("model-delete", async (event, modelId) => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        await modelManager.deleteModel(modelId);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          code: error.code,
          details: error.details,
        };
      }
    });

    ipcMain.handle("model-delete-all", async () => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        await modelManager.deleteAllModels();
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          code: error.code,
          details: error.details,
        };
      }
    });

    ipcMain.handle("model-cancel-download", async (event, modelId) => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        const cancelled = modelManager.cancelDownload(modelId);
        return { success: cancelled };
      } catch (error) {
        return {
          success: false,
          error: error.message,
        };
      }
    });

    ipcMain.handle("model-check-runtime", async (event) => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        await modelManager.ensureLlamaCpp();
        return { available: true };
      } catch (error) {
        return {
          available: false,
          error: error.message,
          code: error.code,
          details: error.details,
        };
      }
    });

    ipcMain.handle("get-anthropic-key", async (_event, options) => {
      return this.environmentManager.getAnthropicKey({
        allowKeychain: allowKeychainAccess(options),
      });
    });

    ipcMain.handle("get-openrouter-key", async (_event, options) => {
      return this.environmentManager.getOpenRouterKey({
        allowKeychain: allowKeychainAccess(options),
      });
    });

    ipcMain.handle("get-gemini-key", async (_event, options) => {
      return this.environmentManager.getGeminiKey({
        allowKeychain: allowKeychainAccess(options),
      });
    });

    ipcMain.handle("save-gemini-key", async (event, key) => {
      return this.environmentManager.saveGeminiKey(key);
    });

    ipcMain.handle("get-groq-key", async (_event, options) => {
      return this.environmentManager.getGroqKey({
        allowKeychain: allowKeychainAccess(options),
      });
    });

    ipcMain.handle("save-groq-key", async (event, key) => {
      return this.environmentManager.saveGroqKey(key);
    });

    ipcMain.handle("get-cerebras-key", async (_event, options) => {
      return this.environmentManager.getCerebrasKey({
        allowKeychain: allowKeychainAccess(options),
      });
    });

    ipcMain.handle("save-cerebras-key", async (event, key) => {
      return this.environmentManager.saveCerebrasKey(key);
    });

    ipcMain.handle("get-soniox-key", async (_event, options) => {
      return this.environmentManager.getSonioxKey({
        allowKeychain: allowKeychainAccess(options),
      });
    });

    ipcMain.handle("save-soniox-key", async (event, key) => {
      return this.environmentManager.saveSonioxKey(key);
    });

    ipcMain.handle("get-deepgram-key", async (_event, options) => {
      return this.environmentManager.getDeepgramKey({
        allowKeychain: allowKeychainAccess(options),
      });
    });

    ipcMain.handle("save-deepgram-key", async (event, key) => {
      return this.environmentManager.saveDeepgramKey(key);
    });

    ipcMain.handle("get-google-stt-key", async (_event, options) => {
      return this.environmentManager.getGoogleSttKey({
        allowKeychain: allowKeychainAccess(options),
      });
    });

    ipcMain.handle("save-google-stt-key", async (event, key) => {
      return this.environmentManager.saveGoogleSttKey(key);
    });

    ipcMain.handle("test-cloud-transcription-connection", async (event, args = {}) => {
      const licenseGate = await this.checkLicenseGate();
      if (!licenseGate.allowed) {
        return this.buildLicenseDeniedResponse(licenseGate.status);
      }

      return this.testCloudTranscriptionConnection(args);
    });

    ipcMain.handle("get-doubao-app-id", async () => {
      return this.environmentManager.getDoubaoAppId();
    });

    ipcMain.handle("save-doubao-app-id", async (event, appId) => {
      return this.environmentManager.saveDoubaoAppId(appId);
    });

    ipcMain.handle("get-doubao-access-token", async (_event, options) => {
      return this.environmentManager.getDoubaoAccessToken({
        allowKeychain: allowKeychainAccess(options),
      });
    });

    ipcMain.handle("save-doubao-access-token", async (event, token) => {
      return this.environmentManager.saveDoubaoAccessToken(token);
    });

    ipcMain.handle("test-doubao-connection", async (event, args = {}) => {
      const licenseGate = await this.checkLicenseGate();
      if (!licenseGate.allowed) {
        return this.buildLicenseDeniedResponse(licenseGate.status);
      }

      const appId = String(args.appId || this.environmentManager.getDoubaoAppId() || "").trim();
      const accessToken = String(
        args.accessToken || this.environmentManager.getDoubaoAccessToken() || ""
      ).trim();

      const result = await this.doubaoAsrClient.testConnection({
        appId,
        accessToken,
        model: args.model,
        language: args.language,
      });

      return {
        success: true,
        resourceId: result.resourceId,
        resolvedModelId: result.resolvedModelId,
        logId: result.logId,
      };
    });

    ipcMain.handle(
      "proxy-doubao-transcription",
      async (
        event,
        {
          audioBuffer,
          model,
          language,
          appId: inputAppId,
          accessToken: inputAccessToken,
          operationId,
        } = {}
      ) => {
        const licenseGate = await this.checkLicenseGate();
        if (!licenseGate.allowed) {
          return this.buildLicenseDeniedResponse(licenseGate.status);
        }

        const appId = String(inputAppId || this.environmentManager.getDoubaoAppId() || "").trim();
        const accessToken = String(
          inputAccessToken || this.environmentManager.getDoubaoAccessToken() || ""
        ).trim();

        const abortController = new AbortController();
        const unregister = this.registerFileTranscription(
          operationId,
          "doubao",
          () => abortController.abort(),
          event.sender
        );
        try {
          const result = await this.doubaoAsrClient.transcribe({
            audioBuffer: toBoundedAudioBuffer(audioBuffer, "Doubao audio buffer"),
            appId,
            accessToken,
            model,
            language,
            signal: abortController.signal,
          });

          return {
            text: result.text,
            logId: result.logId,
            resourceId: result.resourceId,
          };
        } finally {
          unregister();
        }
      }
    );

    ipcMain.handle("proxy-doubao-transcription-file", async (event, filePath, options = {}) => {
      const { model, language, appId: inputAppId, accessToken: inputAccessToken } = options || {};
      const licenseGate = await this.checkLicenseGate();
      if (!licenseGate.allowed) {
        return this.buildLicenseDeniedResponse(licenseGate.status);
      }

      const validation = await validateReadableAudioFilePath(filePath, {
        maxBytes: MAX_CLOUD_AUDIO_FILE_BYTES,
      });
      if (!validation.ok) return validation.response;

      const appId = String(inputAppId || this.environmentManager.getDoubaoAppId() || "").trim();
      const accessToken = String(
        inputAccessToken || this.environmentManager.getDoubaoAccessToken() || ""
      ).trim();

      const abortController = new AbortController();
      const unregister = this.registerFileTranscription(
        options?.operationId,
        "doubao",
        () => abortController.abort(),
        event.sender
      );
      try {
        const result = await this.doubaoAsrClient.transcribeFile({
          filePath: validation.filePath,
          appId,
          accessToken,
          model,
          language,
          timeoutMs: 2 * 60 * 60 * 1000,
          signal: abortController.signal,
        });

        return {
          text: result.text,
          logId: result.logId,
          resourceId: result.resourceId,
        };
      } finally {
        unregister();
      }
    });

    ipcMain.handle("test-google-cloud-stt-connection", async (event, args = {}) => {
      const licenseGate = await this.checkLicenseGate();
      if (!licenseGate.allowed) {
        return this.buildLicenseDeniedResponse(licenseGate.status);
      }

      try {
        const credential = String(
          args.credential || args.apiKey || this.environmentManager.getGoogleSttKey() || ""
        ).trim();
        const result = await this.googleCloudSttClient.testConnection({
          endpoint: args.endpoint,
          credential,
          model: args.model,
          language: args.language,
        });

        return {
          success: true,
          resolvedModelId: result.resolvedModelId,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debugLogger.error(
          "Google Cloud STT connection test failed",
          { error: message },
          "transcription"
        );
        return {
          success: false,
          error: message,
          message,
          code: error?.code || "GOOGLE_CLOUD_STT_CONNECTION_FAILED",
        };
      }
    });

    ipcMain.handle(
      "proxy-google-cloud-stt-transcription",
      async (
        event,
        { audioBuffer, endpoint, model, language, credential: inputCredential, operationId } = {}
      ) => {
        const licenseGate = await this.checkLicenseGate();
        if (!licenseGate.allowed) {
          return this.buildLicenseDeniedResponse(licenseGate.status);
        }

        const credential = String(
          inputCredential || this.environmentManager.getGoogleSttKey() || ""
        ).trim();
        const abortController = new AbortController();
        const unregister = this.registerFileTranscription(
          operationId,
          "google-cloud",
          () => abortController.abort(),
          event.sender
        );
        try {
          const result = await this.googleCloudSttClient.transcribe({
            audioBuffer: toBoundedAudioBuffer(audioBuffer, "Google Cloud STT audio buffer"),
            endpoint,
            credential,
            model,
            language,
            signal: abortController.signal,
          });

          return {
            text: result.text,
            model: result.model,
          };
        } finally {
          unregister();
        }
      }
    );

    ipcMain.handle(
      "proxy-google-cloud-stt-transcription-file",
      async (event, filePath, options = {}) => {
        const { endpoint, model, language, credential: inputCredential } = options || {};
        const licenseGate = await this.checkLicenseGate();
        if (!licenseGate.allowed) {
          return this.buildLicenseDeniedResponse(licenseGate.status);
        }

        const validation = await validateReadableAudioFilePath(filePath, {
          maxBytes: MAX_CLOUD_AUDIO_FILE_BYTES,
        });
        if (!validation.ok) return validation.response;

        const credential = String(
          inputCredential || this.environmentManager.getGoogleSttKey() || ""
        ).trim();
        const abortController = new AbortController();
        const unregister = this.registerFileTranscription(
          options?.operationId,
          "google-cloud",
          () => abortController.abort(),
          event.sender
        );
        try {
          const result = await this.googleCloudSttClient.transcribeFile({
            filePath: validation.filePath,
            endpoint,
            credential,
            model,
            language,
            timeoutMs: 2 * 60 * 60 * 1000,
            signal: abortController.signal,
          });

          return {
            text: result.text,
            model: result.model,
          };
        } finally {
          unregister();
        }
      }
    );

    ipcMain.handle("test-deepgram-connection", async (event, args = {}) => {
      const licenseGate = await this.checkLicenseGate();
      if (!licenseGate.allowed) {
        return this.buildLicenseDeniedResponse(licenseGate.status);
      }

      try {
        const apiKey = String(args.apiKey || this.environmentManager.getDeepgramKey() || "").trim();
        const result = await this.deepgramAsrClient.testConnection({
          apiKey,
          endpoint: args.endpoint,
          model: args.model,
          language: args.language,
        });

        return {
          success: true,
          resolvedModelId: result.resolvedModelId,
          requestId: result.requestId,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debugLogger.error("Deepgram connection test failed", { error: message }, "transcription");
        return {
          success: false,
          error: message,
          message,
          code: error?.code || "DEEPGRAM_CONNECTION_FAILED",
        };
      }
    });

    ipcMain.handle(
      "proxy-deepgram-transcription",
      async (
        event,
        { audioBuffer, endpoint, model, language, apiKey: inputApiKey, mimeType, operationId } = {}
      ) => {
        const licenseGate = await this.checkLicenseGate();
        if (!licenseGate.allowed) {
          return this.buildLicenseDeniedResponse(licenseGate.status);
        }

        const apiKey = String(inputApiKey || this.environmentManager.getDeepgramKey() || "").trim();
        const abortController = new AbortController();
        const unregister = this.registerFileTranscription(
          operationId,
          "deepgram",
          () => abortController.abort(),
          event.sender
        );
        try {
          const result = await this.deepgramAsrClient.transcribe({
            audioBuffer: toBoundedAudioBuffer(audioBuffer, "Deepgram audio buffer"),
            apiKey,
            endpoint,
            model,
            language,
            mimeType,
            signal: abortController.signal,
            onProgress: (progress) => {
              if (event.sender.isDestroyed() || abortController.signal.aborted) {
                return;
              }
              event.sender.send("deepgram-batch-progress", progress);
            },
          });

          return {
            text: result.text,
            requestId: result.requestId,
            requestIds: result.requestIds,
            model: result.model,
            chunkCount: result.chunkCount,
            transcribedChunks: result.transcribedChunks,
            emptyChunks: result.emptyChunks,
            detectedLanguage: result.detectedLanguage,
          };
        } finally {
          unregister();
        }
      }
    );

    ipcMain.handle("proxy-deepgram-transcription-file", async (event, filePath, options = {}) => {
      const { endpoint, model, language, apiKey: inputApiKey, mimeType } = options || {};
      const licenseGate = await this.checkLicenseGate();
      if (!licenseGate.allowed) {
        return this.buildLicenseDeniedResponse(licenseGate.status);
      }

      const validation = await validateReadableAudioFilePath(filePath, {
        maxBytes: MAX_CLOUD_AUDIO_FILE_BYTES,
      });
      if (!validation.ok) return validation.response;

      const apiKey = String(inputApiKey || this.environmentManager.getDeepgramKey() || "").trim();
      const abortController = new AbortController();
      const unregister = this.registerFileTranscription(
        options?.operationId,
        "deepgram",
        () => abortController.abort(),
        event.sender
      );
      try {
        const result = await this.deepgramAsrClient.transcribeFile({
          filePath: validation.filePath,
          apiKey,
          endpoint,
          model,
          language,
          mimeType,
          timeoutMs: 2 * 60 * 60 * 1000,
          signal: abortController.signal,
          onProgress: (progress) => {
            if (event.sender.isDestroyed() || abortController.signal.aborted) {
              return;
            }
            event.sender.send("deepgram-batch-progress", progress);
          },
        });

        return {
          text: result.text,
          requestId: result.requestId,
          requestIds: result.requestIds,
          model: result.model,
          chunkCount: result.chunkCount,
          transcribedChunks: result.transcribedChunks,
          emptyChunks: result.emptyChunks,
          detectedLanguage: result.detectedLanguage,
        };
      } finally {
        unregister();
      }
    });

    ipcMain.handle("test-soniox-connection", async (event, args = {}) => {
      const licenseGate = await this.checkLicenseGate();
      if (!licenseGate.allowed) {
        return this.buildLicenseDeniedResponse(licenseGate.status);
      }

      const apiKey = String(args.apiKey || this.environmentManager.getSonioxKey() || "").trim();
      const result = await this.sonioxAsrClient.testConnection({
        apiKey,
        model: args.model,
        language: args.language,
      });

      return {
        success: true,
        resolvedModelId: result.resolvedModelId,
        clientReferenceId: result.clientReferenceId,
      };
    });

    ipcMain.handle(
      "proxy-soniox-transcription",
      async (event, { audioBuffer, model, language, apiKey: inputApiKey, operationId } = {}) => {
        const licenseGate = await this.checkLicenseGate();
        if (!licenseGate.allowed) {
          return this.buildLicenseDeniedResponse(licenseGate.status);
        }

        const apiKey = String(inputApiKey || this.environmentManager.getSonioxKey() || "").trim();
        const abortController = new AbortController();
        const unregister = this.registerFileTranscription(
          operationId,
          "soniox",
          () => abortController.abort(),
          event.sender
        );
        try {
          const result = await this.sonioxAsrClient.transcribe({
            audioBuffer: toBoundedAudioBuffer(audioBuffer, "Soniox audio buffer"),
            apiKey,
            model,
            language,
            signal: abortController.signal,
          });

          return {
            text: result.text,
            clientReferenceId: result.clientReferenceId,
            model: result.model,
          };
        } finally {
          unregister();
        }
      }
    );

    ipcMain.handle("proxy-soniox-transcription-file", async (event, filePath, options = {}) => {
      const { model, language, apiKey: inputApiKey } = options || {};
      const licenseGate = await this.checkLicenseGate();
      if (!licenseGate.allowed) {
        return this.buildLicenseDeniedResponse(licenseGate.status);
      }

      const validation = await validateReadableAudioFilePath(filePath, {
        maxBytes: MAX_CLOUD_AUDIO_FILE_BYTES,
      });
      if (!validation.ok) return validation.response;

      const apiKey = String(inputApiKey || this.environmentManager.getSonioxKey() || "").trim();
      const abortController = new AbortController();
      const unregister = this.registerFileTranscription(
        options?.operationId,
        "soniox",
        () => abortController.abort(),
        event.sender
      );
      try {
        const result = await this.sonioxAsrClient.transcribeFile({
          filePath: validation.filePath,
          apiKey,
          model,
          language,
          timeoutMs: 2 * 60 * 60 * 1000,
          signal: abortController.signal,
        });

        return {
          text: result.text,
          clientReferenceId: result.clientReferenceId,
          model: result.model,
        };
      } finally {
        unregister();
      }
    });

    ipcMain.handle("get-custom-transcription-key", async (_event, options) => {
      return this.environmentManager.getCustomTranscriptionKey({
        allowKeychain: allowKeychainAccess(options),
      });
    });

    ipcMain.handle("save-custom-transcription-key", async (event, key) => {
      return this.environmentManager.saveCustomTranscriptionKey(key);
    });

    ipcMain.handle("get-custom-reasoning-key", async (_event, options) => {
      return this.environmentManager.getCustomReasoningKey({
        allowKeychain: allowKeychainAccess(options),
      });
    });

    ipcMain.handle("save-custom-reasoning-key", async (event, key) => {
      return this.environmentManager.saveCustomReasoningKey(key);
    });

    ipcMain.handle("get-granite-runtime-api-key", async (_event, options) => {
      return this.environmentManager.getGraniteRuntimeApiKey({
        allowKeychain: allowKeychainAccess(options),
      });
    });

    ipcMain.handle("save-granite-runtime-api-key", async (_event, key) => {
      return this.environmentManager.saveGraniteRuntimeApiKey(key);
    });

    ipcMain.handle("get-cohere-runtime-api-key", async (_event, options) => {
      return this.environmentManager.getCohereRuntimeApiKey({
        allowKeychain: allowKeychainAccess(options),
      });
    });

    ipcMain.handle("save-cohere-runtime-api-key", async (_event, key) => {
      return this.environmentManager.saveCohereRuntimeApiKey(key);
    });

    ipcMain.handle("get-bedrock-credentials", async (_event, options) => {
      return this.environmentManager.getBedrockCredentials({
        allowKeychain: allowKeychainAccess(options),
      });
    });

    ipcMain.handle("save-bedrock-credential", async (_event, key, value) => {
      return this.environmentManager.saveBedrockCredential(key, value);
    });

    ipcMain.handle("proxy-reasoning-request", async (event, payload) => {
      return this.proxyReasoningRequest(event, payload);
    });

    ipcMain.handle("cancel-reasoning-proxy-request", (event, payload) => {
      return this.cancelReasoningProxyRequest(event, payload);
    });

    ipcMain.handle("get-license-api-base-url", async () => {
      return this.environmentManager.getLicenseApiBaseUrl();
    });

    ipcMain.handle("save-license-api-base-url", async (_event, url) => {
      const result = await this.environmentManager.saveLicenseApiBaseUrl(url);
      if (result?.success) {
        this.licenseManager?.refreshConfig?.();
      }
      return result;
    });

    ipcMain.handle("license-get-status", async (_event, options) => {
      if (!this.licenseManager) {
        return {
          success: false,
          configured: false,
          status: "unlicensed",
          isActive: false,
          keyPresent: false,
          error: "LICENSE_MANAGER_UNAVAILABLE",
          message: "License manager is not available.",
        };
      }

      return this.licenseManager.getStatus({
        allowKeychain: allowKeychainAccess(options),
        passive: !allowKeychainAccess(options),
      });
    });

    ipcMain.handle("license-ensure-pro-access", async () => {
      if (!this.licenseManager) {
        return {
          success: false,
          configured: false,
          status: "unlicensed",
          isActive: false,
          keyPresent: false,
          error: "LICENSE_MANAGER_UNAVAILABLE",
          message: "License manager is not available.",
        };
      }

      return this.licenseManager.ensureProAccess();
    });

    ipcMain.handle("license-activate", async (_event, licenseKey) => {
      if (!this.licenseManager) {
        return {
          success: false,
          configured: false,
          status: "unlicensed",
          isActive: false,
          keyPresent: false,
          error: "LICENSE_MANAGER_UNAVAILABLE",
          message: "License manager is not available.",
        };
      }

      return this.licenseManager.activateLicense(licenseKey);
    });

    ipcMain.handle("license-validate", async () => {
      if (!this.licenseManager) {
        return {
          success: false,
          configured: false,
          status: "unlicensed",
          isActive: false,
          keyPresent: false,
          error: "LICENSE_MANAGER_UNAVAILABLE",
          message: "License manager is not available.",
        };
      }

      return this.licenseManager.validateLicense();
    });

    ipcMain.handle("license-clear", async () => {
      if (!this.licenseManager) {
        return {
          success: false,
          configured: false,
          status: "unlicensed",
          isActive: false,
          keyPresent: false,
          error: "LICENSE_MANAGER_UNAVAILABLE",
          message: "License manager is not available.",
        };
      }

      return this.licenseManager.clearLicense();
    });

    // Dictation key handlers for reliable persistence across restarts
    ipcMain.handle("get-dictation-key", async () => {
      return this.environmentManager.getDictationKey();
    });

    ipcMain.handle("save-dictation-key", async (event, key) => {
      return this.environmentManager.saveDictationKey(key);
    });

    ipcMain.handle("get-activation-mode", async () => {
      return this.environmentManager.getActivationMode();
    });

    ipcMain.handle("save-activation-mode", async (event, mode) => {
      return this.environmentManager.saveActivationMode(mode);
    });

    ipcMain.handle("save-anthropic-key", async (event, key) => {
      return this.environmentManager.saveAnthropicKey(key);
    });

    ipcMain.handle("save-openrouter-key", async (event, key) => {
      return this.environmentManager.saveOpenRouterKey(key);
    });

    ipcMain.handle("get-ui-language", async () => {
      return this.environmentManager.getUiLanguage();
    });

    ipcMain.handle("save-ui-language", async (event, language) => {
      return this.environmentManager.saveUiLanguage(language);
    });

    ipcMain.handle("get-model-storage-root", async () => {
      return this.environmentManager.getModelStorageRoot();
    });

    ipcMain.handle("save-model-storage-root", async (event, rootPath) => {
      return this.environmentManager.saveModelStorageRoot(rootPath, {
        onProgress: (progress) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send("model-storage-migration-progress", progress);
          }
        },
      });
    });

    ipcMain.handle("pick-model-storage-root", async (event, defaultPath = "") => {
      const fallbackPath = String(defaultPath || "").trim() || getSpeechModelsRoot();
      const result = await dialog.showOpenDialog({
        title: "Select model storage location",
        defaultPath: fallbackPath,
        properties: ["openDirectory", "createDirectory"],
      });

      if (result.canceled || !result.filePaths?.[0]) {
        return { success: false, cancelled: true, path: null };
      }

      try {
        const normalizedPath = validateModelsStorageRoot(result.filePaths[0]);
        return {
          success: true,
          path: normalizedPath,
          selectedPath: path.resolve(result.filePaths[0]),
          cancelled: false,
        };
      } catch (error) {
        return {
          success: false,
          path: null,
          cancelled: false,
          error: error.message,
        };
      }
    });

    ipcMain.handle("set-ui-language", async (event, language) => {
      const result = await this.environmentManager.saveUiLanguage(language);
      if (!result?.success) {
        return result;
      }
      process.env.UI_LANGUAGE = result.language;
      changeLanguage(result.language);
      this.windowManager?.refreshLocalizedUi?.();
      this.getTrayManager?.()?.updateTrayMenu?.();
      return { success: true, language: result.language };
    });

    ipcMain.handle("save-all-keys-to-env", async () => {
      return this.environmentManager.saveAllKeysToEnvFile();
    });

    ipcMain.handle("import-environment-settings", async (_event, values = {}) => {
      return this.environmentManager.importSettingsValues(values);
    });

    ipcMain.handle("sync-startup-preferences", async (event, prefs) => {
      const setVars = {};
      const clearVars = ["SENSEVOICE_MODEL_PATH", "SENSEVOICE_BINARY_PATH"];
      const rawLocalProvider = String(prefs.localTranscriptionProvider || "whisper");
      const localTranscriptionProvider = ["nvidia", "paraformer", "granite", "cohere"].includes(
        rawLocalProvider
      )
        ? rawLocalProvider
        : "whisper";

      if (prefs.useLocalWhisper && prefs.model) {
        // Local mode with model selected - set provider and model for pre-warming
        setVars.LOCAL_TRANSCRIPTION_PROVIDER = localTranscriptionProvider;
        if (localTranscriptionProvider === "nvidia") {
          setVars.PARAKEET_MODEL = prefs.model;
          clearVars.push(
            "LOCAL_WHISPER_MODEL",
            "PARAFORMER_MODEL",
            "GRANITE_MODEL",
            "COHERE_MODEL",
            "GRANITE_RUNTIME_URL",
            "COHERE_RUNTIME_URL"
          );
        } else if (localTranscriptionProvider === "paraformer") {
          setVars.PARAFORMER_MODEL = prefs.model;
          clearVars.push(
            "LOCAL_WHISPER_MODEL",
            "PARAKEET_MODEL",
            "GRANITE_MODEL",
            "COHERE_MODEL",
            "GRANITE_RUNTIME_URL",
            "COHERE_RUNTIME_URL"
          );
        } else if (localTranscriptionProvider === "granite") {
          setVars.GRANITE_MODEL = prefs.model;
          if (prefs.externalRuntimeUrl) {
            setVars.GRANITE_RUNTIME_URL = prefs.externalRuntimeUrl;
          } else {
            clearVars.push("GRANITE_RUNTIME_URL");
          }
          clearVars.push(
            "PARAKEET_MODEL",
            "PARAFORMER_MODEL",
            "COHERE_MODEL",
            "LOCAL_WHISPER_MODEL",
            "COHERE_RUNTIME_URL"
          );
        } else if (localTranscriptionProvider === "cohere") {
          setVars.COHERE_MODEL = prefs.model;
          if (prefs.externalRuntimeUrl) {
            setVars.COHERE_RUNTIME_URL = prefs.externalRuntimeUrl;
          } else {
            clearVars.push("COHERE_RUNTIME_URL");
          }
          clearVars.push(
            "PARAKEET_MODEL",
            "PARAFORMER_MODEL",
            "GRANITE_MODEL",
            "LOCAL_WHISPER_MODEL",
            "GRANITE_RUNTIME_URL"
          );
        } else {
          setVars.LOCAL_WHISPER_MODEL = prefs.model;
          clearVars.push(
            "PARAKEET_MODEL",
            "PARAFORMER_MODEL",
            "GRANITE_MODEL",
            "COHERE_MODEL",
            "GRANITE_RUNTIME_URL",
            "COHERE_RUNTIME_URL"
          );
        }
      } else if (prefs.useLocalWhisper) {
        // Local mode enabled but no model selected - clear pre-warming vars
        clearVars.push(
          "LOCAL_TRANSCRIPTION_PROVIDER",
          "PARAKEET_MODEL",
          "PARAFORMER_MODEL",
          "LOCAL_WHISPER_MODEL",
          "GRANITE_MODEL",
          "COHERE_MODEL",
          "GRANITE_RUNTIME_URL",
          "COHERE_RUNTIME_URL"
        );
      } else {
        // Cloud mode - clear all local transcription vars
        clearVars.push(
          "LOCAL_TRANSCRIPTION_PROVIDER",
          "PARAKEET_MODEL",
          "PARAFORMER_MODEL",
          "LOCAL_WHISPER_MODEL",
          "GRANITE_MODEL",
          "COHERE_MODEL",
          "GRANITE_RUNTIME_URL",
          "COHERE_RUNTIME_URL"
        );
      }

      if (prefs.reasoningProvider === "local" && prefs.reasoningModel) {
        setVars.REASONING_PROVIDER = "local";
        setVars.LOCAL_REASONING_MODEL = prefs.reasoningModel;
      } else if (prefs.reasoningProvider && prefs.reasoningProvider !== "local") {
        clearVars.push("REASONING_PROVIDER", "LOCAL_REASONING_MODEL");
      }

      this._syncStartupEnv(setVars, clearVars);
    });

    // Local reasoning handler
    ipcMain.handle("process-local-reasoning", async (event, text, modelId, _agentName, config) => {
      if (this.shuttingDown) {
        return {
          success: false,
          error: "Application is shutting down",
          code: "ERR_APP_SHUTTING_DOWN",
        };
      }
      const licenseGate = await this.checkLicenseGate();
      if (!licenseGate.allowed) {
        return this.buildLicenseDeniedResponse(licenseGate.status);
      }

      try {
        const safeText = toBoundedString(text, "local reasoning text", MAX_IPC_TEXT_LENGTH);
        const safeModelId = toBoundedString(
          modelId,
          "local reasoning model",
          MAX_IPC_REASONING_ID_LENGTH
        );
        const safeConfig = sanitizeReasoningConfig(config);
        const controller = new AbortController();
        const stopTracking = this.trackCancellableReasoningTask(
          event,
          safeConfig.requestId,
          controller
        );
        safeConfig.signal = controller.signal;
        const LocalReasoningService = require("../services/localReasoningBridge").default;
        try {
          const result = await LocalReasoningService.processText(safeText, safeModelId, safeConfig);
          return { success: true, text: result };
        } finally {
          stopTracking();
        }
      } catch (error) {
        return { success: false, error: error.message, code: error.code };
      }
    });

    // Anthropic reasoning handler
    ipcMain.handle(
      "process-anthropic-reasoning",
      async (event, text, modelId, _agentName, config) => {
        if (this.shuttingDown) {
          return {
            success: false,
            error: "Application is shutting down",
            code: "ERR_APP_SHUTTING_DOWN",
          };
        }
        const licenseGate = await this.checkLicenseGate();
        if (!licenseGate.allowed) {
          return this.buildLicenseDeniedResponse(licenseGate.status);
        }

        try {
          const apiKey = this.environmentManager.getAnthropicKey();

          if (!apiKey) {
            throw new Error("Anthropic API key not configured");
          }

          const safeText = toBoundedString(text, "Anthropic reasoning text", MAX_IPC_TEXT_LENGTH);
          const safeModelId = toBoundedString(
            modelId,
            "Anthropic reasoning model",
            MAX_IPC_REASONING_ID_LENGTH
          );
          const safeConfig = sanitizeReasoningConfig(config);
          const systemPrompt = safeConfig.systemPrompt || "";
          const userPrompt = safeText;

          if (!safeModelId) {
            throw new Error("No model specified for Anthropic API call");
          }

          const requestBody = buildAnthropicReasoningRequestBody({
            model: safeModelId,
            userPrompt,
            systemPrompt,
            maxTokens: safeConfig.maxTokens || Math.max(100, Math.min(safeText.length * 2, 4096)),
            temperature: safeConfig.temperature ?? 0.3,
            effort: safeConfig.effort,
          });

          const controller = new AbortController();
          const stopTracking = this.trackCancellableReasoningTask(
            event,
            safeConfig.requestId,
            controller
          );
          const timeoutId = setTimeout(() => controller.abort(), ANTHROPIC_REASONING_TIMEOUT_MS);
          let response;
          try {
            response = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-API-Key": apiKey,
                "anthropic-version": "2023-06-01",
              },
              body: JSON.stringify(requestBody),
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timeoutId);
            stopTracking();
          }

          if (!response.ok) {
            const errorText = await response.text();
            let errorData = { error: response.statusText };
            try {
              errorData = JSON.parse(errorText);
            } catch {
              errorData = { error: errorText || response.statusText };
            }
            throw new Error(
              errorData.error?.message ||
                errorData.error ||
                `Anthropic API error: ${response.status}`
            );
          }

          const data = await response.json();
          return { success: true, text: data.content[0].text.trim() };
        } catch (error) {
          debugLogger.error("Anthropic reasoning error:", error);
          return { success: false, error: error.message, code: error.code };
        }
      }
    );

    // Check if local reasoning is available
    ipcMain.handle("check-local-reasoning-available", async () => {
      try {
        const LocalReasoningService = require("../services/localReasoningBridge").default;
        return await LocalReasoningService.isAvailable();
      } catch (error) {
        return false;
      }
    });

    // llama.cpp installation handlers
    ipcMain.handle("llama-cpp-check", async () => {
      try {
        const llamaCppInstaller = require("./llamaCppInstaller").default;
        const isInstalled = await llamaCppInstaller.isInstalled();
        const version = isInstalled ? await llamaCppInstaller.getVersion() : null;
        return { isInstalled, version };
      } catch (error) {
        return { isInstalled: false, error: error.message };
      }
    });

    ipcMain.handle("llama-cpp-install", async () => {
      try {
        const llamaCppInstaller = require("./llamaCppInstaller").default;
        const result = await llamaCppInstaller.install();
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("llama-cpp-uninstall", async () => {
      try {
        const llamaCppInstaller = require("./llamaCppInstaller").default;
        const result = await llamaCppInstaller.uninstall();
        return result;
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    // llama-server management handlers
    ipcMain.handle("llama-server-start", async (event, modelId) => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        const modelInfo = modelManager.findModelById(modelId);
        if (!modelInfo) {
          return { success: false, error: `Model "${modelId}" not found` };
        }

        const modelPath = require("path").join(modelManager.modelsDir, modelInfo.model.fileName);

        await modelManager.serverManager.start(modelPath, {
          contextSize: modelInfo.model.contextLength || 4096,
          threads: 4,
        });
        modelManager.currentServerModelId = modelId;

        return { success: true, port: modelManager.serverManager.port };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("llama-server-stop", async () => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        await modelManager.stopServer();
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("llama-server-status", async () => {
      try {
        const modelManager = require("./modelManagerBridge").default;
        return modelManager.getServerStatus();
      } catch (error) {
        return { available: false, running: false, error: error.message };
      }
    });

    ipcMain.handle("get-log-level", async () => {
      return debugLogger.getLevel();
    });

    ipcMain.handle("app-log", async (event, entry) => {
      debugLogger.logEntry(entry);
      return { success: true };
    });

    const SYSTEM_SETTINGS_URLS = {
      darwin: {
        microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        sound: "x-apple.systempreferences:com.apple.preference.sound?input",
        accessibility:
          "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        screenRecording:
          "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      },
      win32: {
        microphone: "ms-settings:privacy-microphone",
        sound: "ms-settings:sound",
      },
    };

    const openSystemSettings = async (settingType) => {
      const platform = process.platform;
      const urls = SYSTEM_SETTINGS_URLS[platform];
      const url = urls?.[settingType];

      if (!url) {
        // Platform doesn't support this settings URL
        const messages = {
          microphone: i18nMain.t("systemSettings.microphone"),
          sound: i18nMain.t("systemSettings.sound"),
          accessibility: i18nMain.t("systemSettings.accessibility"),
        };
        return {
          success: false,
          error:
            messages[settingType] || `${settingType} settings are not available on this platform.`,
        };
      }

      try {
        await shell.openExternal(url);
        return { success: true };
      } catch (error) {
        debugLogger.error(`Failed to open ${settingType} settings:`, error);
        return { success: false, error: error.message };
      }
    };

    ipcMain.handle("open-microphone-settings", () => openSystemSettings("microphone"));
    ipcMain.handle("open-sound-input-settings", () => openSystemSettings("sound"));
    ipcMain.handle("open-accessibility-settings", () => openSystemSettings("accessibility"));
    ipcMain.handle("open-mac-privacy-helper-settings", (_event, permission) => {
      const settingType = permission === "screenRecording" ? "screenRecording" : "accessibility";
      return openSystemSettings(settingType);
    });
    ipcMain.handle("get-mac-accessibility-guidance", async () => getMacAccessibilityGuidance());

    ipcMain.handle("request-microphone-access", async () => {
      if (process.platform !== "darwin") {
        return { granted: true };
      }
      const { systemPreferences } = require("electron");
      const granted = await systemPreferences.askForMediaAccess("microphone");
      return { granted };
    });

    ipcMain.handle("get-microphone-access-status", () => {
      if (process.platform !== "darwin") {
        return { status: "unknown" };
      }
      try {
        const { systemPreferences } = require("electron");
        return { status: systemPreferences.getMediaAccessStatus("microphone") };
      } catch (error) {
        debugLogger.warn("Failed to read microphone permission status", {
          error: error?.message,
        });
        return { status: "unknown" };
      }
    });

    // Auth: clear all session cookies for sign-out.
    // This clears every cookie in the renderer session rather than targeting
    // individual auth cookies, which is acceptable because the app only sets
    // cookies for Neon Auth. Avoids CSRF/Origin header issues that occur when
    // the renderer tries to call the server-side sign-out endpoint directly.
    ipcMain.handle("auth-clear-session", async (event) => {
      try {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) {
          await win.webContents.session.clearStorageData({ storages: ["cookies"] });
        }
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to clear auth session:", error);
        return { success: false, error: error.message };
      }
    });

    // --- ChordVox Cloud API handlers ---

    // In production, VITE_* env vars aren't available in the main process because
    // Vite only inlines them into the renderer bundle at build time. Load the
    // runtime-env.json that the Vite build writes to src/dist/ as a fallback.
    const runtimeEnv = (() => {
      const fs = require("fs");
      const envPath = path.join(app.getAppPath(), "src", "dist", "runtime-env.json");
      try {
        if (fs.existsSync(envPath)) return JSON.parse(fs.readFileSync(envPath, "utf8"));
      } catch {}
      return {};
    })();

    const getApiUrl = () =>
      process.env.CHORDVOX_API_URL ||
      process.env.VITE_CHORDVOX_API_URL ||
      runtimeEnv.VITE_CHORDVOX_API_URL ||
      "";

    const getAuthUrl = () =>
      process.env.NEON_AUTH_URL ||
      process.env.VITE_NEON_AUTH_URL ||
      runtimeEnv.VITE_NEON_AUTH_URL ||
      "";

    const getSessionCookiesFromWindow = async (win) => {
      const scopedUrls = getCookieLookupUrls([getAuthUrl(), getApiUrl()].filter(Boolean));
      const cookiesByName = new Map();

      for (const url of scopedUrls) {
        try {
          const scopedCookies = await win.webContents.session.cookies.get({ url });
          for (const cookie of scopedCookies) {
            if (!cookiesByName.has(cookie.name)) {
              cookiesByName.set(cookie.name, cookie.value);
            }
          }
        } catch (error) {
          debugLogger.warn("Failed to read scoped auth cookies", {
            url,
            error: error.message,
          });
        }
      }

      const cookieHeader = [...cookiesByName.entries()]
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");

      debugLogger.debug(
        "Resolved auth cookies for cloud request",
        {
          cookieCount: cookiesByName.size,
          scopedUrls,
        },
        "auth"
      );

      return cookieHeader;
    };

    const getSessionCookies = async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return "";
      return getSessionCookiesFromWindow(win);
    };

    ipcMain.handle("cloud-transcribe", async (event, audioBuffer, opts = {}) => {
      if (!HOSTED_CLOUD_FEATURES_ENABLED) return hostedCloudUnavailableResponse();

      const abortController = new AbortController();
      const unregister = this.registerFileTranscription(
        opts?.operationId,
        "chordvox-cloud",
        () => {
          abortController.abort();
        },
        event.sender
      );
      try {
        const licenseGate = await this.checkLicenseGate();
        if (!licenseGate.allowed) {
          return this.buildLicenseDeniedResponse(licenseGate.status);
        }

        const apiUrl = getApiUrl();
        if (!apiUrl) throw new Error("ChordVox API URL not configured");

        const cookieHeader = await getSessionCookies(event);
        if (!cookieHeader) throw new Error("No session cookies available");

        const audioData = toBoundedAudioBuffer(audioBuffer, "cloud transcription audio buffer");
        const boundary = `----ChordVox${crypto.randomBytes(16).toString("hex")}`;
        const parts = [];
        const language = normalizeCloudMultipartField(opts.language, 32);
        const prompt = normalizeCloudMultipartField(opts.prompt, 8000);

        parts.push(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="file"; filename="audio.webm"\r\n` +
            `Content-Type: audio/webm\r\n\r\n`
        );
        parts.push(audioData);
        parts.push("\r\n");

        if (language) {
          appendMultipartField(parts, boundary, "language", language);
        }

        if (prompt) {
          appendMultipartField(parts, boundary, "prompt", prompt);
        }

        // Add client metadata for logging
        appendMultipartField(parts, boundary, "clientType", "desktop");
        appendMultipartField(parts, boundary, "appVersion", app.getVersion());
        appendMultipartField(parts, boundary, "sessionId", this.sessionId);

        parts.push(`--${boundary}--\r\n`);

        const bodyParts = parts.map((p) => (typeof p === "string" ? Buffer.from(p) : p));
        const body = Buffer.concat(bodyParts);

        debugLogger.debug(
          "Cloud transcribe request",
          { audioSize: audioData.length, bodySize: body.length },
          "cloud-api"
        );

        if (abortController.signal.aborted) {
          const err = new Error("Cloud transcription cancelled.");
          err.code = "ABORT_ERR";
          throw err;
        }

        const url = new URL(`${apiUrl}/api/transcribe`);
        const httpModule = url.protocol === "https:" ? https : http;

        const data = await new Promise((resolve, reject) => {
          let settled = false;
          let req = null;
          const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            abortController.signal.removeEventListener("abort", onAbort);
            fn(value);
          };
          const onAbort = () => {
            const err = new Error("Cloud transcription cancelled.");
            err.code = "ABORT_ERR";
            if (req) {
              req.destroy(err);
            }
            finish(reject, err);
          };
          req = httpModule.request(
            {
              hostname: url.hostname,
              port: url.port || (url.protocol === "https:" ? 443 : 80),
              path: url.pathname,
              method: "POST",
              headers: {
                "Content-Type": `multipart/form-data; boundary=${boundary}`,
                "Content-Length": body.length,
                Cookie: cookieHeader,
              },
            },
            (res) => {
              let responseData = "";
              res.on("data", (chunk) => (responseData += chunk));
              res.on("end", () => {
                try {
                  const parsed = JSON.parse(responseData);
                  finish(resolve, { statusCode: res.statusCode, data: parsed });
                } catch (e) {
                  finish(reject, new Error(`Invalid JSON response: ${responseData.slice(0, 200)}`));
                }
              });
            }
          );
          abortController.signal.addEventListener("abort", onAbort, { once: true });
          req.on("error", (error) => finish(reject, error));
          req.write(body);
          req.end();
        });

        debugLogger.debug(
          "Cloud transcribe response",
          { statusCode: data.statusCode },
          "cloud-api"
        );

        if (data.statusCode === 401) {
          return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
        }
        if (data.statusCode === 429) {
          return {
            success: false,
            error: "Daily word limit reached",
            code: "LIMIT_REACHED",
            limitReached: true,
            ...data.data,
          };
        }
        if (data.statusCode !== 200) {
          throw new Error(data.data?.error || `API error: ${data.statusCode}`);
        }

        return {
          success: true,
          text: data.data.text,
          wordsUsed: data.data.wordsUsed,
          wordsRemaining: data.data.wordsRemaining,
          plan: data.data.plan,
          limitReached: data.data.limitReached || false,
        };
      } catch (error) {
        if (isAudioBufferTooLargeError(error)) {
          return { success: false, error: error.message, code: error.code };
        }
        debugLogger.error("Cloud transcription error", { error: error.message }, "cloud-api");
        return { success: false, error: error.message };
      } finally {
        unregister();
      }
    });

    ipcMain.handle("cloud-reason", async (event, text, opts = {}) => {
      if (!HOSTED_CLOUD_FEATURES_ENABLED) return hostedCloudUnavailableResponse();

      try {
        const licenseGate = await this.checkLicenseGate();
        if (!licenseGate.allowed) {
          return this.buildLicenseDeniedResponse(licenseGate.status);
        }

        const safeText = toBoundedString(text, "cloud reasoning text", MAX_IPC_TEXT_LENGTH);
        const safeOpts = sanitizeCloudReasonOptions(opts);
        const apiUrl = getApiUrl();
        if (!apiUrl) throw new Error("ChordVox API URL not configured");

        debugLogger.debug(
          "Cloud reasoning request",
          {
            apiUrl,
            model: safeOpts.model || "(default)",
            agentName: safeOpts.agentName || "(none)",
            language: safeOpts.language || "(auto)",
            locale: safeOpts.locale || "en",
            hasCustomPrompt: !!safeOpts.customPrompt,
            textLength: safeText.length,
          },
          "cloud-api"
        );

        const cookieHeader = await getSessionCookies(event);
        if (!cookieHeader) throw new Error("No session cookies available");

        debugLogger.debug("Fetching cloud reasoning endpoint", { apiUrl }, "cloud-api");

        const fallbackKey = this.getCloudReasonLowLatencyFallbackKey(apiUrl, safeOpts.model);
        const skipLowLatencyParams = this.isCloudReasonLowLatencyFallbackActive(fallbackKey);
        const buildRequestBody = (includeLowLatencyParams) => {
          const body = {
            text: safeText,
            model: safeOpts.model,
            agentName: safeOpts.agentName,
            customDictionary: safeOpts.customDictionary,
            customPrompt: safeOpts.customPrompt,
            language: safeOpts.language,
            locale: safeOpts.locale,
            sessionId: this.sessionId,
            clientType: "desktop",
            appVersion: app.getVersion(),
          };

          if (includeLowLatencyParams) {
            body.disableThinking = safeOpts.disableThinking;
            body.temperature = safeOpts.temperature;
          }

          return body;
        };
        const fetchCloudReason = (includeLowLatencyParams) =>
          fetch(`${apiUrl}/api/reason`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie: cookieHeader,
            },
            body: JSON.stringify(buildRequestBody(includeLowLatencyParams)),
          });

        const fetchStart = Date.now();
        let response = await fetchCloudReason(!skipLowLatencyParams);
        const fetchMs = Date.now() - fetchStart;

        debugLogger.debug(
          "Cloud reasoning response",
          {
            status: response.status,
            ok: response.ok,
            fetchMs,
          },
          "cloud-api"
        );

        if (!response.ok) {
          if (response.status === 401) {
            debugLogger.debug(
              "Cloud reasoning session expired",
              { status: response.status },
              "cloud-api"
            );
            return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
          }
          let errorData = await response.json().catch(() => ({}));
          if (
            !skipLowLatencyParams &&
            isCloudReasonLowLatencyFallbackError(response.status, errorData)
          ) {
            this.rememberCloudReasonLowLatencyFallback(fallbackKey, {
              apiUrl,
              model: safeOpts.model || "(default)",
              status: response.status,
            });
            response = await fetchCloudReason(false);
            if (response.ok) {
              errorData = null;
            } else {
              errorData = await response.json().catch(() => ({}));
            }
          }

          if (response.ok) {
            const data = await response.json();
            debugLogger.debug(
              "Cloud reasoning succeeded after compatibility fallback",
              {
                model: data.model,
                provider: data.provider,
                processingMs: data.processingMs,
                resultLength: data.text?.length || 0,
              },
              "cloud-api"
            );
            return { success: true, text: data.text, model: data.model, provider: data.provider };
          }

          debugLogger.debug(
            "Cloud reasoning API error",
            { status: response.status, code: errorData.code || errorData.error || null },
            "cloud-api"
          );
          throw new Error(errorData.error || `API error: ${response.status}`);
        }

        const data = await response.json();
        debugLogger.debug(
          "Cloud reasoning succeeded",
          {
            model: data.model,
            provider: data.provider,
            processingMs: data.processingMs,
            resultLength: data.text?.length || 0,
          },
          "cloud-api"
        );
        return { success: true, text: data.text, model: data.model, provider: data.provider };
      } catch (error) {
        debugLogger.error("Cloud reasoning error", {
          code: error.code || error.name || "ERROR",
        });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("cloud-usage", async (event) => {
      if (!HOSTED_CLOUD_FEATURES_ENABLED) return hostedCloudUnavailableResponse();

      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) throw new Error("ChordVox API URL not configured");

        const cookieHeader = await getSessionCookies(event);
        if (!cookieHeader) throw new Error("No session cookies available");

        const response = await fetch(`${apiUrl}/api/usage`, {
          headers: { Cookie: cookieHeader },
        });

        if (!response.ok) {
          if (response.status === 401) {
            return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
          }
          throw new Error(`API error: ${response.status}`);
        }

        const data = await response.json();
        return { success: true, ...data };
      } catch (error) {
        debugLogger.error("Cloud usage fetch error:", error);
        return { success: false, error: error.message };
      }
    });

    const fetchStripeUrl = async (event, endpoint, errorPrefix) => {
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) throw new Error("ChordVox API URL not configured");

        const cookieHeader = await getSessionCookies(event);
        if (!cookieHeader) throw new Error("No session cookies available");

        const response = await fetch(`${apiUrl}${endpoint}`, {
          method: "POST",
          headers: { Cookie: cookieHeader },
        });

        if (!response.ok) {
          if (response.status === 401) {
            return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
          }
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `API error: ${response.status}`);
        }

        const data = await response.json();
        return { success: true, url: data.url };
      } catch (error) {
        debugLogger.error(`${errorPrefix}: ${error.message}`);
        return { success: false, error: error.message };
      }
    };

    ipcMain.handle("cloud-checkout", (event) => {
      if (!HOSTED_CLOUD_FEATURES_ENABLED) return hostedCloudUnavailableResponse();
      return fetchStripeUrl(event, "/api/stripe/checkout", "Cloud checkout error");
    });

    ipcMain.handle("cloud-billing-portal", (event) => {
      if (!HOSTED_CLOUD_FEATURES_ENABLED) return hostedCloudUnavailableResponse();
      return fetchStripeUrl(event, "/api/stripe/portal", "Cloud billing portal error");
    });

    ipcMain.handle("open-model-cache-folder", async (event, rootPath = "") => {
      try {
        const requestedRoot = normalizeModelsRootPath(rootPath);
        const modelsRoot = requestedRoot
          ? validateModelsStorageRoot(requestedRoot)
          : getSpeechModelsRoot();
        await fsPromises.mkdir(modelsRoot, { recursive: true });
        const openError = await shell.openPath(modelsRoot);
        if (openError) {
          throw new Error(openError);
        }
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to open model cache folder:", error);
        return { success: false, error: error.message };
      }
    });

    // Debug logging handlers
    ipcMain.handle("get-debug-state", async () => {
      try {
        return {
          enabled: debugLogger.isEnabled(),
          logPath: debugLogger.getLogPath(),
          logLevel: debugLogger.getLevel(),
        };
      } catch (error) {
        debugLogger.error("Failed to get debug state:", error);
        return { enabled: false, logPath: null, logLevel: "info" };
      }
    });

    ipcMain.handle("set-debug-logging", async (event, enabled) => {
      try {
        const previousLogLevel = process.env.CHORDVOX_LOG_LEVEL;
        process.env.CHORDVOX_LOG_LEVEL = enabled === true ? "debug" : "info";
        try {
          // Use the canonical environment persistence path so this setting is
          // serialized once, written atomically, and kept at mode 0600.
          await this.environmentManager.saveAllKeysToEnvFile({ persistLogLevel: true });
        } catch (error) {
          if (previousLogLevel === undefined) {
            delete process.env.CHORDVOX_LOG_LEVEL;
          } else {
            process.env.CHORDVOX_LOG_LEVEL = previousLogLevel;
          }
          throw error;
        }

        // Refresh logger state
        debugLogger.refreshLogLevel();

        return {
          success: true,
          enabled: debugLogger.isEnabled(),
          logPath: debugLogger.getLogPath(),
        };
      } catch (error) {
        debugLogger.error("Failed to set debug logging:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("open-logs-folder", async () => {
      try {
        const logsDir = path.join(app.getPath("userData"), "logs");
        await fsPromises.mkdir(logsDir, { recursive: true, mode: 0o700 });
        if (process.platform !== "win32") {
          await fsPromises.chmod(logsDir, 0o700);
        }
        const openError = await shell.openPath(logsDir);
        if (openError) {
          throw new Error(openError);
        }
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to open logs folder:", error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("get-call-trace-sessions", async (_event, limit = 20) => {
      try {
        return { success: true, sessions: debugLogger.getCallTraceSessions(limit) };
      } catch (error) {
        debugLogger.error("Failed to load call trace sessions:", error);
        return { success: false, sessions: [], error: error.message };
      }
    });

    ipcMain.handle("get-call-trace-events", async (_event, runId, limit = 80) => {
      try {
        return {
          success: true,
          events: debugLogger.getCallTraceEvents(runId, limit),
        };
      } catch (error) {
        debugLogger.error("Failed to load call trace events:", error);
        return { success: false, events: [], error: error.message };
      }
    });

    ipcMain.handle("clear-call-traces", async () => {
      try {
        debugLogger.clearCallTraces();
        return { success: true };
      } catch (error) {
        debugLogger.error("Failed to clear call traces:", error);
        return { success: false, error: error.message };
      }
    });

    // Update handlers
    ipcMain.handle("check-for-updates", async () => {
      return this.updateManager.checkForUpdates();
    });

    ipcMain.handle("download-update", async () => {
      return this.updateManager.downloadUpdate();
    });

    ipcMain.handle("install-update", async () => {
      return this.updateManager.installUpdate();
    });

    ipcMain.handle("get-app-version", async () => {
      return this.updateManager.getAppVersion();
    });

    ipcMain.handle("get-update-status", async () => {
      return this.updateManager.getUpdateStatus();
    });

    ipcMain.handle("get-update-info", async () => {
      return this.updateManager.getUpdateInfo();
    });

    // --- Sherpa-onnx Local Streaming handlers ---

    ipcMain.handle("sherpa-streaming-transcribe-file", async (event, audioBlob, options = {}) => {
      const unregister = this.registerFileTranscription(
        options?.operationId,
        "local-streaming",
        () => this.sherpaStreaming?.cancelFileTranscription?.(),
        event.sender
      );
      try {
        if (!this.sherpaStreaming) {
          this.sherpaStreaming = new SherpaStreamingManager();
        }

        const result = await this.sherpaStreaming.transcribeFile(audioBlob, options);

        if (!result.success && result.message === "No audio detected") {
          event.sender.send("no-audio-detected");
        }

        return result;
      } catch (error) {
        const errorMessage = error.message || "Unknown error";

        if (errorMessage.includes("FFmpeg not found")) {
          return {
            success: false,
            error: "ffmpeg_not_found",
            message: "FFmpeg is missing. Please reinstall the app or install FFmpeg manually.",
          };
        }

        if (
          errorMessage.includes("FFmpeg exited") ||
          errorMessage.includes("FFmpeg process error") ||
          errorMessage.includes("conversion")
        ) {
          return {
            success: false,
            error: "ffmpeg_error",
            message: "Audio conversion failed. The selected file may be corrupted.",
          };
        }

        if (
          errorMessage.includes("Model not downloaded") ||
          errorMessage.includes("Unknown streaming model")
        ) {
          return {
            success: false,
            error: "model_not_found",
            message: errorMessage,
          };
        }

        if (errorMessage.includes("Audio buffer is empty")) {
          return {
            success: false,
            error: "no_audio_data",
            message: "No audio detected",
          };
        }

        if (errorMessage.includes("busy with a live session")) {
          return {
            success: false,
            error: "streaming_busy",
            message: errorMessage,
          };
        }

        debugLogger.error(
          "Sherpa file transcription error",
          { error: errorMessage },
          "sherpa-streaming"
        );

        return {
          success: false,
          error: error.code || "SHERPA_FILE_TRANSCRIPTION_FAILED",
          message: errorMessage,
        };
      } finally {
        unregister();
      }
    });

    ipcMain.handle(
      "sherpa-streaming-transcribe-file-path",
      async (event, filePath, options = {}) => {
        const unregister = this.registerFileTranscription(
          options?.operationId,
          "local-streaming",
          () => this.sherpaStreaming?.cancelFileTranscription?.(),
          event.sender
        );
        try {
          const validation = await validateReadableAudioFilePath(filePath);
          if (!validation.ok) return validation.response;

          if (!this.sherpaStreaming) {
            this.sherpaStreaming = new SherpaStreamingManager();
          }

          const result = await this.sherpaStreaming.transcribeFilePath(
            validation.filePath,
            options
          );

          if (!result.success && result.message === "No audio detected") {
            event.sender.send("no-audio-detected");
          }

          return result;
        } catch (error) {
          const errorMessage = error.message || "Unknown error";

          if (errorMessage.includes("FFmpeg not found")) {
            return {
              success: false,
              error: "ffmpeg_not_found",
              message: "FFmpeg is missing. Please reinstall the app or install FFmpeg manually.",
            };
          }

          if (
            errorMessage.includes("FFmpeg exited") ||
            errorMessage.includes("FFmpeg process error") ||
            errorMessage.includes("conversion")
          ) {
            return {
              success: false,
              error: "ffmpeg_error",
              message: "Audio conversion failed. The selected file may be corrupted.",
            };
          }

          if (
            errorMessage.includes("Model not downloaded") ||
            errorMessage.includes("Unknown streaming model")
          ) {
            return {
              success: false,
              error: "model_not_found",
              message: errorMessage,
            };
          }

          if (errorMessage.includes("busy with a live session")) {
            return {
              success: false,
              error: "streaming_busy",
              message: errorMessage,
            };
          }

          return {
            success: false,
            error: error.code || "sherpa_streaming_file_failed",
            message: errorMessage,
          };
        } finally {
          unregister();
        }
      }
    );

    ipcMain.handle("sherpa-streaming-get-models", async (_event, options = {}) => {
      try {
        if (!this.sherpaStreaming) {
          this.sherpaStreaming = new SherpaStreamingManager();
        }
        const models = await this.sherpaStreaming.getAvailableModels(options.modelsDir || "");
        return { success: true, models };
      } catch (error) {
        debugLogger.error("Sherpa get models error", { error: error.message }, "sherpa-streaming");
        return { success: false, error: error.message, models: [] };
      }
    });

    ipcMain.handle("sherpa-streaming-check-model", async (_event, payload = {}) => {
      try {
        if (!this.sherpaStreaming) {
          this.sherpaStreaming = new SherpaStreamingManager();
        }
        const modelId = typeof payload === "string" ? payload : payload.modelId;
        const modelsDir = typeof payload === "string" ? "" : payload.modelsDir || "";
        return { success: true, ready: this.sherpaStreaming.isModelReady(modelId, modelsDir) };
      } catch (error) {
        return { success: false, ready: false, error: error.message };
      }
    });

    ipcMain.handle("sherpa-streaming-download-model", async (event, payload = {}) => {
      try {
        if (!this.sherpaStreaming) {
          this.sherpaStreaming = new SherpaStreamingManager();
        }

        const modelId = typeof payload === "string" ? payload : payload.modelId;
        const modelsDir = typeof payload === "string" ? "" : payload.modelsDir || "";
        const downloadOptions =
          typeof payload === "string"
            ? {}
            : {
                uiLanguage: payload.uiLanguage || payload.locale || "",
              };

        const result = await this.sherpaStreaming.downloadModel(
          modelId,
          (progressData) => {
            if (!event.sender.isDestroyed()) {
              event.sender.send("sherpa-streaming-download-progress", progressData);
            }
          },
          modelsDir,
          downloadOptions
        );

        return result;
      } catch (error) {
        const modelId = typeof payload === "string" ? payload : payload.modelId;
        const customerError = getCustomerDownloadError(error);
        if (!event.sender.isDestroyed()) {
          event.sender.send("sherpa-streaming-download-progress", {
            type: "error",
            model: modelId,
            error: customerError.message,
            code: customerError.code,
            manualDownloadUrl: customerError.manualDownloadUrl,
            source_count: customerError.sources?.length,
          });
        }

        return {
          success: false,
          error: customerError.message,
          code: customerError.code,
          manualDownloadUrl: customerError.manualDownloadUrl,
          sources: customerError.sources,
        };
      }
    });

    ipcMain.handle("sherpa-streaming-cancel-download", async () => {
      if (!this.sherpaStreaming) {
        this.sherpaStreaming = new SherpaStreamingManager();
      }
      return this.sherpaStreaming.cancelDownload();
    });

    ipcMain.handle("sherpa-streaming-delete-model", async (_event, modelId) => {
      if (!this.sherpaStreaming) {
        this.sherpaStreaming = new SherpaStreamingManager();
      }
      const payload = typeof modelId === "string" ? { modelId, modelsDir: "" } : modelId || {};
      return this.sherpaStreaming.deleteModel(payload.modelId, payload.modelsDir || "");
    });

    ipcMain.handle("sherpa-streaming-delete-all-models", async (_event, options = {}) => {
      if (!this.sherpaStreaming) {
        this.sherpaStreaming = new SherpaStreamingManager();
      }
      return this.sherpaStreaming.deleteAllModels(options.modelsDir || "");
    });

    let sherpaStreamingStartInProgress = false;
    let sherpaStreamingWarmupPromise = null;

    ipcMain.handle("sherpa-streaming-warmup", async (_event, options = {}) => {
      if (sherpaStreamingStartInProgress) {
        debugLogger.debug(
          "Sherpa streaming warmup skipped while start is active",
          {},
          "sherpa-streaming"
        );
        return { success: true, skipped: true, reason: "start-in-progress" };
      }

      if (sherpaStreamingWarmupPromise) {
        debugLogger.debug("Sherpa streaming warmup already in progress", {}, "sherpa-streaming");
        return { success: true, alreadyWarm: false, inProgress: true };
      }

      const warmupPromise = (async () => {
        const modelId = options.modelId || DEFAULT_STREAMING_MODEL_ID;
        const modelsDir = options.modelsDir || "";
        const warmupOptions = { uiLanguage: options.uiLanguage || options.locale || "" };

        if (!this.sherpaStreaming) {
          this.sherpaStreaming = new SherpaStreamingManager();
        }

        if (this.sherpaStreaming.isActive) {
          return { success: true, skipped: true, reason: "active-stream" };
        }

        const status = await this.sherpaStreaming.getStatus().catch(() => null);
        if (
          status?.hasRecognizer &&
          status.currentModelId === modelId &&
          status.workerRunning !== false
        ) {
          return { success: true, alreadyWarm: true, modelId };
        }

        const result = await this.sherpaStreaming.warmupModel(modelId, modelsDir, warmupOptions);
        debugLogger.debug("Sherpa streaming warmup completed", result || {}, "sherpa-streaming");
        return result || { success: true, modelId };
      })();

      sherpaStreamingWarmupPromise = warmupPromise;
      try {
        return await warmupPromise;
      } catch (error) {
        debugLogger.warn(
          "Sherpa streaming warmup failed",
          { error: error.message },
          "sherpa-streaming"
        );
        return { success: false, error: error.message };
      } finally {
        if (sherpaStreamingWarmupPromise === warmupPromise) {
          sherpaStreamingWarmupPromise = null;
        }
      }
    });

    ipcMain.handle("sherpa-streaming-start", async (event, options = {}) => {
      if (sherpaStreamingWarmupPromise) {
        debugLogger.debug(
          "Waiting for Sherpa streaming warmup before start",
          {},
          "sherpa-streaming"
        );
        await sherpaStreamingWarmupPromise.catch(() => {});
      }

      if (sherpaStreamingStartInProgress) {
        debugLogger.debug("Sherpa streaming start already in progress", {}, "sherpa-streaming");
        return { success: false, error: "Operation in progress" };
      }

      sherpaStreamingStartInProgress = true;
      try {
        const win = BrowserWindow.fromWebContents(event.sender);
        const modelId = options.modelId || DEFAULT_STREAMING_MODEL_ID;
        const modelsDir = options.modelsDir || "";
        const startOptions = { uiLanguage: options.uiLanguage || options.locale || "" };

        if (!this.sherpaStreaming) {
          this.sherpaStreaming = new SherpaStreamingManager();
        }

        // Stop any active session
        if (this.sherpaStreaming.isActive) {
          debugLogger.debug("Cleaning up stale sherpa session", {}, "sherpa-streaming");
          await this.sherpaStreaming.stopStream().catch(() => {});
        }

        // Set up callbacks to forward transcripts to renderer
        this.sherpaStreaming.onPartialTranscript = (text) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send("sherpa-streaming-partial-transcript", text);
          }
        };

        this.sherpaStreaming.onFinalTranscript = (text) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send("sherpa-streaming-final-transcript", text);
          }
        };

        this.sherpaStreaming.onError = (error) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send("sherpa-streaming-error", error.message || error);
          }
        };

        this.sherpaStreaming.onAutoStopRequested = (payload) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send("sherpa-streaming-auto-stop", payload || {});
          }
        };

        await this.sherpaStreaming.startStream(modelId, modelsDir, startOptions);
        debugLogger.debug("Sherpa streaming started", { modelId }, "sherpa-streaming");

        return { success: true, modelId };
      } catch (error) {
        debugLogger.error(
          "Sherpa streaming start error",
          { error: error.message },
          "sherpa-streaming"
        );
        return { success: false, error: error.message };
      } finally {
        sherpaStreamingStartInProgress = false;
      }
    });

    ipcMain.on("sherpa-streaming-send", (_event, audioBuffer) => {
      try {
        if (!this.sherpaStreaming || !this.sherpaStreaming.isActive) return;
        this.sherpaStreaming.feedAudioChunk(
          toBoundedAudioBuffer(
            audioBuffer,
            "Sherpa streaming audio chunk",
            MAX_STREAMING_AUDIO_CHUNK_BYTES
          )
        );
      } catch (error) {
        debugLogger.error(
          "Sherpa streaming send error",
          { error: error.message },
          "sherpa-streaming"
        );
      }
    });

    ipcMain.handle("sherpa-streaming-stop", async () => {
      try {
        let result = { text: "" };
        if (this.sherpaStreaming) {
          result = await this.sherpaStreaming.stopStream();
        }
        return {
          success: true,
          text: result?.text || "",
          observedSpeech: result?.observedSpeech === true,
          hadVad: result?.hadVad === true,
        };
      } catch (error) {
        debugLogger.error(
          "Sherpa streaming stop error",
          { error: error.message },
          "sherpa-streaming"
        );
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("sherpa-streaming-status", async () => {
      if (!this.sherpaStreaming) {
        return { isActive: false, currentModelId: null };
      }
      return this.sherpaStreaming.getStatus();
    });

    // --- Assembly AI Streaming handlers ---

    // Helper to fetch streaming token
    const fetchStreamingToken = async (event) => {
      await this.requireLicenseGate();

      const apiUrl = getApiUrl();
      if (!apiUrl) {
        throw new Error("ChordVox API URL not configured");
      }

      const cookieHeader = await getSessionCookies(event);
      if (!cookieHeader) {
        throw new Error("No session cookies available");
      }

      const tokenResponse = await fetch(`${apiUrl}/api/streaming-token`, {
        method: "POST",
        headers: {
          Cookie: cookieHeader,
        },
      });

      if (!tokenResponse.ok) {
        if (tokenResponse.status === 401) {
          const err = new Error("Session expired");
          err.code = "AUTH_EXPIRED";
          throw err;
        }
        const errorData = await tokenResponse.json().catch(() => ({}));
        throw new Error(
          errorData.error || `Failed to get streaming token: ${tokenResponse.status}`
        );
      }

      const { token } = await tokenResponse.json();
      if (!token) {
        throw new Error("No token received from API");
      }

      return token;
    };

    ipcMain.handle("assemblyai-streaming-warmup", async (event, options = {}) => {
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) {
          return { success: false, error: "API not configured", code: "NO_API" };
        }

        await this.requireLicenseGate();

        if (!this.assemblyAiStreaming) {
          this.assemblyAiStreaming = new AssemblyAiStreaming();
        }

        if (this.assemblyAiStreaming.hasWarmConnection()) {
          debugLogger.debug("AssemblyAI connection already warm", {}, "streaming");
          this.assemblyAiStreamingAuthorized = true;
          return { success: true, alreadyWarm: true };
        }

        let token = this.assemblyAiStreaming.getCachedToken();
        if (!token) {
          debugLogger.debug("Fetching new streaming token for warmup", {}, "streaming");
          token = await fetchStreamingToken(event);
        }

        await this.assemblyAiStreaming.warmup({ ...options, token });
        this.assemblyAiStreamingAuthorized = true;
        debugLogger.debug("AssemblyAI connection warmed up", {}, "streaming");

        return { success: true };
      } catch (error) {
        if (error.code === "LICENSE_REQUIRED" && error.response) {
          this.assemblyAiStreamingAuthorized = false;
          return error.response;
        }
        debugLogger.error("AssemblyAI warmup error", { error: error.message });
        if (error.code === "AUTH_EXPIRED") {
          return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
        }
        return { success: false, error: error.message };
      }
    });

    let streamingStartInProgress = false;

    ipcMain.handle("assemblyai-streaming-start", async (event, options = {}) => {
      if (streamingStartInProgress) {
        debugLogger.debug("Streaming start already in progress, ignoring", {}, "streaming");
        return { success: false, error: "Operation in progress" };
      }

      streamingStartInProgress = true;
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) {
          return { success: false, error: "API not configured", code: "NO_API" };
        }

        await this.requireLicenseGate();

        const win = BrowserWindow.fromWebContents(event.sender);

        if (!this.assemblyAiStreaming) {
          this.assemblyAiStreaming = new AssemblyAiStreaming();
        }

        // Clean up any stale active connection (shouldn't happen normally)
        if (this.assemblyAiStreaming.isConnected) {
          debugLogger.debug(
            "AssemblyAI cleaning up stale connection before start",
            {},
            "streaming"
          );
          await this.assemblyAiStreaming.disconnect(false);
          this.assemblyAiStreamingAuthorized = false;
        }

        const hasWarm = this.assemblyAiStreaming.hasWarmConnection();
        debugLogger.debug(
          "AssemblyAI streaming start",
          { hasWarmConnection: hasWarm },
          "streaming"
        );

        let token = this.assemblyAiStreaming.getCachedToken();
        if (!token) {
          debugLogger.debug("Fetching streaming token from API", {}, "streaming");
          token = await fetchStreamingToken(event);
          this.assemblyAiStreaming.cacheToken(token);
        } else {
          debugLogger.debug("Using cached streaming token", {}, "streaming");
        }

        // Set up callbacks to forward events to renderer
        this.assemblyAiStreaming.onPartialTranscript = (text) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send("assemblyai-partial-transcript", text);
          }
        };

        this.assemblyAiStreaming.onFinalTranscript = (text) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send("assemblyai-final-transcript", text);
          }
        };

        this.assemblyAiStreaming.onError = (error) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send("assemblyai-error", error.message);
          }
        };

        this.assemblyAiStreaming.onSessionEnd = (data) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send("assemblyai-session-end", data);
          }
        };

        await this.assemblyAiStreaming.connect({ ...options, token });
        this.assemblyAiStreamingAuthorized = true;
        debugLogger.debug("AssemblyAI streaming started", {}, "streaming");

        return {
          success: true,
          usedWarmConnection: this.assemblyAiStreaming.hasWarmConnection() === false,
        };
      } catch (error) {
        if (error.code === "LICENSE_REQUIRED" && error.response) {
          this.assemblyAiStreamingAuthorized = false;
          return error.response;
        }
        debugLogger.error("AssemblyAI streaming start error", { error: error.message });
        if (error.code === "AUTH_EXPIRED") {
          return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
        }
        return { success: false, error: error.message };
      } finally {
        streamingStartInProgress = false;
      }
    });

    ipcMain.on("assemblyai-streaming-send", (event, audioBuffer) => {
      try {
        if (!this.assemblyAiStreaming || !this.assemblyAiStreamingAuthorized) return;
        const buffer = toBoundedAudioBuffer(
          audioBuffer,
          "AssemblyAI streaming audio chunk",
          MAX_STREAMING_AUDIO_CHUNK_BYTES
        );
        this.assemblyAiStreaming.sendAudio(buffer);
      } catch (error) {
        debugLogger.error("AssemblyAI streaming send error", { error: error.message });
      }
    });

    ipcMain.on("assemblyai-streaming-force-endpoint", () => {
      if (!this.assemblyAiStreamingAuthorized) return;
      this.assemblyAiStreaming?.forceEndpoint();
    });

    ipcMain.handle("assemblyai-streaming-stop", async () => {
      try {
        let result = { text: "" };
        if (this.assemblyAiStreaming) {
          result = await this.assemblyAiStreaming.disconnect(true);
          this.assemblyAiStreaming.cleanupAll();
          this.assemblyAiStreaming = null;
          this.assemblyAiStreamingAuthorized = false;
        }

        return { success: true, text: result?.text || "" };
      } catch (error) {
        debugLogger.error("AssemblyAI streaming stop error", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("assemblyai-streaming-status", async () => {
      if (!this.assemblyAiStreaming) {
        return { isConnected: false, sessionId: null };
      }
      return this.assemblyAiStreaming.getStatus();
    });

    // --- Deepgram Streaming handlers ---

    let deepgramTokenWindowId = null;

    const fetchDeepgramStreamingTokenFromWindow = async (windowId) => {
      await this.requireLicenseGate();

      const apiUrl = getApiUrl();
      if (!apiUrl) throw new Error("ChordVox API URL not configured");

      const win = BrowserWindow.fromId(windowId);
      if (!win || win.isDestroyed()) throw new Error("Window not available for token refresh");

      const cookieHeader = await getSessionCookiesFromWindow(win);
      if (!cookieHeader) throw new Error("No session cookies available");

      const tokenResponse = await fetch(`${apiUrl}/api/deepgram-streaming-token`, {
        method: "POST",
        headers: { Cookie: cookieHeader },
      });

      if (!tokenResponse.ok) {
        if (tokenResponse.status === 401) {
          const err = new Error("Session expired");
          err.code = "AUTH_EXPIRED";
          throw err;
        }
        throw new Error(`Failed to get Deepgram streaming token: ${tokenResponse.status}`);
      }

      const { token } = await tokenResponse.json();
      if (!token) throw new Error("No token received from API");
      return token;
    };

    const fetchDeepgramStreamingToken = async (event) => {
      await this.requireLicenseGate();

      const apiUrl = getApiUrl();
      if (!apiUrl) {
        throw new Error("ChordVox API URL not configured");
      }

      const cookieHeader = await getSessionCookies(event);
      if (!cookieHeader) {
        throw new Error("No session cookies available");
      }

      const tokenResponse = await fetch(`${apiUrl}/api/deepgram-streaming-token`, {
        method: "POST",
        headers: {
          Cookie: cookieHeader,
        },
      });

      if (!tokenResponse.ok) {
        if (tokenResponse.status === 401) {
          const err = new Error("Session expired");
          err.code = "AUTH_EXPIRED";
          throw err;
        }
        const errorData = await tokenResponse.json().catch(() => ({}));
        throw new Error(
          errorData.error || `Failed to get Deepgram streaming token: ${tokenResponse.status}`
        );
      }

      const { token } = await tokenResponse.json();
      if (!token) {
        throw new Error("No token received from API");
      }

      return token;
    };

    ipcMain.handle("deepgram-streaming-warmup", async (event, options = {}) => {
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) {
          return { success: false, error: "API not configured", code: "NO_API" };
        }

        await this.requireLicenseGate();

        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) {
          deepgramTokenWindowId = win.id;
        }

        if (!this.deepgramStreaming) {
          this.deepgramStreaming = new DeepgramStreaming();
        }

        this.deepgramStreaming.setTokenRefreshFn(async () => {
          if (!deepgramTokenWindowId) throw new Error("No window reference");
          return fetchDeepgramStreamingTokenFromWindow(deepgramTokenWindowId);
        });

        if (this.deepgramStreaming.hasWarmConnection()) {
          debugLogger.debug("Deepgram connection already warm", {}, "streaming");
          this.deepgramStreamingAuthorized = true;
          return { success: true, alreadyWarm: true };
        }

        let token = this.deepgramStreaming.getCachedToken();
        if (!token) {
          debugLogger.debug("Fetching new Deepgram streaming token for warmup", {}, "streaming");
          token = await fetchDeepgramStreamingToken(event);
        }

        await this.deepgramStreaming.warmup({ ...options, token });
        this.deepgramStreamingAuthorized = true;
        debugLogger.debug("Deepgram connection warmed up", {}, "streaming");

        return { success: true };
      } catch (error) {
        if (error.code === "LICENSE_REQUIRED" && error.response) {
          this.deepgramStreamingAuthorized = false;
          return error.response;
        }
        debugLogger.error("Deepgram warmup error", { error: error.message });
        if (error.code === "AUTH_EXPIRED") {
          return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
        }
        return { success: false, error: error.message };
      }
    });

    let deepgramStreamingStartInProgress = false;

    ipcMain.handle("deepgram-streaming-start", async (event, options = {}) => {
      if (deepgramStreamingStartInProgress) {
        debugLogger.debug(
          "Deepgram streaming start already in progress, ignoring",
          {},
          "streaming"
        );
        return { success: false, error: "Operation in progress" };
      }

      deepgramStreamingStartInProgress = true;
      try {
        const apiUrl = getApiUrl();
        if (!apiUrl) {
          return { success: false, error: "API not configured", code: "NO_API" };
        }

        await this.requireLicenseGate();

        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) {
          deepgramTokenWindowId = win.id;
        }

        if (!this.deepgramStreaming) {
          this.deepgramStreaming = new DeepgramStreaming();
        }

        this.deepgramStreaming.setTokenRefreshFn(async () => {
          if (!deepgramTokenWindowId) throw new Error("No window reference");
          return fetchDeepgramStreamingTokenFromWindow(deepgramTokenWindowId);
        });

        if (this.deepgramStreaming.isConnected) {
          debugLogger.debug("Deepgram cleaning up stale connection before start", {}, "streaming");
          await this.deepgramStreaming.disconnect(false);
          this.deepgramStreamingAuthorized = false;
        }

        const hasWarm = this.deepgramStreaming.hasWarmConnection();
        debugLogger.debug("Deepgram streaming start", { hasWarmConnection: hasWarm }, "streaming");

        let token = this.deepgramStreaming.getCachedToken();
        if (!token) {
          debugLogger.debug("Fetching Deepgram streaming token from API", {}, "streaming");
          token = await fetchDeepgramStreamingToken(event);
          this.deepgramStreaming.cacheToken(token);
        } else {
          debugLogger.debug("Using cached Deepgram streaming token", {}, "streaming");
        }

        this.deepgramStreaming.onPartialTranscript = (text) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send("deepgram-partial-transcript", text);
          }
        };

        this.deepgramStreaming.onFinalTranscript = (text) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send("deepgram-final-transcript", text);
          }
        };

        this.deepgramStreaming.onError = (error) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send("deepgram-error", error.message);
          }
        };

        this.deepgramStreaming.onSessionEnd = (data) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send("deepgram-session-end", data);
          }
        };

        await this.deepgramStreaming.connect({ ...options, token });
        this.deepgramStreamingAuthorized = true;
        debugLogger.debug("Deepgram streaming started", {}, "streaming");

        return {
          success: true,
          usedWarmConnection: hasWarm,
        };
      } catch (error) {
        if (error.code === "LICENSE_REQUIRED" && error.response) {
          this.deepgramStreamingAuthorized = false;
          return error.response;
        }
        debugLogger.error("Deepgram streaming start error", { error: error.message });
        if (error.code === "AUTH_EXPIRED") {
          return { success: false, error: "Session expired", code: "AUTH_EXPIRED" };
        }
        return { success: false, error: error.message };
      } finally {
        deepgramStreamingStartInProgress = false;
      }
    });

    ipcMain.on("deepgram-streaming-send", (event, audioBuffer) => {
      try {
        if (!this.deepgramStreaming || !this.deepgramStreamingAuthorized) return;
        const buffer = toBoundedAudioBuffer(
          audioBuffer,
          "Deepgram streaming audio chunk",
          MAX_STREAMING_AUDIO_CHUNK_BYTES
        );
        this.deepgramStreaming.sendAudio(buffer);
      } catch (error) {
        debugLogger.error("Deepgram streaming send error", { error: error.message });
      }
    });

    ipcMain.on("deepgram-streaming-finalize", () => {
      if (!this.deepgramStreamingAuthorized) return;
      this.deepgramStreaming?.finalize();
    });

    ipcMain.handle("deepgram-streaming-stop", async () => {
      try {
        let result = { text: "" };
        if (this.deepgramStreaming) {
          result = await this.deepgramStreaming.disconnect(true);
          this.deepgramStreamingAuthorized = false;
        }

        return { success: true, text: result?.text || "" };
      } catch (error) {
        debugLogger.error("Deepgram streaming stop error", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("deepgram-streaming-status", async () => {
      if (!this.deepgramStreaming) {
        return { isConnected: false, sessionId: null };
      }
      return this.deepgramStreaming.getStatus();
    });
  }

  broadcastToWindows(channel, payload, excludeWebContentsId = null) {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach((win) => {
      if (!win.isDestroyed() && win.webContents?.id !== excludeWebContentsId) {
        win.webContents.send(channel, payload);
      }
    });
  }
}

module.exports = IPCHandlers;
