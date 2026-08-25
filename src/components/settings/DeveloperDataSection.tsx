import { useTranslation } from "react-i18next";
import { Download, Upload, FolderOpen } from "lucide-react";
import { Button } from "../ui/button";
import { SettingsRow } from "../ui/SettingsSection";
import DeveloperSection from "../DeveloperSection";
import { SectionHeader, SettingsPanel, SettingsPanelRow } from "./shared";

export interface DeveloperDataSectionProps {
  cachePathHint: string;
  isRemovingModels: boolean;
  onOpenModelCache: () => void;
  onClearModelCache: () => void;
  onExportSettings: () => void;
  onImportSettings: () => void;
  onResetAppData: () => void;
}

export function DeveloperDataSection({
  cachePathHint,
  isRemovingModels,
  onOpenModelCache,
  onClearModelCache,
  onExportSettings,
  onImportSettings,
  onResetAppData,
}: DeveloperDataSectionProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <DeveloperSection />

      <div className="border-t border-border/40 pt-8">
        <SectionHeader
          title={t("settingsPage.developer.dataManagementTitle")}
          description={t("settingsPage.developer.dataManagementDescription")}
        />

        <div className="space-y-4">
          <SettingsPanel>
            <SettingsPanelRow>
              <SettingsRow
                label={t("settingsPage.developer.modelCache")}
                description={cachePathHint}
              >
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={onOpenModelCache}>
                    <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                    {t("settingsPage.developer.open")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onClearModelCache}
                    disabled={isRemovingModels}
                    className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive"
                  >
                    {isRemovingModels
                      ? t("settingsPage.developer.removing")
                      : t("settingsPage.developer.clearCache")}
                  </Button>
                </div>
              </SettingsRow>
            </SettingsPanelRow>
          </SettingsPanel>

          <SettingsPanel>
            <SettingsPanelRow>
              <SettingsRow
                label={t("settingsPage.developer.settingsTransfer.title")}
                description={t("settingsPage.developer.settingsTransfer.description")}
              >
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={onExportSettings}>
                    <Download className="mr-1.5 h-3.5 w-3.5" />
                    {t("settingsPage.developer.settingsTransfer.export")}
                  </Button>
                  <Button variant="outline" size="sm" onClick={onImportSettings}>
                    <Upload className="mr-1.5 h-3.5 w-3.5" />
                    {t("settingsPage.developer.settingsTransfer.import")}
                  </Button>
                </div>
              </SettingsRow>
            </SettingsPanelRow>
          </SettingsPanel>

          <SettingsPanel>
            <SettingsPanelRow>
              <SettingsRow
                label={t("settingsPage.developer.resetAppData")}
                description={t("settingsPage.developer.resetAppDataDescription")}
              >
                <Button
                  onClick={onResetAppData}
                  variant="outline"
                  size="sm"
                  className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive"
                >
                  {t("common.reset")}
                </Button>
              </SettingsRow>
            </SettingsPanelRow>
          </SettingsPanel>
        </div>
      </div>
    </div>
  );
}
