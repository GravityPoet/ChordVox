const fs = require("fs");
const path = require("path");
let app = null;

try {
  ({ app } = require("electron"));
} catch {}

const LOG_LEVELS = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const normalizeLevel = (value) => {
  if (!value) return null;
  const lower = String(value).toLowerCase();
  return Object.prototype.hasOwnProperty.call(LOG_LEVELS, lower) ? lower : null;
};

const readArgLogLevel = () => {
  const argv = process.argv || [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--log-level" && argv[i + 1]) {
      return argv[i + 1];
    }
    if (arg.startsWith("--log-level=")) {
      return arg.split("=", 2)[1];
    }
  }
  return null;
};

const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;
const MAX_LOG_FILE_COUNT = 5;
const MAX_RENDERER_LOG_MESSAGE_LENGTH = 2_000;
const MAX_RENDERER_LOG_LABEL_LENGTH = 120;
const MAX_RENDERER_LOG_META_DEPTH = 4;
const MAX_RENDERER_LOG_META_KEYS = 50;
const MAX_RENDERER_LOG_META_ITEMS = 50;
const MAX_RENDERER_LOG_META_STRING_LENGTH = 4_000;
const DEFAULT_LOG_LEVEL = "info";
const CALL_TRACE_STORE_DIRECTORY = "diagnostics";
const CALL_TRACE_STORE_FILENAME = "call-traces-v1.jsonl";
const MAX_PERSISTED_CALL_TRACE_ENTRIES = 1_000;
const CALL_TRACE_STORE_COMPACT_THRESHOLD = 1_200;
const MAX_CALL_TRACE_STORE_READ_BYTES = 8 * 1024 * 1024;
const PERSISTED_CALL_TRACE_META_FIELDS = new Set([
  "runId",
  "profileId",
  "phase",
  "status",
  "source",
  "occurredAt",
  "transcriptionProvider",
  "transcriptionModel",
  "reasoningProvider",
  "reasoningModel",
  "recordingDurationMs",
  "transcriptionProcessingDurationMs",
  "reasoningProcessingDurationMs",
  "durationMs",
  "error",
  "reason",
  "fallbackError",
  "reasonCode",
  "previewRemaining",
  "previewLimit",
]);
const SENSITIVE_KEY_REGEX =
  /(?:api[_-]?key|token|secret|authorization|credential|password|access[_-]?key|refresh[_-]?token)/i;
const SENSITIVE_TEXT_KEY_REGEX =
  /(?:^|[_-])(?:text|transcript|transcription|prompt|content|reasoning|raw|processed|body|preview|response)(?:$|[_-])/i;
const SENSITIVE_TEXT_FIELD_NAMES = new Set([
  "fullresponse",
  "processoutput",
  "requestbody",
  "requestpreview",
  "responsebody",
  "responsepreview",
  "visibletext",
]);
const SAFE_MODEL_METADATA_FIELD_NAMES = new Set([
  "transcriptionmodel",
  "transcriptionprovider",
  "reasoningmodel",
  "reasoningprovider",
]);
const SECRET_VALUE_REGEX =
  /\b(?:sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,}|gsk_[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{32,})\b/g;
const AUTH_HEADER_REGEX = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;

const ensurePrivateDirectory = (directoryPath) => {
  fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    fs.chmodSync(directoryPath, 0o700);
  }
};

const createPrivateAppendStream = (filePath) => {
  const fileDescriptor = fs.openSync(filePath, "a", 0o600);
  try {
    if (process.platform !== "win32") {
      fs.fchmodSync(fileDescriptor, 0o600);
    }
    return fs.createWriteStream(filePath, {
      fd: fileDescriptor,
      autoClose: true,
    });
  } catch (error) {
    fs.closeSync(fileDescriptor);
    throw error;
  }
};

// PII patterns kept conservative to limit false positives while still
// scrubbing the highest-risk identifiers (emails, JWTs, phone numbers,
// credit cards) before logs leave the device for a support upload.
const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const JWT_REGEX = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const PHONE_REGEX =
  /(?<!\d)(?:\+?\d{1,3}[ \-.]?)?(?:\(\d{2,4}\)[ \-.]?)?\d{3,4}[ \-.]?\d{3,4}(?!\d)/g;
const CREDIT_CARD_REGEX = /\b(?:\d[ -]*?){13,19}\b/g;

const redactString = (value) =>
  String(value)
    .replace(AUTH_HEADER_REGEX, "$1 [REDACTED]")
    .replace(JWT_REGEX, "[REDACTED_JWT]")
    .replace(SECRET_VALUE_REGEX, "[REDACTED]")
    .replace(EMAIL_REGEX, "[REDACTED_EMAIL]")
    .replace(CREDIT_CARD_REGEX, (match) => {
      // Skip strings without enough digit density to be a real PAN.
      const digits = match.replace(/\D/g, "");
      return digits.length >= 13 && digits.length <= 19 ? "[REDACTED_CARD]" : match;
    })
    .replace(PHONE_REGEX, (match) => {
      const digits = match.replace(/\D/g, "");
      return digits.length >= 7 ? "[REDACTED_PHONE]" : match;
    });

