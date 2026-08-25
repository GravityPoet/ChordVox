const path = require("path");
const fs = require("fs");
const fsPromises = require("fs/promises");
const { app } = require("electron");
const { normalizeUiLanguage } = require("./i18nMain");
const secureSecrets = require("./secureSecrets");
const debugLogger = require("./debugLogger");
const { atomicWriteFile } = require("./atomicFile");
const { SerialTaskQueue } = require("./serialTaskQueue");
const {
  getSpeechModelsRoot,
  getDefaultSpeechModelsRoot,
  validateModelsStorageRoot,
  migrateSpeechModelsRoot,
} = require("./modelDirUtils");

const PERSISTED_KEYS = [
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "SONIOX_API_KEY",
  "DEEPGRAM_API_KEY",
  "GOOGLE_STT_API_KEY",
  "DOUBAO_APP_ID",
  "DOUBAO_ACCESS_TOKEN",
  "CUSTOM_TRANSCRIPTION_API_KEY",
  "CUSTOM_REASONING_API_KEY",
  "GRANITE_RUNTIME_API_KEY",
  "COHERE_RUNTIME_API_KEY",
  "BEDROCK_ACCESS_KEY_ID",
  "BEDROCK_SECRET_ACCESS_KEY",
  "BEDROCK_SESSION_TOKEN",
  "LICENSE_API_BASE_URL",
  "LICENSE_PRODUCT_ID",
  "LICENSE_ALLOW_DEV_KEYS",
  "LOCAL_TRANSCRIPTION_PROVIDER",
  "PARAKEET_MODEL",
  "PARAFORMER_MODEL",
  "LOCAL_WHISPER_MODEL",
  "GRANITE_MODEL",
  "COHERE_MODEL",
  "GRANITE_RUNTIME_URL",
  "COHERE_RUNTIME_URL",
  "REASONING_PROVIDER",
  "LOCAL_REASONING_MODEL",
  "DICTATION_KEY",
  "ACTIVATION_MODE",
  "AUTO_START_ENABLED",
  "TRAY_ICON_ENABLED",
  "AUTO_CHECK_UPDATE",
  "UI_LANGUAGE",
  "MODEL_STORAGE_ROOT",
];

const DEPRECATED_PERSISTED_KEYS = ["SENSEVOICE_MODEL_PATH", "SENSEVOICE_BINARY_PATH"];

const PROTECTED_PACKAGED_USER_ENV_PREFIXES = ["LICENSE_"];
const SECRET_PERSISTED_KEYS = new Set([
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "SONIOX_API_KEY",
  "DEEPGRAM_API_KEY",
  "GOOGLE_STT_API_KEY",
  "DOUBAO_ACCESS_TOKEN",
  "CUSTOM_TRANSCRIPTION_API_KEY",
  "CUSTOM_REASONING_API_KEY",
  "GRANITE_RUNTIME_API_KEY",
  "COHERE_RUNTIME_API_KEY",
  "BEDROCK_ACCESS_KEY_ID",
  "BEDROCK_SECRET_ACCESS_KEY",
  "BEDROCK_SESSION_TOKEN",
]);

const IMPORTED_SETTING_ENV_KEYS = {
  anthropicApiKey: "ANTHROPIC_API_KEY",
  customReasoningApiKey: "CUSTOM_REASONING_API_KEY",
  customTranscriptionApiKey: "CUSTOM_TRANSCRIPTION_API_KEY",
  deepgramApiKey: "DEEPGRAM_API_KEY",
  doubaoAccessToken: "DOUBAO_ACCESS_TOKEN",
  doubaoAppId: "DOUBAO_APP_ID",
  geminiApiKey: "GEMINI_API_KEY",
  googleSttApiKey: "GOOGLE_STT_API_KEY",
  graniteRuntimeApiKey: "GRANITE_RUNTIME_API_KEY",
  groqApiKey: "GROQ_API_KEY",
  cerebrasApiKey: "CEREBRAS_API_KEY",
  openaiApiKey: "OPENAI_API_KEY",
  openrouterApiKey: "OPENROUTER_API_KEY",
  sonioxApiKey: "SONIOX_API_KEY",
  cohereRuntimeApiKey: "COHERE_RUNTIME_API_KEY",
  bedrockAccessKeyId: "BEDROCK_ACCESS_KEY_ID",
  bedrockSecretAccessKey: "BEDROCK_SECRET_ACCESS_KEY",
  bedrockSessionToken: "BEDROCK_SESSION_TOKEN",
};

