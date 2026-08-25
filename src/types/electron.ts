export type LocalTranscriptionProvider = "whisper" | "nvidia" | "granite" | "paraformer" | "cohere";
export type DictationProfileId = "primary" | "secondary" | `workflow-${string}`;

export interface KeychainAccessOptions {
  allowKeychain?: boolean;
}

export interface DictationHotkeyPayload {
  profileId?: DictationProfileId;
}

export interface DictationWindowSize {
  width: number;
  height: number;
}

export interface DictationUiPreparationPayload extends DictationHotkeyPayload {
  requestId?: number;
}

export interface DictationUiReadyPayload {
  requestId: number;
  animationStyle: "flow" | "stardust" | "nebula";
  size: DictationWindowSize;
}

export interface TranscriptionItem {
  id: number;
  text: string;
  timestamp: string;
  created_at: string;
  favorite?: number;
  unit_count?: number;
  recording_duration_ms?: number | null;
  exclude_from_stats?: number;
  estimated_typing_duration_ms?: number | null;
}

export interface FileTranscriptionCompletionAlertPayload {
  id?: number | null;
  text?: string;
  title?: string;
  description?: string;
  fileName?: string;
  createdAt?: string;
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
  statsBackfillPending?: boolean;
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
  manualDownloadUrl?: string;
  sources?: ModelDownloadSourceInfo[];
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
  autoDownload?: boolean;
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
  autoDownload?: boolean;
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

type ManagedModelDownloadProgressType =
  | "source-connect"
  | "source-switch"
  | "progress"
  | "verifying"
  | "repairing"
  | "installing"
  | "complete"
  | "error";

export interface ModelDownloadSourceInfo {
  url: string;
  kind?: string;
  label?: string;
}

export interface WhisperDownloadProgressData {
  type: ManagedModelDownloadProgressType;
  model: string;
  percentage?: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  source_index?: number;
  source_count?: number;
  source_kind?: string;
  manualDownloadUrl?: string;
  sources?: ModelDownloadSourceInfo[];
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
  manualDownloadUrl?: string;
  sources?: ModelDownloadSourceInfo[];
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
  type: ManagedModelDownloadProgressType;
  model: string;
  modelsDir?: string;
  models_dir?: string;
  percentage?: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  source_index?: number;
  source_count?: number;
  source_kind?: string;
  manualDownloadUrl?: string;
  sources?: ModelDownloadSourceInfo[];
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

export interface ParaformerCheckResult {
  installed: boolean;
  working: boolean;
  path?: string;
}

export interface ParaformerModelResult {
  success: boolean;
  model: string;
  downloaded: boolean;
  path?: string;
  size_bytes?: number;
  size_mb?: number;
  error?: string;
  code?: string;
  manualDownloadUrl?: string;
  sources?: ModelDownloadSourceInfo[];
}

export interface ParaformerModelDeleteResult {
  success: boolean;
  model: string;
  deleted: boolean;
  freed_bytes?: number;
  freed_mb?: number;
  error?: string;
}

export interface ParaformerModelsListResult {
  success: boolean;
  models: Array<{ model: string; downloaded: boolean; size_mb?: number; path?: string }>;
  cache_dir: string;
}

export interface ParaformerDownloadProgressData {
  type: ManagedModelDownloadProgressType;
  model: string;
  modelsDir?: string;
  models_dir?: string;
  percentage?: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  source_index?: number;
  source_count?: number;
  source_kind?: string;
  manualDownloadUrl?: string;
  sources?: ModelDownloadSourceInfo[];
  error?: string;
  code?: string;
}

export interface ParaformerTranscriptionResult {
  success: boolean;
  text?: string;
  message?: string;
  error?: string;
}

export interface ExternalAsrTranscriptionOptions {
  provider: "granite" | "cohere";
  model: string;
  runtimeUrl: string;
  apiKey?: string;
  language?: string;
  prompt?: string;
  mimeType?: string;
  fileName?: string;
  operationId?: string | null;
  timeoutMs?: number;
}

export interface ExternalAsrRuntimeCheckOptions {
  provider: "granite" | "cohere";
  model: string;
  runtimeUrl: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface ExternalAsrRuntimeCheckResult {
  success: boolean;
  provider?: "granite" | "cohere" | string;
  model?: string;
  endpoint?: string;
  status?: "ready" | "reachable" | "model_missing" | "auth_required" | "unreachable" | "invalid";
  statusCode?: number;
  modelFound?: boolean | null;
  message?: string;
  error?: string;
}

export interface ExternalAsrTranscriptionResult {
  success: boolean;
  text?: string;
  provider?: "granite" | "cohere";
  model?: string;
  statusCode?: number;
  message?: string;
  error?: string;
}

export interface GraniteRuntimeStatus {
  installed: boolean;
  working: boolean;
  repairNeeded?: boolean;
  pythonMissing?: boolean;
  runtimePath?: string;
  venvPath?: string;
  serverScriptPath?: string;
  missingModules?: string[];
  message?: string;
  python?: {
    command?: string;
    executable?: string;
    supported?: boolean;
    version?: { major: number; minor: number; micro: number };
  } | null;
}

export interface GraniteModelResult {
  success: boolean;
  model: string;
  downloaded: boolean;
  path?: string;
  size_bytes?: number;
  size_mb?: number;
  runtime?: GraniteRuntimeStatus;
  error?: string;
  code?: string;
  manualDownloadUrl?: string;
  sources?: ModelDownloadSourceInfo[];
}

export interface GraniteModelsListResult {
  success: boolean;
  models: GraniteModelResult[];
  cache_dir: string;
}

export interface GraniteDownloadProgressData {
  type: ManagedModelDownloadProgressType;
  model: string;
  percentage?: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  source_index?: number;
  source_count?: number;
  source_kind?: string;
  manualDownloadUrl?: string;
  sources?: ModelDownloadSourceInfo[];
  error?: string;
  code?: string;
}

export interface GraniteServerStatus {
  available: boolean;
  running: boolean;
  port: number | null;
  endpoint: string;
  model: string | null;
  runtimePath: string;
  modelsDir: string;
}

export interface GraniteTranscriptionResult {
  success: boolean;
  text?: string;
  provider?: "granite";
  model?: string;
  endpoint?: string;
  statusCode?: number;
  message?: string;
  error?: string;
}

export interface ParaformerDiagnosticsResult {
  platform: string;
  arch: string;
  resourcesPath: string | null;
  isPackaged: boolean;
  sherpaOnnx: { available: boolean; path: string | null };
  modelsDir: string;
  models: string[];
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
  modelFileName?: string;
  encoderFileName?: string;
  decoderFileName?: string;
  joinerFileName?: string;
  files?: Array<{
    path: string;
    url: string;
    sizeBytes?: number;
  }>;
  tier: string;
  language: string;
  isDownloaded: boolean;
  modelDir: string;
  default?: boolean;
  recommended?: boolean;
  hidden?: boolean;
  deprecated?: boolean;
  replacedBy?: string;
}

export interface SherpaStreamingModelResult {
  success: boolean;
  model?: string;
  downloaded?: boolean;
  deleted?: boolean;
  path?: string;
  error?: string;
  code?: string;
  manualDownloadUrl?: string;
  sources?: ModelDownloadSourceInfo[];
}

export interface SherpaStreamingModelsListResult {
  success: boolean;
  models: SherpaStreamingModelInfo[];
  error?: string;
}

export interface SherpaStreamingDownloadProgressData {
  type:
    | "source-connect"
    | "source-switch"
    | "progress"
    | "verifying"
    | "installing"
    | "complete"
    | "error";
  model: string;
  modelsDir?: string;
  models_dir?: string;
  percentage?: number;
  downloaded_bytes?: number;
  total_bytes?: number;
  source_index?: number;
  source_count?: number;
  source_kind?: string;
  manualDownloadUrl?: string;
  sources?: ModelDownloadSourceInfo[];
  error?: string;
  code?: string;
}

export interface SherpaStreamingAutoStopPayload {
  reason?: string;
  minSilenceDuration?: number;
  observedSpeech?: boolean;
}

export interface FilePickResult {
  success: boolean;
  path: string | null;
  selectedPath?: string;
  cancelled?: boolean;
  error?: string;
}

export interface ModelStorageRootSaveResult {
  success: boolean;
  root: string;
  effectiveRoot: string;
  migratedServices?: string[];
  cleanupWarnings?: Array<{ service: string; error: string }>;
  error?: string;
  code?: string;
}

export interface EnvironmentSaveResult {
  success: boolean;
  error?: string;
  code?: string;
  value?: string;
  language?: string;
}

export interface MacAccessibilityGuidanceResult {
  platform: string;
  packaged: boolean;
  signed: boolean;
  trustedSignature: boolean;
  shouldRegrantAfterUpdate: boolean;
  reason?: string;
}

export interface MacAppBundleDragInfo {
  platform: string;
  packaged: boolean;
  available: boolean;
  revealAvailable?: boolean;
  appName: string;
  bundlePath?: string;
  reason?: string;
}

export interface MacPrivacyDragHelperOptions {
  title?: string;
  description?: string;
  dragLabel?: string;
  dragHint?: string;
  revealLabel?: string;
  unavailableLabel?: string;
  grantedLabel?: string;
  closeLabel?: string;
  footer?: string;
  /** Which permission to watch so the helper auto-closes once granted. Defaults to accessibility. */
  watchPermission?: "accessibility" | "screenRecording";
}

export interface MacPrivacyDragHelperResult {
  success: boolean;
  available?: boolean;
  error?: string;
}

export interface MacPrivacyPermissionGrantedPayload {
  permission: "accessibility" | "screenRecording";
  granted: boolean;
}

export interface OnboardingDictationSuccessEvent {
  id: string;
  issuedAt: number;
  previewText: string;
  durationMs: number | null;
  recognitionDurationMs?: number | null;
  signature: string;
}

export interface OnboardingResumeState {
  flowVersion?: number;
  currentStep?: number;
  uiLanguage?: string;
  hasCompletedDictationTest?: boolean;
  dictationDurationMs?: number | null;
  recognitionDurationMs?: number | null;
  activationStepSkipped?: boolean;
  activationStatus?: "idle" | "listening" | "processing" | "success";
  completed?: boolean;
  updatedAt?: number;
}

export interface OnboardingAudioLevelPayload {
  level: number;
  active?: boolean;
  micState?: "idle" | "starting" | "recording" | "processing" | "success" | "error" | "hover";
  issuedAt?: number;
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

export type TranscriptionExportFormat = "txt" | "md" | "csv" | "json";

export interface TranscriptionExportPayload {
  format: TranscriptionExportFormat;
  scope?: "items" | "all" | "query";
  items?: TranscriptionItem[];
  query?: {
    query?: string;
    favoriteOnly?: boolean;
    since?: string | null;
  };
}

export interface TranscriptionExportResult extends SettingsFileOperationResult {
  count?: number;
}

export interface CallTraceSession {
  runId: string;
  profileId: DictationProfileId;
  startedAt: string | null;
  updatedAt: string | null;
  sessionStatus: "unknown" | "start" | "success" | "error" | "cancelled";
  transcriptionStatus: "unknown" | "start" | "route" | "fallback" | "success" | "error" | "skipped";
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
  isStale?: boolean;
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
    status?: "start" | "route" | "fallback" | "success" | "error" | "cancelled" | "skipped";
    source?: string;
    transcriptionProvider?: string;
    transcriptionModel?: string;
    reasoningProvider?: string;
    reasoningModel?: string;
    recordingDurationMs?: number;
    occurredAt?: string;
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
  trialServerEnabled?: boolean;
  trialRequiresServerValidation?: boolean;
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
      pasteText: (
        text: string,
        options?: {
          fromStreaming?: boolean;
          suppressAccessibilityDialog?: boolean;
          pasteRequestId?: string;
        }
      ) => Promise<void>;
      cancelPasteText?: (pasteRequestId: string) => Promise<{ cancelled: boolean }>;
      hideWindow: () => Promise<void>;
      showDictationPanel: () => Promise<void>;
      openTranscriptionHistory?: () => Promise<{ success: boolean }>;
      showFileTranscriptionCompletionAlert?: (
        payload: FileTranscriptionCompletionAlertPayload
      ) => Promise<{ success: boolean; message?: string; error?: string; code?: string }>;
      getFileTranscriptionCompletionAlert?: () => Promise<FileTranscriptionCompletionAlertPayload | null>;
      hideFileTranscriptionCompletionAlert?: () => Promise<{ success: boolean }>;
      onFileTranscriptionCompletionAlert?: (
        callback: (payload: FileTranscriptionCompletionAlertPayload) => void
      ) => () => void;
      openControlPanelSection?: (
        section:
          | "account"
          | "general"
          | "hotkeys"
          | "transcription"
          | "fileTranscription"
          | "transcriptionHistory"
          | "dictionary"
          | "aiModels"
          | "callRecords"
          | "agentConfig"
          | "prompts"
          | "permissions"
          | "privacy"
          | "developer"
      ) => Promise<{ success: boolean }>;
      onToggleDictation: (callback: (payload?: DictationHotkeyPayload) => void) => () => void;
      onStartDictation?: (callback: (payload?: DictationHotkeyPayload) => void) => () => void;
      onStopDictation?: (callback: (payload?: DictationHotkeyPayload) => void) => () => void;
      onPrepareDictationUi?: (
        callback: (payload?: DictationUiPreparationPayload) => void
      ) => () => void;
      notifyDictationUiReady?: (payload: DictationUiReadyPayload) => void;
      onOpenSettingsSection?: (callback: (payload: { section?: string }) => void) => () => void;
      onOpenTranscriptionHistory?: (callback: () => void) => () => void;