const normalizeLogKeyForMatch = (keyName) => String(keyName || "").replace(/[^A-Za-z0-9]/g, "");

const splitCamelCaseLogKey = (keyName) =>
  String(keyName || "").replace(/([a-z0-9])([A-Z])/g, "$1_$2");

const isSensitiveTextKey = (keyName) => {
  const rawKey = String(keyName || "");
  const compactKey = normalizeLogKeyForMatch(rawKey).toLowerCase();
  if (SAFE_MODEL_METADATA_FIELD_NAMES.has(compactKey)) {
    return false;
  }
  return (
    SENSITIVE_TEXT_FIELD_NAMES.has(compactKey) ||
    SENSITIVE_TEXT_KEY_REGEX.test(rawKey) ||
    SENSITIVE_TEXT_KEY_REGEX.test(splitCamelCaseLogKey(rawKey))
  );
};

const redactForLog = (value, keyName = "") => {
  if (value === null || value === undefined) return value;
  if (SENSITIVE_KEY_REGEX.test(String(keyName))) {
    return "[REDACTED]";
  }
  if (isSensitiveTextKey(keyName) && typeof value === "string") {
    return value ? `[REDACTED_TEXT length=${value.length}]` : "";
  }
  if (typeof value === "string") {
    return redactString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return `[Buffer ${value.length} bytes]`;
  }
  if (ArrayBuffer.isView(value)) {
    return `[${value.constructor?.name || "TypedArray"} ${value.byteLength} bytes]`;
  }
  if (value instanceof ArrayBuffer) {
    return `[ArrayBuffer ${value.byteLength} bytes]`;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactForLog(item));
  }
  if (typeof value === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = redactForLog(child, key);
    }
    return result;
  }
  return redactString(value);
};

