export type LocalTranscriptionProvider = "whisper" | "nvidia" | "sensevoice";
export type DictationProfileId = "primary" | "secondary";

export interface DictationHotkeyPayload {
  profileId?: DictationProfileId;
}

export interface TranscriptionItem {
  id: number;
  text: string;
  timestamp: string;
  created_at: string;
}

export interface TranscriptionStats {
  todayUnits: number;
  totalUnits: number;
  todayEntries: number;
  totalEntries: number;
  totalRecordingDurationMs: number;
  estimatedTimeSavedMs: number;
  averageDictationUnitsPerMinute: number;
  lastUpdatedAt: string | null;
}

export interface WhisperCheckResult {
  installed: boolean;
  working: boolean;
  error?: string;
}

export interface WhisperModelResult {
  success: boolean;
  model: string;
  downloaded: boolean;
  size_mb?: number;
  error?: string;
  code?: string;
}

export interface WhisperModelDeleteResult {
  success: boolean;
  model: string;
  deleted: boolean;
  freed_mb?: number;
  error?: string;
}

export interface WhisperModelsListResult {
  success: boolean;
  models: Array<{ model: string; downloaded: boolean; size_mb?: number; path?: string }>;
  cache_dir: string;
}

export interface FFmpegAvailabilityResult {
  available: boolean;
  path?: string;
  error?: string;
}

export interface AudioDiagnosticsResult {
  platform: string;
  arch: string;
  resourcesPath: string | null;
  isPackaged: boolean;
  ffmpeg: { available: boolean; path: string | null; error: string | null };
  whisperBinary: { available: boolean; path: string | null; error: string | null };
  whisperServer: { available: boolean; path: string | null };
  modelsDir: string;
  models: string[];
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  version?: string;
  releaseDate?: string;
  files?: any[];
  releaseNotes?: string;
  manualDownloadUrl?: string | null;
  manualOnly?: boolean;
  message?: string;
  error?: string;
}

export interface UpdateStatusResult {
  updateAvailable: boolean;
  updateDownloaded: boolean;
  isDevelopment: boolean;
  isDownloading?: boolean;
  lastCheckedAt?: string | null;
}

export interface UpdateInfoResult {
  version?: string;
  releaseDate?: string;
  releaseNotes?: string | null;
  files?: any[];
  manualDownloadUrl?: string | null;
  manualOnly?: boolean;
}

export interface UpdateResult {
  success: boolean;
  message: string;
  manual?: boolean;
  url?: string;
}

export interface AppVersionResult {
  version: string;
}

export interface WhisperDownloadProgressData {
  type: "progress" | "installing" | "complete" | "error";
  model: string;
  percentage?: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  error?: string;
  code?: string;
  result?: any;
}

export interface ParakeetCheckResult {
  installed: boolean;
  working: boolean;
  path?: string;
}

export interface ParakeetModelResult {
  success: boolean;
  model: string;
  downloaded: boolean;
  path?: string;
  size_bytes?: number;
  size_mb?: number;
  error?: string;
  code?: string;
}

export interface ParakeetModelDeleteResult {
  success: boolean;
  model: string;
  deleted: boolean;
  freed_bytes?: number;
  freed_mb?: number;
  error?: string;
}

export interface ParakeetModelsListResult {
  success: boolean;
  models: Array<{ model: string; downloaded: boolean; size_mb?: number; path?: string }>;
  cache_dir: string;
}

export interface ParakeetDownloadProgressData {
  type: "progress" | "installing" | "complete" | "error";
  model: string;
  percentage?: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  error?: string;
  code?: string;
}

export interface ParakeetTranscriptionResult {
  success: boolean;
  text?: string;
  message?: string;
  error?: string;
}

export interface ParakeetDiagnosticsResult {
  platform: string;
  arch: string;
  resourcesPath: string | null;
  isPackaged: boolean;
  sherpaOnnx: { available: boolean; path: string | null };
  modelsDir: string;
  models: string[];
}

export interface SenseVoiceCheckResult {
  installed: boolean;
  working: boolean;
  path?: string;
  error?: string;
}

export interface SenseVoiceModelStatusResult {
  success: boolean;
  model?: string;
  modelPath: string;
  downloaded: boolean;
  size_mb?: number;
  runtimeKind?: "sensevoice";
}

