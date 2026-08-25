import { cva } from "class-variance-authority";

export const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium tracking-wide transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary/12 text-primary ring-1 ring-primary/18",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive/12 text-destructive ring-1 ring-destructive/18",
        outline: "text-muted-foreground border-border",
        neutral: "bg-surface-3 text-muted-foreground border-border",
        success: "border-transparent bg-success/12 text-success ring-1 ring-success/18",
        warning:
          "border-transparent bg-warning/12 text-[color:var(--ui-warning-ink)] ring-1 ring-warning/18",
        info: "border-transparent bg-info/12 text-info ring-1 ring-info/18",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);
