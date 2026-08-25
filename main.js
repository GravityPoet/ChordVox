const {
  app,
  globalShortcut,
  BrowserWindow,
  dialog,
  ipcMain,
  powerMonitor,
  session,
} = require("electron");
const path = require("path");
const http = require("http");
const dns = require("dns");
const crypto = require("crypto");
const { buildApiUrl, buildGeminiGenerateContentUrl } = require("./src/config/endpointUtils");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const Sentry = require("@sentry/electron/main");
const {
  buildOnboardingFunnelSentryEvent,
  normalizeOnboardingFunnelEventName,
} = require("./src/utils/onboardingTelemetry");

// Telemetry & Sentry Configuration
let sentryInitialized = false;

function scrubString(str) {
  if (typeof str !== "string") return str;
  let result = str;
  const piiPatterns = [/sk-[a-zA-Z0-9]{32,}/g, /AIzaSy[a-zA-Z0-9-_]{33}/g, /gsk_[a-zA-Z0-9]{24,}/g];
  for (const pattern of piiPatterns) {
    result = result.replace(pattern, "[SCRUBBED_KEY]");
  }
  result = result.replace(/\/Users\/[a-zA-Z0-9_.-]+\//g, "/Users/[USER]/");
  result = result.replace(/C:\\Users\\[a-zA-Z0-9_.-]+\\/gi, "C:\\Users\\[USER]\\");
  result = result.replace(
    /(transcription|transcript|speech|audio|paste|clipboard|text)[:\s]+.+/gi,
    "$1: [SCRUBBED]"
  );
  return result;
}

function scrubObject(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => {
      if (typeof item === "string") return scrubString(item);
      if (typeof item === "object") return scrubObject(item);
      return item;
    });
  }
  const scrubbed = {};
  for (const [key, val] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (
      [
        "text",
        "transcript",
        "audio",
        "clipboard",
        "paste",
        "input",
        "body",
        "headers",
        "query",
        "user",
        "email",
        "name",
        "username",
      ].some((k) => lowerKey.includes(k))
    ) {
      scrubbed[key] = "[SCRUBBED]";
    } else if (typeof val === "string") {
      scrubbed[key] = scrubString(val);
    } else if (typeof val === "object") {
      scrubbed[key] = scrubObject(val);
    } else {
      scrubbed[key] = val;
    }
  }
  return scrubbed;
}

function scrubSentryEvent(event) {
  if (!event) return null;
  event.user = null;
  if (event.message) event.message = scrubString(event.message);
  if (event.logentry?.message) event.logentry.message = scrubString(event.logentry.message);
  if (event.exception && event.exception.values) {
    for (const val of event.exception.values) {
      if (val.value) val.value = scrubString(val.value);
      if (val.stacktrace && val.stacktrace.frames) {
        for (const frame of val.stacktrace.frames) {
          if (frame.filename) frame.filename = scrubString(frame.filename);
          if (frame.abs_path) frame.abs_path = scrubString(frame.abs_path);
          if (frame.pre_context) frame.pre_context = frame.pre_context.map(scrubString);
          if (frame.post_context) frame.post_context = frame.post_context.map(scrubString);
          if (frame.context_line) frame.context_line = scrubString(frame.context_line);
        }
      }
    }
  }
  event.breadcrumbs = [];
  if (event.request) event.request = scrubObject(event.request);
  if (event.extra) event.extra = scrubObject(event.extra);
  if (event.contexts) event.contexts = scrubObject(event.contexts);
  if (event.tags) event.tags = scrubObject(event.tags);
  return event;
}

function setupSentry(enabled) {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  if (!sentryInitialized) {
    Sentry.init({
      dsn,
      enabled,
      beforeSend(event) {
        return scrubSentryEvent(event);
      },
    });
    sentryInitialized = true;
  } else {
    const client = Sentry.getClient();
    if (client) {
      client.getOptions().enabled = enabled;
    }
  }
}

function reportOnboardingFunnelEvent(eventName) {
  const normalized = normalizeOnboardingFunnelEventName(eventName);
  const client = Sentry.getClient();
  if (!normalized || !client?.getOptions()?.enabled || !databaseManager) {
    return false;
  }

  const event = buildOnboardingFunnelSentryEvent(normalized);
  if (!event) return false;
  const eventId = Sentry.captureEvent(event);
  if (!eventId) return false;
  databaseManager.markOnboardingEventReported(normalized);
  return true;
}

function reportPendingOnboardingFunnelEvents() {
  if (!databaseManager) return;
  for (const eventName of databaseManager.getUnreportedOnboardingEvents()) {
    reportOnboardingFunnelEvent(eventName);
  }
}

// Resolve reasoning API hostnames at startup so the first real request skips
// the DNS round-trip (typically 20-100ms). Pure side-effect on the OS resolver
// cache; nothing is sent to these hosts.
function prewarmReasoningDns() {
  const hosts = [
    "api.openai.com",
    "api.anthropic.com",
    "generativelanguage.googleapis.com",
    "api.groq.com",
  ];
  for (const host of hosts) {
    dns.lookup(host, { all: true }, () => {});
  }
}

// Pick a transcription-provider profile when neither env nor renderer pinned
// one yet. Mirrors src/utils/defaultTranscriptionModel.ts. We consult both
// UI_LANGUAGE env and Electron's runtime locale (--lang flag / OS locale) so
// pre-warm aligns with whatever language the renderer will actually load.
function inferTranscriptionFallback() {
  const candidates = [
    environmentManager?.getUiLanguage?.() || "",
    typeof app.getLocale === "function" ? app.getLocale() : "",
  ];
  for (const candidate of candidates) {
    const lang = String(candidate || "")
      .trim()
      .toLowerCase();
    if (!lang) continue;
    if (lang.startsWith("zh")) {
      return { provider: "paraformer", paraformerModel: "paraformer-large-zh" };
    }
    if (lang === "en" || lang.startsWith("en-")) {
      return { provider: "nvidia", parakeetModel: "parakeet-tdt-0.6b-v2" };
    }
    return { provider: "whisper", whisperModel: "turbo" };
  }
  return { provider: "whisper", whisperModel: "turbo" };
}

// Pre-warm state is generation based. Renderer settings arrive after the
// initial env-based guess, so an older async start must never win over the
// newer provider/model selection.
const lastPrewarmConfig = { whisper: "", parakeet: "", paraformer: "", granite: "" };
let prewarmGeneration = 0;
let desiredPrewarmKey = "";
let prewarmDisabled = false;
// Model pre-warming trades a small first-dictation latency win for hundreds of
// megabytes (and sometimes swapped gigabytes) held while the app is idle. Keep
// the shipped default lazy; operators can opt in for kiosk/latency-sensitive
// deployments without changing renderer settings or user data.
const TRANSCRIPTION_PREWARM_ENABLED = /^(1|true|yes)$/i.test(
  String(process.env.CHORDVOX_PREWARM_TRANSCRIPTION || "")
);

async function reconcileTranscriptionPrewarm(settings, generation) {
  if (prewarmDisabled || generation !== prewarmGeneration) return;
  const selectedManagerName =
    {
      whisper: "whisper",
      nvidia: "parakeet",
      paraformer: "paraformer",
      granite: "granite",
    }[settings.effectiveProvider] || null;
  const providers = [
    ["whisper", whisperManager, settings.whisperSettings],
    ["parakeet", parakeetManager, settings.parakeetSettings],
    ["paraformer", paraformerManager, settings.paraformerSettings],
    ["granite", graniteRuntimeManager, settings.graniteSettings],
  ];

  // Stop every provider that is no longer selected before starting the new
  // one. This also cleans up a server left behind by a previous provider.
  const selectedLease = sidecarCoordinator?.begin(
    selectedManagerName,
    `prewarm:${generation}`
  );
  if (sidecarCoordinator) {
    await sidecarCoordinator.stopExcept(selectedManagerName, "prewarm-reconcile");
  } else {
    const stopTasks = providers
      .filter(([name, manager]) => manager && name !== selectedManagerName)
      .map(([name, manager]) =>
        Promise.resolve()
          .then(() => manager.stopServer?.())
          .catch((error) =>
            debugLogger.debug(`${name} stale pre-warm stop error (non-fatal)`, {
              error: error?.message || String(error),
            })
          )
      );
    await Promise.all(stopTasks);
  }
  if (prewarmDisabled || generation !== prewarmGeneration) return;
  if (sidecarCoordinator && !sidecarCoordinator.isCurrent(selectedLease)) return;

  const selected = providers.find(([name]) => name === selectedManagerName);
  if (!selected?.[1]?.initializeAtStartup) return;

  const [name, manager, managerSettings] = selected;
  try {
    await manager.initializeAtStartup({ ...managerSettings, sidecarOwner: selectedLease });
  } catch (error) {
    debugLogger.debug(`${name} startup init error (non-fatal)`, {
      error: error?.message || String(error),
    });
  }

  // A provider may have changed while initialization was waiting for a
  // sidecar/model. Reconcile again by stopping this stale generation.
  if (prewarmDisabled || generation !== prewarmGeneration) {
    try {
      if (sidecarCoordinator && selectedLease) {
        await sidecarCoordinator.stopOwned(selectedLease, "stale-prewarm");
      } else {
        await manager.stopServer?.();
      }
    } catch (error) {
      debugLogger.debug(`${name} stale pre-warm cleanup error (non-fatal)`, {
        error: error?.message || String(error),
      });
    }
  }
}