export interface SenseVoiceModelResult {
  success: boolean;
  model: string;
  downloaded: boolean;
  path?: string;
  size_bytes?: number;
  size_mb?: number;
  runtimeKind?: "sensevoice";
  error?: string;
  code?: string;
}

export interface SenseVoiceModelDeleteResult {
  success: boolean;
  model: string;
  deleted: boolean;
  freed_bytes?: number;
  freed_mb?: number;
  error?: string;
}

export interface SenseVoiceModelsListResult {
  success: boolean;
  models: Array<{
    model: string;
    modelPath?: string;
    downloaded: boolean;
    size_mb?: number;
    path?: string;
    runtimeKind?: "sensevoice";
  }>;
  cache_dir: string;
}

export interface SenseVoiceDownloadProgressData {
  type: "progress" | "installing" | "complete" | "error";
  model: string;
  percentage?: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  error?: string;
  code?: string;
}

export interface SherpaStreamingModelInfo {
  id: string;
  name: string;
  nameEn: string;
  size: string;
  sizeBytes: number;
  dirName: string;
  downloadUrl: string;
  modelType: string;
  tier: string;
  language: string;
  isDownloaded: boolean;
  modelDir: string;
  default?: boolean;
}

export interface SherpaStreamingModelResult {
  success: boolean;
  model?: string;
  downloaded?: boolean;
  deleted?: boolean;
  path?: string;
  error?: string;
  code?: string;
}

export interface SherpaStreamingModelsListResult {
  success: boolean;
  models: SherpaStreamingModelInfo[];
  error?: string;
}

export interface SherpaStreamingDownloadProgressData {
  type: "progress" | "installing" | "complete" | "error";
  model: string;
  percentage?: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  error?: string;
  code?: string;
}

export interface SherpaStreamingAutoStopPayload {
  reason?: string;
  minSilenceDuration?: number;
  observedSpeech?: boolean;
}

export interface SenseVoiceTranscriptionResult {
  success: boolean;
  text?: string;
  message?: string;
  error?: string;
}

export interface FilePickResult {
  success: boolean;
  path: string | null;
  cancelled?: boolean;
  error?: string;
}

export interface MacAccessibilityGuidanceResult {
  platform: string;
  packaged: boolean;
  signed: boolean;
  trustedSignature: boolean;
  shouldRegrantAfterUpdate: boolean;
  reason?: string;
}

export interface SettingsFileOperationResult {
  success: boolean;
  cancelled?: boolean;
  filePath?: string;
  error?: string;
}

export interface SettingsImportResult extends SettingsFileOperationResult {
  data?: any;
}

export interface CallTraceSession {
  runId: string;
  profileId: DictationProfileId;
  startedAt: string | null;
  updatedAt: string | null;
  sessionStatus: "unknown" | "start" | "success" | "error" | "cancelled";
  transcriptionStatus: "unknown" | "start" | "success" | "error" | "skipped";
  reasoningStatus: "unknown" | "start" | "success" | "error" | "skipped";
  pasteStatus: "unknown" | "start" | "success" | "error" | "skipped";
  transcriptionModel: string | null;
  transcriptionProvider: string | null;
  reasoningModel: string | null;
  reasoningProvider: string | null;
  source: string | null;
  error: string | null;
  eventsCount: number;
  failurePhase: "session" | "recording" | "transcription" | "reasoning" | "paste" | null;
  sessionDurationMs: number | null;
  recordingDurationMs: number | null;
  transcriptionProcessingDurationMs: number | null;
  reasoningProcessingDurationMs: number | null;
}

export interface CallTraceEvent {
  id: string;
  timestamp: string;
  level: string;
  message: string;
  scope: string | null;
  source: string | null;
  meta: {
    runId?: string;
    profileId?: DictationProfileId;
    phase?: "session" | "recording" | "transcription" | "reasoning" | "paste";
    status?: "start" | "success" | "error" | "cancelled" | "skipped";
    source?: string;
    transcriptionProvider?: string;
    transcriptionModel?: string;
    reasoningProvider?: string;
    reasoningModel?: string;
    recordingDurationMs?: number;
    error?: string;
    [key: string]: any;
  } | null;
}

