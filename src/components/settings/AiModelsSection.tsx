import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import ReasoningModelSelector from "../ReasoningModelSelector";
import { Toggle } from "../ui/toggle";
import { SettingsRow } from "../ui/SettingsSection";
import { SettingsPanel } from "./shared";
import type { CustomReasoningProtocol } from "../../utils/customReasoningProtocol";
import {
  disableReasoningModelForPreviewLimit,
  getReasoningPreviewQuota,
} from "../../utils/reasoningPreviewQuota";
import type { ProAccessResult } from "./types";

export interface AiModelsSectionProps {
  useReasoningModel: boolean;
  setUseReasoningModel: (value: boolean) => void;
  hasProAccess: boolean;
  canOfferTrial: boolean;
  requestProAccess: (source: string) => Promise<ProAccessResult>;
  onUpgradeToPro: () => void;
  reasoningModel: string;
  setReasoningModel: (model: string) => void;
  reasoningProvider: string;
  setReasoningProvider: (provider: string) => void;
  cloudReasoningBaseUrl: string;
  setCloudReasoningBaseUrl: (url: string) => void;
  customReasoningProtocol: CustomReasoningProtocol;
  setCustomReasoningProtocol: (protocol: CustomReasoningProtocol) => void;
  openaiApiKey: string;
  setOpenaiApiKey: (key: string) => void;
  anthropicApiKey: string;
  setAnthropicApiKey: (key: string) => void;
  geminiApiKey: string;
  setGeminiApiKey: (key: string) => void;
  groqApiKey: string;
  setGroqApiKey: (key: string) => void;
  cerebrasApiKey: string;
  setCerebrasApiKey: (key: string) => void;
  openrouterApiKey: string;
  setOpenrouterApiKey: (key: string) => void;
  customReasoningApiKey: string;
  setCustomReasoningApiKey: (key: string) => void;
  showConfirmDialog: (dialog: {
    title: string;
    description: string;
    confirmText?: string;
    cancelText?: string;
    onConfirm: () => void;
  }) => void;
  showAlertDialog: (dialog: { title: string; description: string }) => void;
}

