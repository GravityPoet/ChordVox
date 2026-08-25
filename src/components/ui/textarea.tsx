import * as React from "react";

import { cn } from "../lib/utils";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "flex min-h-[80px] w-full rounded-[var(--radius-lg)] border border-border/70 bg-input px-3.5 py-3 text-sm text-foreground shadow-none transition-all duration-200 outline-none resize-y cursor-text",
          "placeholder:text-muted-foreground/40",
          "selection:bg-primary selection:text-primary-foreground",
          "hover:border-border-hover",
          "focus-visible:ring-2 focus-visible:ring-[color:var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:shadow-[var(--shadow-selected-glow)]",
          "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-muted",
          "aria-invalid:ring-destructive/40 aria-invalid:ring-offset-2 aria-invalid:ring-offset-background aria-invalid:border-destructive",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Textarea.displayName = "Textarea";

export { Textarea };
