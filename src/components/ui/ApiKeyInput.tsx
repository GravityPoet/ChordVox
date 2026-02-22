import React, { useState } from "react";
import { Check, Eye, EyeOff } from "lucide-react";
import { Input } from "./input";

interface ApiKeyInputProps {
  apiKey: string;
  setApiKey: (key: string) => void;
  className?: string;
  placeholder?: string;
  label?: string;
  helpText?: React.ReactNode;
  variant?: "default" | "purple";
}

export default function ApiKeyInput({
  apiKey,
  setApiKey,
  className = "",
  placeholder = "sk-...",
  label = "API Key",
  helpText = "Get your API key from platform.openai.com",
  variant = "default",
}: ApiKeyInputProps) {
  const [showKey, setShowKey] = useState(false);
  const hasKey = apiKey.length > 0;
  const variantClasses = variant === "purple" ? "border-primary focus:border-primary" : "";

  return (
    <div className={className}>
      {label && <label className="block text-xs font-medium text-foreground mb-1">{label}</label>}
      <div className="relative">
        <Input
          type={showKey ? "text" : "password"}
          placeholder={placeholder}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          className={`h-8 text-sm ${hasKey ? "pr-16" : ""} ${variantClasses}`}
        />
        {hasKey && (
          <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="text-muted-foreground/60 hover:text-foreground transition-colors cursor-pointer"
              tabIndex={-1}
              aria-label={showKey ? "Hide API key" : "Show API key"}
            >
              {showKey ? (
                <Eye className="w-3.5 h-3.5" />
              ) : (
                <EyeOff className="w-3.5 h-3.5" />
              )}
            </button>
            <Check className="w-3.5 h-3.5 text-success" />
          </div>
        )}
      </div>
      {helpText && <p className="text-[11px] text-muted-foreground/70 mt-1">{helpText}</p>}
    </div>
  );
}
