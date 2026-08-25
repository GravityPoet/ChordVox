import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Keyboard,
  Languages,
  Loader2,
  LockKeyhole,
  MessageCircle,
  Mic,
  Pencil,
  Plus,
  Save,
  Sparkles,
  Trash2,
} from "lucide-react";
import type {
  HotkeyWorkflow,
  HotkeyWorkflowAction,
  SecondaryHotkeyProfile,
} from "../../hooks/useSettings";
import type { ConfirmDialogState } from "../../hooks/useDialogs";
import { formatHotkeyLabel } from "../../utils/hotkeys";
import { getPlatform } from "../../utils/platform";
import { Button } from "../ui/button";
import { HotkeyInput } from "../ui/HotkeyInput";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { ActivationModeSelector } from "../ui/ActivationModeSelector";
import { cn } from "../lib/utils";
import { SectionCard } from "./shared";
import { formatSecondaryProfileSummary } from "./utils";

const WORKFLOW_HOTKEY_SUGGESTIONS = {
  darwin: ["Control+Shift+K", "Command+Shift+7", "Command+Shift+8", "Alt+F7"],
  win32: ["Control+Shift+K", "Control+Shift+7", "Control+Shift+8", "Alt+F7"],
  linux: ["Control+Shift+K", "Control+Shift+7", "Control+Shift+8", "Alt+R"],
} as const;

const TARGET_LANGUAGES = [
  { value: "en", label: "English" },
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-TW", label: "繁體中文" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
] as const;
const WORKFLOW_EDITOR_DRAFT_KEY = "chordvox:hotkey-workflow-editor-draft";
const MAX_VISIBLE_HOTKEY_WORKFLOWS = 12;

function readWorkflowEditorDraft(): HotkeyWorkflow | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(WORKFLOW_EDITOR_DRAFT_KEY) || "null");
    if (!parsed || typeof parsed !== "object") return null;
    if (!/^(secondary|workflow-[a-z0-9-]{1,72})$/i.test(String(parsed.id || ""))) return null;
    if (!parsed.profile || typeof parsed.profile !== "object") return null;
    if (!["dictate", "translate", "polish", "chat"].includes(parsed.action)) return null;
    return parsed as HotkeyWorkflow;
  } catch {
    return null;
  }
}

type AvailabilityStatus =
  | { state: "idle" }
  | { state: "checking" }
  | {
      state: "result";
      reason:
        | "free"
        | "owned_by_app"
        | "in_use_by_other_app"
        | "native_listener"
        | "invalid"
        | "error";
      available: boolean;
    };