// Pre-warm runner. Called once at startup with env-based guesses, and again
// from `transcription:report-active-settings` IPC once the renderer loads its
// real provider choice from localStorage. A new generation supersedes the old
// request rather than waiting behind it or allowing it to restart the wrong
// model after a provider switch.
function runTranscriptionPrewarm(overrides = {}) {
  if (prewarmDisabled || !TRANSCRIPTION_PREWARM_ENABLED) return;
  const envProvider = process.env.LOCAL_TRANSCRIPTION_PROVIDER || "";
  const overrideProvider = (overrides.localTranscriptionProvider || "").trim();
  const fallback = !envProvider && !overrideProvider ? inferTranscriptionFallback() : {};

  const effectiveProvider = overrideProvider || envProvider || fallback.provider || "";

  const whisperSettings = {
    localTranscriptionProvider: effectiveProvider,
    whisperModel:
      overrides.whisperModel || process.env.LOCAL_WHISPER_MODEL || fallback.whisperModel || "",
  };

  const parakeetSettings = {
    localTranscriptionProvider: effectiveProvider,
    parakeetModel:
      overrides.parakeetModel || process.env.PARAKEET_MODEL || fallback.parakeetModel || "",
  };

  const paraformerSettings = {
    localTranscriptionProvider: effectiveProvider,
    paraformerModel:
      overrides.paraformerModel || process.env.PARAFORMER_MODEL || fallback.paraformerModel || "",
  };

  const graniteSettings = {
    localTranscriptionProvider: effectiveProvider,
    graniteModel: overrides.graniteModel || process.env.GRANITE_MODEL || "",
  };

  const desired = {
    effectiveProvider,
    whisperSettings,
    parakeetSettings,
    paraformerSettings,
    graniteSettings,
  };
  const desiredKeys = {
    whisper: `${effectiveProvider}|${whisperSettings.whisperModel}`,
    parakeet: `${effectiveProvider}|${parakeetSettings.parakeetModel}`,
    paraformer: `${effectiveProvider}|${paraformerSettings.paraformerModel}`,
    granite: `${effectiveProvider}|${graniteSettings.graniteModel}`,
  };
  const nextKey = JSON.stringify({ provider: effectiveProvider, ...desiredKeys });
  if (nextKey === desiredPrewarmKey) return;

  desiredPrewarmKey = nextKey;
  Object.assign(lastPrewarmConfig, desiredKeys);
  const generation = ++prewarmGeneration;
  void reconcileTranscriptionPrewarm(desired, generation);
}

const VALID_CHANNELS = new Set(["development", "staging", "production"]);
const DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL = {
  development: "chordvox-dev",
  staging: "chordvox-staging",
  production: "chordvox",
};
const BASE_WINDOWS_APP_ID = "com.gravitypoet.chordvox";
const DEFAULT_AUTH_BRIDGE_PORT = 5199;
// Current desktop activation is license-key only. Keep the legacy OAuth code
// isolated for a future hosted-account build, but do not register protocols,
// listeners, or a local bridge in the shipped account-free product.
const ACCOUNT_AUTH_FEATURES_ENABLED = false;

function isElectronBinaryExec() {
  const execPath = (process.execPath || "").toLowerCase();
  return (
    execPath.includes("/electron.app/contents/macos/electron") ||
    execPath.endsWith("/electron") ||
    execPath.endsWith("\\electron.exe")
  );
}

function inferDefaultChannel() {
  if (process.env.NODE_ENV === "development" || process.defaultApp || isElectronBinaryExec()) {
    return "development";
  }
  return "production";
}

function resolveAppChannel() {
  const rawChannel = (process.env.CHORDVOX_CHANNEL || process.env.VITE_CHORDVOX_CHANNEL || "")
    .trim()
    .toLowerCase();

  if (VALID_CHANNELS.has(rawChannel)) {
    return rawChannel;
  }

  return inferDefaultChannel();
}

const APP_CHANNEL = resolveAppChannel();
process.env.CHORDVOX_CHANNEL = APP_CHANNEL;

function getExplicitUserDataDir(argv = process.argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--user-data-dir") {
      const value = String(argv[index + 1] || "").trim();
      return value ? path.resolve(value) : null;
    }
    if (arg.startsWith("--user-data-dir=")) {
      const value = arg.slice("--user-data-dir=".length).trim();
      return value ? path.resolve(value) : null;
    }
  }
  return null;
}

function configureChannelUserDataPath() {
  // Chromium consumes --user-data-dir for browser storage, but Electron does
  // not automatically reflect it through app.getPath("userData"). Set both to
  // the same explicit path so databases, logs, settings, and the single-instance
  // lock stay inside an isolated installed-package acceptance profile.
  const explicitUserDataPath = getExplicitUserDataDir();
  if (explicitUserDataPath) {
    app.setPath("userData", explicitUserDataPath);
    return;
  }

  if (APP_CHANNEL === "production") {
    return;
  }

  const isolatedPath = path.join(app.getPath("appData"), `ChordVox-${APP_CHANNEL}`);
  app.setPath("userData", isolatedPath);
}

configureChannelUserDataPath();

// Fix transparent window flickering on Linux: --enable-transparent-visuals requires
// the compositor to set up an ARGB visual before any windows are created.
// --disable-gpu-compositing prevents GPU compositing conflicts with the compositor.
if (process.platform === "linux") {
  app.commandLine.appendSwitch("enable-transparent-visuals");
  app.commandLine.appendSwitch("disable-gpu-compositing");
}

// Enable native Wayland support: Ozone platform for native rendering,
// and GlobalShortcutsPortal for global shortcuts via xdg-desktop-portal
if (process.platform === "linux" && process.env.XDG_SESSION_TYPE === "wayland") {
  app.commandLine.appendSwitch("ozone-platform-hint", "auto");
  app.commandLine.appendSwitch(
    "enable-features",
    "UseOzonePlatform,WaylandWindowDecorations,GlobalShortcutsPortal"
  );
}

// Group all windows under single taskbar entry on Windows
if (process.platform === "win32") {
  const windowsAppId =
    APP_CHANNEL === "production" ? BASE_WINDOWS_APP_ID : `${BASE_WINDOWS_APP_ID}.${APP_CHANNEL}`;
  app.setAppUserModelId(windowsAppId);
}

function getOAuthProtocol() {
  const fromEnv = (process.env.VITE_CHORDVOX_PROTOCOL || process.env.CHORDVOX_PROTOCOL || "")
    .trim()
    .toLowerCase();

  if (/^[a-z][a-z0-9+.-]*$/.test(fromEnv)) {
    return fromEnv;
  }

  return (
    DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL[APP_CHANNEL] || DEFAULT_OAUTH_PROTOCOL_BY_CHANNEL.production
  );
}

const OAUTH_PROTOCOL = getOAuthProtocol();
const CONNECT_SRC_ALLOWLIST = [
  "'self'",
  "file:",
  "https://api.chordvox.com",
  "https://chordvox.com",
  "https://*.neon.tech",
  "https://api.openai.com",
  "https://openrouter.ai",
  "https://api.anthropic.com",
  "https://generativelanguage.googleapis.com",
  "https://api.groq.com",
  "https://api.deepgram.com",
  "wss://api.deepgram.com",
  "wss://streaming.assemblyai.com",
  "wss://stt-rt.soniox.com",
  "wss://openspeech.bytedance.com",
  "https://speech.googleapis.com",
  "https://*.speech.googleapis.com",
  "https://*.amazonaws.com",
  "http://127.0.0.1:*",
  "https://127.0.0.1:*",
  "ws://127.0.0.1:*",
  "wss://127.0.0.1:*",
  "http://localhost:*",
  "https://localhost:*",
  "ws://localhost:*",
  "wss://localhost:*",
];

function getExtraConnectSrcAllowlist() {
  const raw = process.env.CHORDVOX_CSP_CONNECT_SRC_EXTRA || "";
  return raw
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(
      (item) =>
        /^https:\/\/[a-z0-9*.-]+(?::\*)?$/i.test(item) ||
        /^wss:\/\/[a-z0-9*.-]+(?::\*)?$/i.test(item)
    );
}

