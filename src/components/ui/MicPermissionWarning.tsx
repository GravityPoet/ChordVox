import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import { AlertCircle } from "lucide-react";
import { cn } from "../lib/utils";

interface MicPermissionWarningProps {
  error: string | null;
  onOpenSoundSettings: () => void;
  onOpenPrivacySettings: () => void;
}

type Platform = "darwin" | "win32" | "linux";

const getPlatform = (): Platform => {
  if (typeof window !== "undefined" && window.electronAPI?.getPlatform) {
    const p = window.electronAPI.getPlatform();
    if (p === "darwin" || p === "win32" || p === "linux") return p;
  }
  // Fallback to user agent
  if (typeof navigator !== "undefined") {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("mac")) return "darwin";
    if (ua.includes("linux")) return "linux";
  }
  return "win32";
};

export default function MicPermissionWarning({
  error,
  onOpenSoundSettings,
  onOpenPrivacySettings,
}: MicPermissionWarningProps) {
  const { t } = useTranslation();
  const config = useMemo(() => {
    const platformConfig: Record<
      Platform,
      { message: string; soundLabel: string; privacyLabel: string; showPrivacyButton: boolean }
    > = {
      darwin: {
        message: t("hooks.permissions.warning.messages.macos"),
        soundLabel: t("hooks.permissions.warning.soundLabel"),
        privacyLabel: t("hooks.permissions.warning.privacyLabel"),
        showPrivacyButton: true,
      },
      win32: {
        message: t("hooks.permissions.warning.messages.windows"),
        soundLabel: t("hooks.permissions.warning.soundLabel"),
        privacyLabel: t("hooks.permissions.warning.privacyLabel"),
        showPrivacyButton: true,
      },
      linux: {
        message: t("hooks.permissions.warning.messages.linux"),
        soundLabel: t("hooks.permissions.warning.soundLabel"),
        privacyLabel: "",
        showPrivacyButton: false,
      },
    };
    return platformConfig[getPlatform()];
  }, [t]);

  return (
    <div className={cn("rounded-md p-2.5 border", "bg-warning/12 border-warning/30")}>
      <div className="flex items-center gap-2.5">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-warning/20">
          <AlertCircle className="h-3.5 w-3.5 text-[color:var(--ui-warning-ink)]" />
        </div>
        <p className="flex-1 text-[11px] leading-snug text-[color:var(--ui-warning-ink)]">
          {error || config.message}
        </p>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="subtle"
            size="sm"
            onClick={onOpenSoundSettings}
            className="h-6 px-2 text-[10px] text-[color:var(--ui-warning-ink)] hover:bg-warning/20 hover:text-[color:var(--ui-warning-ink)]"
          >
            {config.soundLabel}
          </Button>
          {config.showPrivacyButton && (
            <Button
              variant="subtle"
              size="sm"
              onClick={onOpenPrivacySettings}
              className="h-6 px-2 text-[10px] text-[color:var(--ui-warning-ink)] hover:bg-warning/20 hover:text-[color:var(--ui-warning-ink)]"
            >
              {config.privacyLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