export interface LicenseStatusResult {
  success: boolean;
  configured: boolean;
  requiresServerValidation?: boolean;
  status: "unlicensed" | "active" | "expired" | "offline_grace" | "invalid";
  isActive: boolean;
  keyPresent: boolean;
  plan?: string | null;
  expiresAt?: string | null;
  trialEnabled?: boolean;
  trialDays?: number;
  trialStartedAt?: string | null;
  trialExpiresAt?: string | null;
  trialDaysLeft?: number;
  trialActive?: boolean;
  lastValidatedAt?: string | null;
  offlineGraceUntil?: string | null;
  message?: string | null;
  error?: string | null;
}

export interface PasteToolsResult {
  platform: "darwin" | "win32" | "linux";
  available: boolean;
  method: string | null;
  requiresPermission: boolean;
  isWayland?: boolean;
  xwaylandAvailable?: boolean;
  terminalAware?: boolean;
  hasNativeBinary?: boolean;
  hasUinput?: boolean;
  tools?: string[];
  recommendedInstall?: string;
}

declare global {
  interface Window {
    electronAPI: {
      // Basic window operations
      pasteText: (text: string, options?: { fromStreaming?: boolean }) => Promise<void>;
      hideWindow: () => Promise<void>;
      showDictationPanel: () => Promise<void>;
      onToggleDictation: (callback: (payload?: DictationHotkeyPayload) => void) => () => void;
      onStartDictation?: (callback: (payload?: DictationHotkeyPayload) => void) => () => void;
      onStopDictation?: (callback: (payload?: DictationHotkeyPayload) => void) => () => void;

      // Database operations
      saveTranscription: (
        text: string,
        metadata?: {
          unitCount?: number;
          recordingDurationMs?: number | null;
        }
      ) => Promise<{ id: number; success: boolean }>;
      getTranscriptions: (limit?: number) => Promise<TranscriptionItem[]>;
      getTranscriptionStats: () => Promise<TranscriptionStats>;
      clearTranscriptions: () => Promise<{ cleared: number; success: boolean }>;
      deleteTranscription: (id: number) => Promise<{ success: boolean }>;

      // Dictionary operations
      getDictionary: () => Promise<string[]>;
      setDictionary: (words: string[]) => Promise<{ success: boolean }>;

      // Database event listeners
      onTranscriptionAdded?: (callback: (item: TranscriptionItem) => void) => () => void;
      onTranscriptionDeleted?: (callback: (payload: { id: number }) => void) => () => void;
      onTranscriptionsCleared?: (callback: (payload: { cleared: number }) => void) => () => void;

      // API key management
      getOpenAIKey: () => Promise<string>;
      saveOpenAIKey: (key: string) => Promise<{ success: boolean }>;
      createProductionEnvFile: (key: string) => Promise<void>;
      getAnthropicKey: () => Promise<string | null>;
      saveAnthropicKey: (key: string) => Promise<void>;
      getOpenRouterKey: () => Promise<string | null>;
      saveOpenRouterKey: (key: string) => Promise<void>;
      getUiLanguage: () => Promise<string>;
      getInitialUiLanguage: () => string;
      saveUiLanguage: (language: string) => Promise<{ success: boolean; language: string }>;
      setUiLanguage: (language: string) => Promise<{ success: boolean; language: string }>;
      getModelStorageRoot?: () => Promise<string>;
      saveModelStorageRoot?: (
        rootPath: string
      ) => Promise<{ success: boolean; root: string; effectiveRoot: string }>;
      pickModelStorageRoot?: (defaultPath?: string) => Promise<FilePickResult>;
      saveAllKeysToEnv: () => Promise<{ success: boolean; path: string }>;
      syncStartupPreferences: (prefs: {
        useLocalWhisper: boolean;
        localTranscriptionProvider: LocalTranscriptionProvider;
        model?: string;
        senseVoiceBinaryPath?: string;
        reasoningProvider: string;
        reasoningModel?: string;
      }) => Promise<void>;
      exportSettingsFile: (payload: any) => Promise<SettingsFileOperationResult>;
      importSettingsFile: () => Promise<SettingsImportResult>;

      // Clipboard operations
      readClipboard: () => Promise<string>;
      writeClipboard: (text: string) => Promise<{ success: boolean }>;
      checkPasteTools: () => Promise<PasteToolsResult>;

      // Audio
      onNoAudioDetected: (callback: (event: any, data?: any) => void) => () => void;

      // Whisper operations (whisper.cpp)
      transcribeLocalWhisper: (audioBlob: Blob | ArrayBuffer, options?: any) => Promise<any>;
      checkWhisperInstallation: () => Promise<WhisperCheckResult>;
      downloadWhisperModel: (modelName: string) => Promise<WhisperModelResult>;
      onWhisperDownloadProgress: (
        callback: (event: any, data: WhisperDownloadProgressData) => void
      ) => () => void;
      checkModelStatus: (modelName: string) => Promise<WhisperModelResult>;
      listWhisperModels: () => Promise<WhisperModelsListResult>;
      deleteWhisperModel: (modelName: string) => Promise<WhisperModelDeleteResult>;
      deleteAllWhisperModels: () => Promise<{
        success: boolean;
        deleted_count?: number;
        freed_bytes?: number;
        freed_mb?: number;
        error?: string;
      }>;
      cancelWhisperDownload: () => Promise<{
        success: boolean;
        message?: string;
        error?: string;
      }>;

      // Parakeet operations (NVIDIA via sherpa-onnx)
      transcribeLocalParakeet: (
        audioBlob: ArrayBuffer,
        options?: { model?: string; modelPath?: string; language?: string }
      ) => Promise<ParakeetTranscriptionResult>;
      checkParakeetInstallation: () => Promise<ParakeetCheckResult>;
      downloadParakeetModel: (modelName: string) => Promise<ParakeetModelResult>;
      onParakeetDownloadProgress: (
        callback: (event: any, data: ParakeetDownloadProgressData) => void
      ) => () => void;
      checkParakeetModelStatus: (modelName: string) => Promise<ParakeetModelResult>;
      listParakeetModels: () => Promise<ParakeetModelsListResult>;
      deleteParakeetModel: (modelName: string) => Promise<ParakeetModelDeleteResult>;
      deleteAllParakeetModels: () => Promise<{
        success: boolean;
        deleted_count?: number;
        freed_bytes?: number;
        freed_mb?: number;
        error?: string;
      }>;
      cancelParakeetDownload: () => Promise<{
        success: boolean;
        message?: string;
        error?: string;
      }>;
      getParakeetDiagnostics: () => Promise<ParakeetDiagnosticsResult>;

      // SenseVoice operations (external CLI + local GGUF)
      transcribeLocalSenseVoice: (
        audioBlob: ArrayBuffer,
        options?: {
          modelPath?: string;
          binaryPath?: string;
          language?: string;
          threads?: number;
          timeoutMs?: number;
          noGpu?: boolean;
        }
      ) => Promise<SenseVoiceTranscriptionResult>;
      checkSenseVoiceInstallation: (binaryPath?: string) => Promise<SenseVoiceCheckResult>;
      downloadSenseVoiceModel: (modelName: string) => Promise<SenseVoiceModelResult>;
      onSenseVoiceDownloadProgress: (
        callback: (event: any, data: SenseVoiceDownloadProgressData) => void
      ) => () => void;
      checkSenseVoiceModelStatus: (
        modelPathOrModel: string
      ) => Promise<SenseVoiceModelStatusResult>;
      listSenseVoiceModels: () => Promise<SenseVoiceModelsListResult>;
      deleteSenseVoiceModel: (modelName: string) => Promise<SenseVoiceModelDeleteResult>;
      deleteAllSenseVoiceModels: () => Promise<{
        success: boolean;
        deleted_count?: number;
        freed_bytes?: number;
        freed_mb?: number;
        error?: string;
      }>;
      cancelSenseVoiceDownload: () => Promise<{
        success: boolean;
        message?: string;
        error?: string;
      }>;
      pickWhisperModelFile: (defaultPath?: string) => Promise<FilePickResult>;
      pickParakeetModelDirectory: (defaultPath?: string) => Promise<FilePickResult>;
      pickStreamingModelDirectory: (defaultPath?: string) => Promise<FilePickResult>;
      pickSenseVoiceModelFile: (defaultPath?: string) => Promise<FilePickResult>;
      pickSenseVoiceBinary: (defaultPath?: string) => Promise<FilePickResult>;

      // Local AI model management
      modelGetAll: () => Promise<any[]>;
      modelCheck: (modelId: string) => Promise<boolean>;
      modelDownload: (modelId: string) => Promise<void>;
      modelDelete: (modelId: string) => Promise<void>;
      modelDeleteAll: () => Promise<{ success: boolean; error?: string; code?: string }>;
      modelCheckRuntime: () => Promise<boolean>;
      modelCancelDownload: (modelId: string) => Promise<{ success: boolean; error?: string }>;
      onModelDownloadProgress: (callback: (event: any, data: any) => void) => () => void;

      // Local reasoning
      processLocalReasoning: (
        text: string,
        modelId: string,
        agentName: string | null,
        config: any
      ) => Promise<{ success: boolean; text?: string; error?: string }>;
      checkLocalReasoningAvailable: () => Promise<boolean>;

      // Anthropic reasoning
      processAnthropicReasoning: (
        text: string,
        modelId: string,
        agentName: string | null,
        config: any
      ) => Promise<{ success: boolean; text?: string; error?: string }>;

      // llama.cpp management
      llamaCppCheck: () => Promise<{ isInstalled: boolean; version?: string }>;
      llamaCppInstall: () => Promise<{ success: boolean; error?: string }>;
      llamaCppUninstall: () => Promise<{ success: boolean; error?: string }>;

      // Window control operations
      windowMinimize: () => Promise<void>;
      windowMaximize: () => Promise<void>;
      windowClose: () => Promise<void>;
      windowIsMaximized: () => Promise<boolean>;
      getPlatform: () => string;
      startWindowDrag: () => Promise<void>;
      stopWindowDrag: () => Promise<void>;
      setMainWindowInteractivity: (interactive: boolean) => Promise<void>;
      toggleCommandMenu: (state?: {
        isRecording?: boolean;
        canStop?: boolean;
      }) => Promise<{ success: boolean; isVisible?: boolean; message?: string }>;
      hideCommandMenu: () => Promise<{ success: boolean }>;
      commandMenuStart: () => Promise<{ success: boolean }>;
      commandMenuStop: () => Promise<{ success: boolean }>;
      commandMenuHidePanel: () => Promise<{ success: boolean }>;
      updateCommandMenuState: (state?: {
        isRecording?: boolean;
        canStop?: boolean;
      }) => Promise<{ success: boolean }>;
      onCommandMenuState: (
        callback: (data: { isVisible: boolean; isRecording: boolean; canStop: boolean }) => void
      ) => () => void;
      onCommandMenuVisibilityChanged: (
        callback: (data: { isVisible: boolean }) => void
      ) => () => void;

      // App management
      appQuit: () => Promise<void>;
      cleanupApp: () => Promise<{ success: boolean; message: string }>;

      // Update operations
      checkForUpdates: () => Promise<UpdateCheckResult>;
      downloadUpdate: () => Promise<UpdateResult>;
      installUpdate: () => Promise<UpdateResult>;
      getAppVersion: () => Promise<AppVersionResult>;
      getUpdateStatus: () => Promise<UpdateStatusResult>;
      getUpdateInfo: () => Promise<UpdateInfoResult | null>;

      // Update event listeners
      onCheckingForUpdate: (callback: (event: any, info: any) => void) => () => void;
      onUpdateAvailable: (callback: (event: any, info: any) => void) => () => void;
      onUpdateNotAvailable: (callback: (event: any, info: any) => void) => () => void;
      onUpdateDownloaded: (callback: (event: any, info: any) => void) => () => void;
      onUpdateDownloadProgress: (callback: (event: any, progressObj: any) => void) => () => void;
      onUpdateError: (callback: (event: any, error: any) => void) => () => void;

      openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;

      // Hotkey management
      updateHotkey: (key: string) => Promise<{ success: boolean; message: string }>;
      updateSecondaryHotkey?: (
        key: string
      ) => Promise<{ success: boolean; message: string; code?: string }>;
      setHotkeyListeningMode?: (
        enabled: boolean,
        newHotkey?: string | null,
        scope?: "primary" | "secondary"
      ) => Promise<{ success: boolean }>;
      getHotkeyModeInfo?: () => Promise<{
        isUsingGnome: boolean;
        platform: "darwin" | "win32" | "linux";
        backend:
          | "globe"
          | "globalShortcut"
          | "windows-native"
          | "gnome-wayland"
          | "native-modifier";
        activationMode: string;
        primaryHotkey: string;
        secondaryHotkey: string;
        primaryRegistered: boolean;
        secondaryRegistered: boolean;
        recommendedPrimaryHotkey: string;
      }>;

      // Globe key listener for hotkey capture (macOS only)
      onGlobeKeyPressed?: (callback: () => void) => () => void;
      onGlobeKeyReleased?: (callback: () => void) => () => void;

      // Hotkey registration events
      onHotkeyFallbackUsed?: (
        callback: (data: { original: string; fallback: string; message: string }) => void
      ) => () => void;
      onHotkeyRegistrationFailed?: (
        callback: (data: { hotkey: string; error: string; suggestions: string[] }) => void
      ) => () => void;

      // Gemini API key management
      getGeminiKey: () => Promise<string | null>;
      saveGeminiKey: (key: string) => Promise<void>;

      // Groq API key management
      getGroqKey: () => Promise<string | null>;
      saveGroqKey: (key: string) => Promise<void>;
      testCloudTranscriptionConnection: (data?: {
        provider?: string;
        apiKey?: string;
        model?: string;
      }) => Promise<{
        success: boolean;
        provider?: string;
        model?: string;
        modelFound?: boolean;
        availableModelCount?: number;
        error?: string;
        code?: string;
        message?: string;
      }>;

      // Doubao ASR credential management
      getDoubaoAppId: () => Promise<string | null>;
      saveDoubaoAppId: (appId: string) => Promise<void>;
      getDoubaoAccessToken: () => Promise<string | null>;
      saveDoubaoAccessToken: (token: string) => Promise<void>;
      testDoubaoConnection: (data?: {
        appId?: string;
        accessToken?: string;
        model?: string;
        language?: string;
      }) => Promise<{
        success: boolean;
        resourceId?: string;
        resolvedModelId?: string;
        logId?: string | null;
        error?: string;
        code?: string;
        message?: string;
      }>;
      proxyDoubaoTranscription: (data: {
        audioBuffer: ArrayBuffer;
        model?: string;
        language?: string;
        appId?: string;
        accessToken?: string;
      }) => Promise<{ text: string }>;

      // Custom endpoint API keys
      getCustomTranscriptionKey?: () => Promise<string | null>;
      saveCustomTranscriptionKey?: (key: string) => Promise<void>;
      getCustomReasoningKey?: () => Promise<string | null>;
      saveCustomReasoningKey?: (key: string) => Promise<void>;
      getLicenseApiBaseUrl?: () => Promise<string | null>;
      saveLicenseApiBaseUrl?: (url: string) => Promise<{ success: boolean; value?: string }>;
      licenseGetStatus?: () => Promise<LicenseStatusResult>;
      licenseEnsureProAccess?: () => Promise<LicenseStatusResult>;
      licenseActivate?: (licenseKey: string) => Promise<LicenseStatusResult>;
      licenseValidate?: () => Promise<LicenseStatusResult>;
      licenseClear?: () => Promise<LicenseStatusResult>;

      // Dictation key persistence (file-based for reliable startup)
      getDictationKey?: () => Promise<string | null>;
      getHotkeyDiagnostics?: () => Promise<{
        isUsingGnome: boolean;
        platform: "darwin" | "win32" | "linux";
        sessionType: string;
        desktopSession: string;
        backend:
          | "globe"
          | "globalShortcut"
          | "windows-native"
          | "gnome-wayland"
          | "native-modifier";
        activationMode: string;
        primaryHotkey: string;
        secondaryHotkey: string;
        primaryRegistered: boolean;
        secondaryRegistered: boolean;
        recommendedPrimaryHotkey: string;
      }>;
      testHotkeyWake?: (profileId?: DictationProfileId) => Promise<{ success: boolean }>;
      saveDictationKey?: (key: string) => Promise<void>;

      // Activation mode persistence (file-based for reliable startup)
      getActivationMode?: () => Promise<"tap" | "push">;
      saveActivationMode?: (mode: "tap" | "push") => Promise<void>;

      // Debug logging
      getLogLevel?: () => Promise<string>;
      log?: (entry: {
        level: string;
        message: string;
        meta?: any;
        scope?: string;
        source?: string;
      }) => Promise<void>;
      getDebugState: () => Promise<{
        enabled: boolean;
        logPath: string | null;
        logLevel: string;
      }>;
      setDebugLogging: (enabled: boolean) => Promise<{
        success: boolean;
        enabled?: boolean;
        logPath?: string | null;
        error?: string;
      }>;
      openLogsFolder: () => Promise<{ success: boolean; error?: string }>;
      getCallTraceSessions: (
        limit?: number
      ) => Promise<{ success: boolean; sessions: CallTraceSession[]; error?: string }>;
      getCallTraceEvents: (
        runId: string,
        limit?: number
      ) => Promise<{ success: boolean; events: CallTraceEvent[]; error?: string }>;
      clearCallTraces: () => Promise<{ success: boolean; error?: string }>;

      // FFmpeg availability
      checkFFmpegAvailability: () => Promise<FFmpegAvailabilityResult>;
      getAudioDiagnostics: () => Promise<AudioDiagnosticsResult>;

      // System settings helpers
      requestMicrophoneAccess?: () => Promise<{ granted: boolean }>;
      openMicrophoneSettings?: () => Promise<{ success: boolean; error?: string }>;
      openSoundInputSettings?: () => Promise<{ success: boolean; error?: string }>;
      openAccessibilitySettings?: () => Promise<{ success: boolean; error?: string }>;
      getMacAccessibilityGuidance?: () => Promise<MacAccessibilityGuidanceResult>;
      openWhisperModelsFolder?: () => Promise<{ success: boolean; error?: string }>;

      // Windows Push-to-Talk notifications
      notifyActivationModeChanged?: (mode: "tap" | "push") => void;
      notifyHotkeyChanged?: (hotkey: string, profileId?: DictationProfileId) => void;
      notifyDictationCueStyleChanged?: (
        style: "off" | "electronic" | "droplet1" | "droplet2"
      ) => void;
      onDictationCueStyleChanged?: (
        callback: (style: "off" | "electronic" | "droplet1" | "droplet2") => void
      ) => () => void;
      notifyRecordingAnimationStyleChanged?: (style: "line" | "particles" | "level") => void;
      onRecordingAnimationStyleChanged?: (
        callback: (style: "line" | "particles" | "level") => void
      ) => () => void;

      // Auto-start at login
      getAutoStartEnabled?: () => Promise<boolean>;
      setAutoStartEnabled?: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;

      // Auto-check update management
      getAutoCheckUpdate?: () => Promise<boolean>;
      setAutoCheckUpdate?: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;

      // Auth
      authClearSession?: () => Promise<void>;

      // ChordVox Cloud API
      cloudTranscribe?: (
        audioBuffer: ArrayBuffer,
        opts: { language?: string; prompt?: string }
      ) => Promise<{
        success: boolean;
        text?: string;
        wordsUsed?: number;
        wordsRemaining?: number;
        limitReached?: boolean;
        error?: string;
        code?: string;
      }>;
      cloudReason?: (
        text: string,
        opts: {
          model?: string;
          agentName?: string;
          customDictionary?: string[];
          customPrompt?: string;
          language?: string;
          locale?: string;
        }
      ) => Promise<{
        success: boolean;
        text?: string;
        model?: string;
        provider?: string;
        error?: string;
        code?: string;
      }>;
      cloudUsage?: () => Promise<{
        success: boolean;
        wordsUsed?: number;
        wordsRemaining?: number;
        limit?: number;
        plan?: string;
        status?: string;
        isSubscribed?: boolean;
        isTrial?: boolean;
        trialDaysLeft?: number | null;
        currentPeriodEnd?: string | null;
        resetAt?: string;
        error?: string;
        code?: string;
      }>;
      cloudCheckout?: () => Promise<{
        success: boolean;
        url?: string;
        error?: string;
        code?: string;
      }>;
      cloudBillingPortal?: () => Promise<{
        success: boolean;
        url?: string;
        error?: string;
        code?: string;
      }>;

      // Usage limit events
      notifyLimitReached?: (data: { wordsUsed: number; limit: number }) => void;
      onLimitReached?: (
        callback: (data: { wordsUsed: number; limit: number }) => void
      ) => () => void;

      // AssemblyAI Streaming
      assemblyAiStreamingWarmup?: (options?: {
        sampleRate?: number;
        language?: string;
      }) => Promise<{
        success: boolean;
        alreadyWarm?: boolean;
        error?: string;
        code?: string;
      }>;
      assemblyAiStreamingStart?: (options?: { sampleRate?: number; language?: string }) => Promise<{
        success: boolean;
        usedWarmConnection?: boolean;
        error?: string;
        code?: string;
      }>;
      assemblyAiStreamingSend?: (audioBuffer: ArrayBuffer) => Promise<{
        success: boolean;
        error?: string;
      }>;
      assemblyAiStreamingForceEndpoint?: () => void;
      assemblyAiStreamingStop?: () => Promise<{
        success: boolean;
        text?: string;
        error?: string;
      }>;
      assemblyAiStreamingStatus?: () => Promise<{
        isConnected: boolean;
        sessionId: string | null;
      }>;
      onAssemblyAiPartialTranscript?: (callback: (text: string) => void) => () => void;
      onAssemblyAiFinalTranscript?: (callback: (text: string) => void) => () => void;
      onAssemblyAiError?: (callback: (error: string) => void) => () => void;
      onAssemblyAiSessionEnd?: (
        callback: (data: { audioDuration?: number; text?: string }) => void
      ) => () => void;

      // Deepgram Streaming
      deepgramStreamingWarmup?: (options?: { sampleRate?: number; language?: string }) => Promise<{
        success: boolean;
        alreadyWarm?: boolean;
        error?: string;
        code?: string;
      }>;
      deepgramStreamingStart?: (options?: { sampleRate?: number; language?: string }) => Promise<{
        success: boolean;
        usedWarmConnection?: boolean;
        error?: string;
        code?: string;
      }>;
      deepgramStreamingSend?: (audioBuffer: ArrayBuffer) => void;
      deepgramStreamingFinalize?: () => void;
      deepgramStreamingStop?: () => Promise<{
        success: boolean;
        text?: string;
        error?: string;
      }>;
      deepgramStreamingStatus?: () => Promise<{
        isConnected: boolean;
        sessionId: string | null;
      }>;
      onDeepgramPartialTranscript?: (callback: (text: string) => void) => () => void;
      onDeepgramFinalTranscript?: (callback: (text: string) => void) => () => void;
      onDeepgramError?: (callback: (error: string) => void) => () => void;
      onDeepgramSessionEnd?: (
        callback: (data: { audioDuration?: number; text?: string }) => void
      ) => () => void;

      // Sherpa-onnx Local Streaming
      sherpaStreamingGetModels?: (options?: {
        modelsDir?: string;
      }) => Promise<SherpaStreamingModelsListResult>;
      sherpaStreamingCheckModel?: (
        modelId: string,
        modelsDir?: string
      ) => Promise<{
        success: boolean;
        ready: boolean;
        error?: string;
      }>;
      sherpaStreamingDownloadModel?: (
        modelId: string,
        modelsDir?: string
      ) => Promise<SherpaStreamingModelResult>;
      sherpaStreamingCancelDownload?: () => Promise<{
        success: boolean;
        message?: string;
        error?: string;
      }>;
      sherpaStreamingDeleteModel?: (
        modelId: string,
        modelsDir?: string
      ) => Promise<SherpaStreamingModelResult>;
      sherpaStreamingDeleteAllModels?: (modelsDir?: string) => Promise<{
        success: boolean;
        error?: string;
      }>;
      sherpaStreamingTranscribeFile?: (
        audioBlob: Blob | ArrayBuffer,
        options?: {
          modelId?: string;
          modelsDir?: string;
          sourceFileName?: string | null;
          mimeType?: string | null;
        }
      ) => Promise<{
        success: boolean;
        text?: string;
        modelId?: string;
        error?: string;
        message?: string;
      }>;
      sherpaStreamingStart?: (options?: { modelId?: string; modelsDir?: string }) => Promise<{
        success: boolean;
        modelId?: string;
        error?: string;
      }>;
      sherpaStreamingSend?: (audioBuffer: ArrayBuffer) => void;
      sherpaStreamingStop?: () => Promise<{
        success: boolean;
        text?: string;
        error?: string;
      }>;
      sherpaStreamingStatus?: () => Promise<{
        isActive: boolean;
        currentModelId: string | null;
        hasRecognizer?: boolean;
        confirmedTextLength?: number;
        partialTextLength?: number;
      }>;
      onSherpaStreamingDownloadProgress?: (
        callback: (event: any, data: SherpaStreamingDownloadProgressData) => void
      ) => () => void;
      onSherpaAutoStop?: (
        callback: (payload: SherpaStreamingAutoStopPayload) => void
      ) => () => void;
      onSherpaPartialTranscript?: (callback: (text: string) => void) => () => void;
      onSherpaFinalTranscript?: (callback: (text: string) => void) => () => void;
      onSherpaError?: (callback: (error: string) => void) => () => void;
    };

    api?: {
      sendDebugLog: (message: string) => void;
    };
  }
}
