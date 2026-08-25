import { useTranslation } from "react-i18next";
import { Mic, Shield } from "lucide-react";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Toggle } from "../ui/toggle";
import { SettingsRow } from "../ui/SettingsSection";
import PermissionCard from "../ui/PermissionCard";
import MacPrivacyPermissionCard from "../ui/MacPrivacyPermissionCard";
import MicrophoneInputTest from "../ui/MicrophoneInputTest";
import MicPermissionWarning from "../ui/MicPermissionWarning";
import PasteToolsInfo from "../ui/PasteToolsInfo";
import { SectionHeader, SettingsPanel, SettingsPanelRow } from "./shared";
import type { PasteToolsResult } from "../../types/electron";

type PermissionsState = {
  micPermissionGranted: boolean;
  accessibilityPermissionGranted: boolean;
  requestMicPermission: () => void;
  openMicPrivacySettings: () => void;
  testAccessibilityPermission: () => void;
  openAccessibilitySettings: () => void;
  setMicPermissionGranted: (granted: boolean) => void;
  micPermissionError: string | null;
  openSoundInputSettings: () => void;
  pasteToolsInfo: PasteToolsResult | null;
  isCheckingPasteTools: boolean;
  checkPasteToolsAvailability: () => void;
};

export interface PrivacyPermissionsSectionProps {
  permissions: PermissionsState;
  platform: string;
  telemetryEnabled: boolean;
  setTelemetryEnabled: (enabled: boolean) => void;
  transcriptionHistoryEnabled: boolean;
  setTranscriptionHistoryEnabled: (enabled: boolean) => void;
  preferBuiltInMic: boolean;
  selectedMicDeviceId: string;
  resetAccessibilityPermissions: () => void;
}

export function PrivacyPermissionsSection({
  permissions,
  platform,
  telemetryEnabled,
  setTelemetryEnabled,
  transcriptionHistoryEnabled,
  setTranscriptionHistoryEnabled,
  preferBuiltInMic,
  selectedMicDeviceId,
  resetAccessibilityPermissions,
}: PrivacyPermissionsSectionProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-5">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.9fr)] xl:items-start">
        <div className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <SectionHeader
              title={t("settingsPage.permissions.systemTitle")}
              description={t("settingsPage.permissions.systemDescription")}
            />
            <div className="flex flex-wrap gap-2 sm:pt-0.5">
              <Badge
                variant={permissions.micPermissionGranted ? "success" : "warning"}
                className="text-[11px]"
              >
                {t("settingsPage.permissions.microphoneTitle")}
              </Badge>
              {platform === "darwin" && (
                <Badge
                  variant={permissions.accessibilityPermissionGranted ? "success" : "warning"}
                  className="text-[11px]"
                >
                  {t("settingsPage.permissions.accessibilityTitle")}
                </Badge>
              )}
            </div>
          </div>

          <SettingsPanel className="overflow-hidden">
            <SettingsPanelRow>
              <div className="grid gap-3 md:grid-cols-2">
                <PermissionCard
                  icon={Mic}
                  title={t("settingsPage.permissions.microphoneTitle")}
                  description={t("settingsPage.permissions.microphoneDescription")}
                  granted={permissions.micPermissionGranted}
                  onRequest={permissions.requestMicPermission}
                  buttonText={t("settingsPage.permissions.test")}
                  onOpenSettings={permissions.openMicPrivacySettings}
                />

                {platform === "darwin" && (
                  <MacPrivacyPermissionCard
                    icon={Shield}
                    title={t("settingsPage.permissions.accessibilityTitle")}
                    description={t("settingsPage.permissions.accessibilityDescription")}
                    granted={permissions.accessibilityPermissionGranted}
                    openSettingsLabel={t(
                      "settingsPage.permissions.macAccessibilityDrag.openSettings"
                    )}
                    dragLabel={t("settingsPage.permissions.macAccessibilityDrag.dragLabel")}
                    dragDescription={t("settingsPage.permissions.macAccessibilityDrag.description")}
                    packagedOnlyDescription={t(
                      "settingsPage.permissions.macAccessibilityDrag.packagedOnly"
                    )}
                    onOpenSettings={permissions.openAccessibilitySettings}
                  />
                )}
              </div>
            </SettingsPanelRow>
            {!permissions.micPermissionGranted && permissions.micPermissionError && (
              <SettingsPanelRow className="pt-0">
                <MicPermissionWarning
                  error={permissions.micPermissionError}
                  onOpenSoundSettings={permissions.openSoundInputSettings}
                  onOpenPrivacySettings={permissions.openMicPrivacySettings}
                />
              </SettingsPanelRow>
            )}
            {platform === "linux" &&
              permissions.pasteToolsInfo &&
              !permissions.pasteToolsInfo.available && (
                <SettingsPanelRow className="pt-0">
                  <PasteToolsInfo
                    pasteToolsInfo={permissions.pasteToolsInfo}
                    isChecking={permissions.isCheckingPasteTools}
                    onCheck={permissions.checkPasteToolsAvailability}
                  />
                </SettingsPanelRow>
              )}
            <SettingsPanelRow className="pt-0">
              <MicrophoneInputTest
                preferBuiltInMic={preferBuiltInMic}
                selectedMicDeviceId={selectedMicDeviceId}
                onPermissionGranted={() => permissions.setMicPermissionGranted(true)}
                onOpenPrivacySettings={permissions.openMicPrivacySettings}
                onOpenSoundSettings={permissions.openSoundInputSettings}
              />
            </SettingsPanelRow>
          </SettingsPanel>

          {platform === "darwin" && (
            <SettingsPanel>
              <SettingsPanelRow>
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-medium text-foreground">
                      {t("settingsPage.permissions.troubleshootingTitle")}
                    </p>
                    <p className="text-[13px] text-muted-foreground/80 mt-0.5 leading-relaxed">
                      {t("settingsPage.permissions.resetAccessibility.rowDescription")}
                    </p>
                  </div>
                  <Button
                    onClick={resetAccessibilityPermissions}
                    variant="outline"
                    size="sm"
                    className="h-8 px-3 text-[13px] shrink-0"
                  >
                    {t("settingsPage.permissions.troubleshoot")}
                  </Button>
                </div>
              </SettingsPanelRow>
            </SettingsPanel>
          )}
        </div>

        <div className="space-y-4">
          <SectionHeader
            title={t("settingsPage.privacy.title")}
            description={t("settingsPage.privacy.description")}
          />
          <SettingsPanel>
            <SettingsPanelRow>
              <SettingsRow
                label={t("settingsPage.privacy.transcriptionHistory")}
                description={t("settingsPage.privacy.transcriptionHistoryDescription")}
              >
                <Toggle
                  checked={transcriptionHistoryEnabled}
                  onChange={setTranscriptionHistoryEnabled}
                  ariaLabel={t("settingsPage.privacy.transcriptionHistory")}
                />
              </SettingsRow>
            </SettingsPanelRow>
            <SettingsPanelRow>
              <SettingsRow
                label={t("settingsPage.privacy.usageAnalytics")}
                description={t("settingsPage.privacy.usageAnalyticsDescription")}
              >
                <Toggle
                  checked={telemetryEnabled}
                  onChange={setTelemetryEnabled}
                  ariaLabel={t("settingsPage.privacy.usageAnalytics")}
                />
              </SettingsRow>
            </SettingsPanelRow>
          </SettingsPanel>
        </div>
      </div>
    </div>
  );
}
