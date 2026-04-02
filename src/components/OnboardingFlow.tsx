import React, { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import {
  ChevronRight,
  ChevronLeft,
  Check,
  Settings,
  Mic,
  Shield,
  Command,
  Globe,
  UserCircle,
  AlertTriangle,
} from "lucide-react";
import TitleBar from "./TitleBar";
import PermissionCard from "./ui/PermissionCard";
import SupportDropdown from "./ui/SupportDropdown";
import MicPermissionWarning from "./ui/MicPermissionWarning";
import PasteToolsInfo from "./ui/PasteToolsInfo";
import StepProgress from "./ui/StepProgress";
import { AlertDialog, ConfirmDialog } from "./ui/dialog";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useDialogs } from "../hooks/useDialogs";
import { usePermissions } from "../hooks/usePermissions";
import { useClipboard } from "../hooks/useClipboard";
import { useSettings } from "../hooks/useSettings";
import LanguageSelector, { type LanguageOption } from "./ui/LanguageSelector";
import AuthenticationStep from "./AuthenticationStep";
import EmailVerificationStep from "./EmailVerificationStep";
import { setAgentName as saveAgentName } from "../utils/agentName";
import { formatHotkeyLabel, getDefaultHotkey } from "../utils/hotkeys";
import { useAuth } from "../hooks/useAuth";
import { authClient, NEON_AUTH_URL } from "../lib/neonAuth";
import { HotkeyInput } from "./ui/HotkeyInput";
import { useHotkeyRegistration } from "../hooks/useHotkeyRegistration";
import { getValidationMessage } from "../utils/hotkeyValidator";
import { getPlatform } from "../utils/platform";
import { ActivationModeSelector } from "./ui/ActivationModeSelector";
import OnboardingStreamingModelPicker from "./OnboardingStreamingModelPicker";
import streamingModels from "../config/streamingModels.json";
import logoIcon from "../assets/icon.png";

const STREAMING_MODELS = streamingModels;
const DEFAULT_STREAMING_MODEL_ID =
  STREAMING_MODELS.find((model) => model.default)?.id || STREAMING_MODELS[0]?.id;
const ONBOARDING_FLOW_VERSION = 4;
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
const ONBOARDING_LANGUAGE_PROMPTS = [
  { value: "en", prompt: "Please choose your default interface language." },
  { value: "zh-CN", prompt: "请选择默认的界面语言" },
  { value: "es", prompt: "Selecciona el idioma predeterminado de la interfaz." },
  { value: "ja", prompt: "デフォルトの表示言語を選択してください。" },
  { value: "zh-TW", prompt: "請選擇預設的介面語言" },
  { value: "fr", prompt: "Veuillez choisir votre langue d'interface par défaut." },
  { value: "de", prompt: "Bitte wählen Sie Ihre Standardsprache für die Benutzeroberfläche." },
  { value: "pt", prompt: "Escolha o idioma padrão da interface." },
];

interface OnboardingFlowProps {
  onComplete: () => void;
}