const PRODUCTION_RENDERER_CSP = [
  "default-src 'self' file: blob:",
  "script-src 'self' file: blob:",
  "worker-src 'self' file: blob:",
  "style-src 'self' 'unsafe-inline' file: https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' file: data: blob: https:",
  "media-src 'self' file: data: blob:",
  `connect-src ${[...CONNECT_SRC_ALLOWLIST, ...getExtraConnectSrcAllowlist()].join(" ")}`,
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

function shouldRegisterProtocolWithAppArg() {
  return Boolean(process.defaultApp) || isElectronBinaryExec();
}

// Register custom protocol for OAuth callbacks.
// In development, always include the app path argument so macOS/Windows/Linux
// can launch the project app instead of opening bare Electron.
function registerChordVoxProtocol() {
  if (!ACCOUNT_AUTH_FEATURES_ENABLED) return true;
  const protocol = OAUTH_PROTOCOL;

  if (shouldRegisterProtocolWithAppArg()) {
    const appArg = process.argv[1] ? path.resolve(process.argv[1]) : path.resolve(".");
    return app.setAsDefaultProtocolClient(protocol, process.execPath, [appArg]);
  }

  return app.setAsDefaultProtocolClient(protocol);
}

const protocolRegistered = registerChordVoxProtocol();
if (!protocolRegistered) {
  console.warn(`[Auth] Failed to register ${OAUTH_PROTOCOL}:// protocol handler`);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.exit(0);
}

const isLiveWindow = (window) => window && !window.isDestroyed();

function clearMacDockBadge() {
  if (process.platform !== "darwin" || typeof app.setBadgeCount !== "function") {
    return;
  }

  try {
    app.setBadgeCount(0);
  } catch (error) {
    console.warn("[Dock] Failed to clear badge:", error?.message || error);
  }
}

// Ensure macOS menus use the proper casing for the app name
if (process.platform === "darwin" && app.getName() !== "ChordVox") {
  app.setName("ChordVox");
}

const { i18nMain, changeLanguage } = require("./src/helpers/i18nMain");
const FATAL_RECOVERY_ARG_PREFIX = "--fatal-recovery-at=";
const FATAL_RECOVERY_COOLDOWN_MS = 5 * 60 * 1000;
let fatalExceptionHandling = false;

// Continuing after an unknown uncaught exception can leave hotkeys, windows,
// audio, or persistence half-mutated. Recover once by starting a clean process;
// a timestamped cooldown prevents an immediate crash loop.
process.on("uncaughtException", (error) => {
  const fatalError =
    error instanceof Error
      ? error
      : new Error(error === null || error === undefined ? "Unknown fatal error" : String(error));
  console.error("Uncaught Exception:", fatalError);
  if (fatalError.code === "EPIPE") {
    return;
  }
  if (fatalExceptionHandling) return;
  fatalExceptionHandling = true;
  console.error("Error stack:", fatalError.stack);

  const now = Date.now();
  const previousRecoveryAt = process.argv
    .find((arg) => arg.startsWith(FATAL_RECOVERY_ARG_PREFIX))
    ?.slice(FATAL_RECOVERY_ARG_PREFIX.length);
  const previousRecoveryTimestamp = Number(previousRecoveryAt);
  const canRelaunch =
    !Number.isFinite(previousRecoveryTimestamp) ||
    now - previousRecoveryTimestamp > FATAL_RECOVERY_COOLDOWN_MS;

  try {
    dialog.showErrorBox(
      i18nMain.t("fatalError.title"),
      i18nMain.t(
        canRelaunch ? "fatalError.restartingDescription" : "fatalError.stoppedDescription"
      )
    );
  } catch {}

  if (canRelaunch) {
    try {
      const args = process.argv
        .slice(1)
        .filter((arg) => !arg.startsWith(FATAL_RECOVERY_ARG_PREFIX));
      args.push(`${FATAL_RECOVERY_ARG_PREFIX}${now}`);
      app.relaunch({ args });
    } catch (relaunchError) {
      console.error("Failed to relaunch after fatal exception:", relaunchError);
    }
  }

  try {
    app.exit(1);
  } catch {
    process.exit(1);
  }
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

// Import helper module classes (but don't instantiate yet - wait for app.whenReady())
const EnvironmentManager = require("./src/helpers/environment");
const WindowManager = require("./src/helpers/windowManager");
const DatabaseManager = require("./src/helpers/database");
const ClipboardManager = require("./src/helpers/clipboard");
const WhisperManager = require("./src/helpers/whisper");
const ParakeetManager = require("./src/helpers/parakeet");
const ParaformerManager = require("./src/helpers/paraformer");
const GraniteRuntimeManager = require("./src/helpers/graniteRuntimeManager");
const LicenseManager = require("./src/helpers/licenseManager");
const TrayManager = require("./src/helpers/tray");
const IPCHandlers = require("./src/helpers/ipcHandlers");
const UpdateManager = require("./src/updater");
const GlobeKeyManager = require("./src/helpers/globeKeyManager");
const DevServerManager = require("./src/helpers/devServerManager");
const WindowsKeyManager = require("./src/helpers/windowsKeyManager");
const ContextCaptureManager = require("./src/helpers/contextCaptureManager");
const SidecarCoordinator = require("./src/helpers/sidecarCoordinator");
const { usesNativeHotkeyListener } = require("./src/helpers/hotkeyManager");

// Manager instances - initialized after app.whenReady()
let debugLogger = null;
let environmentManager = null;
let windowManager = null;
let hotkeyManager = null;
let databaseManager = null;
let clipboardManager = null;
let whisperManager = null;
let parakeetManager = null;
let paraformerManager = null;
let graniteRuntimeManager = null;
let licenseManager = null;
let trayManager = null;
let updateManager = null;
let globeKeyManager = null;
let windowsKeyManager = null;
let contextCaptureManager = null;
let sidecarCoordinator = null;
let ipcHandlers = null;
let globeKeyAlertShown = false;
let isMacHotkeyCaptureActive = false;
let isMacAccessibilityPromptActive = false;
let isMacNativeHotkeyEligible = false;
let isMacNativeHotkeyStateIpcRegistered = false;
let macAccessibilityPromptResumeTimer = null;
let authBridgeServer = null;
let shutdownInProgress = false;
let shutdownComplete = false;
let powerRecoveryHandlersRegistered = false;
let powerRecoveryPromise = null;

const SHUTDOWN_TIMEOUT_MS = 5000;

function macHotkeyNeedsNativeListener(hotkey, activationMode) {
  if (!hotkey) {
    return false;
  }
  if (usesNativeHotkeyListener(hotkey, "darwin")) {
    return true;
  }
  return activationMode === "push" && hotkey.includes("+");
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({
        status: "rejected",
        reason: new Error(`${label} timed out after ${timeoutMs}ms`),
      });
    }, timeoutMs);

    Promise.resolve(promise)
      .then((value) => resolve({ status: "fulfilled", value }))
      .catch((reason) => resolve({ status: "rejected", reason }))
      .finally(() => clearTimeout(timer));
  });
}

async function closeAuthBridgeServer() {
  if (!authBridgeServer) return;
  const server = authBridgeServer;
  authBridgeServer = null;
  await new Promise((resolve) => server.close(() => resolve()));
}

async function stopBackgroundServices(reason = "app_quit") {
  const tasks = [];

  prewarmDisabled = true;
  prewarmGeneration += 1;
  desiredPrewarmKey = "";

  // Close the IPC admission gate and cancel renderer-owned work before any
  // database/model manager is torn down. This prevents a late renderer event
  // from starting a query against a closed database or resurrecting a sidecar.
  if (ipcHandlers) {
    notifyRendererPowerState("app-shutting-down", { reason });
    tasks.push(["ipc-lifecycle", ipcHandlers.beginShutdown(reason)]);
  }

  tasks.push(["auth-bridge", closeAuthBridgeServer()]);

  if (hotkeyManager) {
    try {
      hotkeyManager.unregisterAll();
    } catch {}
  } else {
    globalShortcut.unregisterAll();
  }

  if (globeKeyManager) {
    tasks.push(["globe-key-manager", globeKeyManager.stop()]);
  }
  if (macAccessibilityPromptResumeTimer) {
    clearTimeout(macAccessibilityPromptResumeTimer);
    macAccessibilityPromptResumeTimer = null;
  }
  if (windowsKeyManager) {
    tasks.push(["windows-key-manager", windowsKeyManager.stop()]);
  }
  if (updateManager) {
    try {
      updateManager.cleanup();
    } catch {}
  }
  if (sidecarCoordinator) {
    tasks.push(["sidecars", sidecarCoordinator.stopAll("app_quit")]);
  } else {
    if (whisperManager) tasks.push(["whisper-server", whisperManager.stopServer()]);
    if (parakeetManager) tasks.push(["parakeet-server", parakeetManager.stopServer()]);
    if (paraformerManager) tasks.push(["paraformer-server", paraformerManager.stopServer()]);
    if (graniteRuntimeManager) tasks.push(["granite-runtime", graniteRuntimeManager.stopServer()]);
  }
  if (databaseManager) {
    tasks.push(["database", Promise.resolve().then(() => databaseManager.close())]);
  }

  try {
    const modelManager = require("./src/helpers/modelManagerBridge").default;
    tasks.push(["llama-server", modelManager.stopServer()]);
  } catch (error) {
    tasks.push(["llama-server", Promise.reject(error)]);
  }

  const results = await Promise.all(
    tasks.map(([label, promise]) => withTimeout(promise, SHUTDOWN_TIMEOUT_MS, label))
  );

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status === "rejected") {
      const label = tasks[index]?.[0] || "shutdown-task";
      debugLogger?.warn?.("Shutdown task failed", {
        task: label,
        error: result.reason?.message || String(result.reason),
      });
    }
  }
}

function notifyRendererPowerState(channel, payload = {}) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

