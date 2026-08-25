import { cva } from "class-variance-authority";

export const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap",
    "rounded text-sm font-medium cursor-pointer select-none",
    "transition-all duration-200 ease-out",
    "outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    "disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed",
    "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        default: [
          "relative text-primary-foreground font-semibold tracking-[0.005em]",
          "bg-primary",
          "border border-primary/60",
          "shadow-sm",
          "hover:bg-primary/95 hover:shadow",
          "active:bg-primary/85 active:scale-[0.985]",
          "transition-all duration-200 ease-out",
        ].join(" "),
        success: [
          "relative text-success-foreground font-semibold tracking-[0.01em]",
          "bg-success",
          "border border-success/70",
          "shadow-sm",
          "hover:bg-success/90",
          "active:bg-success/80 active:scale-[0.98]",
        ].join(" "),
        destructive: [
          "relative text-destructive-foreground font-semibold tracking-[0.01em]",
          "bg-destructive",
          "border border-destructive/70",
          "shadow-sm",
          "hover:bg-destructive/90",
          "active:bg-destructive/80 active:scale-[0.98]",
        ].join(" "),
        outline: [
          "relative font-medium",
          "text-foreground backdrop-blur-md",
          "border border-[color:var(--ui-glass-panel-border)] bg-[var(--ui-glass-panel-bg)]",
          "shadow-[var(--ui-glass-panel-shadow)]",
          "hover:border-border-hover hover:bg-[var(--ui-glass-panel-bg-hover)] hover:shadow-[var(--ui-glass-panel-shadow-hover)]",
          "active:scale-[0.985]",
          "transition-all duration-200 ease-out",
        ].join(" "),
        secondary: [
          "relative font-medium",
          "text-foreground backdrop-blur-md",
          "border border-[color:var(--ui-glass-panel-chrome-border)] bg-[var(--ui-glass-panel-chrome-bg)]",
          "shadow-[var(--ui-glass-panel-chrome-shadow)]",
          "hover:bg-[var(--ui-glass-panel-bg-hover)] hover:shadow-[var(--ui-glass-panel-shadow-hover)]",
          "active:scale-[0.98]",
        ].join(" "),
        ghost: [
          "font-medium",
          "text-foreground",
          "hover:bg-[var(--ui-glass-chip-bg)] hover:backdrop-blur-sm",
          "active:scale-[0.98]",
        ].join(" "),
        link: [
          "font-medium",
          "text-primary",
          "hover:text-primary/80 hover:underline",
          "underline-offset-4",
        ].join(" "),
        social: [
          "relative font-medium",
          "text-foreground backdrop-blur-xl",
          "border border-[color:var(--ui-glass-chip-border)] bg-[var(--ui-glass-chip-bg)]",
          "shadow-[var(--ui-glass-panel-shadow)] gap-2",
          "hover:border-border-hover hover:bg-[var(--ui-glass-panel-bg-hover)] hover:shadow-[var(--ui-glass-panel-shadow-hover)]",
          "active:scale-[0.985] active:shadow-sm",
          "transition-all duration-200 ease-out",
        ].join(" "),
        subtle: [
          "relative font-medium",
          "bg-transparent text-foreground",
          "hover:bg-surface-2 active:bg-surface-3",
        ].join(" "),
        tinted: [
          "relative font-medium",
          "text-primary backdrop-blur-md",
          "border border-[color:var(--ui-glass-chip-accent-border)] bg-[var(--ui-glass-chip-accent-bg)]",
          "hover:border-border-hover hover:bg-[var(--ui-glass-chip-selected-bg)] active:bg-[var(--ui-glass-chip-selected-bg)]",
        ].join(" "),
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 px-3 text-xs gap-1.5",
        lg: "h-12 px-6 text-sm",
        icon: "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);
