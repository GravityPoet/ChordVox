const { desktopCapturer, systemPreferences, app, dialog } = require("electron");
const { execFile, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const debugLogger = require("./debugLogger");

// ─── Constants ─────────────────────────────────────────────────────────────────

const ACCESSIBILITY_TIMEOUT_MS = 300;
const SCREENSHOT_TIMEOUT_MS = 300;
const VISION_TIMEOUT_MS = 2500;
const VISION_WAIT_AFTER_ASR_MS = 600;
const MAX_SENSITIVE_APP_ENTRIES = 100;
const MAX_SENSITIVE_APP_ENTRY_LENGTH = 256;

const DEFAULT_SENSITIVE_APPS = {
  bundleIds: [
    "com.agilebits.onepassword7",
    "com.agilebits.onepassword",
    "com.bitwarden.desktop",
    "com.lastpass.LastPass",
    "com.apple.keychainaccess",
    "com.apple.SecurityAgent",
  ],
  processNames: ["1Password", "Bitwarden", "LastPass", "Keychain Access", "SecurityAgent"],
};

const DEFAULT_SENSITIVE_APP_SELECTIONS = [
  { appName: "1Password", bundleId: "com.agilebits.onepassword7" },
  { appName: "1Password", bundleId: "com.agilebits.onepassword" },
  { appName: "Bitwarden", bundleId: "com.bitwarden.desktop" },
  { appName: "LastPass", bundleId: "com.lastpass.LastPass" },
  { appName: "Keychain Access", bundleId: "com.apple.keychainaccess" },
  { appName: "SecurityAgent", bundleId: "com.apple.SecurityAgent" },
];

function normalizeStringList(value, fallback) {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const normalized = [];
  const seen = new Set();
  for (const entry of value) {
    if (normalized.length >= MAX_SENSITIVE_APP_ENTRIES) {
      break;
    }
    if (typeof entry !== "string") {
      continue;
    }
    const item = entry.trim();
    if (!item || item.length > MAX_SENSITIVE_APP_ENTRY_LENGTH || seen.has(item)) {
      continue;
    }
    seen.add(item);
    normalized.push(item);
  }
  return normalized;
}

function normalizeSensitiveAppSelections(value, bundleIds, processNames) {
  const selections = [];
  const seen = new Set();
  const addSelection = (candidate) => {
    if (!candidate || typeof candidate !== "object") return;
    const appName = typeof candidate.appName === "string" ? candidate.appName.trim() : "";
    const bundleId = typeof candidate.bundleId === "string" ? candidate.bundleId.trim() : "";
    if (!appName || appName.length > MAX_SENSITIVE_APP_ENTRY_LENGTH) return;
    if (bundleId.length > MAX_SENSITIVE_APP_ENTRY_LENGTH) return;
    const key = `${appName.toLowerCase()}::${bundleId.toLowerCase()}`;
    if (seen.has(key) || selections.length >= MAX_SENSITIVE_APP_ENTRIES) return;
    seen.add(key);
    selections.push({ appName, bundleId });
  };

  if (Array.isArray(value)) {
    value.forEach(addSelection);
    return selections;
  }

  const normalizedBundleIds = new Set(bundleIds.map((item) => item.toLowerCase()));
  const normalizedProcessNames = new Set(processNames.map((item) => item.toLowerCase()));
  for (const selection of DEFAULT_SENSITIVE_APP_SELECTIONS) {
    if (
      normalizedBundleIds.has(selection.bundleId.toLowerCase()) ||
      normalizedProcessNames.has(selection.appName.toLowerCase())
    ) {
      addSelection(selection);
    }
  }

  for (const appName of processNames) {
    if (
      !selections.some((selection) => selection.appName.toLowerCase() === appName.toLowerCase())
    ) {
      addSelection({ appName, bundleId: "" });
    }
  }

  for (const bundleId of bundleIds) {
    if (
      !selections.some((selection) => selection.bundleId.toLowerCase() === bundleId.toLowerCase())
    ) {
      const fallbackName = bundleId.split(".").filter(Boolean).pop() || bundleId;
      addSelection({ appName: fallbackName, bundleId });
    }
  }

  return selections;
}

function normalizeSensitiveAppsConfig(config) {
  const bundleIds = normalizeStringList(config?.bundleIds, DEFAULT_SENSITIVE_APPS.bundleIds);
  const processNames = normalizeStringList(
    config?.processNames,
    DEFAULT_SENSITIVE_APPS.processNames
  );
  return {
    bundleIds,
    processNames,
    selectedApps: normalizeSensitiveAppSelections(config?.selectedApps, bundleIds, processNames),
  };
}

function getMacAppBundleId(appPath) {
  const infoPlistPath = path.join(appPath, "Contents", "Info.plist");
  if (!fs.existsSync(infoPlistPath)) return Promise.resolve("");

  return new Promise((resolve) => {
    execFile(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleIdentifier", infoPlistPath],
      { encoding: "utf8", timeout: 2_000 },
      (error, stdout) => resolve(error ? "" : String(stdout || "").trim())
    );
  });
}

function matchesProcessName(appName, configuredName) {
  const normalizedAppName = String(appName || "")
    .trim()
    .toLowerCase();
  const normalizedConfiguredName = String(configuredName || "")
    .trim()
    .toLowerCase();
  if (!normalizedAppName || !normalizedConfiguredName) {
    return false;
  }
  return (
    normalizedAppName === normalizedConfiguredName ||
    normalizedAppName.includes(normalizedConfiguredName) ||
    normalizedConfiguredName.includes(normalizedAppName)
  );
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function safeLog(message, data) {
  try {
    debugLogger.debug(`[ContextCapture] ${message}`, data || {});
  } catch {}
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ success: false, error: "timeout", label, timeoutMs });
    }, timeoutMs);

    promise
      .then((value) => resolve({ success: true, value }))
      .catch((error) => resolve({ success: false, error: error?.message || String(error) }))
      .finally(() => clearTimeout(timer));
  });
}

