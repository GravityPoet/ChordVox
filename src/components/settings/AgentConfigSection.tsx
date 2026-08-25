import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsPanel, SettingsPanelRow, SectionCard, SubsectionHeader } from "./shared";
import { StyleRule } from "../../utils/appStyleRules";

export interface AgentConfigSectionProps {
  agentName: string;
  agentNameInput: string;
  setAgentNameInput: (value: string) => void;
  onSaveAgentName: () => void;
  dictionaryManager: React.ReactNode;
}

export function AgentConfigSection({
  agentName,
  agentNameInput,
  setAgentNameInput,
  onSaveAgentName,
  dictionaryManager,
}: AgentConfigSectionProps) {
  const { t } = useTranslation();
  const [rules, setRules] = useState<StyleRule[]>([]);
  const [isPickingApp, setIsPickingApp] = useState(false);
  const [appPickerFailed, setAppPickerFailed] = useState(false);
  const canPickApps =
    window.electronAPI?.getPlatform?.() === "darwin" &&
    typeof window.electronAPI?.pickSensitiveApps === "function";

  useEffect(() => {
    try {
      const raw = localStorage.getItem("appPolishStyleRules");
      if (raw) {
        const parsed = JSON.parse(raw);
        // Corrupt/non-array storage would crash rules.map below.
        if (Array.isArray(parsed)) {
          setRules(parsed);
        }
      }
    } catch (e) {
      // Ignore
    }
  }, []);

  const saveRules = (newRules: StyleRule[]) => {
    setRules(newRules);
    localStorage.setItem("appPolishStyleRules", JSON.stringify(newRules));
  };

  const handleAddRule = () => {
    setAppPickerFailed(false);
    const newRules: StyleRule[] = [
      ...rules,
      {
        match: { appNameContains: "" },
        styleKey: "casual",
      },
    ];
    saveRules(newRules);
  };

  const handlePickApps = async (ruleIndex?: number) => {
    if (!canPickApps || !window.electronAPI?.pickSensitiveApps) {
      if (typeof ruleIndex !== "number") handleAddRule();
      return;
    }

    setIsPickingApp(true);
    setAppPickerFailed(false);
    try {
      const result = await window.electronAPI.pickSensitiveApps({
        title: t("settingsPage.agentConfig.styleRules.pickAppsTitle"),
      });
      if (!result?.success) {
        setAppPickerFailed(true);
        return;
      }
      if (result.cancelled || !result.apps?.length) return;

      if (typeof ruleIndex === "number") {
        const app = result.apps[0];
        handleUpdateRule(ruleIndex, {
          displayName: app.appName,
          match: app.bundleId
            ? { bundleIdPrefix: app.bundleId, appNameContains: undefined }
            : { appNameContains: app.appName, bundleIdPrefix: undefined },
        });
        return;
      }

      const existingMatches = new Set(
        rules.map((rule) =>
          (rule.match.bundleIdPrefix || rule.match.appNameContains || "").trim().toLowerCase()
        )
      );
      const additions: StyleRule[] = [];
      for (const app of result.apps) {
        const matchValue = (app.bundleId || app.appName).trim();
        if (!matchValue || existingMatches.has(matchValue.toLowerCase())) continue;
        existingMatches.add(matchValue.toLowerCase());
        additions.push({
          displayName: app.appName,
          match: app.bundleId ? { bundleIdPrefix: app.bundleId } : { appNameContains: app.appName },
          styleKey: "casual",
        });
      }
      if (additions.length > 0) saveRules([...rules, ...additions]);
    } catch (error) {
      console.error("Failed to choose apps for polishing rules:", error);
      setAppPickerFailed(true);
    } finally {
      setIsPickingApp(false);
    }
  };

  const handleUpdateRule = (index: number, updated: Partial<StyleRule>) => {
    const newRules = rules.map((r, i) => {
      if (i === index) {
        const match = updated.match ? { ...r.match, ...updated.match } : r.match;
        const result = { ...r, ...updated, match } as StyleRule;
        if (result.match.appNameContains === undefined) delete result.match.appNameContains;
        if (result.match.bundleIdPrefix === undefined) delete result.match.bundleIdPrefix;
        if (result.displayName === undefined) delete result.displayName;
        return result;
      }
      return r;
    });
    saveRules(newRules);
  };

  const handleDeleteRule = (index: number) => {
    const newRules = rules.filter((_, i) => i !== index);
    saveRules(newRules);
  };
  const examples = [
    {
      input: t("settingsPage.agentConfig.examples.normalDictation.input"),
      mode: t("settingsPage.agentConfig.examples.normalDictation.mode"),
      kind: "cleanup",
    },
    {
      input: t("settingsPage.agentConfig.examples.processPrevious.input", { agentName }),
      mode: t("settingsPage.agentConfig.examples.processPrevious.mode"),
      kind: "agent",
    },
    {
      input: t("settingsPage.agentConfig.examples.directGenerate.input", { agentName }),
      mode: t("settingsPage.agentConfig.examples.directGenerate.mode"),
      kind: "agent",
    },
    {
      input: t("settingsPage.agentConfig.examples.format.input", { agentName }),
      mode: t("settingsPage.agentConfig.examples.format.mode"),
      kind: "agent",
    },
  ] as const;

  return (
    <div className="space-y-5">
      <SectionCard
        title={t("settingsPage.agentConfig.title")}
        description={t("settingsPage.agentConfig.description")}
      >
        <div className="space-y-5">
          <div>
            <SettingsPanel>
              <SettingsPanelRow>
                <div className="space-y-3">
                  <div className="flex gap-2">
                    <Input
                      name="agentName"
                      autoComplete="off"
                      placeholder={t("settingsPage.agentConfig.placeholder")}
                      aria-label={t("settingsPage.agentConfig.placeholder")}
                      value={agentNameInput}
                      onChange={(e) => setAgentNameInput(e.target.value)}
                      className="agent-name-input w-48 text-left text-base font-mono"
                    />
                    <Button onClick={onSaveAgentName} disabled={!agentNameInput.trim()} size="sm">
                      {t("settingsPage.agentConfig.save")}
                    </Button>
                  </div>
                </div>
              </SettingsPanelRow>
            </SettingsPanel>
          </div>

          <div>
            <SubsectionHeader title={t("settingsPage.agentConfig.howItWorksTitle")} />
            <SettingsPanel>
              <SettingsPanelRow>
                <p className="text-[14px] text-muted-foreground leading-relaxed">
                  {t("settingsPage.agentConfig.howItWorksDescription", { agentName })}
                </p>
              </SettingsPanelRow>
            </SettingsPanel>
          </div>

          <div>
            <SubsectionHeader title={t("settingsPage.agentConfig.examplesTitle")} />
            <SettingsPanel>
              <SettingsPanelRow>
                <div className="space-y-2.5">
                  {examples.map((example, i) => (
                    <div key={i} className="flex items-start gap-3">
                      <span
                        className={`shrink-0 mt-0.5 text-[11px] font-medium uppercase tracking-wider px-1.5 py-px rounded ${
                          example.kind === "agent"
                            ? "glass-chip glass-chip--accent text-primary"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {example.mode}
                      </span>
                      <p className="text-[14px] text-muted-foreground leading-relaxed">
                        "{example.input}"
                      </p>
                    </div>
                  ))}
                </div>
              </SettingsPanelRow>
            </SettingsPanel>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title={t("settingsPage.agentConfig.styleRules.title")}
        description={t("settingsPage.agentConfig.styleRules.description")}
      >
        <div className="space-y-4">
          {rules.length === 0 ? (
            <div className="text-[14px] text-muted-foreground italic py-2">
              {t("settingsPage.agentConfig.styleRules.emptyRules")}
            </div>
          ) : (
            <div className="space-y-3">
              {rules.map((rule, index) => {
                const isBundle = !!rule.match.bundleIdPrefix;
                const matchType = isBundle ? "bundle" : "app";
                const matchValue = isBundle
                  ? rule.match.bundleIdPrefix
                  : rule.match.appNameContains;

                return (
                  <div
                    key={index}
                    className="space-y-2 border border-border/40 p-3 rounded-lg bg-card/30"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="min-w-40 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">
                          {rule.displayName ||
                            matchValue ||
                            t("settingsPage.agentConfig.styleRules.matchValuePlaceholder")}
                        </p>
                        {rule.displayName && matchValue && (
                          <p className="truncate font-mono text-[11px] text-muted-foreground">
                            {matchValue}
                          </p>
                        )}
                      </div>
                      <select
                        name={`styleRuleStyle-${index}`}
                        value={rule.styleKey}
                        onChange={(e) => {
                          const key = e.target.value as StyleRule["styleKey"];
                          handleUpdateRule(index, { styleKey: key });
                        }}
                        aria-label={t("settingsPage.agentConfig.styleRules.title")}
                        className="h-9 rounded-md border border-input bg-background/50 px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                      >
                        <option value="casual">
                          {t("settingsPage.agentConfig.styleRules.styleKeyCasual")}
                        </option>
                        <option value="professional">
                          {t("settingsPage.agentConfig.styleRules.styleKeyProfessional")}
                        </option>
                        <option value="technical">
                          {t("settingsPage.agentConfig.styleRules.styleKeyTechnical")}
                        </option>
                        <option value="custom">
                          {t("settingsPage.agentConfig.styleRules.styleKeyCustom")}
                        </option>
                      </select>

                      {canPickApps && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={isPickingApp}
                          onClick={() => void handlePickApps(index)}
                        >
                          {t("settingsPage.agentConfig.styleRules.changeApp")}
                        </Button>
                      )}

                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleDeleteRule(index)}
                      >
                        {t("settingsPage.agentConfig.styleRules.delete")}
                      </Button>
                    </div>

                    <details className="rounded-md border border-border/35 bg-background/30 px-3 py-2">
                      <summary className="cursor-pointer text-[12px] font-medium text-muted-foreground">
                        {t("settingsPage.agentConfig.styleRules.advancedMatcher")}
                      </summary>
                      <div className="mt-2 flex items-center gap-2">
                        <select
                          name={`styleRuleMatchType-${index}`}
                          value={matchType}
                          onChange={(e) => {
                            const type = e.target.value;
                            if (type === "bundle") {
                              handleUpdateRule(index, {
                                displayName: undefined,
                                match: {
                                  bundleIdPrefix: matchValue || "",
                                  appNameContains: undefined,
                                },
                              });
                            } else {
                              handleUpdateRule(index, {
                                displayName: undefined,
                                match: {
                                  appNameContains: matchValue || "",
                                  bundleIdPrefix: undefined,
                                },
                              });
                            }
                          }}
                          aria-label={t("settingsPage.agentConfig.styleRules.title")}
                          className="h-9 rounded-md border border-input bg-background/50 px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        >
                          <option value="app">
                            {t("settingsPage.agentConfig.styleRules.matchTypeApp")}
                          </option>
                          <option value="bundle">
                            {t("settingsPage.agentConfig.styleRules.matchTypeBundle")}
                          </option>
                        </select>

                        <Input
                          name={`styleRuleMatchValue-${index}`}
                          autoComplete="off"
                          placeholder={t(
                            "settingsPage.agentConfig.styleRules.matchValuePlaceholder"
                          )}
                          aria-label={t(
                            "settingsPage.agentConfig.styleRules.matchValuePlaceholder"
                          )}
                          value={matchValue || ""}
                          onChange={(e) => {
                            const val = e.target.value;
                            if (matchType === "bundle") {
                              handleUpdateRule(index, {
                                displayName: undefined,
                                match: { bundleIdPrefix: val },
                              });
                            } else {
                              handleUpdateRule(index, {
                                displayName: undefined,
                                match: { appNameContains: val },
                              });
                            }
                          }}
                          className="flex-1"
                        />
                      </div>
                    </details>

                    {rule.styleKey === "custom" && (
                      <Input
                        name={`styleRuleCustomPrompt-${index}`}
                        autoComplete="off"
                        placeholder={t(
                          "settingsPage.agentConfig.styleRules.customPromptPlaceholder"
                        )}
                        aria-label={t(
                          "settingsPage.agentConfig.styleRules.customPromptPlaceholder"
                        )}
                        value={rule.customPrompt || ""}
                        onChange={(e) => handleUpdateRule(index, { customPrompt: e.target.value })}
                        className="w-full font-mono text-sm"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <Button
            onClick={() => void handlePickApps()}
            disabled={isPickingApp}
            variant="outline"
            size="sm"
            className="w-full"
          >
            {canPickApps
              ? t("settingsPage.agentConfig.styleRules.chooseApps")
              : t("settingsPage.agentConfig.styleRules.addRule")}
          </Button>
          {appPickerFailed && (
            <div className="flex flex-col items-center gap-2">
              <p className="text-center text-xs text-destructive">
                {t("settingsPage.agentConfig.styleRules.pickAppsFailed")}
              </p>
              <Button type="button" variant="ghost" size="sm" onClick={handleAddRule}>
                {t("settingsPage.agentConfig.styleRules.manualAdd")}
              </Button>
            </div>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title={t("settingsPage.dictionary.title")}
        description={t("settingsPage.dictionary.description")}
      >
        {dictionaryManager}
      </SectionCard>
    </div>
  );
}
