import React from "react";

type Tone = "default" | "tinted" | "warning";
type Density = "comfortable" | "compact";

const settingsGroupDeprecations = new Set<string>();

function warnSettingsGroupVariantDeprecation() {
  const key = "SettingsGroup.variant";
  if (settingsGroupDeprecations.has(key)) return;
  settingsGroupDeprecations.add(key);
  console.warn(
    '[SettingsGroup] `variant="highlighted"` is deprecated. Use `tone="tinted"` instead.'
  );
}

interface SettingsSectionProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}

export const SettingsSection: React.FC<SettingsSectionProps> = ({
  title,
  description,
  children,
  className = "",
}) => {
  return (
    <div className={`space-y-3 ${className}`}>
      <div>
        <h3 className="text-[13px] font-semibold text-foreground tracking-tight">{title}</h3>
        {description && (
          <p className="text-[11px] text-muted-foreground/80 mt-0.5 leading-relaxed">
            {description}
          </p>
        )}
      </div>
      {children}
    </div>
  );
};

interface SettingsGroupProps {
  title?: string;
  children: React.ReactNode;
  tone?: Tone;
  density?: Density;
  /** @deprecated use tone="tinted" */
  variant?: "default" | "highlighted";
  className?: string;
}

export const SettingsGroup: React.FC<SettingsGroupProps> = ({
  title,
  children,
  tone,
  density = "comfortable",
  variant = "default",
  className = "",
}) => {
  const resolvedTone: Tone =
    tone ??
    (variant === "highlighted" ? (warnSettingsGroupVariantDeprecation(), "tinted") : "default");

  const baseClasses = "rounded-[var(--radius-lg)] border transition-colors";
  const toneClasses: Record<Tone, string> = {
    default: "bg-card border-border",
    tinted: "glass-panel glass-panel--accent",
    warning: "bg-warning/12 border-warning/30",
  };
  const densityClasses: Record<Density, string> = {
    comfortable: "p-5 space-y-4",
    compact: "p-3 space-y-2",
  };

  return (
    <div
      className={`${baseClasses} ${toneClasses[resolvedTone]} ${densityClasses[density]} ${className}`}
    >
      {title && <h4 className="text-[12px] font-medium text-foreground">{title}</h4>}
      {children}
    </div>
  );
};

interface SettingsRowProps {
  label: React.ReactNode;
  description?: string;
  children: React.ReactNode;
  className?: string;
}

export const SettingsRow: React.FC<SettingsRowProps> = ({
  label,
  description,
  children,
  className = "",
}) => {
  return (
    <div className={`flex items-center justify-between gap-4 ${className}`}>
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium text-foreground">{label}</div>
        {description && (
          <p className="text-[13px] text-muted-foreground/80 mt-0.5 leading-relaxed">
            {description}
          </p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
};
