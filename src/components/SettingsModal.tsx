import React, { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Sliders,
  Mic,
  Brain,
  History,
  Activity,
  BadgeCheck,
  User,
  Sparkles,
  Wrench,
  ShieldCheck,
  FolderOpen,
  Command,
  Eye,
} from "lucide-react";
import SidebarModal, { SidebarItem } from "./ui/SidebarModal";
import SettingsPage, { SettingsSectionType } from "./SettingsPage";

export type { SettingsSectionType };

interface SettingsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSection?: SettingsSectionType;
  onOpenTranscriptionHistory?: () => void;
}

export default function SettingsModal({
  open,
  onOpenChange,
  initialSection,
  onOpenTranscriptionHistory,
}: SettingsModalProps) {
  const { t } = useTranslation();
  const sidebarItems: SidebarItem<SettingsSectionType>[] = useMemo(
    () => [
      {
        id: "account",
        label: t("settingsModal.sections.account.label"),
        icon: BadgeCheck,
        description: t("settingsModal.sections.account.description"),
      },
      {
        id: "general",
        label: t("settingsModal.sections.general.label"),
        icon: Sliders,
        description: t("settingsModal.sections.general.description"),
        group: t("settingsModal.groups.app"),
      },
      {
        id: "hotkeys",
        label: t("settingsModal.sections.hotkeys.label"),
        icon: Command,
        description: t("settingsModal.sections.hotkeys.description"),
        group: t("settingsModal.groups.app"),
      },
      {
        id: "transcription",
        label: t("settingsModal.sections.transcription.label"),
        icon: Mic,
        description: t("settingsModal.sections.transcription.description"),
        group: t("settingsModal.groups.speech"),
      },
      {
        id: "fileTranscription",
        label: t("settingsModal.sections.fileTranscription.label"),
        icon: FolderOpen,
        description: t("settingsModal.sections.fileTranscription.description"),
        badge: t("settingsPage.account.badges.pro"),
        group: t("settingsModal.groups.speech"),
      },
      {
        id: "transcriptionHistory",
        label: t("settingsModal.sections.transcriptionHistory.label"),
        icon: History,
        description: t("settingsModal.sections.transcriptionHistory.description"),
        group: t("settingsModal.groups.speech"),
      },
      {
        id: "aiModels",
        label: t("settingsModal.sections.aiModels.label"),
        icon: Brain,
        description: t("settingsModal.sections.aiModels.description"),
        badge: t("settingsPage.account.badges.pro"),
        group: t("settingsModal.groups.intelligence"),
      },
      {
        id: "agentConfig",
        label: t("settingsModal.sections.agentConfig.label"),
        icon: User,
        description: t("settingsModal.sections.agentConfig.description"),
        group: t("settingsModal.groups.intelligence"),
      },
      {
        id: "prompts",
        label: t("settingsModal.sections.prompts.label"),
        icon: Sparkles,
        description: t("settingsModal.sections.prompts.description"),
        group: t("settingsModal.groups.intelligence"),
      },
      {
        id: "permissions",
        label: t("settingsModal.sections.permissions.label"),
        icon: ShieldCheck,
        description: t("settingsModal.sections.permissions.description"),
        group: t("settingsModal.groups.system"),
      },
      {
        id: "context",
        label: t("settingsModal.sections.context.label"),
        icon: Eye,
        description: t("settingsModal.sections.context.description"),
        group: t("settingsModal.groups.system"),
      },
      {
        id: "callRecords",
        label: t("settingsModal.sections.callRecords.label"),
        icon: Activity,
        description: t("settingsModal.sections.callRecords.description"),
        group: t("settingsModal.groups.system"),
      },
      {
        id: "developer",
        label: t("settingsModal.sections.developer.label"),
        icon: Wrench,
        description: t("settingsModal.sections.developer.description"),
        group: t("settingsModal.groups.system"),
      },
    ],
    [t]
  );

  const [activeSection, setActiveSection] = React.useState<SettingsSectionType>("account");
  const normalizedActiveSection: SettingsSectionType =
    activeSection === "transcriptionHistory"
      ? "transcription"
      : activeSection === "privacy"
        ? "permissions"
        : activeSection === "dictionary"
          ? "agentConfig"
          : activeSection;

  // Navigate to initial section when modal opens
  useEffect(() => {
    if (open && initialSection) {
      if (initialSection === "transcriptionHistory") {
        onOpenTranscriptionHistory?.();
        return;
      }
      setActiveSection(
        initialSection === "privacy"
          ? "permissions"
          : initialSection === "dictionary"
            ? "agentConfig"
            : initialSection
      );
    }
  }, [open, initialSection, onOpenTranscriptionHistory]);

  const handleSectionChange = React.useCallback(
    (section: SettingsSectionType) => {
      if (section === "transcriptionHistory") {
        onOpenTranscriptionHistory?.();
        return;
      }
      setActiveSection(section);
    },
    [onOpenTranscriptionHistory]
  );

  return (
    <SidebarModal<SettingsSectionType>
      open={open}
      onOpenChange={onOpenChange}
      title={t("settingsModal.title")}
      sidebarItems={sidebarItems}
      sidebarWidth="w-[15rem]"
      activeSection={normalizedActiveSection}
      onSectionChange={handleSectionChange}
    >
      <SettingsPage
        activeSection={normalizedActiveSection}
        onOpenTranscriptionHistory={onOpenTranscriptionHistory}
        onOpenTranscriptionSettings={() => setActiveSection("transcription")}
        onSectionChange={setActiveSection}
      />
    </SidebarModal>
  );
}