async function recoverAfterSystemResume() {
  if (powerRecoveryPromise) return powerRecoveryPromise;

  powerRecoveryPromise = (async () => {
    const tasks = [];
    if (ipcHandlers) tasks.push(["streaming sessions", ipcHandlers.recoverAfterSystemResume()]);
    if (sidecarCoordinator) {
      tasks.push(["sidecars", sidecarCoordinator.stopAll("system-resume")]);
    } else {
      if (whisperManager) tasks.push(["Whisper server", whisperManager.stopServer()]);
      if (parakeetManager) tasks.push(["Parakeet server", parakeetManager.stopServer()]);
      if (paraformerManager) tasks.push(["Paraformer server", paraformerManager.stopServer()]);
      if (graniteRuntimeManager) tasks.push(["Granite runtime", graniteRuntimeManager.stopServer()]);
    }
    try {
      const modelManager = require("./src/helpers/modelManagerBridge").default;
      tasks.push(["local reasoning server", modelManager.stopServer()]);
    } catch (error) {
      debugLogger?.warn?.("Could not reset local reasoning after system resume", {
        error: error?.message || String(error),
      });
    }

    const results = await Promise.all(
      tasks.map(([label, promise]) => withTimeout(promise, SHUTDOWN_TIMEOUT_MS, label))
    );
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        debugLogger?.warn?.("System resume recovery task failed", {
          task: tasks[index]?.[0] || "resume-task",
          error: result.reason?.message || String(result.reason),
        });
      }
    });

    for (const key of Object.keys(lastPrewarmConfig)) {
      lastPrewarmConfig[key] = "";
    }
    desiredPrewarmKey = "";
    prewarmGeneration += 1;
    sidecarCoordinator?.resetAfterResume();
    runTranscriptionPrewarm();

    if (process.platform === "darwin" && globeKeyManager) {
      globeKeyManager.stop();
      syncMacNativeHotkeyListener("system-resume");
    } else if (process.platform === "win32" && windowsKeyManager && hotkeyManager) {
      const hotkey = hotkeyManager.getCurrentHotkey?.() || "";
      const activationMode = windowManager?.getActivationMode?.() || "tap";
      const isRightSideModifier =
        /^Right(Control|Ctrl|Alt|Option|Shift|Super|Win|Meta|Command|Cmd)$/i.test(hotkey);
      const { isModifierOnlyHotkey } = require("./src/helpers/hotkeyManager");
      windowsKeyManager.stop();
      if (
        hotkey &&
        hotkey !== "GLOBE" &&
        (activationMode === "push" || isRightSideModifier || isModifierOnlyHotkey(hotkey))
      ) {
        windowsKeyManager.start(hotkey);
      }
    }

    notifyRendererPowerState("system-resumed", { recoveredAt: Date.now() });
  })()
    .catch((error) => {
      debugLogger?.error?.("System resume recovery failed", {
        error: error?.message || String(error),
      });
      notifyRendererPowerState("system-resumed", {
        recoveredAt: Date.now(),
        degraded: true,
      });
    })
    .finally(() => {
      powerRecoveryPromise = null;
    });

  return powerRecoveryPromise;
}

function registerPowerRecoveryHandlers() {
  if (powerRecoveryHandlersRegistered) return;
  powerRecoveryHandlersRegistered = true;

  powerMonitor.on("suspend", () => {
    windowManager?.resetWindowsPushState?.();
    notifyRendererPowerState("system-suspend", { suspendedAt: Date.now() });
  });
  powerMonitor.on("resume", () => {
    notifyRendererPowerState("system-resume-recovering", { resumedAt: Date.now() });
    setTimeout(() => {
      void recoverAfterSystemResume();
    }, 500);
  });
}

function syncMacNativeHotkeyListener(reason = "state-change") {
  if (process.platform !== "darwin" || !globeKeyManager || !hotkeyManager) {
    return;
  }

  if (isMacAccessibilityPromptActive) {
    globeKeyManager.stop();
    debugLogger?.debug?.("[macOS Native Hotkey] Paused during Accessibility prompt", { reason });
    return;
  }

  const currentHotkey = hotkeyManager.getCurrentHotkey?.() || "";
  const activationMode = windowManager?.getActivationMode?.() || "tap";
  const hasMacPushWorkflowHotkeys =
    windowManager?.hasMacPushWorkflowHotkeys?.(activationMode) || false;
  const needsNativeListener =
    isMacHotkeyCaptureActive ||
    (isMacNativeHotkeyEligible &&
      (macHotkeyNeedsNativeListener(currentHotkey, activationMode) || hasMacPushWorkflowHotkeys));

  if (needsNativeListener) {
    globeKeyManager.start();
  } else {
    globeKeyManager.stop();
  }

  debugLogger?.debug?.("[macOS Native Hotkey] Sync complete", {
    reason,
    currentHotkey,
    activationMode,
    captureActive: isMacHotkeyCaptureActive,
    eligible: isMacNativeHotkeyEligible,
    hasMacPushWorkflowHotkeys,
    needsNativeListener,
  });
}

function registerMacNativeHotkeyStateIpc() {
  if (process.platform !== "darwin" || isMacNativeHotkeyStateIpcRegistered) {
    return;
  }

  isMacNativeHotkeyStateIpcRegistered = true;

  ipcMain.on("mac-hotkey-capture-mode-changed", (_event, enabled) => {
    isMacHotkeyCaptureActive = Boolean(enabled);
    syncMacNativeHotkeyListener(
      isMacHotkeyCaptureActive ? "hotkey-capture-start" : "hotkey-capture-end"
    );
  });

  ipcMain.on("mac-accessibility-prompt-state", (_event, active) => {
    isMacAccessibilityPromptActive = Boolean(active);

    if (macAccessibilityPromptResumeTimer) {
      clearTimeout(macAccessibilityPromptResumeTimer);
      macAccessibilityPromptResumeTimer = null;
    }

    if (isMacAccessibilityPromptActive) {
      syncMacNativeHotkeyListener("accessibility-prompt-start");
      return;
    }

    macAccessibilityPromptResumeTimer = setTimeout(() => {
      macAccessibilityPromptResumeTimer = null;
      syncMacNativeHotkeyListener("accessibility-prompt-end");
    }, 2000);
  });

  ipcMain.on("mac-native-hotkey-eligibility-changed", (_event, eligible) => {
    isMacNativeHotkeyEligible = Boolean(eligible);
    syncMacNativeHotkeyListener(
      isMacNativeHotkeyEligible ? "native-hotkey-eligible" : "native-hotkey-ineligible"
    );
  });
}

function parseAuthBridgePort() {
  const raw = (process.env.CHORDVOX_AUTH_BRIDGE_PORT || "").trim();
  if (!raw) return DEFAULT_AUTH_BRIDGE_PORT;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return DEFAULT_AUTH_BRIDGE_PORT;
  }

  return parsed;
}

const AUTH_BRIDGE_HOST = "127.0.0.1";
const AUTH_BRIDGE_PORT = parseAuthBridgePort();
const AUTH_BRIDGE_PATH = "/oauth/callback";
const OAUTH_VERIFIER_REGEX = /^[A-Za-z0-9._~-]{16,2048}$/;
const AUTH_BRIDGE_STATE_PARAM = "chordvox_auth_bridge_state";
const AUTH_BRIDGE_STATE_REGEX = /^[A-Za-z0-9_-]{32,128}$/;
const AUTH_BRIDGE_STATE_TTL_MS = 10 * 60 * 1000;
const authBridgeStates = new Map();

// Set up PATH for production builds to find system tools (whisper.cpp, ffmpeg)
function setupProductionPath() {
  if (process.platform === "darwin" && process.env.NODE_ENV !== "development") {
    const commonPaths = [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ];

    const currentPath = process.env.PATH || "";
    const pathsToAdd = commonPaths.filter((p) => !currentPath.includes(p));

    if (pathsToAdd.length > 0) {
      process.env.PATH = `${currentPath}:${pathsToAdd.join(":")}`;
    }
  }
}

// Phase 1: Initialize managers + IPC handlers before window content loads
function initializeCoreManagers() {
  setupProductionPath();

  environmentManager = new EnvironmentManager();
  debugLogger = require("./src/helpers/debugLogger");
  debugLogger.ensureFileLogging();

  const uiLanguage = environmentManager.getUiLanguage();
  process.env.UI_LANGUAGE = uiLanguage;
  changeLanguage(uiLanguage);
  debugLogger.refreshLogLevel();

  windowManager = new WindowManager();
  windowManager.setWorkflowHotkeysChangedHandler(() => {
    syncMacNativeHotkeyListener("workflow-hotkeys-changed");
  });
  hotkeyManager = windowManager.hotkeyManager;
  databaseManager = new DatabaseManager();
  clipboardManager = new ClipboardManager();
  whisperManager = new WhisperManager();
  parakeetManager = new ParakeetManager();
  paraformerManager = new ParaformerManager();
  graniteRuntimeManager = new GraniteRuntimeManager();
  sidecarCoordinator = new SidecarCoordinator({ logger: debugLogger });
  sidecarCoordinator.register("whisper", whisperManager);
  sidecarCoordinator.register("parakeet", parakeetManager);
  sidecarCoordinator.register("paraformer", paraformerManager);
  sidecarCoordinator.register("granite", graniteRuntimeManager);
  licenseManager = new LicenseManager();
  windowManager.setLicenseManager(licenseManager);
  updateManager = new UpdateManager();
  windowsKeyManager = new WindowsKeyManager();
  contextCaptureManager = new ContextCaptureManager();
  registerMacNativeHotkeyStateIpc();
  if (ACCOUNT_AUTH_FEATURES_ENABLED) {
    registerAuthBridgeIpcHandlers();
  }

  // IPC handlers must be registered before window content loads
  ipcHandlers = new IPCHandlers({
    environmentManager,
    databaseManager,
    clipboardManager,
    whisperManager,
    parakeetManager,
    paraformerManager,
    graniteRuntimeManager,
    licenseManager,
    windowManager,
    updateManager,
    windowsKeyManager,
    getTrayManager: () => trayManager,
    reportOnboardingFunnelEvent,
  });
}