      // Native Liquid Glass
      getNativeGlassCapability?: () => Promise<{
        supported: boolean;
        method: "liquid-glass" | "vibrancy" | "css-only";
        macOSVersion: number;
      }>;
      onNativeGlassCapability?: (callback: (payload: { method: string }) => void) => () => void;

      // Database operations
      saveTranscription: (
        text: string,
        metadata?: {
          unitCount?: number;
          recordingDurationMs?: number | null;
          excludeFromStats?: boolean;
          estimatedTypingDurationMs?: number | null;
        }
      ) => Promise<{ id: number; success: boolean; transcription?: TranscriptionItem }>;
      getTranscriptions: (limit?: number) => Promise<TranscriptionItem[]>;
      searchTranscriptions: (
        query: string,
        limit?: number
      ) => Promise<{ items: TranscriptionItem[]; truncated: boolean }>;
      queryTranscriptionHistory: (options?: {
        requestKey?: string;
        query?: string;
        limit?: number;
        offset?: number;
        cursor?: string | null;
        favoriteOnly?: boolean;
        since?: string | null;
      }) => Promise<{
        items: TranscriptionItem[];
        hasMore: boolean;
        totalCount: number | null;
        nextCursor?: string | null;
        truncated: boolean;
        cancelled?: boolean;
        error?: string;
      }>;
      getTranscriptionStats: () => Promise<TranscriptionStats>;
      clearTranscriptions: () => Promise<{ cleared: number; success: boolean }>;
      deleteTranscription: (id: number) => Promise<{ success: boolean }>;
      setTranscriptionFavorite: (id: number, favorite: boolean) => Promise<{ success: boolean }>;

