/**
 * Settings shared UI primitives — extracted from SettingsPage monolith.
 * Reusable layout components for all settings sections.
 */

import React from "react";
import { cn } from "../lib/utils";

/* ---- SettingsPanel: grouped settings container ---- */

export function SettingsPanel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`premium-panel premium-panel--subtle section-entrance rounded-[var(--radius-xl)] divide-y divide-[color:var(--ui-glass-divider)] ${className}`}
    >
      {children}
    </div>
  );
}

/* ---- SettingsPanelRow: single row inside a SettingsPanel ---- */

export function SettingsPanelRow({
  children,
  className = "",
  density = "compact",
}: {
  children: React.ReactNode;
  className?: string;
  density?: "compact" | "comfortable";
}) {
  const paddingClass = density === "comfortable" ? "px-4 py-4 sm:px-5 sm:py-4" : "px-4 py-3";
  return <div className={`${paddingClass} ${className}`}>{children}</div>;
}

/* ---- SectionHeader: title + optional description above a section ---- */

export function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-3">
      <h3 className="text-[14px] font-semibold text-foreground tracking-tight">{title}</h3>
      {description && (
        <p className="text-[13px] text-muted-foreground/80 mt-0.5 leading-relaxed">{description}</p>
      )}
    </div>
  );
}

/* ---- SectionCard: section with title, description, and content ---- */

export function SectionCard({
  title,
  description,
  children,
  variant = "default",
  className = "",
}: {
  title?: string;
  description?: string;
  children: React.ReactNode;
  variant?: "default" | "hero";
  className?: string;
}) {
  const variantClass =
    variant === "hero"
      ? "premium-panel premium-panel--hero flow-border--subtle shimmer-on-mount"
      : "premium-panel premium-panel--subtle";
  return (
    <section
      className={cn(
        variantClass,
        "section-entrance rounded-[var(--radius-xl)] px-4 py-4 sm:px-5 sm:py-5",
        className
      )}
    >
      {variant === "hero" && <span className="border-beam" aria-hidden />}
      {title || description ? (
        <div className="mb-4">
          {title ? (
            <h3 className="text-[16px] font-semibold text-foreground tracking-tight">{title}</h3>
          ) : null}
          {description && (
            <p className="mt-1 text-[14px] leading-relaxed text-muted-foreground/80">
              {description}
            </p>
          )}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/* ---- MetricCard: stat display with icon, eyebrow, value, and label ---- */

export function MetricCard({
  icon: Icon,
  eyebrow,
  value,
  label,
  tone = "default",
  onClick,
  ariaLabel,
  disabled = false,
  valueClassName,
}: {
  icon: React.ComponentType<{ className?: string }>;
  eyebrow?: string;
  value: string;
  label?: string;
  tone?: "default" | "accent" | "success";
  onClick?: () => void;
  ariaLabel?: string;
  disabled?: boolean;
  /* 24px is sized for numeric metrics; pass a smaller size for CJK word values */
  valueClassName?: string;
}) {
  const iconClass =
    tone === "accent"
      ? "glass-chip glass-chip--accent text-primary"
      : tone === "success"
        ? "glass-chip glass-chip--success text-success"
        : "glass-chip glass-chip--muted text-muted-foreground";

  const cardClassName = cn(
    "premium-stat-card hover-lift card-shine-hover px-4 py-4",
    onClick &&
      "w-full cursor-pointer text-left transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    disabled && "cursor-not-allowed opacity-70"
  );

  const content = (
    <>
      <div className="flex items-start gap-3">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${iconClass}`}
        >
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          {eyebrow ? (
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
              {eyebrow}
            </p>
          ) : null}
          <div
            className={cn(
              "mt-1 text-[24px] font-medium leading-none tracking-[-0.02em] text-foreground",
              valueClassName
            )}
          >
            {value}
          </div>
          {label ? (
            <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground/80">{label}</p>
          ) : null}
        </div>
      </div>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={ariaLabel}
        disabled={disabled}
        className={cardClassName}
      >
        {content}
      </button>
    );
  }

  return <div className={cardClassName}>{content}</div>;
}

/* ---- SubsectionHeader: h4-level header inside a section ---- */

export function SubsectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-3">
      <h4 className="text-[14px] font-semibold text-foreground tracking-tight">{title}</h4>
      {description && (
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground/75">{description}</p>
      )}
    </div>
  );
}