// Phase 2: Non-critical setup after windows are visible
function initializeDeferredManagers() {
  clipboardManager.preWarmAccessibility();
  trayManager = new TrayManager();
  globeKeyManager = new GlobeKeyManager();

  // Register Context IPC handlers
  registerContextIpcHandlers();

  if (process.platform === "darwin") {
    registerMacNativeHotkeyStateIpc();

    globeKeyManager.on("error", (error) => {
      if (globeKeyAlertShown) {
        return;
      }
      globeKeyAlertShown = true;

      const detailLines = [
        error?.message || i18nMain.t("startup.globeHotkey.details.unknown"),
        i18nMain.t("startup.globeHotkey.details.fallback"),
      ];

      if (process.env.NODE_ENV === "development") {
        detailLines.push(i18nMain.t("startup.globeHotkey.details.devHint"));
      } else {
        detailLines.push(i18nMain.t("startup.globeHotkey.details.reinstallHint"));
      }

      dialog.showMessageBox({
        type: "warning",
        title: i18nMain.t("startup.globeHotkey.title"),
        message: i18nMain.t("startup.globeHotkey.message"),
        detail: detailLines.join("\n\n"),
      });
    });
  }
}

// ─── Vision Capability Testing ──────────────────────────────────────────────────

const VISION_MODEL_PATTERNS = {
  openai: [/^gpt-4o/i, /^gpt-4-turbo/i, /^gpt-4-vision/i, /^gpt-5/i, /^o[13]/i],
  custom: [
    /^gpt-4o/i,
    /^gpt-4-turbo/i,
    /^gpt-4-vision/i,
    /^gpt-5/i,
    /^o[13]/i,
    /^claude-3/i,
    /^claude-3\.5/i,
    /^claude-4/i,
    /^gemini-1\.5/i,
    /^gemini-2/i,
    /^gemini-2\.5/i,
    /^gemini-3/i,
  ],
  openrouter: [
    /^openai\/gpt-4o/i,
    /^openai\/gpt-4-turbo/i,
    /^openai\/gpt-5/i,
    /^anthropic\/claude-3/i,
    /^anthropic\/claude-4/i,
    /^google\/gemini-1\.5/i,
    /^google\/gemini-2/i,
    /^google\/gemini-3/i,
    /^meta-llama\/llama-4-scout/i,
  ],
  anthropic: [/^claude-3/i, /^claude-3\.5/i, /^claude-4/i],
  gemini: [/^gemini-1\.5/i, /^gemini-2/i, /^gemini-2\.5/i, /^gemini-3/i],
};

function hasKnownVisionPattern(provider, model) {
  const patterns = VISION_MODEL_PATTERNS[provider] || [];
  return patterns.some((pattern) => pattern.test(model || ""));
}

async function testVisionCapabilityInMainProcess(provider, model, baseUrl, apiKey) {
  const normalizedProvider = (provider || "").toLowerCase().trim();
  const normalizedModel = (model || "").toLowerCase().trim();
  const knownVision = hasKnownVisionPattern(normalizedProvider, normalizedModel);

  if (knownVision && !apiKey) {
    return {
      supported: false,
      provider: normalizedProvider,
      model: normalizedModel,
      error: "API key missing; vision could not be verified",
    };
  }

  if (
    normalizedProvider === "groq" ||
    normalizedProvider === "local" ||
    normalizedProvider === "bedrock"
  ) {
    return {
      supported: false,
      provider: normalizedProvider,
      model: normalizedModel,
      error: "Text-only context mode; screenshots will be skipped",
    };
  }

  // Generate a tiny test image (64x64 red pixel)
  const testImageBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";
  const testPrompt = "What color is this image? Reply with just the color name.";

  let endpoint;
  let headers;
  let body;

  switch (normalizedProvider) {
    case "openai":
    case "openrouter":
    case "custom":
      endpoint = buildApiUrl(
        baseUrl ||
          (normalizedProvider === "openrouter"
            ? "https://openrouter.ai/api/v1"
            : "https://api.openai.com/v1"),
        "/chat/completions"
      );
      headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      };
      body = JSON.stringify({
        model: normalizedModel,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: testPrompt },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${testImageBase64}` },
              },
            ],
          },
        ],
        max_tokens: 50,
      });
      break;

    case "anthropic":
      endpoint = "https://api.anthropic.com/v1/messages";
      headers = {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      };
      body = JSON.stringify({
        model: normalizedModel,
        max_tokens: 50,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: testPrompt },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: testImageBase64,
                },
              },
            ],
          },
        ],
      });
      break;

    case "gemini": {
      // Use BYOK endpoint rule: only official Google endpoints remain on v1beta
      // Custom bridge endpoints use v1, matching ContextSummaryService logic
      const rawGeminiBase = baseUrl || "https://generativelanguage.googleapis.com";
      endpoint = buildGeminiGenerateContentUrl(rawGeminiBase, normalizedModel);
      headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      };
      body = JSON.stringify({
        contents: [
          {
            parts: [
              { text: testPrompt },
              {
                inline_data: {
                  mime_type: "image/png",
                  data: testImageBase64,
                },
              },
            ],
          },
        ],
        generationConfig: { maxOutputTokens: 50 },
      });
      break;
    }

    default:
      return {
        supported: false,
        provider: normalizedProvider,
        model: normalizedModel,
        error: `Unsupported provider: ${normalizedProvider}`,
      };
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      return {
        supported: false,
        provider: normalizedProvider,
        model: normalizedModel,
        error: `API error: ${response.status} ${errorText}`,
      };
    }

    const data = await response.json();
    let responseText = null;

    switch (normalizedProvider) {
      case "openai":
      case "openrouter":
      case "custom":
        responseText = data.choices?.[0]?.message?.content || null;
        break;
      case "anthropic":
        responseText = data.content?.[0]?.text || null;
        break;
      case "gemini":
        responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || null;
        break;
    }

    return {
      supported: !!responseText,
      provider: normalizedProvider,
      model: normalizedModel,
      testedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
  } catch (error) {
    return {
      supported: false,
      provider: normalizedProvider,
      model: normalizedModel,
      error: error?.message || "Vision probe failed",
    };
  }
}

// ─── Context IPC Handlers ──────────────────────────────────────────────────────

function registerContextIpcHandlers() {
  if (!contextCaptureManager) return;

  ipcMain.handle("capture-context", async (_event, options = {}) => {
    try {
      return await contextCaptureManager.captureContext({
        textEnabled: options?.textEnabled === true,
        visionEnabled: options?.visionEnabled === true,
      });
    } catch (error) {
      debugLogger.warn("capture-context failed", { error: error?.message });
      return {
        layer1Success: false,
        layer2Success: false,
        fallbackReason: "capture-timeout",
      };
    }
  });

  ipcMain.handle("get-frontmost-app", async () => {
    try {
      return await contextCaptureManager.getFrontmostApp();
    } catch (error) {
      debugLogger.warn("get-frontmost-app failed", { error: error?.message });
      return null;
    }
  });

  ipcMain.handle("check-context-permissions", async () => {
    try {
      return await contextCaptureManager.checkContextPermissions();
    } catch (error) {
      debugLogger.warn("check-context-permissions failed", { error: error?.message });
      return {
        accessibility: false,
        screenRecording: false,
        platform: process.platform,
      };
    }
  });

  ipcMain.handle("test-vision-capability", async (_event, options) => {
    const { provider, model, baseUrl, apiKey } = options || {};

    try {
      const result = await testVisionCapabilityInMainProcess(provider, model, baseUrl, apiKey);
      return result;
    } catch (error) {
      return {
        supported: false,
        provider: provider || "unknown",
        model: model || "unknown",
        error: error?.message || "Vision capability test failed",
      };
    }
  });

  ipcMain.handle("get-sensitive-apps", () => {
    try {
      return contextCaptureManager.getSensitiveApps();
    } catch {
      return { bundleIds: [], processNames: [] };
    }
  });

  ipcMain.handle("pick-sensitive-apps", async (_event, options) => {
    try {
      return await contextCaptureManager.pickSensitiveApps(options);
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle("set-sensitive-apps", (_event, config) => {
    try {
      return contextCaptureManager.saveSensitiveApps(config);
    } catch (error) {
      return { success: false, error: error?.message };
    }
  });

  ipcMain.handle("open-screen-recording-settings", async () => {
    try {
      return await contextCaptureManager.openScreenRecordingSettings();
    } catch (error) {
      return { success: false, error: error?.message };
    }
  });

  ipcMain.handle("request-screen-recording-permission", async () => {
    try {
      return await contextCaptureManager.requestScreenRecordingPermission();
    } catch (error) {
      return { granted: false, error: error?.message };
    }
  });

  ipcMain.handle("get-context-settings", () => {
    try {
      return contextCaptureManager.getContextSettings();
    } catch {
      return {
        enabled: false,
        textEnabled: false,
        visionEnabled: false,
        sensitiveApps: { bundleIds: [], processNames: [] },
      };
    }
  });

  ipcMain.handle("set-context-settings", (_event, settings) => {
    try {
      return contextCaptureManager.setContextSettings(settings);
    } catch (error) {
      return { success: false, error: error?.message };
    }
  });

  ipcMain.handle("set-context-enabled", (_event, enabled) => {
    try {
      return contextCaptureManager.setContextEnabled(enabled);
    } catch (error) {
      return { success: false, error: error?.message };
    }
  });
}

function registerAuthBridgeIpcHandlers() {
  ipcMain.handle("auth-bridge-create-state", () => createAuthBridgeState());
}

function syncAutoStartSetting() {
  if (process.platform === "linux") {
    return;
  }

  const hasExplicitChoice = environmentManager.hasExplicitAutoStartChoice();
  if (!hasExplicitChoice && !app.isPackaged) {
    debugLogger.debug("Auto-start sync skipped for unpackaged implicit default");
    return;
  }

  const desiredOpenAtLogin = environmentManager.getAutoStartEnabled();
  if (process.platform === "win32") {
    const hiddenArgs = ["--hidden"];
    const hiddenEntry = app.getLoginItemSettings({ args: hiddenArgs });
    const anyEntry = app.getLoginItemSettings();
    const anyEntryEnabled = anyEntry.executableWillLaunchAtLogin === true;
    const isSynchronized = desiredOpenAtLogin
      ? hiddenEntry.openAtLogin === true
      : !anyEntryEnabled;
    if (isSynchronized) {
      return;
    }

    if (desiredOpenAtLogin) {
      if (anyEntryEnabled && !hiddenEntry.openAtLogin) {
        app.setLoginItemSettings({ openAtLogin: false });
      }
      app.setLoginItemSettings({ openAtLogin: true, args: hiddenArgs });
    } else {
      app.setLoginItemSettings({ openAtLogin: false, args: hiddenArgs });
      app.setLoginItemSettings({ openAtLogin: false });
    }

    debugLogger.debug("Windows auto-start setting synchronized at startup", {
      desiredOpenAtLogin,
      previousOpenAtLogin: anyEntryEnabled,
      previousHiddenEntry: hiddenEntry.openAtLogin,
    });
    return;
  }

  const current = app.getLoginItemSettings().openAtLogin;
  if (current === desiredOpenAtLogin) {
    return;
  }

  app.setLoginItemSettings({
    openAtLogin: desiredOpenAtLogin,
    openAsHidden: true,
  });

  debugLogger.debug("Auto-start setting synchronized at startup", {
    desiredOpenAtLogin,
    previousOpenAtLogin: current,
  });
}

function wasLaunchedAtLogin() {
  if (process.argv.includes("--hidden")) {
    return true;
  }
  try {
    return app.getLoginItemSettings().wasOpenedAtLogin === true;
  } catch {
    return false;
  }
}

app.on("open-url", (event, url) => {
  if (!ACCOUNT_AUTH_FEATURES_ENABLED) return;
  event.preventDefault();
  if (!url.startsWith(`${OAUTH_PROTOCOL}://`)) return;

  handleOAuthDeepLink(url);

  if (windowManager && isLiveWindow(windowManager.controlPanelWindow)) {
    windowManager.controlPanelWindow.show();
    windowManager.controlPanelWindow.focus();
  }
});

