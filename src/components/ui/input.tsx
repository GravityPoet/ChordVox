import * as React from "react";

import { cn } from "../lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-10 w-full min-w-0 rounded border border-border/70 bg-input px-3 py-2 text-sm text-foreground shadow-none transition-all duration-200 outline-none",
        "placeholder:text-muted-foreground/40",
        "selection:bg-primary selection:text-primary-foreground",
        "file:text-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-muted",
        "hover:border-border-hover",
        "focus-visible:ring-2 focus-visible:ring-[color:var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:shadow-[var(--shadow-selected-glow)]",
        "aria-invalid:ring-destructive/40 aria-invalid:ring-offset-2 aria-invalid:ring-offset-background aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  );
}

export { Input };
