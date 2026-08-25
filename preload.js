const { contextBridge, ipcRenderer, webUtils } = require("electron");

const E2E_MODE = process.env.CHORDVOX_E2E === "1";
const e2eListenerRegistrations = {};

const recordE2eListenerRegistration = (channel) => {
  if (!E2E_MODE) {
    return;
  }
  const state = e2eListenerRegistrations[channel] || { active: 0, total: 0 };
  state.active += 1;
  state.total += 1;
  e2eListenerRegistrations[channel] = state;
};

const releaseE2eListenerRegistration = (channel) => {
  if (!E2E_MODE) {
    return;
  }
  const state = e2eListenerRegistrations[channel];
  if (!state) {
    return;
  }
  state.active = Math.max(0, state.active - 1);
};

const getE2eListenerRegistrations = () =>
  Object.fromEntries(
    Object.entries(e2eListenerRegistrations).map(([channel, state]) => [
      channel,
      { active: state.active, total: state.total },
    ])
  );

/**
 * Helper to register an IPC listener and return a cleanup function.
 * Ensures renderer code can easily remove listeners to avoid leaks.
 */
const registerListener = (channel, handlerFactory) => {
  return (callback) => {
    if (typeof callback !== "function") {
      return () => {};
    }

    const listener =
      typeof handlerFactory === "function"
        ? handlerFactory(callback)
        : (event, ...args) => callback(event, ...args);

    ipcRenderer.on(channel, listener);
    recordE2eListenerRegistration(channel);
    let disposed = false;
    return () => {
      if (disposed) {
        return;
      }
      disposed = true;
      ipcRenderer.removeListener(channel, listener);
      releaseE2eListenerRegistration(channel);
    };
  };
};

const getPathForFile = (file) => {
  try {
    if (!file || typeof webUtils?.getPathForFile !== "function") {
      return "";
    }
    return webUtils.getPathForFile(file) || "";
  } catch {
    return "";
  }
};

const invokeWithFilePath = (channel, file, options = {}) => {
  const sourceFilePath = getPathForFile(file);
  if (!sourceFilePath) {
    return Promise.resolve({
      success: false,
      error: "file_path_unavailable",
      message: "Selected file path is unavailable. Please choose the file again.",
    });
  }
  const safeOptions = options && typeof options === "object" ? options : {};
  return ipcRenderer.invoke(channel, sourceFilePath, {
    ...safeOptions,
    sourceFileName: safeOptions.sourceFileName || file?.name || "",
    mimeType: safeOptions.mimeType || file?.type || "",
  });
};

