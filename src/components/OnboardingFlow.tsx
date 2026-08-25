import React, { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Card, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import {
  ChevronRight,
  ChevronLeft,
  Check,
  Mic,
  Shield,
  Command,
  Globe,
  AlertTriangle,
  Sparkles,
  Loader2,
  Cloud,
  FolderOpen,
} from "lucide-react";
import TitleBar from "./TitleBar";
import PermissionCard from "./ui/PermissionCard";
import MacPrivacyPermissionCard from "./ui/MacPrivacyPermissionCard";
import SupportDropdown from "./ui/SupportDropdown";
import MicPermissionWarning from "./ui/MicPermissionWarning";
import PasteToolsInfo from "./ui/PasteToolsInfo";
import StepProgress from "./ui/StepProgress";
import { LiquidGlassFilters } from "./ui/LiquidGlassFilters";
import { AlertDialog, ConfirmDialog } from "./ui/dialog";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useDialogs } from "../hooks/useDialogs";
import { usePermissions } from "../hooks/usePermissions";
import { useClipboard } from "../hooks/useClipboard";
import { useSettings } from "../hooks/useSettings";
import { useToast } from "./ui/toastContext";
import LanguageSelector, { type LanguageOption } from "./ui/LanguageSelector";
import { setAgentName as saveAgentName } from "../utils/agentName";
import { formatHotkeyLabel, getDefaultHotkey } from "../utils/hotkeys";
import { HotkeyInput } from "./ui/HotkeyInput";
import { useHotkeyRegistration } from "../hooks/useHotkeyRegistration";
import { getValidationMessage } from "../utils/hotkeyValidator";
import { getPlatform } from "../utils/platform";
import { ActivationModeSelector } from "./ui/ActivationModeSelector";
import type {
  LocalTranscriptionProvider,
  OnboardingAudioLevelPayload,
  OnboardingDictationSuccessEvent,
  OnboardingResumeState,
  ParakeetDownloadProgressData,
  ParaformerDownloadProgressData,
  SherpaStreamingDownloadProgressData,
} from "../types/electron";
import {
  ONBOARDING_MODEL_PREP_EVENT,
  getOnboardingStarterModel,
  isOnboardingDownloadEventForPrepState,
  markOnboardingPreparedModelReady,
  normalizeOnboardingModelsDir,
  readOnboardingModelPrepState,
  writeOnboardingModelPrepState,
  type OnboardingModelPrepProvider,
  type OnboardingModelPrepState,
} from "../utils/onboardingModelPrep";
import streamingModels from "../config/streamingModels.json";
import { getStreamingModelDisplayName } from "../utils/streamingModelI18n";
import {
  formatDirectoryDisplay,
  joinModelStoragePath,
  shouldShowModelStorageRootNormalizedNotice,
} from "./settings/utils";
import { PARAKEET_MODEL_INFO, PARAFORMER_MODEL_INFO } from "../models/ModelRegistry";
import { useAnimationFrameGate } from "../hooks/useAnimationFrameGate";
import {
  ONBOARDING_ACTIVATION_STEP_INDEX,
  ONBOARDING_PERMISSIONS_STEP_INDEX,
  ONBOARDING_STEPS,
  ONBOARDING_WELCOME_STEP_INDEX,
  normalizeOnboardingStep,
} from "../utils/onboardingSteps";

const ONBOARDING_FLOW_VERSION = 5;
const DEFAULT_AGENT_NAME = "CC";

type OnboardingDownloadProgressData =
  | SherpaStreamingDownloadProgressData
  | ParakeetDownloadProgressData
  | ParaformerDownloadProgressData;

function getPreparedModelDisplayName(
  t: TFunction,
  provider: OnboardingModelPrepProvider,
  modelId: string,
  fallbackName: string
) {
  if (provider === "paraformer") {
    return PARAFORMER_MODEL_INFO[modelId]?.name || fallbackName;
  }

  if (provider === "parakeet") {
    return PARAKEET_MODEL_INFO[modelId]?.name || fallbackName;
  }

  const modelConfig = streamingModels.find((model) => model.id === modelId);
  return getStreamingModelDisplayName(
    t,
    modelId,
    modelConfig?.nameEn || modelConfig?.name || fallbackName
  );
}

function getOnboardingPrepModelsDir(
  provider: OnboardingModelPrepProvider,
  modelStorageRoot: string
) {
  const root = String(modelStorageRoot || "").trim();
  if (!root) return "";

  if (provider === "paraformer") {
    return joinModelStoragePath(root, "paraformer-models");
  }

  if (provider === "parakeet") {
    return joinModelStoragePath(root, "parakeet-models");
  }

  return joinModelStoragePath(root, "streaming-models");
}

const ONBOARDING_UI_LANGUAGE_OPTIONS: LanguageOption[] = [
  { value: "en", label: "English", subtitle: "英语", flag: "🇺🇸" },
  { value: "zh-CN", label: "简体中文", subtitle: "Chinese", flag: "🇨🇳" },
  { value: "es", label: "Español", subtitle: "Spanish", flag: "🇪🇸" },
  { value: "ja", label: "日本語", subtitle: "Japanese", flag: "🇯🇵" },
  { value: "zh-TW", label: "繁體中文", subtitle: "Traditional Chinese", flag: "繁" },
  { value: "fr", label: "Français", subtitle: "French", flag: "🇫🇷" },
  { value: "de", label: "Deutsch", subtitle: "German", flag: "🇩🇪" },
  { value: "pt", label: "Português", subtitle: "Portuguese", flag: "🇵🇹" },
  { value: "it", label: "Italiano", subtitle: "Italian", flag: "🇮🇹" },
  { value: "ru", label: "Русский", subtitle: "Russian", flag: "🇷🇺" },
];

const ONBOARDING_UI_LANGUAGE_VALUES = new Set(
  ONBOARDING_UI_LANGUAGE_OPTIONS.map((option) => option.value)
);
const ONBOARDING_PRIORITY_UI_LANGUAGE_VALUES = ["en", "zh-CN", "es", "ja", "fr"];

interface OnboardingFlowProps {
  onComplete: () => void;
}

function resolveCloudFallbackProvider(options: {
  currentProvider: string;
  openaiApiKey: string;
  groqApiKey: string;
  sonioxApiKey: string;
  deepgramApiKey: string;
  googleSttApiKey: string;
  doubaoAppId: string;
  doubaoAccessToken: string;
  customTranscriptionApiKey: string;
  cloudTranscriptionBaseUrl: string;
}) {
  const {
    currentProvider,
    openaiApiKey,
    groqApiKey,
    sonioxApiKey,
    deepgramApiKey,
    googleSttApiKey,
    doubaoAppId,
    doubaoAccessToken,
    customTranscriptionApiKey,
    cloudTranscriptionBaseUrl,
  } = options;

  const hasOpenAI = openaiApiKey.trim().length > 0;
  const hasGroq = groqApiKey.trim().length > 0;
  const hasSoniox = sonioxApiKey.trim().length > 0;
  const hasDeepgram = deepgramApiKey.trim().length > 0;
  const hasGoogleStt = googleSttApiKey.trim().length > 0;
  const hasDoubao = doubaoAppId.trim().length > 0 && doubaoAccessToken.trim().length > 0;
  const hasCustom =
    customTranscriptionApiKey.trim().length > 0 && cloudTranscriptionBaseUrl.trim().length > 0;

  if (currentProvider === "openai" && hasOpenAI) return "openai";
  if (currentProvider === "groq" && hasGroq) return "groq";
  if (currentProvider === "soniox" && hasSoniox) return "soniox";
  if (currentProvider === "deepgram" && hasDeepgram) return "deepgram";
  if (currentProvider === "google-cloud" && hasGoogleStt) return "google-cloud";
  if (currentProvider === "doubao" && hasDoubao) return "doubao";
  if (currentProvider === "custom" && hasCustom) return "custom";
  if (hasOpenAI) return "openai";
  if (hasGroq) return "groq";
  if (hasSoniox) return "soniox";
  if (hasDeepgram) return "deepgram";
  if (hasGoogleStt) return "google-cloud";
  if (hasDoubao) return "doubao";
  if (hasCustom) return "custom";
  return null;
}

