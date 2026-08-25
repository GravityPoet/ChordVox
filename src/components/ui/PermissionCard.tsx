import { useTranslation } from "react-i18next";
import { Button } from "./button";
import { Check, LucideIcon, Settings } from "lucide-react";
import { cn } from "../lib/utils";

interface PermissionCardProps {
  icon: LucideIcon;
  title: string;
  description: string;
  granted: boolean;
  onRequest: () => void;
  buttonText?: string;
  onOpenSettings?: () => void;
}

export default function PermissionCard({
  icon: Icon,
  title,
  description,
  granted,
  onRequest,
  buttonText = "Grant Access",
  onOpenSettings,
}: PermissionCardProps) {
  const { t } = useTranslation();

  return (
    <div
      className={cn(
        "group relative rounded-md border px-4 py-3 transition-[background-color,border-color,box-shadow] duration-150 motion-reduce:transition-none",
        granted
          ? "glass-panel glass-panel--success"
          : "glass-panel glass-panel--soft glass-panel--hoverable hover:shadow-[var(--shadow-card-hover)]"
      )}
    >
      <div className="flex items-center gap-3">
        {/* Icon container */}
        <div
          className={cn(
            "w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors duration-150 motion-reduce:transition-none",
            granted ? "glass-chip glass-chip--success" : "glass-chip glass-chip--featured"
          )}
        >
          {granted ? (
            <Check className="w-4 h-4 text-success" strokeWidth={2.5} aria-hidden="true" />
          ) : (
            <Icon className="w-4 h-4 text-primary" aria-hidden="true" />
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <h3 className="text-xs font-medium text-foreground">{title}</h3>
          <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">{description}</p>
        </div>

        {granted ? (
          <div className="inline-flex min-h-7 shrink-0 items-center justify-center gap-1.5 rounded-full border border-success/20 bg-success/10 px-3 text-[11px] font-semibold text-success">
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            {t("common.complete")}
          </div>
        ) : (
          <div className="flex items-center gap-1.5 shrink-0">
            <Button onClick={onRequest} size="sm" variant="tinted" className="h-7 px-3 text-[11px]">
              {buttonText}
            </Button>
            {onOpenSettings && (
              <Button
                onClick={onOpenSettings}
                size="sm"
                variant="subtle"
                className="h-7 w-7 p-0"
                aria-label={t("common.openSystemSettings")}
              >
                <Settings className="w-3.5 h-3.5" aria-hidden="true" />
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