// Extract the session verifier from the deep link and navigate the control
// panel to its app URL with the verifier param so the Neon Auth SDK can
// read it from window.location.search and complete authentication.
function navigateControlPanelWithVerifier(verifier) {
  if (!isValidOAuthVerifier(verifier)) return;
  if (!isLiveWindow(windowManager?.controlPanelWindow)) return;

  const appUrl = DevServerManager.getAppUrl(true);

  if (appUrl) {
    const separator = appUrl.includes("?") ? "&" : "?";
    const urlWithVerifier = `${appUrl}${separator}neon_auth_session_verifier=${encodeURIComponent(verifier)}`;
    windowManager.controlPanelWindow.loadURL(urlWithVerifier);
  } else {
    const fileInfo = DevServerManager.getAppFilePath(true);
    if (!fileInfo) return;
    fileInfo.query.neon_auth_session_verifier = verifier;
    windowManager.controlPanelWindow.loadFile(fileInfo.path, { query: fileInfo.query });
  }

  if (debugLogger) {
    debugLogger.debug("Navigating control panel with OAuth verifier", {
      appChannel: APP_CHANNEL,
      oauthProtocol: OAUTH_PROTOCOL,
    });
  }
  windowManager.controlPanelWindow.show();
  windowManager.controlPanelWindow.focus();
}

function isValidOAuthVerifier(verifier) {
  return OAUTH_VERIFIER_REGEX.test(String(verifier || "").trim());
}

function pruneExpiredAuthBridgeStates(now = Date.now()) {
  for (const [state, expiresAt] of authBridgeStates.entries()) {
    if (expiresAt <= now) {
      authBridgeStates.delete(state);
    }
  }
}

function createAuthBridgeState() {
  pruneExpiredAuthBridgeStates();
  const state = crypto.randomBytes(32).toString("base64url");
  authBridgeStates.set(state, Date.now() + AUTH_BRIDGE_STATE_TTL_MS);
  return state;
}

function consumeAuthBridgeState(state) {
  pruneExpiredAuthBridgeStates();
  const normalized = String(state || "").trim();
  if (!AUTH_BRIDGE_STATE_REGEX.test(normalized)) {
    return false;
  }
  if (!authBridgeStates.has(normalized)) {
    return false;
  }
  authBridgeStates.delete(normalized);
  return true;
}

function handleOAuthDeepLink(deepLinkUrl) {
  try {
    const parsed = new URL(deepLinkUrl);
    const verifier = parsed.searchParams.get("neon_auth_session_verifier");
    if (!verifier) return;
    const bridgeState = parsed.searchParams.get(AUTH_BRIDGE_STATE_PARAM);
    if (!consumeAuthBridgeState(bridgeState)) {
      if (debugLogger) debugLogger.warn("Rejected OAuth deep link with invalid bridge state");
      return;
    }
    navigateControlPanelWithVerifier(verifier);
  } catch (err) {
    if (debugLogger) debugLogger.error("Failed to handle OAuth deep link:", err);
  }
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 32 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON payload"));
      }
    });
    req.on("error", reject);
  });
}

function isAllowedAuthBridgeOrigin(origin) {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname;
    return (
      parsed.protocol === "http:" &&
      (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1")
    );
  } catch {
    return false;
  }
}

function writeCorsHeaders(req, res) {
  const origin = String(req.headers.origin || "").trim();
  if (isAllowedAuthBridgeOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function startAuthBridgeServer() {
  if (APP_CHANNEL !== "development" || authBridgeServer) {
    return;
  }

  authBridgeServer = http.createServer(async (req, res) => {
    writeCorsHeaders(req, res);
    if (req.method === "OPTIONS") {
      if (req.headers.origin && !isAllowedAuthBridgeOrigin(req.headers.origin)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Forbidden");
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    const requestUrl = new URL(req.url || "/", `http://${AUTH_BRIDGE_HOST}:${AUTH_BRIDGE_PORT}`);
    if (requestUrl.pathname !== AUTH_BRIDGE_PATH) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    let verifier = requestUrl.searchParams.get("neon_auth_session_verifier");
    let bridgeState = requestUrl.searchParams.get(AUTH_BRIDGE_STATE_PARAM);
    if (!verifier && req.method === "POST") {
      try {
        const body = await parseJsonBody(req);
        verifier = body?.neon_auth_session_verifier || body?.verifier || null;
        bridgeState = body?.[AUTH_BRIDGE_STATE_PARAM] || body?.state || bridgeState;
      } catch (error) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(error.message || "Invalid request");
        return;
      }
    }

    if (!isValidOAuthVerifier(verifier)) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(
        verifier ? "Invalid neon_auth_session_verifier" : "Missing neon_auth_session_verifier"
      );
      return;
    }

    if (!consumeAuthBridgeState(bridgeState)) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Invalid or expired auth bridge state");
      return;
    }

    navigateControlPanelWithVerifier(verifier);

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      "<html><body><h3>ChordVox sign-in complete.</h3><p>You can close this tab.</p></body></html>"
    );
  });

  authBridgeServer.on("error", (error) => {
    if (debugLogger) {
      debugLogger.error("OAuth auth bridge server failed:", error);
    }
  });

  authBridgeServer.listen(AUTH_BRIDGE_PORT, AUTH_BRIDGE_HOST, () => {
    if (debugLogger) {
      debugLogger.debug("OAuth auth bridge server started", {
        url: `http://${AUTH_BRIDGE_HOST}:${AUTH_BRIDGE_PORT}${AUTH_BRIDGE_PATH}`,
      });
    }
  });
}

function configureRendererSecurityHeaders() {
  if (process.env.NODE_ENV === "development") {
    return;
  }

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = {
      ...details.responseHeaders,
      "Content-Security-Policy": [PRODUCTION_RENDERER_CSP],
      "X-Content-Type-Options": ["nosniff"],
    };
    callback({ responseHeaders });
  });
}

