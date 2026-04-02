const path = require("path");
const fs = require("fs");
const fsPromises = require("fs/promises");
const { app } = require("electron");
const { normalizeUiLanguage } = require("./i18nMain");
const {
  getSpeechModelsRoot,
  getDefaultSpeechModelsRoot,
  normalizeModelsRootPath,
  migrateSpeechModelsRootSync,
} = require("./modelDirUtils");

const PERSISTED_KEYS = [
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "DOUBAO_APP_ID",
  "DOUBAO_ACCESS_TOKEN",
  "CUSTOM_TRANSCRIPTION_API_KEY",
  "CUSTOM_REASONING_API_KEY",
  "LICENSE_API_BASE_URL",
  "LICENSE_PRODUCT_ID",
  "LICENSE_ALLOW_DEV_KEYS",
  "LOCAL_TRANSCRIPTION_PROVIDER",
  "PARAKEET_MODEL",
  "LOCAL_WHISPER_MODEL",
  "SENSEVOICE_MODEL_PATH",
  "SENSEVOICE_BINARY_PATH",
  "REASONING_PROVIDER",
  "LOCAL_REASONING_MODEL",
  "DICTATION_KEY",
  "ACTIVATION_MODE",
  "AUTO_START_ENABLED",
  "AUTO_CHECK_UPDATE",
  "UI_LANGUAGE",
  "MODEL_STORAGE_ROOT",
];

const PROTECTED_PACKAGED_USER_ENV_PREFIXES = ["LICENSE_"];

class EnvironmentManager {
  constructor() {
    this.loadEnvironmentVariables();
  }

  _isPackagedRelease() {
    return app.isPackaged && process.env.NODE_ENV !== "development";
  }

  _shouldIgnoreUserDataEnvKey(key) {
    if (!this._isPackagedRelease()) return false;
    return PROTECTED_PACKAGED_USER_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
  }

  _loadUserDataEnvironmentFile(envPath) {
    try {
      if (!fs.existsSync(envPath)) {
        return;
      }
      const dotenv = require("dotenv");
      const parsed = dotenv.parse(fs.readFileSync(envPath, "utf8"));
      for (const [key, value] of Object.entries(parsed)) {
        if (this._shouldIgnoreUserDataEnvKey(key)) {
          continue;
        }
        if (typeof process.env[key] === "undefined") {
          process.env[key] = value;
        }
      }
    } catch { }
  }

  loadEnvironmentVariables() {
    // Loaded in priority order - later loads do not override existing process.env values.
    const userDataEnv = path.join(app.getPath("userData"), ".env");
    this._loadUserDataEnvironmentFile(userDataEnv);

    const fallbackPaths = [
      path.join(__dirname, "..", "..", ".env"), // Development
      path.join(process.resourcesPath, ".env"),
      path.join(process.resourcesPath, "app.asar.unpacked", ".env"),
      path.join(process.resourcesPath, "app", ".env"), // Legacy
    ];

    for (const envPath of fallbackPaths) {
      try {
        if (fs.existsSync(envPath)) {
          require("dotenv").config({ path: envPath });
        }
      } catch { }
    }
  }

  _getKey(envVarName) {
    return process.env[envVarName] || "";
  }

  _saveKey(envVarName, key) {
    process.env[envVarName] = key;
    return { success: true };
  }

  _saveProtectedLicenseRuntimeKey(envVarName, value) {
    if (this._isPackagedRelease()) {
      this.saveAllKeysToEnvFile().catch(() => { });
      return {
        success: false,
        value: this._getKey(envVarName),
        error: "LICENSE_RUNTIME_LOCKED",
        message: "License runtime overrides are disabled in packaged builds.",
      };
    }
    return this._saveKey(envVarName, value);
  }

  getOpenAIKey() {
    return this._getKey("OPENAI_API_KEY");
  }

  saveOpenAIKey(key) {
    return this._saveKey("OPENAI_API_KEY", key);
  }

  getOpenRouterKey() {
    return this._getKey("OPENROUTER_API_KEY");
  }

  saveOpenRouterKey(key) {
    return this._saveKey("OPENROUTER_API_KEY", key);
  }

  getAnthropicKey() {
    return this._getKey("ANTHROPIC_API_KEY");
  }

  saveAnthropicKey(key) {
    return this._saveKey("ANTHROPIC_API_KEY", key);
  }

  getGeminiKey() {
    return this._getKey("GEMINI_API_KEY");
  }

  saveGeminiKey(key) {
    return this._saveKey("GEMINI_API_KEY", key);
  }

  getGroqKey() {
    return this._getKey("GROQ_API_KEY");
  }

  saveGroqKey(key) {
    return this._saveKey("GROQ_API_KEY", key);
  }

  getDoubaoAppId() {
    return this._getKey("DOUBAO_APP_ID");
  }

  saveDoubaoAppId(appId) {
    return this._saveKey("DOUBAO_APP_ID", appId);
  }

  getDoubaoAccessToken() {
    return this._getKey("DOUBAO_ACCESS_TOKEN");
  }

  saveDoubaoAccessToken(token) {
    return this._saveKey("DOUBAO_ACCESS_TOKEN", token);
  }

  getCustomTranscriptionKey() {
    return this._getKey("CUSTOM_TRANSCRIPTION_API_KEY");
  }

  saveCustomTranscriptionKey(key) {
    return this._saveKey("CUSTOM_TRANSCRIPTION_API_KEY", key);
  }

