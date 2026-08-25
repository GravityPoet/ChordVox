import { Check, MicVocal, MousePointerClick } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";

type ActivationMode = "tap" | "push";

interface ActivationModeSelectorProps {
  value: ActivationMode;
  onChange: (mode: ActivationMode) => void;
  disabled?: boolean;
  /** Compact variant for inline use */
  variant?: "default" | "compact" | "cards";
}

export function ActivationModeSelector({
  value,
  onChange,
  disabled = false,
  variant = "default",
}: ActivationModeSelectorProps) {
  const { t } = useTranslation();
  const isCompact = variant === "compact";
  const isCards = variant === "cards";

  if (isCards) {
    const options = [
      {
        id: "tap" as const,
        icon: MousePointerClick,
        label: t("common.tap"),
        description: t("onboarding.activation.tapDescription"),
      },
      {
        id: "push" as const,
        icon: MicVocal,
        label: t("common.hold"),
        description: t("onboarding.activation.holdDescription"),
      },
    ];

    return (
      <div className="grid gap-3 md:grid-cols-2">
        {options.map((option) => {
          const Icon = option.icon;
          const isActive = value === option.id;

          return (
            <button
              key={option.id}
              type="button"
              disabled={disabled}
              onClick={() => onChange(option.id)}
              aria-pressed={isActive}
              className={cn(
                "premium-option-card flex w-full items-start gap-4 px-4 py-4 text-left",
                !disabled && "hover-lift card-shine-hover",
                isActive && "premium-option-card--active",
                disabled && "cursor-not-allowed opacity-50"
              )}
            >
              <div
                className={cn(
                  "flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl",
                  isActive
                    ? "glass-chip glass-chip--accent text-primary"
                    : "glass-chip glass-chip--muted text-muted-foreground"
                )}
              >
                <Icon className="h-5 w-5" />
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[18px] font-semibold tracking-[-0.02em] text-foreground">
                    {option.label}
                  </span>
                  {isActive ? (
                    <span className="glass-chip glass-chip--accent inline-flex h-6 w-6 items-center justify-center rounded-full text-primary">
                      <Check className="h-3.5 w-3.5" />
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground/80">
                  {option.description}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div
      className={`
        relative flex rounded-md border transition-all duration-200
        bg-surface-1 border-border
        ${isCompact ? "min-h-12 p-0.5" : "p-0.5"}
        ${disabled ? "opacity-50 cursor-not-allowed" : ""}
      `}
    >
      {/* Sliding indicator */}
      <div
        className={`
          absolute top-0.5 bottom-0.5 w-[calc(50%-2px)] rounded
          bg-surface-raised border border-border
          transition-transform duration-200 ease-out
          ${value === "push" ? "translate-x-[calc(100%+4px)]" : "translate-x-0"}
        `}
      />

      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange("tap")}
        aria-pressed={value === "tap"}
        className={`
          relative z-10 flex-1 flex items-center justify-center gap-1.5 rounded
          transition-colors duration-150
          ${isCompact ? "px-4 py-3" : "px-3 py-2"}
          ${disabled ? "cursor-not-allowed" : "cursor-pointer"}
          ${value === "tap" ? "text-foreground" : "text-muted-foreground hover:text-foreground"}
        `}
      >
        <MousePointerClick className="w-4 h-4" />
        <span className="text-sm font-medium">{t("common.tap")}</span>
      </button>

      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange("push")}
        aria-pressed={value === "push"}
        className={`
          relative z-10 flex-1 flex items-center justify-center gap-1.5 rounded
          transition-colors duration-150
          ${isCompact ? "px-4 py-3" : "px-3 py-2"}
          ${disabled ? "cursor-not-allowed" : "cursor-pointer"}
          ${value === "push" ? "text-foreground" : "text-muted-foreground hover:text-foreground"}
        `}
      >
        <MicVocal className="w-4 h-4" />
        <span className="text-sm font-medium">{t("common.hold")}</span>
      </button>
    </div>
  );
}
