import {
  REASONING_PROVIDERS,
  getCohereModelInfo,
  getGraniteModelInfo,
  getParakeetModelInfo,
  getParaformerModelInfo,
  getTranscriptionProvider,
  getWhisperModelInfo,
} from "../models/ModelRegistry";
import {
  CHORDVOX_CLOUD_MODEL,
  CHORDVOX_CLOUD_PROVIDER,
  isChordVoxCloudProvider,
  isChordVoxCloudValue,
} from "./chordvoxCloud";
import {
  getCloudProviderLabel,
  getLocalTranscriptionProviderLabel,
} from "../components/settings/utils";

export type DiagnosticModelKind = "transcription" | "reasoning";

function getRawModelDisplayValue(value: string | null | undefined): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "—";
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : trimmed;
}

function getProviderDisplayValue(
  provider: string | null | undefined,
  kind: DiagnosticModelKind
): string {
  const normalized = String(provider || "").trim();
  if (!normalized) return "";
  if (isChordVoxCloudProvider(normalized)) return "ChordVox Cloud";

  if (kind === "transcription") {
    if (["whisper", "nvidia", "paraformer", "granite", "cohere"].includes(normalized)) {
      return getLocalTranscriptionProviderLabel(normalized);
    }
    return getTranscriptionProvider(normalized)?.name || getCloudProviderLabel(normalized);
  }

  return REASONING_PROVIDERS[normalized]?.name || getCloudProviderLabel(normalized);
}

export function getFriendlyModelDisplayValue(
  provider: string | null | undefined,
  model: string | null | undefined,
  kind: DiagnosticModelKind
): string {
  const normalizedProvider = String(provider || "").trim();
  const normalizedModel = String(model || "").trim();
  if (!normalizedModel) return "—";
  if (isChordVoxCloudValue(normalizedModel)) return "ChordVox Cloud";

  if (kind === "reasoning") {
    const configuredModel = REASONING_PROVIDERS[normalizedProvider]?.models.find(
      (candidate) => candidate.value === normalizedModel
    );
    if (configuredModel?.label) return configuredModel.label;
  } else {
    const localModel =
      normalizedProvider === "nvidia"
        ? getParakeetModelInfo(normalizedModel)
        : normalizedProvider === "paraformer"
          ? getParaformerModelInfo(normalizedModel)
          : normalizedProvider === "granite"
            ? getGraniteModelInfo(normalizedModel)
            : normalizedProvider === "cohere"
              ? getCohereModelInfo(normalizedModel)
              : normalizedProvider === "whisper"
                ? getWhisperModelInfo(normalizedModel)
                : undefined;
    if (localModel?.name) return localModel.name;

    const cloudModel = getTranscriptionProvider(normalizedProvider)?.models.find(
      (candidate) => candidate.id === normalizedModel
    );
    if (cloudModel?.name) return cloudModel.name;
  }

  return getRawModelDisplayValue(normalizedModel);
}

export function getProviderModelDisplayValue(
  provider: string | null,
  model: string | null,
  kind: DiagnosticModelKind
): string {
  const normalizedProvider = String(provider || "").trim();
  const normalizedModel = String(model || "").trim();
  const providerLabel = getProviderDisplayValue(normalizedProvider, kind);
  const modelLabel = getFriendlyModelDisplayValue(normalizedProvider, normalizedModel, kind);
  if (!providerLabel && modelLabel === "—") return "—";
  if (!providerLabel) return modelLabel;
  if (modelLabel === "—" || modelLabel === providerLabel) return providerLabel;
  if (normalizedProvider === CHORDVOX_CLOUD_PROVIDER || normalizedModel === CHORDVOX_CLOUD_MODEL) {
    return "ChordVox Cloud";
  }
  return `${providerLabel} / ${modelLabel}`;
}

export function formatTraceTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function getTraceSessionListTitle(sessionLabel: string, updatedAt: string | null): string {
  return `${sessionLabel} · ${formatTraceTime(updatedAt)}`;
}
