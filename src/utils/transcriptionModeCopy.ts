import i18next from "i18next";

export interface TranscriptionModeCopy {
  realTime: {
    label: string;
    cardDescription: string;
    switchedTitle: string;
    switchedDescription: string;
    modelsLabel: string;
    clearModelsTitle: string;
    clearModelsDescription: string;
    clearedModelsTitle: string;
    clearedModelsDescription: string;
    downloadHint: string;
    defaultEnabledTitle: string;
    defaultEnabledDescription: string;
  };
  highAccuracy: {
    label: string;
    optionalLabel: string;
    cardDescription: string;
    switchedTitle: string;
    switchedDescription: string;
    onboardingDescription: string;
  };
}

export function getTranscriptionModeCopy(
  language?: string,
  defaultStreamingModelName?: string
): TranscriptionModeCopy {
  const fallbackModelName = defaultStreamingModelName || "Recommended";
  const t = i18next.getFixedT(language);
  return {
    realTime: {
      label: t("transcriptionModes.realTime.label"),
      cardDescription: t("transcriptionModes.realTime.cardDescription"),
      switchedTitle: t("transcriptionModes.realTime.switchedTitle"),
      switchedDescription: t("transcriptionModes.realTime.switchedDescription"),
      modelsLabel: t("transcriptionModes.realTime.modelsLabel"),
      clearModelsTitle: t("transcriptionModes.realTime.clearModelsTitle"),
      clearModelsDescription: t("transcriptionModes.realTime.clearModelsDescription"),
      clearedModelsTitle: t("transcriptionModes.realTime.clearedModelsTitle"),
      clearedModelsDescription: t("transcriptionModes.realTime.clearedModelsDescription"),
      downloadHint: t("transcriptionModes.realTime.downloadHint"),
      defaultEnabledTitle: t("transcriptionModes.realTime.defaultEnabledTitle"),
      defaultEnabledDescription: t("transcriptionModes.realTime.defaultEnabledDescription", {
        defaultModelName: fallbackModelName,
      }),
    },
    highAccuracy: {
      label: t("transcriptionModes.highAccuracy.label"),
      optionalLabel: t("transcriptionModes.highAccuracy.optionalLabel"),
      cardDescription: t("transcriptionModes.highAccuracy.cardDescription"),
      switchedTitle: t("transcriptionModes.highAccuracy.switchedTitle"),
      switchedDescription: t("transcriptionModes.highAccuracy.switchedDescription"),
      onboardingDescription: t("transcriptionModes.highAccuracy.onboardingDescription"),
    },
  };
}