export function AiModelsSection({
  useReasoningModel,
  setUseReasoningModel,
  hasProAccess,
  canOfferTrial,
  requestProAccess,
  onUpgradeToPro,
  reasoningModel,
  setReasoningModel,
  reasoningProvider,
  setReasoningProvider,
  cloudReasoningBaseUrl,
  setCloudReasoningBaseUrl,
  customReasoningProtocol,
  setCustomReasoningProtocol,
  openaiApiKey,
  setOpenaiApiKey,
  anthropicApiKey,
  setAnthropicApiKey,
  geminiApiKey,
  setGeminiApiKey,
  groqApiKey,
  setGroqApiKey,
  cerebrasApiKey,
  setCerebrasApiKey,
  openrouterApiKey,
  setOpenrouterApiKey,
  customReasoningApiKey,
  setCustomReasoningApiKey,
  showConfirmDialog,
  showAlertDialog,
}: AiModelsSectionProps) {
  const { t } = useTranslation();

  useEffect(() => {
    if (hasProAccess || !useReasoningModel) return;
    if (getReasoningPreviewQuota().remaining > 0) return;

    disableReasoningModelForPreviewLimit();
    setUseReasoningModel(false);
  }, [hasProAccess, setUseReasoningModel, useReasoningModel]);

  const showReasoningUpgradeDialog = useCallback(
    (result: ProAccessResult) => {
      const status = result.status;
      const isPreviewLimitReached = status?.error === "PRO_REASONING_PREVIEW_LIMIT_REACHED";
      const isTrialExpired = status?.error === "TRIAL_EXPIRED" || status?.status === "expired";
      const isLicenseUnavailable = status?.error === "LICENSE_TRIAL_SERVER_UNAVAILABLE";

      const titleKey = isPreviewLimitReached
        ? "settingsPage.aiModels.proRequiredDialog.title"
        : isTrialExpired
          ? "settingsPage.aiModels.proRequiredDialog.trialExpiredTitle"
          : isLicenseUnavailable
            ? "settingsPage.aiModels.proRequiredDialog.unavailableTitle"
            : "settingsPage.aiModels.proRequiredDialog.title";
      const descriptionKey = isPreviewLimitReached
        ? "settingsPage.aiModels.proRequiredDialog.description"
        : isTrialExpired
          ? "settingsPage.aiModels.proRequiredDialog.trialExpiredDescription"
          : isLicenseUnavailable
            ? "settingsPage.aiModels.proRequiredDialog.unavailableDescription"
            : "settingsPage.aiModels.proRequiredDialog.description";

      showConfirmDialog({
        title: t(titleKey),
        description: t(descriptionKey),
        confirmText: t("settingsPage.aiModels.proRequiredDialog.confirm"),
        cancelText: t("common.cancel"),
        onConfirm: onUpgradeToPro,
      });
    },
    [onUpgradeToPro, showConfirmDialog, t]
  );

  const handleUseReasoningModelChange = useCallback(
    async (value: boolean) => {
      if (!value) {
        setUseReasoningModel(false);
        return;
      }

      const result = await requestProAccess("ai-models-toggle");
      if (result.allowed) {
        setUseReasoningModel(true);
        return;
      }

      setUseReasoningModel(false);
      if (!result.declinedTrial) {
        showReasoningUpgradeDialog(result);
      }
    },
    [requestProAccess, setUseReasoningModel, showReasoningUpgradeDialog]
  );

  const offHintKey = canOfferTrial
    ? "settingsPage.aiModels.disabledHintWithTrial"
    : "settingsPage.aiModels.disabledHint";

  return (
    <div className="space-y-4">
      {/* Enable toggle — always at top */}
      <SettingsPanel className="premium-panel--hero flow-border--subtle shimmer-on-mount aurora-full">
        {/* 关键的 Pro 权益闸: 用更大方的内边距(24/22)+ 15px 标题撑出分量感, 不走
            SettingsPanelRow 默认 px-4 py-3 的紧凑密度. border-beam 已 absolute 脱流,
            上下 padding 对称(顶/底各 22). 标题行 + 关闭态提示用 space-y 紧贴成一组. */}
        <div className="px-6 py-[22px]">
          <div className="space-y-2.5">
            <SettingsRow
              label={
                <span className="flex items-center gap-2">
                  <span className="text-[15px]">
                    {t("settingsPage.aiModels.enableTextCleanup")}
                  </span>
                  <span
                    className={`rounded-sm px-1.5 py-px text-[11px] font-medium ${
                      useReasoningModel
                        ? "glass-chip glass-chip--accent text-primary"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {useReasoningModel
                      ? t("settingsPage.aiModels.statusOn")
                      : t("settingsPage.aiModels.statusOff")}
                  </span>
                </span>
              }
              description={t("settingsPage.aiModels.enableTextCleanupDescription")}
            >
              <Toggle
                checked={useReasoningModel}
                onChange={handleUseReasoningModelChange}
                ariaLabel={t("settingsPage.aiModels.enableTextCleanup")}
              />
            </SettingsRow>
            {!useReasoningModel && (
              <p className="text-[13px] text-muted-foreground/80 leading-relaxed">
                {t(offHintKey)}
              </p>
            )}
          </div>
        </div>
        <span className="border-beam" aria-hidden />
      </SettingsPanel>

      <ReasoningModelSelector
        useReasoningModel={useReasoningModel}
        setUseReasoningModel={setUseReasoningModel}
        reasoningModel={reasoningModel}
        setReasoningModel={setReasoningModel}
        reasoningProvider={reasoningProvider}
        setReasoningProvider={setReasoningProvider}
        cloudReasoningBaseUrl={cloudReasoningBaseUrl}
        setCloudReasoningBaseUrl={setCloudReasoningBaseUrl}
        customReasoningProtocol={customReasoningProtocol}
        setCustomReasoningProtocol={setCustomReasoningProtocol}
        openaiApiKey={openaiApiKey}
        setOpenaiApiKey={setOpenaiApiKey}
        openrouterApiKey={openrouterApiKey}
        setOpenrouterApiKey={setOpenrouterApiKey}
        anthropicApiKey={anthropicApiKey}
        setAnthropicApiKey={setAnthropicApiKey}
        geminiApiKey={geminiApiKey}
        setGeminiApiKey={setGeminiApiKey}
        groqApiKey={groqApiKey}
        setGroqApiKey={setGroqApiKey}
        cerebrasApiKey={cerebrasApiKey}
        setCerebrasApiKey={setCerebrasApiKey}
        customReasoningApiKey={customReasoningApiKey}
        setCustomReasoningApiKey={setCustomReasoningApiKey}
        showAlertDialog={showAlertDialog}
      />
    </div>
  );
}