      // Dictionary operations
      getDictionary: () => Promise<string[]>;
      setDictionary: (words: string[]) => Promise<{ success: boolean }>;
      trackOnboardingEvent: (eventName: string) => Promise<{ success: boolean; error?: string }>;
      getOnboardingEvents: () => Promise<
        Array<{ id: number; event_name: string; timestamp: string }>
      >;

      // Database event listeners
      onTranscriptionAdded?: (callback: (item: TranscriptionItem) => void) => () => void;
      onTranscriptionDeleted?: (callback: (payload: { id: number }) => void) => () => void;
      onTranscriptionUpdated?: (
        callback: (payload: { id: number; patch: Partial<TranscriptionItem> }) => void
      ) => () => void;
      onTranscriptionsCleared?: (callback: (payload: { cleared: number }) => void) => () => void;

      // API key management
      getOpenAIKey: (options?: KeychainAccessOptions) => Promise<string>;
      saveOpenAIKey: (key: string) => Promise<EnvironmentSaveResult>;
      createProductionEnvFile: (key: string) => Promise<EnvironmentSaveResult>;
      getAnthropicKey: (options?: KeychainAccessOptions) => Promise<string | null>;
      saveAnthropicKey: (key: string) => Promise<EnvironmentSaveResult>;
      getOpenRouterKey: (options?: KeychainAccessOptions) => Promise<string | null>;
      saveOpenRouterKey: (key: string) => Promise<EnvironmentSaveResult>;
      getUiLanguage: () => Promise<string>;
      getInitialUiLanguage: () => string;
      saveUiLanguage: (language: string) => Promise<EnvironmentSaveResult>;
      setUiLanguage: (language: string) => Promise<EnvironmentSaveResult>;
      getModelStorageRoot?: () => Promise<string>;
      saveModelStorageRoot?: (rootPath: string) => Promise<ModelStorageRootSaveResult>;
      onModelStorageMigrationProgress?: (
        callback: (progress: {
          phase: string;
          service: string;
          completed: number;
          total: number;
        }) => void
      ) => () => void;
      pickModelStorageRoot?: (defaultPath?: string) => Promise<FilePickResult>;
      reportTranscriptionSettings?: (payload: {
        localTranscriptionProvider?: string;
        whisperModel?: string;
        parakeetModel?: string;
        paraformerModel?: string;
        graniteModel?: string;
        cohereModel?: string;
      }) => void;
      saveAllKeysToEnv: () => Promise<{ success: boolean; path: string }>;
      importEnvironmentSettings: (values: Record<string, string>) => Promise<{
        success: boolean;
        imported?: number;
        error?: string;
      }>;
      syncStartupPreferences: (prefs: {
        useLocalWhisper: boolean;
        localTranscriptionProvider: LocalTranscriptionProvider;
        model?: string;
        externalRuntimeUrl?: string;
        reasoningProvider: string;
        reasoningModel?: string;
      }) => Promise<void>;
      exportSettingsFile: (payload: any) => Promise<SettingsFileOperationResult>;
      importSettingsFile: () => Promise<SettingsImportResult>;
      exportTranscriptionHistory: (
        payload: TranscriptionExportPayload
      ) => Promise<TranscriptionExportResult>;
      showItemInFolder?: (filePath: string) => Promise<{ success: boolean; error?: string }>;
      getMacAppBundleDragInfo?: () => Promise<MacAppBundleDragInfo>;
      showMacPrivacyDragHelper?: (
        options?: MacPrivacyDragHelperOptions
      ) => Promise<MacPrivacyDragHelperResult>;
      hideMacPrivacyDragHelper?: () => Promise<{ success: boolean; error?: string }>;
      startMacAppBundleDrag?: () => void;
      revealMacAppBundle?: () => Promise<{ success: boolean; path?: string; error?: string }>;
      getFrontmostApp?: () => Promise<{ appName: string; bundleId: string } | null>;
      onMacPrivacyPermissionGranted?: (
        callback: (payload: MacPrivacyPermissionGrantedPayload) => void
      ) => () => void;

