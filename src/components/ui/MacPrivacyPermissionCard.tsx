import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Settings, type LucideIcon } from "lucide-react";
import { Button } from "./button";
import { cn } from "../lib/utils";
import appIcon from "../../assets/icon.png";
import type { MacAppBundleDragInfo } from "../../types/electron";

interface MacPrivacyPermissionCardProps {
  icon: LucideIcon;
  title: string;
  description: string;
  granted: boolean;
  openSettingsLabel: string;
  dragLabel: string;
  dragDescription: string;
  packagedOnlyDescription: string;
  onOpenSettings: () => void | Promise<void>;
  className?: string;
}

export default function MacPrivacyPermissionCard({
  icon: Icon,
  title,
  description,
  granted,
  openSettingsLabel,
  dragLabel,
  dragDescription,
  packagedOnlyDescription,
  onOpenSettings,
  className,
}: MacPrivacyPermissionCardProps) {
  const { t } = useTranslation();
  const [dragInfo, setDragInfo] = useState<MacAppBundleDragInfo | null>(null);

  useEffect(() => {
    if (granted) return;

    let cancelled = false;
    const dragInfoPromise = window.electronAPI?.getMacAppBundleDragInfo?.();
    if (!dragInfoPromise) return;

    dragInfoPromise
      .then((info) => {
        if (!cancelled) {
          setDragInfo(info);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDragInfo(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [granted]);

  useEffect(() => {
    if (granted) {
      window.electronAPI?.hideMacPrivacyDragHelper?.();
    }
  }, [granted]);

  const canDrag = dragInfo?.available === true;

  const handleOpenSettings = useCallback(() => {
    void Promise.resolve(onOpenSettings()).catch((error) => {
      console.error("Failed to open macOS privacy settings:", error);
    });
  }, [onOpenSettings]);

  return (
    <div className={cn("relative", className)}>
      <div
        className={cn(
          "group rounded-md border px-3 py-3 transition-[background-color,border-color,box-shadow] duration-150 motion-reduce:transition-none sm:px-4",
          granted
            ? "glass-panel glass-panel--success"
            : "glass-panel glass-panel--soft glass-panel--hoverable hover:shadow-[var(--shadow-card-hover)]"
        )}
      >
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors duration-150 motion-reduce:transition-none",
                granted ? "glass-chip glass-chip--success" : "glass-chip glass-chip--featured"
              )}
            >
              {granted ? (
                <Check className="h-4 w-4 text-success" strokeWidth={2.5} aria-hidden="true" />
              ) : (
                <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
              )}
            </div>

            <div className="min-w-0 flex-1">
              <h3 className="text-xs font-medium text-foreground">{title}</h3>
              <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{description}</p>
            </div>
          </div>

          {granted ? (
            <div className="inline-flex min-h-7 shrink-0 items-center justify-center gap-1.5 rounded-full border border-success/20 bg-success/10 px-3 text-[11px] font-semibold text-success">
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              {t("common.complete")}
            </div>
          ) : null}
        </div>

        {!granted && (
          <div className="mt-3 rounded-md border border-dashed border-primary/25 bg-primary/5 px-3 py-2.5">
            <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <img
                  src={appIcon}
                  alt=""
                  className="mt-0.5 h-9 w-9 shrink-0 rounded-md object-contain shadow-sm"
                  draggable={false}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2 text-[11px] font-medium text-foreground">
                    <Settings className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                    <span className="leading-snug">{dragLabel}</span>
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                    {canDrag ? dragDescription : packagedOnlyDescription}
                  </p>
                </div>
              </div>

              <Button
                onClick={handleOpenSettings}
                size="sm"
                variant="tinted"
                className="min-h-8 w-full shrink-0 px-3 py-1 text-[11px] sm:w-auto"
              >
                <Settings className="h-3.5 w-3.5" aria-hidden="true" />
                {openSettingsLabel}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