// ─── ContextCaptureManager ─────────────────────────────────────────────────────

class ContextCaptureManager {
  constructor() {
    this.sensitiveApps = normalizeSensitiveAppsConfig(DEFAULT_SENSITIVE_APPS);
    this.accessibilityCache = { value: null, expiresAt: 0 };
    this.screenRecordingCache = { value: null, expiresAt: 0 };
    this.loadSensitiveApps();
  }

  getContextSettingsPath() {
    return path.join(app.getPath("userData"), "context-settings.json");
  }

  readContextSettingsFile() {
    try {
      const settingsPath = this.getContextSettingsPath();
      if (fs.existsSync(settingsPath)) {
        return JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      }
    } catch {}
    return {};
  }

  writeContextSettingsFile(settings) {
    const settingsPath = this.getContextSettingsPath();
    const tmpPath = `${settingsPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2));
    fs.renameSync(tmpPath, settingsPath);
  }

  // ─── Sensitive App Management ─────────────────────────────────────────────

  loadSensitiveApps() {
    try {
      const parsed = this.readContextSettingsFile();
      this.sensitiveApps = normalizeSensitiveAppsConfig(parsed?.sensitiveApps);
    } catch (error) {
      safeLog("Failed to load sensitive apps config", { error: error?.message });
    }
  }

  saveSensitiveApps(config) {
    try {
      const existing = this.readContextSettingsFile();
      const normalizedConfig = normalizeSensitiveAppsConfig(config);
      existing.sensitiveApps = normalizedConfig;
      this.writeContextSettingsFile(existing);
      this.sensitiveApps = normalizedConfig;
      return { success: true };
    } catch (error) {
      safeLog("Failed to save sensitive apps config", { error: error?.message });
      return { success: false, error: error?.message };
    }
  }

  getSensitiveApps() {
    return {
      bundleIds: [...this.sensitiveApps.bundleIds],
      processNames: [...this.sensitiveApps.processNames],
      selectedApps: this.sensitiveApps.selectedApps.map((selection) => ({ ...selection })),
    };
  }

  async pickSensitiveApps(options = {}) {
    if (process.platform !== "darwin") {
      return { success: false, error: "platform-unsupported" };
    }

    try {
      const requestedTitle = typeof options?.title === "string" ? options.title.trim() : "";
      const result = await dialog.showOpenDialog({
        title: requestedTitle.slice(0, 120) || "ChordVox",
        defaultPath: "/Applications",
        properties: ["openFile", "multiSelections"],
        filters: [{ name: "Applications", extensions: ["app"] }],
      });
      if (result.canceled) {
        return { success: true, cancelled: true, apps: [] };
      }

      const appPaths = result.filePaths.filter(
        (appPath) => path.extname(appPath).toLowerCase() === ".app"
      );
      const apps = (
        await Promise.all(
          appPaths.map(async (appPath) => ({
            appName: path.basename(appPath, path.extname(appPath)),
            bundleId: await getMacAppBundleId(appPath),
          }))
        )
      ).filter((selection) => selection.appName);

      return { success: true, cancelled: false, apps };
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  }

  // ─── Permission Checks ───────────────────────────────────────────────────

  async checkAccessibilityPermission() {
    if (process.platform !== "darwin") {
      return false;
    }

    const now = Date.now();
    if (this.accessibilityCache.value !== null && now < this.accessibilityCache.expiresAt) {
      return this.accessibilityCache.value;
    }

    try {
      const granted = systemPreferences.isTrustedAccessibilityClient(false);
      const ttl = 1000;
      this.accessibilityCache = { value: granted, expiresAt: now + ttl };
      return granted;
    } catch (error) {
      safeLog("Accessibility check failed", { error: error?.message });
      return false;
    }
  }

  async checkScreenRecordingPermission() {
    if (process.platform !== "darwin") {
      return false;
    }

    const now = Date.now();
    if (this.screenRecordingCache.value !== null && now < this.screenRecordingCache.expiresAt) {
      return this.screenRecordingCache.value;
    }

    try {
      const granted = systemPreferences.getMediaAccessStatus("screen") === "granted";
      const ttl = 1000;
      this.screenRecordingCache = { value: granted, expiresAt: now + ttl };
      return granted;
    } catch (error) {
      safeLog("Screen recording check failed", { error: error?.message });
      return false;
    }
  }

  async checkContextPermissions() {
    const [accessibility, screenRecording] = await Promise.all([
      this.checkAccessibilityPermission(),
      this.checkScreenRecordingPermission(),
    ]);

    return {
      accessibility,
      screenRecording,
      platform: process.platform,
    };
  }

  async requestScreenRecordingPermission() {
    if (process.platform !== "darwin") {
      return { granted: false, error: "platform-unsupported" };
    }

    this.screenRecordingCache = { value: null, expiresAt: 0 };

    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 1, height: 1 },
      });
      const granted = sources.length > 0;
      const now = Date.now();
      this.screenRecordingCache = { value: granted, expiresAt: now + 1000 };
      return { granted };
    } catch (error) {
      safeLog("Screen recording request failed", { error: error?.message });
      return { granted: false, error: error?.message || "SCREEN_RECORDING_PROMPT_FAILED" };
    }
  }

  // ─── Layer 1: Accessibility Text Capture ──────────────────────────────────

  async captureAccessibilityText() {
    if (process.platform !== "darwin") {
      // Windows/Linux: use platform-specific methods
      return this.captureAccessibilityTextCrossPlatform();
    }

    const startTime = Date.now();

    try {
      // Use AppleScript for macOS (reliable fallback)
      const result = await this.captureAccessibilityViaAppleScript();
      const elapsed = Date.now() - startTime;

      if (result.success) {
        safeLog("Accessibility capture succeeded", {
          elapsed,
          appName: result.appName,
          textLength: result.visibleText?.length || 0,
        });

        return {
          appName: result.appName,
          windowTitle: result.windowTitle,
          visibleText: result.visibleText,
          accessibilityMs: elapsed,
          layer1Success: true,
        };
      }

      safeLog("Accessibility capture failed", { elapsed, error: result.error });
      return {
        accessibilityMs: elapsed,
        layer1Success: false,
        fallbackReason: result.error,
      };
    } catch (error) {
      const elapsed = Date.now() - startTime;
      safeLog("Accessibility capture error", { elapsed, error: error?.message });
      return {
        accessibilityMs: elapsed,
        layer1Success: false,
        fallbackReason: "capture-timeout",
      };
    }
  }

  async captureAccessibilityViaAppleScript() {
    // Get frontmost app info
    const appInfoScript = `
      tell application "System Events"
        set frontApp to first application process whose frontmost is true
        set appName to name of frontApp
        set bundleId to bundle identifier of frontApp
        
        try
          set frontWindow to first window of frontApp
          set windowTitle to name of frontWindow
        on error
          set windowTitle to ""
        end try
        
        return appName & "|||" & windowTitle & "|||" & bundleId
      end tell
    `;

    const appResult = await this.runAppleScript(appInfoScript);

    if (!appResult.success) {
      return { success: false, error: "app-info-failed" };
    }

    const parts = (appResult.output || "").trim().split("|||");
    const appName = parts[0] || "";
    const windowTitle = parts[1] || "";
    const bundleId = parts[2] || "";

    // Get visible text from frontmost window
    const visibleTextScript = `
      tell application "System Events"
        set frontApp to first application process whose frontmost is true
        
        try
          set frontWindow to first window of frontApp
          set allText to {}
          
          -- Try to get UI elements with value attribute
          repeat with uiElem in (every UI element of frontWindow whose role is "AXTextArea" or role is "AXTextField" or role is "AXStaticText" or role is "AXScrollArea")
            try
              set elemValue to value of uiElem
              if elemValue is not missing value and elemValue is not "" then
                set end of allText to elemValue as text
              end if
            end try
          end repeat
          
          -- Also try getting entire contents for scroll areas
          repeat with scrollArea in (every scroll area of frontWindow)
            try
              set scrollText to value of scrollArea
              if scrollText is not missing value and scrollText is not "" then
                set end of allText to scrollText as text
              end if
            end try
          end repeat
          
          if (count of allText) > 0 then
            set AppleScript's text item delimiters to "
"
            return allText as text
          else
            return ""
          end if
        on error errMsg
          return ""
        end try
      end tell
    `;

    const textResult = await this.runAppleScript(visibleTextScript);
    const visibleText = textResult.success ? (textResult.output || "").trim() : "";

    return {
      success: true,
      appName,
      windowTitle,
      visibleText,
      bundleId,
    };
  }

  async runAppleScript(script) {
    return new Promise((resolve) => {
      let resolved = false;
      const proc = spawn("osascript", ["-e", script], {
        // Use a shorter timeout than ACCESSIBILITY_TIMEOUT_MS to allow for cleanup
        timeout: ACCESSIBILITY_TIMEOUT_MS - 50,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (!resolved) {
          resolved = true;
          if (code === 0) {
            resolve({ success: true, output: stdout });
          } else {
            resolve({ success: false, error: stderr });
          }
        }
      });

      proc.on("error", (error) => {
        if (!resolved) {
          resolved = true;
          resolve({ success: false, error: error?.message });
        }
      });

      // Safety timeout: kill process if it hangs
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try {
            proc.kill("SIGTERM");
          } catch {}
          resolve({ success: false, error: "timeout" });
        }
      }, ACCESSIBILITY_TIMEOUT_MS);
    });
  }

  async captureAccessibilityTextCrossPlatform() {
    // Windows/Linux fallback: just return basic info
    const startTime = Date.now();

    try {
      // For now, return empty - can be extended with platform-specific implementations
      return {
        accessibilityMs: Date.now() - startTime,
        layer1Success: false,
        fallbackReason: "platform-unsupported",
      };
    } catch (error) {
      return {
        accessibilityMs: Date.now() - startTime,
        layer1Success: false,
        fallbackReason: "capture-timeout",
      };
    }
  }

  // ─── Window Matching Helper ───────────────────────────────────────────────

  /**
   * Find the window that best matches the frontmost app
   */
  findMatchingWindow(sources, frontAppName, bundleId) {
    if (!frontAppName) {
      return null;
    }

    const lowerAppName = frontAppName.toLowerCase();

    // Derive candidate names from bundleId (e.g. "com.google.Chrome" → ["chrome"])
    const bundleNameCandidates = [];
    if (bundleId) {
      const parts = bundleId.split(".");
      const lastPart = parts[parts.length - 1] || "";
      if (lastPart) {
        bundleNameCandidates.push(lastPart.toLowerCase());
      }
      // Also try last two parts for compound names (e.g. "com.microsoft.VisualStudioCode" → "visualstudiocode")
      if (parts.length >= 2) {
        const lastTwo = parts.slice(-2).join("").toLowerCase();
        if (lastTwo.length > 3) {
          bundleNameCandidates.push(lastTwo);
        }
      }
    }

    // Score each window source based on matching criteria
    const scoredSources = sources.map((source) => {
      const name = source.name || "";
      const lowerName = name.toLowerCase();
      let score = 0;

      // Strategy 1: Window name contains app name
      if (lowerName.includes(lowerAppName)) {
        score += 10;
      }

      // Strategy 2: App name contains window name (for short app names)
      if (lowerAppName.includes(lowerName) && lowerName.length > 5) {
        score += 5;
      }

      // Strategy 3: Match common patterns
      // e.g., "filename - AppName" or "AppName - filename"
      if (lowerName.endsWith(` - ${lowerAppName}`) || lowerName.startsWith(`${lowerAppName} - `)) {
        score += 8;
      }

      // Strategy 4: Match without spaces or special chars
      const cleanAppName = lowerAppName.replace(/[^a-z0-9]/g, "");
      const cleanWindowName = lowerName.replace(/[^a-z0-9]/g, "");
      if (cleanWindowName.includes(cleanAppName)) {
        score += 3;
      }

      // Strategy 5: BundleId-derived name match
      // e.g., bundleId "com.google.Chrome" → window name "Google Chrome"
      for (const candidate of bundleNameCandidates) {
        if (candidate.length > 2 && lowerName.includes(candidate)) {
          score += 12; // Higher than appName match since bundleId is more precise
          break;
        }
      }

      return { source, score, name };
    });

    // Find the highest scored source
    const bestMatch = scoredSources.reduce(
      (best, current) => {
        if (current.score > best.score) {
          return current;
        }
        return best;
      },
      { source: null, score: 0, name: "" }
    );

    // Require a minimum score to consider it a match
    if (bestMatch.score >= 3) {
      safeLog("Window matched", {
        appName: frontAppName,
        windowName: bestMatch.name,
        score: bestMatch.score,
      });
      return bestMatch.source;
    }

    return null;
  }

  // ─── Layer 2: Screenshot Capture ──────────────────────────────────────────

  async captureFrontWindowScreenshot() {
    const startTime = Date.now();

    try {
      // Get frontmost app info
      const [frontAppName, bundleId] = await Promise.all([
        this.getFrontAppName(),
        this.getFrontAppBundleId(),
      ]);

      const sources = await desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: { width: 1280, height: 720 },
      });

      if (sources.length === 0) {
        return {
          screenshotMs: Date.now() - startTime,
          layer2Success: false,
          fallbackReason: "no-sources",
        };
      }

      // Find the window matching the frontmost app using multiple strategies
      let targetSource = this.findMatchingWindow(sources, frontAppName, bundleId);

      // If no match found, return failure instead of fallback to wrong window
      // This ensures we don't capture unrelated windows
      if (!targetSource) {
        safeLog("Screenshot capture skipped: no matching window found", {
          frontAppName,
          bundleId,
          availableWindows: sources.map((s) => s.name),
        });
        return {
          screenshotMs: Date.now() - startTime,
          layer2Success: false,
          fallbackReason: "no-matching-window",
        };
      }

      const thumbnail = targetSource.thumbnail;

      // Convert to JPEG for smaller size
      const jpegBuffer = thumbnail.toJPEG(80);
      const base64 = jpegBuffer.toString("base64");

      const elapsed = Date.now() - startTime;
      safeLog("Screenshot capture succeeded", {
        elapsed,
        size: jpegBuffer.length,
        windowName: targetSource.name,
      });

      return {
        screenshotBase64: base64,
        screenshotMimeType: "image/jpeg",
        screenshotMs: elapsed,
        layer2Success: true,
      };
    } catch (error) {
      const elapsed = Date.now() - startTime;
      safeLog("Screenshot capture failed", { elapsed, error: error?.message });
      return {
        screenshotMs: elapsed,
        layer2Success: false,
        fallbackReason: "capture-timeout",
      };
    }
  }

  async getFrontAppBundleId() {
    try {
      const result = await this.runAppleScript(`
        tell application "System Events"
          set frontApp to first application process whose frontmost is true
          return bundle identifier of frontApp
        end tell
      `);
      return result.success ? (result.output || "").trim() : null;
    } catch {
      return null;
    }
  }

  async getFrontAppName() {
    try {
      const result = await this.runAppleScript(`
        tell application "System Events"
          set frontApp to first application process whose frontmost is true
          return name of frontApp
        end tell
      `);
      return result.success ? (result.output || "").trim() : null;
    } catch {
      return null;
    }
  }

  // ─── Main Capture Flow ───────────────────────────────────────────────────

  async captureContext(options = {}) {
    const startTime = Date.now();
    const storedFlags = this._readContextFlags();
    const textEnabled =
      typeof options.textEnabled === "boolean" ? options.textEnabled : storedFlags.textEnabled;
    const visionEnabled =
      typeof options.visionEnabled === "boolean"
        ? options.visionEnabled
        : storedFlags.visionEnabled;

    if (process.platform !== "darwin") {
      return {
        layer1Success: false,
        layer2Success: false,
        fallbackReason: "platform-unsupported",
        totalMs: Date.now() - startTime,
      };
    }

    if (!textEnabled && !visionEnabled) {
      return {
        layer1Success: false,
        layer2Success: false,
        fallbackReason: "disabled",
        totalMs: Date.now() - startTime,
      };
    }

    // Check if current app is sensitive
    const isSensitive = await this.isCurrentAppSensitive();
    if (isSensitive) {
      return {
        layer1Success: false,
        layer2Success: false,
        fallbackReason: "sensitive-app",
        totalMs: Date.now() - startTime,
      };
    }

    // Run Layer 1 and Layer 2 in parallel
    const [accessibilityResult, screenshotResult] = await Promise.all([
      textEnabled
        ? withTimeout(this.captureAccessibilityText(), ACCESSIBILITY_TIMEOUT_MS, "accessibility")
        : Promise.resolve({
            success: false,
            value: { layer1Success: false, fallbackReason: "text-disabled" },
          }),
      visionEnabled
        ? withTimeout(this.captureFrontWindowScreenshot(), SCREENSHOT_TIMEOUT_MS, "screenshot")
        : Promise.resolve({
            success: false,
            value: { layer2Success: false, fallbackReason: "vision-disabled" },
          }),
    ]);

    const totalMs = Date.now() - startTime;

    // Combine results
    const result = {
      appName: accessibilityResult.value?.appName,
      windowTitle: accessibilityResult.value?.windowTitle,
      visibleText: accessibilityResult.value?.visibleText,
      accessibilityMs: accessibilityResult.value?.accessibilityMs,
      screenshotBase64: screenshotResult.value?.screenshotBase64,
      screenshotMimeType: screenshotResult.value?.screenshotMimeType,
      screenshotMs: screenshotResult.value?.screenshotMs,
      layer1Success: accessibilityResult.success && accessibilityResult.value?.layer1Success,
      layer2Success: screenshotResult.success && screenshotResult.value?.layer2Success,
      totalMs,
    };

    // Set fallback reason if either layer failed
    if (!result.layer1Success) {
      result.fallbackReason = accessibilityResult.value?.fallbackReason || "capture-timeout";
    }
    if (!result.layer2Success) {
      result.fallbackReason =
        result.fallbackReason || screenshotResult.value?.fallbackReason || "capture-timeout";
    }

    safeLog("Context capture completed", {
      totalMs,
      textEnabled,
      visionEnabled,
      layer1Success: result.layer1Success,
      layer2Success: result.layer2Success,
      fallbackReason: result.fallbackReason,
    });

    return result;
  }

  // ─── Sensitive App Detection ──────────────────────────────────────────────

  async isCurrentAppSensitive() {
    if (process.platform !== "darwin") {
      return false;
    }

    try {
      // Get current app bundle ID using AppleScript
      const result = await this.runAppleScript(`
        tell application "System Events"
          set frontApp to first application process whose frontmost is true
          set appName to name of frontApp
          set bundleId to bundle identifier of frontApp
          return appName & "|||" & bundleId
        end tell
      `);

      if (result.success && result.output) {
        const parts = result.output.trim().split("|||");
        const appName = parts[0] || "";
        const bundleId = parts[1] || "";
        const bundleIdMatches = this.sensitiveApps.bundleIds.some(
          (configuredBundleId) =>
            configuredBundleId.trim().toLowerCase() === bundleId.trim().toLowerCase()
        );
        const processNameMatches = this.sensitiveApps.processNames.some((configuredName) =>
          matchesProcessName(appName, configuredName)
        );

        return bundleIdMatches || processNameMatches;
      }
    } catch (error) {
      safeLog("Sensitive app check failed", { error: error?.message });
    }

    return false;
  }

  // ─── Settings ─────────────────────────────────────────────────────────────

  _readContextFlags() {
    const parsed = this.readContextSettingsFile();
    const legacyEnabled = parsed?.enabled === true;
    const textEnabled =
      typeof parsed?.textEnabled === "boolean" ? parsed.textEnabled : legacyEnabled;
    const visionEnabled = typeof parsed?.visionEnabled === "boolean" ? parsed.visionEnabled : false;
    return { textEnabled, visionEnabled };
  }

  isContextEnabled() {
    const { textEnabled, visionEnabled } = this._readContextFlags();
    return textEnabled || visionEnabled;
  }

  setContextSettings(settings = {}) {
    try {
      const existing = this.readContextSettingsFile();
      const legacyEnabled = existing?.enabled === true;

      existing.textEnabled =
        typeof existing.textEnabled === "boolean" ? existing.textEnabled : legacyEnabled;
      existing.visionEnabled =
        typeof existing.visionEnabled === "boolean" ? existing.visionEnabled : false;

      if (typeof settings?.textEnabled === "boolean") {
        existing.textEnabled = settings.textEnabled;
      }
      if (typeof settings?.visionEnabled === "boolean") {
        existing.visionEnabled = settings.visionEnabled;
      }

      existing.enabled = existing.textEnabled === true || existing.visionEnabled === true;
      this.writeContextSettingsFile(existing);
      return { success: true };
    } catch (error) {
      return { success: false, error: error?.message };
    }
  }

  setContextEnabled(enabled) {
    if (enabled === true) {
      return this.setContextSettings({ textEnabled: true });
    }
    return this.setContextSettings({ textEnabled: false, visionEnabled: false });
  }

  getContextSettings() {
    const { textEnabled, visionEnabled } = this._readContextFlags();
    return {
      enabled: textEnabled || visionEnabled,
      textEnabled,
      visionEnabled,
      sensitiveApps: this.getSensitiveApps(),
    };
  }

  // ─── Open Settings Helpers ────────────────────────────────────────────────

  async openScreenRecordingSettings() {
    if (process.platform !== "darwin") {
      return { success: false, error: "Not macOS" };
    }

    try {
      this.screenRecordingCache = { value: null, expiresAt: 0 };
      const { shell } = require("electron");
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
      );
      return { success: true };
    } catch (error) {
      return { success: false, error: error?.message };
    }
  }

  async openAccessibilitySettings() {
    if (process.platform !== "darwin") {
      return { success: false, error: "Not macOS" };
    }

    try {
      this.accessibilityCache = { value: null, expiresAt: 0 };
      const { shell } = require("electron");
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
      );
      return { success: true };
    } catch (error) {
      return { success: false, error: error?.message };
    }
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  destroy() {
    this.accessibilityCache = { value: null, expiresAt: 0 };
    this.screenRecordingCache = { value: null, expiresAt: 0 };
  }

  async getFrontmostApp() {
    if (process.platform !== "darwin") {
      return null;
    }
    try {
      const result = await this.runAppleScript(`
        tell application "System Events"
          set frontApp to first application process whose frontmost is true
          set appName to name of frontApp
          set bundleId to bundle identifier of frontApp
          return appName & "|||" & bundleId
        end tell
      `);
      if (result.success && result.output) {
        const parts = result.output.trim().split("|||");
        return {
          appName: parts[0] || "",
          bundleId: parts[1] || "",
        };
      }
    } catch (error) {
      safeLog("getFrontmostApp check failed", { error: error?.message });
    }
    return null;
  }
}

module.exports = ContextCaptureManager;
