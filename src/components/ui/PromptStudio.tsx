import React, { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import { Textarea } from "./textarea";
import {
  Eye,
  Edit3,
  Play,
  Save,
  RotateCcw,
  Copy,
  TestTube,
  AlertTriangle,
  Check,
} from "lucide-react";
import { AlertDialog } from "./dialog";
import { useDialogs } from "../../hooks/useDialogs";
import { useAgentName } from "../../utils/agentName";
import ReasoningService from "../../services/ReasoningService";
import { getModelProvider } from "../../models/ModelRegistry";
import logger from "../../utils/logger";
import { UNIFIED_SYSTEM_PROMPT, getPromptBundle } from "../../config/prompts";

interface PromptStudioProps {
  className?: string;
  ensureTestAccess?: () => Promise<boolean>;
  onUpgradeToPro?: () => void;
  canOfferTrial?: boolean;
}

type ProviderConfig = {
  label: string;
  apiKeyStorageKey?: string;
  baseStorageKey?: string;
};

const PROVIDER_CONFIG: Record<string, ProviderConfig> = {
  openai: { label: "OpenAI", apiKeyStorageKey: "openaiApiKey" },
  anthropic: { label: "Anthropic", apiKeyStorageKey: "anthropicApiKey" },
  gemini: { label: "Gemini", apiKeyStorageKey: "geminiApiKey" },
  groq: { label: "Groq", apiKeyStorageKey: "groqApiKey" },
  cerebras: { label: "Cerebras", apiKeyStorageKey: "cerebrasApiKey" },
  custom: {
    label: "Custom endpoint",
    apiKeyStorageKey: "openaiApiKey",
    baseStorageKey: "cloudReasoningBaseUrl",
  },
  local: { label: "Local" },
};

function migrateLegacyBrandNames(input: string): string {
  const legacyBrandNames = ["AriaKey", "Whispr", ["Open", "Whispr"].join(""), "MoonlitVoice"];
  return legacyBrandNames.reduce(
    (result, name) => result.replace(new RegExp(`\\b${name}\\b`, "gi"), "ChordVox"),
    input
  );
}

function readStoredCustomPrompt(): string | null {
  const customPrompt = localStorage.getItem("customUnifiedPrompt");
  if (customPrompt) {
    try {
      const parsed = JSON.parse(customPrompt);
      if (typeof parsed !== "string") return null;
      return migrateLegacyBrandNames(parsed);
    } catch {
      return null;
    }
  }
  return null;
}

function isDefaultPromptEquivalent(prompt: string, localizedDefaultPrompt: string): boolean {
  const migrated = migrateLegacyBrandNames(prompt);
  return migrated === localizedDefaultPrompt || migrated === UNIFIED_SYSTEM_PROMPT;
}

function getCurrentPrompt(localizedDefaultPrompt: string): string {
  const customPrompt = readStoredCustomPrompt();
  if (customPrompt && !isDefaultPromptEquivalent(customPrompt, localizedDefaultPrompt)) {
    return customPrompt;
  }
  return localizedDefaultPrompt;
}

export default function PromptStudio({
  className = "",
  ensureTestAccess,
  onUpgradeToPro,
  canOfferTrial = false,
}: PromptStudioProps) {
  const { t, i18n } = useTranslation();
  const { agentName } = useAgentName();
  const localizedDefaultPrompt = useMemo(
    () => getPromptBundle(i18n.resolvedLanguage || i18n.language).fullPrompt,
    [i18n.language, i18n.resolvedLanguage]
  );
  const [activeTab, setActiveTab] = useState<"current" | "edit" | "test">("current");
  const [editedPrompt, setEditedPrompt] = useState(localizedDefaultPrompt);
  const [testText, setTestText] = useState(() => t("promptStudio.defaultTestInput"));
  const [testResult, setTestResult] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [showTestRequiresPro, setShowTestRequiresPro] = useState(false);

  const { alertDialog, showAlertDialog, hideAlertDialog } = useDialogs();

  useEffect(() => {
    const legacyPrompts = localStorage.getItem("customPrompts");
    if (legacyPrompts && !localStorage.getItem("customUnifiedPrompt")) {
      try {
        const parsed = JSON.parse(legacyPrompts);
        if (typeof parsed?.agent === "string") {
          localStorage.setItem(
            "customUnifiedPrompt",
            JSON.stringify(migrateLegacyBrandNames(parsed.agent))
          );
          localStorage.removeItem("customPrompts");
        }
      } catch (e) {
        console.error("Failed to migrate legacy custom prompts:", e);
      }
    }

    const customPrompt = readStoredCustomPrompt();
    if (customPrompt) {
      if (isDefaultPromptEquivalent(customPrompt, localizedDefaultPrompt)) {
        localStorage.removeItem("customUnifiedPrompt");
        setEditedPrompt(localizedDefaultPrompt);
        return;
      }

      const migrated = migrateLegacyBrandNames(customPrompt);
      if (migrated !== customPrompt) {
        localStorage.setItem("customUnifiedPrompt", JSON.stringify(migrated));
      }
      setEditedPrompt(migrated);
      return;
    }

    setEditedPrompt(localizedDefaultPrompt);
  }, [localizedDefaultPrompt]);

  const savePrompt = () => {
    if (isDefaultPromptEquivalent(editedPrompt, localizedDefaultPrompt)) {
      localStorage.removeItem("customUnifiedPrompt");
    } else {
      localStorage.setItem("customUnifiedPrompt", JSON.stringify(editedPrompt));
    }
    showAlertDialog({
      title: t("promptStudio.dialogs.saved.title"),
      description: t("promptStudio.dialogs.saved.description"),
    });
  };

  const resetToDefault = () => {
    setEditedPrompt(localizedDefaultPrompt);
    localStorage.removeItem("customUnifiedPrompt");
    showAlertDialog({
      title: t("promptStudio.dialogs.reset.title"),
      description: t("promptStudio.dialogs.reset.description"),
    });
  };

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedPrompt(true);
    setTimeout(() => setCopiedPrompt(false), 2000);
  };

  const testPrompt = async () => {
    if (!testText.trim()) return;

    if (ensureTestAccess) {
      const allowed = await ensureTestAccess();
      if (!allowed) {
        setShowTestRequiresPro(true);
        setTestResult("");
        return;
      }
    }

    setShowTestRequiresPro(false);
    setIsLoading(true);
    setTestResult("");

    try {
      const useReasoningModel = localStorage.getItem("useReasoningModel") === "true";
      const reasoningModel = localStorage.getItem("reasoningModel") || "";
      const reasoningProvider = reasoningModel ? getModelProvider(reasoningModel) : "openai";

      logger.debug(
        "PromptStudio test starting",
        {
          useReasoningModel,
          reasoningModel,
          reasoningProvider,
          testTextLength: testText.length,
          agentName,
        },
        "prompt-studio"
      );

      if (!useReasoningModel) {
        setTestResult(t("promptStudio.test.disabledReasoning"));
        return;
      }

      if (!reasoningModel) {
        setTestResult(t("promptStudio.test.noModelSelected"));
        return;
      }

      const providerConfig = PROVIDER_CONFIG[reasoningProvider] || {
        label: reasoningProvider.charAt(0).toUpperCase() + reasoningProvider.slice(1),
      };

      if (providerConfig.baseStorageKey) {
        const baseUrl = (localStorage.getItem(providerConfig.baseStorageKey) || "").trim();
        if (!baseUrl) {
          setTestResult(
            t("promptStudio.test.baseUrlMissing", {
              provider: providerConfig.label,
            })
          );
          return;
        }
      }

      const result = await ReasoningService.processText(testText, reasoningModel, agentName, {
        systemPromptOverride: editedPrompt,
      });
      setTestResult(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("PromptStudio test failed", { error: errorMessage }, "prompt-studio");
      setTestResult(t("promptStudio.test.failed", { error: errorMessage }));
    } finally {
      setIsLoading(false);
    }
  };

  const isAgentAddressed = testText.toLowerCase().includes(agentName.toLowerCase());
  const currentPrompt = getCurrentPrompt(localizedDefaultPrompt);
  const storedCustomPrompt = readStoredCustomPrompt();
  const isCustomPrompt =
    storedCustomPrompt !== null &&
    !isDefaultPromptEquivalent(storedCustomPrompt, localizedDefaultPrompt);

  const tabs = [
    { id: "current" as const, label: t("promptStudio.tabs.view"), icon: Eye },
    { id: "edit" as const, label: t("promptStudio.tabs.customize"), icon: Edit3 },
    { id: "test" as const, label: t("promptStudio.tabs.test"), icon: TestTube },
  ];

  return (
    <div className={className}>
      <AlertDialog
        open={alertDialog.open}
        onOpenChange={(open) => !open && hideAlertDialog()}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      {/* Tab Navigation + Content in a single panel */}
      <div className="premium-panel premium-panel--subtle rounded-[var(--radius-xl)] overflow-hidden">
        <div
          className="glass-panel glass-panel--chrome flex border-x-0 border-t-0 rounded-none"
          role="tablist"
          aria-label={t("settingsModal.sections.prompts.label")}
        >
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                type="button"
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                role="tab"
                aria-selected={isActive}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-[13px] font-medium transition-all duration-150 ${
                  isActive
                    ? "glass-chip glass-chip--selected text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-white/30 dark:hover:bg-white/6"
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* ── View Tab ── */}
        {activeTab === "current" && (
          <div className="divide-y divide-border/40">
            <div className="px-5 py-4">
              <div className="space-y-2">
                {[
                  {
                    mode: t("promptStudio.view.modes.cleanup.label"),
                    desc: t("promptStudio.view.modes.cleanup.description"),
                  },
                  {
                    mode: t("promptStudio.view.modes.agent.label"),
                    desc: t("promptStudio.view.modes.agent.description", { agentName }),
                  },
                ].map((item) => (
                  <div key={item.mode} className="flex items-start gap-3">
                    <span className="shrink-0 mt-0.5 text-[10px] font-medium uppercase tracking-wider px-1.5 py-px rounded bg-muted text-muted-foreground">
                      {item.mode}
                    </span>
                    <p className="text-[12px] text-muted-foreground leading-relaxed">{item.desc}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="px-5 py-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <p className="text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider">
                    {isCustomPrompt
                      ? t("promptStudio.view.customPrompt")
                      : t("promptStudio.view.defaultPrompt")}
                  </p>
                  {isCustomPrompt && (
                    <span className="glass-chip glass-chip--accent rounded-full px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-primary">
                      {t("promptStudio.view.modified")}
                    </span>
                  )}
                </div>
                <Button
                  onClick={() => copyText(currentPrompt)}
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                >
                  {copiedPrompt ? (
                    <>
                      <Check className="w-3 h-3 mr-1 text-success" />{" "}
                      {t("promptStudio.common.copied")}
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3 mr-1" /> {t("promptStudio.common.copy")}
                    </>
                  )}
                </Button>
              </div>
              <div className="prompt-content-panel premium-panel premium-panel--subtle max-h-80 overflow-y-auto rounded-[var(--radius-lg)] p-4">
                <pre className="text-[13px] text-muted-foreground whitespace-pre-wrap leading-relaxed">
                  {currentPrompt.replace(/\{\{agentName\}\}/g, agentName)}
                </pre>
              </div>
            </div>
          </div>
        )}

        {/* ── Edit Tab ── */}
        {activeTab === "edit" && (
          <div className="divide-y divide-border/40">
            <div className="px-5 py-4">
              <p className="text-[12px] text-muted-foreground leading-relaxed">
                <span className="font-medium text-warning">
                  {t("promptStudio.edit.cautionLabel")}
                </span>{" "}
                {t("promptStudio.edit.cautionTextPrefix")}{" "}
                <code className="text-[11px] bg-muted/50 px-1 py-0.5 rounded font-mono">
                  {"{{agentName}}"}
                </code>{" "}
                {t("promptStudio.edit.cautionTextSuffix")}
              </p>
            </div>

            <div className="px-5 py-4">
              <Textarea
                name="editedPrompt"
                value={editedPrompt}
                onChange={(e) => setEditedPrompt(e.target.value)}
                rows={16}
                className="text-[13px] leading-relaxed"
                placeholder={t("promptStudio.edit.placeholder")}
                aria-label={t("promptStudio.edit.placeholder")}
              />
              <p className="text-[11px] text-muted-foreground/50 mt-2">
                {t("promptStudio.edit.agentNameLabel")}{" "}
                <span className="font-medium text-foreground">{agentName}</span>
              </p>
            </div>

            <div className="px-5 py-4">
              <div className="flex gap-2">
                <Button onClick={savePrompt} size="sm" className="flex-1">
                  <Save className="w-3.5 h-3.5 mr-2" />
                  {t("promptStudio.common.save")}
                </Button>
                <Button onClick={resetToDefault} variant="outline" size="sm">
                  <RotateCcw className="w-3.5 h-3.5 mr-2" />
                  {t("promptStudio.common.reset")}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ── Test Tab ── */}
        {activeTab === "test" &&
          (() => {
            const useReasoningModel = localStorage.getItem("useReasoningModel") === "true";
            const reasoningModel = localStorage.getItem("reasoningModel") || "";
            const reasoningProvider = reasoningModel ? getModelProvider(reasoningModel) : "openai";
            const providerConfig = PROVIDER_CONFIG[reasoningProvider] || {
              label: reasoningProvider.charAt(0).toUpperCase() + reasoningProvider.slice(1),
            };

            const displayModel = reasoningModel || t("promptStudio.test.none");
            const displayProvider = providerConfig.label;

            return (
              <div className="divide-y divide-border/40">
                {showTestRequiresPro && (
                  <div className="px-5 py-4">
                    <div className="rounded-lg border border-warning/20 bg-warning/5 px-4 py-3">
                      <div className="flex items-start gap-2.5">
                        <AlertTriangle className="w-3.5 h-3.5 text-warning mt-0.5 shrink-0" />
                        <div className="space-y-3">
                          <div>
                            <p className="text-[12px] font-medium text-foreground leading-relaxed">
                              {t("settingsPage.prompts.requiresProTitle")}
                            </p>
                            <p className="mt-1 text-[12px] text-muted-foreground leading-relaxed">
                              {t("settingsPage.prompts.requiresProDescription")}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button size="sm" onClick={onUpgradeToPro}>
                              {canOfferTrial
                                ? t("settingsPage.account.trialStartDialog.confirm")
                                : t("settingsPage.account.checkout.upgradeToPro")}
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {!useReasoningModel && (
                  <div className="px-5 py-4">
                    <div className="rounded-lg border border-warning/20 bg-warning/5 px-4 py-3">
                      <div className="flex items-start gap-2.5">
                        <AlertTriangle className="w-3.5 h-3.5 text-warning mt-0.5 shrink-0" />
                        <p className="text-[12px] text-muted-foreground leading-relaxed">
                          {t("promptStudio.test.disabledInSettingsPrefix")}{" "}
                          <span className="font-medium text-foreground">
                            {t("promptStudio.test.aiModels")}
                          </span>{" "}
                          {t("promptStudio.test.disabledInSettingsSuffix")}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                <div className="px-5 py-4">
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <p className="text-[11px] text-muted-foreground/60 uppercase tracking-wider">
                        {t("promptStudio.test.modelLabel")}
                      </p>
                      <p className="text-[12px] font-medium text-foreground font-mono">
                        {displayModel}
                      </p>
                    </div>
                    <div className="h-3 w-px bg-border/40" />
                    <div className="flex items-center gap-2">
                      <p className="text-[11px] text-muted-foreground/60 uppercase tracking-wider">
                        {t("promptStudio.test.providerLabel")}
                      </p>
                      <p className="text-[12px] font-medium text-foreground">{displayProvider}</p>
                    </div>
                  </div>
                </div>

                <div className="px-5 py-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[12px] font-medium text-foreground">
                      {t("promptStudio.test.inputLabel")}
                    </p>
                    {testText && (
                      <span
                        className={`text-[10px] font-medium uppercase tracking-wider px-1.5 py-px rounded ${
                          isAgentAddressed
                            ? "glass-chip glass-chip--accent text-primary"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {isAgentAddressed
                          ? t("promptStudio.test.instruction")
                          : t("promptStudio.test.cleanup")}
                      </span>
                    )}
                  </div>
                  <Textarea
                    name="promptTestInput"
                    value={testText}
                    onChange={(e) => {
                      setTestText(e.target.value);
                      if (showTestRequiresPro) {
                        setShowTestRequiresPro(false);
                      }
                    }}
                    rows={3}
                    className="text-[12px]"
                    placeholder={t("promptStudio.test.inputPlaceholder")}
                    aria-label={t("promptStudio.test.inputPlaceholder")}
                  />
                  <p className="text-[10px] text-muted-foreground/40 mt-1.5">
                    {t("promptStudio.test.addressHint", { agentName })}
                  </p>
                </div>

                <div className="px-5 py-4">
                  <Button
                    onClick={testPrompt}
                    disabled={!testText.trim() || isLoading || !useReasoningModel}
                    size="sm"
                    className="w-full"
                  >
                    <Play className="w-3.5 h-3.5 mr-2" />
                    {isLoading ? t("promptStudio.test.processing") : t("promptStudio.test.run")}
                  </Button>
                </div>

                {testResult && (
                  <div className="px-5 py-4" aria-live="polite">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-[12px] font-medium text-foreground">
                        {t("promptStudio.test.outputLabel")}
                      </p>
                      <Button
                        type="button"
                        onClick={() => copyText(testResult)}
                        variant="ghost"
                        size="sm"
                        aria-label={t("common.copy")}
                        title={t("common.copy")}
                        className="h-6 px-1.5"
                      >
                        <Copy className="w-3 h-3 text-muted-foreground" aria-hidden="true" />
                      </Button>
                    </div>
                    <div className="prompt-content-panel max-h-48 overflow-y-auto rounded-lg border border-border/30 bg-muted/30 p-4">
                      <pre className="text-[12px] text-foreground whitespace-pre-wrap leading-relaxed">
                        {testResult}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
      </div>
    </div>
  );
}
