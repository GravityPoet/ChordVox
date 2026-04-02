import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Download,
  Trash2,
  Cloud,
  Lock,
  X,
  Boxes,
  Loader2,
} from "lucide-react";
import { ProviderIcon } from "./ui/ProviderIcon";
import { ProviderTabs } from "./ui/ProviderTabs";
import ModelCardList from "./ui/ModelCardList";
import { DownloadProgressBar } from "./ui/DownloadProgressBar";
import ApiKeyInput from "./ui/ApiKeyInput";
import { ConfirmDialog } from "./ui/dialog";
import { useDialogs } from "../hooks/useDialogs";
import { useModelDownload, type DownloadProgress } from "../hooks/useModelDownload";
import {
  getTranscriptionProviders,
  TranscriptionProviderData,
  WHISPER_MODEL_INFO,
  PARAKEET_MODEL_INFO,
  SENSEVOICE_MODEL_INFO,
} from "../models/ModelRegistry";
import {
  MODEL_PICKER_COLORS,
  type ColorScheme,
  type ModelPickerStyles,
} from "../utils/modelPickerStyles";
import { getProviderIcon, isMonochromeProvider } from "../utils/providerIcons";
import { API_ENDPOINTS } from "../config/constants";
import { createExternalLinkHandler } from "../utils/externalLinks";
import { getProviderGuideUrl } from "../utils/providerGuideLinks";
import { addChordVoxModelsClearedListener } from "../utils/chordvoxCloud";