function useHotkeyAvailability(hotkey: string): AvailabilityStatus {
  const [status, setStatus] = useState<AvailabilityStatus>({ state: "idle" });

  useEffect(() => {
    if (!hotkey || typeof window.electronAPI?.checkHotkeyAvailability !== "function") {
      setStatus({ state: "idle" });
      return undefined;
    }

    let cancelled = false;
    setStatus({ state: "checking" });
    const timer = window.setTimeout(async () => {
      try {
        const result = await window.electronAPI?.checkHotkeyAvailability?.(hotkey);
        if (!cancelled && result) {
          setStatus({ state: "result", reason: result.reason, available: result.available });
        }
      } catch {
        if (!cancelled) setStatus({ state: "result", reason: "error", available: false });
      }
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [hotkey]);

  return status;
}

function HotkeyAvailabilityHint({ hotkey }: { hotkey: string }) {
  const { t } = useTranslation();
  const status = useHotkeyAvailability(hotkey);
  if (status.state === "idle" || (status.state === "result" && status.reason === "error")) {
    return null;
  }
  if (status.state === "checking") {
    return (
      <p className="mt-1.5 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("settingsPage.general.hotkey.availability.checking")}
      </p>
    );
  }

  const error = status.reason === "in_use_by_other_app" || status.reason === "invalid";
  const key =
    status.reason === "owned_by_app"
      ? "owned"
      : status.reason === "native_listener"
        ? "native"
        : status.reason === "in_use_by_other_app"
          ? "conflict"
          : status.reason === "invalid"
            ? "invalid"
            : "free";
  return (
    <p
      className={cn(
        "mt-1.5 inline-flex items-center gap-1.5 text-[13px]",
        error ? "text-destructive" : "text-success"
      )}
    >
      {error ? <AlertTriangle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
      {t(`settingsPage.general.hotkey.availability.${key}`)}
    </p>
  );
}

function createWorkflowId(): string {
  return `workflow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function withActionProfile(
  profile: SecondaryHotkeyProfile,
  action: HotkeyWorkflowAction
): SecondaryHotkeyProfile {
  return {
    ...profile,
    useReasoningModel: action !== "dictate",
  };
}

export interface HotkeysSectionProps {
  dictationKey: string;
  onPrimaryHotkeyChange: (newHotkey: string) => Promise<unknown>;
  isPrimaryHotkeyRegistering: boolean;
  validatePrimaryHotkey: (hotkey: string) => string | null | undefined;
  workflows: HotkeyWorkflow[];
  currentProfile: SecondaryHotkeyProfile;
  onSaveWorkflows: (workflows: HotkeyWorkflow[]) => Promise<boolean>;
  isSavingWorkflows: boolean;
  validateWorkflowHotkey: (hotkey: string) => string | null | undefined;
  isWorkflowFeatureLocked: boolean;
  trialOfferAvailable: boolean;
  onUnlockWorkflows: () => Promise<unknown>;
  onOpenTranscriptionSettings: () => void;
  onOpenAiModelsSettings: () => void;
  isUsingGnomeHotkeys: boolean;
  activationMode: "tap" | "push";
  setActivationMode: (mode: "tap" | "push") => void;
  showConfirmDialog: (options: Omit<ConfirmDialogState, "open">) => void;
}

export function HotkeysSection({
  dictationKey,
  onPrimaryHotkeyChange,
  isPrimaryHotkeyRegistering,
  validatePrimaryHotkey,
  workflows,
  currentProfile,
  onSaveWorkflows,
  isSavingWorkflows,
  validateWorkflowHotkey,
  isWorkflowFeatureLocked,
  trialOfferAvailable,
  onUnlockWorkflows,
  onOpenTranscriptionSettings,
  onOpenAiModelsSettings,
  isUsingGnomeHotkeys,
  activationMode,
  setActivationMode,
  showConfirmDialog,
}: HotkeysSectionProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<HotkeyWorkflow | null>(readWorkflowEditorDraft);
  useEffect(() => {
    if (draft) {
      sessionStorage.setItem(WORKFLOW_EDITOR_DRAFT_KEY, JSON.stringify(draft));
    } else {
      sessionStorage.removeItem(WORKFLOW_EDITOR_DRAFT_KEY);
    }
  }, [draft]);
  const actionOptions = useMemo(
    () => [
      {
        value: "dictate" as const,
        icon: Mic,
        title: t("settingsPage.general.hotkey.secondary.actions.dictate.title"),
        description: t("settingsPage.general.hotkey.secondary.actions.dictate.description"),
      },
      {
        value: "translate" as const,
        icon: Languages,
        title: t("settingsPage.general.hotkey.secondary.actions.translate.title"),
        description: t("settingsPage.general.hotkey.secondary.actions.translate.description"),
      },
      {
        value: "polish" as const,
        icon: Sparkles,
        title: t("settingsPage.general.hotkey.secondary.actions.polish.title"),
        description: t("settingsPage.general.hotkey.secondary.actions.polish.description"),
      },
      {
        value: "chat" as const,
        icon: MessageCircle,
        title: t("settingsPage.general.hotkey.secondary.actions.chat.title"),
        description: t("settingsPage.general.hotkey.secondary.actions.chat.description"),
      },
    ],
    [t]
  );
  const usedHotkeys = useMemo(
    () => new Set(workflows.map((workflow) => workflow.hotkey.trim().toLowerCase())),
    [workflows]
  );
  const suggestions =
    WORKFLOW_HOTKEY_SUGGESTIONS[getPlatform()] || WORKFLOW_HOTKEY_SUGGESTIONS.linux;
  const availableSuggestions = suggestions.filter(
    (hotkey) =>
      hotkey.toLowerCase() !== dictationKey.trim().toLowerCase() &&
      (!usedHotkeys.has(hotkey.toLowerCase()) || draft?.hotkey === hotkey)
  );
  const draftValidationError = draft ? validateWorkflowHotkey(draft.hotkey) : null;
  const duplicateDraftHotkey = draft
    ? workflows.some(
        (workflow) =>
          workflow.id !== draft.id &&
          workflow.hotkey.trim().toLowerCase() === draft.hotkey.trim().toLowerCase()
      )
    : false;
  const draftNeedsAi = draft ? draft.action !== "dictate" : false;
  const draftAiModelMissing = Boolean(draftNeedsAi && !draft?.profile.reasoningModel.trim());
  const draftCanSave = Boolean(
    draft?.hotkey.trim() && !draftValidationError && !duplicateDraftHotkey && !draftAiModelMissing
  );

  const getActionOption = (action: HotkeyWorkflowAction) =>
    actionOptions.find((option) => option.value === action) || actionOptions[0];

  const startNewWorkflow = () => {
    if (workflows.length >= MAX_VISIBLE_HOTKEY_WORKFLOWS) return;
    const hotkey = availableSuggestions[0] || "";
    setDraft({
      id: createWorkflowId(),
      name: "",
      hotkey,
      action: "dictate",
      targetLanguage: "en",
      enabled: true,
      profile: withActionProfile(currentProfile, "dictate"),
    });
  };

  const saveDraft = async () => {
    if (!draft || !draftCanSave) return;
    const next = workflows.some((workflow) => workflow.id === draft.id)
      ? workflows.map((workflow) => (workflow.id === draft.id ? draft : workflow))
      : [...workflows, draft];
    if (await onSaveWorkflows(next)) setDraft(null);
  };

  const executeDeleteWorkflow = async (id: string) => {
    if (await onSaveWorkflows(workflows.filter((workflow) => workflow.id !== id))) {
      if (draft?.id === id) setDraft(null);
    }
  };

  const requestDeleteWorkflow = (workflow: HotkeyWorkflow) => {
    const option = getActionOption(workflow.action);
    showConfirmDialog({
      title: t("settingsPage.general.hotkey.secondary.deleteWorkflow"),
      description: `${workflow.name || option.title} · ${formatHotkeyLabel(workflow.hotkey)}`,
      confirmText: t("common.delete"),
      variant: "destructive",
      onConfirm: () => void executeDeleteWorkflow(workflow.id),
    });
  };

  return (
    <div className="space-y-4">
      <section className="premium-panel premium-panel--hero flow-border--subtle shimmer-on-mount aurora-full rounded-[var(--radius-xl)] px-5 py-4 sm:px-6 sm:py-5">
        <span className="border-beam" aria-hidden />
        <div className="flex items-start gap-4">
          <div className="glass-chip glass-chip--accent flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-primary">
            <Keyboard className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-[17px] font-semibold text-foreground">
              {t("settingsPage.general.hotkey.title")}
            </h2>
            <p className="mt-1.5 max-w-2xl text-[15px] leading-relaxed text-muted-foreground/85">
              {t("settingsPage.general.hotkey.description")}
            </p>
          </div>
        </div>
        <div className="mt-4">
          <HotkeyInput
            value={dictationKey}
            onChange={(hotkey) => void onPrimaryHotkeyChange(hotkey)}
            disabled={isPrimaryHotkeyRegistering}
            validate={validatePrimaryHotkey}
            captureScope="primary"
            variant="hero"
          />
          <HotkeyAvailabilityHint hotkey={dictationKey} />
        </div>
      </section>

      <SectionCard
        title={t("settingsPage.general.hotkey.secondary.workflowsTitle")}
        description={t("settingsPage.general.hotkey.secondary.workflowsDescription")}
      >
        {isWorkflowFeatureLocked ? (
          <Alert variant="warning" className="border-warning/30 bg-warning/8">
            <LockKeyhole className="h-4 w-4" />
            <AlertTitle>{t("settingsPage.general.hotkey.secondary.requiresProTitle")}</AlertTitle>
            <AlertDescription className="space-y-4">
              <p>{t("settingsPage.general.hotkey.secondary.requiresProDescription")}</p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {actionOptions.map((option) => {
                  const Icon = option.icon;
                  return (
                    <div
                      key={option.value}
                      className="rounded-md border border-warning/20 bg-background/55 p-3"
                    >
                      <Icon className="h-4 w-4 text-warning" />
                      <p className="mt-2 text-[14px] font-semibold text-foreground">
                        {option.title}
                      </p>
                      <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                        {option.description}
                      </p>
                    </div>
                  );
                })}
              </div>
              <Button size="sm" onClick={() => void onUnlockWorkflows()}>
                {trialOfferAvailable
                  ? t("settingsPage.account.trialStartDialog.confirm")
                  : t("settingsPage.account.checkout.upgradeToPro")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : draft ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h4 className="text-[15px] font-semibold text-foreground">
                  {workflows.some((workflow) => workflow.id === draft.id)
                    ? t("settingsPage.general.hotkey.secondary.editWorkflow")
                    : t("settingsPage.general.hotkey.secondary.newWorkflow")}
                </h4>
                <p className="mt-0.5 text-[13px] text-muted-foreground">
                  {t("settingsPage.general.hotkey.secondary.editorDescription")}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
                {t("settingsPage.general.hotkey.secondary.cancelEdit")}
              </Button>
            </div>

            <div>
              <p className="mb-2 text-[13px] font-semibold text-foreground">
                {t("settingsPage.general.hotkey.secondary.chooseAction")}
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {actionOptions.map((option) => {
                  const Icon = option.icon;
                  const selected = draft.action === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                action: option.value,
                                profile: withActionProfile(current.profile, option.value),
                              }
                            : current
                        )
                      }
                      className={cn(
                        "rounded-md border p-3 text-left transition-colors",
                        selected
                          ? "border-primary/40 bg-primary/10 shadow-[var(--shadow-selected-glow)]"
                          : "border-border/60 bg-background/55 hover:border-primary/25"
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <Icon
                          className={cn(
                            "h-4 w-4",
                            selected ? "text-primary" : "text-muted-foreground"
                          )}
                        />
                        <span className="text-[14px] font-semibold text-foreground">
                          {option.title}
                        </span>
                      </span>
                      <span className="mt-1.5 block text-[12px] leading-relaxed text-muted-foreground">
                        {option.description}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1.5">
                <span className="text-[13px] font-semibold text-foreground">
                  {t("settingsPage.general.hotkey.secondary.workflowName")}
                </span>
                <Input
                  value={draft.name}
                  maxLength={80}
                  placeholder={getActionOption(draft.action).title}
                  onChange={(event) =>
                    setDraft((current) =>
                      current ? { ...current, name: event.target.value } : current
                    )
                  }
                />
              </label>
              {draft.action === "translate" ? (
                <label className="space-y-1.5">
                  <span className="text-[13px] font-semibold text-foreground">
                    {t("settingsPage.general.hotkey.secondary.targetLanguage")}
                  </span>
                  <Select
                    value={draft.targetLanguage}
                    onValueChange={(targetLanguage) =>
                      setDraft((current) => (current ? { ...current, targetLanguage } : current))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TARGET_LANGUAGES.map((language) => (
                        <SelectItem key={language.value} value={language.value}>
                          {language.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              ) : null}
            </div>

            <div className="rounded-lg border border-primary/20 bg-primary/6 p-4">
              <p className="text-[13px] font-semibold text-foreground">
                {t("settingsPage.general.hotkey.secondary.shortcut")}
              </p>
              <div className="mt-2 grid gap-2 sm:grid-cols-4">
                {availableSuggestions.map((hotkey) => (
                  <Button
                    key={hotkey}
                    type="button"
                    size="sm"
                    variant={draft.hotkey === hotkey ? "default" : "outline"}
                    onClick={() =>
                      setDraft((current) => (current ? { ...current, hotkey } : current))
                    }
                  >
                    {formatHotkeyLabel(hotkey)}
                  </Button>
                ))}
              </div>
              <div className="mt-3">
                <HotkeyInput
                  value={draft.hotkey}
                  onChange={(hotkey) =>
                    setDraft((current) => (current ? { ...current, hotkey } : current))
                  }
                  validate={validateWorkflowHotkey}
                  captureScope={draft.id}
                />
                {duplicateDraftHotkey ? (
                  <p className="mt-1.5 text-[13px] text-destructive">
                    {t("settingsPage.general.hotkey.secondary.duplicateHotkey")}
                  </p>
                ) : (
                  <HotkeyAvailabilityHint hotkey={draft.hotkey} />
                )}
              </div>
            </div>

            <div className="rounded-lg border border-border/60 bg-background/55 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-[13px] font-semibold text-foreground">
                    {t("settingsPage.general.hotkey.secondary.modelsForWorkflow")}
                  </p>
                  <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                    {t("settingsPage.general.hotkey.secondary.modelsDescription")}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            profile: withActionProfile(currentProfile, current.action),
                          }
                        : current
                    )
                  }
                >
                  <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                  {t("settingsPage.general.hotkey.secondary.useCurrentModels")}
                </Button>
              </div>
              {(() => {
                const summary = formatSecondaryProfileSummary(draft.profile, t);
                return (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <div className="rounded-md border border-border/50 bg-surface-1/70 px-3 py-2.5">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                        {t("settingsPage.general.hotkey.secondary.transcriptionModel")}
                      </p>
                      <p className="mt-1 text-[13px] text-foreground">{summary.transcription}</p>
                    </div>
                    <div className="rounded-md border border-border/50 bg-surface-1/70 px-3 py-2.5">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                        {t("settingsPage.general.hotkey.secondary.reasoningModel")}
                      </p>
                      <p className="mt-1 text-[13px] text-foreground">{summary.reasoning}</p>
                    </div>
                  </div>
                );
              })()}
              {draftAiModelMissing ? (
                <p className="mt-2 flex items-center gap-1.5 text-[13px] text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {t("settingsPage.general.hotkey.secondary.aiModelRequired")}
                </p>
              ) : null}
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={onOpenTranscriptionSettings}
                >
                  <Mic className="mr-1.5 h-3.5 w-3.5" />
                  {t("settingsPage.general.hotkey.secondary.chooseTranscriptionModel")}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={onOpenAiModelsSettings}>
                  <Brain className="mr-1.5 h-3.5 w-3.5" />
                  {t("settingsPage.general.hotkey.secondary.chooseReasoningModel")}
                </Button>
              </div>
            </div>

            <Button
              type="button"
              className="w-full"
              disabled={!draftCanSave || isSavingWorkflows}
              onClick={() => void saveDraft()}
            >
              {isSavingWorkflows ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-1.5 h-4 w-4" />
              )}
              {t("settingsPage.general.hotkey.secondary.saveWorkflow")}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="glass-chip glass-chip--accent inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-primary">
                PRO · {workflows.length}
              </span>
              <Button
                size="sm"
                onClick={startNewWorkflow}
                disabled={workflows.length >= MAX_VISIBLE_HOTKEY_WORKFLOWS}
              >
                <Plus className="mr-1.5 h-4 w-4" />
                {t("settingsPage.general.hotkey.secondary.addWorkflow")}
              </Button>
            </div>

            {workflows.length === 0 ? (
              <button
                type="button"
                onClick={startNewWorkflow}
                className="flex w-full flex-col items-center rounded-lg border border-dashed border-primary/25 bg-primary/5 px-5 py-8 text-center transition-colors hover:bg-primary/8"
              >
                <Plus className="h-6 w-6 text-primary" />
                <span className="mt-2 text-[15px] font-semibold text-foreground">
                  {t("settingsPage.general.hotkey.secondary.emptyTitle")}
                </span>
                <span className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
                  {t("settingsPage.general.hotkey.secondary.emptyDescription")}
                </span>
              </button>
            ) : (
              <div className="grid gap-2">
                {workflows.map((workflow) => {
                  const option = getActionOption(workflow.action);
                  const Icon = option.icon;
                  const summary = formatSecondaryProfileSummary(workflow.profile, t);
                  return (
                    <div
                      key={workflow.id}
                      className="rounded-lg border border-border/60 bg-background/55 p-4"
                    >
                      <div className="flex items-start gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                          <Icon className="h-4 w-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-[15px] font-semibold text-foreground">
                              {workflow.name || option.title}
                            </p>
                            <span className="rounded-full border border-primary/20 bg-primary/8 px-2 py-0.5 text-[11px] font-medium text-primary">
                              {formatHotkeyLabel(workflow.hotkey)}
                            </span>
                          </div>
                          <p className="mt-1 text-[12px] text-muted-foreground">
                            {option.description}
                          </p>
                          <p className="mt-2 truncate text-[12px] text-muted-foreground/80">
                            {summary.transcription} · {summary.reasoning}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            aria-label={t("settingsPage.general.hotkey.secondary.editWorkflow")}
                            onClick={() =>
                              setDraft({ ...workflow, profile: { ...workflow.profile } })
                            }
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            aria-label={t("settingsPage.general.hotkey.secondary.deleteWorkflow")}
                            disabled={isSavingWorkflows}
                            onClick={() => requestDeleteWorkflow(workflow)}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </SectionCard>

      {!isUsingGnomeHotkeys && (
        <SectionCard title={t("settingsPage.general.hotkey.activationMode")}>
          <ActivationModeSelector
            value={activationMode}
            onChange={setActivationMode}
            variant="cards"
          />
        </SectionCard>
      )}
    </div>
  );
}