      // Clipboard operations
      readClipboard: () => Promise<string>;
      writeClipboard: (text: string) => Promise<{ success: boolean }>;
      checkPasteTools: () => Promise<PasteToolsResult>;
      checkAccessibilityPermission: () => Promise<boolean>;
      requestAccessibilityPermission?: () => Promise<{ granted: boolean; error?: string }>;

      // Context-aware refinement
      captureContext?: (options?: {
        textEnabled?: boolean;
        visionEnabled?: boolean;
      }) => Promise<ContextCaptureResult>;
      checkContextPermissions?: () => Promise<ContextPermissions>;
      testVisionCapability?: (options?: {
        provider?: string;
        model?: string;
        baseUrl?: string;
        apiKey?: string;
      }) => Promise<VisionCapabilityResult>;
      getSensitiveApps?: () => Promise<SensitiveAppConfig>;
      pickSensitiveApps?: (options?: { title?: string }) => Promise<SensitiveAppPickResult>;
      setSensitiveApps?: (
        config: SensitiveAppConfig
      ) => Promise<{ success: boolean; error?: string }>;
      requestScreenRecordingPermission?: () => Promise<{ granted: boolean; error?: string }>;
      openScreenRecordingSettings?: () => Promise<{ success: boolean; error?: string }>;
      getContextSettings?: () => Promise<ContextSettings>;
      setContextSettings?: (settings: {
        textEnabled?: boolean;
        visionEnabled?: boolean;
      }) => Promise<{ success: boolean; error?: string }>;
      setContextEnabled?: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
      openAccessibilitySettings?: () => Promise<{ success: boolean; error?: string }>;
      getOnboardingState?: () => Promise<OnboardingResumeState | null>;
      saveOnboardingState?: (patch: OnboardingResumeState) => Promise<OnboardingResumeState>;
      clearOnboardingState?: () => Promise<{ success: boolean }>;
      emitOnboardingDictationSuccess?: (payload: {
        text?: string;
        durationMs?: number | null;
        recognitionDurationMs?: number | null;
      }) => Promise<{ success: boolean; event?: OnboardingDictationSuccessEvent }>;
      consumeOnboardingDictationSuccess?: () => Promise<OnboardingDictationSuccessEvent | null>;
      onOnboardingDictationSuccess?: (
        callback: (event: any, data: OnboardingDictationSuccessEvent) => void
      ) => () => void;
      pushOnboardingAudioLevel?: (payload: OnboardingAudioLevelPayload) => void;
      onOnboardingAudioLevel?: (
        callback: (event: any, data: OnboardingAudioLevelPayload) => void
      ) => () => void;

      // Audio
      onNoAudioDetected: (callback: (event: any, data?: any) => void) => () => void;

      // Whisper operations (whisper.cpp)
      transcribeLocalWhisper: (audioBlob: Blob | ArrayBuffer, options?: any) => Promise<any>;
      transcribeLocalWhisperFile?: (
        file: File,
        options?: {
          model?: string;
          modelPath?: string;
          language?: string;
          initialPrompt?: string;
          operationId?: string | null;
          sourceFileName?: string | null;
          mimeType?: string | null;
        }
      ) => Promise<any>;
      checkWhisperInstallation: () => Promise<WhisperCheckResult>;
      downloadWhisperModel: (
        modelName: string,
        options?: { uiLanguage?: string; locale?: string }
      ) => Promise<WhisperModelResult>;
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
      cancelFileTranscription?: (operationId: string) => Promise<{
        success: boolean;
        provider?: string;
        message?: string;
        error?: string;
      }>;
      acquireTranscriptionLease?: (payload: {
        leaseId: string;
        kind: "batch" | "file" | "local-streaming" | "cloud-streaming";
      }) => Promise<{
        success: boolean;
        acquired?: boolean;
        leaseId?: string;
        code?: string;
        error?: string;
        activeKind?: string;
        startedAt?: number;
      }>;
      releaseTranscriptionLease?: (leaseId: string) => Promise<{
        success: boolean;
        released?: boolean;
        code?: string;
        error?: string;
      }>;

