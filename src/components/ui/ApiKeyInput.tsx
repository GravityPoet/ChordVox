import React, { useId, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Input } from "./input";

type ApiKeyProvider =
  | "openai"
  | "anthropic"
  | "gemini"
  | "groq"
  | "cerebras"
  | "deepgram"
  | "soniox"
  | "google"
  | "doubao"
  | "custom";

const PROVIDER_PLACEHOLDERS: Record<ApiKeyProvider, string> = {
  openai: "sk-...",
  anthropic: "sk-ant-...",
  gemini: "AIza...",
  groq: "gsk_...",
  cerebras: "Cerebras API key",
  deepgram: "Token",
  soniox: "soniox-...",
  google: "AIza...",
  doubao: "Volcano Engine token",
  custom: "API Key",
};

interface ApiKeyInputProps {
  apiKey: string;
  setApiKey: (key: string) => void;
  className?: string;
  placeholder?: string;
  provider?: ApiKeyProvider;
  label?: string;
  ariaLabel?: string;
  helpText?: React.ReactNode;
  variant?: "default" | "purple";
  name?: string;
}

export default function ApiKeyInput({
  apiKey,
  setApiKey,
  className = "",
  placeholder,
  provider,
  label,
  ariaLabel,
  helpText,
  variant = "default",
  name,
}: ApiKeyInputProps) {
  const { t } = useTranslation();
  const inputId = useId();
  const helpTextId = `${inputId}-help`;
  const [showKey, setShowKey] = useState(false);
  const hasKey = apiKey.length > 0;
  const variantClasses = variant === "purple" ? "border-primary focus:border-primary" : "";
  const resolvedLabel = label ?? t("common.apiKey");
  const accessibleLabel = ariaLabel || resolvedLabel || t("common.apiKey");
  const resolvedHelpText = helpText ?? t("common.apiKeyHelp");
  const resolvedPlaceholder =
    placeholder ?? (provider ? PROVIDER_PLACEHOLDERS[provider] : "sk-...");

  return (
    <div className={className}>
      {resolvedLabel && (
        <label htmlFor={inputId} className="block text-xs font-medium text-foreground mb-1">
          {resolvedLabel}
        </label>
      )}
      <div className="relative">
        <Input
          id={inputId}
          name={name || (provider ? `${provider}ApiKey` : "apiKey")}
          type={showKey ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          placeholder={resolvedPlaceholder}
          aria-label={accessibleLabel}
          aria-describedby={resolvedHelpText ? helpTextId : undefined}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          className={`h-8 text-sm ${hasKey ? "pr-10" : ""} ${variantClasses}`}
        />
        {hasKey && (
          <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center">
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="text-muted-foreground/60 hover:text-foreground transition-colors cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-ring)] focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              aria-label={showKey ? t("common.hideApiKey") : t("common.showApiKey")}
            >
              {showKey ? (
                <EyeOff className="w-3.5 h-3.5" aria-hidden="true" />
              ) : (
                <Eye className="w-3.5 h-3.5" aria-hidden="true" />
              )}
            </button>
          </div>
        )}
      </div>
      {resolvedHelpText && (
        <p id={helpTextId} className="text-[11px] text-muted-foreground/70 mt-1">
          {resolvedHelpText}
        </p>
      )}
    </div>
  );
}
