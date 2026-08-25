import { useState, useEffect, useCallback, useMemo, useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Download,
  Trash2,
  X,
  Loader2,
  AudioWaveform,
  Cpu,
  Sparkles,
  Cloud,
  Lock,
  Settings2,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { ProviderIcon } from "./ui/ProviderIcon";
import { ProviderTabs } from "./ui/ProviderTabs";
import ModelCardList from "./ui/ModelCardList";
import { DownloadProgressBar } from "./ui/DownloadProgressBar";
import ApiKeyInput from "./ui/ApiKeyInput";
import { ConfirmDialog } from "./ui/dialog";
import { useDialogs } from "../hooks/useDialogs";
import { useModelDownload } from "../hooks/useModelDownload";
import {
  getTranscriptionProviders,
  TranscriptionProviderData,
  WHISPER_MODEL_INFO,
  PARAKEET_MODEL_INFO,
  PARAFORMER_MODEL_INFO,
  GRANITE_MODEL_INFO,
  COHERE_MODEL_INFO,
} from "../models/ModelRegistry";
import {
  MODEL_PICKER_COLORS,
  type ColorScheme,
  type ModelPickerStyles,
} from "../utils/modelPickerStyles";
import { getProviderIcon, isMonochromeProvider } from "../utils/providerIcons";
import { API_ENDPOINTS, normalizeBaseUrl } from "../config/constants";
import { createExternalLinkHandler } from "../utils/externalLinks";
import { getProviderGuideUrl } from "../utils/providerGuideLinks";
import { addChordVoxModelsClearedListener } from "../utils/chordvoxCloud";
import { DEFAULT_ENGLISH_PARAKEET_MODEL_ID } from "../utils/defaultTranscriptionModel";
import { markDeletedModelUnavailable, type ModelDownloadState } from "../utils/modelDeletionState";

type LocalModel = ModelDownloadState;

interface LocalModelCardProps {
  modelId: string;
  name: string;
  description: string;
  size: string;
  actualSizeMb?: number;
  isSelected: boolean;
  isDownloaded: boolean;
  isDownloading: boolean;
  isCancelling: boolean;
  downloadDisabled?: boolean;
  downloadDisabledTitle?: string;
  idleActionLabel?: string;
  idleActionIcon?: LucideIcon;
  showDelete?: boolean;
  recommended?: boolean;
  provider: string;
  languageLabel?: string;
  modelTag?: string;
  onSelect: () => void;
  onDelete: () => void;
  onDownload: () => void;
  onCancel: () => void;
  styles: ModelPickerStyles;
}

function LocalModelCard({
  modelId,
  name,
  description,
  size,
  actualSizeMb,
  isSelected,
  isDownloaded,
  isDownloading,
  isCancelling,
  downloadDisabled = false,
  downloadDisabledTitle,
  idleActionLabel,
  idleActionIcon: IdleActionIcon = Download,
  showDelete = true,
  recommended,
  provider,
  languageLabel,
  modelTag,
  onSelect,
  onDelete,
  onDownload,
  onCancel,
  styles: cardStyles,
}: LocalModelCardProps) {
  const { t } = useTranslation();
  const isUsable = isDownloaded && !downloadDisabled;
  const canSelect = isUsable && !isSelected;

  const handleClick = () => {
    if (canSelect) {
      onSelect();
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!canSelect || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    onSelect();
  };

  return (
    <div
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role={canSelect ? "button" : undefined}
      tabIndex={canSelect ? 0 : undefined}
      aria-label={canSelect ? name : undefined}
      className={`relative w-full text-left overflow-hidden rounded-md border transition-[background-color,border-color,box-shadow,color,transform] duration-200 group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
        isSelected ? cardStyles.modelCard.selected : cardStyles.modelCard.default
      } ${canSelect ? "cursor-pointer" : ""}`}
    >
      {isSelected && (
        <div className="absolute left-0 top-0 bottom-0 w-1 bg-linear-to-b from-primary via-primary to-primary/80 rounded-l-md" />
      )}
      <div className="flex items-center gap-1.5 p-2 pl-2.5">
        <div className="shrink-0">
          {isUsable ? (
            <div
              className={`w-1.5 h-1.5 rounded-full ${isSelected ? "bg-primary" : "bg-success"}`}
            />
          ) : isDownloading ? (
            <div className="w-1.5 h-1.5 rounded-full bg-warning animate-[spinner-rotate_1s_linear_infinite]" />
          ) : (
            <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/25" />
          )}
        </div>

        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          {provider === "granite" ? (
            <Cpu className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
          ) : provider === "cohere" ? (
            <Sparkles className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
          ) : provider === "paraformer" ? (
            <AudioWaveform className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ProviderIcon provider={provider} className="w-3.5 h-3.5 shrink-0" />
          )}
          <span className="font-semibold text-sm text-foreground truncate tracking-tight">
            {name}
          </span>
          <span className="text-[11px] text-muted-foreground/50 tabular-nums shrink-0">
            {actualSizeMb ? `${actualSizeMb}MB` : size}
          </span>
          {modelTag && (
            <span
              title={modelTag}
              className="glass-chip max-w-[12rem] truncate rounded-sm px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground shrink-0"
            >
              {modelTag}
            </span>
          )}
          {recommended && (
            <span className={cardStyles.badges.recommended}>{t("common.recommended")}</span>
          )}
          {languageLabel && (
            <span className="text-[11px] text-muted-foreground/50 font-medium shrink-0">
              {languageLabel}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {isUsable ? (
            <>
              {isSelected && (
                <span className="glass-chip glass-chip--accent rounded-sm px-2 py-0.5 text-[10px] font-medium text-primary">
                  {t("common.active")}
                </span>
              )}
              {showDelete ? (
                <Button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete();
                  }}
                  aria-label={`${t("common.delete")}: ${name}`}
                  title={`${t("common.delete")}: ${name}`}
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0 text-muted-foreground/40 hover:text-destructive opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-[background-color,color,opacity,transform] active:scale-95"
                >
                  <Trash2 size={12} aria-hidden="true" />
                </Button>
              ) : null}
            </>
          ) : isDownloading ? (
            <Button
              onClick={(e) => {
                e.stopPropagation();
                onCancel();
              }}
              disabled={isCancelling}
              size="sm"
              variant="outline"
              className="h-6 px-2.5 text-[11px] text-destructive border-destructive/25 hover:bg-destructive/8"
            >
              <X size={11} className="mr-0.5" aria-hidden="true" />
              {isCancelling ? `${t("common.cancel")}…` : t("common.cancel")}
            </Button>
          ) : (
            <>
              {downloadDisabled ? (
                <span
                  title={downloadDisabledTitle}
                  className="glass-chip rounded-sm px-2 py-0.5 text-[10px] font-medium text-muted-foreground inline-flex items-center gap-1"
                >
                  <Lock size={10} aria-hidden="true" />
                  {t("common.unavailable")}
                </span>
              ) : (
                <Button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDownload();
                  }}
                  size="sm"
                  variant="default"
                  className="h-6 px-2.5 text-[11px]"
                >
                  <IdleActionIcon size={11} className="mr-1" />
                  {idleActionLabel || t("common.download")}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

interface TranscriptionModelPickerProps {
  selectedCloudProvider: string;
  onCloudProviderSelect: (providerId: string) => void;
  selectedCloudModel: string;
  onCloudModelSelect: (modelId: string) => void;
  preferredLanguage: string;
  selectedLocalModel: string;
  onLocalModelSelect: (modelId: string, providerId?: string) => void;
  selectedLocalProvider?: string;
  onLocalProviderSelect?: (providerId: string) => void;
  useLocalWhisper: boolean;
  onModeChange: (useLocal: boolean) => void;
  openaiApiKey: string;
  setOpenaiApiKey: (key: string) => void;
  graniteRuntimeUrl: string;
  setGraniteRuntimeUrl: (url: string) => void;
  graniteRuntimeApiKey: string;
  setGraniteRuntimeApiKey: (key: string) => void;
  cohereRuntimeUrl: string;
  setCohereRuntimeUrl: (url: string) => void;
  cohereRuntimeApiKey: string;
  setCohereRuntimeApiKey: (key: string) => void;
  groqApiKey: string;
  setGroqApiKey: (key: string) => void;
  sonioxApiKey: string;
  setSonioxApiKey: (key: string) => void;
  deepgramApiKey: string;
  setDeepgramApiKey: (key: string) => void;
  googleSttApiKey: string;
  setGoogleSttApiKey: (key: string) => void;
  doubaoAppId: string;
  setDoubaoAppId: (value: string) => void;
  doubaoAccessToken: string;
  setDoubaoAccessToken: (value: string) => void;
  customTranscriptionApiKey?: string;
  setCustomTranscriptionApiKey?: (key: string) => void;
  cloudTranscriptionBaseUrl?: string;
  setCloudTranscriptionBaseUrl?: (url: string) => void;
  className?: string;
  variant?: "onboarding" | "settings";
}

interface CloudConnectionTestState {
  status: "idle" | "testing" | "success" | "warning" | "error";
  message: string;
}

const CLOUD_PROVIDER_TABS = [
  { id: "openai", name: "OpenAI" },
  { id: "groq", name: "Groq" },
  { id: "soniox", name: "Soniox" },
  { id: "deepgram", name: "Deepgram" },
  { id: "doubao", name: "Doubao" },
  { id: "custom", name: "Custom" },
];

const VALID_CLOUD_PROVIDER_IDS = CLOUD_PROVIDER_TABS.map((p) => p.id);

type LocalProviderId = "whisper" | "parakeet" | "paraformer" | "granite" | "cohere";
type ExternalAsrProviderId = "granite" | "cohere";
type ExternalRuntimeCheckStatus = "idle" | "checking" | "success" | "warning" | "error";

const LOCAL_PROVIDER_TABS: Array<{ id: string; name: string; disabled?: boolean }> = [
  { id: "whisper", name: "OpenAI Whisper" },
  { id: "paraformer", name: "Paraformer" },
  { id: "granite", name: "IBM Granite" },
  { id: "nvidia", name: "NVIDIA" },
];

const CUSTOMER_LOCAL_PROVIDER_IDS = new Set(LOCAL_PROVIDER_TABS.map((provider) => provider.id));
const SHOW_ADVANCED_EXTERNAL_ASR_IN_CUSTOMER_UI = false;

const ADVANCED_EXTERNAL_ASR_TABS: Array<{ id: ExternalAsrProviderId; name: string }> = [
  { id: "cohere", name: "Cohere Transcribe" },
];

interface ExternalRuntimeCheckState {
  status: ExternalRuntimeCheckStatus;
  message: string;
}

const EXTERNAL_RUNTIME_CHECK_IDLE: ExternalRuntimeCheckState = {
  status: "idle",
  message: "",
};

const EXTERNAL_ASR_MODEL_INFO = {
  granite: GRANITE_MODEL_INFO,
  cohere: COHERE_MODEL_INFO,
};

function isExternalAsrModelSelectable(providerId: ExternalAsrProviderId, modelId: string) {
  const model = EXTERNAL_ASR_MODEL_INFO[providerId][modelId];
  return Boolean(model);
}

function getSelectableExternalAsrModelId(providerId: ExternalAsrProviderId, preferredModelId = "") {
  if (preferredModelId && isExternalAsrModelSelectable(providerId, preferredModelId)) {
    return preferredModelId;
  }

  const fallbackModel = Object.entries(EXTERNAL_ASR_MODEL_INFO[providerId])[0];
  return fallbackModel?.[0] || "";
}

function isExternalAsrProviderId(providerId: string): providerId is ExternalAsrProviderId {
  return providerId === "cohere";
}

function normalizeCustomerLocalProviderId(providerId?: string) {
  const normalizedProviderId = String(providerId || "").trim();
  if (normalizedProviderId === "parakeet") return "nvidia";
  return CUSTOMER_LOCAL_PROVIDER_IDS.has(normalizedProviderId) ? normalizedProviderId : "whisper";
}

function isEnglishUiLanguage(uiLanguage: string | null | undefined) {
  const normalizedLanguage = String(uiLanguage || "")
    .trim()
    .toLowerCase();
  return normalizedLanguage === "en" || normalizedLanguage.startsWith("en-");
}

function getPreferredLocalProviderTab(selectedProvider: string | undefined) {
  const rawSelectedProvider = String(selectedProvider || "").trim();
  if (rawSelectedProvider === "parakeet") {
    return "nvidia";
  }
  if (CUSTOMER_LOCAL_PROVIDER_IDS.has(rawSelectedProvider)) {
    return rawSelectedProvider;
  }

  if (typeof window !== "undefined") {
    const storedProvider = window.localStorage.getItem(LOCAL_PROVIDER_TAB_STORAGE_KEY) || "";
    if (CUSTOMER_LOCAL_PROVIDER_IDS.has(storedProvider)) {
      return storedProvider;
    }
  }

  return "whisper";
}

const TESTABLE_CLOUD_PROVIDERS = new Set([
  "openai",
  "groq",
  "custom",
  "soniox",
  "deepgram",
  "google-cloud",
  "doubao",
]);
const CUSTOM_TRANSCRIPTION_BASE_URL_STORAGE_KEY = "customTranscriptionBaseUrl";
const CLOUD_TRANSCRIPTION_MODEL_STORAGE_PREFIX = "chordvox_last_transcription_model_";
const CLOUD_TRANSCRIPTION_BASE_URL_STORAGE_PREFIX = "chordvox_last_transcription_base_url_";
const CLOUD_PROVIDER_BASE_URL_STORAGE_IDS = new Set(["deepgram", "google-cloud"]);
const LOCAL_PROVIDER_TAB_STORAGE_KEY = "localModelPickerLastProviderTabV1";

function isLikelyPathInput(value: string) {
  const raw = String(value || "").trim();
  return raw.includes("/") || raw.includes("\\");
}

function isWebSocketEndpoint(value?: string) {
  return /^wss?:\/\//i.test(String(value || "").trim());
}

export default function TranscriptionModelPicker({
  selectedCloudProvider,
  onCloudProviderSelect,
  selectedCloudModel,
  onCloudModelSelect,
  preferredLanguage,
  selectedLocalModel,
  onLocalModelSelect,
  selectedLocalProvider = "whisper",
  onLocalProviderSelect,
  useLocalWhisper,
  onModeChange,
  openaiApiKey,
  setOpenaiApiKey,
  graniteRuntimeUrl,
  setGraniteRuntimeUrl,
  graniteRuntimeApiKey,
  setGraniteRuntimeApiKey,
  cohereRuntimeUrl,
  setCohereRuntimeUrl,
  cohereRuntimeApiKey,
  setCohereRuntimeApiKey,
  groqApiKey,
  setGroqApiKey,
  sonioxApiKey,
  setSonioxApiKey,
  deepgramApiKey,
  setDeepgramApiKey,
  googleSttApiKey,
  setGoogleSttApiKey,
  doubaoAppId,
  setDoubaoAppId,
  doubaoAccessToken,
  setDoubaoAccessToken,
  customTranscriptionApiKey = "",
  setCustomTranscriptionApiKey,
  cloudTranscriptionBaseUrl = "",
  setCloudTranscriptionBaseUrl,
  className = "",
  variant = "settings",
}: TranscriptionModelPickerProps) {
  const { t, i18n } = useTranslation();
  const isOnboarding = variant === "onboarding";
  const uiLanguage = i18n.resolvedLanguage || i18n.language;
  const [localModels, setLocalModels] = useState<LocalModel[]>([]);
  const [parakeetModels, setParakeetModels] = useState<LocalModel[]>([]);
  const [paraformerModels, setParaformerModels] = useState<LocalModel[]>([]);
  const [graniteModels, setGraniteModels] = useState<LocalModel[]>([]);
  const [graniteRuntimeStatus, setGraniteRuntimeStatus] = useState<{
    working?: boolean;
    installed?: boolean;
    repairNeeded?: boolean;
    pythonMissing?: boolean;
    message?: string;
    runtimePath?: string;
    missingModules?: string[];
  } | null>(null);
  const [internalLocalProvider, setInternalLocalProvider] = useState(() =>
    getPreferredLocalProviderTab(selectedLocalProvider)
  );
  const [advancedRuntimeProvider, setAdvancedRuntimeProvider] =
    useState<ExternalAsrProviderId>("cohere");
  const [externalRuntimeChecks, setExternalRuntimeChecks] = useState<
    Record<ExternalAsrProviderId, ExternalRuntimeCheckState>
  >({
    granite: EXTERNAL_RUNTIME_CHECK_IDLE,
    cohere: EXTERNAL_RUNTIME_CHECK_IDLE,
  });
  const [cloudConnectionTest, setCloudConnectionTest] = useState<CloudConnectionTestState>({
    status: "idle",
    message: "",
  });
  const hasLoadedRef = useRef(false);
  const hasLoadedParakeetRef = useRef(false);
  const hasLoadedParaformerRef = useRef(false);
  const hasLoadedGraniteRef = useRef(false);
  const isChineseUi = uiLanguage.toLowerCase().startsWith("zh");
  const isEnglishUi = isEnglishUiLanguage(uiLanguage);
  const getExternalAsrRuntimeUrl = useCallback(
    (providerId: ExternalAsrProviderId) =>
      providerId === "granite" ? graniteRuntimeUrl : cohereRuntimeUrl,
    [cohereRuntimeUrl, graniteRuntimeUrl]
  );

  const isExternalAsrRuntimeConfigured = useCallback(
    (providerId: ExternalAsrProviderId) => getExternalAsrRuntimeUrl(providerId).trim().length > 0,
    [getExternalAsrRuntimeUrl]
  );
  const isExternalAsrRuntimeReady = useCallback(
    (providerId: ExternalAsrProviderId) => {
      const check = externalRuntimeChecks[providerId];
      return (
        isExternalAsrRuntimeConfigured(providerId) &&
        (check.status === "success" || check.status === "warning")
      );
    },
    [externalRuntimeChecks, isExternalAsrRuntimeConfigured]
  );

  const focusExternalAsrRuntimeUrl = useCallback((providerId: ExternalAsrProviderId) => {
    setInternalLocalProvider(providerId);
    window.requestAnimationFrame(() => {
      document.getElementById(`external-asr-runtime-url-${providerId}`)?.focus();
    });
  }, []);

  const getLocalRecommended = useCallback(
    (providerId: LocalProviderId, modelId: string, fallback?: boolean) => {
      if (providerId === "whisper" && modelId === "turbo") return false;
      if (providerId === "paraformer" && modelId === "paraformer-large-zh") return isChineseUi;
      if (providerId === "parakeet" && modelId === DEFAULT_ENGLISH_PARAKEET_MODEL_ID) {
        return isEnglishUi;
      }

      if (!isChineseUi) {
        return Boolean(fallback);
      }

      if (providerId === "parakeet" && modelId === "parakeet-tdt-0.6b-v3") return false;

      return Boolean(fallback);
    },
    [isChineseUi, isEnglishUi]
  );

  useEffect(() => {
    const nextProvider = getPreferredLocalProviderTab(selectedLocalProvider);
    if (nextProvider !== internalLocalProvider) {
      setInternalLocalProvider(nextProvider);
    }
  }, [internalLocalProvider, selectedLocalProvider]);

  useEffect(() => {
    if (isExternalAsrProviderId(selectedLocalProvider)) {
      setAdvancedRuntimeProvider(selectedLocalProvider);
    }
  }, [selectedLocalProvider]);

  useEffect(() => {
    setExternalRuntimeChecks((prev) => ({
      ...prev,
      granite: EXTERNAL_RUNTIME_CHECK_IDLE,
    }));
  }, [graniteRuntimeUrl, graniteRuntimeApiKey]);

  useEffect(() => {
    setExternalRuntimeChecks((prev) => ({
      ...prev,
      cohere: EXTERNAL_RUNTIME_CHECK_IDLE,
    }));
  }, [cohereRuntimeUrl, cohereRuntimeApiKey]);

  useEffect(() => {
    setCloudConnectionTest((prev) =>
      prev.status === "idle" ? prev : { status: "idle", message: "" }
    );
  }, [
    selectedCloudProvider,
    selectedCloudModel,
    doubaoAppId,
    doubaoAccessToken,
    openaiApiKey,
    groqApiKey,
    sonioxApiKey,
    deepgramApiKey,
    googleSttApiKey,
    cloudTranscriptionBaseUrl,
  ]);
  const isLoadingRef = useRef(false);
  const isLoadingParakeetRef = useRef(false);
  const isLoadingParaformerRef = useRef(false);
  const isLoadingGraniteRef = useRef(false);
  const loadLocalModelsRef = useRef<(() => Promise<void>) | null>(null);
  const loadParakeetModelsRef = useRef<(() => Promise<void>) | null>(null);
  const loadParaformerModelsRef = useRef<(() => Promise<void>) | null>(null);
  const loadGraniteModelsRef = useRef<(() => Promise<void>) | null>(null);
  const ensureValidCloudSelectionRef = useRef<(() => void) | null>(null);
  const selectedLocalModelRef = useRef(selectedLocalModel);
  const selectedLocalProviderRef = useRef(normalizeCustomerLocalProviderId(selectedLocalProvider));
  const onLocalModelSelectRef = useRef(onLocalModelSelect);

  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const colorScheme: ColorScheme = variant === "settings" ? "purple" : "blue";
  const styles = useMemo(() => MODEL_PICKER_COLORS[colorScheme], [colorScheme]);
  const cloudProviders = useMemo(() => getTranscriptionProviders(), []);
  const readStoredCustomTranscriptionBaseUrl = useCallback(() => {
    if (typeof window === "undefined") return API_ENDPOINTS.TRANSCRIPTION_BASE;
    const stored = window.localStorage.getItem(CUSTOM_TRANSCRIPTION_BASE_URL_STORAGE_KEY) || "";
    return normalizeBaseUrl(stored) || API_ENDPOINTS.TRANSCRIPTION_BASE;
  }, []);
  const rememberCustomTranscriptionBaseUrl = useCallback((value: string) => {
    if (typeof window === "undefined") return;
    const normalized = normalizeBaseUrl(value);
    window.localStorage.setItem(
      CUSTOM_TRANSCRIPTION_BASE_URL_STORAGE_KEY,
      normalized || API_ENDPOINTS.TRANSCRIPTION_BASE
    );
  }, []);
  const readStoredCloudProviderBaseUrl = useCallback(
    (providerId: string, fallbackBaseUrl: string) => {
      if (typeof window === "undefined") return fallbackBaseUrl;
      if (!CLOUD_PROVIDER_BASE_URL_STORAGE_IDS.has(providerId)) return fallbackBaseUrl;

      const stored = window.localStorage.getItem(
        `${CLOUD_TRANSCRIPTION_BASE_URL_STORAGE_PREFIX}${providerId}`
      );
      const normalized = normalizeBaseUrl(stored || "");
      return normalized || fallbackBaseUrl;
    },
    []
  );
  const rememberCloudProviderBaseUrl = useCallback((providerId: string, value: string) => {
    if (typeof window === "undefined") return;
    if (!CLOUD_PROVIDER_BASE_URL_STORAGE_IDS.has(providerId)) return;

    const normalized = normalizeBaseUrl(value);
    const storageKey = `${CLOUD_TRANSCRIPTION_BASE_URL_STORAGE_PREFIX}${providerId}`;
    if (normalized) {
      window.localStorage.setItem(storageKey, normalized);
    } else {
      window.localStorage.removeItem(storageKey);
    }
  }, []);
  const readStoredCloudModel = useCallback((providerId: string) => {
    if (typeof window === "undefined") return "";
    return String(
      window.localStorage.getItem(`${CLOUD_TRANSCRIPTION_MODEL_STORAGE_PREFIX}${providerId}`) || ""
    ).trim();
  }, []);
  const rememberCloudModel = useCallback((providerId: string, modelId: string) => {
    if (typeof window === "undefined") return;
    const storageKey = `${CLOUD_TRANSCRIPTION_MODEL_STORAGE_PREFIX}${providerId}`;
    const normalizedModelId = String(modelId || "").trim();
    if (normalizedModelId) {
      window.localStorage.setItem(storageKey, normalizedModelId);
    } else {
      window.localStorage.removeItem(storageKey);
    }
  }, []);
  const cloudProviderTabs = CLOUD_PROVIDER_TABS.map((provider) =>
    provider.id === "custom" ? { ...provider, name: t("transcription.customProvider") } : provider
  );
  const visibleCloudProviderTabs =
    isOnboarding && selectedCloudProvider !== "custom"
      ? cloudProviderTabs.filter((provider) => provider.id !== "custom")
      : cloudProviderTabs;
  const localProviderTabs = useMemo(
    () =>
      LOCAL_PROVIDER_TABS.map((provider) => {
        if (provider.id === "paraformer" && isChineseUi) {
          return {
            ...provider,
            subtitle: t("models.providerBadges.paraformerChineseRecommended", {
              defaultValue: "中文推荐",
            }),
          };
        }

        if (provider.id === "nvidia" && isEnglishUi) {
          return {
            ...provider,
            subtitle: t("models.providerBadges.nvidiaEnglishRecommended", {
              defaultValue: "English pick",
            }),
          };
        }

        return provider;
      }),
    [isChineseUi, isEnglishUi, t]
  );
  const visibleLocalProviderTabs =
    isOnboarding && internalLocalProvider !== "nvidia"
      ? localProviderTabs.filter((provider) => provider.id !== "nvidia")
      : localProviderTabs;

  useEffect(() => {
    selectedLocalModelRef.current = selectedLocalModel;
  }, [selectedLocalModel]);
  useEffect(() => {
    selectedLocalProviderRef.current = normalizeCustomerLocalProviderId(selectedLocalProvider);
  }, [selectedLocalProvider]);
  useEffect(() => {
    onLocalModelSelectRef.current = onLocalModelSelect;
  }, [onLocalModelSelect]);

  const validateAndSelectModel = useCallback((loadedModels: LocalModel[]) => {
    const current = selectedLocalModelRef.current;
    if (!current) return;
    if (isLikelyPathInput(current)) return;

    const downloaded = loadedModels.filter((m) => m.downloaded);
    const isCurrentDownloaded = loadedModels.find((m) => m.model === current)?.downloaded;

    if (!isCurrentDownloaded && downloaded.length > 0) {
      onLocalModelSelectRef.current(downloaded[0].model, "whisper");
    } else if (!isCurrentDownloaded && downloaded.length === 0) {
      onLocalModelSelectRef.current("", "whisper");
    }
  }, []);

  const loadLocalModels = useCallback(async () => {
    if (isLoadingRef.current) return;
    isLoadingRef.current = true;

    try {
      const result = await window.electronAPI?.listWhisperModels();
      if (result?.success) {
        setLocalModels(result.models);
        validateAndSelectModel(result.models);
      }
    } catch (error) {
      console.error("[TranscriptionModelPicker] Failed to load models:", error);
      setLocalModels([]);
    } finally {
      isLoadingRef.current = false;
    }
  }, [validateAndSelectModel]);

  const loadParakeetModels = useCallback(async () => {
    if (isLoadingParakeetRef.current) return;
    isLoadingParakeetRef.current = true;

    try {
      const result = await window.electronAPI?.listParakeetModels();
      if (result?.success) {
        setParakeetModels(result.models);
      }
    } catch (error) {
      console.error("[TranscriptionModelPicker] Failed to load Parakeet models:", error);
      setParakeetModels([]);
    } finally {
      isLoadingParakeetRef.current = false;
    }
  }, []);

  const loadParaformerModels = useCallback(async () => {
    if (isLoadingParaformerRef.current) return;
    isLoadingParaformerRef.current = true;

    try {
      const result = await window.electronAPI?.listParaformerModels();
      if (result?.success) {
        setParaformerModels(result.models);
      }
    } catch (error) {
      console.error("[TranscriptionModelPicker] Failed to load Paraformer models:", error);
      setParaformerModels([]);
    } finally {
      isLoadingParaformerRef.current = false;
    }
  }, []);

  const loadGraniteModels = useCallback(async () => {
    if (isLoadingGraniteRef.current) return;
    isLoadingGraniteRef.current = true;

    try {
      const [modelsResult, runtimeResult] = await Promise.all([
        window.electronAPI?.listGraniteModels?.(),
        window.electronAPI?.checkGraniteRuntime?.(),
      ]);
      if (modelsResult?.success) {
        setGraniteModels(modelsResult.models);
      }
      if (runtimeResult) {
        setGraniteRuntimeStatus(runtimeResult);
      }
    } catch (error) {
      console.error("[TranscriptionModelPicker] Failed to load Granite models:", error);
      setGraniteModels([]);
      setGraniteRuntimeStatus(null);
    } finally {
      isLoadingGraniteRef.current = false;
    }
  }, []);

  const ensureValidCloudSelection = useCallback(() => {
    const isValidProvider = VALID_CLOUD_PROVIDER_IDS.includes(selectedCloudProvider);

    if (!isValidProvider) {
      const knownProviderUrls = cloudProviders.map((p) => p.baseUrl);
      const hasCustomUrl =
        cloudTranscriptionBaseUrl &&
        cloudTranscriptionBaseUrl.trim() !== "" &&
        cloudTranscriptionBaseUrl !== API_ENDPOINTS.TRANSCRIPTION_BASE &&
        !knownProviderUrls.includes(cloudTranscriptionBaseUrl);

      if (hasCustomUrl) {
        onCloudProviderSelect("custom");
      } else {
        const firstProvider = cloudProviders.find((provider) =>
          VALID_CLOUD_PROVIDER_IDS.includes(provider.id)
        );
        if (firstProvider) {
          onCloudProviderSelect(firstProvider.id);
          if (firstProvider.models?.length) {
            onCloudModelSelect(firstProvider.models[0].id);
          }
        }
      }
    } else if (selectedCloudProvider !== "custom" && !selectedCloudModel) {
      const provider = cloudProviders.find((p) => p.id === selectedCloudProvider);
      if (provider?.models?.length) {
        onCloudModelSelect(provider.models[0].id);
      }
    }
  }, [
    cloudProviders,
    cloudTranscriptionBaseUrl,
    selectedCloudProvider,
    selectedCloudModel,
    onCloudProviderSelect,
    onCloudModelSelect,
  ]);

  useEffect(() => {
    loadLocalModelsRef.current = loadLocalModels;
  }, [loadLocalModels]);
  useEffect(() => {
    loadParakeetModelsRef.current = loadParakeetModels;
  }, [loadParakeetModels]);
  useEffect(() => {
    loadParaformerModelsRef.current = loadParaformerModels;
  }, [loadParaformerModels]);
  useEffect(() => {
    loadGraniteModelsRef.current = loadGraniteModels;
  }, [loadGraniteModels]);
  useEffect(() => {
    ensureValidCloudSelectionRef.current = ensureValidCloudSelection;
  }, [ensureValidCloudSelection]);

  useEffect(() => {
    if (selectedCloudProvider !== "custom" || !setCloudTranscriptionBaseUrl) return;

    const currentValue = String(cloudTranscriptionBaseUrl || "").trim();
    if (!currentValue || isWebSocketEndpoint(currentValue)) {
      const fallbackBaseUrl = readStoredCustomTranscriptionBaseUrl();
      if (fallbackBaseUrl !== currentValue) {
        setCloudTranscriptionBaseUrl(fallbackBaseUrl);
      }
      return;
    }

    rememberCustomTranscriptionBaseUrl(currentValue);
  }, [
    cloudTranscriptionBaseUrl,
    selectedCloudProvider,
    setCloudTranscriptionBaseUrl,
    readStoredCustomTranscriptionBaseUrl,
    rememberCustomTranscriptionBaseUrl,
  ]);

  useEffect(() => {
    if (!useLocalWhisper) return;

    if (internalLocalProvider === "whisper" && !hasLoadedRef.current) {
      hasLoadedRef.current = true;
      loadLocalModelsRef.current?.();
    } else if (internalLocalProvider === "nvidia" && !hasLoadedParakeetRef.current) {
      hasLoadedParakeetRef.current = true;
      loadParakeetModelsRef.current?.();
    } else if (internalLocalProvider === "paraformer" && !hasLoadedParaformerRef.current) {
      hasLoadedParaformerRef.current = true;
      loadParaformerModelsRef.current?.();
    } else if (internalLocalProvider === "granite" && !hasLoadedGraniteRef.current) {
      hasLoadedGraniteRef.current = true;
      loadGraniteModelsRef.current?.();
    }
  }, [useLocalWhisper, internalLocalProvider]);

  useEffect(() => {
    if (useLocalWhisper) return;

    hasLoadedRef.current = false;
    hasLoadedParakeetRef.current = false;
    hasLoadedParaformerRef.current = false;
    hasLoadedGraniteRef.current = false;
    ensureValidCloudSelectionRef.current?.();
  }, [useLocalWhisper]);

  useEffect(() => {
    const handleModelsCleared = () => {
      loadLocalModels();
      loadParakeetModels();
      loadParaformerModels();
      loadGraniteModels();
    };
    return addChordVoxModelsClearedListener(window, handleModelsCleared);
  }, [loadLocalModels, loadParakeetModels, loadParaformerModels, loadGraniteModels]);

  const {
    downloadingModel,
    downloadProgress,
    downloadModel,
    deleteModel,
    isDownloadingModel,
    isInstalling,
    cancelDownload,
    isCancelling,
  } = useModelDownload({
    modelType: "whisper",
    onDownloadComplete: loadLocalModels,
  });

  const {
    downloadingModel: downloadingParakeetModel,
    downloadProgress: parakeetDownloadProgress,
    downloadModel: downloadParakeetModel,
    deleteModel: deleteParakeetModel,
    isDownloadingModel: isDownloadingParakeetModel,
    isInstalling: isInstallingParakeet,
    cancelDownload: cancelParakeetDownload,
    isCancelling: isCancellingParakeet,
  } = useModelDownload({
    modelType: "parakeet",
    onDownloadComplete: loadParakeetModels,
  });

  const {
    downloadingModel: downloadingParaformerModel,
    downloadProgress: paraformerDownloadProgress,
    downloadModel: downloadParaformerModel,
    deleteModel: deleteParaformerModel,
    isDownloadingModel: isDownloadingParaformerModel,
    isInstalling: isInstallingParaformer,
    cancelDownload: cancelParaformerDownload,
    isCancelling: isCancellingParaformer,
  } = useModelDownload({
    modelType: "paraformer",
    onDownloadComplete: loadParaformerModels,
  });

  const {
    downloadingModel: downloadingGraniteModel,
    downloadProgress: graniteDownloadProgress,
    downloadModel: downloadGraniteModel,
    deleteModel: deleteGraniteModel,
    isDownloadingModel: isDownloadingGraniteModel,
    isInstalling: isInstallingGranite,
    cancelDownload: cancelGraniteDownload,
    isCancelling: isCancellingGranite,
  } = useModelDownload({
    modelType: "granite",
    onDownloadComplete: loadGraniteModels,
  });

  const handleModeChange = useCallback(
    (isLocal: boolean) => {
      onModeChange(isLocal);
      if (!isLocal) ensureValidCloudSelection();
    },
    [onModeChange, ensureValidCloudSelection]
  );

  const handleCloudProviderChange = useCallback(
    (providerId: string) => {
      if (selectedCloudProvider === "custom" && (cloudTranscriptionBaseUrl || "").trim()) {
        rememberCustomTranscriptionBaseUrl(cloudTranscriptionBaseUrl || "");
      } else {
        rememberCloudProviderBaseUrl(selectedCloudProvider, cloudTranscriptionBaseUrl || "");
      }

      onCloudProviderSelect(providerId);
      const provider = cloudProviders.find((p) => p.id === providerId);
      const storedModel = readStoredCloudModel(providerId);

      if (providerId === "custom") {
        setCloudTranscriptionBaseUrl?.(readStoredCustomTranscriptionBaseUrl());
        onCloudModelSelect(storedModel || "whisper-1");
        return;
      }

      if (provider) {
        setCloudTranscriptionBaseUrl?.(
          readStoredCloudProviderBaseUrl(providerId, provider.baseUrl)
        );
        onCloudModelSelect(storedModel || provider.models?.[0]?.id || "");
      }
    },
    [
      cloudProviders,
      cloudTranscriptionBaseUrl,
      onCloudProviderSelect,
      onCloudModelSelect,
      readStoredCloudModel,
      readStoredCloudProviderBaseUrl,
      readStoredCustomTranscriptionBaseUrl,
      rememberCloudProviderBaseUrl,
      rememberCustomTranscriptionBaseUrl,
      selectedCloudProvider,
      setCloudTranscriptionBaseUrl,
    ]
  );

  const handleLocalProviderChange = useCallback(
    (providerId: string) => {
      const nextProvider = normalizeCustomerLocalProviderId(providerId);
      const tab = LOCAL_PROVIDER_TABS.find((t) => t.id === nextProvider);
      if (tab?.disabled) return;
      if (typeof window !== "undefined") {
        window.localStorage.setItem(LOCAL_PROVIDER_TAB_STORAGE_KEY, nextProvider);
      }
      setInternalLocalProvider(nextProvider);
      onLocalProviderSelect?.(nextProvider);
    },
    [onLocalProviderSelect]
  );

  const getExternalRuntimeCheckMessage = useCallback(
    (result: { status?: string; message?: string }) => {
      if (result.status === "model_missing") {
        return t("transcription.externalRuntime.modelMissing");
      }
      if (result.status === "auth_required") {
        return t("transcription.externalRuntime.authRequired");
      }
      if (result.status === "reachable") {
        return t("transcription.externalRuntime.reachableMessage");
      }
      if (result.status === "ready") {
        return t("transcription.externalRuntime.readyMessage");
      }
      const fallback = result.message || t("transcription.externalRuntime.checkFailed");
      return t("transcription.externalRuntime.endpointError", { message: fallback });
    },
    [t]
  );

  const handleCheckExternalAsrRuntime = useCallback(
    async (providerId: ExternalAsrProviderId, selectOnSuccess = false) => {
      const runtimeUrl = getExternalAsrRuntimeUrl(providerId).trim();
      const runtimeApiKey = providerId === "granite" ? graniteRuntimeApiKey : cohereRuntimeApiKey;
      const modelId = getSelectableExternalAsrModelId(
        providerId,
        selectedLocalProvider === providerId ? selectedLocalModel : ""
      );

      if (!runtimeUrl) {
        setExternalRuntimeChecks((prev) => ({
          ...prev,
          [providerId]: {
            status: "error",
            message: t("transcription.externalRuntime.endpointRequired"),
          },
        }));
        focusExternalAsrRuntimeUrl(providerId);
        return false;
      }

      if (!modelId || !window.electronAPI?.checkExternalAsrRuntime) {
        setExternalRuntimeChecks((prev) => ({
          ...prev,
          [providerId]: {
            status: "error",
            message: t("transcription.externalRuntime.checkUnsupported"),
          },
        }));
        return false;
      }

      setExternalRuntimeChecks((prev) => ({
        ...prev,
        [providerId]: {
          status: "checking",
          message: t("transcription.externalRuntime.checking"),
        },
      }));

      try {
        const result = await window.electronAPI.checkExternalAsrRuntime({
          provider: providerId,
          model: modelId,
          runtimeUrl,
          apiKey: runtimeApiKey,
        });

        if (result?.success) {
          const status: ExternalRuntimeCheckStatus =
            result.status === "reachable" || result.modelFound !== true ? "warning" : "success";
          setExternalRuntimeChecks((prev) => ({
            ...prev,
            [providerId]: {
              status,
              message: getExternalRuntimeCheckMessage(result),
            },
          }));

          if (selectOnSuccess) {
            onLocalProviderSelect?.(providerId);
            setInternalLocalProvider(providerId);
            setAdvancedRuntimeProvider(providerId);
            onLocalModelSelect(modelId, providerId);
          }

          return true;
        }

        setExternalRuntimeChecks((prev) => ({
          ...prev,
          [providerId]: {
            status: "error",
            message: getExternalRuntimeCheckMessage(result || {}),
          },
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setExternalRuntimeChecks((prev) => ({
          ...prev,
          [providerId]: {
            status: "error",
            message: t("transcription.externalRuntime.endpointError", { message }),
          },
        }));
      }

      return false;
    },
    [
      cohereRuntimeApiKey,
      focusExternalAsrRuntimeUrl,
      getExternalAsrRuntimeUrl,
      getExternalRuntimeCheckMessage,
      graniteRuntimeApiKey,
      onLocalModelSelect,
      onLocalProviderSelect,
      selectedLocalModel,
      selectedLocalProvider,
      t,
    ]
  );

  const handleWhisperModelSelect = useCallback(
    (modelId: string) => {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(LOCAL_PROVIDER_TAB_STORAGE_KEY, "whisper");
      }
      onLocalProviderSelect?.("whisper");
      setInternalLocalProvider("whisper");
      onLocalModelSelect(modelId, "whisper");
    },
    [onLocalModelSelect, onLocalProviderSelect]
  );

  const handleParakeetModelSelect = useCallback(
    (modelId: string) => {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(LOCAL_PROVIDER_TAB_STORAGE_KEY, "nvidia");
      }
      onLocalProviderSelect?.("nvidia");
      setInternalLocalProvider("nvidia");
      onLocalModelSelect(modelId, "nvidia");
    },
    [onLocalModelSelect, onLocalProviderSelect]
  );

  const handleParaformerModelSelect = useCallback(
    (modelId: string) => {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(LOCAL_PROVIDER_TAB_STORAGE_KEY, "paraformer");
      }
      onLocalProviderSelect?.("paraformer");
      setInternalLocalProvider("paraformer");
      onLocalModelSelect(modelId, "paraformer");
    },
    [onLocalModelSelect, onLocalProviderSelect]
  );

  const handleGraniteModelSelect = useCallback(
    (modelId: string) => {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(LOCAL_PROVIDER_TAB_STORAGE_KEY, "granite");
      }
      onLocalProviderSelect?.("granite");
      setInternalLocalProvider("granite");
      onLocalModelSelect(modelId, "granite");
    },
    [onLocalModelSelect, onLocalProviderSelect]
  );

  const handleExternalAsrModelSelect = useCallback(
    (providerId: ExternalAsrProviderId, modelId: string) => {
      if (!isExternalAsrModelSelectable(providerId, modelId)) return;
      if (!isExternalAsrRuntimeConfigured(providerId)) {
        focusExternalAsrRuntimeUrl(providerId);
        return;
      }
      if (!isExternalAsrRuntimeReady(providerId)) {
        void handleCheckExternalAsrRuntime(providerId, true);
        return;
      }
      onLocalProviderSelect?.(providerId);
      setInternalLocalProvider(providerId);
      setAdvancedRuntimeProvider(providerId);
      onLocalModelSelect(modelId, providerId);
    },
    [
      focusExternalAsrRuntimeUrl,
      handleCheckExternalAsrRuntime,
      isExternalAsrRuntimeConfigured,
      isExternalAsrRuntimeReady,
      onLocalModelSelect,
      onLocalProviderSelect,
    ]
  );

  const selectedWhisperModelId = useMemo(() => {
    const rawValue = String(selectedLocalModel || "").trim();
    if (!rawValue || isLikelyPathInput(rawValue)) {
      const normalizedPath = rawValue.toLowerCase();
      if (!normalizedPath) return "";
      const byPath = localModels.find(
        (model) =>
          String(model.path || "")
            .trim()
            .toLowerCase() === normalizedPath
      );
      return byPath?.model || "";
    }
    return rawValue;
  }, [selectedLocalModel, localModels]);

  const selectedWhisperModelPath = useMemo(() => {
    const rawValue = String(selectedLocalModel || "").trim();
    if (isLikelyPathInput(rawValue)) {
      return rawValue;
    }
    const selected = localModels.find((model) => model.model === rawValue);
    return selected?.path || "";
  }, [selectedLocalModel, localModels]);

  const handleWhisperModelPathChange = useCallback(
    (value: string) => {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(LOCAL_PROVIDER_TAB_STORAGE_KEY, "whisper");
      }
      onLocalProviderSelect?.("whisper");
      setInternalLocalProvider("whisper");
      onLocalModelSelect(value, "whisper");
    },
    [onLocalModelSelect, onLocalProviderSelect]
  );

  const handlePickWhisperModel = useCallback(async () => {
    try {
      const result = await window.electronAPI?.pickWhisperModelFile?.(selectedWhisperModelPath);
      if (result?.success && result.path) {
        handleWhisperModelPathChange(result.path);
      }
    } catch (error) {
      console.error("[TranscriptionModelPicker] Failed to pick Whisper model:", error);
    }
  }, [selectedWhisperModelPath, handleWhisperModelPathChange]);

  const selectedParakeetModelId = useMemo(() => {
    const rawValue = String(selectedLocalModel || "").trim();
    if (!rawValue || isLikelyPathInput(rawValue)) {
      const normalizedPath = rawValue.toLowerCase();
      if (!normalizedPath) return "";
      const byPath = parakeetModels.find(
        (model) =>
          String(model.path || "")
            .trim()
            .toLowerCase() === normalizedPath
      );
      return byPath?.model || "";
    }
    return rawValue;
  }, [selectedLocalModel, parakeetModels]);

  const selectedParakeetModelPath = useMemo(() => {
    const rawValue = String(selectedLocalModel || "").trim();
    if (isLikelyPathInput(rawValue)) {
      return rawValue;
    }
    const selected = parakeetModels.find((model) => model.model === rawValue);
    return selected?.path || "";
  }, [selectedLocalModel, parakeetModels]);

  const handleParakeetModelPathChange = useCallback(
    (value: string) => {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(LOCAL_PROVIDER_TAB_STORAGE_KEY, "nvidia");
      }
      onLocalProviderSelect?.("nvidia");
      setInternalLocalProvider("nvidia");
      onLocalModelSelect(value, "nvidia");
    },
    [onLocalModelSelect, onLocalProviderSelect]
  );

  const handlePickParakeetModelDirectory = useCallback(async () => {
    try {
      const result =
        await window.electronAPI?.pickParakeetModelDirectory?.(selectedParakeetModelPath);
      if (result?.success && result.path) {
        handleParakeetModelPathChange(result.path);
      }
    } catch (error) {
      console.error("[TranscriptionModelPicker] Failed to pick Parakeet model directory:", error);
    }
  }, [selectedParakeetModelPath, handleParakeetModelPathChange]);

  const selectedParaformerModelId = useMemo(() => {
    const rawValue = String(selectedLocalModel || "").trim();
    if (!rawValue || isLikelyPathInput(rawValue)) {
      const normalizedPath = rawValue.toLowerCase();
      if (!normalizedPath) return "";
      const byPath = paraformerModels.find(
        (model) =>
          String(model.path || "")
            .trim()
            .toLowerCase() === normalizedPath
      );
      return byPath?.model || "";
    }
    return rawValue;
  }, [selectedLocalModel, paraformerModels]);

  const selectedParaformerModelPath = useMemo(() => {
    const rawValue = String(selectedLocalModel || "").trim();
    if (isLikelyPathInput(rawValue)) {
      return rawValue;
    }
    const selected = paraformerModels.find((model) => model.model === rawValue);
    return selected?.path || "";
  }, [selectedLocalModel, paraformerModels]);

  const selectedGraniteModelId = useMemo(() => {
    const rawValue = String(selectedLocalModel || "").trim();
    if (!rawValue || isLikelyPathInput(rawValue)) return "";
    return rawValue;
  }, [selectedLocalModel]);

  const handleParaformerModelPathChange = useCallback(
    (value: string) => {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(LOCAL_PROVIDER_TAB_STORAGE_KEY, "paraformer");
      }
      onLocalProviderSelect?.("paraformer");
      setInternalLocalProvider("paraformer");
      onLocalModelSelect(value, "paraformer");
    },
    [onLocalModelSelect, onLocalProviderSelect]
  );

  const handlePickParaformerModelDirectory = useCallback(async () => {
    try {
      const result = await window.electronAPI?.pickParaformerModelDirectory?.(
        selectedParaformerModelPath
      );
      if (result?.success && result.path) {
        handleParaformerModelPathChange(result.path);
      }
    } catch (error) {
      console.error("[TranscriptionModelPicker] Failed to pick Paraformer model directory:", error);
    }
  }, [selectedParaformerModelPath, handleParaformerModelPathChange]);

  const refreshModelsAndSelectFallback = useCallback(
    async (
      deletedProvider: "whisper" | "nvidia" | "paraformer" | "granite",
      deletedModelId: string,
      selectedValueBeforeDelete: string | null
    ) => {
      const reconcileModels = (provider: typeof deletedProvider, models: LocalModel[]) =>
        provider === deletedProvider ? markDeletedModelUnavailable(models, deletedModelId) : models;

      const loadWhisper = async () => {
        try {
          const result = await window.electronAPI?.listWhisperModels();
          return reconcileModels("whisper", result?.success ? result.models : localModels);
        } catch {
          return reconcileModels("whisper", localModels);
        }
      };
      const loadParakeet = async () => {
        try {
          const result = await window.electronAPI?.listParakeetModels();
          return reconcileModels("nvidia", result?.success ? result.models : parakeetModels);
        } catch {
          return reconcileModels("nvidia", parakeetModels);
        }
      };
      const loadParaformer = async () => {
        try {
          const result = await window.electronAPI?.listParaformerModels();
          return reconcileModels("paraformer", result?.success ? result.models : paraformerModels);
        } catch {
          return reconcileModels("paraformer", paraformerModels);
        }
      };
      const loadGranite = async () => {
        try {
          const result = await window.electronAPI?.listGraniteModels?.();
          return reconcileModels("granite", result?.success ? result.models : graniteModels);
        } catch {
          return reconcileModels("granite", graniteModels);
        }
      };

      const [nextWhisper, nextParakeet, nextParaformer, nextGranite] = await Promise.all([
        loadWhisper(),
        loadParakeet(),
        loadParaformer(),
        loadGranite(),
      ]);
      setLocalModels(nextWhisper);
      setParakeetModels(nextParakeet);
      setParaformerModels(nextParaformer);
      setGraniteModels(nextGranite);

      if (
        selectedValueBeforeDelete === null ||
        selectedLocalProviderRef.current !== deletedProvider ||
        selectedLocalModelRef.current !== selectedValueBeforeDelete
      ) {
        return;
      }

      const modelsByProvider = {
        whisper: nextWhisper,
        nvidia: nextParakeet,
        paraformer: nextParaformer,
        granite: nextGranite,
      };
      const providerOrder = [
        deletedProvider,
        ...(["whisper", "nvidia", "paraformer", "granite"] as const).filter(
          (provider) => provider !== deletedProvider
        ),
      ] as const;

      let fallbackProvider: "whisper" | "nvidia" | "paraformer" | "granite" = "whisper";
      let fallbackModelId = "";
      for (const provider of providerOrder) {
        const fallback = modelsByProvider[provider].find(
          (model) =>
            model.downloaded && !(provider === deletedProvider && model.model === deletedModelId)
        );
        if (fallback) {
          fallbackProvider = provider;
          fallbackModelId = fallback.model;
          break;
        }
      }

      window.localStorage.setItem(LOCAL_PROVIDER_TAB_STORAGE_KEY, fallbackProvider);
      selectedLocalProviderRef.current = fallbackProvider;
      selectedLocalModelRef.current = fallbackModelId;
      setInternalLocalProvider(fallbackProvider);
      onLocalProviderSelect?.(fallbackProvider);
      onLocalModelSelectRef.current(fallbackModelId, fallbackProvider);
    },
    [graniteModels, localModels, onLocalProviderSelect, parakeetModels, paraformerModels]
  );

  const handleBaseUrlBlur = useCallback(() => {
    if (!setCloudTranscriptionBaseUrl || selectedCloudProvider !== "custom") return;

    const trimmed = (cloudTranscriptionBaseUrl || "").trim();
    if (!trimmed) return;

    const normalized = normalizeBaseUrl(trimmed);

    if (normalized && normalized !== cloudTranscriptionBaseUrl) {
      setCloudTranscriptionBaseUrl(normalized);
    }
    if (normalized) {
      rememberCustomTranscriptionBaseUrl(normalized);
    }
    if (normalized) {
      for (const provider of cloudProviders) {
        const providerNormalized = normalizeBaseUrl(provider.baseUrl);
        if (normalized === providerNormalized) {
          onCloudProviderSelect(provider.id);
          onCloudModelSelect("whisper-1");
          break;
        }
      }
    }
  }, [
    cloudTranscriptionBaseUrl,
    selectedCloudProvider,
    setCloudTranscriptionBaseUrl,
    onCloudProviderSelect,
    onCloudModelSelect,
    cloudProviders,
    rememberCustomTranscriptionBaseUrl,
  ]);

  const handleDelete = useCallback(
    (modelId: string) => {
      const selectedValueBeforeDelete =
        internalLocalProvider === "whisper" && selectedWhisperModelId === modelId
          ? selectedLocalModelRef.current
          : null;
      showConfirmDialog({
        title: t("transcription.deleteModel.title"),
        description: t("transcription.deleteModel.description"),
        onConfirm: async () => {
          await deleteModel(modelId, () =>
            refreshModelsAndSelectFallback("whisper", modelId, selectedValueBeforeDelete)
          );
        },
        variant: "destructive",
      });
    },
    [
      deleteModel,
      internalLocalProvider,
      refreshModelsAndSelectFallback,
      selectedWhisperModelId,
      showConfirmDialog,
      t,
    ]
  );

  const currentCloudProvider = useMemo<TranscriptionProviderData | undefined>(
    () => cloudProviders.find((p) => p.id === selectedCloudProvider),
    [cloudProviders, selectedCloudProvider]
  );

  const selectedCloudGuideUrl = useMemo(
    () => getProviderGuideUrl(selectedCloudProvider),
    [selectedCloudProvider]
  );

  const cloudModelOptions = useMemo(() => {
    if (!currentCloudProvider) return [];
    return currentCloudProvider.models.map((m) => ({
      value: m.id,
      label: m.name,
      description: m.descriptionKey
        ? t(m.descriptionKey, { defaultValue: m.description })
        : m.description,
      icon: getProviderIcon(selectedCloudProvider),
      invertInDark: isMonochromeProvider(selectedCloudProvider),
    }));
  }, [currentCloudProvider, selectedCloudProvider, t]);

  const displayedCloudModelOptions = useMemo(() => {
    const trimmedModelId = String(selectedCloudModel || "").trim();
    if (!trimmedModelId || cloudModelOptions.some((model) => model.value === trimmedModelId)) {
      return cloudModelOptions;
    }

    return [
      {
        value: trimmedModelId,
        label: trimmedModelId,
        description: t("transcription.customModelIdDescription"),
        icon: getProviderIcon(selectedCloudProvider),
        invertInDark: isMonochromeProvider(selectedCloudProvider),
      },
      ...cloudModelOptions,
    ];
  }, [cloudModelOptions, selectedCloudModel, selectedCloudProvider, t]);

  const cloudModelIdPlaceholder = currentCloudProvider?.models[0]?.id || "whisper-1";

  const handleCloudModelIdInputChange = useCallback(
    (value: string) => {
      const normalizedModelId = value.trim();
      rememberCloudModel(selectedCloudProvider, normalizedModelId);
      onCloudModelSelect(normalizedModelId);
    },
    [onCloudModelSelect, rememberCloudModel, selectedCloudProvider]
  );

  const handleCloudModelSelect = useCallback(
    (modelId: string) => {
      const normalizedModelId = modelId.trim();
      rememberCloudModel(selectedCloudProvider, normalizedModelId);
      onCloudModelSelect(normalizedModelId);
    },
    [onCloudModelSelect, rememberCloudModel, selectedCloudProvider]
  );

  const handleCloudProviderBaseUrlInputChange = useCallback(
    (value: string) => {
      setCloudTranscriptionBaseUrl?.(value);
      rememberCloudProviderBaseUrl(selectedCloudProvider, value);
    },
    [rememberCloudProviderBaseUrl, selectedCloudProvider, setCloudTranscriptionBaseUrl]
  );

  const testButtonLabel = t("transcription.connectionTest.button");
  const testingLabel = t("transcription.connectionTest.testing");

  const getCloudProviderLabel = useCallback(
    (providerId: string) => {
      if (providerId === "openai") return "OpenAI";
      if (providerId === "groq") return "Groq";
      if (providerId === "soniox") return "Soniox";
      if (providerId === "deepgram") return "Deepgram";
      if (providerId === "google-cloud") return "Google Cloud";
      if (providerId === "doubao") return "Doubao";
      if (providerId === "custom") return t("transcription.customProvider");
      return providerId;
    },
    [t]
  );

  const getDoubaoModelLabel = useCallback(
    (modelId?: string) => {
      if (modelId === "doubao-seedasr-streaming-2.0") {
        return t("transcription.connectionTest.doubao.streaming2");
      }
      if (modelId === "doubao-bigasr-streaming-1.0") {
        return t("transcription.connectionTest.doubao.streaming1Compatibility");
      }
      return modelId || t("transcription.connectionTest.doubao.autoRecommended");
    },
    [t]
  );

  const getCloudModelLabel = useCallback(
    (providerId: string, modelId?: string) => {
      if (providerId === "doubao") {
        return getDoubaoModelLabel(modelId);
      }

      const provider = cloudProviders.find((item) => item.id === providerId);
      const model = provider?.models.find((item) => item.id === modelId);
      return model?.name || modelId || "";
    },
    [cloudProviders, getDoubaoModelLabel]
  );

  const handleTestDoubaoConnection = useCallback(async () => {
    if (!window.electronAPI?.testDoubaoConnection) {
      setCloudConnectionTest({
        status: "error",
        message: t("transcription.connectionTest.unsupported"),
      });
      return;
    }

    setCloudConnectionTest({
      status: "testing",
      message: t("transcription.connectionTest.doubao.testing"),
    });

    try {
      const result = await window.electronAPI.testDoubaoConnection({
        appId: doubaoAppId,
        accessToken: doubaoAccessToken,
        model: selectedCloudModel,
        language: preferredLanguage,
      });

      if (!result?.success) {
        throw new Error(
          result?.message || result?.error || t("transcription.connectionTest.defaultError")
        );
      }

      const resolvedLabel = getDoubaoModelLabel(result.resolvedModelId);
      if (
        selectedCloudModel === "doubao-streaming-auto" &&
        result.resolvedModelId === "doubao-bigasr-streaming-1.0"
      ) {
        setCloudConnectionTest({
          status: "warning",
          message: t("transcription.connectionTest.doubao.autoFallbackWarning", {
            model: resolvedLabel,
          }),
        });
        return;
      }

      setCloudConnectionTest({
        status: "success",
        message: t("transcription.connectionTest.doubao.availableModel", {
          model: resolvedLabel,
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCloudConnectionTest({
        status: "error",
        message: t("transcription.connectionTest.failed", { message }),
      });
    }
  }, [
    doubaoAccessToken,
    doubaoAppId,
    getDoubaoModelLabel,
    preferredLanguage,
    selectedCloudModel,
    t,
  ]);

  const handleTestSonioxConnection = useCallback(async () => {
    if (!window.electronAPI?.testSonioxConnection) {
      setCloudConnectionTest({
        status: "error",
        message: t("transcription.connectionTest.unsupported"),
      });
      return;
    }

    setCloudConnectionTest({
      status: "testing",
      message: t("transcription.connectionTest.soniox.testing"),
    });

    try {
      const result = await window.electronAPI.testSonioxConnection({
        apiKey: sonioxApiKey,
        model: selectedCloudModel,
        language: preferredLanguage,
      });

      if (!result?.success) {
        throw new Error(
          result?.message || result?.error || t("transcription.connectionTest.defaultError")
        );
      }

      const modelLabel = getCloudModelLabel("soniox", result.resolvedModelId || selectedCloudModel);
      setCloudConnectionTest({
        status: "success",
        message: t("transcription.connectionTest.soniox.availableModel", {
          model: modelLabel,
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCloudConnectionTest({
        status: "error",
        message: t("transcription.connectionTest.failed", { message }),
      });
    }
  }, [getCloudModelLabel, preferredLanguage, selectedCloudModel, sonioxApiKey, t]);

  const handleTestGoogleCloudSttConnection = useCallback(async () => {
    if (!window.electronAPI?.testGoogleCloudSttConnection) {
      setCloudConnectionTest({
        status: "error",
        message: t("transcription.connectionTest.unsupported"),
      });
      return;
    }

    setCloudConnectionTest({
      status: "testing",
      message: t("transcription.connectionTest.googleCloud.testing"),
    });

    try {
      const result = await window.electronAPI.testGoogleCloudSttConnection({
        endpoint: cloudTranscriptionBaseUrl,
        credential: googleSttApiKey,
        model: selectedCloudModel,
        language: preferredLanguage,
      });

      if (!result?.success) {
        throw new Error(
          result?.message || result?.error || t("transcription.connectionTest.defaultError")
        );
      }

      const modelLabel = getCloudModelLabel(
        "google-cloud",
        result.resolvedModelId || selectedCloudModel
      );
      setCloudConnectionTest({
        status: "success",
        message: t("transcription.connectionTest.googleCloud.availableModel", {
          model: modelLabel,
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCloudConnectionTest({
        status: "error",
        message: t("transcription.connectionTest.failed", { message }),
      });
    }
  }, [
    cloudTranscriptionBaseUrl,
    getCloudModelLabel,
    googleSttApiKey,
    preferredLanguage,
    selectedCloudModel,
    t,
  ]);

  const handleTestDeepgramConnection = useCallback(async () => {
    if (!window.electronAPI?.testDeepgramConnection) {
      setCloudConnectionTest({
        status: "error",
        message: t("transcription.connectionTest.unsupported"),
      });
      return;
    }

    setCloudConnectionTest({
      status: "testing",
      message: t("transcription.connectionTest.deepgram.testing"),
    });

    try {
      const result = await window.electronAPI.testDeepgramConnection({
        apiKey: deepgramApiKey,
        endpoint: cloudTranscriptionBaseUrl,
        model: selectedCloudModel,
        language: preferredLanguage,
      });

      if (!result?.success) {
        setCloudConnectionTest({
          status: "error",
          message:
            result?.message || result?.error || t("transcription.connectionTest.defaultError"),
        });
        return;
      }

      const modelLabel = getCloudModelLabel(
        "deepgram",
        result.resolvedModelId || selectedCloudModel
      );
      setCloudConnectionTest({
        status: "success",
        message: t("transcription.connectionTest.deepgram.availableModel", {
          model: modelLabel,
        }),
      });
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error))
        .replace(/^Error invoking remote method 'test-deepgram-connection':\s*/u, "")
        .replace(/^Error:\s*/u, "");
      setCloudConnectionTest({
        status: "error",
        message: message || t("transcription.connectionTest.defaultError"),
      });
    }
  }, [
    cloudTranscriptionBaseUrl,
    deepgramApiKey,
    getCloudModelLabel,
    preferredLanguage,
    selectedCloudModel,
    t,
  ]);

  const handleTestStandardCloudConnection = useCallback(
    async (providerId: "openai" | "groq" | "custom") => {
      if (!window.electronAPI?.testCloudTranscriptionConnection) {
        setCloudConnectionTest({
          status: "error",
          message: t("transcription.connectionTest.unsupported"),
        });
        return;
      }

      const providerName = getCloudProviderLabel(providerId);
      setCloudConnectionTest({
        status: "testing",
        message: t("transcription.connectionTest.testingProvider", {
          provider: providerName,
        }),
      });

      try {
        const apiKey =
          providerId === "openai"
            ? openaiApiKey
            : providerId === "groq"
              ? groqApiKey
              : customTranscriptionApiKey;
        const result = await window.electronAPI.testCloudTranscriptionConnection({
          provider: providerId,
          apiKey,
          model: selectedCloudModel,
          endpoint: providerId === "custom" ? cloudTranscriptionBaseUrl : undefined,
        });

        if (!result?.success) {
          throw new Error(
            result?.message || result?.error || t("transcription.connectionTest.defaultError")
          );
        }

        const modelLabel = getCloudModelLabel(providerId, selectedCloudModel);
        if (result.modelFound === false) {
          setCloudConnectionTest({
            status: "warning",
            message: t("transcription.connectionTest.modelMissingWarning", {
              model: modelLabel,
              provider: providerName,
            }),
          });
          return;
        }

        setCloudConnectionTest({
          status: "success",
          message: t("transcription.connectionTest.modelAvailable", {
            model: modelLabel,
          }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setCloudConnectionTest({
          status: "error",
          message: t("transcription.connectionTest.failed", { message }),
        });
      }
    },
    [
      cloudTranscriptionBaseUrl,
      customTranscriptionApiKey,
      getCloudModelLabel,
      getCloudProviderLabel,
      groqApiKey,
      openaiApiKey,
      selectedCloudModel,
      t,
    ]
  );

  const handleTestCloudConnection = useCallback(async () => {
    if (selectedCloudProvider === "doubao") {
      await handleTestDoubaoConnection();
      return;
    }

    if (selectedCloudProvider === "soniox") {
      await handleTestSonioxConnection();
      return;
    }

    if (selectedCloudProvider === "deepgram") {
      await handleTestDeepgramConnection();
      return;
    }

    if (selectedCloudProvider === "google-cloud") {
      await handleTestGoogleCloudSttConnection();
      return;
    }

    if (selectedCloudProvider === "openai" || selectedCloudProvider === "groq") {
      await handleTestStandardCloudConnection(selectedCloudProvider);
      return;
    }

    if (selectedCloudProvider === "custom") {
      await handleTestStandardCloudConnection("custom");
    }
  }, [
    handleTestDoubaoConnection,
    handleTestDeepgramConnection,
    handleTestGoogleCloudSttConnection,
    handleTestSonioxConnection,
    handleTestStandardCloudConnection,
    selectedCloudProvider,
  ]);

  const progressDisplay = useMemo(() => {
    if (!useLocalWhisper) return null;

    if (downloadingModel && internalLocalProvider === "whisper") {
      const modelInfo = WHISPER_MODEL_INFO[downloadingModel];
      return (
        <DownloadProgressBar
          modelName={modelInfo?.name || downloadingModel}
          progress={downloadProgress}
          isInstalling={isInstalling}
        />
      );
    }

    if (downloadingParakeetModel && internalLocalProvider === "nvidia") {
      const modelInfo = PARAKEET_MODEL_INFO[downloadingParakeetModel];
      return (
        <DownloadProgressBar
          modelName={modelInfo?.name || downloadingParakeetModel}
          progress={parakeetDownloadProgress}
          isInstalling={isInstallingParakeet}
        />
      );
    }

    if (downloadingParaformerModel && internalLocalProvider === "paraformer") {
      const modelInfo = PARAFORMER_MODEL_INFO[downloadingParaformerModel];
      return (
        <DownloadProgressBar
          modelName={modelInfo?.name || downloadingParaformerModel}
          progress={paraformerDownloadProgress}
          isInstalling={isInstallingParaformer}
        />
      );
    }

    if (downloadingGraniteModel && internalLocalProvider === "granite") {
      const modelInfo = GRANITE_MODEL_INFO[downloadingGraniteModel];
      return (
        <DownloadProgressBar
          modelName={modelInfo?.name || downloadingGraniteModel}
          progress={graniteDownloadProgress}
          isInstalling={isInstallingGranite}
        />
      );
    }

    return null;
  }, [
    downloadingModel,
    downloadProgress,
    isInstalling,
    downloadingParakeetModel,
    parakeetDownloadProgress,
    isInstallingParakeet,
    downloadingParaformerModel,
    paraformerDownloadProgress,
    isInstallingParaformer,
    downloadingGraniteModel,
    graniteDownloadProgress,
    isInstallingGranite,
    useLocalWhisper,
    internalLocalProvider,
  ]);

  const renderLocalModels = () => {
    const modelsToRender =
      localModels.length === 0
        ? Object.entries(WHISPER_MODEL_INFO).map(([modelId, info]) => ({
            model: modelId,
            downloaded: false,
            size_mb: info.sizeMb,
          }))
        : localModels;

    return (
      <div className="space-y-2">
        <div className="space-y-0.5">
          {modelsToRender.map((model) => {
            const modelId = model.model;
            const info = WHISPER_MODEL_INFO[modelId] ?? {
              name: modelId,
              description: t("transcription.fallback.whisperModelDescription"),
              descriptionKey: undefined,
              size: t("common.unknown"),
              badge: undefined,
              badgeKey: undefined,
              recommended: false,
            };
            const descriptionKey = "descriptionKey" in info ? info.descriptionKey : undefined;

            return (
              <LocalModelCard
                key={modelId}
                modelId={modelId}
                name={info.name}
                description={
                  descriptionKey
                    ? t(descriptionKey, { defaultValue: info.description })
                    : info.description
                }
                size={info.size}
                actualSizeMb={model.size_mb}
                isSelected={modelId === selectedWhisperModelId}
                isDownloaded={model.downloaded ?? false}
                isDownloading={isDownloadingModel(modelId)}
                isCancelling={isCancelling}
                recommended={getLocalRecommended("whisper", modelId, info.recommended)}
                provider="whisper"
                modelTag={
                  info.badgeKey ? t(info.badgeKey, { defaultValue: info.badge || "" }) : info.badge
                }
                onSelect={() => handleWhisperModelSelect(modelId)}
                onDelete={() => handleDelete(modelId)}
                onDownload={() =>
                  downloadModel(modelId, (downloadedId) => {
                    setLocalModels((prev) =>
                      prev.map((m) => (m.model === downloadedId ? { ...m, downloaded: true } : m))
                    );
                    handleWhisperModelSelect(downloadedId);
                  })
                }
                onCancel={cancelDownload}
                styles={styles}
              />
            );
          })}
        </div>

        {!isOnboarding ? (
          <>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">
                {t("transcription.whisperModelFileLabel")}
              </label>
              <div className="flex items-center gap-1.5">
                <Input
                  name="whisperModelPath"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-label={t("transcription.whisperModelFileLabel")}
                  value={selectedWhisperModelPath}
                  onChange={(e) => handleWhisperModelPathChange(e.target.value)}
                  placeholder="/path/to/ggml-large-v3-turbo.bin"
                  className="h-8 text-sm"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="h-8 px-2 text-xs"
                  onClick={handlePickWhisperModel}
                >
                  {t("transcription.browse")}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {t("transcription.whisperModelFileHint")}
              </p>
            </div>
          </>
        ) : null}
      </div>
    );
  };

  const handleParakeetDelete = useCallback(
    (modelId: string) => {
      const selectedValueBeforeDelete =
        internalLocalProvider === "nvidia" && selectedParakeetModelId === modelId
          ? selectedLocalModelRef.current
          : null;
      showConfirmDialog({
        title: t("transcription.deleteModel.title"),
        description: t("transcription.deleteModel.description"),
        onConfirm: async () => {
          await deleteParakeetModel(modelId, () =>
            refreshModelsAndSelectFallback("nvidia", modelId, selectedValueBeforeDelete)
          );
        },
        variant: "destructive",
      });
    },
    [
      deleteParakeetModel,
      internalLocalProvider,
      refreshModelsAndSelectFallback,
      selectedParakeetModelId,
      showConfirmDialog,
      t,
    ]
  );

  const getParakeetLanguageLabel = (language: string) => {
    return language === "multilingual"
      ? t("transcription.parakeet.multilingual")
      : t("transcription.parakeet.english");
  };

  const renderLocalProviderIcon = useCallback((providerId: string) => {
    if (providerId === "granite") {
      return <Cpu className="h-4 w-4 text-muted-foreground" aria-hidden="true" />;
    }
    if (providerId === "cohere") {
      return <Sparkles className="h-4 w-4 text-muted-foreground" aria-hidden="true" />;
    }
    if (providerId === "paraformer") {
      return <AudioWaveform className="h-4 w-4 text-muted-foreground" aria-hidden="true" />;
    }
    return <ProviderIcon provider={providerId} />;
  }, []);

  const renderParakeetModels = () => {
    const modelsToRender =
      parakeetModels.length === 0
        ? Object.entries(PARAKEET_MODEL_INFO).map(([modelId, info]) => ({
            model: modelId,
            downloaded: false,
            size_mb: info.sizeMb,
          }))
        : parakeetModels;

    return (
      <div className="space-y-2">
        <div className="space-y-0.5">
          {modelsToRender.map((model) => {
            const modelId = model.model;
            const info = PARAKEET_MODEL_INFO[modelId] ?? {
              name: modelId,
              description: t("transcription.fallback.parakeetModelDescription"),
              descriptionKey: undefined,
              size: t("common.unknown"),
              language: "en",
              badge: undefined,
              badgeKey: undefined,
              runtimeSupported: true,
              recommended: false,
            };
            const descriptionKey = "descriptionKey" in info ? info.descriptionKey : undefined;
            const isRuntimeSupported = info.runtimeSupported !== false;

            return (
              <LocalModelCard
                key={modelId}
                modelId={modelId}
                name={info.name}
                description={
                  descriptionKey
                    ? t(descriptionKey, { defaultValue: info.description })
                    : info.description
                }
                size={info.size}
                actualSizeMb={model.size_mb}
                isSelected={modelId === selectedParakeetModelId}
                isDownloaded={model.downloaded ?? false}
                isDownloading={isDownloadingParakeetModel(modelId)}
                isCancelling={isCancellingParakeet}
                downloadDisabled={!isRuntimeSupported}
                downloadDisabledTitle={
                  isRuntimeSupported ? undefined : t("transcription.parakeet.externalRuntime")
                }
                recommended={getLocalRecommended("parakeet", modelId, info.recommended)}
                provider="nvidia"
                languageLabel={getParakeetLanguageLabel(info.language)}
                modelTag={
                  info.badgeKey ? t(info.badgeKey, { defaultValue: info.badge || "" }) : info.badge
                }
                onSelect={() => handleParakeetModelSelect(modelId)}
                onDelete={() => handleParakeetDelete(modelId)}
                onDownload={() =>
                  downloadParakeetModel(modelId, (downloadedId) => {
                    setParakeetModels((prev) =>
                      prev.map((m) => (m.model === downloadedId ? { ...m, downloaded: true } : m))
                    );
                    handleParakeetModelSelect(downloadedId);
                  })
                }
                onCancel={cancelParakeetDownload}
                styles={styles}
              />
            );
          })}
        </div>

        {!isOnboarding ? (
          <>
            <div className="rounded-md border border-border/50 bg-muted/20 px-2.5 py-2">
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {t("transcription.parakeetLocalHelp")}
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">
                {t("transcription.parakeetModelDirectoryLabel")}
              </label>
              <div className="flex items-center gap-1.5">
                <Input
                  name="parakeetModelPath"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-label={t("transcription.parakeetModelDirectoryLabel")}
                  value={selectedParakeetModelPath}
                  onChange={(e) => handleParakeetModelPathChange(e.target.value)}
                  placeholder="/path/to/parakeet-tdt-0.6b-v3"
                  className="h-8 text-sm"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="h-8 px-2 text-xs"
                  onClick={handlePickParakeetModelDirectory}
                >
                  {t("transcription.browse")}
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </div>
    );
  };

  const handleParaformerDelete = useCallback(
    (modelId: string) => {
      const selectedValueBeforeDelete =
        internalLocalProvider === "paraformer" && selectedParaformerModelId === modelId
          ? selectedLocalModelRef.current
          : null;
      showConfirmDialog({
        title: t("transcription.deleteModel.title"),
        description: t("transcription.deleteModel.description"),
        onConfirm: async () => {
          await deleteParaformerModel(modelId, () =>
            refreshModelsAndSelectFallback("paraformer", modelId, selectedValueBeforeDelete)
          );
        },
        variant: "destructive",
      });
    },
    [
      deleteParaformerModel,
      internalLocalProvider,
      refreshModelsAndSelectFallback,
      selectedParaformerModelId,
      showConfirmDialog,
      t,
    ]
  );

  const getParaformerLanguageLabel = (language: string) => {
    return language === "zh-en"
      ? t("transcription.paraformer.chineseEnglish")
      : t("transcription.paraformer.chinese");
  };

  const renderParaformerModels = () => {
    const modelsToRender =
      paraformerModels.length === 0
        ? Object.entries(PARAFORMER_MODEL_INFO).map(([modelId, info]) => ({
            model: modelId,
            downloaded: false,
            size_mb: info.sizeMb,
          }))
        : paraformerModels;

    return (
      <div className="space-y-2">
        <div className="space-y-0.5">
          {modelsToRender.map((model) => {
            const modelId = model.model;
            const info = PARAFORMER_MODEL_INFO[modelId] ?? {
              name: modelId,
              description: t("transcription.fallback.paraformerModelDescription"),
              size: t("common.unknown"),
              language: "zh",
              badge: undefined,
              badgeKey: undefined,
              recommended: false,
            };

            return (
              <LocalModelCard
                key={modelId}
                modelId={modelId}
                name={info.name}
                description={info.description}
                size={info.size}
                actualSizeMb={model.size_mb}
                isSelected={modelId === selectedParaformerModelId}
                isDownloaded={model.downloaded ?? false}
                isDownloading={isDownloadingParaformerModel(modelId)}
                isCancelling={isCancellingParaformer}
                recommended={getLocalRecommended("paraformer", modelId, info.recommended)}
                provider="paraformer"
                languageLabel={getParaformerLanguageLabel(info.language)}
                modelTag={
                  isChineseUi
                    ? undefined
                    : info.badgeKey
                      ? t(info.badgeKey, { defaultValue: info.badge || "" })
                      : info.badge
                }
                onSelect={() => handleParaformerModelSelect(modelId)}
                onDelete={() => handleParaformerDelete(modelId)}
                onDownload={() =>
                  downloadParaformerModel(modelId, (downloadedId) => {
                    setParaformerModels((prev) =>
                      prev.map((m) => (m.model === downloadedId ? { ...m, downloaded: true } : m))
                    );
                    handleParaformerModelSelect(downloadedId);
                  })
                }
                onCancel={cancelParaformerDownload}
                styles={styles}
              />
            );
          })}
        </div>

        {!isOnboarding ? (
          <>
            <div className="rounded-md border border-border/50 bg-muted/20 px-2.5 py-2">
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {t("transcription.paraformerLocalHelp")}
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">
                {t("transcription.paraformerModelDirectoryLabel")}
              </label>
              <div className="flex items-center gap-1.5">
                <Input
                  name="paraformerModelPath"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-label={t("transcription.paraformerModelDirectoryLabel")}
                  value={selectedParaformerModelPath}
                  onChange={(e) => handleParaformerModelPathChange(e.target.value)}
                  placeholder="/path/to/paraformer-large-zh"
                  className="h-8 text-sm"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="h-8 px-2 text-xs"
                  onClick={handlePickParaformerModelDirectory}
                >
                  {t("transcription.browse")}
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </div>
    );
  };

  const handleGraniteDelete = useCallback(
    (modelId: string) => {
      const selectedValueBeforeDelete =
        internalLocalProvider === "granite" && selectedGraniteModelId === modelId
          ? selectedLocalModelRef.current
          : null;
      showConfirmDialog({
        title: t("transcription.deleteModel.title"),
        description: t("transcription.deleteModel.description"),
        onConfirm: async () => {
          await deleteGraniteModel(modelId, async () => {
            await refreshModelsAndSelectFallback("granite", modelId, selectedValueBeforeDelete);
            const runtime = await window.electronAPI?.checkGraniteRuntime?.();
            if (runtime) setGraniteRuntimeStatus(runtime);
          });
        },
        variant: "destructive",
      });
    },
    [
      deleteGraniteModel,
      internalLocalProvider,
      refreshModelsAndSelectFallback,
      selectedGraniteModelId,
      showConfirmDialog,
      t,
    ]
  );

  const getGraniteRuntimeLabel = () => {
    if (!graniteRuntimeStatus) return t("transcription.graniteRuntime.checking");
    if (graniteRuntimeStatus.working) return t("transcription.graniteRuntime.ready");
    if (graniteRuntimeStatus.pythonMissing) return t("transcription.graniteRuntime.pythonMissing");
    if (graniteRuntimeStatus.installed || graniteRuntimeStatus.repairNeeded) {
      return t("transcription.graniteRuntime.repairNeeded");
    }
    return t("transcription.graniteRuntime.installNeeded");
  };

  const getGraniteActionLabel = (isDownloaded: boolean) => {
    if (!graniteRuntimeStatus?.working) {
      return isDownloaded
        ? t("transcription.graniteRuntime.installAction")
        : t("transcription.graniteRuntime.installAndDownloadAction");
    }
    if (!isDownloaded) return t("common.download");
    return t("common.use");
  };

  const renderGraniteModels = () => {
    const modelsToRender =
      graniteModels.length === 0
        ? Object.entries(GRANITE_MODEL_INFO).map(([modelId, info]) => ({
            model: modelId,
            downloaded: false,
            size_mb: info.sizeMb,
          }))
        : graniteModels;

    return (
      <div className="space-y-2">
        <div className="space-y-0.5">
          {modelsToRender.map((model) => {
            const modelId = model.model;
            const info = GRANITE_MODEL_INFO[modelId] ?? {
              name: modelId,
              description: t("transcription.fallback.graniteModelDescription"),
              size: t("common.unknown"),
              badge: undefined,
              badgeKey: undefined,
              recommended: false,
            };
            const descriptionKey = "descriptionKey" in info ? info.descriptionKey : undefined;
            const isDownloaded = model.downloaded ?? false;

            return (
              <LocalModelCard
                key={modelId}
                modelId={modelId}
                name={info.name}
                description={
                  descriptionKey
                    ? t(descriptionKey, { defaultValue: info.description })
                    : info.description
                }
                size={info.size}
                actualSizeMb={model.size_mb}
                isSelected={
                  modelId === selectedGraniteModelId && selectedLocalProvider === "granite"
                }
                isDownloaded={isDownloaded && graniteRuntimeStatus?.working === true}
                isDownloading={isDownloadingGraniteModel(modelId)}
                isCancelling={isCancellingGranite}
                idleActionLabel={getGraniteActionLabel(isDownloaded)}
                idleActionIcon={!graniteRuntimeStatus?.working ? Settings2 : Download}
                recommended={getLocalRecommended("granite", modelId, info.recommended)}
                provider="granite"
                languageLabel={t("transcription.granite.englishSpecialized")}
                modelTag={
                  info.badgeKey ? t(info.badgeKey, { defaultValue: info.badge || "" }) : info.badge
                }
                onSelect={() => handleGraniteModelSelect(modelId)}
                onDelete={() => handleGraniteDelete(modelId)}
                onDownload={() =>
                  downloadGraniteModel(modelId, (downloadedId) => {
                    setGraniteModels((prev) =>
                      prev.map((m) => (m.model === downloadedId ? { ...m, downloaded: true } : m))
                    );
                    void window.electronAPI?.checkGraniteRuntime?.().then((runtime) => {
                      if (runtime) setGraniteRuntimeStatus(runtime);
                    });
                    handleGraniteModelSelect(downloadedId);
                  })
                }
                onCancel={cancelGraniteDownload}
                styles={styles}
              />
            );
          })}
        </div>

        {!isOnboarding ? (
          <div className="rounded-md border border-border/50 bg-muted/20 px-2.5 py-2 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <Cpu className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate text-xs font-semibold text-foreground">
                  {t("transcription.graniteRuntime.title")}
                </span>
              </div>
              <span
                className={`glass-chip rounded-sm px-2 py-0.5 text-[10px] font-medium ${
                  graniteRuntimeStatus?.working
                    ? "text-success"
                    : graniteRuntimeStatus?.pythonMissing
                      ? "text-destructive"
                      : "text-muted-foreground"
                }`}
              >
                {getGraniteRuntimeLabel()}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {t("transcription.graniteLocalHelp")}
            </p>
            {graniteRuntimeStatus?.message ? (
              <p
                className={`text-[11px] leading-relaxed ${
                  graniteRuntimeStatus.working ? "text-success" : "text-muted-foreground"
                }`}
              >
                {graniteRuntimeStatus.message}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  const getExternalAsrLanguageLabel = (providerId: ExternalAsrProviderId) => {
    return providerId === "granite"
      ? t("transcription.granite.englishSpecialized")
      : t("transcription.cohere.multilingual");
  };

  const renderExternalAsrModels = (providerId: ExternalAsrProviderId) => {
    const providerModels = EXTERNAL_ASR_MODEL_INFO[providerId];
    const runtimeHelpKey =
      providerId === "granite" ? "transcription.graniteLocalHelp" : "transcription.cohereLocalHelp";
    const runtimeUrl = getExternalAsrRuntimeUrl(providerId);
    const runtimeApiKey = providerId === "granite" ? graniteRuntimeApiKey : cohereRuntimeApiKey;
    const setRuntimeUrl = providerId === "granite" ? setGraniteRuntimeUrl : setCohereRuntimeUrl;
    const setRuntimeApiKey =
      providerId === "granite" ? setGraniteRuntimeApiKey : setCohereRuntimeApiKey;
    const hasRuntimeConfigured = isExternalAsrRuntimeConfigured(providerId);
    const runtimeCheck = externalRuntimeChecks[providerId] || EXTERNAL_RUNTIME_CHECK_IDLE;
    const isRuntimeChecking = runtimeCheck.status === "checking";
    const isRuntimeReady = isExternalAsrRuntimeReady(providerId);
    const runtimeStatusLabel =
      runtimeCheck.status === "success"
        ? t("transcription.externalRuntime.ready")
        : runtimeCheck.status === "warning"
          ? t("transcription.externalRuntime.reachable")
          : runtimeCheck.status === "checking"
            ? t("transcription.externalRuntime.checking")
            : runtimeCheck.status === "error"
              ? t("transcription.externalRuntime.checkFailed")
              : hasRuntimeConfigured
                ? t("transcription.externalRuntime.checkRequired")
                : t("transcription.externalRuntime.required");
    const runtimeStatusClassName =
      runtimeCheck.status === "success"
        ? "text-success"
        : runtimeCheck.status === "warning"
          ? "text-[color:var(--ui-warning-ink)]"
          : runtimeCheck.status === "error"
            ? "text-destructive"
            : "text-muted-foreground";
    const selectedModelId = getSelectableExternalAsrModelId(providerId, selectedLocalModel);

    return (
      <div className="space-y-2">
        <div className="space-y-0.5">
          {Object.entries(providerModels).map(([modelId, info]) => {
            const isSelected =
              isRuntimeReady && selectedLocalProvider === providerId && modelId === selectedModelId;

            return (
              <LocalModelCard
                key={modelId}
                modelId={modelId}
                name={info.name}
                description={
                  info.descriptionKey
                    ? t(info.descriptionKey, { defaultValue: info.description })
                    : info.description
                }
                size={info.size}
                isSelected={isSelected}
                isDownloaded={isRuntimeReady}
                isDownloading={false}
                isCancelling={false}
                idleActionLabel={
                  hasRuntimeConfigured
                    ? t("transcription.externalRuntime.checkAction")
                    : t("transcription.externalRuntime.configureAction")
                }
                idleActionIcon={Settings2}
                showDelete={false}
                recommended={getLocalRecommended(providerId, modelId, info.recommended)}
                provider={providerId}
                languageLabel={getExternalAsrLanguageLabel(providerId)}
                modelTag={
                  info.badgeKey ? t(info.badgeKey, { defaultValue: info.badge || "" }) : info.badge
                }
                onSelect={() => handleExternalAsrModelSelect(providerId, modelId)}
                onDelete={() => {}}
                onDownload={() => {
                  if (hasRuntimeConfigured) {
                    void handleCheckExternalAsrRuntime(providerId, true);
                    return;
                  }
                  focusExternalAsrRuntimeUrl(providerId);
                }}
                onCancel={() => {}}
                styles={styles}
              />
            );
          })}
        </div>

        {!isOnboarding ? (
          <div className="rounded-md border border-border/50 bg-muted/20 px-2.5 py-2 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <Settings2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate text-xs font-semibold text-foreground">
                  {t("transcription.externalRuntime.title")}
                </span>
              </div>
              <span
                className={`glass-chip rounded-sm px-2 py-0.5 text-[10px] font-medium ${
                  runtimeStatusClassName
                }`}
              >
                {runtimeStatusLabel}
              </span>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-foreground">
                {t("transcription.externalRuntime.endpointLabel")}
              </label>
              <Input
                id={`external-asr-runtime-url-${providerId}`}
                value={runtimeUrl}
                onChange={(e) => setRuntimeUrl(e.target.value)}
                placeholder="http://127.0.0.1:8000/v1/audio/transcriptions"
                className="h-8 text-sm"
              />
              <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
                {t("transcription.externalRuntime.endpointHelp")}
              </p>
            </div>

            <ApiKeyInput
              apiKey={runtimeApiKey}
              setApiKey={setRuntimeApiKey}
              label={t("transcription.apiKeyOptional")}
              helpText={t("transcription.externalRuntime.apiKeyHelp")}
              placeholder="optional-bearer-token"
            />

            <div className="space-y-1">
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isRuntimeChecking || !hasRuntimeConfigured}
                  onClick={() => {
                    void handleCheckExternalAsrRuntime(providerId, true);
                  }}
                >
                  {isRuntimeChecking ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  {isRuntimeChecking
                    ? t("transcription.externalRuntime.checking")
                    : t("transcription.externalRuntime.checkAction")}
                </Button>
              </div>
              {runtimeCheck.status !== "idle" ? (
                <p
                  className={`text-[11px] leading-relaxed ${
                    runtimeCheck.status === "success"
                      ? "text-success"
                      : runtimeCheck.status === "warning"
                        ? "text-[color:var(--ui-warning-ink)]"
                        : runtimeCheck.status === "error"
                          ? "text-destructive"
                          : "text-muted-foreground"
                  }`}
                >
                  {runtimeCheck.message}
                </p>
              ) : null}
            </div>

            <p className="text-[11px] text-muted-foreground leading-relaxed">{t(runtimeHelpKey)}</p>
          </div>
        ) : null}
      </div>
    );
  };

  const renderAdvancedExternalAsrSection = () => {
    if (isOnboarding) return null;

    return (
      <div className="mt-3 space-y-2 border-t border-border/50 pt-3">
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-foreground">
              {t("transcription.externalRuntime.advancedTitle")}
            </p>
            <span className="glass-chip rounded-sm px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {t("transcription.externalRuntime.advancedBadge")}
            </span>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("transcription.externalRuntime.advancedDescription")}
          </p>
        </div>

        <ProviderTabs
          providers={ADVANCED_EXTERNAL_ASR_TABS}
          selectedId={advancedRuntimeProvider}
          onSelect={(providerId) => setAdvancedRuntimeProvider(providerId as ExternalAsrProviderId)}
          renderIcon={renderLocalProviderIcon}
          colorScheme={colorScheme === "purple" ? "purple" : "indigo"}
          distribution="balanced"
        />

        {renderExternalAsrModels(advancedRuntimeProvider)}
      </div>
    );
  };

  const highAccuracyRouteOptions: Array<{
    id: "cloud" | "local";
    label: string;
    description: string;
    Icon: LucideIcon;
  }> = [
    {
      id: "cloud",
      label: t("transcription.route.cloudTitle"),
      description: t("transcription.route.cloudDescription"),
      Icon: Cloud,
    },
    {
      id: "local",
      label: t("transcription.route.localTitle"),
      description: t("transcription.route.localDescription"),
      Icon: Lock,
    },
  ];

  return (
    <div className={`space-y-2 ${className}`}>
      <div className={`${styles.container} p-3`}>
        <div className="grid gap-2 md:grid-cols-2">
          {highAccuracyRouteOptions.map(({ id, label, description, Icon }) => {
            const isSelected = useLocalWhisper ? id === "local" : id === "cloud";

            return (
              <button
                key={id}
                type="button"
                onClick={() => handleModeChange(id === "local")}
                aria-pressed={isSelected}
                className={`mode-depth-card group flex min-h-[5.25rem] w-full items-center gap-3 rounded-xl border px-4 py-3 text-left shadow-sm transition-[background-color,border-color,box-shadow,color,transform] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
                  isSelected
                    ? "mode-depth-card--active border-primary/35 bg-primary/10 text-foreground shadow-[0_16px_34px_rgba(96,165,250,0.18)]"
                    : "border-border/70 bg-card/40 text-muted-foreground hover:-translate-y-[1px] hover:border-primary/20 hover:bg-card/60 hover:text-foreground"
                }`}
              >
                <span
                  className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border ${
                    isSelected
                      ? "border-primary/25 bg-primary/12 text-primary"
                      : "border-border/60 bg-card/50 text-muted-foreground"
                  }`}
                >
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[15px] font-semibold tracking-normal">
                      {label}
                    </span>
                    {isSelected ? (
                      <span className="glass-chip glass-chip--accent rounded-sm px-2 py-0.5 text-[10px] font-semibold text-primary">
                        {t("common.active")}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-1 block truncate text-[11px] leading-relaxed text-muted-foreground/80">
                    {description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {!useLocalWhisper ? (
        <div className={styles.container}>
          <div className="p-3 pb-0">
            <p className="mb-2 text-xs font-semibold text-foreground">
              {t("transcription.route.cloudProviderLabel")}
            </p>
            <ProviderTabs
              providers={visibleCloudProviderTabs}
              selectedId={selectedCloudProvider}
              onSelect={handleCloudProviderChange}
              colorScheme={colorScheme === "purple" ? "purple" : "indigo"}
              distribution="balanced"
              balancedMaxColumns={4}
            />
          </div>

          <div className="p-3">
            {selectedCloudProvider === "custom" ? (
              <div className="space-y-2">
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-foreground">
                    {t("transcription.endpointUrl")}
                  </label>
                  <Input
                    name="customTranscriptionEndpoint"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    inputMode="url"
                    aria-label={t("transcription.endpointUrl")}
                    value={cloudTranscriptionBaseUrl}
                    onChange={(e) => {
                      const nextValue = e.target.value;
                      setCloudTranscriptionBaseUrl?.(nextValue);
                      rememberCustomTranscriptionBaseUrl(nextValue);
                    }}
                    onBlur={handleBaseUrlBlur}
                    placeholder="https://your-api.example.com/v1"
                    className="h-8 text-sm"
                  />
                </div>

                <ApiKeyInput
                  apiKey={customTranscriptionApiKey}
                  setApiKey={setCustomTranscriptionApiKey || (() => {})}
                  provider="custom"
                  label={t("transcription.apiKeyOptional")}
                  helpText=""
                />

                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-foreground">
                    {t("transcription.customModelIdLabel")}
                  </label>
                  <Input
                    name="customTranscriptionModelId"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    aria-label={t("transcription.customModelIdLabel")}
                    value={selectedCloudModel}
                    onChange={(e) => handleCloudModelIdInputChange(e.target.value)}
                    placeholder={cloudModelIdPlaceholder}
                    className="h-8 text-sm"
                  />
                  <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
                    {t("transcription.customModelIdHint")}
                  </p>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-end">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={cloudConnectionTest.status === "testing"}
                      onClick={() => {
                        void handleTestCloudConnection();
                      }}
                    >
                      {cloudConnectionTest.status === "testing" ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          {testingLabel}
                        </>
                      ) : (
                        testButtonLabel
                      )}
                    </Button>
                  </div>
                  {cloudConnectionTest.status !== "idle" ? (
                    <p
                      className={`text-[11px] leading-relaxed ${
                        cloudConnectionTest.status === "success"
                          ? "text-success"
                          : cloudConnectionTest.status === "warning"
                            ? "text-[color:var(--ui-warning-ink)]"
                            : cloudConnectionTest.status === "error"
                              ? "text-destructive"
                              : "text-muted-foreground"
                      }`}
                    >
                      {cloudConnectionTest.message}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {selectedCloudProvider === "doubao" ? (
                  <>
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <label className="text-xs font-medium text-foreground">
                          {t("transcription.appId")}
                        </label>
                        {!isOnboarding ? (
                          <button
                            type="button"
                            onClick={createExternalLinkHandler(selectedCloudGuideUrl)}
                            className="text-[11px] text-white/70 hover:text-white transition-colors cursor-pointer"
                          >
                            {t("transcription.getKey")}
                          </button>
                        ) : null}
                      </div>
                      <Input
                        name="doubaoAppId"
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        aria-label={t("transcription.appId")}
                        value={doubaoAppId}
                        onChange={(e) => setDoubaoAppId(e.target.value)}
                        placeholder="123456789"
                        className="h-8 text-sm"
                      />
                    </div>

                    <ApiKeyInput
                      apiKey={doubaoAccessToken}
                      setApiKey={setDoubaoAccessToken}
                      label={t("transcription.accessToken")}
                      helpText=""
                      placeholder="your-access-token"
                    />
                  </>
                ) : selectedCloudProvider === "deepgram" ? (
                  <>
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <label className="text-xs font-medium text-foreground">
                          {t("transcription.endpointUrl")}
                        </label>
                        {!isOnboarding ? (
                          <button
                            type="button"
                            onClick={createExternalLinkHandler(selectedCloudGuideUrl)}
                            className="text-[11px] text-white/70 hover:text-white transition-colors cursor-pointer"
                          >
                            {t("transcription.getKey")}
                          </button>
                        ) : null}
                      </div>
                      <Input
                        name="deepgramEndpoint"
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        inputMode="url"
                        aria-label={t("transcription.endpointUrl")}
                        value={cloudTranscriptionBaseUrl}
                        onChange={(e) => handleCloudProviderBaseUrlInputChange(e.target.value)}
                        placeholder="https://api.deepgram.com/v1/listen"
                        className="h-8 text-sm"
                      />
                      <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
                        {t("transcription.deepgram.endpointHelp")}
                      </p>
                    </div>

                    <ApiKeyInput
                      apiKey={deepgramApiKey}
                      setApiKey={setDeepgramApiKey}
                      label={t("common.apiKey")}
                      helpText={t("transcription.deepgram.apiKeyHelp")}
                      placeholder={t("transcription.deepgram.apiKeyPlaceholder")}
                    />
                  </>
                ) : selectedCloudProvider === "google-cloud" ? (
                  <>
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <label className="text-xs font-medium text-foreground">
                          {t("transcription.endpointUrl")}
                        </label>
                        {!isOnboarding ? (
                          <button
                            type="button"
                            onClick={createExternalLinkHandler(selectedCloudGuideUrl)}
                            className="text-[11px] text-white/70 hover:text-white transition-colors cursor-pointer"
                          >
                            {t("transcription.getKey")}
                          </button>
                        ) : null}
                      </div>
                      <Input
                        name="googleCloudTranscriptionEndpoint"
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        inputMode="url"
                        aria-label={t("transcription.endpointUrl")}
                        value={cloudTranscriptionBaseUrl}
                        onChange={(e) => handleCloudProviderBaseUrlInputChange(e.target.value)}
                        placeholder="https://us-speech.googleapis.com/v2/projects/PROJECT_ID/locations/us/recognizers/_:recognize"
                        className="h-8 text-sm"
                      />
                      <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
                        {t("transcription.googleCloud.endpointHelp")}
                      </p>
                    </div>

                    <ApiKeyInput
                      apiKey={googleSttApiKey}
                      setApiKey={setGoogleSttApiKey}
                      label={t("transcription.googleCloud.credential")}
                      helpText={t("transcription.googleCloud.credentialHelp")}
                      placeholder={t("transcription.googleCloud.credentialPlaceholder")}
                    />
                  </>
                ) : (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium text-foreground">
                        {t("common.apiKey")}
                      </label>
                      {!isOnboarding ? (
                        <button
                          type="button"
                          onClick={createExternalLinkHandler(selectedCloudGuideUrl)}
                          className="text-[11px] text-white/70 hover:text-white transition-colors cursor-pointer"
                        >
                          {t("transcription.getKey")}
                        </button>
                      ) : null}
                    </div>
                    <ApiKeyInput
                      apiKey={
                        {
                          groq: groqApiKey,
                          soniox: sonioxApiKey,
                          deepgram: deepgramApiKey,
                          openai: openaiApiKey,
                        }[selectedCloudProvider] || openaiApiKey
                      }
                      setApiKey={
                        {
                          groq: setGroqApiKey,
                          soniox: setSonioxApiKey,
                          deepgram: setDeepgramApiKey,
                          openai: setOpenaiApiKey,
                        }[selectedCloudProvider] || setOpenaiApiKey
                      }
                      provider={
                        (
                          {
                            groq: "groq",
                            soniox: "soniox",
                            deepgram: "deepgram",
                            openai: "openai",
                          } as const
                        )[selectedCloudProvider as "groq" | "soniox" | "deepgram" | "openai"] ??
                        "openai"
                      }
                      label=""
                      helpText=""
                    />
                  </div>
                )}

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">{t("common.model")}</label>
                  <ModelCardList
                    models={displayedCloudModelOptions}
                    selectedModel={selectedCloudModel}
                    onModelSelect={handleCloudModelSelect}
                    colorScheme={colorScheme === "purple" ? "purple" : "indigo"}
                  />
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-foreground">
                      {t("transcription.customModelIdLabel")}
                    </label>
                    <Input
                      name={`${selectedCloudProvider}TranscriptionModelId`}
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      aria-label={t("transcription.customModelIdLabel")}
                      value={selectedCloudModel}
                      onChange={(e) => handleCloudModelIdInputChange(e.target.value)}
                      placeholder={cloudModelIdPlaceholder}
                      className="h-8 text-sm"
                    />
                    <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
                      {t("transcription.customModelIdHint")}
                    </p>
                  </div>
                </div>

                {selectedCloudProvider === "doubao" ? (
                  <div className="space-y-1.5">
                    <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
                      {t("transcription.connectionTest.doubao.autoHint")}
                    </p>
                    <div className="flex items-center justify-end">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={cloudConnectionTest.status === "testing"}
                        onClick={() => {
                          void handleTestCloudConnection();
                        }}
                      >
                        {cloudConnectionTest.status === "testing" ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            {testingLabel}
                          </>
                        ) : (
                          testButtonLabel
                        )}
                      </Button>
                    </div>
                    {cloudConnectionTest.status !== "idle" ? (
                      <p
                        className={`text-[11px] leading-relaxed ${
                          cloudConnectionTest.status === "success"
                            ? "text-success"
                            : cloudConnectionTest.status === "warning"
                              ? "text-[color:var(--ui-warning-ink)]"
                              : cloudConnectionTest.status === "error"
                                ? "text-destructive"
                                : "text-muted-foreground"
                        }`}
                      >
                        {cloudConnectionTest.message}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {TESTABLE_CLOUD_PROVIDERS.has(selectedCloudProvider) &&
                selectedCloudProvider !== "doubao" ? (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-end">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={cloudConnectionTest.status === "testing"}
                        onClick={() => {
                          void handleTestCloudConnection();
                        }}
                      >
                        {cloudConnectionTest.status === "testing" ? (
                          <>
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            {testingLabel}
                          </>
                        ) : (
                          testButtonLabel
                        )}
                      </Button>
                    </div>
                    {cloudConnectionTest.status !== "idle" ? (
                      <p
                        className={`text-[11px] leading-relaxed ${
                          cloudConnectionTest.status === "success"
                            ? "text-success"
                            : cloudConnectionTest.status === "warning"
                              ? "text-[color:var(--ui-warning-ink)]"
                              : cloudConnectionTest.status === "error"
                                ? "text-destructive"
                                : "text-muted-foreground"
                        }`}
                      >
                        {cloudConnectionTest.message}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className={styles.container}>
          <div className="p-3 pb-0">
            <p className="mb-2 text-xs font-semibold text-foreground">
              {t("transcription.route.localBuiltInProviderLabel")}
            </p>
            <ProviderTabs
              providers={visibleLocalProviderTabs}
              selectedId={internalLocalProvider}
              onSelect={handleLocalProviderChange}
              renderIcon={renderLocalProviderIcon}
              colorScheme={colorScheme === "purple" ? "purple" : "indigo"}
              distribution="balanced"
              balancedMaxColumns={4}
            />
          </div>

          {progressDisplay}

          <div className="p-3">
            {internalLocalProvider === "whisper" && renderLocalModels()}
            {internalLocalProvider === "nvidia" && renderParakeetModels()}
            {internalLocalProvider === "paraformer" && renderParaformerModels()}
            {internalLocalProvider === "granite" && renderGraniteModels()}
            {SHOW_ADVANCED_EXTERNAL_ASR_IN_CUSTOMER_UI ? renderAdvancedExternalAsrSection() : null}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => !open && hideConfirmDialog()}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
      />
    </div>
  );
}
