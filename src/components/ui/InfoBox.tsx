import React from "react";
import { cn } from "../lib/utils";
import { cva, type VariantProps } from "class-variance-authority";

const infoBoxVariants = cva("rounded-md border p-4 transition-colors", {
  variants: {
    variant: {
      default: "glass-panel glass-panel--accent text-foreground",
      success: "bg-success/8 border-success/20",
      warning: "bg-warning/8 border-warning/20",
      info: "bg-info/8 border-info/20",
      muted: "bg-surface-3 border-border/60 text-muted-foreground",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export interface InfoBoxProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof infoBoxVariants> {}

export function InfoBox({ variant, className, children, ...props }: InfoBoxProps) {
  return (
    <div className={cn(infoBoxVariants({ variant }), className)} {...props}>
      {children}
    </div>
  );
}