contextBridge.exposeInMainWorld("electronAPI", {
  ...(E2E_MODE ? { getE2eListenerRegistrations } : {}),
  pasteText: async (text, options) => {
    const result = await ipcRenderer.invoke("paste-text", text, options);

    if (result?.success === false) {
      const error = new Error(result?.error?.message || "Paste failed");
      error.code = result?.error?.code || undefined;
      error.requiresAccessibilityPermission =
        result?.error?.requiresAccessibilityPermission === true;
      error.handledBySystemDialog = result?.error?.handledBySystemDialog === true;
      error.suppressRendererToast = result?.error?.suppressRendererToast === true;
      throw error;
    }
  },
  cancelPasteText: (pasteRequestId) => ipcRenderer.invoke("cancel-paste-text", pasteRequestId),
  getSentryDsn: () => ipcRenderer.invoke("get-sentry-dsn"),
  reportTelemetrySettings: (enabled) => ipcRenderer.send("report-telemetry-settings", enabled),
  hideWindow: () => ipcRenderer.invoke("hide-window"),
  showDictationPanel: () => ipcRenderer.invoke("show-dictation-panel"),
  openControlPanelSection: (section) => ipcRenderer.invoke("open-control-panel-section", section),
  openTranscriptionHistory: () => ipcRenderer.invoke("open-transcription-history"),
  showFileTranscriptionCompletionAlert: (payload) =>
    ipcRenderer.invoke("show-file-transcription-completion-alert", payload),
  getFileTranscriptionCompletionAlert: () =>
    ipcRenderer.invoke("get-file-transcription-completion-alert"),
  hideFileTranscriptionCompletionAlert: () =>
    ipcRenderer.invoke("hide-file-transcription-completion-alert"),
  onFileTranscriptionCompletionAlert: registerListener(
    "file-transcription-completion-alert",
    (callback) => (_event, payload) => callback(payload || {})
  ),
  toggleCommandMenu: (state) => ipcRenderer.invoke("toggle-command-menu", state),
  hideCommandMenu: () => ipcRenderer.invoke("hide-command-menu"),
  commandMenuStart: () => ipcRenderer.invoke("command-menu-start"),
  commandMenuStop: () => ipcRenderer.invoke("command-menu-stop"),
  commandMenuHidePanel: () => ipcRenderer.invoke("command-menu-hide-panel"),
  updateCommandMenuState: (state) => ipcRenderer.invoke("update-command-menu-state", state),
  onCommandMenuState: registerListener(
    "command-menu-state",
    (callback) => (_event, payload) => callback(payload || {})
  ),
  onCommandMenuVisibilityChanged: registerListener(
    "command-menu-visibility-changed",
    (callback) => (_event, payload) => callback(payload || {})
  ),
  // Native glass capability
  getNativeGlassCapability: () => ipcRenderer.invoke("get-native-glass-capability"),
  onNativeGlassCapability: registerListener(
    "native-glass-capability",
    (callback) => (_event, payload) => callback(payload || {})
  ),
  onToggleDictation: registerListener(
    "toggle-dictation",
    (callback) => (_event, payload) => callback(payload || {})
  ),
  onStartDictation: registerListener(
    "start-dictation",
    (callback) => (_event, payload) => callback(payload || {})
  ),
  onStopDictation: registerListener(
    "stop-dictation",
    (callback) => (_event, payload) => callback(payload || {})
  ),
  onPrepareDictationUi: registerListener(
    "prepare-dictation-ui",
    (callback) => (_event, payload) => callback(payload || {})
  ),
  notifyDictationUiReady: (payload) => ipcRenderer.send("dictation-ui-ready", payload),
  onSecondaryHotkeyLocked: registerListener(
    "secondary-hotkey-locked",
    (callback) => (_event, payload) => callback(payload || {})
  ),
  onOpenSettingsSection: registerListener(
    "open-settings-section",
    (callback) => (_event, payload) => callback(payload || {})
  ),
  onOpenTranscriptionHistory: registerListener(
    "open-transcription-history",
    (callback) => () => callback()
  ),

  // Database functions
  saveTranscription: (text, metadata) =>
    ipcRenderer.invoke("db-save-transcription", text, metadata),
  getTranscriptions: (limit) => ipcRenderer.invoke("db-get-transcriptions", limit),
  searchTranscriptions: (query, limit) =>
    ipcRenderer.invoke("db-search-transcriptions", query, limit),
  queryTranscriptionHistory: (options = {}) =>
    ipcRenderer.invoke("db-query-transcription-history", options),
  getTranscriptionStats: () => ipcRenderer.invoke("db-get-transcription-stats"),
  clearTranscriptions: () => ipcRenderer.invoke("db-clear-transcriptions"),
  deleteTranscription: (id) => ipcRenderer.invoke("db-delete-transcription", id),
  setTranscriptionFavorite: (id, favorite) =>
    ipcRenderer.invoke("db-set-transcription-favorite", id, favorite),
  // Dictionary functions
  getDictionary: () => ipcRenderer.invoke("db-get-dictionary"),
  setDictionary: (words) => ipcRenderer.invoke("db-set-dictionary", words),
  trackOnboardingEvent: (eventName) => ipcRenderer.invoke("track-onboarding-event", eventName),
  getOnboardingEvents: () => ipcRenderer.invoke("get-onboarding-events"),

  onTranscriptionAdded: (callback) => {
    const listener = (_event, transcription) => callback?.(transcription);
    ipcRenderer.on("transcription-added", listener);
    return () => ipcRenderer.removeListener("transcription-added", listener);
  },
  onTranscriptionDeleted: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("transcription-deleted", listener);
    return () => ipcRenderer.removeListener("transcription-deleted", listener);
  },
  onTranscriptionUpdated: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("transcription-updated", listener);
    return () => ipcRenderer.removeListener("transcription-updated", listener);
  },
  onTranscriptionsCleared: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("transcriptions-cleared", listener);
    return () => ipcRenderer.removeListener("transcriptions-cleared", listener);
  },

  // Environment variables
  getOpenAIKey: (options = {}) => ipcRenderer.invoke("get-openai-key", options),
  saveOpenAIKey: (key) => ipcRenderer.invoke("save-openai-key", key),
  createProductionEnvFile: (key) => ipcRenderer.invoke("create-production-env-file", key),

  // Clipboard functions
  readClipboard: () => ipcRenderer.invoke("read-clipboard"),
  writeClipboard: (text) => ipcRenderer.invoke("write-clipboard", text),
  checkPasteTools: () => ipcRenderer.invoke("check-paste-tools"),
  checkAccessibilityPermission: () => ipcRenderer.invoke("check-accessibility-permission"),
  requestAccessibilityPermission: () => ipcRenderer.invoke("request-accessibility-permission"),
  getOnboardingState: () => ipcRenderer.invoke("get-onboarding-state"),
  saveOnboardingState: (patch) => ipcRenderer.invoke("save-onboarding-state", patch),
  clearOnboardingState: () => ipcRenderer.invoke("clear-onboarding-state"),
  emitOnboardingDictationSuccess: (payload) =>
    ipcRenderer.invoke("emit-onboarding-dictation-success", payload),
  consumeOnboardingDictationSuccess: () =>
    ipcRenderer.invoke("consume-onboarding-dictation-success"),
  onOnboardingDictationSuccess: registerListener("onboarding-dictation-success"),
  pushOnboardingAudioLevel: (payload) => ipcRenderer.send("onboarding-audio-level", payload),
  onOnboardingAudioLevel: registerListener("onboarding-audio-level"),

  // Local Whisper functions (whisper.cpp)
  transcribeLocalWhisper: (audioBlob, options) =>
    ipcRenderer.invoke("transcribe-local-whisper", audioBlob, options),
  transcribeLocalWhisperFile: (file, options = {}) =>
    invokeWithFilePath("transcribe-local-whisper-file", file, options),
  checkWhisperInstallation: () => ipcRenderer.invoke("check-whisper-installation"),
  downloadWhisperModel: (modelName, options = {}) =>
    ipcRenderer.invoke("download-whisper-model", { ...options, modelName }),
  onWhisperDownloadProgress: registerListener("whisper-download-progress"),
  checkModelStatus: (modelName) => ipcRenderer.invoke("check-model-status", modelName),
  listWhisperModels: () => ipcRenderer.invoke("list-whisper-models"),
  deleteWhisperModel: (modelName) => ipcRenderer.invoke("delete-whisper-model", modelName),
  deleteAllWhisperModels: () => ipcRenderer.invoke("delete-all-whisper-models"),
  cancelWhisperDownload: () => ipcRenderer.invoke("cancel-whisper-download"),
  cancelFileTranscription: (operationId) =>
    ipcRenderer.invoke("cancel-file-transcription", operationId),
  acquireTranscriptionLease: (payload) =>
    ipcRenderer.invoke("acquire-transcription-lease", payload),
  releaseTranscriptionLease: (leaseId) =>
    ipcRenderer.invoke("release-transcription-lease", leaseId),
  checkFFmpegAvailability: () => ipcRenderer.invoke("check-ffmpeg-availability"),
  getAudioDiagnostics: () => ipcRenderer.invoke("get-audio-diagnostics"),

  // Whisper server functions (faster repeated transcriptions)
  whisperServerStart: (modelName) => ipcRenderer.invoke("whisper-server-start", modelName),
  whisperServerStop: () => ipcRenderer.invoke("whisper-server-stop"),
  whisperServerStatus: () => ipcRenderer.invoke("whisper-server-status"),

  // Local Parakeet (NVIDIA) functions
  transcribeLocalParakeet: (audioBlob, options) =>
    ipcRenderer.invoke("transcribe-local-parakeet", audioBlob, options),
  transcribeLocalParakeetFile: (file, options = {}) =>
    invokeWithFilePath("transcribe-local-parakeet-file", file, options),
  checkParakeetInstallation: () => ipcRenderer.invoke("check-parakeet-installation"),
  downloadParakeetModel: (modelName, options = {}) =>
    ipcRenderer.invoke("download-parakeet-model", { ...options, modelName }),
  onParakeetDownloadProgress: registerListener("parakeet-download-progress"),
  checkParakeetModelStatus: (modelName) =>
    ipcRenderer.invoke("check-parakeet-model-status", modelName),
  listParakeetModels: () => ipcRenderer.invoke("list-parakeet-models"),
  deleteParakeetModel: (modelName) => ipcRenderer.invoke("delete-parakeet-model", modelName),
  deleteAllParakeetModels: () => ipcRenderer.invoke("delete-all-parakeet-models"),
  cancelParakeetDownload: () => ipcRenderer.invoke("cancel-parakeet-download"),
  getParakeetDiagnostics: () => ipcRenderer.invoke("get-parakeet-diagnostics"),

  pickWhisperModelFile: (defaultPath) => ipcRenderer.invoke("pick-whisper-model-file", defaultPath),
  pickParakeetModelDirectory: (defaultPath) =>
    ipcRenderer.invoke("pick-parakeet-model-directory", defaultPath),

  // Parakeet server functions (faster repeated transcriptions)
  parakeetServerStart: (modelName) => ipcRenderer.invoke("parakeet-server-start", modelName),
  parakeetServerStop: () => ipcRenderer.invoke("parakeet-server-stop"),
  parakeetServerStatus: () => ipcRenderer.invoke("parakeet-server-status"),

  // Local Paraformer functions
  transcribeLocalParaformer: (audioBlob, options) =>
    ipcRenderer.invoke("transcribe-local-paraformer", audioBlob, options),
  transcribeLocalParaformerFile: (file, options = {}) =>
    invokeWithFilePath("transcribe-local-paraformer-file", file, options),
  checkParaformerInstallation: () => ipcRenderer.invoke("check-paraformer-installation"),
  downloadParaformerModel: (modelName, options = {}) =>
    ipcRenderer.invoke("download-paraformer-model", { ...options, modelName }),
  onParaformerDownloadProgress: registerListener("paraformer-download-progress"),
  checkParaformerModelStatus: (modelName) =>
    ipcRenderer.invoke("check-paraformer-model-status", modelName),
  listParaformerModels: () => ipcRenderer.invoke("list-paraformer-models"),
  deleteParaformerModel: (modelName) => ipcRenderer.invoke("delete-paraformer-model", modelName),
  deleteAllParaformerModels: () => ipcRenderer.invoke("delete-all-paraformer-models"),
  cancelParaformerDownload: () => ipcRenderer.invoke("cancel-paraformer-download"),
  getParaformerDiagnostics: () => ipcRenderer.invoke("get-paraformer-diagnostics"),
  pickParaformerModelDirectory: (defaultPath) =>
    ipcRenderer.invoke("pick-paraformer-model-directory", defaultPath),
  paraformerServerStart: (modelName) => ipcRenderer.invoke("paraformer-server-start", modelName),
  paraformerServerStop: () => ipcRenderer.invoke("paraformer-server-stop"),
  paraformerServerStatus: () => ipcRenderer.invoke("paraformer-server-status"),
  transcribeExternalAsr: (audioBlob, options) =>
    ipcRenderer.invoke("transcribe-external-asr", audioBlob, options),
  transcribeExternalAsrFile: (file, options = {}) =>
    invokeWithFilePath("transcribe-external-asr-file", file, options),
  checkExternalAsrRuntime: (options) => ipcRenderer.invoke("check-external-asr-runtime", options),

  // IBM Granite managed local runtime
  transcribeLocalGranite: (audioBlob, options) =>
    ipcRenderer.invoke("transcribe-local-granite", audioBlob, options),
  transcribeLocalGraniteFile: (file, options = {}) =>
    invokeWithFilePath("transcribe-local-granite-file", file, options),
  checkGraniteRuntime: () => ipcRenderer.invoke("check-granite-runtime"),
  installGraniteRuntime: (options = {}) => ipcRenderer.invoke("install-granite-runtime", options),
  downloadGraniteModel: (modelName, options = {}) =>
    ipcRenderer.invoke("download-granite-model", { ...options, modelName }),
  onGraniteDownloadProgress: registerListener("granite-download-progress"),
  checkGraniteModelStatus: (modelName) =>
    ipcRenderer.invoke("check-granite-model-status", modelName),
  listGraniteModels: () => ipcRenderer.invoke("list-granite-models"),
  deleteGraniteModel: (modelName) => ipcRenderer.invoke("delete-granite-model", modelName),
  deleteAllGraniteModels: () => ipcRenderer.invoke("delete-all-granite-models"),
  deletePunctuationModels: () => ipcRenderer.invoke("delete-punctuation-models"),
  cancelGraniteDownload: () => ipcRenderer.invoke("cancel-granite-download"),
  getGraniteDiagnostics: () => ipcRenderer.invoke("get-granite-diagnostics"),
  graniteServerStart: (modelName) => ipcRenderer.invoke("granite-server-start", modelName),
  graniteServerStop: () => ipcRenderer.invoke("granite-server-stop"),
  graniteServerStatus: () => ipcRenderer.invoke("granite-server-status"),

  // Window control functions
  windowMinimize: () => ipcRenderer.invoke("window-minimize"),
  windowMaximize: () => ipcRenderer.invoke("window-maximize"),
  windowClose: () => ipcRenderer.invoke("window-close"),
  windowIsMaximized: () => ipcRenderer.invoke("window-is-maximized"),
  getPlatform: () => process.platform,
  appQuit: () => ipcRenderer.invoke("app-quit"),

  // Cleanup function
  cleanupApp: () => ipcRenderer.invoke("cleanup-app"),
  restartApp: () => ipcRenderer.invoke("restart-app"),
  updateHotkey: (hotkey) => ipcRenderer.invoke("update-hotkey", hotkey),
  updateSecondaryHotkey: (hotkey) => ipcRenderer.invoke("update-secondary-hotkey", hotkey),
  syncHotkeyWorkflows: (workflows) => ipcRenderer.invoke("sync-hotkey-workflows", workflows),
  checkHotkeyAvailability: (hotkey) => ipcRenderer.invoke("check-hotkey-availability", hotkey),
  setHotkeyListeningMode: (enabled, newHotkey, scope) =>
    ipcRenderer.invoke("set-hotkey-listening-mode", enabled, newHotkey, scope),
  getHotkeyModeInfo: () => ipcRenderer.invoke("get-hotkey-mode-info"),
  getHotkeyDiagnostics: () => ipcRenderer.invoke("get-hotkey-mode-info"),
  testHotkeyWake: (profileId = "primary") => ipcRenderer.invoke("test-hotkey-wake", profileId),
  startWindowDrag: () => ipcRenderer.invoke("start-window-drag"),
  stopWindowDrag: () => ipcRenderer.invoke("stop-window-drag"),
  setMainWindowInteractivity: (interactive, options) =>
    ipcRenderer.invoke("set-main-window-interactivity", interactive, options),
  resizeMainWindow: (sizeKeyOrSize) => ipcRenderer.invoke("resize-main-window", sizeKeyOrSize),

  // Update functions
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  downloadUpdate: () => ipcRenderer.invoke("download-update"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  getUpdateStatus: () => ipcRenderer.invoke("get-update-status"),
  getUpdateInfo: () => ipcRenderer.invoke("get-update-info"),

  // Update event listeners
  onCheckingForUpdate: registerListener("checking-for-update"),
  onUpdateAvailable: registerListener("update-available"),
  onUpdateNotAvailable: registerListener("update-not-available"),
  onUpdateDownloaded: registerListener("update-downloaded"),
  onUpdateDownloadProgress: registerListener("update-download-progress"),
  onUpdateError: registerListener("update-error"),

  // Audio event listeners
  onNoAudioDetected: registerListener("no-audio-detected"),

  // External link opener
  openExternal: (url, options) => ipcRenderer.invoke("open-external", url, options),

  // Model management functions
  modelGetAll: () => ipcRenderer.invoke("model-get-all"),
  modelCheck: (modelId) => ipcRenderer.invoke("model-check", modelId),
  modelDownload: (modelId) => ipcRenderer.invoke("model-download", modelId),
  modelDelete: (modelId) => ipcRenderer.invoke("model-delete", modelId),
  modelDeleteAll: () => ipcRenderer.invoke("model-delete-all"),
  modelCheckRuntime: () => ipcRenderer.invoke("model-check-runtime"),
  modelCancelDownload: (modelId) => ipcRenderer.invoke("model-cancel-download", modelId),
  onModelDownloadProgress: registerListener("model-download-progress"),

  // Anthropic API
  getAnthropicKey: (options = {}) => ipcRenderer.invoke("get-anthropic-key", options),
  saveAnthropicKey: (key) => ipcRenderer.invoke("save-anthropic-key", key),
  getOpenRouterKey: (options = {}) => ipcRenderer.invoke("get-openrouter-key", options),
  saveOpenRouterKey: (key) => ipcRenderer.invoke("save-openrouter-key", key),
  getUiLanguage: () => ipcRenderer.invoke("get-ui-language"),
  getInitialUiLanguage: () => process.env.UI_LANGUAGE || "",
  saveUiLanguage: (language) => ipcRenderer.invoke("save-ui-language", language),
  setUiLanguage: (language) => ipcRenderer.invoke("set-ui-language", language),
  getModelStorageRoot: () => ipcRenderer.invoke("get-model-storage-root"),
  saveModelStorageRoot: (rootPath) => ipcRenderer.invoke("save-model-storage-root", rootPath),
  onModelStorageMigrationProgress: registerListener(
    "model-storage-migration-progress",
    (callback) => (_event, progress) => callback(progress)
  ),
  pickModelStorageRoot: (defaultPath) => ipcRenderer.invoke("pick-model-storage-root", defaultPath),
  reportTranscriptionSettings: (payload) =>
    ipcRenderer.send("transcription:report-active-settings", payload),

  // Gemini API
  getGeminiKey: (options = {}) => ipcRenderer.invoke("get-gemini-key", options),
  saveGeminiKey: (key) => ipcRenderer.invoke("save-gemini-key", key),

  // Groq API
  getGroqKey: (options = {}) => ipcRenderer.invoke("get-groq-key", options),
  saveGroqKey: (key) => ipcRenderer.invoke("save-groq-key", key),

  // Cerebras API
  getCerebrasKey: (options = {}) => ipcRenderer.invoke("get-cerebras-key", options),
  saveCerebrasKey: (key) => ipcRenderer.invoke("save-cerebras-key", key),
  testCloudTranscriptionConnection: (data) =>
    ipcRenderer.invoke("test-cloud-transcription-connection", data),

  // Soniox ASR
  getSonioxKey: (options = {}) => ipcRenderer.invoke("get-soniox-key", options),
  saveSonioxKey: (key) => ipcRenderer.invoke("save-soniox-key", key),
  testSonioxConnection: (data) => ipcRenderer.invoke("test-soniox-connection", data),
  proxySonioxTranscription: (data) => ipcRenderer.invoke("proxy-soniox-transcription", data),
  proxySonioxTranscriptionFile: (file, options = {}) =>
    invokeWithFilePath("proxy-soniox-transcription-file", file, options),

  // Deepgram ASR
  getDeepgramKey: (options = {}) => ipcRenderer.invoke("get-deepgram-key", options),
  saveDeepgramKey: (key) => ipcRenderer.invoke("save-deepgram-key", key),
  testDeepgramConnection: (data) => ipcRenderer.invoke("test-deepgram-connection", data),
  proxyDeepgramTranscription: (data) => ipcRenderer.invoke("proxy-deepgram-transcription", data),
  proxyDeepgramTranscriptionFile: (file, options = {}) =>
    invokeWithFilePath("proxy-deepgram-transcription-file", file, options),
  onDeepgramBatchProgress: registerListener(
    "deepgram-batch-progress",
    (callback) => (_event, data) => callback(data)
  ),

  // Google Cloud Speech-to-Text
  getGoogleSttKey: (options = {}) => ipcRenderer.invoke("get-google-stt-key", options),
  saveGoogleSttKey: (key) => ipcRenderer.invoke("save-google-stt-key", key),
  testGoogleCloudSttConnection: (data) =>
    ipcRenderer.invoke("test-google-cloud-stt-connection", data),
  proxyGoogleCloudSttTranscription: (data) =>
    ipcRenderer.invoke("proxy-google-cloud-stt-transcription", data),
  proxyGoogleCloudSttTranscriptionFile: (file, options = {}) =>
    invokeWithFilePath("proxy-google-cloud-stt-transcription-file", file, options),

  // Doubao ASR
  getDoubaoAppId: () => ipcRenderer.invoke("get-doubao-app-id"),
  saveDoubaoAppId: (appId) => ipcRenderer.invoke("save-doubao-app-id", appId),
  getDoubaoAccessToken: (options = {}) => ipcRenderer.invoke("get-doubao-access-token", options),
  saveDoubaoAccessToken: (token) => ipcRenderer.invoke("save-doubao-access-token", token),
  testDoubaoConnection: (data) => ipcRenderer.invoke("test-doubao-connection", data),
  proxyDoubaoTranscription: (data) => ipcRenderer.invoke("proxy-doubao-transcription", data),
  proxyDoubaoTranscriptionFile: (file, options = {}) =>
    invokeWithFilePath("proxy-doubao-transcription-file", file, options),

  // Custom endpoint API keys
  getCustomTranscriptionKey: (options = {}) =>
    ipcRenderer.invoke("get-custom-transcription-key", options),
  saveCustomTranscriptionKey: (key) => ipcRenderer.invoke("save-custom-transcription-key", key),
  getCustomReasoningKey: (options = {}) => ipcRenderer.invoke("get-custom-reasoning-key", options),
  saveCustomReasoningKey: (key) => ipcRenderer.invoke("save-custom-reasoning-key", key),
  getGraniteRuntimeApiKey: (options = {}) =>
    ipcRenderer.invoke("get-granite-runtime-api-key", options),
  saveGraniteRuntimeApiKey: (key) => ipcRenderer.invoke("save-granite-runtime-api-key", key),
  getCohereRuntimeApiKey: (options = {}) =>
    ipcRenderer.invoke("get-cohere-runtime-api-key", options),
  saveCohereRuntimeApiKey: (key) => ipcRenderer.invoke("save-cohere-runtime-api-key", key),
  getBedrockCredentials: (options = {}) => ipcRenderer.invoke("get-bedrock-credentials", options),
  saveBedrockCredential: (key, value) =>
    ipcRenderer.invoke("save-bedrock-credential", key, value),
  proxyReasoningRequest: (payload) => ipcRenderer.invoke("proxy-reasoning-request", payload),
  cancelReasoningProxyRequest: (payload) =>
    ipcRenderer.invoke("cancel-reasoning-proxy-request", payload),
  onReasoningProxyChunk: registerListener(
    "reasoning-proxy-chunk",
    (callback) => (_event, payload) => callback(payload || {})
  ),
  getLicenseApiBaseUrl: () => ipcRenderer.invoke("get-license-api-base-url"),
  saveLicenseApiBaseUrl: (url) => ipcRenderer.invoke("save-license-api-base-url", url),
  licenseGetStatus: (options = {}) => ipcRenderer.invoke("license-get-status", options),
  licenseEnsureProAccess: () => ipcRenderer.invoke("license-ensure-pro-access"),
  licenseActivate: (licenseKey) => ipcRenderer.invoke("license-activate", licenseKey),
  licenseValidate: () => ipcRenderer.invoke("license-validate"),
  licenseClear: () => ipcRenderer.invoke("license-clear"),

  // Dictation key persistence (file-based for reliable startup)
  getDictationKey: () => ipcRenderer.invoke("get-dictation-key"),
  saveDictationKey: (key) => ipcRenderer.invoke("save-dictation-key", key),

  // Activation mode persistence (file-based for reliable startup)
  getActivationMode: () => ipcRenderer.invoke("get-activation-mode"),
  saveActivationMode: (mode) => ipcRenderer.invoke("save-activation-mode", mode),

  saveAllKeysToEnv: () => ipcRenderer.invoke("save-all-keys-to-env"),
  importEnvironmentSettings: (values) =>
    ipcRenderer.invoke("import-environment-settings", values),
  syncStartupPreferences: (prefs) => ipcRenderer.invoke("sync-startup-preferences", prefs),
  exportSettingsFile: (payload) => ipcRenderer.invoke("export-settings-file", payload),
  importSettingsFile: () => ipcRenderer.invoke("import-settings-file"),
  exportTranscriptionHistory: (payload) =>
    ipcRenderer.invoke("export-transcription-history", payload),
  showItemInFolder: (filePath) => ipcRenderer.invoke("show-item-in-folder", filePath),
  getMacAppBundleDragInfo: () => ipcRenderer.invoke("get-mac-app-bundle-drag-info"),
  showMacPrivacyDragHelper: (options) =>
    ipcRenderer.invoke("show-mac-privacy-drag-helper", options),
  hideMacPrivacyDragHelper: () => ipcRenderer.invoke("hide-mac-privacy-drag-helper"),
  startMacAppBundleDrag: () => ipcRenderer.send("start-mac-app-bundle-drag"),
  revealMacAppBundle: () => ipcRenderer.invoke("reveal-mac-app-bundle"),
  onMacPrivacyPermissionGranted: registerListener(
    "mac-privacy-permission-granted",
    (callback) => (_event, payload) => callback(payload || {})
  ),

  // Local reasoning
  processLocalReasoning: (text, modelId, agentName, config) =>
    ipcRenderer.invoke("process-local-reasoning", text, modelId, agentName, config),
  checkLocalReasoningAvailable: () => ipcRenderer.invoke("check-local-reasoning-available"),

  // Anthropic reasoning
  processAnthropicReasoning: (text, modelId, agentName, config) =>
    ipcRenderer.invoke("process-anthropic-reasoning", text, modelId, agentName, config),

  // llama.cpp
  llamaCppCheck: () => ipcRenderer.invoke("llama-cpp-check"),
  llamaCppInstall: () => ipcRenderer.invoke("llama-cpp-install"),
  llamaCppUninstall: () => ipcRenderer.invoke("llama-cpp-uninstall"),

  // llama-server
  llamaServerStart: (modelId) => ipcRenderer.invoke("llama-server-start", modelId),
  llamaServerStop: () => ipcRenderer.invoke("llama-server-stop"),
  llamaServerStatus: () => ipcRenderer.invoke("llama-server-status"),

  getLogLevel: () => ipcRenderer.invoke("get-log-level"),
  log: (entry) => ipcRenderer.invoke("app-log", entry),

  // Debug logging management
  getDebugState: () => ipcRenderer.invoke("get-debug-state"),
  setDebugLogging: (enabled) => ipcRenderer.invoke("set-debug-logging", enabled),
  openLogsFolder: () => ipcRenderer.invoke("open-logs-folder"),
  getCallTraceSessions: (limit) => ipcRenderer.invoke("get-call-trace-sessions", limit),
  getCallTraceEvents: (runId, limit) => ipcRenderer.invoke("get-call-trace-events", runId, limit),
  clearCallTraces: () => ipcRenderer.invoke("clear-call-traces"),

  // System settings helpers for microphone/audio permissions
  requestMicrophoneAccess: () => ipcRenderer.invoke("request-microphone-access"),
  getMicrophoneAccessStatus: () => ipcRenderer.invoke("get-microphone-access-status"),
  openMicrophoneSettings: () => ipcRenderer.invoke("open-microphone-settings"),
  openSoundInputSettings: () => ipcRenderer.invoke("open-sound-input-settings"),
  openAccessibilitySettings: () => ipcRenderer.invoke("open-accessibility-settings"),
  getMacAccessibilityGuidance: () => ipcRenderer.invoke("get-mac-accessibility-guidance"),
  openModelCacheFolder: (rootPath) => ipcRenderer.invoke("open-model-cache-folder", rootPath),
  authClearSession: () => ipcRenderer.invoke("auth-clear-session"),
  authBridgeCreateState: () => ipcRenderer.invoke("auth-bridge-create-state"),

  // ChordVox Cloud API
  cloudTranscribe: (audioBuffer, opts) => ipcRenderer.invoke("cloud-transcribe", audioBuffer, opts),
  cloudReason: (text, opts) => ipcRenderer.invoke("cloud-reason", text, opts),
  cloudUsage: () => ipcRenderer.invoke("cloud-usage"),
  cloudCheckout: () => ipcRenderer.invoke("cloud-checkout"),
  cloudBillingPortal: () => ipcRenderer.invoke("cloud-billing-portal"),

  // Assembly AI Streaming
  assemblyAiStreamingWarmup: (options) =>
    ipcRenderer.invoke("assemblyai-streaming-warmup", options),
  assemblyAiStreamingStart: (options) => ipcRenderer.invoke("assemblyai-streaming-start", options),
  assemblyAiStreamingSend: (audioBuffer) =>
    ipcRenderer.send("assemblyai-streaming-send", audioBuffer),
  assemblyAiStreamingForceEndpoint: () => ipcRenderer.send("assemblyai-streaming-force-endpoint"),
  assemblyAiStreamingStop: () => ipcRenderer.invoke("assemblyai-streaming-stop"),
  assemblyAiStreamingStatus: () => ipcRenderer.invoke("assemblyai-streaming-status"),
  onAssemblyAiPartialTranscript: registerListener(
    "assemblyai-partial-transcript",
    (callback) => (_event, text) => callback(text)
  ),
  onAssemblyAiFinalTranscript: registerListener(
    "assemblyai-final-transcript",
    (callback) => (_event, text) => callback(text)
  ),
  onAssemblyAiError: registerListener(
    "assemblyai-error",
    (callback) => (_event, error) => callback(error)
  ),
  onAssemblyAiSessionEnd: registerListener(
    "assemblyai-session-end",
    (callback) => (_event, data) => callback(data)
  ),

  // Sherpa-onnx Local Streaming
  sherpaStreamingGetModels: (options) => ipcRenderer.invoke("sherpa-streaming-get-models", options),
  sherpaStreamingCheckModel: (modelId, modelsDir) =>
    ipcRenderer.invoke("sherpa-streaming-check-model", { modelId, modelsDir }),
  sherpaStreamingDownloadModel: (modelId, modelsDir, options = {}) =>
    ipcRenderer.invoke("sherpa-streaming-download-model", { ...options, modelId, modelsDir }),
  sherpaStreamingCancelDownload: () => ipcRenderer.invoke("sherpa-streaming-cancel-download"),
  sherpaStreamingDeleteModel: (modelId, modelsDir) =>
    ipcRenderer.invoke("sherpa-streaming-delete-model", { modelId, modelsDir }),
  sherpaStreamingDeleteAllModels: (modelsDir) =>
    ipcRenderer.invoke("sherpa-streaming-delete-all-models", { modelsDir }),
  sherpaStreamingTranscribeFile: (audioBlob, options) => {
    const sourceFilePath = getPathForFile(audioBlob);
    if (sourceFilePath) {
      return invokeWithFilePath("sherpa-streaming-transcribe-file-path", audioBlob, options);
    }
    return ipcRenderer.invoke("sherpa-streaming-transcribe-file", audioBlob, options);
  },
  sherpaStreamingWarmup: (options) => ipcRenderer.invoke("sherpa-streaming-warmup", options),
  sherpaStreamingStart: (options) => ipcRenderer.invoke("sherpa-streaming-start", options),
  sherpaStreamingSend: (audioBuffer) => ipcRenderer.send("sherpa-streaming-send", audioBuffer),
  sherpaStreamingStop: () => ipcRenderer.invoke("sherpa-streaming-stop"),
  sherpaStreamingStatus: () => ipcRenderer.invoke("sherpa-streaming-status"),
  pickStreamingModelDirectory: (defaultPath) =>
    ipcRenderer.invoke("pick-streaming-model-directory", defaultPath),
  onSherpaStreamingDownloadProgress: registerListener("sherpa-streaming-download-progress"),
  onSherpaPartialTranscript: registerListener(
    "sherpa-streaming-partial-transcript",
    (callback) => (_event, text) => callback(text)
  ),
  onSherpaFinalTranscript: registerListener(
    "sherpa-streaming-final-transcript",
    (callback) => (_event, text) => callback(text)
  ),
  onSherpaAutoStop: registerListener(
    "sherpa-streaming-auto-stop",
    (callback) => (_event, payload) => callback(payload || {})
  ),
  onSherpaError: registerListener(
    "sherpa-streaming-error",
    (callback) => (_event, error) => callback(error)
  ),

  // Deepgram Streaming
  deepgramStreamingWarmup: (options) => ipcRenderer.invoke("deepgram-streaming-warmup", options),
  deepgramStreamingStart: (options) => ipcRenderer.invoke("deepgram-streaming-start", options),
  deepgramStreamingSend: (audioBuffer) => ipcRenderer.send("deepgram-streaming-send", audioBuffer),
  deepgramStreamingFinalize: () => ipcRenderer.send("deepgram-streaming-finalize"),
  deepgramStreamingStop: () => ipcRenderer.invoke("deepgram-streaming-stop"),
  deepgramStreamingStatus: () => ipcRenderer.invoke("deepgram-streaming-status"),
  onDeepgramPartialTranscript: registerListener(
    "deepgram-partial-transcript",
    (callback) => (_event, text) => callback(text)
  ),
  onDeepgramFinalTranscript: registerListener(
    "deepgram-final-transcript",
    (callback) => (_event, text) => callback(text)
  ),
  onDeepgramError: registerListener(
    "deepgram-error",
    (callback) => (_event, error) => callback(error)
  ),
  onDeepgramSessionEnd: registerListener(
    "deepgram-session-end",
    (callback) => (_event, data) => callback(data)
  ),

  // Usage limit events (for showing UpgradePrompt in ControlPanel)
  notifyLimitReached: (data) => ipcRenderer.send("limit-reached", data),
  onLimitReached: registerListener("limit-reached", (callback) => (_event, data) => callback(data)),

  // Globe key listener for hotkey capture (macOS only)
  onGlobeKeyPressed: (callback) => {
    const listener = () => callback?.();
    ipcRenderer.on("globe-key-pressed", listener);
    return () => ipcRenderer.removeListener("globe-key-pressed", listener);
  },
  onGlobeKeyReleased: (callback) => {
    const listener = () => callback?.();
    ipcRenderer.on("globe-key-released", listener);
    return () => ipcRenderer.removeListener("globe-key-released", listener);
  },

  // Hotkey registration events (for notifying user when hotkey fails)
  onHotkeyFallbackUsed: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("hotkey-fallback-used", listener);
    return () => ipcRenderer.removeListener("hotkey-fallback-used", listener);
  },
  onHotkeyRegistrationFailed: (callback) => {
    const listener = (_event, data) => callback?.(data);
    ipcRenderer.on("hotkey-registration-failed", listener);
    return () => ipcRenderer.removeListener("hotkey-registration-failed", listener);
  },
  onWindowsPushToTalkUnavailable: registerListener("windows-ptt-unavailable"),

  // Notify main process of activation mode changes (for Windows Push-to-Talk)
  notifyActivationModeChanged: (mode) => ipcRenderer.send("activation-mode-changed", mode),
  notifyHotkeyChanged: (hotkey, profileId = "primary") =>
    ipcRenderer.send("hotkey-changed", hotkey, profileId),
  notifyMacNativeHotkeyEligibilityChanged: (eligible) =>
    ipcRenderer.send("mac-native-hotkey-eligibility-changed", eligible),
  notifyLocalStorageChanged: (key) => {
    if (typeof key === "string" && key) {
      ipcRenderer.send("local-storage-changed", { key });
    }
  },
  onLocalStorageChanged: registerListener(
    "local-storage-changed",
    (callback) => (_event, payload) => callback(payload || {})
  ),

  notifyDictationCueStyleChanged: (style) => ipcRenderer.send("dictation-cue-style-changed", style),
  onDictationCueStyleChanged: registerListener(
    "dictation-cue-style-changed",
    (callback) => (_event, style) => callback(style)
  ),
  notifyRecordingAnimationStyleChanged: (style) =>
    ipcRenderer.send("recording-animation-style-changed", style),
  onRecordingAnimationStyleChanged: registerListener(
    "recording-animation-style-changed",
    (callback) => (_event, style) => callback(style)
  ),
  onSystemSuspend: registerListener(
    "system-suspend",
    (callback) => (_event, payload) => callback(payload)
  ),
  onSystemResumeRecovering: registerListener(
    "system-resume-recovering",
    (callback) => (_event, payload) => callback(payload)
  ),
  onSystemResumed: registerListener(
    "system-resumed",
    (callback) => (_event, payload) => callback(payload)
  ),
  onAppShuttingDown: registerListener(
    "app-shutting-down",
    (callback) => (_event, payload) => callback(payload)
  ),

  // Auto-start management
  getAutoStartEnabled: () => ipcRenderer.invoke("get-auto-start-enabled"),
  setAutoStartEnabled: (enabled) => ipcRenderer.invoke("set-auto-start-enabled", enabled),

  // macOS menu bar icon management
  getTrayIconEnabled: () => ipcRenderer.invoke("get-tray-icon-enabled"),
  setTrayIconEnabled: (enabled) => ipcRenderer.invoke("set-tray-icon-enabled", enabled),

  // Auto-check-update management
  getAutoCheckUpdate: () => ipcRenderer.invoke("get-auto-check-update"),
  setAutoCheckUpdate: (enabled) => ipcRenderer.invoke("set-auto-check-update", enabled),

  // Context-aware refinement
  captureContext: (options) => ipcRenderer.invoke("capture-context", options),
  checkContextPermissions: () => ipcRenderer.invoke("check-context-permissions"),
  testVisionCapability: (options) => ipcRenderer.invoke("test-vision-capability", options),
  getSensitiveApps: () => ipcRenderer.invoke("get-sensitive-apps"),
  pickSensitiveApps: (options) => ipcRenderer.invoke("pick-sensitive-apps", options),
  setSensitiveApps: (config) => ipcRenderer.invoke("set-sensitive-apps", config),
  requestScreenRecordingPermission: () => ipcRenderer.invoke("request-screen-recording-permission"),
  openScreenRecordingSettings: () => ipcRenderer.invoke("open-screen-recording-settings"),
  getContextSettings: () => ipcRenderer.invoke("get-context-settings"),
  setContextSettings: (settings) => ipcRenderer.invoke("set-context-settings", settings),
  setContextEnabled: (enabled) => ipcRenderer.invoke("set-context-enabled", enabled),
  getFrontmostApp: () => ipcRenderer.invoke("get-frontmost-app"),
});