function serializeEnvValue(value) {
  return JSON.stringify(String(value ?? ""));
}

class EnvironmentManager {
  constructor() {
    this.secureSecretsLoadedWithKeychain = false;
    this.deletedSecretKeys = new Set();
    this.persistenceDisabled = false;
    this.activePersistenceTasks = new Set();
    this.persistenceQueue = new SerialTaskQueue();
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
    } catch {}
  }

  _loadSecureSecrets(options = {}) {
    const allowKeychain = options.allowKeychain !== false;
    if (allowKeychain && this.secureSecretsLoadedWithKeychain) {
      return;
    }
    try {
      const secrets = secureSecrets.loadSecretsSync({ allowKeychain });
      for (const [key, value] of Object.entries(secrets)) {
        if (SECRET_PERSISTED_KEYS.has(key) && typeof process.env[key] === "undefined") {
          process.env[key] = value;
        }
      }
      if (allowKeychain) {
        this.secureSecretsLoadedWithKeychain = true;
      }
    } catch {}
  }

  loadEnvironmentVariables() {
    // Loaded in priority order - later loads do not override existing process.env values.
    const userDataEnv = path.join(app.getPath("userData"), ".env");
    this._loadUserDataEnvironmentFile(userDataEnv);
    this._loadSecureSecrets({ allowKeychain: false });

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
      } catch {}
    }
  }

  _getKey(envVarName, options = {}) {
    if (
      SECRET_PERSISTED_KEYS.has(envVarName) &&
      !process.env[envVarName] &&
      options.allowKeychain !== false
    ) {
      this._loadSecureSecrets({ allowKeychain: true });
    }
    return process.env[envVarName] || "";
  }

  async _saveKey(envVarName, key, options = {}) {
    const previousValue = process.env[envVarName];
    const wasDeleted = this.deletedSecretKeys.has(envVarName);
    if (key) {
      process.env[envVarName] = key;
      this.deletedSecretKeys.delete(envVarName);
    } else {
      delete process.env[envVarName];
      if (SECRET_PERSISTED_KEYS.has(envVarName)) {
        this.deletedSecretKeys.add(envVarName);
      }
    }

    try {
      await this.saveAllKeysToEnvFile({
        ...options,
        persistSecrets: SECRET_PERSISTED_KEYS.has(envVarName) || options.persistSecrets === true,
        useKeychainForSecrets:
          SECRET_PERSISTED_KEYS.has(envVarName) || options.useKeychainForSecrets === true,
      });
      return { success: true };
    } catch (error) {
      if (typeof previousValue === "string") {
        process.env[envVarName] = previousValue;
      } else {
        delete process.env[envVarName];
      }
      if (wasDeleted) {
        this.deletedSecretKeys.add(envVarName);
      } else {
        this.deletedSecretKeys.delete(envVarName);
      }
      debugLogger.warn("Failed to persist environment setting", {
        key: envVarName,
        code: error?.code || "ENV_PERSISTENCE_FAILED",
        error: error?.message || String(error),
      });
      return {
        success: false,
        code: error?.code || "ENV_PERSISTENCE_FAILED",
        error: error?.message || String(error),
      };
    }
  }

  async _saveProtectedLicenseRuntimeKey(envVarName, value) {
    if (this._isPackagedRelease()) {
      return {
        success: false,
        value: this._getKey(envVarName),
        error: "LICENSE_RUNTIME_LOCKED",
        message: "License runtime overrides are disabled in packaged builds.",
      };
    }
    return this._saveKey(envVarName, value);
  }

  getOpenAIKey(options = {}) {
    return this._getKey("OPENAI_API_KEY", options);
  }

  saveOpenAIKey(key) {
    return this._saveKey("OPENAI_API_KEY", key);
  }

  getOpenRouterKey(options = {}) {
    return this._getKey("OPENROUTER_API_KEY", options);
  }

  saveOpenRouterKey(key) {
    return this._saveKey("OPENROUTER_API_KEY", key);
  }

  getAnthropicKey(options = {}) {
    return this._getKey("ANTHROPIC_API_KEY", options);
  }

  saveAnthropicKey(key) {
    return this._saveKey("ANTHROPIC_API_KEY", key);
  }

  getGeminiKey(options = {}) {
    return this._getKey("GEMINI_API_KEY", options);
  }

  saveGeminiKey(key) {
    return this._saveKey("GEMINI_API_KEY", key);
  }

  getGroqKey(options = {}) {
    return this._getKey("GROQ_API_KEY", options);
  }

  saveGroqKey(key) {
    return this._saveKey("GROQ_API_KEY", key);
  }

  getCerebrasKey(options = {}) {
    return this._getKey("CEREBRAS_API_KEY", options);
  }

  saveCerebrasKey(key) {
    return this._saveKey("CEREBRAS_API_KEY", key);
  }

  getSonioxKey(options = {}) {
    return this._getKey("SONIOX_API_KEY", options);
  }

  saveSonioxKey(key) {
    return this._saveKey("SONIOX_API_KEY", key);
  }

  getDeepgramKey(options = {}) {
    return this._getKey("DEEPGRAM_API_KEY", options);
  }

  saveDeepgramKey(key) {
    return this._saveKey("DEEPGRAM_API_KEY", key);
  }

  getGoogleSttKey(options = {}) {
    return this._getKey("GOOGLE_STT_API_KEY", options);
  }

  saveGoogleSttKey(key) {
    return this._saveKey("GOOGLE_STT_API_KEY", key);
  }

  getDoubaoAppId() {
    return this._getKey("DOUBAO_APP_ID");
  }

  saveDoubaoAppId(appId) {
    return this._saveKey("DOUBAO_APP_ID", appId);
  }

  getDoubaoAccessToken(options = {}) {
    return this._getKey("DOUBAO_ACCESS_TOKEN", options);
  }

  saveDoubaoAccessToken(token) {
    return this._saveKey("DOUBAO_ACCESS_TOKEN", token);
  }

  getCustomTranscriptionKey(options = {}) {
    return this._getKey("CUSTOM_TRANSCRIPTION_API_KEY", options);
  }

  saveCustomTranscriptionKey(key) {
    return this._saveKey("CUSTOM_TRANSCRIPTION_API_KEY", key);
  }

  getCustomReasoningKey(options = {}) {
    return this._getKey("CUSTOM_REASONING_API_KEY", options);
  }

  saveCustomReasoningKey(key) {
    return this._saveKey("CUSTOM_REASONING_API_KEY", key);
  }

  getGraniteRuntimeApiKey(options = {}) {
    return this._getKey("GRANITE_RUNTIME_API_KEY", options);
  }

  saveGraniteRuntimeApiKey(key) {
    return this._saveKey("GRANITE_RUNTIME_API_KEY", key);
  }

  getCohereRuntimeApiKey(options = {}) {
    return this._getKey("COHERE_RUNTIME_API_KEY", options);
  }

  saveCohereRuntimeApiKey(key) {
    return this._saveKey("COHERE_RUNTIME_API_KEY", key);
  }

  getBedrockCredentials(options = {}) {
    return {
      bedrockAccessKeyId: this._getKey("BEDROCK_ACCESS_KEY_ID", options),
      bedrockSecretAccessKey: this._getKey("BEDROCK_SECRET_ACCESS_KEY", options),
      bedrockSessionToken: this._getKey("BEDROCK_SESSION_TOKEN", options),
    };
  }

  saveBedrockCredential(key, value) {
    const envKey = {
      bedrockAccessKeyId: "BEDROCK_ACCESS_KEY_ID",
      bedrockSecretAccessKey: "BEDROCK_SECRET_ACCESS_KEY",
      bedrockSessionToken: "BEDROCK_SESSION_TOKEN",
    }[key];
    if (!envKey) {
      return { success: false, error: "Unsupported Bedrock credential key" };
    }
    return this._saveKey(envKey, value);
  }

  getLicenseApiBaseUrl() {
    return this._getKey("LICENSE_API_BASE_URL");
  }

  async saveLicenseApiBaseUrl(url) {
    const normalized = String(url || "")
      .trim()
      .replace(/\/+$/, "");
    const result = await this._saveProtectedLicenseRuntimeKey("LICENSE_API_BASE_URL", normalized);
    return { ...result, value: result.success ? normalized : this._getKey("LICENSE_API_BASE_URL") };
  }

  getLicenseProductId() {
    return this._getKey("LICENSE_PRODUCT_ID");
  }

  async saveLicenseProductId(productId) {
    const normalized = String(productId || "").trim();
    const result = await this._saveProtectedLicenseRuntimeKey("LICENSE_PRODUCT_ID", normalized);
    return { ...result, value: result.success ? normalized : this._getKey("LICENSE_PRODUCT_ID") };
  }

  getDictationKey() {
    return this._getKey("DICTATION_KEY");
  }

  saveDictationKey(key) {
    return this._saveKey("DICTATION_KEY", key);
  }

  getActivationMode() {
    const mode = this._getKey("ACTIVATION_MODE");
    return mode === "push" ? "push" : "tap";
  }

  saveActivationMode(mode) {
    const validMode = mode === "push" ? "push" : "tap";
    return this._saveKey("ACTIVATION_MODE", validMode);
  }

  getAutoStartEnabled() {
    const val = this._getKey("AUTO_START_ENABLED");
    // Tri-state: undefined = user has not chosen, "true"/"false" = explicit.
    // Default to true for packaged customer builds; explicit false still wins.
    if (val === "true") return true;
    if (val === "false") return false;
    return true;
  }

  hasExplicitAutoStartChoice() {
    const val = this._getKey("AUTO_START_ENABLED");
    return val === "true" || val === "false";
  }

  saveAutoStartEnabled(enabled) {
    return this._saveKey("AUTO_START_ENABLED", String(enabled));
  }

  getTrayIconEnabled() {
    const val = this._getKey("TRAY_ICON_ENABLED");
    return val !== "false";
  }

  saveTrayIconEnabled(enabled) {
    return this._saveKey("TRAY_ICON_ENABLED", String(enabled));
  }

  getAutoCheckUpdate() {
    const val = this._getKey("AUTO_CHECK_UPDATE");
    // Default to true if not explicitly set to "false"
    return val !== "false";
  }

  saveAutoCheckUpdate(enabled) {
    return this._saveKey("AUTO_CHECK_UPDATE", String(enabled));
  }

  getUiLanguage() {
    return normalizeUiLanguage(this._getKey("UI_LANGUAGE"));
  }

  async saveUiLanguage(language) {
    const normalized = normalizeUiLanguage(language);
    const result = await this._saveKey("UI_LANGUAGE", normalized);
    return { ...result, language: normalized };
  }

  getModelStorageRoot() {
    return this._getKey("MODEL_STORAGE_ROOT");
  }

  async saveModelStorageRoot(rootPath, options = {}) {
    const previousRoot = getSpeechModelsRoot();
    const previousConfiguredRoot = this.getModelStorageRoot();
    const normalized = validateModelsStorageRoot(rootPath);
    const nextRoot = normalized || getDefaultSpeechModelsRoot();

    try {
      const migration = await migrateSpeechModelsRoot(previousRoot, nextRoot, options);
      const result = await this._saveKey("MODEL_STORAGE_ROOT", normalized);
      return {
        ...result,
        root: normalized,
        effectiveRoot: nextRoot,
        migratedServices: migration.migratedServices,
        cleanupWarnings: migration.cleanupWarnings,
      };
    } catch (error) {
      debugLogger.error("Failed to migrate model storage root", {
        previousRoot,
        nextRoot,
        code: error?.code || "MODEL_MIGRATION_FAILED",
        error: error?.message || String(error),
      });
      return {
        success: false,
        root: previousConfiguredRoot,
        effectiveRoot: previousRoot,
        error: error?.message || String(error),
        code: error?.code || "MODEL_MIGRATION_FAILED",
      };
    }
  }

  _persistEnvironmentInBackground(context, options = {}) {
    this.saveAllKeysToEnvFile(options).catch((error) => {
      debugLogger.warn("Failed to persist .env file", {
        context,
        error: error?.message || String(error),
      });
    });
  }

  async createProductionEnvFile(apiKey) {
    return this._saveKey("OPENAI_API_KEY", apiKey, {
      persistSecrets: true,
      useKeychainForSecrets: true,
    });
  }

  async importSettingsValues(values = {}) {
    const importedEntries = Object.entries(IMPORTED_SETTING_ENV_KEYS).filter(([settingKey]) =>
      Object.prototype.hasOwnProperty.call(values, settingKey)
    );
    if (importedEntries.length === 0) {
      return { success: true, imported: 0 };
    }

    const previousValues = new Map(
      importedEntries.map(([, envKey]) => [envKey, process.env[envKey]])
    );
    const previousDeletedSecretKeys = new Set(this.deletedSecretKeys);

    try {
      for (const [settingKey, envKey] of importedEntries) {
        const value = String(values[settingKey] ?? "");
        if (value) {
          process.env[envKey] = value;
          this.deletedSecretKeys.delete(envKey);
        } else {
          delete process.env[envKey];
          if (SECRET_PERSISTED_KEYS.has(envKey)) {
            this.deletedSecretKeys.add(envKey);
          }
        }
      }

      await this.saveAllKeysToEnvFile({
        persistSecrets: true,
        useKeychainForSecrets: true,
      });
      return { success: true, imported: importedEntries.length };
    } catch (error) {
      for (const [, envKey] of importedEntries) {
        const previousValue = previousValues.get(envKey);
        if (typeof previousValue === "string") {
          process.env[envKey] = previousValue;
        } else {
          delete process.env[envKey];
        }
      }
      this.deletedSecretKeys = previousDeletedSecretKeys;
      await this.saveAllKeysToEnvFile({
        persistSecrets: true,
        useKeychainForSecrets: true,
      }).catch(() => {});
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async prepareForReset() {
    this.persistenceDisabled = true;
    await this.persistenceQueue.drain();
    await Promise.allSettled([...this.activePersistenceTasks]);
    this.deletedSecretKeys.clear();
    this.secureSecretsLoadedWithKeychain = false;
  }

  async saveAllKeysToEnvFile(options = {}) {
    if (this.persistenceDisabled) {
      throw new Error("Environment persistence is disabled while app data is being reset");
    }

    const task = this.persistenceQueue.run(() => this._saveAllKeysToEnvFile(options));
    this.activePersistenceTasks.add(task);
    try {
      return await task;
    } finally {
      this.activePersistenceTasks.delete(task);
    }
  }

  async _saveAllKeysToEnvFile(options = {}) {
    const envPath = path.join(app.getPath("userData"), ".env");
    const persistSecrets = options.persistSecrets === true || this.deletedSecretKeys.size > 0;
    const useKeychainForSecrets = options.useKeychainForSecrets === true;

    const existingMap = new Map();
    const orderedKeys = [];
    const secretValues = persistSecrets
      ? { ...secureSecrets.loadSecretsSync({ allowKeychain: false }) }
      : {};

    try {
      const existingContent = await fsPromises.readFile(envPath, "utf8");
      const parsed = require("dotenv").parse(existingContent);
      const lines = existingContent.split(/\r?\n/);
      for (const line of lines) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match) continue;
        const key = match[1];
        if (this._shouldIgnoreUserDataEnvKey(key)) continue;
        const value = Object.prototype.hasOwnProperty.call(parsed, key) ? parsed[key] : "";
        if (SECRET_PERSISTED_KEYS.has(key)) {
          if (value && !process.env[key]) {
            process.env[key] = value;
          }
          if (!persistSecrets) {
            if (!existingMap.has(key)) {
              orderedKeys.push(key);
            }
            existingMap.set(key, value);
          }
          continue;
        }
        if (!existingMap.has(key)) {
          orderedKeys.push(key);
        }
        existingMap.set(key, value);
      }
    } catch {
      // No previous env file; start fresh.
    }

    const persistedKeys =
      options.persistLogLevel === true ? [...PERSISTED_KEYS, "CHORDVOX_LOG_LEVEL"] : PERSISTED_KEYS;

    for (const key of persistedKeys) {
      if (this._shouldIgnoreUserDataEnvKey(key)) {
        continue;
      }
      const value = process.env[key];
      if (SECRET_PERSISTED_KEYS.has(key)) {
        if (persistSecrets) {
          if (value) {
            secretValues[key] = value;
            this.deletedSecretKeys.delete(key);
          } else if (this.deletedSecretKeys.has(key)) {
            secretValues[key] = "";
          }
          existingMap.delete(key);
        }
        continue;
      }
      if (value) {
        if (!existingMap.has(key)) {
          orderedKeys.push(key);
        }
        existingMap.set(key, value);
      } else if (existingMap.has(key)) {
        existingMap.delete(key);
      }
    }

    for (const key of DEPRECATED_PERSISTED_KEYS) {
      existingMap.delete(key);
    }

    const lines = ["# ChordVox Environment Variables"];
    for (const key of orderedKeys) {
      if (!existingMap.has(key)) continue;
      lines.push(`${key}=${serializeEnvValue(existingMap.get(key))}`);
    }
    const envContent = `${lines.join("\n")}\n`;

    await atomicWriteFile(envPath, envContent, { mode: 0o600, backup: true });
    if (persistSecrets || this.deletedSecretKeys.size > 0) {
      await secureSecrets.saveSecrets(secretValues, { useKeychain: useKeychainForSecrets });
    }
    require("dotenv").config({ path: envPath });

    return { success: true, path: envPath, secretsPath: secureSecrets.getSecretStorePath() };
  }
}

module.exports = EnvironmentManager;