export default function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const { t, i18n } = useTranslation();
  const { isSignedIn } = useAuth();
  const hasAuthStep = Boolean(NEON_AUTH_URL && authClient);
  const activationTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activationStartedAtRef = useRef(0);
  const initialStoredOnboardingStep =
    typeof window !== "undefined" ? window.localStorage.getItem("onboardingCurrentStep") : null;
  const initialStoredOnboardingVersion =
    typeof window !== "undefined" ? window.localStorage.getItem("onboardingFlowVersion") : null;
  const initialStoredOnboardingStepRef = useRef(initialStoredOnboardingStep);
  const initialStoredOnboardingVersionRef = useRef(initialStoredOnboardingVersion);

  // Max valid step index dynamically determined based on auth state
  // Signed-in users: 5 steps (Welcome, Language, Setup, Hotkey, Complete) - index 0-4
  // Non-signed-in users: 6 steps (Welcome, Language, Setup, Permissions, Hotkey, Complete) - index 0-5
  const getMaxStep = useCallback(() => (isSignedIn ? 4 : 5), [isSignedIn]);

  const [currentStep, setCurrentStep, removeCurrentStep] = useLocalStorage(
    "onboardingCurrentStep",
    hasAuthStep ? 0 : 1,
    {
      serialize: String,
      deserialize: (value) => {
        const parsed = parseInt(value, 10);
        // Clamp to valid range to handle users upgrading from older versions
        // with different step counts
        if (isNaN(parsed) || parsed < 0) return hasAuthStep ? 0 : 1;
        if (!hasAuthStep && parsed < 1) return 1;
        const maxStep = getMaxStep();
        if (parsed > maxStep) return maxStep;
        return parsed;
      },
    }
  );

  const {
    useLocalWhisper,
    whisperModel,
    uiLanguage,
    localTranscriptionProvider,
    parakeetModel,
    senseVoiceModelPath,
    senseVoiceBinaryPath,
    cloudTranscriptionProvider,
    cloudTranscriptionModel,
    cloudTranscriptionBaseUrl,
    openaiApiKey,
    groqApiKey,
    doubaoAppId,
    doubaoAccessToken,
    customTranscriptionApiKey,
    setCustomTranscriptionApiKey,
    dictationKey,
    activationMode,
    setActivationMode,
    setUiLanguage,
    setDictationKey,
    setOpenaiApiKey,
    setGroqApiKey,
    setDoubaoAppId,
    setDoubaoAccessToken,
    updateTranscriptionSettings,
    preferredLanguage,
    setSenseVoiceModelPath,
    setSenseVoiceBinaryPath,
  } = useSettings();

  const [hotkey, setHotkey] = useState(dictationKey || getDefaultHotkey());
  const [agentName, setAgentName] = useState("Chord");
  const [skipAuth, setSkipAuth] = useState(false);
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState<string | null>(null);
  const [isModelDownloaded, setIsModelDownloaded] = useState(false);
  const [hasReadyStreamingModel, setHasReadyStreamingModel] = useState(false);
  const [isUsingGnomeHotkeys, setIsUsingGnomeHotkeys] = useState(false);
  const [hasCompletedDictationTest, setHasCompletedDictationTest] = useState(false);
  const [dictationTestPreview, setDictationTestPreview] = useState("");
  const [activationManualText, setActivationManualText] = useState("");
  const [activationStepSkipped, setActivationStepSkipped] = useState(false);
  const readableHotkey = formatHotkeyLabel(hotkey);
  const { alertDialog, confirmDialog, showAlertDialog, hideAlertDialog, hideConfirmDialog } =
    useDialogs();

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
    (hotkey: string) => getValidationMessage(hotkey, getPlatform()),
    []
  );

  const permissionsHook = usePermissions(showAlertDialog);
  useClipboard(showAlertDialog); // Initialize clipboard hook for permission checks

  const activationStepIndex = isSignedIn && !skipAuth ? 3 : 4;
  const completionStepIndex = activationStepIndex + 1;

  // For signed-in users, merge setup and permissions into one step
  const steps =
    isSignedIn && !skipAuth
      ? [
          { title: t("onboarding.steps.welcome"), icon: UserCircle },
          { title: t("onboarding.steps.language"), icon: Globe },
          { title: t("onboarding.steps.setup"), icon: Settings },
          { title: t("onboarding.steps.activation"), icon: Command },
          { title: t("onboarding.steps.complete"), icon: Check },
        ]
      : [
          { title: t("onboarding.steps.welcome"), icon: UserCircle },
          { title: t("onboarding.steps.language"), icon: Globe },
          { title: t("onboarding.steps.setup"), icon: Settings },
          { title: t("onboarding.steps.permissions"), icon: Shield },
          { title: t("onboarding.steps.activation"), icon: Command },
          { title: t("onboarding.steps.complete"), icon: Check },
        ];

  // Only show progress for signed-up users after account creation step
  const showProgress = currentStep > 0;
  const resolvedOnboardingUiLanguage = ONBOARDING_UI_LANGUAGE_VALUES.has(uiLanguage)
    ? uiLanguage
    : uiLanguage.startsWith("zh")
      ? "zh-CN"
      : "en";

  useEffect(() => {
    if (typeof window === "undefined") return;

    const storedVersion = Number(initialStoredOnboardingVersionRef.current || "1");
    if (storedVersion >= ONBOARDING_FLOW_VERSION) {
      return;
    }

    const storedStepBeforeInit = initialStoredOnboardingStepRef.current;
    // Fresh installs have no persisted onboarding step yet. useLocalStorage writes
    // the default step during mount, so only migrate when a real legacy step
    // existed before this component initialized.
    if (storedStepBeforeInit === null) {
      localStorage.setItem("onboardingFlowVersion", String(ONBOARDING_FLOW_VERSION));
      return;
    }

    const rawStep = Number(storedStepBeforeInit || "0");
    let migratedStep = Number.isFinite(rawStep) ? rawStep : hasAuthStep ? 0 : 1;

    if (storedVersion < 2) {
      migratedStep = migratedStep > 0 ? migratedStep + 1 : 0;
    }

    if (storedVersion < 3) {
      const previousCompletionStep = isSignedIn ? 4 : 5;
      if (migratedStep >= previousCompletionStep) {
        migratedStep += 1;
      }
    }

    if (storedVersion < 4) {
      const mergedActivationStart = isSignedIn ? 3 : 4;
      migratedStep = Math.min(migratedStep, mergedActivationStart);
    }

    if (!hasAuthStep && migratedStep < 1) {
      migratedStep = 1;
    }

    migratedStep = Math.min(Math.max(migratedStep, hasAuthStep ? 0 : 1), getMaxStep());

    if (migratedStep !== currentStep) {
      setCurrentStep(migratedStep);
    }

    localStorage.setItem("onboardingFlowVersion", String(ONBOARDING_FLOW_VERSION));
  }, [currentStep, getMaxStep, setCurrentStep]);

  useEffect(() => {
    if (!hasAuthStep) {
      setSkipAuth(true);
    }
  }, [hasAuthStep]);

  useEffect(() => {
    if (currentStep !== 1) {
      return;
    }

    if (uiLanguage === resolvedOnboardingUiLanguage) {
      return;
    }

    setUiLanguage(resolvedOnboardingUiLanguage);
  }, [currentStep, resolvedOnboardingUiLanguage, setUiLanguage, uiLanguage]);

  useEffect(() => {
    const checkHotkeyMode = async () => {
      try {
        const info = await window.electronAPI?.getHotkeyModeInfo();
        if (info?.isUsingGnome) {
          setIsUsingGnomeHotkeys(true);
          setActivationMode("tap");
        }
      } catch (error) {
        console.error("Failed to check hotkey mode:", error);
      }
    };
    checkHotkeyMode();
  }, [setActivationMode]);

  useEffect(() => {
    if (currentStep < 2) {
      return;
    }

    if (!localStorage.getItem("localStreamingModelId")) {
      localStorage.setItem("localStreamingModelId", DEFAULT_STREAMING_MODEL_ID);
    }

    localStorage.setItem("useLocalStreaming", "true");

    if (!isSignedIn || skipAuth) {
      updateTranscriptionSettings({ cloudTranscriptionMode: "byok" });
    }
  }, [currentStep, isSignedIn, skipAuth, updateTranscriptionSettings]);

  useEffect(() => {
    const modelToCheck =
      localTranscriptionProvider === "nvidia"
        ? parakeetModel
        : localTranscriptionProvider === "sensevoice"
          ? senseVoiceModelPath
          : whisperModel;
    if (!useLocalWhisper || !modelToCheck) {
      setIsModelDownloaded(false);
      return;
    }

    const checkStatus = async () => {
      try {
        if (localTranscriptionProvider === "nvidia") {
          const result = await window.electronAPI?.checkParakeetModelStatus(modelToCheck);
          setIsModelDownloaded(result?.downloaded ?? false);
          return;
        }

        if (localTranscriptionProvider === "sensevoice") {
          const modelStatus = await window.electronAPI?.checkSenseVoiceModelStatus(modelToCheck);
          const installStatus = await window.electronAPI?.checkSenseVoiceInstallation(
            senseVoiceBinaryPath
          );
          setIsModelDownloaded(Boolean(modelStatus?.downloaded && installStatus?.working));
          return;
        }

        const result = await window.electronAPI?.checkModelStatus(modelToCheck);
        setIsModelDownloaded(result?.downloaded ?? false);
      } catch (error) {
        console.error("Failed to check model status:", error);
        setIsModelDownloaded(false);
      }
    };

    checkStatus();
  }, [
    useLocalWhisper,
    whisperModel,
    parakeetModel,
    senseVoiceModelPath,
    senseVoiceBinaryPath,
    localTranscriptionProvider,
  ]);

  useEffect(() => {
    if (currentStep !== activationStepIndex) {
      // Reset initialization flag when leaving activation step.
      hotkeyStepInitializedRef.current = false;
      return;
    }

    // Prevent double-invocation from React.StrictMode
    if (autoRegisterInFlightRef.current || hotkeyStepInitializedRef.current) {
      return;
    }

    const autoRegisterDefaultHotkey = async () => {
      autoRegisterInFlightRef.current = true;
      hotkeyStepInitializedRef.current = true;

      try {
        // Get platform-appropriate default hotkey
        const defaultHotkey = getDefaultHotkey();
        const platform = window.electronAPI?.getPlatform?.() ?? "darwin";

        // Only auto-register if no hotkey is currently set
        const shouldAutoRegister =
          !hotkey || hotkey.trim() === "" || (platform !== "darwin" && hotkey === "GLOBE");

        if (shouldAutoRegister) {
          // Try to register the default hotkey silently
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

  const syncDictationTestState = useCallback(() => {
    const lastSuccessAt = Number(localStorage.getItem("onboardingLastDictationSuccessAt") || "0");
    if (!lastSuccessAt || lastSuccessAt < activationStartedAtRef.current) {
      return false;
    }
    const preview = (localStorage.getItem("onboardingLastDictationText") || "").trim();
    setHasCompletedDictationTest(true);
    setDictationTestPreview(preview);
    return true;
  }, []);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (
        event.key === "onboardingLastDictationSuccessAt" ||
        event.key === "onboardingLastDictationText"
      ) {
        syncDictationTestState();
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [syncDictationTestState]);

  useEffect(() => {
    if (currentStep !== activationStepIndex) {
      return;
    }

    activationStartedAtRef.current = Date.now();
    setHasCompletedDictationTest(false);
    setDictationTestPreview("");
    setActivationManualText("");
    setActivationStepSkipped(false);
    void syncDictationTestState();
  }, [activationStepIndex, currentStep, syncDictationTestState]);

  useEffect(() => {
    if (currentStep !== activationStepIndex || hasCompletedDictationTest) {
      return;
    }

    const intervalId = window.setInterval(() => {
      syncDictationTestState();
    }, 400);

    return () => window.clearInterval(intervalId);
  }, [activationStepIndex, currentStep, hasCompletedDictationTest, syncDictationTestState]);

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
    saveAgentName(agentName);

    const skippedAuth = skipAuth;
    localStorage.setItem("authenticationSkipped", skippedAuth.toString());
    localStorage.setItem("onboardingCompleted", "true");
    localStorage.setItem("skipAuth", skippedAuth.toString());
    localStorage.removeItem("onboardingLastDictationSuccessAt");
    localStorage.removeItem("onboardingLastDictationText");

    try {
      await window.electronAPI?.saveAllKeysToEnv?.();
    } catch (error) {
      console.error("Failed to persist API keys:", error);
    }

    return true;
  }, [hotkey, agentName, setDictationKey, ensureHotkeyRegistered, skipAuth]);

  const nextStep = useCallback(async () => {
    if (currentStep >= steps.length - 1) {
      return;
    }

    setCurrentStep(currentStep + 1);
  }, [currentStep, setCurrentStep, steps.length]);

  const prevStep = useCallback(() => {
    if (!hasAuthStep && currentStep <= 1) {
      return;
    }
    if (currentStep > 0) {
      const newStep = currentStep - 1;
      setCurrentStep(newStep);
    }
  }, [currentStep, hasAuthStep, setCurrentStep]);

  const finishOnboarding = useCallback(async () => {
    const saved = await saveSettings();
    if (!saved) {
      return;
    }
    removeCurrentStep();
    onComplete();
  }, [saveSettings, removeCurrentStep, onComplete]);

  const skipCurrentStep = useCallback(() => {
    if (currentStep >= steps.length - 1) {
      return;
    }

    if (currentStep === activationStepIndex) {
      setActivationStepSkipped(true);
    }

    void nextStep();
  }, [activationStepIndex, currentStep, nextStep, steps.length]);

  const isTranscriptionSetupComplete = useCallback(() => {
    if (useLocalWhisper) {
      const modelToCheck =
        localTranscriptionProvider === "nvidia"
          ? parakeetModel
          : localTranscriptionProvider === "sensevoice"
            ? senseVoiceModelPath
            : whisperModel;
      return modelToCheck !== "" && isModelDownloaded;
    }

    if (cloudTranscriptionProvider === "openai") {
      return openaiApiKey.trim().length > 0;
    }
    if (cloudTranscriptionProvider === "groq") {
      return groqApiKey.trim().length > 0;
    }
    if (cloudTranscriptionProvider === "custom") {
      return true;
    }
    return openaiApiKey.trim().length > 0;
  }, [
    useLocalWhisper,
    localTranscriptionProvider,
    parakeetModel,
    senseVoiceModelPath,
    whisperModel,
    isModelDownloaded,
    cloudTranscriptionProvider,
    openaiApiKey,
    groqApiKey,
  ]);

  const renderLanguageStep = () => (
    <div className="space-y-5">
      <div className="mx-auto max-w-[920px] text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-sky-100">
          <Globe className="h-6 w-6 text-sky-600" />
        </div>
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-sky-700/70">
          Language
        </p>
        <h2 className="mt-2.5 text-[2rem] font-semibold tracking-tight text-foreground">
          Please choose your default interface language.
        </h2>
        <p className="mt-2 text-base text-muted-foreground">请选择默认的界面语言</p>
        <div className="mt-4 grid gap-2 text-left sm:grid-cols-2">
          {ONBOARDING_LANGUAGE_PROMPTS.filter(
            (entry) => entry.value !== "en" && entry.value !== "zh-CN"
          ).map((entry) => {
            const languageOption = ONBOARDING_UI_LANGUAGE_OPTIONS.find(
              (option) => option.value === entry.value
            );
            return (
              <div
                key={entry.value}
                className="rounded-lg border border-border/60 bg-muted/35 px-3 py-1.5"
              >
                <p className="text-[11px] font-medium text-foreground/80">
                  {languageOption?.flag} {languageOption?.label}
                </p>
                <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">{entry.prompt}</p>
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-xl border border-border/70 bg-muted/35 p-4 space-y-3">
        <div className="space-y-1">
          <h3 className="text-[15px] font-semibold text-foreground">Default Interface Language</h3>
          <p className="text-[13px] text-muted-foreground">默认界面语言</p>
        </div>

        <LanguageSelector
          value={resolvedOnboardingUiLanguage}
          onChange={setUiLanguage}
          options={ONBOARDING_UI_LANGUAGE_OPTIONS}
          variant="onboarding"
          className="w-full"
        />
      </div>
    </div>
  );

  const renderStep = () => {
    switch (currentStep) {
      case 0: // Authentication (with Welcome)
        if (pendingVerificationEmail) {
          return (
            <EmailVerificationStep
              email={pendingVerificationEmail}
              onVerified={() => {
                setPendingVerificationEmail(null);
                nextStep();
              }}
            />
          );
        }
        return (
          <AuthenticationStep
            onContinueWithoutAccount={() => {
              setSkipAuth(true);
              nextStep();
            }}
            onAuthComplete={() => {
              nextStep();
            }}
            onNeedsVerification={(email) => {
              setPendingVerificationEmail(email);
            }}
          />
        );

      case 1:
        return renderLanguageStep();

      case 2: // Setup - Choose Mode & Configure (merged with permissions for signed-in users)
        {
          const platform = permissionsHook.pasteToolsInfo?.platform;
          const isMacOS = platform === "darwin";
          const showInlinePermissions = isSignedIn && !skipAuth;

          return (
            <div className="space-y-3">
              <div className="rounded-xl border border-border/70 bg-muted/25 px-4 py-2.5">
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                    <Check className="h-4.5 w-4.5" />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700/75">
                      {t("onboarding.steps.setup")}
                    </p>
                    <h2 className="text-base font-semibold tracking-tight text-foreground">
                      {t("onboarding.setup.title")}
                    </h2>
                    <p className="text-[13px] leading-5 text-muted-foreground">
                      {t("onboarding.setup.description")}
                    </p>
                  </div>
                </div>
              </div>

              <div className="grid gap-3 lg:grid-cols-[minmax(0,1.45fr)_minmax(260px,0.82fr)] lg:items-start">
                <OnboardingStreamingModelPicker onReadyChange={setHasReadyStreamingModel} />

                <div className="space-y-2.5 rounded-xl border border-border/60 bg-muted/35 p-3">
                  <div className="space-y-1">
                    <label className="block text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                      {t("settings.language.transcriptionLabel")}
                    </label>
                    <p className="text-[11px] leading-5 text-muted-foreground">
                      {t("settings.language.transcriptionDescription")}
                    </p>
                  </div>
                  <LanguageSelector
                    value={preferredLanguage}
                    onChange={(value) => {
                      updateTranscriptionSettings({ preferredLanguage: value });
                    }}
                    className="w-full"
                  />
                </div>
              </div>

              {showInlinePermissions && (
                <div className="space-y-3">
                  <h3 className="text-sm font-medium text-foreground">
                    {t("onboarding.permissions.title")}
                  </h3>
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
                      <PermissionCard
                        icon={Shield}
                        title={t("onboarding.permissions.accessibilityTitle")}
                        description={t("onboarding.permissions.accessibilityDescription")}
                        granted={permissionsHook.accessibilityPermissionGranted}
                        onRequest={permissionsHook.testAccessibilityPermission}
                        buttonText={t("onboarding.permissions.testAndGrant")}
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

                  {platform === "linux" &&
                    permissionsHook.pasteToolsInfo &&
                    !permissionsHook.pasteToolsInfo.available && (
                      <PasteToolsInfo
                        pasteToolsInfo={permissionsHook.pasteToolsInfo}
                        isChecking={permissionsHook.isCheckingPasteTools}
                        onCheck={permissionsHook.checkPasteToolsAvailability}
                      />
                    )}
                </div>
              )}
            </div>
          );
        }

      case 3: // Permissions (only for non-signed-in users) or Activation (for signed-in users)
        // For signed-in users, this is the activation step
        if (isSignedIn && !skipAuth) {
          return renderActivationStep();
        }

        // For non-signed-in users, this is the permissions step
        const platform = permissionsHook.pasteToolsInfo?.platform;
        const isMacOS = platform === "darwin";

        return (
          <div className="space-y-4">
            {/* Header - compact */}
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

            {/* Permission cards - tight stack */}
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
                <PermissionCard
                  icon={Shield}
                  title={t("onboarding.permissions.accessibilityTitle")}
                  description={t("onboarding.permissions.accessibilityDescription")}
                  granted={permissionsHook.accessibilityPermissionGranted}
                  onRequest={permissionsHook.testAccessibilityPermission}
                  buttonText={t("onboarding.permissions.testAndGrant")}
                  onOpenSettings={permissionsHook.openAccessibilitySettings}
                />
              )}
            </div>


            {/* Error state - only show when there's actually an issue */}
            {!permissionsHook.micPermissionGranted && permissionsHook.micPermissionError && (
              <MicPermissionWarning
                error={permissionsHook.micPermissionError}
                onOpenSoundSettings={permissionsHook.openSoundInputSettings}
                onOpenPrivacySettings={permissionsHook.openMicPrivacySettings}
              />
            )}

            {/* Linux paste tools - only when needed */}
            {platform === "linux" &&
              permissionsHook.pasteToolsInfo &&
              !permissionsHook.pasteToolsInfo.available && (
                <PasteToolsInfo
                  pasteToolsInfo={permissionsHook.pasteToolsInfo}
                  isChecking={permissionsHook.isCheckingPasteTools}
                  onCheck={permissionsHook.checkPasteToolsAvailability}
                />
              )}
          </div>
        );

      case 4: // Activation (only for non-signed-in users) or completion (for signed-in users)
        if (isSignedIn && !skipAuth) {
          return renderCompletionStep();
        }
        return renderActivationStep();

      case 5: // Completion (only for non-signed-in users)
        return renderCompletionStep();

      default:
        return null;
    }
  };

  const focusActivationInput = useCallback(() => {
    activationTextareaRef.current?.focus();
  }, []);

  const activationCanProceed =
    hotkey.trim() !== "" &&
    (hasCompletedDictationTest || activationManualText.trim() !== "" || activationStepSkipped);
  const hotkeyInstructionText =
    activationMode === "tap" || isUsingGnomeHotkeys
      ? t("onboarding.activation.hotkeyToStartStop", { hotkey: readableHotkey })
      : t("onboarding.activation.holdHotkey", { hotkey: readableHotkey });

  const renderActivationStep = () => (
    <div className="space-y-4">
      <div className="text-center">
        <div className="mx-auto mb-2.5 flex h-10 w-10 items-center justify-center rounded-full bg-sky-100">
          <Command className="h-5 w-5 text-sky-700" />
        </div>
        <h2 className="text-base font-semibold text-foreground tracking-tight md:text-lg">
          {t("onboarding.activation.title")}
        </h2>
        <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
          {t("onboarding.activation.description")}
        </p>
      </div>

      <div className="grid gap-3">
        <div className={`grid gap-3 ${isUsingGnomeHotkeys ? "" : "md:grid-cols-[minmax(0,1fr)_220px]"}`}>
          <div className="rounded-xl border border-border-subtle bg-surface-1 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("onboarding.activation.hotkey")}
                </span>
                <p className="mt-1 text-[11px] leading-5 text-muted-foreground/80">
                  {t("onboarding.activation.hotkeyHint")}
                </p>
              </div>
              <span className="text-[11px] text-muted-foreground">{hotkeyInstructionText}</span>
            </div>
            <HotkeyInput
              value={hotkey}
              onChange={async (newHotkey) => {
                const success = await registerHotkey(newHotkey);
                if (success) {
                  setHotkey(newHotkey);
                }
              }}
              disabled={isHotkeyRegistering}
              validate={validateHotkeyForInput}
            />
          </div>

          {!isUsingGnomeHotkeys && (
            <div className="rounded-xl border border-border-subtle bg-surface-1 p-4">
              <div className="mb-3 space-y-1">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("onboarding.activation.mode")}
                </span>
                <p className="text-[11px] leading-5 text-muted-foreground/80">
                  {activationMode === "tap"
                    ? t("onboarding.activation.tapDescription")
                    : t("onboarding.activation.holdDescription")}
                </p>
              </div>
              <ActivationModeSelector
                value={activationMode}
                onChange={setActivationMode}
                variant="compact"
              />
            </div>
          )}
        </div>

        <div className="rounded-xl border border-border/70 bg-background/90 p-4">
          <div className="space-y-3">
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <div>
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("onboarding.activation.test")}
                </span>
                <p className="mt-1 text-sm text-foreground">{t("onboarding.activation.testDescription")}</p>
                <p className="mt-1 text-[11px] text-muted-foreground/80">{hotkeyInstructionText}</p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={focusActivationInput}>
                {t("onboarding.activation.focusInput")}
              </Button>
            </div>

            <Textarea
              ref={activationTextareaRef}
              rows={2}
              value={activationManualText}
              onChange={(event) => setActivationManualText(event.target.value)}
              placeholder={t("onboarding.activation.textareaPlaceholder")}
              className="min-h-[84px] resize-none text-sm"
            />

            <p className="text-[11px] leading-5 text-muted-foreground">
              {t("onboarding.activation.manualFallbackHint")}
            </p>

            {hasCompletedDictationTest ? (
              <div className="rounded-xl border border-emerald-200/70 bg-emerald-50/80 px-4 py-3 text-left">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                    <Check className="h-4 w-4" />
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-sm font-semibold text-emerald-950">
                      {t("onboarding.activation.successTitle")}
                    </p>
                    <p className="text-xs leading-5 text-emerald-900/80">
                      {t("onboarding.activation.successDescription")}
                    </p>
                    {dictationTestPreview ? (
                      <div className="rounded-lg border border-emerald-200/80 bg-white/70 px-3 py-2 text-xs text-emerald-950">
                        <span className="font-medium">{t("onboarding.activation.lastTranscriptLabel")}</span>{" "}
                        {dictationTestPreview}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-amber-200/70 bg-amber-50/80 px-4 py-3 text-xs leading-5 text-amber-900/80">
                {t("onboarding.activation.completeHint")}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  const renderCompletionStep = () => (
    <div className="space-y-4">
      <div className="text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100">
          <Check className="h-6 w-6 text-emerald-600" />
        </div>
        <h2 className="text-xl font-semibold text-foreground md:text-2xl">
          {t("onboarding.completion.title")}
        </h2>
        <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
          {t("onboarding.completion.description")}
        </p>
      </div>

      {!hasAuthStep ? (
        <div className="rounded-xl border border-emerald-200/70 bg-emerald-50/80 p-4">
          <div className="flex items-start gap-3">
            <img
              src={logoIcon}
              alt="ChordVox"
              className="h-10 w-10 shrink-0 rounded-xl shadow-sm"
            />
            <div className="space-y-1">
              <p className="text-base font-semibold text-emerald-950">
                {t("auth.welcomeTitle")}
              </p>
              <p className="text-sm text-emerald-900/85">{t("auth.welcomeSubtitle")}</p>
              <p className="text-xs leading-5 text-emerald-900/80">{t("auth.localPrivacyHint")}</p>
            </div>
          </div>
        </div>
      ) : null}

      <div className="rounded-xl border border-border/70 bg-muted/25 px-4 py-3">
        <div className="space-y-2 text-sm text-foreground">
          <p>{t("onboarding.completion.hotkeyReady", { hotkey: readableHotkey })}</p>
          {hasCompletedDictationTest ? <p>{t("onboarding.completion.tryReady")}</p> : null}
        </div>
      </div>

      {dictationTestPreview ? (
        <div className="rounded-xl border border-emerald-200/70 bg-emerald-50/80 px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wide text-emerald-800/80">
            {t("onboarding.completion.firstResultLabel")}
          </p>
          <p className="mt-2 text-sm leading-6 text-emerald-950">{dictationTestPreview}</p>
        </div>
      ) : null}
    </div>
  );

  const canProceed = () => {
    if (currentStep === 0) {
      return isSignedIn || skipAuth;
    }

    if (currentStep === 1) {
      return resolvedOnboardingUiLanguage.trim() !== "";
    }

    if (currentStep === 2) {
      if (!hasReadyStreamingModel) {
        return false;
      }

      if (isSignedIn && !skipAuth) {
        if (!permissionsHook.micPermissionGranted) {
          return false;
        }
        const currentPlatform = permissionsHook.pasteToolsInfo?.platform;
        if (currentPlatform === "darwin") {
          return permissionsHook.accessibilityPermissionGranted;
        }
      }

      return true;
    }

    if (!isSignedIn && currentStep === 3) {
      if (!permissionsHook.micPermissionGranted) {
        return false;
      }
      const currentPlatform = permissionsHook.pasteToolsInfo?.platform;
      if (currentPlatform === "darwin") {
        return permissionsHook.accessibilityPermissionGranted;
      }
      return true;
    }

    if (currentStep === activationStepIndex) {
      return activationCanProceed;
    }

    if (currentStep === completionStepIndex) {
      return true;
    }

    return false;
  };

  // Load Google Font only in the browser
  React.useEffect(() => {
    const link = document.createElement("link");
    link.href =
      "https://fonts.googleapis.com/css2?family=Noto+Sans:wght@300;400;500;600;700&display=swap";
    link.rel = "stylesheet";
    document.head.appendChild(link);
    return () => {
      document.head.removeChild(link);
    };
  }, []);

  return (
    <div
      className="h-screen flex flex-col bg-background"
      style={{
        paddingTop: "env(safe-area-inset-top, 0px)",
      }}
    >
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => !open && hideConfirmDialog()}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
        onConfirm={confirmDialog.onConfirm}
      />

      <AlertDialog
        open={alertDialog.open}
        onOpenChange={(open) => !open && hideAlertDialog()}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      {/* Title Bar */}
      <div className="shrink-0 z-10">
        <TitleBar
          showTitle={true}
          className="bg-background backdrop-blur-xl border-b border-border shadow-sm"
          actions={isSignedIn ? <SupportDropdown /> : undefined}
        ></TitleBar>
      </div>

      {/* Progress Bar - hidden on welcome/auth step */}
      {showProgress && (
        <div className="shrink-0 bg-background/80 backdrop-blur-2xl border-b border-white/5 px-6 md:px-12 py-2.5 z-10">
          <div className="max-w-4xl mx-auto">
            <StepProgress steps={steps.slice(1)} currentStep={currentStep - 1} />
          </div>
        </div>
      )}

      {/* Content - This will grow to fill available space */}
      <div
        className={`flex-1 px-6 md:px-12 overflow-y-auto ${currentStep === 0 ? "flex items-center" : "py-5"}`}
      >
        <div
          className={`w-full ${
            currentStep === 0
              ? "max-w-sm"
              : currentStep === 2
                ? "max-w-4xl"
                : currentStep === activationStepIndex || currentStep === completionStepIndex
                  ? "max-w-2xl"
                  : "max-w-3xl"
          } mx-auto`}
        >
          <Card className="bg-card/90 backdrop-blur-2xl border border-border/50 dark:border-white/5 shadow-lg rounded-xl overflow-hidden">
            <CardContent
              className={
                currentStep === 0
                  ? "p-6"
                  : currentStep === 2
                    ? "p-5 md:p-6"
                    : currentStep === activationStepIndex || currentStep === completionStepIndex
                      ? "p-5 md:p-6"
                      : "p-6 md:p-7"
              }
            >
              {renderStep()}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Footer Navigation - hidden on welcome/auth step */}
      {showProgress && (
        <div className="shrink-0 bg-background/80 backdrop-blur-2xl border-t border-white/5 px-6 md:px-12 py-2.5 z-10">
          <div className="max-w-4xl mx-auto flex items-center justify-between">
            {/* Hide back button on first visible step */}
            {!(
              (currentStep === 1 && isSignedIn && !skipAuth) ||
              (currentStep === 1 && !hasAuthStep)
            ) && (
              <Button
                onClick={prevStep}
                variant="outline"
                disabled={currentStep === 0}
                className="h-8 px-5 rounded-full text-xs"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                {t("common.back")}
              </Button>
            )}

            {/* Spacer to push next button to the right when back button is hidden */}
            {((currentStep === 1 && isSignedIn && !skipAuth) ||
              (currentStep === 1 && !hasAuthStep)) && <div />}

            <div className="flex items-center gap-2">
              {currentStep !== steps.length - 1 && currentStep !== activationStepIndex && (
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
      )}
    </div>
  );
}
