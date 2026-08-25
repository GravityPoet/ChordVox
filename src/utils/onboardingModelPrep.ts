import { writeLocalStorageValue } from "../hooks/useLocalStorage";
import {
  DEFAULT_ENGLISH_PARAKEET_MODEL_ID,
  DEFAULT_PARAFORMER_MODEL_ID,
} from "./defaultTranscriptionModel";

export const ONBOARDING_MODEL_PREP_STORAGE_KEY = "onboardingModelPrepState";
export const ONBOARDING_MODEL_PREP_EVENT = "onboarding-model-prep-state-changed";

export type OnboardingModelPrepStatus =
  | "idle"
  | "checking"
  | "downloading"
  | "installing"
  | "ready"
  | "error";

export type OnboardingModelPrepProvider = "streaming" | "paraformer" | "parakeet";

export interface OnboardingModelPrepState {
  status: OnboardingModelPrepStatus;
  provider: OnboardingModelPrepProvider;
  modelId: string | null;
  modelsDir: string | null;
  percentage: number;
  downloadedBytes: number;
  totalBytes: number;
  message: string | null;
  error: string | null;
  updatedAt: number;
}

const DEFAULT_ONBOARDING_MODEL_PREP_STATE: OnboardingModelPrepState = {
  status: "idle",
  provider: "streaming",
  modelId: null,
  modelsDir: null,
  percentage: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  message: null,
  error: null,
  updatedAt: 0,
};

function safeNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface OnboardingStarterModel {
  provider: OnboardingModelPrepProvider;
  modelId: string;
}

export function getOnboardingStarterModel(uiLanguage: string): OnboardingStarterModel {
  const normalizedLanguage = String(uiLanguage || "")
    .trim()
    .toLowerCase();

  if (normalizedLanguage.startsWith("zh")) {
    return { provider: "paraformer", modelId: DEFAULT_PARAFORMER_MODEL_ID };
  }

  if (normalizedLanguage === "en" || normalizedLanguage.startsWith("en-")) {
    return { provider: "parakeet", modelId: DEFAULT_ENGLISH_PARAKEET_MODEL_ID };
  }

  return { provider: "streaming", modelId: "nemotron-streaming-en-0.6b" };
}

export function getOnboardingStarterModelId(uiLanguage: string): string {
  return getOnboardingStarterModel(uiLanguage).modelId;
}

export function readOnboardingModelPrepState(): OnboardingModelPrepState {
  if (typeof window === "undefined") {
    return DEFAULT_ONBOARDING_MODEL_PREP_STATE;
  }

  try {
    const raw = window.localStorage.getItem(ONBOARDING_MODEL_PREP_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_ONBOARDING_MODEL_PREP_STATE;
    }

    const parsed = JSON.parse(raw) as Partial<OnboardingModelPrepState>;
    return {
      ...DEFAULT_ONBOARDING_MODEL_PREP_STATE,
      ...parsed,
      status: parsed.status ?? DEFAULT_ONBOARDING_MODEL_PREP_STATE.status,
      provider:
        parsed.provider === "paraformer" ||
        parsed.provider === "parakeet" ||
        parsed.provider === "streaming"
          ? parsed.provider
          : inferOnboardingModelPrepProvider(parsed.modelId),
      modelId: parsed.modelId ?? null,
      modelsDir: typeof parsed.modelsDir === "string" ? parsed.modelsDir : null,
      percentage: safeNumber(parsed.percentage),
      downloadedBytes: safeNumber(parsed.downloadedBytes),
      totalBytes: safeNumber(parsed.totalBytes),
      message: typeof parsed.message === "string" ? parsed.message : null,
      error: typeof parsed.error === "string" ? parsed.error : null,
      updatedAt: safeNumber(parsed.updatedAt),
    };
  } catch (error) {
    console.error("Failed to read onboarding model prep state:", error);
    return DEFAULT_ONBOARDING_MODEL_PREP_STATE;
  }
}

export function writeOnboardingModelPrepState(
  patch: Partial<OnboardingModelPrepState>
): OnboardingModelPrepState {
  const nextState: OnboardingModelPrepState = {
    ...readOnboardingModelPrepState(),
    ...patch,
    updatedAt: Date.now(),
  };

  if (typeof window !== "undefined") {
    window.localStorage.setItem(ONBOARDING_MODEL_PREP_STORAGE_KEY, JSON.stringify(nextState));
    window.dispatchEvent(
      new CustomEvent<OnboardingModelPrepState>(ONBOARDING_MODEL_PREP_EVENT, {
        detail: nextState,
      })
    );
  }

  return nextState;
}

export function inferOnboardingModelPrepProvider(
  modelId: string | null | undefined
): OnboardingModelPrepProvider {
  const normalizedModelId = String(modelId || "").trim();
  if (normalizedModelId === DEFAULT_PARAFORMER_MODEL_ID) return "paraformer";
  if (normalizedModelId === DEFAULT_ENGLISH_PARAKEET_MODEL_ID) return "parakeet";
  return "streaming";
}

export function normalizeOnboardingModelsDir(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .replace(/[\\/]+$/, "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

export function isOnboardingDownloadEventForPrepState(
  data:
    | {
        model?: string;
        modelsDir?: string | null;
        models_dir?: string | null;
      }
    | null
    | undefined,
  state: OnboardingModelPrepState
): boolean {
  if (!data || !state.modelId || data.model !== state.modelId) {
    return false;
  }

  const trackedModelsDir = normalizeOnboardingModelsDir(state.modelsDir);
  if (!trackedModelsDir) {
    return true;
  }

  const eventModelsDir = normalizeOnboardingModelsDir(data.modelsDir || data.models_dir || null);
  return Boolean(eventModelsDir && eventModelsDir === trackedModelsDir);
}

export function markOnboardingLocalStreamingReady(modelId: string) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem("localStreamingModelId", modelId);
  window.localStorage.setItem("useLocalStreaming", "true");
  writeLocalStorageValue("useLocalWhisper", "true");
}

export function markOnboardingPreparedModelReady(
  provider: OnboardingModelPrepProvider,
  modelId: string
) {
  if (typeof window === "undefined") {
    return;
  }

  if (provider === "paraformer") {
    window.localStorage.setItem("useLocalStreaming", "false");
    writeLocalStorageValue("useLocalWhisper", "true");
    window.localStorage.setItem("localTranscriptionProvider", "paraformer");
    window.localStorage.setItem("paraformerModel", modelId);
    return;
  }

  if (provider === "parakeet") {
    window.localStorage.setItem("useLocalStreaming", "false");
    writeLocalStorageValue("useLocalWhisper", "true");
    window.localStorage.setItem("localTranscriptionProvider", "nvidia");
    window.localStorage.setItem("parakeetModel", modelId);
    return;
  }

  markOnboardingLocalStreamingReady(modelId);
}