      // Parakeet operations (NVIDIA via sherpa-onnx)
      transcribeLocalParakeet: (
        audioBlob: ArrayBuffer,
        options?: {
          model?: string;
          modelPath?: string;
          language?: string;
          operationId?: string | null;
        }
      ) => Promise<ParakeetTranscriptionResult>;
      transcribeLocalParakeetFile?: (
        file: File,
        options?: {
          model?: string;
          modelPath?: string;
          language?: string;
          operationId?: string | null;
          sourceFileName?: string | null;
          mimeType?: string | null;
        }
      ) => Promise<ParakeetTranscriptionResult>;
      checkParakeetInstallation: () => Promise<ParakeetCheckResult>;
      downloadParakeetModel: (
        modelName: string,
        options?: { uiLanguage?: string; locale?: string; modelsDir?: string }
      ) => Promise<ParakeetModelResult>;
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

      // Paraformer operations (sherpa-onnx)
      transcribeLocalParaformer: (
        audioBlob: ArrayBuffer,
        options?: {
          model?: string;
          modelPath?: string;
          language?: string;
          operationId?: string | null;
        }
      ) => Promise<ParaformerTranscriptionResult>;
      transcribeLocalParaformerFile?: (
        file: File,
        options?: {
          model?: string;
          modelPath?: string;
          language?: string;
          operationId?: string | null;
          sourceFileName?: string | null;
          mimeType?: string | null;
        }
      ) => Promise<ParaformerTranscriptionResult>;
      transcribeExternalAsr: (
        audioBlob: ArrayBuffer,
        options: ExternalAsrTranscriptionOptions
      ) => Promise<ExternalAsrTranscriptionResult>;
      transcribeExternalAsrFile?: (
        file: File,
        options: ExternalAsrTranscriptionOptions & {
          sourceFileName?: string | null;
          mimeType?: string | null;
        }
      ) => Promise<ExternalAsrTranscriptionResult>;
      checkExternalAsrRuntime: (
        options: ExternalAsrRuntimeCheckOptions
      ) => Promise<ExternalAsrRuntimeCheckResult>;
      transcribeLocalGranite: (
        audioBlob: ArrayBuffer,
        options?: {
          model?: string;
          language?: string;
          prompt?: string;
          operationId?: string | null;
        }
      ) => Promise<GraniteTranscriptionResult>;
      transcribeLocalGraniteFile?: (
        file: File,
        options?: {
          model?: string;
          language?: string;
          prompt?: string;
          operationId?: string | null;
          sourceFileName?: string | null;
          mimeType?: string | null;
        }
      ) => Promise<GraniteTranscriptionResult>;
      checkGraniteRuntime: () => Promise<GraniteRuntimeStatus>;
      installGraniteRuntime: (options?: { uiLanguage?: string; locale?: string }) => Promise<{
        success: boolean;
        error?: string;
        code?: string;
        manualDownloadUrl?: string;
        sources?: ModelDownloadSourceInfo[];
      }>;
      downloadGraniteModel: (
        modelName: string,
        options?: { uiLanguage?: string; locale?: string }
      ) => Promise<GraniteModelResult>;
      onGraniteDownloadProgress: (
        callback: (event: any, data: GraniteDownloadProgressData) => void
      ) => () => void;
      checkGraniteModelStatus: (modelName: string) => Promise<GraniteModelResult>;
      listGraniteModels: () => Promise<GraniteModelsListResult>;
      deleteGraniteModel: (modelName: string) => Promise<{
        success: boolean;
        model: string;
        deleted: boolean;
        freed_bytes?: number;
        freed_mb?: number;
        error?: string;
      }>;
      deleteAllGraniteModels: () => Promise<{
        success: boolean;
        deleted_count?: number;
        freed_bytes?: number;
        error?: string;
      }>;
      deletePunctuationModels: () => Promise<{ success: boolean; error?: string }>;
      cancelGraniteDownload: () => Promise<{ success: boolean; message?: string; error?: string }>;
      getGraniteDiagnostics: () => Promise<any>;
      graniteServerStart: (
        modelName: string
      ) => Promise<{ success: boolean; port?: number; endpoint?: string; model?: string }>;
      graniteServerStop: () => Promise<{ success: boolean }>;
      graniteServerStatus: () => Promise<GraniteServerStatus>;
      checkParaformerInstallation: () => Promise<ParaformerCheckResult>;
      downloadParaformerModel: (
        modelName: string,
        options?: { uiLanguage?: string; locale?: string; modelsDir?: string }
      ) => Promise<ParaformerModelResult>;
      onParaformerDownloadProgress: (
        callback: (event: any, data: ParaformerDownloadProgressData) => void
      ) => () => void;
      checkParaformerModelStatus: (modelName: string) => Promise<ParaformerModelResult>;
      listParaformerModels: () => Promise<ParaformerModelsListResult>;
      deleteParaformerModel: (modelName: string) => Promise<ParaformerModelDeleteResult>;
      deleteAllParaformerModels: () => Promise<{
        success: boolean;
        deleted_count?: number;
        freed_bytes?: number;
        freed_mb?: number;
        error?: string;
      }>;
      cancelParaformerDownload: () => Promise<{
        success: boolean;
        message?: string;
        error?: string;
      }>;
      getParaformerDiagnostics: () => Promise<ParaformerDiagnosticsResult>;