// Main application startup
async function startApp() {
  // A quit/relaunch can arrive while Electron is still resolving app.whenReady
  // (notably during an installer replacement).  Do not create new windows or
  // turn the resulting navigation cancellation into a startup failure dialog.
  if (shutdownInProgress || shutdownComplete) {
    return;
  }

  // Freeze the actual launch context before auto-start synchronization mutates
  // Login Items. Otherwise a first manual launch can be mistaken for a hidden
  // login launch immediately after the default auto-start entry is registered.
  const launchedAtLogin = wasLaunchedAtLogin();

  // Phase 1: Core managers + IPC handlers before windows
  initializeCoreManagers();
  if (ACCOUNT_AUTH_FEATURES_ENABLED) {
    startAuthBridgeServer();
  }
  syncAutoStartSetting();
  prewarmReasoningDns();
  setupSentry(false); // Pre-initialize Sentry as disabled by default

  // Electron's file:// sends no Origin header, which Neon Auth rejects.
  if (ACCOUNT_AUTH_FEATURES_ENABLED) {
    session.defaultSession.webRequest.onBeforeSendHeaders(
      { urls: ["https://*.neon.tech/*"] },
      (details, callback) => {
        try {
          details.requestHeaders["Origin"] = new URL(details.url).origin;
        } catch {
          /* malformed URL — leave Origin as-is */
        }
        callback({ requestHeaders: details.requestHeaders });
      }
    );
  }
  configureRendererSecurityHeaders();

  windowManager.setActivationModeCache(environmentManager.getActivationMode());

  ipcMain.on("activation-mode-changed", (_event, mode) => {
    windowManager.setActivationModeCache(mode);
    environmentManager.saveActivationMode(mode);
  });

  ipcMain.on("dictation-cue-style-changed", (_event, style) => {
    if (windowManager.mainWindow && !windowManager.mainWindow.isDestroyed()) {
      windowManager.mainWindow.webContents.send("dictation-cue-style-changed", style);
    }
  });

  ipcMain.on("recording-animation-style-changed", (event, style) => {
    const normalizedStyle = windowManager.setRecordingAnimationStyleCache(style);
    if (windowManager.mainWindow && !windowManager.mainWindow.isDestroyed()) {
      if (event.sender.id !== windowManager.mainWindow.webContents.id) {
        windowManager.mainWindow.webContents.send(
          "recording-animation-style-changed",
          normalizedStyle
        );
      }
    }
  });

  if (process.platform === "darwin") {
    windowManager.applyMacPresentationMode({ preferDock: false });
  }

  // In development, wait for Vite dev server to be ready
  if (process.env.NODE_ENV === "development") {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (shutdownInProgress || shutdownComplete) {
    return;
  }

  // Create windows FIRST so the user sees UI as soon as possible
  await windowManager.createMainWindow();
  await windowManager.createControlPanelWindow({ show: !launchedAtLogin });

  // Phase 2: Initialize remaining managers after windows are visible
  initializeDeferredManagers();
  registerPowerRecoveryHandlers();

  // Non-blocking server pre-warming.
  // First-run users have no LOCAL_TRANSCRIPTION_PROVIDER env set yet (defaults
  // live in renderer localStorage). Mirror src/utils/defaultTranscriptionModel.ts
  // here so pre-warm still triggers on first launch.
  runTranscriptionPrewarm();

  // Renderer reports its real localStorage-backed transcription settings as
  // soon as they hydrate. We re-run pre-warm with the actual provider so
  // first-recording latency stays low even when env-based guess was wrong.
  ipcMain.on("transcription:report-active-settings", (_event, payload = {}) => {
    if (!payload || typeof payload !== "object") return;
    runTranscriptionPrewarm({
      localTranscriptionProvider: String(payload.localTranscriptionProvider || "").trim(),
      whisperModel: String(payload.whisperModel || "").trim(),
      parakeetModel: String(payload.parakeetModel || "").trim(),
      paraformerModel: String(payload.paraformerModel || "").trim(),
      graniteModel: String(payload.graniteModel || "").trim(),
    });
  });

  if (process.env.REASONING_PROVIDER === "local" && process.env.LOCAL_REASONING_MODEL) {
    const modelManager = require("./src/helpers/modelManagerBridge").default;
    modelManager.prewarmServer(process.env.LOCAL_REASONING_MODEL).catch((err) => {
      debugLogger.debug("llama-server pre-warm error (non-fatal)", { error: err.message });
    });
  }

  if (process.platform === "win32") {
    const nircmdStatus = clipboardManager.getNircmdStatus();
    debugLogger.debug("Windows paste tool status", nircmdStatus);
  }

  trayManager.setWindows(windowManager.mainWindow, windowManager.controlPanelWindow);
  trayManager.setWindowManager(windowManager);
  trayManager.setCreateControlPanelCallback(() => windowManager.createControlPanelWindow());
  if (environmentManager.getTrayIconEnabled()) {
    await trayManager.createTray();
  }

  updateManager.setWindows(windowManager.mainWindow, windowManager.controlPanelWindow);
  if (environmentManager.getAutoCheckUpdate()) {
    updateManager.checkForUpdatesOnStartup();
  }

  if (process.platform === "darwin") {
    let globeKeyDownTime = 0;
    let globeKeyIsRecording = false;
    let globeLastStopTime = 0;
    const MIN_HOLD_DURATION_MS = 150;
    const POST_STOP_COOLDOWN_MS = 300;

    globeKeyManager.on("globe-down", async () => {
      // Forward to control panel for hotkey capture
      if (isLiveWindow(windowManager.controlPanelWindow)) {
        windowManager.controlPanelWindow.webContents.send("globe-key-pressed");
      }

      // Handle dictation if Globe is the current hotkey
      if (hotkeyManager.getCurrentHotkey && hotkeyManager.getCurrentHotkey() === "GLOBE") {
        if (isLiveWindow(windowManager.mainWindow)) {
          const activationMode = windowManager.getActivationMode();
          if (activationMode === "push") {
            const now = Date.now();
            if (now - globeLastStopTime < POST_STOP_COOLDOWN_MS) return;
            windowManager.showDictationPanel();
            const pressTime = now;
            globeKeyDownTime = pressTime;
            globeKeyIsRecording = false;
            setTimeout(async () => {
              if (globeKeyDownTime === pressTime && !globeKeyIsRecording) {
                globeKeyIsRecording = true;
                windowManager.sendStartDictation("primary");
              }
            }, MIN_HOLD_DURATION_MS);
          } else {
            windowManager.showDictationPanel();
            windowManager.mainWindow.webContents.send("toggle-dictation", {
              profileId: "primary",
            });
          }
        }
      }
    });

    globeKeyManager.on("globe-up", async () => {
      // Forward to control panel for hotkey capture (Fn key released)
      if (isLiveWindow(windowManager.controlPanelWindow)) {
        windowManager.controlPanelWindow.webContents.send("globe-key-released");
      }

      // Handle push-to-talk release if Globe is the current hotkey
      if (hotkeyManager.getCurrentHotkey && hotkeyManager.getCurrentHotkey() === "GLOBE") {
        const activationMode = windowManager.getActivationMode();
        if (activationMode === "push") {
          globeKeyDownTime = 0;
          globeLastStopTime = Date.now();
          if (globeKeyIsRecording) {
            globeKeyIsRecording = false;
            windowManager.sendStopDictation("primary");
          } else {
            // Mirror right-modifier-up: a tap shorter than the hold threshold
            // never started recording, so retract the panel immediately.
            windowManager.hideDictationPanel();
          }
        }
      }

      // Fn release also stops compound push-to-talk for Fn+F-key hotkeys
      windowManager.handleMacPushModifierUp("fn");
    });

    globeKeyManager.on("modifier-up", (modifier) => {
      if (windowManager?.handleMacPushModifierUp) {
        windowManager.handleMacPushModifierUp(modifier);
      }
    });

    // Right-side single modifier handling (e.g., RightOption as hotkey)
    let rightModDownTime = 0;
    let rightModIsRecording = false;
    let rightModLastStopTime = 0;

    globeKeyManager.on("right-modifier-down", async (modifier) => {
      const currentHotkey = hotkeyManager.getCurrentHotkey && hotkeyManager.getCurrentHotkey();
      if (currentHotkey !== modifier) return;
      if (!isLiveWindow(windowManager.mainWindow)) return;

      const activationMode = windowManager.getActivationMode();
      if (activationMode === "push") {
        const now = Date.now();
        if (now - rightModLastStopTime < POST_STOP_COOLDOWN_MS) return;
        windowManager.showDictationPanel();
        const pressTime = now;
        rightModDownTime = pressTime;
        rightModIsRecording = false;
        setTimeout(() => {
          if (rightModDownTime === pressTime && !rightModIsRecording) {
            rightModIsRecording = true;
            windowManager.sendStartDictation("primary");
          }
        }, MIN_HOLD_DURATION_MS);
      } else {
        windowManager.showDictationPanel();
        windowManager.mainWindow.webContents.send("toggle-dictation", {
          profileId: "primary",
        });
      }
    });

    globeKeyManager.on("right-modifier-up", async (modifier) => {
      const currentHotkey = hotkeyManager.getCurrentHotkey && hotkeyManager.getCurrentHotkey();
      if (currentHotkey !== modifier) return;
      if (!isLiveWindow(windowManager.mainWindow)) return;

      const activationMode = windowManager.getActivationMode();
      if (activationMode === "push") {
        rightModDownTime = 0;
        rightModLastStopTime = Date.now();
        if (rightModIsRecording) {
          rightModIsRecording = false;
          windowManager.sendStopDictation("primary");
        } else {
          windowManager.hideDictationPanel();
        }
      }
    });

    syncMacNativeHotkeyListener("startup");

    // Reset native key state when hotkey changes
    ipcMain.on("hotkey-changed", (_event, newHotkey, profileId = "primary") => {
      globeKeyDownTime = 0;
      globeKeyIsRecording = false;
      globeLastStopTime = 0;
      rightModDownTime = 0;
      rightModIsRecording = false;
      rightModLastStopTime = 0;
      if (profileId === "primary") {
        syncMacNativeHotkeyListener(`hotkey-changed:${newHotkey || ""}`);
      }
    });

    ipcMain.on("activation-mode-changed", (_event, mode) => {
      globeKeyDownTime = 0;
      globeKeyIsRecording = false;
      globeLastStopTime = 0;
      rightModDownTime = 0;
      rightModIsRecording = false;
      rightModLastStopTime = 0;
      syncMacNativeHotkeyListener(`activation-mode-changed:${mode || ""}`);
    });
  }

  // Set up Windows Push-to-Talk handling
  if (process.platform === "win32") {
    debugLogger.debug("[Push-to-Talk] Windows Push-to-Talk setup starting");

    const isValidHotkey = (hotkey) => hotkey && hotkey !== "GLOBE";

    const isRightSideMod = (hotkey) =>
      /^Right(Control|Ctrl|Alt|Option|Shift|Super|Win|Meta|Command|Cmd)$/i.test(hotkey);

    const { isModifierOnlyHotkey } = require("./src/helpers/hotkeyManager");

    const needsNativeListener = (hotkey, mode) => {
      if (!isValidHotkey(hotkey)) return false;
      if (mode === "push") return true;
      return isRightSideMod(hotkey) || isModifierOnlyHotkey(hotkey);
    };

    windowsKeyManager.on("key-down", (_key) => {
      if (!isLiveWindow(windowManager.mainWindow)) return;

      const activationMode = windowManager.getActivationMode();
      if (activationMode === "push") {
        windowManager.startWindowsPushToTalk();
      } else if (activationMode === "tap") {
        windowManager.showDictationPanel();
        windowManager.mainWindow.webContents.send("toggle-dictation", {
          profileId: "primary",
        });
      }
    });

    windowsKeyManager.on("key-up", () => {
      if (!isLiveWindow(windowManager.mainWindow)) return;

      const activationMode = windowManager.getActivationMode();
      if (activationMode === "push") {
        windowManager.handleWindowsPushKeyUp();
      }
    });

    windowsKeyManager.on("error", (error) => {
      debugLogger.warn("[Push-to-Talk] Windows key listener error", { error: error.message });
      if (isLiveWindow(windowManager.mainWindow)) {
        windowManager.mainWindow.webContents.send("windows-ptt-unavailable", {
          reason: "error",
          message: error.message,
        });
      }
    });

    windowsKeyManager.on("unavailable", () => {
      debugLogger.debug(
        "[Push-to-Talk] Windows key listener not available - falling back to toggle mode"
      );
      if (isLiveWindow(windowManager.mainWindow)) {
        windowManager.mainWindow.webContents.send("windows-ptt-unavailable", {
          reason: "binary_not_found",
          message: i18nMain.t("windows.pttUnavailable"),
        });
      }
    });

    windowsKeyManager.on("ready", () => {
      debugLogger.debug("[Push-to-Talk] WindowsKeyManager is ready and listening");
    });

    const startWindowsKeyListener = () => {
      if (!isLiveWindow(windowManager.mainWindow)) return;
      const activationMode = windowManager.getActivationMode();
      const currentHotkey = hotkeyManager.getCurrentHotkey();

      if (needsNativeListener(currentHotkey, activationMode)) {
        windowsKeyManager.start(currentHotkey);
      }
    };

    startWindowsKeyListener();

    ipcMain.on("activation-mode-changed", (_event, mode) => {
      windowManager.resetWindowsPushState();
      const currentHotkey = hotkeyManager.getCurrentHotkey();
      if (needsNativeListener(currentHotkey, mode)) {
        windowsKeyManager.start(currentHotkey);
      } else {
        windowsKeyManager.stop();
      }
    });

    ipcMain.on("hotkey-changed", (_event, hotkey, profileId = "primary") => {
      if (profileId !== "primary") return;
      if (!isLiveWindow(windowManager.mainWindow)) return;
      windowManager.resetWindowsPushState();
      const activationMode = windowManager.getActivationMode();
      windowsKeyManager.stop();
      if (needsNativeListener(hotkey, activationMode)) {
        windowsKeyManager.start(hotkey);
      }
    });
  }
}

// Telemetry IPC handlers
ipcMain.handle("get-sentry-dsn", () => {
  return process.env.SENTRY_DSN || null;
});

ipcMain.on("report-telemetry-settings", (_event, enabled) => {
  const telemetryEnabled = Boolean(enabled);
  setupSentry(telemetryEnabled);
  if (telemetryEnabled) {
    setImmediate(reportPendingOnboardingFunnelEvents);
  }
});

// Listen for usage limit reached from dictation overlay, forward to control panel
ipcMain.on("limit-reached", (_event, data) => {
  if (isLiveWindow(windowManager?.controlPanelWindow)) {
    windowManager.controlPanelWindow.webContents.send("limit-reached", data);
  }
});

// App event handlers
if (gotSingleInstanceLock) {
  app.on("second-instance", async (_event, commandLine) => {
    if (shutdownInProgress || shutdownComplete || ipcHandlers?.shuttingDown) {
      debugLogger?.info?.("Ignoring second-instance while application is shutting down", {
        shutdownInProgress,
        shutdownComplete,
        ipcShutdown: Boolean(ipcHandlers?.shuttingDown),
      });
      return;
    }

    await app.whenReady();
    if (!windowManager) {
      return;
    }

    if (isLiveWindow(windowManager.controlPanelWindow)) {
      if (windowManager.controlPanelWindow.isMinimized()) {
        windowManager.controlPanelWindow.restore();
      }
      windowManager.controlPanelWindow.show();
      windowManager.controlPanelWindow.focus();
    } else {
      windowManager.createControlPanelWindow();
    }

    if (isLiveWindow(windowManager.mainWindow)) {
      windowManager.enforceMainWindowOnTop();
    } else {
      windowManager.createMainWindow();
    }

    // Check for OAuth protocol URL in command line arguments (Windows/Linux)
    const url = ACCOUNT_AUTH_FEATURES_ENABLED
      ? commandLine.find((arg) => arg.startsWith(`${OAUTH_PROTOCOL}://`))
      : null;
    if (url) {
      handleOAuthDeepLink(url);
    }
  });

  app
    .whenReady()
    .then(() => {
      clearMacDockBadge();
      // On Linux, --enable-transparent-visuals requires a short delay before creating
      // windows to allow the compositor to set up the ARGB visual correctly.
      // Without this delay, transparent windows flicker on both X11 and Wayland.
      const delay = process.platform === "linux" ? 300 : 0;
      return new Promise((resolve) => setTimeout(resolve, delay));
    })
    .then(() => {
      startApp().catch((error) => {
        // ERR_FAILED is the normal Chromium error for a navigation cancelled
        // by app.quit()/relaunch.  The shutdown coordinator owns that path; a
        // generic startup dialog here is misleading and can appear on top of
        // an installer or a user-initiated quit.
        if (shutdownInProgress || shutdownComplete || windowManager?.isQuitting) {
          debugLogger?.info?.("Ignoring startup failure during application shutdown", {
            error: error?.message || String(error),
          });
          return;
        }
        console.error("Failed to start app:", error);
        dialog.showErrorBox(
          i18nMain.t("startup.error.title"),
          i18nMain.t("startup.error.message", { error: error.message })
        );
        app.exit(1);
      });
    });

  app.on("window-all-closed", () => {
    // Don't quit on macOS when all windows are closed
    // The app should stay in the dock/menu bar
    if (process.platform !== "darwin") {
      app.quit();
    }
    // On macOS, keep the app running even without windows
  });

  app.on("browser-window-focus", (event, window) => {
    // Only apply always-on-top to the dictation window, not the control panel
    if (windowManager && isLiveWindow(windowManager.mainWindow)) {
      // Check if the focused window is the dictation window
      if (window === windowManager.mainWindow) {
        windowManager.enforceMainWindowOnTop();
      }
    }

    // Control panel doesn't need any special handling on focus
    // It should behave like a normal window
  });

  app.on("activate", () => {
    if (shutdownInProgress || shutdownComplete || ipcHandlers?.shuttingDown) {
      debugLogger?.info?.("Ignoring activate while application is shutting down", {
        shutdownInProgress,
        shutdownComplete,
        ipcShutdown: Boolean(ipcHandlers?.shuttingDown),
      });
      return;
    }

    clearMacDockBadge();
    // On macOS, re-create windows when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) {
      if (windowManager) {
        windowManager.createMainWindow();
        windowManager.createControlPanelWindow();
      }
    } else {
      // Show control panel when dock icon is clicked (most common user action)
      if (windowManager && isLiveWindow(windowManager.controlPanelWindow)) {
        // Ensure dock icon is visible when control panel opens
        windowManager.applyMacPresentationMode({ preferDock: true });
        if (windowManager.controlPanelWindow.isMinimized()) {
          windowManager.controlPanelWindow.restore();
        }
        windowManager.controlPanelWindow.show();
        windowManager.controlPanelWindow.focus();
      } else if (windowManager) {
        // If control panel doesn't exist, create it
        windowManager.createControlPanelWindow();
      }

      // Ensure dictation panel maintains its always-on-top status
      if (windowManager && isLiveWindow(windowManager.mainWindow)) {
        windowManager.enforceMainWindowOnTop();
      }
    }
  });

  app.on("before-quit", (event) => {
    if (shutdownComplete || shutdownInProgress) {
      return;
    }

    debugLogger?.info?.("Application shutdown initiated", {
      reason: "app_quit",
      windowCount: BrowserWindow.getAllWindows().length,
    });
    event.preventDefault();
    shutdownInProgress = true;
    stopBackgroundServices("app_quit")
      .catch((error) => {
        debugLogger?.warn?.("Shutdown cleanup failed", { error: error.message });
      })
      .finally(() => {
        shutdownComplete = true;
        shutdownInProgress = false;
        app.quit();
      });
  });
}
