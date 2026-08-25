import React from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Cloud, Lock } from "lucide-react";

type ProcessingMode = "cloud" | "local";

interface ProcessingModeSelectorProps {
  value: ProcessingMode;
  onChange: (value: ProcessingMode) => void;
  className?: string;
}

export default function ProcessingModeSelector({
  value,
  onChange,
  className = "",
}: ProcessingModeSelectorProps) {
  const { t } = useTranslation();

  const options: Array<{
    id: ProcessingMode;
    label: string;
    description: string;
    Icon: typeof Cloud;
  }> = [
    {
      id: "cloud",
      label: t("reasoning.mode.cloud"),
      description: t("reasoning.mode.cloudDescription"),
      Icon: Cloud,
    },
    {
      id: "local",
      label: t("reasoning.mode.local"),
      description: t("reasoning.mode.localDescription"),
      Icon: Lock,
    },
  ];

  return (
    <div className={`mx-auto grid w-full max-w-2xl gap-3 sm:grid-cols-2 ${className}`}>
      {options.map(({ id, label, description, Icon }) => {
        const isSelected = value === id;

        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            aria-pressed={isSelected}
            className={`mode-depth-card glass-panel glass-panel--soft relative flex min-h-[5.25rem] items-start gap-3 rounded-[1rem] border px-4 py-3 text-left transition-all duration-200 ${
              isSelected
                ? "mode-depth-card--active border-primary bg-primary/15 text-foreground shadow-[0_14px_36px_rgba(96,165,250,0.32)] ring-2 ring-primary/35"
                : "border-border/70 text-muted-foreground hover:border-primary/35 hover:bg-primary/[0.06] hover:text-foreground"
            }`}
          >
            {isSelected && (
              <CheckCircle2
                className="absolute right-2.5 top-2.5 h-4 w-4 text-primary"
                aria-hidden="true"
              />
            )}
            <span
              className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors duration-200 ${
                isSelected
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              <Icon className="h-4 w-4" />
            </span>
            <span className="min-w-0 pr-5">
              <span
                className={`block text-sm text-foreground ${
                  isSelected ? "font-bold" : "font-semibold"
                }`}
              >
                {label}
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                {description}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