interface LocalModel {
  model: string;
  size_mb?: number;
  downloaded?: boolean;
  modelPath?: string;
  path?: string;
  runtimeKind?: "sensevoice";
}

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
  downloadProgress?: DownloadProgress;
  isInstalling?: boolean;
  recommended?: boolean;
  provider: string;
  languageLabel?: string;
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
  downloadProgress,
  isInstalling = false,
  recommended,
  provider,
  languageLabel,
  onSelect,
  onDelete,
  onDownload,
  onCancel,
  styles: cardStyles,
}: LocalModelCardProps) {
  const { t } = useTranslation();
  const percentage = Math.max(0, Math.min(100, Math.round(downloadProgress?.percentage || 0)));
  const indeterminate =
    isDownloading &&
    !isInstalling &&
    (downloadProgress?.totalBytes || 0) === 0 &&
    (downloadProgress?.downloadedBytes || 0) > 0;
  const handleClick = () => {
    if (isDownloaded && !isSelected) {
      onSelect();
    }
  };

  return (
    <div
      onClick={handleClick}
      className={`relative w-full text-left overflow-hidden rounded-md border transition-all duration-200 group ${
        isSelected ? cardStyles.modelCard.selected : cardStyles.modelCard.default
      } ${isDownloaded && !isSelected ? "cursor-pointer" : ""}`}
    >
      {isSelected && (
        <div className="absolute left-0 top-0 bottom-0 w-1 bg-linear-to-b from-primary via-primary to-primary/80 rounded-l-md" />
      )}
      <div className="flex items-center gap-1.5 p-2 pl-2.5">
        <div className="shrink-0">
          {isDownloaded ? (
            <div
              className={`w-1.5 h-1.5 rounded-full ${
                isSelected
                  ? "bg-primary shadow-[0_0_6px_oklch(0.62_0.22_260/0.6)] animate-[pulse-glow_2s_ease-in-out_infinite]"
                  : "bg-success shadow-[0_0_4px_rgba(34,197,94,0.5)]"
              }`}
            />
          ) : isDownloading ? (
            <div className="w-1.5 h-1.5 rounded-full bg-amber-500 shadow-[0_0_4px_rgba(245,158,11,0.5)] animate-[spinner-rotate_1s_linear_infinite]" />
          ) : (
            <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/20" />
          )}
        </div>

        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          {provider === "sensevoice" ? (
            <Boxes className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ProviderIcon provider={provider} className="w-3.5 h-3.5 shrink-0" />
          )}
          <span className="font-semibold text-sm text-foreground truncate tracking-tight">
            {name}
          </span>
          <span className="text-[11px] text-muted-foreground/50 tabular-nums shrink-0">
            {actualSizeMb ? `${actualSizeMb}MB` : size}
          </span>
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
          {isDownloaded ? (
            <>
              {isSelected && (
                <span className="text-[10px] font-medium text-primary px-2 py-0.5 bg-primary/10 rounded-sm">
                  {t("common.active")}
                </span>
              )}
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0 text-muted-foreground/40 hover:text-destructive opacity-0 group-hover:opacity-100 transition-all active:scale-95"
              >
                <Trash2 size={12} />
              </Button>
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
              <X size={11} className="mr-0.5" />
              {isCancelling ? "..." : t("common.cancel")}
            </Button>
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
              <Download size={11} className="mr-1" />
              {t("common.download")}
            </Button>
          )}
        </div>
      </div>

      {isDownloading ? (
        <div className="px-2.5 pb-2 pt-0.5">
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="text-muted-foreground">
              {isInstalling ? `Installing ${name}` : `Downloading ${name}`}
            </span>
            <span className="font-semibold text-primary tabular-nums">
              {indeterminate ? "···" : `${percentage}%`}
            </span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-primary/10">
            {indeterminate ? (
              <div className="h-full w-1/3 rounded-full bg-primary animate-[indeterminate_1.5s_ease-in-out_infinite]" />
            ) : (
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                style={{ width: `${Math.max(percentage, 2)}%` }}
              />
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface TranscriptionModelPickerProps {
  selectedCloudProvider: string;
  onCloudProviderSelect: (providerId: string) => void;
  selectedCloudModel: string;
  onCloudModelSelect: (modelId: string) => void;
  selectedLocalModel: string;
  onLocalModelSelect: (modelId: string, providerId?: string) => void;
  selectedLocalProvider?: string;
  onLocalProviderSelect?: (providerId: string) => void;
  useLocalWhisper: boolean;
  onModeChange: (useLocal: boolean) => void;
  senseVoiceModelPath?: string;
  setSenseVoiceModelPath?: (path: string) => void;
  senseVoiceBinaryPath?: string;
  setSenseVoiceBinaryPath?: (path: string) => void;
  openaiApiKey: string;
  setOpenaiApiKey: (key: string) => void;
  groqApiKey: string;
  setGroqApiKey: (key: string) => void;
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
  { id: "groq", name: "Groq", recommended: true },
  { id: "doubao", name: "Doubao" },
  { id: "custom", name: "Custom" },
];

const VALID_CLOUD_PROVIDER_IDS = CLOUD_PROVIDER_TABS.map((p) => p.id);

const LOCAL_PROVIDER_TABS: Array<{ id: string; name: string; disabled?: boolean }> = [
  { id: "whisper", name: "OpenAI Whisper" },
  { id: "nvidia", name: "NVIDIA Parakeet" },
  { id: "sensevoice", name: "SenseVoice" },
];

const OTHERS_VISIBLE_MODEL_IDS = new Set([
  "sense-voice-small-q4_0",
  "sense-voice-small-q5_k",
  "sense-voice-small-q8_0",
  "sense-voice-small-fp16",
  "sense-voice-small-fp32",
]);
const TESTABLE_CLOUD_PROVIDERS = new Set(["openai", "groq", "doubao"]);

function isLikelyPathInput(value: string) {
  const raw = String(value || "").trim();
  return raw.includes("/") || raw.includes("\\");
}

interface ModeToggleProps {
  useLocalWhisper: boolean;
  onModeChange: (useLocal: boolean) => void;
}

function ModeToggle({ useLocalWhisper, onModeChange }: ModeToggleProps) {
  const { t } = useTranslation();
  return (
    <div className="relative flex p-0.5 rounded-lg bg-surface-1/80 backdrop-blur-xl dark:bg-surface-1 border border-border/60 dark:border-white/8 shadow-(--shadow-metallic-light) dark:shadow-(--shadow-metallic-dark)">
      <div
        className={`absolute top-0.5 bottom-0.5 w-[calc(50%-2px)] rounded-md bg-card border border-border/60 dark:border-border-subtle shadow-(--shadow-metallic-light) dark:shadow-(--shadow-metallic-dark) transition-transform duration-200 ease-out ${
          useLocalWhisper ? "translate-x-[calc(100%)]" : "translate-x-0"
        }`}
      />
      <button
        onClick={() => onModeChange(false)}
        className={`relative z-10 flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md transition-colors duration-150 ${
          !useLocalWhisper ? "text-foreground" : "text-muted-foreground hover:text-foreground"
        }`}
      >
        <Cloud className="w-3.5 h-3.5" />
        <span className="text-xs font-medium">{t("common.cloud")}</span>
      </button>
      <button
        onClick={() => onModeChange(true)}
        className={`relative z-10 flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md transition-colors duration-150 ${
          useLocalWhisper ? "text-foreground" : "text-muted-foreground hover:text-foreground"
        }`}
      >
        <Lock className="w-3.5 h-3.5" />
        <span className="text-xs font-medium">{t("common.local")}</span>
      </button>
    </div>
  );
}

export default function TranscriptionModelPicker({
  selectedCloudProvider,
  onCloudProviderSelect,
  selectedCloudModel,
  onCloudModelSelect,
  selectedLocalModel,
  onLocalModelSelect,
  selectedLocalProvider = "whisper",
  onLocalProviderSelect,
  useLocalWhisper,
  onModeChange,
  senseVoiceModelPath = "",
  setSenseVoiceModelPath,
  senseVoiceBinaryPath = "",
  setSenseVoiceBinaryPath,
  openaiApiKey,
  setOpenaiApiKey,
  groqApiKey,
  setGroqApiKey,
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
  const { t } = useTranslation();
  const isOnboarding = variant === "onboarding";
  const [localModels, setLocalModels] = useState<LocalModel[]>([]);
  const [parakeetModels, setParakeetModels] = useState<LocalModel[]>([]);
  const [senseVoiceModels, setSenseVoiceModels] = useState<LocalModel[]>([]);
  const [internalLocalProvider, setInternalLocalProvider] = useState(selectedLocalProvider);
  const [pendingSenseVoiceModelId, setPendingSenseVoiceModelId] = useState("");
  const [cloudConnectionTest, setCloudConnectionTest] = useState<CloudConnectionTestState>({
    status: "idle",
    message: "",
  });
  const hasLoadedRef = useRef(false);
  const hasLoadedParakeetRef = useRef(false);
  const hasLoadedSenseVoiceRef = useRef(false);

  useEffect(() => {
    if (selectedLocalProvider !== internalLocalProvider) {
      setInternalLocalProvider(selectedLocalProvider);
    }
  }, [selectedLocalProvider]);

  useEffect(() => {
    if (cloudConnectionTest.status === "idle") return;
    setCloudConnectionTest({ status: "idle", message: "" });
  }, [
    selectedCloudProvider,
    selectedCloudModel,
    doubaoAppId,
    doubaoAccessToken,
    openaiApiKey,
    groqApiKey,
  ]);
  const isLoadingRef = useRef(false);
  const isLoadingParakeetRef = useRef(false);
  const isLoadingSenseVoiceRef = useRef(false);
  const loadLocalModelsRef = useRef<(() => Promise<void>) | null>(null);
  const loadParakeetModelsRef = useRef<(() => Promise<void>) | null>(null);
  const loadSenseVoiceModelsRef = useRef<(() => Promise<void>) | null>(null);
  const ensureValidCloudSelectionRef = useRef<(() => void) | null>(null);
  const selectedLocalModelRef = useRef(selectedLocalModel);
  const onLocalModelSelectRef = useRef(onLocalModelSelect);

  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const colorScheme: ColorScheme = variant === "settings" ? "purple" : "blue";
  const styles = useMemo(() => MODEL_PICKER_COLORS[colorScheme], [colorScheme]);
  const cloudProviders = useMemo(() => getTranscriptionProviders(), []);
  const cloudProviderTabs = CLOUD_PROVIDER_TABS.map((provider) =>
    provider.id === "custom" ? { ...provider, name: t("transcription.customProvider") } : provider
  );
  const visibleCloudProviderTabs =
    isOnboarding && selectedCloudProvider !== "custom"
      ? cloudProviderTabs.filter((provider) => provider.id !== "custom")
      : cloudProviderTabs;
  const visibleLocalProviderTabs =
    isOnboarding && internalLocalProvider !== "nvidia"
      ? LOCAL_PROVIDER_TABS.filter((provider) => provider.id !== "nvidia")
      : LOCAL_PROVIDER_TABS;

  useEffect(() => {
    selectedLocalModelRef.current = selectedLocalModel;
  }, [selectedLocalModel]);
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

  const loadSenseVoiceModels = useCallback(async () => {
    if (isLoadingSenseVoiceRef.current) return;
    isLoadingSenseVoiceRef.current = true;

    try {
      const result = await window.electronAPI?.listSenseVoiceModels();
      if (result?.success) {
        setSenseVoiceModels(result.models);
      }
    } catch (error) {
      console.error("[TranscriptionModelPicker] Failed to load SenseVoice models:", error);
      setSenseVoiceModels([]);
    } finally {
      isLoadingSenseVoiceRef.current = false;
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
        const firstProvider = cloudProviders[0];
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
    loadSenseVoiceModelsRef.current = loadSenseVoiceModels;
  }, [loadSenseVoiceModels]);
  useEffect(() => {
    ensureValidCloudSelectionRef.current = ensureValidCloudSelection;
  }, [ensureValidCloudSelection]);

  useEffect(() => {
    if (!useLocalWhisper) return;

    if (internalLocalProvider === "whisper" && !hasLoadedRef.current) {
      hasLoadedRef.current = true;
      loadLocalModelsRef.current?.();
    } else if (internalLocalProvider === "nvidia" && !hasLoadedParakeetRef.current) {
      hasLoadedParakeetRef.current = true;
      loadParakeetModelsRef.current?.();
    } else if (internalLocalProvider === "sensevoice" && !hasLoadedSenseVoiceRef.current) {
      hasLoadedSenseVoiceRef.current = true;
      loadSenseVoiceModelsRef.current?.();
    }
  }, [useLocalWhisper, internalLocalProvider]);

  useEffect(() => {
    if (useLocalWhisper) return;

    hasLoadedRef.current = false;
    hasLoadedParakeetRef.current = false;
    hasLoadedSenseVoiceRef.current = false;
    ensureValidCloudSelectionRef.current?.();
  }, [useLocalWhisper]);

  useEffect(() => {
    const handleModelsCleared = () => {
      loadLocalModels();
      loadParakeetModels();
      loadSenseVoiceModels();
    };
    return addChordVoxModelsClearedListener(window, handleModelsCleared);
  }, [loadLocalModels, loadParakeetModels, loadSenseVoiceModels]);

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
    downloadingModel: downloadingSenseVoiceModel,
    downloadProgress: senseVoiceDownloadProgress,
    downloadModel: downloadSenseVoiceModel,
    deleteModel: deleteSenseVoiceModel,
    isDownloadingModel: isDownloadingSenseVoiceModel,
    isInstalling: isInstallingSenseVoice,
    cancelDownload: cancelSenseVoiceDownload,
    isCancelling: isCancellingSenseVoice,
  } = useModelDownload({
    modelType: "sensevoice",
    onDownloadComplete: loadSenseVoiceModels,
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
      onCloudProviderSelect(providerId);
      const provider = cloudProviders.find((p) => p.id === providerId);

      if (providerId === "custom") {
        onCloudModelSelect("whisper-1");
        return;
      }

      if (provider) {
        setCloudTranscriptionBaseUrl?.(provider.baseUrl);
        if (provider.models?.length) {
          onCloudModelSelect(provider.models[0].id);
        }
      }
    },
    [cloudProviders, onCloudProviderSelect, onCloudModelSelect, setCloudTranscriptionBaseUrl]
  );

  const handleLocalProviderChange = useCallback(
    (providerId: string) => {
      const tab = LOCAL_PROVIDER_TABS.find((t) => t.id === providerId);
      if (tab?.disabled) return;
      setInternalLocalProvider(providerId);
      onLocalProviderSelect?.(providerId);
    },
    [onLocalProviderSelect]
  );

  const handleWhisperModelSelect = useCallback(
    (modelId: string) => {
      onLocalProviderSelect?.("whisper");
      setInternalLocalProvider("whisper");
      onLocalModelSelect(modelId, "whisper");
    },
    [onLocalModelSelect, onLocalProviderSelect]
  );

  const handleParakeetModelSelect = useCallback(
    (modelId: string) => {
      onLocalProviderSelect?.("nvidia");
      setInternalLocalProvider("nvidia");
      onLocalModelSelect(modelId, "nvidia");
    },
    [onLocalModelSelect, onLocalProviderSelect]
  );

  const selectedWhisperModelId = useMemo(() => {
    const rawValue = String(selectedLocalModel || "").trim();
    if (!rawValue || isLikelyPathInput(rawValue)) {
      const normalizedPath = rawValue.toLowerCase();
      if (!normalizedPath) return "";
      const byPath = localModels.find(
        (model) => String(model.path || "").trim().toLowerCase() === normalizedPath
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
        (model) => String(model.path || "").trim().toLowerCase() === normalizedPath
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
      onLocalProviderSelect?.("nvidia");
      setInternalLocalProvider("nvidia");
      onLocalModelSelect(value, "nvidia");
    },
    [onLocalModelSelect, onLocalProviderSelect]
  );

  const handlePickParakeetModelDirectory = useCallback(async () => {
    try {
      const result = await window.electronAPI?.pickParakeetModelDirectory?.(
        selectedParakeetModelPath
      );
      if (result?.success && result.path) {
        handleParakeetModelPathChange(result.path);
      }
    } catch (error) {
      console.error("[TranscriptionModelPicker] Failed to pick Parakeet model directory:", error);
    }
  }, [selectedParakeetModelPath, handleParakeetModelPathChange]);

  const selectedSenseVoiceModelId = useMemo(() => {
    const currentPath = String(senseVoiceModelPath || "")
      .trim()
      .toLowerCase()
      .replace(/\\/g, "/");
    if (!currentPath) return "";

    const fromLoaded = senseVoiceModels.find((model) => {
      const candidatePath = String(model.modelPath || model.path || "")
        .trim()
        .toLowerCase()
        .replace(/\\/g, "/");
      return candidatePath && candidatePath === currentPath;
    });
    if (fromLoaded?.model) return fromLoaded.model;

    for (const [modelId, info] of Object.entries(SENSEVOICE_MODEL_INFO)) {
      const relativeDir = String(info.customRelativeDir || "")
        .trim()
        .toLowerCase()
        .replace(/\\/g, "/");
      if (relativeDir && currentPath.includes(relativeDir)) {
        return modelId;
      }
    }

    const fileName = currentPath.split(/[\\/]/).pop() || "";
    const fileNameMatches = Object.entries(SENSEVOICE_MODEL_INFO).filter(
      ([, info]) => info.fileName.toLowerCase() === fileName
    );
    if (fileNameMatches.length === 1) {
      return fileNameMatches[0][0];
    }
    return "";
  }, [senseVoiceModelPath, senseVoiceModels]);

  const effectiveSelectedSenseVoiceModelId =
    pendingSenseVoiceModelId || selectedSenseVoiceModelId;

  const selectedOthersRuntimeKind = "sensevoice";

  useEffect(() => {
    if (internalLocalProvider !== "sensevoice" && pendingSenseVoiceModelId) {
      setPendingSenseVoiceModelId("");
    }
  }, [internalLocalProvider, pendingSenseVoiceModelId]);

  useEffect(() => {
    if (!pendingSenseVoiceModelId) return;
    if (selectedSenseVoiceModelId === pendingSenseVoiceModelId) {
      setPendingSenseVoiceModelId("");
    }
  }, [pendingSenseVoiceModelId, selectedSenseVoiceModelId]);

  const handleSenseVoiceModelPathChange = useCallback(
    (value: string) => {
      if (!String(value || "").trim()) {
        setPendingSenseVoiceModelId("");
      }
      setSenseVoiceModelPath?.(value);
      onLocalProviderSelect?.("sensevoice");
      setInternalLocalProvider("sensevoice");
      onLocalModelSelect(value, "sensevoice");
    },
    [onLocalModelSelect, onLocalProviderSelect, setSenseVoiceModelPath]
  );

  const handleSenseVoiceModelSelect = useCallback(
    async (modelId: string) => {
      setPendingSenseVoiceModelId(modelId);
      onLocalProviderSelect?.("sensevoice");
      setInternalLocalProvider("sensevoice");

      try {
        const status = await window.electronAPI?.checkSenseVoiceModelStatus(modelId);
        if (status?.downloaded && status.modelPath) {
          handleSenseVoiceModelPathChange(status.modelPath);
          return;
        }
      } catch (error) {
        console.error("[TranscriptionModelPicker] Failed to resolve SenseVoice model path:", error);
      }

      const fallback = senseVoiceModels.find((model) => model.model === modelId);
      const fallbackPath = fallback?.modelPath || fallback?.path || "";
      if (fallbackPath) {
        handleSenseVoiceModelPathChange(fallbackPath);
        return;
      }

      setPendingSenseVoiceModelId("");
    },
    [handleSenseVoiceModelPathChange, onLocalProviderSelect, senseVoiceModels]
  );

  const handleSenseVoiceBinaryPathChange = useCallback(
    (value: string) => {
      setSenseVoiceBinaryPath?.(value);
      onLocalProviderSelect?.("sensevoice");
      setInternalLocalProvider("sensevoice");
    },
    [onLocalProviderSelect, setSenseVoiceBinaryPath]
  );

  const handlePickSenseVoiceModel = useCallback(async () => {
    try {
      const result = await window.electronAPI?.pickSenseVoiceModelFile?.(senseVoiceModelPath);
      if (result?.success && result.path) {
        handleSenseVoiceModelPathChange(result.path);
      }
    } catch (error) {
      console.error("[TranscriptionModelPicker] Failed to pick SenseVoice model:", error);
    }
  }, [senseVoiceModelPath, handleSenseVoiceModelPathChange]);

  const handlePickSenseVoiceBinary = useCallback(async () => {
    try {
      const result = await window.electronAPI?.pickSenseVoiceBinary?.(senseVoiceBinaryPath);
      if (result?.success && result.path) {
        handleSenseVoiceBinaryPathChange(result.path);
      }
    } catch (error) {
      console.error("[TranscriptionModelPicker] Failed to pick SenseVoice binary:", error);
    }
  }, [senseVoiceBinaryPath, handleSenseVoiceBinaryPathChange]);


  const handleBaseUrlBlur = useCallback(() => {
    if (!setCloudTranscriptionBaseUrl || selectedCloudProvider !== "custom") return;

    const trimmed = (cloudTranscriptionBaseUrl || "").trim();
    if (!trimmed) return;

    const { normalizeBaseUrl } = require("../config/constants");
    const normalized = normalizeBaseUrl(trimmed);

    if (normalized && normalized !== cloudTranscriptionBaseUrl) {
      setCloudTranscriptionBaseUrl(normalized);
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
  ]);

  const handleDelete = useCallback(
    (modelId: string) => {
      showConfirmDialog({
        title: t("transcription.deleteModel.title"),
        description: t("transcription.deleteModel.description"),
        onConfirm: async () => {
          await deleteModel(modelId, async () => {
            const result = await window.electronAPI?.listWhisperModels();
            if (result?.success) {
              setLocalModels(result.models);
              validateAndSelectModel(result.models);
            }
          });
        },
        variant: "destructive",
      });
    },
    [showConfirmDialog, deleteModel, validateAndSelectModel, t]
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

  const isChineseUi = t("common.cloud") === "云端";
  const testButtonLabel = isChineseUi ? "测试连接" : "Test Connection";
  const testingLabel = isChineseUi ? "测试中" : "Testing";

  const getCloudProviderLabel = useCallback(
    (providerId: string) => {
      if (providerId === "openai") return "OpenAI";
      if (providerId === "groq") return "Groq";
      if (providerId === "doubao") return "Doubao";
      return providerId;
    },
    []
  );

  const getDoubaoModelLabel = useCallback(
    (modelId?: string) => {
      if (modelId === "doubao-seedasr-streaming-2.0") {
        return isChineseUi ? "流式 2.0" : "Streaming 2.0";
      }
      if (modelId === "doubao-bigasr-streaming-1.0") {
        return isChineseUi ? "流式 1.0（兼容）" : "Streaming 1.0 (Compatibility)";
      }
      return isChineseUi ? "自动（推荐）" : "Auto (Recommended)";
    },
    [isChineseUi]
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
        message: isChineseUi ? "当前版本不支持连接测试。" : "This build does not support connection testing.",
      });
      return;
    }

    setCloudConnectionTest({
      status: "testing",
      message: isChineseUi ? "正在测试 Doubao 连接..." : "Testing Doubao connection...",
    });

    try {
      const result = await window.electronAPI.testDoubaoConnection({
        appId: doubaoAppId,
        accessToken: doubaoAccessToken,
        model: selectedCloudModel,
      });

      if (!result?.success) {
        throw new Error(result?.message || result?.error || "Connection test failed");
      }

      const resolvedLabel = getDoubaoModelLabel(result.resolvedModelId);
      if (
        selectedCloudModel === "doubao-streaming-auto" &&
        result.resolvedModelId === "doubao-bigasr-streaming-1.0"
      ) {
        setCloudConnectionTest({
          status: "warning",
          message: isChineseUi
            ? `连接成功，自动模式当前回退到 ${resolvedLabel}。`
            : `Connection succeeded. Auto mode is currently falling back to ${resolvedLabel}.`,
        });
        return;
      }

      setCloudConnectionTest({
        status: "success",
        message: isChineseUi
          ? `连接成功，当前可用模型：${resolvedLabel}。`
          : `Connection succeeded. Available model: ${resolvedLabel}.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCloudConnectionTest({
        status: "error",
        message: isChineseUi ? `连接测试失败：${message}` : `Connection test failed: ${message}`,
      });
    }
  }, [
    doubaoAccessToken,
    doubaoAppId,
    getDoubaoModelLabel,
    isChineseUi,
    selectedCloudModel,
  ]);

  const handleTestStandardCloudConnection = useCallback(
    async (providerId: "openai" | "groq") => {
      if (!window.electronAPI?.testCloudTranscriptionConnection) {
        setCloudConnectionTest({
          status: "error",
          message: isChineseUi ? "当前版本不支持连接测试。" : "This build does not support connection testing.",
        });
        return;
      }

      const providerName = getCloudProviderLabel(providerId);
      setCloudConnectionTest({
        status: "testing",
        message: isChineseUi
          ? `正在测试 ${providerName} 连接...`
          : `Testing ${providerName} connection...`,
      });

      try {
        const apiKey = providerId === "openai" ? openaiApiKey : groqApiKey;
        const result = await window.electronAPI.testCloudTranscriptionConnection({
          provider: providerId,
          apiKey,
          model: selectedCloudModel,
        });

        if (!result?.success) {
          throw new Error(result?.message || result?.error || "Connection test failed");
        }

        const modelLabel = getCloudModelLabel(providerId, selectedCloudModel);
        if (result.modelFound === false) {
          setCloudConnectionTest({
            status: "warning",
            message: isChineseUi
              ? `连接成功，但当前模型 ${modelLabel} 未出现在 ${providerName} 的可用模型列表中。`
              : `Connection succeeded, but ${modelLabel} was not returned in ${providerName}'s available model list.`,
          });
          return;
        }

        setCloudConnectionTest({
          status: "success",
          message: isChineseUi
            ? `连接成功，当前模型 ${modelLabel} 可用。`
            : `Connection succeeded. ${modelLabel} is available.`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setCloudConnectionTest({
          status: "error",
          message: isChineseUi ? `连接测试失败：${message}` : `Connection test failed: ${message}`,
        });
      }
    },
    [
      getCloudModelLabel,
      getCloudProviderLabel,
      groqApiKey,
      isChineseUi,
      openaiApiKey,
      selectedCloudModel,
    ]
  );

  const handleTestCloudConnection = useCallback(async () => {
    if (selectedCloudProvider === "doubao") {
      await handleTestDoubaoConnection();
      return;
    }

    if (selectedCloudProvider === "openai" || selectedCloudProvider === "groq") {
      await handleTestStandardCloudConnection(selectedCloudProvider);
    }
  }, [handleTestDoubaoConnection, handleTestStandardCloudConnection, selectedCloudProvider]);

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

    return null;
  }, [
    downloadingModel,
    downloadProgress,
    isInstalling,
    downloadingParakeetModel,
    parakeetDownloadProgress,
    isInstallingParakeet,
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
              size: t("common.unknown"),
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
                isSelected={modelId === selectedWhisperModelId}
                isDownloaded={model.downloaded ?? false}
                isDownloading={isDownloadingModel(modelId)}
                isCancelling={isCancelling}
                recommended={info.recommended}
                provider="whisper"
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
            <div className="rounded-md border border-border/50 bg-muted/20 px-2.5 py-2">
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {t("transcription.whisperLocalHelp")}
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">
                {t("transcription.whisperModelFileLabel")}
              </label>
              <div className="flex items-center gap-1.5">
                <Input
                  value={selectedWhisperModelPath}
                  onChange={(e) => handleWhisperModelPathChange(e.target.value)}
                  placeholder="/path/to/ggml-base.bin"
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
            </div>
          </>
        ) : null}
      </div>
    );
  };

  const handleParakeetDelete = useCallback(
    (modelId: string) => {
      showConfirmDialog({
        title: t("transcription.deleteModel.title"),
        description: t("transcription.deleteModel.description"),
        onConfirm: async () => {
          await deleteParakeetModel(modelId, async () => {
            const result = await window.electronAPI?.listParakeetModels();
            if (result?.success) {
              setParakeetModels(result.models);
            }
          });
        },
        variant: "destructive",
      });
    },
    [showConfirmDialog, deleteParakeetModel, t]
  );

  const getParakeetLanguageLabel = (language: string) => {
    return language === "multilingual"
      ? t("transcription.parakeet.multilingual")
      : t("transcription.parakeet.english");
  };

  const renderLocalProviderIcon = useCallback((providerId: string) => {
    if (providerId === "sensevoice") {
      return <Boxes className="h-4 w-4 text-muted-foreground" aria-hidden="true" />;
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
              size: t("common.unknown"),
              language: "en",
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
                isSelected={modelId === selectedParakeetModelId}
                isDownloaded={model.downloaded ?? false}
                isDownloading={isDownloadingParakeetModel(modelId)}
                isCancelling={isCancellingParakeet}
                recommended={info.recommended}
                provider="nvidia"
                languageLabel={getParakeetLanguageLabel(info.language)}
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

  const handleSenseVoiceDelete = useCallback(
    (modelId: string) => {
      showConfirmDialog({
        title: t("transcription.deleteModel.title"),
        description: t("transcription.deleteModel.description"),
        onConfirm: async () => {
          await deleteSenseVoiceModel(modelId, async () => {
            const result = await window.electronAPI?.listSenseVoiceModels();
            if (result?.success) {
              setSenseVoiceModels(result.models);
              if (effectiveSelectedSenseVoiceModelId === modelId) {
                setPendingSenseVoiceModelId("");
                handleSenseVoiceModelPathChange("");
              }
            }
          });
        },
        variant: "destructive",
      });
    },
    [
      showConfirmDialog,
      deleteSenseVoiceModel,
      effectiveSelectedSenseVoiceModelId,
      handleSenseVoiceModelPathChange,
      t,
    ]
  );

  const renderSenseVoiceModels = () => {
    const modelsToRender =
      senseVoiceModels.length === 0
        ? Object.entries(SENSEVOICE_MODEL_INFO).map(([modelId, info]) => ({
            model: modelId,
            downloaded: false,
            size_mb: info.sizeMb,
          }))
        : senseVoiceModels;
    const filteredModels = modelsToRender.filter((model) =>
      OTHERS_VISIBLE_MODEL_IDS.has(model.model)
    );

    return (
      <div className="space-y-2">
        <div className="space-y-0.5">
          {filteredModels.map((model) => {
            const modelId = model.model;
            const info = SENSEVOICE_MODEL_INFO[modelId] ?? {
              name: modelId,
              description: t("common.unknown"),
              size: t("common.unknown"),
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
                isSelected={modelId === effectiveSelectedSenseVoiceModelId}
                isDownloaded={model.downloaded ?? false}
                isDownloading={isDownloadingSenseVoiceModel(modelId)}
                isCancelling={isCancellingSenseVoice}
                downloadProgress={
                  isDownloadingSenseVoiceModel(modelId) ? senseVoiceDownloadProgress : undefined
                }
                isInstalling={isInstallingSenseVoice && isDownloadingSenseVoiceModel(modelId)}
                recommended={info.recommended}
                provider="sensevoice"
                onSelect={() => {
                  void handleSenseVoiceModelSelect(modelId);
                }}
                onDelete={() => handleSenseVoiceDelete(modelId)}
                onDownload={() =>
                  downloadSenseVoiceModel(modelId, (downloadedId) => {
                    setSenseVoiceModels((prev) =>
                      prev.map((m) => (m.model === downloadedId ? { ...m, downloaded: true } : m))
                    );
                    void handleSenseVoiceModelSelect(downloadedId);
                  })
                }
                onCancel={cancelSenseVoiceDownload}
                styles={styles}
              />
            );
          })}
        </div>

        {!isOnboarding ? (
          <>
            <div className="rounded-md border border-border/50 bg-muted/20 px-2.5 py-2">
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {t("transcription.senseVoiceLocalHelp")}
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">
                {t("transcription.senseVoiceModelFileLabel")}
              </label>
              <div className="flex items-center gap-1.5">
                <Input
                  value={senseVoiceModelPath}
                  onChange={(e) => handleSenseVoiceModelPathChange(e.target.value)}
                  placeholder="/path/to/local-model.gguf"
                  className="h-8 text-sm"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="h-8 px-2 text-xs"
                  onClick={handlePickSenseVoiceModel}
                >
                  {t("transcription.browse")}
                </Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">
                {t("transcription.senseVoiceBinaryLabel")}
              </label>
              <div className="flex items-center gap-1.5">
                <Input
                  value={senseVoiceBinaryPath}
                  onChange={(e) => handleSenseVoiceBinaryPathChange(e.target.value)}
                  placeholder="/path/to/sense-voice-main"
                  className="h-8 text-sm"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="h-8 px-2 text-xs"
                  onClick={handlePickSenseVoiceBinary}
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

  return (
    <div className={`space-y-2 ${className}`}>
      <ModeToggle useLocalWhisper={useLocalWhisper} onModeChange={handleModeChange} />

      {!useLocalWhisper ? (
        <div className={styles.container}>
          <div className="p-2 pb-0">
            <ProviderTabs
              providers={visibleCloudProviderTabs}
              selectedId={selectedCloudProvider}
              onSelect={handleCloudProviderChange}
              colorScheme={colorScheme === "purple" ? "purple" : "indigo"}
              scrollable
            />
          </div>

          <div className="p-2">
            {selectedCloudProvider === "custom" ? (
              <div className="space-y-2">
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-foreground">
                    {t("transcription.endpointUrl")}
                  </label>
                  <Input
                    value={cloudTranscriptionBaseUrl}
                    onChange={(e) => setCloudTranscriptionBaseUrl?.(e.target.value)}
                    onBlur={handleBaseUrlBlur}
                    placeholder="https://your-api.example.com/v1"
                    className="h-8 text-sm"
                  />
                </div>

                <ApiKeyInput
                  apiKey={customTranscriptionApiKey}
                  setApiKey={setCustomTranscriptionApiKey || (() => {})}
                  label={t("transcription.apiKeyOptional")}
                  helpText=""
                />

                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-foreground">
                    {t("common.model")}
                  </label>
                  <Input
                    value={selectedCloudModel}
                    onChange={(e) => onCloudModelSelect(e.target.value)}
                    placeholder="whisper-1"
                    className="h-8 text-sm"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {selectedCloudProvider === "doubao" ? (
                  <>
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <label className="text-xs font-medium text-foreground">APP ID</label>
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
                        value={doubaoAppId}
                        onChange={(e) => setDoubaoAppId(e.target.value)}
                        placeholder="123456789"
                        className="h-8 text-sm"
                      />
                    </div>

                    <ApiKeyInput
                      apiKey={doubaoAccessToken}
                      setApiKey={setDoubaoAccessToken}
                      label="ACCESS TOKEN"
                      helpText=""
                      placeholder="your-access-token"
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
                        { groq: groqApiKey, openai: openaiApiKey }[selectedCloudProvider] ||
                        openaiApiKey
                      }
                      setApiKey={
                        { groq: setGroqApiKey, openai: setOpenaiApiKey }[selectedCloudProvider] ||
                        setOpenaiApiKey
                      }
                      label=""
                      helpText=""
                    />
                  </div>
                )}

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">{t("common.model")}</label>
                  <ModelCardList
                    models={cloudModelOptions}
                    selectedModel={selectedCloudModel}
                    onModelSelect={onCloudModelSelect}
                    colorScheme={colorScheme === "purple" ? "purple" : "indigo"}
                  />
                </div>

                {selectedCloudProvider === "doubao" ? (
                  <div className="space-y-1.5">
                    <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
                      {isChineseUi
                        ? "自动模式会优先使用流式 2.0，失败时自动回退到流式 1.0。"
                        : "Auto mode prefers Streaming 2.0 and falls back to Streaming 1.0 if needed."}
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
                            ? "text-emerald-600 dark:text-emerald-400"
                            : cloudConnectionTest.status === "warning"
                              ? "text-amber-600 dark:text-amber-400"
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
                            ? "text-emerald-600 dark:text-emerald-400"
                            : cloudConnectionTest.status === "warning"
                              ? "text-amber-600 dark:text-amber-400"
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
          <div className="p-2 pb-0">
            <ProviderTabs
              providers={visibleLocalProviderTabs}
              selectedId={internalLocalProvider}
              onSelect={handleLocalProviderChange}
              renderIcon={renderLocalProviderIcon}
              colorScheme={colorScheme === "purple" ? "purple" : "indigo"}
            />
          </div>

          {progressDisplay}

          <div className="p-2">
            {internalLocalProvider === "whisper" && renderLocalModels()}
            {internalLocalProvider === "nvidia" && renderParakeetModels()}
            {internalLocalProvider === "sensevoice" && renderSenseVoiceModels()}
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