      pickWhisperModelFile: (defaultPath?: string) => Promise<FilePickResult>;
      pickParakeetModelDirectory: (defaultPath?: string) => Promise<FilePickResult>;
      pickParaformerModelDirectory: (defaultPath?: string) => Promise<FilePickResult>;
      pickStreamingModelDirectory: (defaultPath?: string) => Promise<FilePickResult>;

      // Local AI model management
      modelGetAll: () => Promise<any[]>;
      modelCheck: (modelId: string) => Promise<boolean>;
      modelDownload: (modelId: string) => Promise<{
        success: boolean;
        path?: string;
        error?: string;
        code?: string;
        manualDownloadUrl?: string;
        sources?: ModelDownloadSourceInfo[];
      }>;
      modelDelete: (modelId: string) => Promise<{
        success: boolean;
        error?: string;
        code?: string;
      }>;
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
      setMainWindowInteractivity: (
        interactive: boolean,
        options?: { focus?: boolean }
      ) => Promise<void>;
      resizeMainWindow?: (sizeKeyOrSize: string | DictationWindowSize) => Promise<{
        success: boolean;
        bounds?: DictationWindowSize & { x: number; y: number };
        message?: string;
      }>;
      toggleCommandMenu: (state?: {
        isRecording?: boolean;
        isStarting?: boolean;
        canStop?: boolean;
      }) => Promise<{ success: boolean; isVisible?: boolean; message?: string }>;
      hideCommandMenu: () => Promise<{ success: boolean }>;
      commandMenuStart: () => Promise<{ success: boolean }>;
      commandMenuStop: () => Promise<{ success: boolean }>;
      commandMenuHidePanel: () => Promise<{ success: boolean }>;
      updateCommandMenuState: (state?: {
        isRecording?: boolean;
        isStarting?: boolean;
        canStop?: boolean;
      }) => Promise<{ success: boolean }>;
      onCommandMenuState: (
        callback: (data: {
          isVisible: boolean;
          isRecording: boolean;
          isStarting: boolean;
          canStop: boolean;
        }) => void
      ) => () => void;
      onCommandMenuVisibilityChanged: (
        callback: (data: { isVisible: boolean }) => void
      ) => () => void;

      // App management
      appQuit: () => Promise<void>;
      cleanupApp: () => Promise<{
        success: boolean;
        message: string;
        errors?: Array<{ step: string; error: string }>;
        requiresRestart?: boolean;
      }>;
      restartApp: () => Promise<{ success: boolean; error?: string }>;

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

      openExternal: (
        url: string,
        options?: { showError?: boolean }
      ) => Promise<{ success: boolean; error?: string }>;