export default function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const { t, i18n } = useTranslation();
  const activationTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activationStartedAtRef = useRef(0);
  const activationAttemptStartedAtRef = useRef(0);
  const onboardingStateHydratedRef = useRef(false);
  const initialStoredOnboardingStep =
    typeof window !== "undefined" ? window.localStorage.getItem("onboardingCurrentStep") : null;
  const initialStoredOnboardingVersion =
    typeof window !== "undefined" ? window.localStorage.getItem("onboardingFlowVersion") : null;
  const initialStoredOnboardingStepRef = useRef(initialStoredOnboardingStep);
  const initialStoredOnboardingVersionRef = useRef(initialStoredOnboardingVersion);
  const prepStartedForModelRef = useRef<string | null>(null);
  const prepStartedForKeyRef = useRef<string | null>(null);
  const prepRunIdRef = useRef(0);
  const activationTranscriptionPrefsRef = useRef<{
    useLocalStreaming: string | null;
    localStreamingModelId: string | null;
    useLocalWhisper: boolean;
    localTranscriptionProvider: LocalTranscriptionProvider;
    parakeetModel: string;
    paraformerModel: string;
    cloudTranscriptionMode: string;
    cloudTranscriptionProvider: string;
  } | null>(null);
  const activationTranscriptionPrefsOverriddenRef = useRef(false);
  const preserveActivationTranscriptionPrefsRef = useRef(false);

  const [currentStep, setCurrentStep, removeCurrentStep] = useLocalStorage(
    "onboardingCurrentStep",
    0,
    {
      serialize: String,
      deserialize: normalizeOnboardingStep,
    }
  );

  const {
    uiLanguage,
    isUiLanguageSyncReady,
    preferredLanguage,
    modelStorageRoot,
    useLocalWhisper,
    localTranscriptionProvider,
    parakeetModel,
    paraformerModel,
    cloudTranscriptionMode,
    cloudTranscriptionProvider,
    cloudTranscriptionBaseUrl,
    openaiApiKey,
    groqApiKey,
    sonioxApiKey,
    deepgramApiKey,
    googleSttApiKey,
    doubaoAppId,
    doubaoAccessToken,
    customTranscriptionApiKey,
    dictationKey,
    activationMode,
    setActivationMode,
    setUiLanguage,
    setModelStorageRoot,
    setDictationKey,
    updateTranscriptionSettings,
  } = useSettings();

  const [hotkey, setHotkey] = useState(dictationKey || getDefaultHotkey());
  const [isUsingGnomeHotkeys, setIsUsingGnomeHotkeys] = useState(false);
  const [hasCompletedDictationTest, setHasCompletedDictationTest] = useState(false);
  const [dictationTestPreview, setDictationTestPreview] = useState("");
  const [activationManualText, setActivationManualText] = useState("");
  const [activationStepSkipped, setActivationStepSkipped] = useState(false);
  const [activationSessionState, setActivationSessionState] = useState<
    "idle" | "listening" | "processing" | "success"
  >("idle");
  const [activationElapsedMs, setActivationElapsedMs] = useState<number | null>(null);
  const [activationAudioLevel, setActivationAudioLevel] = useState(0);
  const [activationVisualLevel, setActivationVisualLevel] = useState(0);
  const [activationPeakLevel, setActivationPeakLevel] = useState(0);
  const activationAudioLevelRef = useRef(0);
  const activationSessionStateRef = useRef<"idle" | "listening" | "processing" | "success">("idle");
  activationAudioLevelRef.current = activationAudioLevel;
  activationSessionStateRef.current = activationSessionState;
  const [isChoosingModelStorageRoot, setIsChoosingModelStorageRoot] = useState(false);
  const [onboardingModelPrepState, setOnboardingModelPrepState] =
    useState<OnboardingModelPrepState>(() => readOnboardingModelPrepState());
  const readableHotkey = formatHotkeyLabel(hotkey);

  const lastTrackedStepRef = useRef<number | null>(null);

  useEffect(() => {
    if (currentStep === lastTrackedStepRef.current) {
      return;
    }
    lastTrackedStepRef.current = currentStep;

    if (currentStep === ONBOARDING_WELCOME_STEP_INDEX) {
      window.electronAPI?.trackOnboardingEvent?.("onboarding_started");
    } else if (currentStep === ONBOARDING_PERMISSIONS_STEP_INDEX) {
      window.electronAPI?.trackOnboardingEvent?.("step_reached:permissions");
    } else if (currentStep === ONBOARDING_ACTIVATION_STEP_INDEX) {
      window.electronAPI?.trackOnboardingEvent?.("step_reached:activation");
    }
  }, [currentStep]);

  const {
    alertDialog,
    confirmDialog,
    showAlertDialog,
    showConfirmDialog,
    hideAlertDialog,
    hideConfirmDialog,
  } = useDialogs();
  const { toast } = useToast();

  const autoRegisterInFlightRef = useRef(false);
  const hotkeyStepInitializedRef = useRef(false);

  const { registerHotkey, isRegistering: isHotkeyRegistering } = useHotkeyRegistration({
    onSuccess: (registeredHotkey) => {
      setHotkey(registeredHotkey);
      setDictationKey(registeredHotkey);
    },
    showSuccessToast: false,
    showErrorToast: false,
  });

  const validateHotkeyForInput = useCallback(
    (nextHotkey: string) => getValidationMessage(nextHotkey, getPlatform()),
    []
  );

  const permissionsHook = usePermissions(showAlertDialog);
  useClipboard(showAlertDialog);

  const activationStepIndex = ONBOARDING_ACTIVATION_STEP_INDEX;
  const isMacOS = getPlatform() === "darwin";
  const showProgress = true;
  const resolvedOnboardingUiLanguage = ONBOARDING_UI_LANGUAGE_VALUES.has(uiLanguage)
    ? uiLanguage
    : uiLanguage.startsWith("zh")
      ? "zh-CN"
      : "en";
  const onboardingStarterModel = getOnboardingStarterModel(resolvedOnboardingUiLanguage);
  const onboardingStarterModelId = onboardingStarterModel.modelId;
  const onboardingStarterModelDisplayName = getPreparedModelDisplayName(
    t,
    onboardingStarterModel.provider,
    onboardingStarterModelId,
    onboardingStarterModelId
  );
  const activationRouteModelId = onboardingModelPrepState.modelId || onboardingStarterModelId;
  const activationRouteModelDisplayName = getPreparedModelDisplayName(
    t,
    onboardingModelPrepState.provider || onboardingStarterModel.provider,
    activationRouteModelId,
    onboardingStarterModelDisplayName
  );
  const onboardingModelStorageRootDisplay = formatDirectoryDisplay(modelStorageRoot);
  const onboardingStreamingModelsDir = modelStorageRoot.trim()
    ? joinModelStoragePath(modelStorageRoot, "streaming-models")
    : "";
  const onboardingPrepModelsDir = getOnboardingPrepModelsDir(
    onboardingStarterModel.provider,
    modelStorageRoot
  );
  const preferredCloudProvider = resolveCloudFallbackProvider({
    currentProvider: cloudTranscriptionProvider,
    openaiApiKey,
    groqApiKey,
    sonioxApiKey,
    deepgramApiKey,
    googleSttApiKey,
    doubaoAppId,
    doubaoAccessToken,
    customTranscriptionApiKey,
    cloudTranscriptionBaseUrl,
  });
  const hasCloudActivationFallback = preferredCloudProvider !== null;

  useEffect(() => {
    if (!isMacOS) {
      return;
    }

    window.electronAPI?.notifyMacNativeHotkeyEligibilityChanged?.(
      currentStep >= activationStepIndex
    );

    return () => {
      if (localStorage.getItem("onboardingCompleted") !== "true") {
        window.electronAPI?.notifyMacNativeHotkeyEligibilityChanged?.(false);
      }
    };
  }, [activationStepIndex, currentStep, isMacOS]);

  const stepIcons = { welcome: Globe, permissions: Shield, activation: Command } as const;
  const steps = ONBOARDING_STEPS.map((id) => ({
    title: t(`onboarding.steps.${id}`),
    icon: stepIcons[id],
  }));

  const updatePrepState = useCallback((patch: Partial<OnboardingModelPrepState>) => {
    const nextState = writeOnboardingModelPrepState(patch);
    setOnboardingModelPrepState(nextState);
    return nextState;
  }, []);

  const resetOnboardingPrepForLanguage = useCallback(
    (language: string) => {
      const starterModel = getOnboardingStarterModel(language);
      prepRunIdRef.current += 1;
      prepStartedForModelRef.current = null;
      prepStartedForKeyRef.current = null;
      updatePrepState({
        status: "idle",
        provider: starterModel.provider,
        modelId: null,
        modelsDir: null,
        percentage: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        message: null,
        error: null,
      });
    },
    [updatePrepState]
  );

  const cancelActiveOnboardingPrep = useCallback(async () => {
    const trackedState = readOnboardingModelPrepState();
    const isActiveDownload =
      trackedState.status === "downloading" || trackedState.status === "installing";

    if (!isActiveDownload) {
      return;
    }

    prepRunIdRef.current += 1;
    prepStartedForModelRef.current = null;
    prepStartedForKeyRef.current = null;

    if (trackedState.provider === "paraformer") {
      await window.electronAPI?.cancelParaformerDownload?.();
    } else if (trackedState.provider === "parakeet") {
      await window.electronAPI?.cancelParakeetDownload?.();
    } else {
      await window.electronAPI?.sherpaStreamingCancelDownload?.();
    }
  }, []);

  const changeOnboardingUiLanguage = useCallback(
    async (language: string) => {
      await cancelActiveOnboardingPrep();
      await setUiLanguage(language);
      resetOnboardingPrepForLanguage(language);
    },
    [cancelActiveOnboardingPrep, resetOnboardingPrepForLanguage, setUiLanguage]
  );

  const captureActivationTranscriptionPrefs = useCallback(() => {
    if (activationTranscriptionPrefsRef.current || typeof window === "undefined") {
      return;
    }

    activationTranscriptionPrefsRef.current = {
      useLocalStreaming: window.localStorage.getItem("useLocalStreaming"),
      localStreamingModelId: window.localStorage.getItem("localStreamingModelId"),
      useLocalWhisper,
      localTranscriptionProvider,
      parakeetModel,
      paraformerModel,
      cloudTranscriptionMode,
      cloudTranscriptionProvider,
    };
  }, [
    cloudTranscriptionMode,
    cloudTranscriptionProvider,
    localTranscriptionProvider,
    parakeetModel,
    paraformerModel,
    useLocalWhisper,
  ]);

  const restoreActivationTranscriptionPrefs = useCallback(() => {
    if (
      preserveActivationTranscriptionPrefsRef.current ||
      !activationTranscriptionPrefsOverriddenRef.current ||
      !activationTranscriptionPrefsRef.current ||
      typeof window === "undefined"
    ) {
      return;
    }

    const snapshot = activationTranscriptionPrefsRef.current;

    if (snapshot.useLocalStreaming === null) {
      window.localStorage.removeItem("useLocalStreaming");
    } else {
      window.localStorage.setItem("useLocalStreaming", snapshot.useLocalStreaming);
    }

    if (snapshot.localStreamingModelId === null) {
      window.localStorage.removeItem("localStreamingModelId");
    } else {
      window.localStorage.setItem("localStreamingModelId", snapshot.localStreamingModelId);
    }

    updateTranscriptionSettings({
      useLocalWhisper: snapshot.useLocalWhisper,
      localTranscriptionProvider: snapshot.localTranscriptionProvider,
      parakeetModel: snapshot.parakeetModel,
      paraformerModel: snapshot.paraformerModel,
      cloudTranscriptionMode: snapshot.cloudTranscriptionMode,
      cloudTranscriptionProvider: snapshot.cloudTranscriptionProvider,
    });

    activationTranscriptionPrefsOverriddenRef.current = false;
    activationTranscriptionPrefsRef.current = null;
  }, [updateTranscriptionSettings]);

  useEffect(() => {
    const handlePrepStateChange = (event: Event) => {
      const detail = (event as CustomEvent<OnboardingModelPrepState>).detail;
      if (detail) {
        setOnboardingModelPrepState(detail);
        return;
      }

      setOnboardingModelPrepState(readOnboardingModelPrepState());
    };

    window.addEventListener(ONBOARDING_MODEL_PREP_EVENT, handlePrepStateChange as EventListener);
    return () => {
      window.removeEventListener(
        ONBOARDING_MODEL_PREP_EVENT,
        handlePrepStateChange as EventListener
      );
    };
  }, []);

  useEffect(() => {
    const handleDownloadProgress = (_event: unknown, data: OnboardingDownloadProgressData) => {
      if (!data) return;

      const trackedState = readOnboardingModelPrepState();
      if (!isOnboardingDownloadEventForPrepState(data, trackedState)) {
        return;
      }

      if (
        data.type === "source-connect" ||
        data.type === "source-switch" ||
        data.type === "verifying"
      ) {
        updatePrepState({
          status: data.type === "verifying" ? "installing" : "downloading",
          message:
            data.type === "verifying"
              ? t("common.verifyingDownload")
              : data.type === "source-switch"
                ? t("common.switchingDownloadNode")
                : t("common.connectingDownloadNode"),
          error: null,
        });
        return;
      }

      if (data.type === "progress") {
        const nextPercentage = Math.max(trackedState.percentage || 0, data.percentage || 0);
        const nextDownloadedBytes = Math.max(
          trackedState.downloadedBytes || 0,
          data.downloaded_bytes || 0
        );
        const nextTotalBytes = Math.max(trackedState.totalBytes || 0, data.total_bytes || 0);

        updatePrepState({
          status: "downloading",
          percentage: nextPercentage,
          downloadedBytes: nextDownloadedBytes,
          totalBytes: nextTotalBytes,
          message: null,
          error: null,
        });
        return;
      }

      if (data.type === "installing") {
        updatePrepState({
          status: "installing",
          percentage: 100,
          message: null,
          error: null,
        });
        return;
      }

      if (data.type === "complete") {
        markOnboardingPreparedModelReady(trackedState.provider, data.model);
        updatePrepState({
          status: "ready",
          provider: trackedState.provider,
          modelId: data.model,
          modelsDir: trackedState.modelsDir,
          percentage: 100,
          message: null,
          error: null,
        });
        return;
      }

      if (data.type === "error") {
        prepStartedForModelRef.current = null;
        prepStartedForKeyRef.current = null;
        updatePrepState({
          status: "error",
          error: data.error || "Failed to prepare local transcription model.",
        });
      }
    };

    const disposeStreaming =
      window.electronAPI?.onSherpaStreamingDownloadProgress?.(handleDownloadProgress);
    const disposeParakeet =
      window.electronAPI?.onParakeetDownloadProgress?.(handleDownloadProgress);
    const disposeParaformer =
      window.electronAPI?.onParaformerDownloadProgress?.(handleDownloadProgress);

    return () => {
      disposeStreaming?.();
      disposeParakeet?.();
      disposeParaformer?.();
    };
  }, [t, updatePrepState]);

  useEffect(() => {
    const storedVersion = Number(initialStoredOnboardingVersionRef.current || "1");
    if (storedVersion >= ONBOARDING_FLOW_VERSION) {
      return;
    }

    const storedStepBeforeInit = initialStoredOnboardingStepRef.current;
    if (storedStepBeforeInit === null) {
      localStorage.setItem("onboardingFlowVersion", String(ONBOARDING_FLOW_VERSION));
      initialStoredOnboardingVersionRef.current = String(ONBOARDING_FLOW_VERSION);
      return;
    }

    if (currentStep !== 0) {
      setCurrentStep(0);
    }

    localStorage.setItem("onboardingFlowVersion", String(ONBOARDING_FLOW_VERSION));
    initialStoredOnboardingStepRef.current = "0";
    initialStoredOnboardingVersionRef.current = String(ONBOARDING_FLOW_VERSION);
  }, [currentStep, setCurrentStep]);

  useEffect(() => {
    if (currentStep !== 0) {
      return;
    }

    const normalizedUiLanguage = ONBOARDING_UI_LANGUAGE_VALUES.has(uiLanguage)
      ? uiLanguage
      : uiLanguage.startsWith("zh")
        ? "zh-CN"
        : "en";

    if (uiLanguage === normalizedUiLanguage) {
      return;
    }

    void changeOnboardingUiLanguage(normalizedUiLanguage);
  }, [changeOnboardingUiLanguage, currentStep, uiLanguage]);

  useEffect(() => {
    const checkHotkeyMode = async () => {
      try {
        const info = await window.electronAPI?.getHotkeyModeInfo?.();
        if (info?.isUsingGnome) {
          setIsUsingGnomeHotkeys(true);
          setActivationMode("tap");
        }
      } catch (error) {
        console.error("Failed to check hotkey mode:", error);
      }
    };

    void checkHotkeyMode();
  }, [setActivationMode]);

  useEffect(() => {
    if (currentStep !== activationStepIndex) {
      hotkeyStepInitializedRef.current = false;
      return;
    }

    if (autoRegisterInFlightRef.current || hotkeyStepInitializedRef.current) {
      return;
    }

    const autoRegisterDefaultHotkey = async () => {
      autoRegisterInFlightRef.current = true;
      hotkeyStepInitializedRef.current = true;

      try {
        const defaultHotkey = getDefaultHotkey();
        const platform = window.electronAPI?.getPlatform?.() ?? "darwin";
        const shouldAutoRegister =
          !hotkey || hotkey.trim() === "" || (platform !== "darwin" && hotkey === "GLOBE");

        if (shouldAutoRegister) {
          const success = await registerHotkey(defaultHotkey);
          if (success) {
            setHotkey(defaultHotkey);
          }
        }
      } catch (error) {
        console.error("Failed to auto-register default hotkey:", error);
      } finally {
        autoRegisterInFlightRef.current = false;
      }
    };

    void autoRegisterDefaultHotkey();
  }, [activationStepIndex, currentStep, hotkey, registerHotkey]);

  const resetActivationProgress = useCallback(() => {
    activationAttemptStartedAtRef.current = 0;
    setHasCompletedDictationTest(false);
    setDictationTestPreview("");
    setActivationManualText("");
    setActivationStepSkipped(false);
    setActivationSessionState("idle");
    setActivationElapsedMs(null);
    setActivationAudioLevel(0);
    setActivationVisualLevel(0);
    setActivationPeakLevel(0);
  }, []);

  const restoreActivationState = useCallback(
    (resumeState: OnboardingResumeState | null) => {
      if (!resumeState || resumeState.flowVersion !== ONBOARDING_FLOW_VERSION) {
        resetActivationProgress();
        return;
      }

      setActivationManualText("");
      setActivationStepSkipped(Boolean(resumeState.activationStepSkipped));

      if (resumeState.hasCompletedDictationTest) {
        setHasCompletedDictationTest(true);
        setDictationTestPreview("");
        setActivationElapsedMs(
          typeof resumeState.recognitionDurationMs === "number"
            ? resumeState.recognitionDurationMs
            : null
        );
        setActivationSessionState("success");
        return;
      }

      setHasCompletedDictationTest(false);
      setDictationTestPreview("");
      setActivationSessionState("idle");
      setActivationElapsedMs(null);
    },
    [resetActivationProgress]
  );

  const applyDictationSuccess = useCallback(
    (
      payload: OnboardingDictationSuccessEvent | null | undefined,
      options: { allowBeforeActivationStart?: boolean } = {}
    ) => {
      if (!payload) {
        return false;
      }

      const issuedAt = Number(payload.issuedAt) || 0;
      if (!options.allowBeforeActivationStart && issuedAt < activationStartedAtRef.current) {
        return false;
      }

      const recognitionDurationMs =
        typeof payload.recognitionDurationMs === "number" && payload.recognitionDurationMs >= 0
          ? payload.recognitionDurationMs
          : activationAttemptStartedAtRef.current
            ? Math.max(0, issuedAt - activationAttemptStartedAtRef.current)
            : null;

      setHasCompletedDictationTest(true);
      setDictationTestPreview((payload.previewText || "").trim());
      setActivationElapsedMs(recognitionDurationMs);
      setActivationSessionState("success");
      setActivationAudioLevel(0);
      setActivationPeakLevel(0);
      return true;
    },
    []
  );

  useEffect(() => {
    if (onboardingStateHydratedRef.current) {
      return;
    }

    onboardingStateHydratedRef.current = true;
    let cancelled = false;

    const hydrateOnboardingState = async () => {
      const resumeState = await window.electronAPI?.getOnboardingState?.();
      if (cancelled || !resumeState || resumeState.flowVersion !== ONBOARDING_FLOW_VERSION) {
        return;
      }

      if (typeof resumeState.currentStep === "number" && resumeState.currentStep !== currentStep) {
        setCurrentStep(resumeState.currentStep);
      }

      if (
        typeof resumeState.uiLanguage === "string" &&
        resumeState.uiLanguage &&
        resumeState.uiLanguage !== uiLanguage
      ) {
        await setUiLanguage(resumeState.uiLanguage);
      }

      if (resumeState.currentStep === activationStepIndex || currentStep === activationStepIndex) {
        restoreActivationState(resumeState);
      }
    };

    void hydrateOnboardingState();

    return () => {
      cancelled = true;
    };
  }, [
    activationStepIndex,
    currentStep,
    restoreActivationState,
    setCurrentStep,
    setUiLanguage,
    uiLanguage,
  ]);

  useEffect(() => {
    const dispose = window.electronAPI?.onOnboardingDictationSuccess?.(
      (_event: unknown, payload: OnboardingDictationSuccessEvent) => {
        if (currentStep !== activationStepIndex) {
          return;
        }

        applyDictationSuccess(payload);
      }
    );

    return () => {
      dispose?.();
    };
  }, [activationStepIndex, applyDictationSuccess, currentStep]);

  useEffect(() => {
    if (currentStep !== activationStepIndex) {
      return;
    }

    activationStartedAtRef.current = Date.now();
    let cancelled = false;

    const hydrateActivationStep = async () => {
      const resumeState = await window.electronAPI?.getOnboardingState?.();
      if (cancelled) {
        return;
      }

      restoreActivationState(resumeState ?? null);

      const latestEvent = await window.electronAPI?.consumeOnboardingDictationSuccess?.();
      if (cancelled) {
        return;
      }

      applyDictationSuccess(latestEvent);
    };

    void hydrateActivationStep();

    return () => {
      cancelled = true;
      activationAttemptStartedAtRef.current = 0;
      setActivationSessionState("idle");
      setActivationElapsedMs(null);
      setActivationAudioLevel(0);
      setActivationPeakLevel(0);
    };
  }, [activationStepIndex, applyDictationSuccess, currentStep, restoreActivationState]);

  useEffect(() => {
    if (currentStep !== activationStepIndex) {
      return;
    }

    const disposeStart = window.electronAPI?.onStartDictation?.(() => {
      activationAttemptStartedAtRef.current = 0;
      setActivationSessionState("listening");
      setActivationElapsedMs(null);
      setActivationAudioLevel(0);
      setActivationPeakLevel(0);
    });

    const disposeStop = window.electronAPI?.onStopDictation?.(() => {
      activationAttemptStartedAtRef.current = Date.now();
      setActivationAudioLevel(0);
      setActivationElapsedMs(0);
      setActivationSessionState((previous) => (previous === "success" ? previous : "processing"));
    });

    return () => {
      disposeStart?.();
      disposeStop?.();
    };
  }, [activationStepIndex, currentStep]);

  useEffect(() => {
    if (
      currentStep !== activationStepIndex ||
      activationSessionState !== "processing" ||
      !activationAttemptStartedAtRef.current
    ) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setActivationElapsedMs(Math.max(0, Date.now() - activationAttemptStartedAtRef.current));
    }, 120);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [activationSessionState, activationStepIndex, currentStep]);

  useEffect(() => {
    if (currentStep !== activationStepIndex) {
      return;
    }

    const dispose = window.electronAPI?.onOnboardingAudioLevel?.(
      (_event: unknown, payload: OnboardingAudioLevelPayload) => {
        const nextLevel = Number(payload?.level);
        setActivationAudioLevel(
          Number.isFinite(nextLevel) ? Math.max(0, Math.min(1, nextLevel)) : 0
        );
      }
    );

    return () => {
      dispose?.();
    };
  }, [activationStepIndex, currentStep]);

  const activationAnimationActive =
    currentStep === activationStepIndex &&
    (activationSessionState === "listening" || activationSessionState === "processing");
  const shouldAnimateActivation = useAnimationFrameGate(activationAnimationActive);

  useEffect(() => {
    if (shouldAnimateActivation) {
      return undefined;
    }

    const target =
      currentStep === activationStepIndex && activationSessionState === "listening"
        ? activationAudioLevel
        : 0;
    setActivationVisualLevel(target);
    setActivationPeakLevel(activationSessionState === "success" ? 0.72 : target);
    return undefined;
  }, [
    activationAudioLevel,
    activationSessionState,
    activationStepIndex,
    currentStep,
    shouldAnimateActivation,
  ]);

  useEffect(() => {
    if (!shouldAnimateActivation) {
      return undefined;
    }

    let frameId = 0;

    const animate = () => {
      const sessionState = activationSessionStateRef.current;
      const target = sessionState === "listening" ? activationAudioLevelRef.current : 0;

      setActivationVisualLevel((current) => {
        const spring = target > current ? 0.42 : sessionState === "processing" ? 0.12 : 0.18;
        const next = current + (target - current) * spring;
        return Math.abs(next - target) < 0.006 ? target : next;
      });
      setActivationPeakLevel((current) => {
        if (sessionState === "success") {
          return 0.72;
        }

        if (sessionState === "listening") {
          return Math.min(1, Math.max(target, current - 0.028));
        }

        if (sessionState === "processing") {
          return Math.max(0, current - 0.045);
        }

        return Math.max(0, current - 0.08);
      });
      frameId = window.requestAnimationFrame(animate);
    };

    frameId = window.requestAnimationFrame(animate);
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [shouldAnimateActivation]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void window.electronAPI
        ?.saveOnboardingState?.({
          flowVersion: ONBOARDING_FLOW_VERSION,
          currentStep,
          uiLanguage: resolvedOnboardingUiLanguage,
          hasCompletedDictationTest,
          recognitionDurationMs: activationElapsedMs,
          dictationDurationMs: null,
          activationStepSkipped,
          activationStatus: hasCompletedDictationTest ? "success" : activationSessionState,
          completed: false,
        })
        ?.catch((error) => {
          console.warn("Failed to save onboarding state:", error);
        });
    }, 200);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    activationElapsedMs,
    activationStepSkipped,
    currentStep,
    hasCompletedDictationTest,
    activationSessionState,
    resolvedOnboardingUiLanguage,
  ]);

  useEffect(() => {
    if (onboardingModelPrepState.status !== "ready" || !onboardingModelPrepState.modelId) {
      return;
    }

    markOnboardingPreparedModelReady(
      onboardingModelPrepState.provider,
      onboardingModelPrepState.modelId
    );
    updateTranscriptionSettings({
      useLocalWhisper: true,
      localTranscriptionProvider:
        onboardingModelPrepState.provider === "paraformer"
          ? "paraformer"
          : onboardingModelPrepState.provider === "parakeet"
            ? "nvidia"
            : localTranscriptionProvider,
      paraformerModel:
        onboardingModelPrepState.provider === "paraformer"
          ? onboardingModelPrepState.modelId
          : paraformerModel,
      parakeetModel:
        onboardingModelPrepState.provider === "parakeet"
          ? onboardingModelPrepState.modelId
          : parakeetModel,
    });
  }, [
    localTranscriptionProvider,
    onboardingModelPrepState.modelId,
    onboardingModelPrepState.provider,
    onboardingModelPrepState.status,
    paraformerModel,
    parakeetModel,
    updateTranscriptionSettings,
  ]);

  useEffect(() => {
    if (currentStep !== activationStepIndex) {
      restoreActivationTranscriptionPrefs();
      return;
    }

    if (onboardingModelPrepState.status === "ready") {
      captureActivationTranscriptionPrefs();
      activationTranscriptionPrefsOverriddenRef.current = true;
      markOnboardingPreparedModelReady(
        onboardingModelPrepState.provider || onboardingStarterModel.provider,
        onboardingModelPrepState.modelId || onboardingStarterModelId
      );
      updateTranscriptionSettings({
        useLocalWhisper: true,
        localTranscriptionProvider:
          (onboardingModelPrepState.provider || onboardingStarterModel.provider) === "paraformer"
            ? "paraformer"
            : (onboardingModelPrepState.provider || onboardingStarterModel.provider) === "parakeet"
              ? "nvidia"
              : localTranscriptionProvider,
        paraformerModel:
          (onboardingModelPrepState.provider || onboardingStarterModel.provider) === "paraformer"
            ? onboardingModelPrepState.modelId || onboardingStarterModelId
            : paraformerModel,
        parakeetModel:
          (onboardingModelPrepState.provider || onboardingStarterModel.provider) === "parakeet"
            ? onboardingModelPrepState.modelId || onboardingStarterModelId
            : parakeetModel,
      });
      return;
    }

    if (!preferredCloudProvider) {
      return;
    }

    captureActivationTranscriptionPrefs();
    activationTranscriptionPrefsOverriddenRef.current = true;
    localStorage.setItem("useLocalStreaming", "false");
    updateTranscriptionSettings({
      useLocalWhisper: false,
      cloudTranscriptionMode: "byok",
      cloudTranscriptionProvider: preferredCloudProvider,
    });
  }, [
    activationStepIndex,
    currentStep,
    onboardingModelPrepState.modelId,
    onboardingModelPrepState.provider,
    onboardingModelPrepState.status,
    onboardingStarterModel.provider,
    onboardingStarterModelId,
    localTranscriptionProvider,
    paraformerModel,
    parakeetModel,
    preferredCloudProvider,
    captureActivationTranscriptionPrefs,
    restoreActivationTranscriptionPrefs,
    updateTranscriptionSettings,
  ]);

  useEffect(() => {
    return () => {
      restoreActivationTranscriptionPrefs();
    };
  }, [restoreActivationTranscriptionPrefs]);

  const ensureHotkeyRegistered = useCallback(async () => {
    if (!window.electronAPI?.updateHotkey) {
      return true;
    }

    try {
      const result = await window.electronAPI.updateHotkey(hotkey);
      if (result && !result.success) {
        showAlertDialog({
          title: t("onboarding.hotkey.couldNotRegisterTitle"),
          description: result.message || t("onboarding.hotkey.couldNotRegisterDescription"),
        });
        return false;
      }

      return true;
    } catch (error) {
      console.error("Failed to register onboarding hotkey", error);
      showAlertDialog({
        title: t("onboarding.hotkey.couldNotRegisterTitle"),
        description: t("onboarding.hotkey.couldNotRegisterDescription"),
      });
      return false;
    }
  }, [hotkey, showAlertDialog, t]);

  const saveSettings = useCallback(async () => {
    const hotkeyRegistered = await ensureHotkeyRegistered();
    if (!hotkeyRegistered) {
      return false;
    }

    setDictationKey(hotkey);
    saveAgentName(DEFAULT_AGENT_NAME);
    // Current desktop onboarding is account-free; a license key is the only
    // activation credential. Keep legacy flags true so older builds never
    // reinterpret a completed onboarding as an unfinished sign-in flow.
    localStorage.setItem("authenticationSkipped", "true");
    localStorage.setItem("skipAuth", "true");
    localStorage.setItem("onboardingCompleted", "true");
    window.electronAPI?.notifyMacNativeHotkeyEligibilityChanged?.(true);

    try {
      await window.electronAPI?.saveAllKeysToEnv?.();
    } catch (error) {
      console.error("Failed to persist API keys:", error);
    }

    return true;
  }, [ensureHotkeyRegistered, hotkey, setDictationKey]);

  const startBackgroundModelPrep = useCallback(
    (
      language: string,
      options: {
        modelsDir?: string;
        forceRestart?: boolean;
      } = {}
    ) => {
      const starterModel = getOnboardingStarterModel(language);
      const starterModelId = starterModel.modelId;
      const modelsDir = String(options.modelsDir || "").trim();
      const normalizedModelsDir = normalizeOnboardingModelsDir(modelsDir);
      const prepKey = [starterModel.provider, starterModelId, language, normalizedModelsDir].join(
        ":"
      );

      if (!options.forceRestart && prepStartedForKeyRef.current === prepKey) {
        return;
      }

      prepStartedForModelRef.current = starterModelId;
      prepStartedForKeyRef.current = prepKey;
      const runId = prepRunIdRef.current + 1;
      prepRunIdRef.current = runId;
      const isCurrentRun = () =>
        prepRunIdRef.current === runId && prepStartedForKeyRef.current === prepKey;

      void (async () => {
        try {
          const trackedState = readOnboardingModelPrepState();
          const isActivePrep =
            trackedState.status === "downloading" || trackedState.status === "installing";
          const isPreparingDifferentTarget =
            trackedState.modelId &&
            (trackedState.modelId !== starterModelId ||
              normalizeOnboardingModelsDir(trackedState.modelsDir) !== normalizedModelsDir);

          if (isActivePrep && isPreparingDifferentTarget) {
            if (trackedState.provider === "paraformer") {
              await window.electronAPI?.cancelParaformerDownload?.();
            } else if (trackedState.provider === "parakeet") {
              await window.electronAPI?.cancelParakeetDownload?.();
            } else {
              await window.electronAPI?.sherpaStreamingCancelDownload?.();
            }

            if (!isCurrentRun()) {
              return;
            }
          }

          updatePrepState({
            status: "checking",
            provider: starterModel.provider,
            modelId: starterModelId,
            modelsDir,
            percentage: 0,
            downloadedBytes: 0,
            totalBytes: 0,
            error: null,
          });

          const checkModel =
            starterModel.provider === "paraformer"
              ? () => window.electronAPI?.checkParaformerModelStatus?.(starterModelId)
              : starterModel.provider === "parakeet"
                ? () => window.electronAPI?.checkParakeetModelStatus?.(starterModelId)
                : () =>
                    window.electronAPI?.sherpaStreamingCheckModel?.(
                      starterModelId,
                      modelsDir || undefined
                    );
          const downloadModel =
            starterModel.provider === "paraformer"
              ? () =>
                  window.electronAPI?.downloadParaformerModel?.(starterModelId, {
                    uiLanguage: language,
                    modelsDir: modelsDir || undefined,
                  })
              : starterModel.provider === "parakeet"
                ? () =>
                    window.electronAPI?.downloadParakeetModel?.(starterModelId, {
                      uiLanguage: language,
                      modelsDir: modelsDir || undefined,
                    })
                : () =>
                    window.electronAPI?.sherpaStreamingDownloadModel?.(
                      starterModelId,
                      modelsDir || undefined,
                      { uiLanguage: language }
                    );

          const alreadyReady = (await checkModel()) as
            | { ready?: boolean; downloaded?: boolean }
            | undefined;

          if (!isCurrentRun()) {
            return;
          }

          const isReady =
            starterModel.provider === "streaming"
              ? Boolean(alreadyReady?.ready)
              : Boolean(alreadyReady?.downloaded);

          if (isReady) {
            markOnboardingPreparedModelReady(starterModel.provider, starterModelId);
            updatePrepState({
              status: "ready",
              provider: starterModel.provider,
              modelId: starterModelId,
              modelsDir,
              percentage: 100,
              error: null,
            });
            return;
          }

          updatePrepState({
            status: "downloading",
            provider: starterModel.provider,
            modelId: starterModelId,
            modelsDir,
            percentage: 0,
            downloadedBytes: 0,
            totalBytes: 0,
            message: null,
            error: null,
          });

          const downloadResult = await downloadModel();

          if (!isCurrentRun()) {
            return;
          }

          if (!downloadResult?.success) {
            prepStartedForModelRef.current = null;
            prepStartedForKeyRef.current = null;
            updatePrepState({
              status: "error",
              provider: starterModel.provider,
              modelId: starterModelId,
              modelsDir,
              error: downloadResult?.error || "Failed to prepare local transcription model.",
            });
            return;
          }

          markOnboardingPreparedModelReady(starterModel.provider, starterModelId);
          updatePrepState({
            status: "ready",
            provider: starterModel.provider,
            modelId: starterModelId,
            modelsDir,
            percentage: 100,
            error: null,
          });
        } catch (error) {
          if (!isCurrentRun()) {
            return;
          }

          prepStartedForModelRef.current = null;
          prepStartedForKeyRef.current = null;
          updatePrepState({
            status: "error",
            provider: starterModel.provider,
            modelId: starterModelId,
            modelsDir,
            error:
              error instanceof Error
                ? error.message
                : "Failed to prepare local transcription model.",
          });
        }
      })();
    },
    [updatePrepState]
  );

  const chooseOnboardingModelStorageRoot = useCallback(async () => {
    if (!window.electronAPI?.pickModelStorageRoot) {
      return null;
    }

    setIsChoosingModelStorageRoot(true);

    try {
      const result = await window.electronAPI.pickModelStorageRoot(
        modelStorageRoot || onboardingPrepModelsDir || undefined
      );

      if (!result?.success || result.cancelled || !result.path) {
        if (result?.error) {
          toast({
            title: t("settingsPage.transcription.storageLocation.saveFailedTitle"),
            description: result.error,
            variant: "destructive",
          });
        }
        return null;
      }

      const nextRoot = String(result.path || "").trim();
      if (!nextRoot) {
        return null;
      }

      await cancelActiveOnboardingPrep();

      const savedRoot = await setModelStorageRoot(nextRoot);
      const persistedRoot = String(savedRoot.root ?? nextRoot).trim();
      const finalRoot = persistedRoot || nextRoot;
      if (shouldShowModelStorageRootNormalizedNotice(result.selectedPath, finalRoot)) {
        toast({
          title: t("settingsPage.transcription.storageLocation.normalizedTitle"),
          description: t("settingsPage.transcription.storageLocation.normalizedDescription", {
            path: finalRoot,
          }),
          duration: 7000,
        });
      }

      resetOnboardingPrepForLanguage(resolvedOnboardingUiLanguage);

      return finalRoot;
    } catch (error) {
      toast({
        title: t("settingsPage.transcription.storageLocation.saveFailedTitle"),
        description:
          error instanceof Error
            ? error.message
            : t("settingsPage.transcription.storageLocation.saveFailedDescription"),
        variant: "destructive",
      });
      return null;
    } finally {
      setIsChoosingModelStorageRoot(false);
    }
  }, [
    cancelActiveOnboardingPrep,
    modelStorageRoot,
    onboardingPrepModelsDir,
    resetOnboardingPrepForLanguage,
    resolvedOnboardingUiLanguage,
    setModelStorageRoot,
    t,
    toast,
  ]);

  const nextStep = useCallback(async () => {
    if (currentStep >= steps.length - 1) {
      return;
    }

    if (currentStep === 0 && isUiLanguageSyncReady) {
      startBackgroundModelPrep(resolvedOnboardingUiLanguage, {
        modelsDir: onboardingPrepModelsDir,
      });
    }

    setCurrentStep((previous) => Math.min(previous + 1, steps.length - 1));
  }, [
    currentStep,
    isUiLanguageSyncReady,
    onboardingPrepModelsDir,
    resolvedOnboardingUiLanguage,
    setCurrentStep,
    startBackgroundModelPrep,
    steps.length,
  ]);

  const prevStep = useCallback(() => {
    setCurrentStep((previous) => Math.max(previous - 1, 0));
  }, [setCurrentStep]);

  const finishOnboarding = useCallback(async () => {
    const saved = await saveSettings();
    if (!saved) {
      return;
    }

    // Fire-and-forget: analytics must never block or break onboarding completion.
    Promise.resolve(window.electronAPI?.trackOnboardingEvent?.("onboarding_completed")).catch(
      () => {}
    );
    preserveActivationTranscriptionPrefsRef.current = true;
    await window.electronAPI?.clearOnboardingState?.();
    removeCurrentStep();
    onComplete();

    // Surface the Pro workflow capability once after onboarding; it is useful
    // but otherwise easy to miss in Settings → Hotkeys.
    window.setTimeout(() => {
      toast({
        title: t("onboarding.workflowHotkeyTip.title"),
        description: t("onboarding.workflowHotkeyTip.description"),
        duration: 12000,
      });
    }, 1500);
  }, [onComplete, removeCurrentStep, saveSettings, t, toast]);

  const permissionsCanProceed =
    permissionsHook.micPermissionGranted &&
    (!isMacOS || permissionsHook.accessibilityPermissionGranted);
  const activationTestUnlocked =
    onboardingModelPrepState.status === "ready" ||
    (onboardingModelPrepState.status !== "error" && hasCloudActivationFallback);
  const manualActivationPass = activationTestUnlocked && activationManualText.trim().length > 0;
  const activationCanProceed =
    hotkey.trim() !== "" && (hasCompletedDictationTest || manualActivationPass);

  const skipCurrentStep = useCallback(() => {
    if (currentStep === 1 && !permissionsCanProceed) {
      showConfirmDialog({
        title: t("onboarding.permissions.skipDialog.title"),
        description: t("onboarding.permissions.skipDialog.description"),
        variant: "destructive",
        confirmText: t("onboarding.permissions.skipDialog.confirm"),
        cancelText: t("onboarding.permissions.skipDialog.cancel"),
        onConfirm: () => {
          hideConfirmDialog();
          void nextStep();
        },
        onCancel: hideConfirmDialog,
      });
      return;
    }

    if (currentStep === activationStepIndex && !activationCanProceed) {
      showConfirmDialog({
        title: t("onboarding.activation.skipDialog.title"),
        description: t("onboarding.activation.skipDialog.description"),
        variant: "destructive",
        confirmText: t("onboarding.activation.skipDialog.confirm"),
        cancelText: t("onboarding.activation.skipDialog.cancel"),
        onConfirm: () => {
          setActivationStepSkipped(true);
          hideConfirmDialog();
          void finishOnboarding();
        },
        onCancel: hideConfirmDialog,
      });
      return;
    }

    if (currentStep < steps.length - 1) {
      void nextStep();
    }
  }, [
    activationCanProceed,
    activationStepIndex,
    currentStep,
    finishOnboarding,
    hideConfirmDialog,
    nextStep,
    permissionsCanProceed,
    showConfirmDialog,
    steps.length,
    t,
  ]);

  const canProceed = () => {
    if (currentStep === 0) {
      return isUiLanguageSyncReady && resolvedOnboardingUiLanguage.trim() !== "";
    }

    if (currentStep === 1) {
      return permissionsCanProceed;
    }

    if (currentStep === activationStepIndex) {
      return activationCanProceed || activationStepSkipped;
    }

    return false;
  };

  const priorityOnboardingLanguageOptions = ONBOARDING_PRIORITY_UI_LANGUAGE_VALUES.map((value) =>
    ONBOARDING_UI_LANGUAGE_OPTIONS.find((option) => option.value === value)
  ).filter((option): option is LanguageOption => Boolean(option));
  const secondaryOnboardingLanguageOptions = ONBOARDING_UI_LANGUAGE_OPTIONS.filter(
    (option) => !ONBOARDING_PRIORITY_UI_LANGUAGE_VALUES.includes(option.value)
  );
  const isPriorityOnboardingLanguage = ONBOARDING_PRIORITY_UI_LANGUAGE_VALUES.includes(
    resolvedOnboardingUiLanguage
  );
  const renderModelStorageCard = (options: { compact?: boolean } = {}) =>
    options.compact ? (
      <div className="glass-panel glass-panel--soft rounded-xl px-4 py-3.5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-sky-600">
              <FolderOpen className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-muted-foreground">
                {t("settingsPage.transcription.storageLocation.label")}
              </p>
              <p
                className="truncate text-base font-semibold leading-6 text-foreground"
                title={onboardingModelStorageRootDisplay}
              >
                {onboardingModelStorageRootDisplay}
              </p>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                {t("onboarding.setup.modelPrepAfterNext")}
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void chooseOnboardingModelStorageRoot();
            }}
            disabled={isChoosingModelStorageRoot}
            className="h-11 shrink-0 px-4 text-sm font-semibold"
          >
            {isChoosingModelStorageRoot ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t("common.loading")}
              </>
            ) : (
              <>
                <FolderOpen className="mr-2 h-4 w-4" />
                {t("common.chooseFolder")}
              </>
            )}
          </Button>
        </div>
      </div>
    ) : (
      <div className="glass-panel glass-panel--soft rounded-xl p-3.5 space-y-2.5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
              <FolderOpen className="h-4 w-4 text-sky-600" />
              <span>{t("settingsPage.transcription.storageLocation.label")}</span>
            </div>
            <p className="text-[11px] leading-5 text-muted-foreground">
              {t("settingsPage.transcription.storageLocation.description")}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void chooseOnboardingModelStorageRoot();
            }}
            disabled={isChoosingModelStorageRoot}
            className="shrink-0"
          >
            {isChoosingModelStorageRoot ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                {t("common.loading")}
              </>
            ) : (
              <>
                <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                {t("common.chooseFolder")}
              </>
            )}
          </Button>
        </div>

        <div className="rounded-xl border border-border/60 bg-muted/35 px-3 py-2.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/75">
            {t("settingsPage.transcription.storageLocation.rootLabel")}
          </p>
          <p className="mt-1 text-sm font-medium text-foreground break-all">
            {onboardingModelStorageRootDisplay}
          </p>
          <p className="mt-1 text-[11px] leading-5 text-muted-foreground/80">
            {t("settingsPage.transcription.storageLocation.streamingFolderHint")}
          </p>
        </div>
      </div>
    );

  const activationRoute =
    onboardingModelPrepState.status === "ready"
      ? {
          mode: "local" as const,
          icon: Check,
          panelClass: "glass-panel glass-panel--success",
          chipClass: "glass-chip glass-chip--success text-emerald-700",
          title: t("onboarding.activation.route.local.title"),
          description: t("onboarding.activation.route.local.description"),
        }
      : onboardingModelPrepState.status === "error"
        ? {
            mode: "error" as const,
            icon: AlertTriangle,
            panelClass: "glass-panel glass-panel--warning",
            chipClass: "glass-chip glass-chip--warning text-amber-700",
            title: t("onboarding.activation.route.error.title"),
            description: t("onboarding.activation.route.error.description"),
          }
        : hasCloudActivationFallback
          ? {
              mode: "cloud" as const,
              icon: Cloud,
              panelClass: "glass-panel glass-panel--soft",
              chipClass: "glass-chip glass-chip--soft text-sky-700",
              title: t("onboarding.activation.route.cloud.title"),
              description: t("onboarding.activation.route.cloud.description"),
            }
          : {
              mode: "waiting" as const,
              icon: Loader2,
              panelClass: "glass-panel glass-panel--warning",
              chipClass: "glass-chip glass-chip--warning text-amber-700",
              title: t("onboarding.activation.route.waiting.title"),
              description: t("onboarding.activation.route.waiting.description"),
            };

  const hotkeyInstructionText =
    activationMode === "tap" || isUsingGnomeHotkeys
      ? t("onboarding.activation.hotkeyToStartStop", { hotkey: readableHotkey })
      : t("onboarding.activation.holdHotkey", { hotkey: readableHotkey });
  const formattedActivationDuration =
    typeof activationElapsedMs === "number"
      ? activationElapsedMs >= 1000
        ? t("onboarding.activation.elapsedSecondsValue", {
            value: (activationElapsedMs / 1000).toFixed(1),
          })
        : t("onboarding.activation.elapsedMillisecondsValue", {
            value: Math.round(activationElapsedMs),
          })
      : null;
  const activationElapsedLabel = formattedActivationDuration
    ? t("onboarding.activation.elapsedLabel", {
        value: formattedActivationDuration,
      })
    : null;
  const activationRouteProgressText =
    onboardingModelPrepState.status === "downloading" ||
    onboardingModelPrepState.status === "installing"
      ? onboardingModelPrepState.status === "installing" ||
        Math.round(onboardingModelPrepState.percentage || 0) >= 100
        ? t("onboarding.activation.route.installingLabel", {
            model: activationRouteModelDisplayName,
          })
        : t("onboarding.activation.route.progressLabel", {
            model: activationRouteModelDisplayName,
            percentage: Math.round(onboardingModelPrepState.percentage || 0),
          })
      : null;
  const activationRouteProgressPercentage = Math.max(
    0,
    Math.min(100, Math.round(onboardingModelPrepState.percentage || 0))
  );
  const activationTestLockedCopy =
    activationRoute.mode === "waiting"
      ? {
          title: t("onboarding.activation.lockedWaitingTitle"),
          description: t("onboarding.activation.lockedWaitingDescription"),
        }
      : activationRoute.mode === "error"
        ? {
            title: t("onboarding.activation.lockedErrorTitle"),
            description: t("onboarding.activation.lockedErrorDescription"),
          }
        : null;
  const activationStatusCopy =
    activationSessionState === "listening"
      ? {
          title: t("onboarding.activation.status.listeningTitle"),
          description: hotkeyInstructionText,
        }
      : activationSessionState === "processing"
        ? {
            title: t("onboarding.activation.status.processingTitle"),
            description: t("onboarding.activation.status.processingDescription"),
          }
        : activationSessionState === "success"
          ? {
              title: t("onboarding.activation.successTitle"),
              description: t("onboarding.activation.successDescription"),
            }
          : activationTestLockedCopy
            ? {
                title: activationTestLockedCopy.title,
                description: activationTestLockedCopy.description,
              }
            : {
                title: t("onboarding.activation.status.readyTitle"),
                description: t("onboarding.activation.testDescription"),
              };
  const activationWaveBars = [
    { envelope: 0.34, width: 4 },
    { envelope: 0.56, width: 4 },
    { envelope: 0.8, width: 5 },
    { envelope: 1, width: 5 },
    { envelope: 0.82, width: 5 },
    { envelope: 0.58, width: 4 },
    { envelope: 0.36, width: 4 },
  ].map((bar, index, bars) => {
    const center = (bars.length - 1) / 2;
    const distance = Math.abs(index - center);
    const restingHeight = 7 + Math.max(0, 4 - distance) * 1.5;
    const liveEnergy = activationVisualLevel;
    const peakEnergy = activationPeakLevel;
    const transientEnergy = Math.max(0, peakEnergy - liveEnergy);

    const height =
      activationSessionState === "listening"
        ? restingHeight +
          bar.envelope * (10 + liveEnergy * 24) +
          transientEnergy * Math.max(1.5, 7 - distance * 1.35)
        : activationSessionState === "processing"
          ? restingHeight + bar.envelope * (7 + peakEnergy * 16)
          : activationSessionState === "success"
            ? 12 + bar.envelope * 18
            : restingHeight;
    const opacity =
      activationSessionState === "listening"
        ? Math.min(1, 0.48 + bar.envelope * 0.16 + liveEnergy * 0.18 + transientEnergy * 0.16)
        : activationSessionState === "processing"
          ? 0.62 + bar.envelope * 0.16 + peakEnergy * 0.12
          : activationSessionState === "success"
            ? 0.88
            : 0.42 + bar.envelope * 0.18;
    const glowAlpha =
      activationSessionState === "idle"
        ? 0
        : Math.min(0.42, 0.08 + bar.envelope * 0.1 + peakEnergy * 0.18);
    const translateY =
      activationSessionState === "listening" ? Math.max(0, (1 - bar.envelope) * 1.6) : 0;

    return {
      ...bar,
      height: Math.round(height),
      opacity: Number(opacity.toFixed(3)),
      translateY: Number(translateY.toFixed(3)),
      boxShadow:
        activationSessionState === "idle"
          ? "none"
          : `0 0 ${Math.round(8 + bar.envelope * 10)}px rgba(56, 189, 248, ${glowAlpha.toFixed(3)})`,
      background:
        activationSessionState === "success"
          ? "linear-gradient(180deg, rgba(103, 232, 249, 0.96) 0%, rgba(96, 165, 250, 0.9) 48%, rgba(168, 85, 247, 0.86) 100%)"
          : activationSessionState === "processing"
            ? "linear-gradient(180deg, rgba(186, 230, 253, 0.92) 0%, rgba(96, 165, 250, 0.8) 100%)"
            : activationSessionState === "listening"
              ? "linear-gradient(180deg, rgba(125, 211, 252, 0.98) 0%, rgba(96, 165, 250, 0.9) 40%, rgba(168, 85, 247, 0.82) 100%)"
              : "linear-gradient(180deg, rgba(191, 219, 254, 0.68) 0%, rgba(96, 165, 250, 0.48) 100%)",
    };
  });

  const renderWelcomeStep = () => (
    <div className="space-y-3">
      <div className="mx-auto max-w-[680px] text-center">
        <div className="mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-full bg-sky-100">
          <Sparkles className="h-5 w-5 text-sky-600" />
        </div>
        <h2 className="text-[1.22rem] font-semibold tracking-tight text-foreground md:text-[1.4rem]">
          {t("onboarding.setup.localPrivacyTitle")}
        </h2>
        <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
          {t("onboarding.setup.localPrivacyDescription")}
        </p>
      </div>

      <div className="rounded-xl border border-border/70 bg-muted/35 p-3 space-y-2.5">
        <div className="space-y-2.5">
          <div className="flex items-center gap-2.5 text-base font-semibold text-foreground">
            <Globe className="h-5 w-5 text-sky-600" />
            <span>{t("settings.language.uiLabel")}</span>
          </div>

          <div className="flex flex-wrap gap-2.5">
            {priorityOnboardingLanguageOptions.map((option) => {
              const isSelected = resolvedOnboardingUiLanguage === option.value;

              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    void changeOnboardingUiLanguage(option.value);
                  }}
                  aria-pressed={isSelected}
                  className={`inline-flex items-center gap-2.5 rounded-full border px-3.5 py-2 text-sm font-semibold transition-all duration-150 ${
                    isSelected
                      ? "border-primary/30 bg-primary/12 text-primary shadow-[0_6px_16px_rgba(96,165,250,0.14)]"
                      : "glass-panel glass-panel--soft text-foreground/85 hover:border-primary/20"
                  }`}
                >
                  <span className="text-base leading-none">{option.flag}</span>
                  <span>{option.label}</span>
                </button>
              );
            })}
          </div>

          <div className="w-full sm:max-w-[320px]">
            <LanguageSelector
              value={resolvedOnboardingUiLanguage}
              onChange={(value) => {
                void changeOnboardingUiLanguage(value);
              }}
              options={secondaryOnboardingLanguageOptions}
              variant="onboarding"
              className="w-full"
              displayOverride={
                isPriorityOnboardingLanguage
                  ? {
                      flag: "🌐",
                      label: t("onboarding.setup.moreLanguages"),
                    }
                  : null
              }
            />
          </div>
        </div>
      </div>

      {renderModelStorageCard({ compact: true })}
    </div>
  );

  const renderPermissionsStep = () => (
    <div className="space-y-4">
      <div className="text-center">
        <h2 className="text-lg font-semibold text-foreground tracking-tight">
          {t("onboarding.permissions.title")}
        </h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          {isMacOS
            ? t("onboarding.permissions.requiredForApp")
            : t("onboarding.permissions.microphoneRequired")}
        </p>
      </div>

      <div className="space-y-1.5">
        <PermissionCard
          icon={Mic}
          title={t("onboarding.permissions.microphoneTitle")}
          description={t("onboarding.permissions.microphoneDescription")}
          granted={permissionsHook.micPermissionGranted}
          onRequest={permissionsHook.requestMicPermission}
          buttonText={t("onboarding.permissions.grant")}
        />

        {isMacOS && (
          <MacPrivacyPermissionCard
            icon={Shield}
            title={t("onboarding.permissions.accessibilityTitle")}
            description={t("onboarding.permissions.accessibilityDescription")}
            granted={permissionsHook.accessibilityPermissionGranted}
            openSettingsLabel={t("settingsPage.permissions.macAccessibilityDrag.openSettings")}
            dragLabel={t("settingsPage.permissions.macAccessibilityDrag.dragLabel")}
            dragDescription={t("settingsPage.permissions.macAccessibilityDrag.description")}
            packagedOnlyDescription={t(
              "settingsPage.permissions.macAccessibilityDrag.packagedOnly"
            )}
            onOpenSettings={permissionsHook.openAccessibilitySettings}
          />
        )}
      </div>

      {!permissionsHook.micPermissionGranted && permissionsHook.micPermissionError && (
        <MicPermissionWarning
          error={permissionsHook.micPermissionError}
          onOpenSoundSettings={permissionsHook.openSoundInputSettings}
          onOpenPrivacySettings={permissionsHook.openMicPrivacySettings}
        />
      )}

      {permissionsHook.pasteToolsInfo?.platform === "linux" &&
        permissionsHook.pasteToolsInfo &&
        !permissionsHook.pasteToolsInfo.available && (
          <PasteToolsInfo
            pasteToolsInfo={permissionsHook.pasteToolsInfo}
            isChecking={permissionsHook.isCheckingPasteTools}
            onCheck={permissionsHook.checkPasteToolsAvailability}
          />
        )}

      <div className="glass-panel glass-panel--soft rounded-xl px-4 py-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Globe className="h-4 w-4 text-sky-600" />
              <span>{t("settings.language.transcriptionLabel")}</span>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              {t("settings.language.transcriptionDescription")}
            </p>
          </div>
          <LanguageSelector
            value={preferredLanguage}
            onChange={(value) => {
              void updateTranscriptionSettings({ preferredLanguage: value });
            }}
            className="w-full sm:w-[260px]"
          />
        </div>
      </div>
    </div>
  );

  const renderActivationStep = () => {
    const RouteIcon = activationRoute.icon;
    const routeInlinePrimaryText = activationRouteProgressText || activationRoute.title;
    const routeInlineDescription =
      activationRoute.mode === "cloud" || activationRoute.mode === "local"
        ? activationRoute.description
        : null;
    const waitingProgressHeadline =
      activationRoute.mode === "waiting" ? activationRouteProgressText : null;
    const showWaitingPrepProgress = Boolean(waitingProgressHeadline);

    return (
      <div className="space-y-3">
        <div
          className={`relative overflow-hidden rounded-xl border px-4 py-3 ${
            showWaitingPrepProgress
              ? "border-amber-200/80 bg-gradient-to-r from-amber-50 via-orange-50/75 to-sky-50 shadow-[0_14px_34px_rgba(245,158,11,0.14)]"
              : "glass-panel glass-panel--soft"
          }`}
        >
          {showWaitingPrepProgress ? (
            <div
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_14%_44%,rgba(251,191,36,0.22),transparent_30%),radial-gradient(circle_at_92%_18%,rgba(96,165,250,0.16),transparent_34%)]"
              aria-hidden="true"
            />
          ) : null}
          <div className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              {showWaitingPrepProgress ? (
                <div
                  className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-amber-200/80 bg-white/85 text-amber-600 shadow-[0_10px_24px_rgba(245,158,11,0.18)]"
                  aria-hidden="true"
                >
                  <span className="absolute inset-1 rounded-full bg-amber-300/25 animate-ping" />
                  <Loader2 className="relative h-5 w-5 animate-spin" />
                </div>
              ) : (
                <div
                  className={`flex h-9 items-end gap-[3px] ${
                    activationSessionState === "idle" ? "opacity-55" : "opacity-100"
                  }`}
                  aria-hidden="true"
                >
                  {activationWaveBars.map((bar, index) => (
                    <span
                      key={index}
                      className="rounded-full transition-[height,opacity,transform,box-shadow] duration-100 ease-out"
                      style={{
                        width: `${bar.width}px`,
                        height: `${bar.height}px`,
                        opacity: bar.opacity,
                        transform: `translateY(${bar.translateY}px)`,
                        boxShadow: bar.boxShadow,
                        background: bar.background,
                      }}
                    />
                  ))}
                </div>
              )}
              <div className="min-w-0 flex-1 space-y-1" aria-live="polite">
                {waitingProgressHeadline ? (
                  <p className="text-base font-semibold leading-6 text-amber-950 sm:text-lg">
                    {waitingProgressHeadline}
                  </p>
                ) : null}
                <p className="text-sm font-semibold text-foreground">
                  {activationStatusCopy.title}
                </p>
                <p className="text-xs leading-5 text-muted-foreground">
                  {activationStatusCopy.description}
                </p>
                {showWaitingPrepProgress ? (
                  <div className="mt-2 h-2 overflow-hidden rounded-full border border-amber-200/70 bg-white/80 shadow-inner">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-amber-400 via-orange-400 to-sky-400 transition-[width] duration-300"
                      style={{ width: `${activationRouteProgressPercentage}%` }}
                    />
                  </div>
                ) : null}
              </div>
            </div>
            {activationElapsedLabel ? (
              <span className="text-[11px] font-medium text-muted-foreground">
                {activationElapsedLabel}
              </span>
            ) : null}
          </div>
        </div>

        <div className="rounded-xl border border-border bg-surface-1 px-4 py-3">
          <div
            className={`grid gap-3 ${isUsingGnomeHotkeys ? "" : "md:grid-cols-[minmax(0,1fr)_220px]"}`}
          >
            <div className="space-y-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("onboarding.activation.hotkey")}
              </span>
              <HotkeyInput
                value={hotkey}
                onChange={async (nextHotkey) => {
                  const success = await registerHotkey(nextHotkey);
                  if (success) {
                    setHotkey(nextHotkey);
                  }
                }}
                disabled={isHotkeyRegistering}
                validate={validateHotkeyForInput}
              />
            </div>

            {!isUsingGnomeHotkeys && (
              <div className="space-y-2">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("onboarding.activation.mode")}
                </span>
                <ActivationModeSelector
                  value={activationMode}
                  onChange={setActivationMode}
                  variant="compact"
                />
              </div>
            )}
          </div>
        </div>

        <div className="glass-panel glass-panel--soft rounded-xl p-4">
          <div className="space-y-3">
            <Textarea
              ref={activationTextareaRef}
              name="activationTestInput"
              rows={2}
              value={activationManualText}
              onChange={(event) => setActivationManualText(event.target.value)}
              placeholder={
                activationTestUnlocked
                  ? t("onboarding.activation.textareaPlaceholder")
                  : t("onboarding.activation.textareaLockedPlaceholder")
              }
              disabled={!activationTestUnlocked}
              aria-label={t("onboarding.activation.textareaPlaceholder")}
              className="min-h-[84px] resize-none text-sm disabled:cursor-not-allowed disabled:opacity-70"
            />

            {activationTestUnlocked ? (
              <>
                {!hasCompletedDictationTest ? (
                  <p className="text-[11px] leading-5 text-muted-foreground">
                    {t("onboarding.activation.manualFallbackHint")}
                  </p>
                ) : null}

                {hasCompletedDictationTest &&
                !activationManualText.trim() &&
                dictationTestPreview ? (
                  <p className="text-[11px] leading-5 text-muted-foreground">
                    <span className="font-medium text-foreground/80">
                      {t("onboarding.activation.lastTranscriptLabel")}
                    </span>{" "}
                    {dictationTestPreview}
                  </p>
                ) : null}

                {!hasCompletedDictationTest && manualActivationPass ? (
                  <div className="glass-panel glass-panel--soft rounded-xl px-4 py-3 text-left">
                    <div className="flex items-start gap-3">
                      <div className="glass-chip glass-chip--soft mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sky-700">
                        <Check className="h-4 w-4" />
                      </div>
                      <div className="space-y-1.5">
                        <p className="text-sm font-semibold text-foreground">
                          {t("onboarding.activation.manualPassTitle")}
                        </p>
                        <p className="text-xs leading-5 text-muted-foreground">
                          {t("onboarding.activation.manualPassDescription")}
                        </p>
                      </div>
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}

            {activationRoute.mode !== "waiting" ? (
              <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  <span
                    className={`${activationRoute.chipClass} inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full`}
                  >
                    <RouteIcon className="h-3.5 w-3.5" />
                  </span>
                  <span className="font-medium text-foreground/90">{routeInlinePrimaryText}</span>
                </div>
                {routeInlineDescription ? (
                  <p className="mt-1 text-[11px] leading-5 text-muted-foreground/80">
                    {routeInlineDescription}
                  </p>
                ) : null}
              </div>
            ) : null}

            {hasCompletedDictationTest || activationCanProceed ? (
              <div className="glass-panel glass-panel--soft rounded-xl px-4 py-3 text-left">
                <div className="flex items-start gap-3">
                  <div className="glass-chip glass-chip--soft mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-amber-700">
                    <Sparkles className="h-4 w-4" />
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-sm font-semibold text-foreground">
                      {t("onboarding.activation.proTipsTitle")}
                    </p>
                    <ul className="space-y-1 text-xs leading-5 text-muted-foreground">
                      <li>· {t("onboarding.activation.proTipsDictionary")}</li>
                      <li>· {t("onboarding.activation.proTipsAgentName")}</li>
                    </ul>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  };

  const renderStep = () => {
    switch (currentStep) {
      case 0:
        return renderWelcomeStep();
      case 1:
        return renderPermissionsStep();
      case 2:
        return renderActivationStep();
      default:
        return null;
    }
  };

  return (
    <div
      className="app-glass-shell h-screen flex flex-col"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      <LiquidGlassFilters />
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => !open && hideConfirmDialog()}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
        onConfirm={confirmDialog.onConfirm}
        onCancel={confirmDialog.onCancel}
        variant={confirmDialog.variant}
      />

      <AlertDialog
        open={alertDialog.open}
        onOpenChange={(open) => !open && hideAlertDialog()}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      <div className="shrink-0 z-10">
        <TitleBar showTitle={true} className="shadow-sm" actions={<SupportDropdown />} />
      </div>

      {showProgress && (
        <div className="glass-panel glass-panel--chrome shrink-0 rounded-none border-x-0 border-t-0 px-6 py-2.5 z-10 md:px-12">
          <div className="max-w-4xl mx-auto">
            <StepProgress steps={steps} currentStep={currentStep} />
          </div>
        </div>
      )}

      <div className="flex-1 px-6 md:px-12 overflow-y-auto py-5">
        <div
          className={`w-full ${
            currentStep === 0
              ? "max-w-[920px]"
              : currentStep === activationStepIndex
                ? "max-w-2xl"
                : "max-w-[860px]"
          } mx-auto`}
        >
          <Card className="glass-panel glass-panel--soft overflow-hidden rounded-xl border border-border/50 shadow-lg backdrop-blur-2xl">
            <CardContent
              className={currentStep === activationStepIndex ? "p-5 md:p-6" : "p-6 md:p-7"}
            >
              {renderStep()}
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="glass-panel glass-panel--chrome shrink-0 rounded-none border-b-0 border-x-0 px-6 py-2.5 z-10 md:px-12">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          {currentStep === 0 ? (
            <div />
          ) : (
            <Button onClick={prevStep} variant="outline" className="h-8 px-5 rounded-full text-xs">
              <ChevronLeft className="w-3.5 h-3.5" />
              {t("common.back")}
            </Button>
          )}

          <div className="flex items-center gap-2">
            {(currentStep === 1 || currentStep === activationStepIndex) && (
              <Button
                onClick={skipCurrentStep}
                variant="ghost"
                className="h-8 px-4 rounded-full text-xs text-muted-foreground"
              >
                {t("common.skip")}
              </Button>
            )}

            {currentStep === steps.length - 1 ? (
              <Button
                onClick={finishOnboarding}
                disabled={!canProceed()}
                variant="success"
                className="h-8 px-6 rounded-full text-xs"
              >
                <Check className="w-3.5 h-3.5" />
                {t("common.complete")}
              </Button>
            ) : (
              <Button
                onClick={nextStep}
                disabled={!canProceed()}
                className="h-8 px-6 rounded-full text-xs"
              >
                {t("common.next")}
                <ChevronRight className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