  getCustomReasoningKey() {
    return this._getKey("CUSTOM_REASONING_API_KEY");
  }

  saveCustomReasoningKey(key) {
    return this._saveKey("CUSTOM_REASONING_API_KEY", key);
  }

  getLicenseApiBaseUrl() {
    return this._getKey("LICENSE_API_BASE_URL");
  }

  saveLicenseApiBaseUrl(url) {
    const normalized = String(url || "").trim().replace(/\/+$/, "");
    const result = this._saveProtectedLicenseRuntimeKey("LICENSE_API_BASE_URL", normalized);
    this.saveAllKeysToEnvFile().catch(() => { });
    return { ...result, value: result.success ? normalized : this._getKey("LICENSE_API_BASE_URL") };
  }

  getLicenseProductId() {
    return this._getKey("LICENSE_PRODUCT_ID");
  }

  saveLicenseProductId(productId) {
    const normalized = String(productId || "").trim();
    const result = this._saveProtectedLicenseRuntimeKey("LICENSE_PRODUCT_ID", normalized);
    this.saveAllKeysToEnvFile().catch(() => { });
    return { ...result, value: result.success ? normalized : this._getKey("LICENSE_PRODUCT_ID") };
  }

  getDictationKey() {
    return this._getKey("DICTATION_KEY");
  }

  saveDictationKey(key) {
    const result = this._saveKey("DICTATION_KEY", key);
    this.saveAllKeysToEnvFile().catch(() => { });
    return result;
  }

  getActivationMode() {
    const mode = this._getKey("ACTIVATION_MODE");
    return mode === "push" ? "push" : "tap";
  }

  saveActivationMode(mode) {
    const validMode = mode === "push" ? "push" : "tap";
    const result = this._saveKey("ACTIVATION_MODE", validMode);
    this.saveAllKeysToEnvFile().catch(() => { });
    return result;
  }

  getAutoStartEnabled() {
    const val = this._getKey("AUTO_START_ENABLED");
    return val !== "false";
  }

  saveAutoStartEnabled(enabled) {
    const result = this._saveKey("AUTO_START_ENABLED", String(enabled));
    this.saveAllKeysToEnvFile().catch(() => { });
    return result;
  }

  getAutoCheckUpdate() {
    const val = this._getKey("AUTO_CHECK_UPDATE");
    // Default to true if not explicitly set to "false"
    return val !== "false";
  }

  saveAutoCheckUpdate(enabled) {
    const result = this._saveKey("AUTO_CHECK_UPDATE", String(enabled));
    this.saveAllKeysToEnvFile().catch(() => { });
    return result;
  }

  getUiLanguage() {
    return normalizeUiLanguage(this._getKey("UI_LANGUAGE"));
  }

  saveUiLanguage(language) {
    const normalized = normalizeUiLanguage(language);
    const result = this._saveKey("UI_LANGUAGE", normalized);
    this.saveAllKeysToEnvFile().catch(() => { });
    return { ...result, language: normalized };
  }

  getModelStorageRoot() {
    return this._getKey("MODEL_STORAGE_ROOT");
  }

  saveModelStorageRoot(rootPath) {
    const previousRoot = getSpeechModelsRoot();
    const normalized = normalizeModelsRootPath(rootPath);
    const nextRoot = normalized || getDefaultSpeechModelsRoot();

    migrateSpeechModelsRootSync(previousRoot, nextRoot);

    const result = this._saveKey("MODEL_STORAGE_ROOT", normalized);
    this.saveAllKeysToEnvFile().catch(() => { });
    return { ...result, root: normalized, effectiveRoot: nextRoot };
  }

  async createProductionEnvFile(apiKey) {
    const envPath = path.join(app.getPath("userData"), ".env");

    const envContent = `# ChordVox Environment Variables
# This file was created automatically for production use
OPENAI_API_KEY=${apiKey}
`;

    await fsPromises.writeFile(envPath, envContent, "utf8");
    require("dotenv").config({ path: envPath });

    return { success: true, path: envPath };
  }

  async saveAllKeysToEnvFile() {
    const envPath = path.join(app.getPath("userData"), ".env");

    const existingMap = new Map();
    const orderedKeys = [];

    try {
      const existingContent = await fsPromises.readFile(envPath, "utf8");
      const lines = existingContent.split(/\r?\n/);
      for (const line of lines) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match) continue;
        const key = match[1];
        if (this._shouldIgnoreUserDataEnvKey(key)) continue;
        const value = match[2] || "";
        if (!existingMap.has(key)) {
          orderedKeys.push(key);
        }
        existingMap.set(key, value);
      }
    } catch {
      // No previous env file; start fresh.
    }

    for (const key of PERSISTED_KEYS) {
      if (this._shouldIgnoreUserDataEnvKey(key)) {
        continue;
      }
      const value = process.env[key];
      if (value) {
        if (!existingMap.has(key)) {
          orderedKeys.push(key);
        }
        existingMap.set(key, value);
      } else if (existingMap.has(key)) {
        existingMap.delete(key);
      }
    }

    const lines = ["# ChordVox Environment Variables"];
    for (const key of orderedKeys) {
      if (!existingMap.has(key)) continue;
      lines.push(`${key}=${existingMap.get(key)}`);
    }
    const envContent = `${lines.join("\n")}\n`;

    await fsPromises.writeFile(envPath, envContent, "utf8");
    require("dotenv").config({ path: envPath });

    return { success: true, path: envPath };
  }
}

module.exports = EnvironmentManager;