      // Hotkey management
      updateHotkey: (key: string) => Promise<{ success: boolean; message: string }>;
      updateSecondaryHotkey?: (
        key: string
      ) => Promise<{ success: boolean; message: string; code?: string }>;
      syncHotkeyWorkflows?: (
        workflows: Array<{ id: string; hotkey: string; enabled?: boolean }>
      ) => Promise<{
        success: boolean;
        message: string;
        code?: string;
        registered?: Array<{ id: string; hotkey: string }>;
      }>;
      checkHotkeyAvailability?: (key: string) => Promise<{
        available: boolean;
        reason:
          | "free"
          | "owned_by_app"
          | "in_use_by_other_app"
          | "native_listener"
          | "invalid"
          | "error";
        ownedByApp: boolean;
      }>;
      setHotkeyListeningMode?: (
        enabled: boolean,
        newHotkey?: string | null,
        scope?: string
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
      onWindowsPushToTalkUnavailable?: (
        callback: (data: { reason: string; message: string }) => void
      ) => () => void;

      // Gemini API key management
      getGeminiKey: (options?: KeychainAccessOptions) => Promise<string | null>;
      saveGeminiKey: (key: string) => Promise<EnvironmentSaveResult>;

      // Groq API key management
      getGroqKey: (options?: KeychainAccessOptions) => Promise<string | null>;
      saveGroqKey: (key: string) => Promise<EnvironmentSaveResult>;

      // Cerebras API key management
      getCerebrasKey: (options?: KeychainAccessOptions) => Promise<string | null>;
      saveCerebrasKey: (key: string) => Promise<EnvironmentSaveResult>;
      testCloudTranscriptionConnection: (data?: {
        provider?: string;
        apiKey?: string;
        model?: string;
        endpoint?: string;
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

      // Soniox ASR credential management
      getSonioxKey: (options?: KeychainAccessOptions) => Promise<string | null>;
      saveSonioxKey: (key: string) => Promise<EnvironmentSaveResult>;
      testSonioxConnection: (data?: {
        apiKey?: string;
        model?: string;
        language?: string;
      }) => Promise<{
        success: boolean;
        resolvedModelId?: string;
        clientReferenceId?: string;
        error?: string;
        code?: string;
        message?: string;
      }>;
      proxySonioxTranscription: (data: {
        audioBuffer: ArrayBuffer;
        model?: string;
        language?: string;
        apiKey?: string;
      }) => Promise<{ text: string; clientReferenceId?: string; model?: string }>;
      proxySonioxTranscriptionFile?: (
        file: File,
        options?: {
          model?: string;
          language?: string;
          apiKey?: string;
          sourceFileName?: string | null;
          mimeType?: string | null;
        }
      ) => Promise<{ text: string; clientReferenceId?: string; model?: string }>;

      // Deepgram ASR credential management
      getDeepgramKey: (options?: KeychainAccessOptions) => Promise<string | null>;
      saveDeepgramKey: (key: string) => Promise<EnvironmentSaveResult>;
      testDeepgramConnection: (data?: {
        apiKey?: string;
        endpoint?: string;
        model?: string;
        language?: string;
      }) => Promise<{
        success: boolean;
        resolvedModelId?: string;
        requestId?: string | null;
        error?: string;
        code?: string;
        message?: string;
      }>;
      proxyDeepgramTranscription: (data: {
        audioBuffer: ArrayBuffer;
        endpoint?: string;
        model?: string;
        language?: string;
        apiKey?: string;
        mimeType?: string;
      }) => Promise<{
        text: string;
        requestId?: string | null;
        requestIds?: string[];
        model?: string;
        chunkCount?: number;
        transcribedChunks?: number;
        emptyChunks?: Array<{
          index: number;
          startSec?: number;
          durationSec?: number;
          requestIds?: string[];
          attempts?: Array<{
            language?: string;
            reason?: string;
            requestId?: string | null;
          }>;
        }>;
        detectedLanguage?: string | null;
      }>;
      proxyDeepgramTranscriptionFile?: (
        file: File,
        options?: {
          endpoint?: string;
          model?: string;
          language?: string;
          apiKey?: string;
          mimeType?: string;
          sourceFileName?: string | null;
        }
      ) => Promise<{
        text: string;
        requestId?: string | null;
        requestIds?: string[];
        model?: string;
        chunkCount?: number;
        transcribedChunks?: number;
        emptyChunks?: Array<{
          index: number;
          startSec?: number;
          durationSec?: number;
          requestIds?: string[];
          attempts?: Array<{
            language?: string;
            reason?: string;
            requestId?: string | null;
          }>;
        }>;
        detectedLanguage?: string | null;
      }>;
      onDeepgramBatchProgress?: (
        callback: (data: {
          type: "chunk-plan" | "chunk-complete";
          chunkCount?: number;
          durationSec?: number;
          chunkDurationSec?: number;
          chunkIndex?: number;
          completedChunks?: number;
          chunkStartSec?: number;
          languageAttempt?: number;
          languageAttemptCount?: number;
          languageFallbackReason?: string;
          hasText?: boolean;
        }) => void
      ) => () => void;

      // Google Cloud Speech-to-Text credential management
      getGoogleSttKey: (options?: KeychainAccessOptions) => Promise<string | null>;
      saveGoogleSttKey: (key: string) => Promise<EnvironmentSaveResult>;
      testGoogleCloudSttConnection: (data?: {
        endpoint?: string;
        credential?: string;
        apiKey?: string;
        model?: string;
        language?: string;
      }) => Promise<{
        success: boolean;
        resolvedModelId?: string;
        error?: string;
        code?: string;
        message?: string;
      }>;
      proxyGoogleCloudSttTranscription: (data: {
        audioBuffer: ArrayBuffer;
        endpoint?: string;
        model?: string;
        language?: string;
        credential?: string;
      }) => Promise<{ text: string; model?: string }>;
      proxyGoogleCloudSttTranscriptionFile?: (
        file: File,
        options?: {
          endpoint?: string;
          model?: string;
          language?: string;
          credential?: string;
          sourceFileName?: string | null;
          mimeType?: string | null;
        }
      ) => Promise<{ text: string; model?: string }>;

      // Doubao ASR credential management
      getDoubaoAppId: () => Promise<string | null>;
      saveDoubaoAppId: (appId: string) => Promise<EnvironmentSaveResult>;
      getDoubaoAccessToken: (options?: KeychainAccessOptions) => Promise<string | null>;
      saveDoubaoAccessToken: (token: string) => Promise<EnvironmentSaveResult>;
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
      proxyDoubaoTranscriptionFile?: (
        file: File,
        options?: {
          model?: string;
          language?: string;
          appId?: string;
          accessToken?: string;
          sourceFileName?: string | null;
          mimeType?: string | null;
        }
      ) => Promise<{ text: string; logId?: string | null; resourceId?: string }>;

      // Custom endpoint API keys
      getCustomTranscriptionKey?: (options?: KeychainAccessOptions) => Promise<string | null>;
      saveCustomTranscriptionKey?: (key: string) => Promise<EnvironmentSaveResult>;
      getCustomReasoningKey?: (options?: KeychainAccessOptions) => Promise<string | null>;
      saveCustomReasoningKey?: (key: string) => Promise<EnvironmentSaveResult>;
      getGraniteRuntimeApiKey?: (options?: KeychainAccessOptions) => Promise<string | null>;
      saveGraniteRuntimeApiKey?: (key: string) => Promise<{ success: boolean; error?: string }>;
      getCohereRuntimeApiKey?: (options?: KeychainAccessOptions) => Promise<string | null>;
      saveCohereRuntimeApiKey?: (key: string) => Promise<{ success: boolean; error?: string }>;
      getBedrockCredentials?: (options?: KeychainAccessOptions) => Promise<{
        bedrockAccessKeyId: string;
        bedrockSecretAccessKey: string;
        bedrockSessionToken: string;
      }>;
      saveBedrockCredential?: (
        key: "bedrockAccessKeyId" | "bedrockSecretAccessKey" | "bedrockSessionToken",
        value: string
      ) => Promise<{ success: boolean; error?: string }>;
      proxyReasoningRequest?: (payload: {
        requestId?: string;
        url: string;
        method?: "GET" | "POST";
        headers?: Record<string, string>;
        body?: string;
        stream?: boolean;
      }) => Promise<{
        success: boolean;
        status?: number;
        statusText?: string;
        headers?: Record<string, string>;
        body?: string;
        error?: string;
        message?: string;
        code?: string;
      }>;
      cancelReasoningProxyRequest?: (payload: {
        requestId: string;
      }) => Promise<{ success: boolean; error?: string }>;
      onReasoningProxyChunk?: (
        callback: (payload: { requestId?: string; chunk?: string }) => void
      ) => () => void;
      getLicenseApiBaseUrl?: () => Promise<string | null>;
      saveLicenseApiBaseUrl?: (url: string) => Promise<EnvironmentSaveResult>;
      licenseGetStatus?: (options?: KeychainAccessOptions) => Promise<LicenseStatusResult>;
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
      saveDictationKey?: (key: string) => Promise<EnvironmentSaveResult>;
      onSecondaryHotkeyLocked?: (
        callback: (payload?: { profileId?: DictationProfileId }) => void
      ) => () => void;

      // Activation mode persistence (file-based for reliable startup)
      getActivationMode?: () => Promise<"tap" | "push">;
      saveActivationMode?: (mode: "tap" | "push") => Promise<EnvironmentSaveResult>;

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
      getMicrophoneAccessStatus?: () => Promise<{
        status: "granted" | "denied" | "restricted" | "not-determined" | "unknown";
      }>;
      openMicrophoneSettings?: () => Promise<{ success: boolean; error?: string }>;
      openSoundInputSettings?: () => Promise<{ success: boolean; error?: string }>;
      getMacAccessibilityGuidance?: () => Promise<MacAccessibilityGuidanceResult>;
      openModelCacheFolder?: (rootPath?: string) => Promise<{ success: boolean; error?: string }>;

      // Windows Push-to-Talk notifications
      notifyActivationModeChanged?: (mode: "tap" | "push") => void;
      notifyHotkeyChanged?: (hotkey: string, profileId?: DictationProfileId) => void;
      notifyMacNativeHotkeyEligibilityChanged?: (eligible: boolean) => void;
      notifyLocalStorageChanged?: (key: string) => void;
      onLocalStorageChanged?: (callback: (payload: { key?: string }) => void) => () => void;
      notifyDictationCueStyleChanged?: (
        style: "off" | "electronic" | "droplet1" | "droplet2"
      ) => void;
      onDictationCueStyleChanged?: (
        callback: (style: "off" | "electronic" | "droplet1" | "droplet2") => void
      ) => () => void;
      notifyRecordingAnimationStyleChanged?: (style: "flow" | "stardust" | "nebula") => void;
      onRecordingAnimationStyleChanged?: (
        callback: (style: "flow" | "stardust" | "nebula" | "planet") => void
      ) => () => void;
      onSystemSuspend?: (callback: (payload?: { suspendedAt?: number }) => void) => () => void;
      onSystemResumeRecovering?: (
        callback: (payload?: { resumedAt?: number }) => void
      ) => () => void;
      onSystemResumed?: (
        callback: (payload?: { recoveredAt?: number; degraded?: boolean }) => void
      ) => () => void;
      onAppShuttingDown?: (callback: (payload?: { reason?: string }) => void) => () => void;

      // Auto-start at login
      getAutoStartEnabled?: () => Promise<boolean>;
      setAutoStartEnabled?: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;

      // macOS menu bar icon
      getTrayIconEnabled?: () => Promise<boolean>;
      setTrayIconEnabled?: (
        enabled: boolean
      ) => Promise<{ success: boolean; enabled?: boolean; error?: string }>;

      // Auto-check update management
      getAutoCheckUpdate?: () => Promise<boolean>;
      setAutoCheckUpdate?: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;

      // Auth
      authClearSession?: () => Promise<void>;
      authBridgeCreateState?: () => Promise<string>;

      // ChordVox Cloud API
      cloudTranscribe?: (
        audioBuffer: ArrayBuffer,
        opts: { language?: string; prompt?: string; operationId?: string | null }
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
          disableThinking?: boolean;
          temperature?: number;
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
        modelsDir?: string,
        options?: { uiLanguage?: string; locale?: string }
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
        audioBlob: Blob | File | ArrayBuffer,
        options?: {
          modelId?: string;
          modelsDir?: string;
          operationId?: string | null;
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
      sherpaStreamingWarmup?: (options?: {
        modelId?: string;
        modelsDir?: string;
        uiLanguage?: string;
        locale?: string;
      }) => Promise<{
        success: boolean;
        modelId?: string;
        alreadyWarm?: boolean;
        inProgress?: boolean;
        skipped?: boolean;
        reason?: string;
        warmupMs?: number;
        error?: string;
      }>;
      sherpaStreamingStart?: (options?: {
        modelId?: string;
        modelsDir?: string;
        uiLanguage?: string;
        locale?: string;
      }) => Promise<{
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
        currentDownloadModelId?: string | null;
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
      getSentryDsn?: () => Promise<string | null>;
      reportTelemetrySettings?: (enabled: boolean) => void;
    };

    api?: {
      sendDebugLog: (message: string) => void;
    };
  }
}

// ─── Context-Aware Refinement Types ────────────────────────────────────────────

export type ContextFallbackReason =
  | "disabled"
  | "permission-denied"
  | "sensitive-app"
  | "capture-timeout"
  | "vision-not-supported"
  | "vision-timeout"
  | "vision-error";

export interface ContextCaptureResult {
  appName?: string;
  windowTitle?: string;
  visibleText?: string;

  screenshotBase64?: string;
  screenshotMimeType?: "image/png" | "image/jpeg" | "image/webp";

  accessibilityMs?: number;
  screenshotMs?: number;
  visionMs?: number;
  totalMs?: number;

  layer1Success: boolean;
  layer2Success: boolean;

  fallbackReason?: ContextFallbackReason;
}

export interface ContextPermissions {
  accessibility: boolean;
  screenRecording: boolean;
  platform: string;
}

export interface VisionCapabilityResult {
  supported: boolean;
  provider: string;
  model: string;
  testedAt?: string;
  expiresAt?: string;
  error?: string;
}

export interface SensitiveAppConfig {
  bundleIds: string[];
  processNames: string[];
  selectedApps?: SensitiveAppSelection[];
}

export interface SensitiveAppSelection {
  appName: string;
  bundleId: string;
}

export interface SensitiveAppPickResult {
  success: boolean;
  cancelled?: boolean;
  apps?: SensitiveAppSelection[];
  error?: string;
}

export interface ContextSettings {
  enabled: boolean;
  textEnabled: boolean;
  visionEnabled: boolean;
  sensitiveApps: SensitiveAppConfig;
}