const truncateString = (value, maxLength) => {
  const text = String(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}... [truncated ${text.length - maxLength} chars]`;
};

const boundRendererLogMeta = (value, depth = 0, keyName = "") => {
  if (depth > MAX_RENDERER_LOG_META_DEPTH) {
    return "[MaxDepth]";
  }
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return truncateString(value, MAX_RENDERER_LOG_META_STRING_LENGTH);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return `[Buffer ${value.length} bytes]`;
  }
  if (ArrayBuffer.isView(value)) {
    return `[${value.constructor?.name || "TypedArray"} ${value.byteLength} bytes]`;
  }
  if (value instanceof ArrayBuffer) {
    return `[ArrayBuffer ${value.byteLength} bytes]`;
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_RENDERER_LOG_META_ITEMS)
      .map((item) => boundRendererLogMeta(item, depth + 1, keyName));
    if (value.length > MAX_RENDERER_LOG_META_ITEMS) {
      items.push(`[truncated ${value.length - MAX_RENDERER_LOG_META_ITEMS} items]`);
    }
    return items;
  }
  if (typeof value === "object") {
    const result = {};
    const entries = Object.entries(value).slice(0, MAX_RENDERER_LOG_META_KEYS);
    for (const [key, child] of entries) {
      const safeKey = truncateString(key, MAX_RENDERER_LOG_LABEL_LENGTH);
      result[safeKey] = boundRendererLogMeta(child, depth + 1, safeKey);
    }
    const extraKeyCount = Object.keys(value).length - entries.length;
    if (extraKeyCount > 0) {
      result.__truncatedKeys = extraKeyCount;
    }
    return result;
  }
  return truncateString(value, MAX_RENDERER_LOG_META_STRING_LENGTH);
};

const getCallTraceTimestamp = (entry) => {
  const occurredAt = entry?.meta?.occurredAt;
  if (typeof occurredAt === "string" && Number.isFinite(Date.parse(occurredAt))) {
    return occurredAt;
  }
  return entry?.timestamp || null;
};

const sanitizeCallTraceEntryForPersistence = (entry) => {
  if (!entry || typeof entry !== "object" || entry.scope !== "call-trace") {
    return null;
  }

  const boundedMeta = boundRendererLogMeta(entry.meta);
  const redactedMeta = redactForLog(boundedMeta);
  if (!redactedMeta || typeof redactedMeta !== "object" || Array.isArray(redactedMeta)) {
    return null;
  }

  const meta = {};
  for (const field of PERSISTED_CALL_TRACE_META_FIELDS) {
    if (redactedMeta[field] !== undefined) {
      meta[field] = redactedMeta[field];
    }
  }

  const runId = typeof meta.runId === "string" ? meta.runId.trim() : "";
  if (!runId) {
    return null;
  }
  meta.runId = truncateString(runId, MAX_RENDERER_LOG_LABEL_LENGTH);

  const occurredAt = typeof meta.occurredAt === "string" ? meta.occurredAt : null;
  const entryTimestamp = typeof entry.timestamp === "string" ? entry.timestamp : null;
  const timestamp = Number.isFinite(Date.parse(occurredAt || ""))
    ? occurredAt
    : Number.isFinite(Date.parse(entryTimestamp || ""))
      ? entryTimestamp
      : null;
  if (!timestamp) {
    return null;
  }

  const id =
    typeof entry.id === "string" && entry.id.trim()
      ? truncateString(entry.id.trim(), MAX_RENDERER_LOG_LABEL_LENGTH)
      : `${timestamp}-${meta.runId}-${meta.phase || "session"}-${meta.status || "unknown"}`;

  return {
    id,
    timestamp,
    level: normalizeLevel(entry.level) || "info",
    message: "CALL_TRACE",
    scope: "call-trace",
    source:
      typeof entry.source === "string"
        ? truncateString(redactString(entry.source), MAX_RENDERER_LOG_LABEL_LENGTH)
        : null,
    meta,
  };
};

class DebugLogger {
  constructor(options = {}) {
    this.logLevel = this.resolveLogLevel();
    this.levelValue = LOG_LEVELS[this.logLevel] || LOG_LEVELS.info;
    this.debugMode = this.isDebugEnabled();
    this.logFile = null;
    this.logStream = null;
    this.logsDir = null;
    this.fileLoggingEnabled = false;
    this.fileLoggingPending = this.debugMode; // Track if we need to initialize file logging later
    this.recentEntries = [];
    this.maxRecentEntries = 2000;
    this.callTraceEntries = [];
    this.userDataPathOverride =
      typeof options.userDataPath === "string" && options.userDataPath.trim()
        ? path.resolve(options.userDataPath)
        : null;
    this.callTraceUserDataPath = this.userDataPathOverride;
    this.callTraceStorePath = null;
    this.callTraceStoreLoaded = false;
    this.callTraceStoreEntryCount = 0;
    this.discardPersistedCallTracesOnLoad = false;
    this.callTraceStoreWarningShown = false;

    // IMPORTANT: Do NOT call initializeFileLogging() here!
    // It uses app.getPath() which is unsafe before app.whenReady().
    // File logging will be initialized on first log write or via ensureFileLogging().
  }

  resolveCallTraceStorePath() {
    if (this.callTraceStorePath) {
      return this.callTraceStorePath;
    }

    try {
      let userDataPath = this.callTraceUserDataPath;
      if (!userDataPath) {
        if (!app?.isReady?.()) {
          return null;
        }
        userDataPath = app.getPath("userData");
      }
      if (!userDataPath) {
        return null;
      }

      const diagnosticsDirectory = path.join(userDataPath, CALL_TRACE_STORE_DIRECTORY);
      fs.mkdirSync(diagnosticsDirectory, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") {
        fs.chmodSync(diagnosticsDirectory, 0o700);
      }
      this.callTraceStorePath = path.join(diagnosticsDirectory, CALL_TRACE_STORE_FILENAME);
      return this.callTraceStorePath;
    } catch (error) {
      if (!this.callTraceStoreWarningShown) {
        console.warn(
          "Saved call diagnostics are unavailable; continuing in memory:",
          error.message
        );
        this.callTraceStoreWarningShown = true;
      }
      return null;
    }
  }

  readCallTraceStore(storePath) {
    if (!fs.existsSync(storePath)) {
      return { entries: [], needsRewrite: false };
    }

    let content = "";
    let needsRewrite = false;
    try {
      const stats = fs.statSync(storePath);
      if (stats.size > MAX_CALL_TRACE_STORE_READ_BYTES) {
        const bytesToRead = MAX_CALL_TRACE_STORE_READ_BYTES;
        const buffer = Buffer.alloc(bytesToRead);
        const fileDescriptor = fs.openSync(storePath, "r");
        try {
          fs.readSync(fileDescriptor, buffer, 0, bytesToRead, stats.size - bytesToRead);
        } finally {
          fs.closeSync(fileDescriptor);
        }
        content = buffer.toString("utf8");
        const firstCompleteLine = content.indexOf("\n");
        content = firstCompleteLine >= 0 ? content.slice(firstCompleteLine + 1) : "";
        needsRewrite = true;
      } else {
        content = fs.readFileSync(storePath, "utf8");
      }
    } catch (error) {
      console.warn("Failed to read saved call diagnostics:", error.message);
      return { entries: [], needsRewrite: true };
    }

    const entries = [];
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = sanitizeCallTraceEntryForPersistence(JSON.parse(line));
        if (entry) {
          entries.push(entry);
        } else {
          needsRewrite = true;
        }
      } catch {
        needsRewrite = true;
      }
    }

    if (entries.length > MAX_PERSISTED_CALL_TRACE_ENTRIES) {
      return {
        entries: entries.slice(entries.length - MAX_PERSISTED_CALL_TRACE_ENTRIES),
        needsRewrite: true,
      };
    }
    return { entries, needsRewrite };
  }

  replaceCallTraceStore(entries) {
    const storePath = this.resolveCallTraceStorePath();
    if (!storePath) return false;

    const persistableEntries = entries
      .map((entry) => sanitizeCallTraceEntryForPersistence(entry))
      .filter(Boolean)
      .slice(-MAX_PERSISTED_CALL_TRACE_ENTRIES);
    const payload = persistableEntries.length
      ? `${persistableEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`
      : "";
    const temporaryPath = `${storePath}.tmp-${process.pid}-${Date.now()}`;

    try {
      fs.writeFileSync(temporaryPath, payload, { encoding: "utf8", mode: 0o600 });
      if (process.platform !== "win32") {
        fs.chmodSync(temporaryPath, 0o600);
      }
      fs.renameSync(temporaryPath, storePath);
      this.callTraceStoreEntryCount = persistableEntries.length;
      return true;
    } catch (error) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {}
      console.warn("Failed to replace saved call diagnostics:", error.message);
      return false;
    }
  }

  ensureCallTraceStoreLoaded() {
    if (this.callTraceStoreLoaded) {
      return true;
    }

    const storePath = this.resolveCallTraceStorePath();
    if (!storePath) {
      return false;
    }

    const currentCallTraceEntries = this.callTraceEntries;
    const readResult = this.discardPersistedCallTracesOnLoad
      ? { entries: [], needsRewrite: true }
      : this.readCallTraceStore(storePath);
    const mergedCallTraceEntries = [];
    const seenEntryIds = new Set();
    for (const entry of [...readResult.entries, ...currentCallTraceEntries]) {
      const persistableEntry = sanitizeCallTraceEntryForPersistence(entry);
      if (!persistableEntry || seenEntryIds.has(persistableEntry.id)) continue;
      seenEntryIds.add(persistableEntry.id);
      mergedCallTraceEntries.push(persistableEntry);
    }
    mergedCallTraceEntries.sort((left, right) => {
      const leftTime = Date.parse(getCallTraceTimestamp(left) || "") || 0;
      const rightTime = Date.parse(getCallTraceTimestamp(right) || "") || 0;
      return leftTime - rightTime;
    });

    this.callTraceEntries = mergedCallTraceEntries.slice(-MAX_PERSISTED_CALL_TRACE_ENTRIES);
    this.callTraceStoreLoaded = true;
    this.discardPersistedCallTracesOnLoad = false;
    this.callTraceStoreEntryCount = readResult.entries.length;

    if (
      readResult.needsRewrite ||
      currentCallTraceEntries.length > 0 ||
      mergedCallTraceEntries.length !== readResult.entries.length
    ) {
      this.replaceCallTraceStore(mergedCallTraceEntries);
    } else if (process.platform !== "win32" && fs.existsSync(storePath)) {
      try {
        fs.chmodSync(storePath, 0o600);
      } catch (error) {
        console.warn("Failed to secure saved call diagnostics:", error.message);
      }
    }
    return true;
  }

  persistCallTraceEntry(entry) {
    if (!this.ensureCallTraceStoreLoaded()) return;
    const persistableEntry = sanitizeCallTraceEntryForPersistence(entry);
    const storePath = this.resolveCallTraceStorePath();
    if (!persistableEntry || !storePath) return;

    try {
      fs.appendFileSync(storePath, `${JSON.stringify(persistableEntry)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      if (process.platform !== "win32") {
        fs.chmodSync(storePath, 0o600);
      }
      this.callTraceStoreEntryCount += 1;
      if (this.callTraceStoreEntryCount > CALL_TRACE_STORE_COMPACT_THRESHOLD) {
        this.replaceCallTraceStore(this.callTraceEntries);
      }
    } catch (error) {
      console.warn("Failed to save call diagnostics:", error.message);
    }
  }

  clearCallTraces() {
    const storeLoaded = this.ensureCallTraceStoreLoaded();
    this.callTraceEntries = [];
    this.recentEntries = this.recentEntries.filter((entry) => entry.scope !== "call-trace");
    if (storeLoaded) {
      this.replaceCallTraceStore([]);
    } else {
      this.discardPersistedCallTracesOnLoad = true;
    }
  }

  initializeFileLogging() {
    if (this.fileLoggingEnabled) return;

    try {
      let userDataPath = this.userDataPathOverride;
      if (!userDataPath) {
        // app.getPath() is unsafe before app.whenReady(). A path override is
        // accepted for isolated verification without weakening production checks.
        if (!app?.isReady?.()) {
          return;
        }
        userDataPath = app.getPath("userData");
      }

      this.logsDir = path.join(userDataPath, "logs");
      ensurePrivateDirectory(this.logsDir);
      this.pruneOldLogFiles();

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      this.logFile = path.join(this.logsDir, `debug-${timestamp}.log`);

      this.logStream = createPrivateAppendStream(this.logFile);
      this.fileLoggingEnabled = true;
      this.fileLoggingPending = false;

      this.debug("Debug logging enabled", { logFile: this.logFile });
      this.info("System Info", {
        platform: process.platform,
        nodeVersion: process.version,
        electronVersion: process.versions.electron,
        appPath: app?.getAppPath?.() || null,
        userDataPath,
        resourcesPath: process.resourcesPath,
        environment: process.env.NODE_ENV,
      });
    } catch (error) {
      this.fileLoggingEnabled = false;
      this.fileLoggingPending = false;
      console.error("Failed to initialize debug logging:", error);
    }
  }

  /**
   * Ensures file logging is initialized if debug mode is enabled.
   * This should be called after app.whenReady() to safely initialize file logging.
   */
  ensureFileLogging() {
    if (this.fileLoggingPending && !this.fileLoggingEnabled) {
      this.initializeFileLogging();
    }
  }

  resolveLogLevel() {
    const argLevel = normalizeLevel(readArgLogLevel());
    if (argLevel) {
      return argLevel;
    }

    const envLevel = normalizeLevel(process.env.CHORDVOX_LOG_LEVEL || process.env.LOG_LEVEL);
    if (envLevel) {
      return envLevel;
    }

    return DEFAULT_LOG_LEVEL;
  }

  refreshLogLevel() {
    const nextLevel = this.resolveLogLevel();

    this.logLevel = nextLevel;
    this.levelValue = LOG_LEVELS[this.logLevel] || LOG_LEVELS.info;
    this.debugMode = this.isDebugEnabled();

    if (this.debugMode) {
      this.fileLoggingPending = !this.fileLoggingEnabled;
      if (!this.fileLoggingEnabled) {
        this.initializeFileLogging();
      }
    } else {
      this.disableFileLogging();
    }
  }

  getLevel() {
    return this.logLevel;
  }

  isDebugEnabled() {
    return this.levelValue <= LOG_LEVELS.debug;
  }

  shouldLog(level) {
    const normalized = normalizeLevel(level) || "info";
    return LOG_LEVELS[normalized] >= this.levelValue;
  }

  formatArgs(args) {
    return args
      .map((arg) => {
        if (typeof arg === "object") {
          try {
            return JSON.stringify(redactForLog(arg), null, 2);
          } catch (error) {
            return redactString(arg);
          }
        }
        return redactString(arg);
      })
      .join(" ");
  }

  formatMeta(meta) {
    if (meta === undefined) return "";
    if (typeof meta === "string") return redactString(meta);
    try {
      return JSON.stringify(redactForLog(meta), null, 2);
    } catch (error) {
      return redactString(meta);
    }
  }

  sanitizeMessage(message) {
    return redactString(message);
  }

  rotateLogFileIfNeeded() {
    if (!this.logFile || !this.logStream) return;
    try {
      const stats = fs.existsSync(this.logFile) ? fs.statSync(this.logFile) : null;
      if (!stats || stats.size < MAX_LOG_FILE_BYTES) return;

      this.logStream.end();
      const rotatedPath = this.logFile.replace(/\.log$/, `-${Date.now()}.log`);
      fs.renameSync(this.logFile, rotatedPath);
      this.logStream = createPrivateAppendStream(this.logFile);
      this.pruneOldLogFiles();
    } catch (error) {
      console.warn("Failed to rotate debug log:", error.message);
    }
  }

  pruneOldLogFiles() {
    if (!this.logsDir || !fs.existsSync(this.logsDir)) return;
    try {
      const files = fs
        .readdirSync(this.logsDir)
        .filter((name) => /^debug-.*\.log$/.test(name))
        .map((name) => {
          const filePath = path.join(this.logsDir, name);
          if (process.platform !== "win32") {
            fs.chmodSync(filePath, 0o600);
          }
          const stats = fs.statSync(filePath);
          return { filePath, mtimeMs: stats.mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      for (const file of files.slice(MAX_LOG_FILE_COUNT)) {
        fs.unlinkSync(file.filePath);
      }
    } catch (error) {
      console.warn("Failed to prune debug logs:", error.message);
    }
  }

  write(level, message, meta, scope, source) {
    const normalized = normalizeLevel(level) || "info";
    if (!this.shouldLog(normalized)) return;

    if (scope === "call-trace") {
      this.ensureCallTraceStoreLoaded();
    }

    // Try to initialize file logging if pending and app is ready
    if (this.fileLoggingPending && !this.fileLoggingEnabled) {
      this.initializeFileLogging();
    }

    const timestamp = new Date().toISOString();
    const scopeTag = scope ? `[${scope}]` : "";
    const sourceTag = source ? `[${source}]` : "";
    const levelTag = `[${normalized.toUpperCase()}]`;
    const safeMessage = this.sanitizeMessage(message);
    const safeMeta = redactForLog(meta);
    const baseLine = `[${timestamp}] ${levelTag}${scopeTag}${sourceTag} ${safeMessage}`;
    const metaText = this.formatMeta(meta);
    const logLine = metaText ? `${baseLine} ${metaText}\n` : `${baseLine}\n`;
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp,
      level: normalized,
      message: safeMessage,
      scope: scope || null,
      source: source || null,
      meta: meta === undefined ? null : safeMeta,
    };

    this.recentEntries.push(entry);
    if (this.recentEntries.length > this.maxRecentEntries) {
      this.recentEntries.splice(0, this.recentEntries.length - this.maxRecentEntries);
    }
    if (scope === "call-trace") {
      this.callTraceEntries.push(entry);
      if (this.callTraceEntries.length > MAX_PERSISTED_CALL_TRACE_ENTRIES) {
        this.callTraceEntries.splice(
          0,
          this.callTraceEntries.length - MAX_PERSISTED_CALL_TRACE_ENTRIES
        );
      }
      this.persistCallTraceEntry(entry);
    }

    const consoleFn =
      normalized === "error" || normalized === "fatal"
        ? console.error
        : normalized === "warn"
          ? console.warn
          : console.log;

    if (meta !== undefined) {
      consoleFn(`${levelTag}${scopeTag}${sourceTag} ${safeMessage}`, safeMeta);
    } else {
      consoleFn(`${levelTag}${scopeTag}${sourceTag} ${safeMessage}`);
    }

    if (this.logStream) {
      this.rotateLogFileIfNeeded();
      this.logStream.write(logLine);
    }
  }

  log(...args) {
    this.write("debug", this.formatArgs(args));
  }

  debug(message, meta, scope, source) {
    this.write("debug", message, meta, scope, source);
  }

  trace(message, meta, scope, source) {
    this.write("trace", message, meta, scope, source);
  }

  info(message, meta, scope, source) {
    this.write("info", message, meta, scope, source);
  }

  warn(message, meta, scope, source) {
    this.write("warn", message, meta, scope, source);
  }

  logReasoning(stage, details) {
    this.debug(stage, details, "reasoning");
  }

  error(...args) {
    const message = `ERROR: ${this.formatArgs(args)}`;
    this.write("error", message);
  }

  fatal(...args) {
    const message = `FATAL: ${this.formatArgs(args)}`;
    this.write("fatal", message);
  }

  logEntry(entry) {
    if (!entry || typeof entry !== "object") return;
    const normalized = normalizeLevel(entry.level) || "info";
    const message = entry.message
      ? truncateString(entry.message, MAX_RENDERER_LOG_MESSAGE_LENGTH)
      : "";
    const scope = entry.scope
      ? truncateString(entry.scope, MAX_RENDERER_LOG_LABEL_LENGTH)
      : undefined;
    const source = entry.source
      ? truncateString(entry.source, MAX_RENDERER_LOG_LABEL_LENGTH)
      : "renderer";
    this.write(normalized, message, boundRendererLogMeta(entry.meta), scope, source);
  }

  logFFmpegDebug(context, ffmpegPath, additionalInfo = {}) {
    if (!this.isDebugEnabled()) return;

    const debugInfo = {
      context,
      ffmpegPath,
      exists: ffmpegPath ? fs.existsSync(ffmpegPath) : false,
      platform: process.platform,
      ...additionalInfo,
    };

    if (ffmpegPath && fs.existsSync(ffmpegPath)) {
      try {
        const stats = fs.statSync(ffmpegPath);
        debugInfo.fileInfo = {
          size: stats.size,
          isFile: stats.isFile(),
          // Skip X_OK check on Windows (not reliable)
          isExecutable: process.platform !== "win32" ? !!(stats.mode & fs.constants.X_OK) : false,
          executableCheckSkipped: process.platform === "win32",
          permissions: stats.mode.toString(8),
          modified: stats.mtime,
        };
      } catch (e) {
        debugInfo.statError = e.message;
      }
    }

    // Check parent directory permissions
    if (ffmpegPath) {
      const dir = path.dirname(ffmpegPath);
      try {
        fs.accessSync(dir, fs.constants.R_OK);
        debugInfo.dirReadable = true;
      } catch (e) {
        debugInfo.dirReadable = false;
        debugInfo.dirError = e.message;
      }
    }

    // Platform-specific path checks
    let possiblePaths = [];
    if (process.platform === "win32") {
      possiblePaths = [
        ffmpegPath,
        ffmpegPath?.replace(/app\.asar([/\\])/, "app.asar.unpacked$1"),
        path.join(
          process.resourcesPath || "",
          "app.asar.unpacked",
          "node_modules",
          "ffmpeg-static",
          "ffmpeg.exe"
        ),
        path.join(process.env.ProgramFiles || "C:\\Program Files", "ffmpeg", "bin", "ffmpeg.exe"),
        "C:\\ffmpeg\\bin\\ffmpeg.exe",
      ].filter(Boolean);
    } else {
      possiblePaths = [
        ffmpegPath,
        ffmpegPath?.replace("app.asar", "app.asar.unpacked"),
        path.join(
          process.resourcesPath || "",
          "app.asar.unpacked",
          "node_modules",
          "ffmpeg-static",
          "ffmpeg"
        ),
        "/usr/local/bin/ffmpeg",
        "/opt/homebrew/bin/ffmpeg",
        "/usr/bin/ffmpeg",
      ].filter(Boolean);
    }

    debugInfo.pathChecks = possiblePaths.map((p) => ({
      path: p,
      exists: fs.existsSync(p),
      normalized: path.normalize(p),
    }));

    this.debug(`FFmpeg Debug - ${context}`, debugInfo, "ffmpeg");
  }

  logAudioData(context, audioBlob) {
    if (!this.isDebugEnabled()) return;

    const audioInfo = {
      context,
      type: audioBlob?.type || "unknown",
      size: audioBlob?.size || 0,
      constructor: audioBlob?.constructor?.name || "unknown",
    };

    if (audioBlob instanceof ArrayBuffer) {
      audioInfo.byteLength = audioBlob.byteLength;
      // Check first few bytes
      const view = new Uint8Array(audioBlob, 0, Math.min(16, audioBlob.byteLength));
      audioInfo.firstBytes = Array.from(view)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
    } else if (audioBlob instanceof Uint8Array) {
      audioInfo.byteLength = audioBlob.byteLength;
      const view = audioBlob.slice(0, Math.min(16, audioBlob.byteLength));
      audioInfo.firstBytes = Array.from(view)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
    }

    this.debug("Audio Data Debug", audioInfo, "audio");
  }

  logProcessStart(command, args, options = {}) {
    if (!this.isDebugEnabled()) return;

    this.debug(
      "Starting process",
      {
        command,
        args,
        cwd: options.cwd || process.cwd(),
        env: {
          FFMPEG_PATH: options.env?.FFMPEG_PATH,
          FFMPEG_EXECUTABLE: options.env?.FFMPEG_EXECUTABLE,
          FFMPEG_BINARY: options.env?.FFMPEG_BINARY,
          PATH_preview: options.env?.PATH?.substring(0, 200) + "...",
        },
      },
      "process"
    );
  }

  logProcessOutput(processName, type, data) {
    if (!this.isDebugEnabled()) return;

    const output = data.toString().trim();
    if (output) {
      this.debug(`${processName} ${type}`, output, "process");
    }
  }

  logWhisperPipeline(stage, details) {
    if (!this.isDebugEnabled()) return;
    this.debug(`Whisper Pipeline - ${stage}`, details, "whisper");
  }

  logSTTPipeline(stage, details) {
    if (!this.isDebugEnabled()) return;
    this.debug(`STT Pipeline - ${stage}`, details, "stt");
  }

  getLogPath() {
    return this.logFile;
  }

  isEnabled() {
    return this.isDebugEnabled();
  }

  getRecentEntries(options = {}) {
    const limit = Math.max(1, Math.min(Number(options.limit) || 200, 1000));
    const scope = options.scope ? String(options.scope) : null;
    const runId = options.runId ? String(options.runId) : null;

    if (scope === "call-trace" || runId) {
      this.ensureCallTraceStoreLoaded();
    }

    let entries = scope === "call-trace" ? this.callTraceEntries : this.recentEntries;
    if (scope && scope !== "call-trace") {
      entries = entries.filter((entry) => entry.scope === scope);
    }
    if (runId) {
      entries = entries.filter(
        (entry) => entry?.meta && typeof entry.meta === "object" && entry.meta.runId === runId
      );
    }

    if (entries.length <= limit) {
      return entries.slice();
    }
    return entries.slice(entries.length - limit);
  }

  clearRecentEntries(scope = null) {
    if (scope === "call-trace") {
      this.clearCallTraces();
      return;
    }
    if (!scope) {
      this.recentEntries = [];
      this.callTraceEntries = [];
      return;
    }
    this.recentEntries = this.recentEntries.filter((entry) => entry.scope !== scope);
  }

  getCallTraceSessions(limit = 20) {
    const entries = this.getRecentEntries({ scope: "call-trace", limit: 1000 });
    const sessions = new Map();
    const terminalStatuses = new Set(["success", "error", "cancelled", "skipped", "fallback"]);

    const ensureSession = (runId) => {
      if (!sessions.has(runId)) {
        sessions.set(runId, {
          runId,
          profileId: "primary",
          startedAt: null,
          updatedAt: null,
          sessionStatus: "unknown",
          transcriptionStatus: "unknown",
          reasoningStatus: "unknown",
          pasteStatus: "unknown",
          transcriptionModel: null,
          transcriptionProvider: null,
          reasoningModel: null,
          reasoningProvider: null,
          source: null,
          error: null,
          eventsCount: 0,
          failurePhase: null,
          sessionDurationMs: null,
          recordingDurationMs: null,
          transcriptionProcessingDurationMs: null,
          reasoningProcessingDurationMs: null,
          isStale: false,
          _hasTerminalStatus: false,
          _lastEventTimeMs: 0,
        });
      }
      return sessions.get(runId);
    };

    for (const entry of entries) {
      const meta = entry?.meta;
      if (!meta || typeof meta !== "object") continue;
      const runId = meta.runId ? String(meta.runId) : null;
      if (!runId) continue;

      const session = ensureSession(runId);
      session.eventsCount += 1;
      session.profileId = meta.profileId || session.profileId || "primary";
      const traceTimestamp = getCallTraceTimestamp(entry);
      const traceTimeMs = traceTimestamp ? Date.parse(traceTimestamp) : NaN;
      const startedTimeMs = session.startedAt ? Date.parse(session.startedAt) : NaN;
      const updatedTimeMs = session.updatedAt ? Date.parse(session.updatedAt) : NaN;
      if (traceTimestamp && (!Number.isFinite(startedTimeMs) || traceTimeMs < startedTimeMs)) {
        session.startedAt = traceTimestamp;
      }
      if (traceTimestamp && (!Number.isFinite(updatedTimeMs) || traceTimeMs > updatedTimeMs)) {
        session.updatedAt = traceTimestamp;
      }

      const phase = meta.phase ? String(meta.phase) : "";
      const status = meta.status ? String(meta.status) : "";
      const entryTime = traceTimeMs;
      if (Number.isFinite(entryTime)) {
        session._lastEventTimeMs = Math.max(Number(session._lastEventTimeMs) || 0, entryTime);
      }
      if (terminalStatuses.has(status)) {
        session._hasTerminalStatus = true;
      }

      if (phase === "session" && status) {
        session.sessionStatus = status;
      }
      if (phase === "transcription" && status) {
        session.transcriptionStatus = status;
      }
      if (phase === "reasoning" && status) {
        session.reasoningStatus = status;
      }
      if (phase === "paste" && status) {
        session.pasteStatus = status;
      }

      if (meta.source) session.source = String(meta.source);
      if (meta.transcriptionModel) session.transcriptionModel = String(meta.transcriptionModel);
      if (meta.transcriptionProvider)
        session.transcriptionProvider = String(meta.transcriptionProvider);
      if (meta.reasoningModel) session.reasoningModel = String(meta.reasoningModel);
      if (meta.reasoningProvider) session.reasoningProvider = String(meta.reasoningProvider);
      if (meta.error) {
        session.error = String(meta.error);
        session.failurePhase = phase || session.failurePhase || null;
      }
      if (status === "error" && phase) {
        session.failurePhase = phase;
      }
      if (phase === "session" && Number.isFinite(Number(meta.durationMs))) {
        session.sessionDurationMs = Number(meta.durationMs);
      }
      if (Number.isFinite(Number(meta.recordingDurationMs))) {
        session.recordingDurationMs = Number(meta.recordingDurationMs);
      }
      if (
        phase === "recording" &&
        status === "start" &&
        Number.isFinite(entryTime) &&
        !Number.isFinite(Number(session._recordingStartedAtMs))
      ) {
        session._recordingStartedAtMs = entryTime;
      }
      if (
        phase === "transcription" &&
        status === "start" &&
        Number.isFinite(entryTime) &&
        Number.isFinite(Number(session._recordingStartedAtMs)) &&
        !Number.isFinite(Number(session.recordingDurationMs))
      ) {
        session.recordingDurationMs = Math.max(
          0,
          entryTime - Number(session._recordingStartedAtMs)
        );
      }
      if (
        phase === "recording" &&
        ["success", "error", "cancelled"].includes(status) &&
        Number.isFinite(entryTime) &&
        Number.isFinite(Number(session._recordingStartedAtMs)) &&
        !Number.isFinite(Number(session.recordingDurationMs))
      ) {
        session.recordingDurationMs = Math.max(
          0,
          entryTime - Number(session._recordingStartedAtMs)
        );
      }
      if (Number.isFinite(Number(meta.transcriptionProcessingDurationMs))) {
        session.transcriptionProcessingDurationMs = Number(meta.transcriptionProcessingDurationMs);
      }
      if (Number.isFinite(Number(meta.reasoningProcessingDurationMs))) {
        session.reasoningProcessingDurationMs = Number(meta.reasoningProcessingDurationMs);
      }
    }

    const sessionList = Array.from(sessions.values());
    const latestTraceEventTimeMs = sessionList.reduce(
      (latest, session) => Math.max(latest, Number(session._lastEventTimeMs) || 0),
      0
    );

    for (const session of sessionList) {
      const hasBeenSuperseded =
        latestTraceEventTimeMs > 0 &&
        Number(session._lastEventTimeMs) > 0 &&
        latestTraceEventTimeMs > Number(session._lastEventTimeMs);
      if (session.sessionStatus === "start" && !session._hasTerminalStatus && hasBeenSuperseded) {
        session.sessionStatus = "cancelled";
        session.failurePhase = session.failurePhase || "session";
        session.sessionDurationMs = Number.isFinite(Number(session.sessionDurationMs))
          ? session.sessionDurationMs
          : 0;
        session.isStale = true;
      }
      delete session._hasTerminalStatus;
      delete session._lastEventTimeMs;
    }

    return sessionList
      .sort((a, b) => {
        const at = a.updatedAt ? Date.parse(a.updatedAt) : 0;
        const bt = b.updatedAt ? Date.parse(b.updatedAt) : 0;
        return bt - at;
      })
      .slice(0, Math.max(1, Math.min(Number(limit) || 20, 200)));
  }

  getCallTraceEvents(runId, limit = 80) {
    if (!runId) return [];
    return this.getRecentEntries({
      scope: "call-trace",
      runId: String(runId),
      limit: Math.max(1, Math.min(Number(limit) || 80, 300)),
    }).map((entry) => {
      const timestamp = getCallTraceTimestamp(entry);
      return timestamp && timestamp !== entry.timestamp ? { ...entry, timestamp } : entry;
    });
  }

  disableFileLogging() {
    if (this.logStream) {
      this.logStream.end();
    }
    this.logStream = null;
    this.logFile = null;
    this.fileLoggingEnabled = false;
    this.fileLoggingPending = false;
  }

  close() {
    if (this.logStream) {
      this.log("📝 Debug logger closing");
      this.disableFileLogging();
    }
  }
}

// Singleton instance
const debugLogger = new DebugLogger();

module.exports = debugLogger;
module.exports.DebugLogger = DebugLogger;
