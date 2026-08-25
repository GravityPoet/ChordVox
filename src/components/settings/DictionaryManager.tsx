import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsPanel, SettingsPanelRow, SectionHeader, SubsectionHeader } from "./shared";
import { useTranscriptions } from "../../stores/transcriptionStore";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { getDictionarySuggestions } from "../../utils/dictionarySuggestions";
import { useToast } from "../ui/toastContext";

const SUGGESTION_HISTORY_PAGE_SIZE = 200;
const SUGGESTION_HISTORY_ENTRY_LIMIT = 400;

type ConfirmDialogOptions = {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "default" | "destructive";
  onConfirm: () => void;
  onCancel?: () => void;
};

export interface DictionaryManagerProps {
  agentName: string;
  customDictionary: string[];
  newDictionaryWord: string;
  setNewDictionaryWord: (value: string) => void;
  setCustomDictionary: (words: string[]) => Promise<boolean> | boolean | void;
  handleAddDictionaryWord: () => Promise<void> | void;
  handleRemoveDictionaryWord: (word: string) => Promise<void> | void;
  showConfirmDialog: (dialog: ConfirmDialogOptions) => void;
  showPageHeader?: boolean;
  embedded?: boolean;
}

export function DictionaryManager({
  agentName,
  customDictionary,
  newDictionaryWord,
  setNewDictionaryWord,
  setCustomDictionary,
  handleAddDictionaryWord,
  handleRemoveDictionaryWord,
  showConfirmDialog,
  showPageHeader = false,
  embedded = false,
}: DictionaryManagerProps) {
  const { t } = useTranslation();
  const { toast } = useToast();

  const transcriptions = useTranscriptions();
  const [ignoredWords, setIgnoredWords] = useLocalStorage<string[]>(
    "dictionarySuggestionIgnored",
    []
  );

  const recentTexts = useMemo(() => transcriptions.map((item) => item.text), [transcriptions]);
  const [suggestionHistoryTexts, setSuggestionHistoryTexts] = useState<string[] | null>(null);
  const [isLoadingSuggestionHistory, setIsLoadingSuggestionHistory] = useState(false);
  const [suggestionHistoryFailed, setSuggestionHistoryFailed] = useState(false);

  useEffect(() => {
    const queryHistory = window.electronAPI?.queryTranscriptionHistory;
    if (!queryHistory) {
      return;
    }

    let disposed = false;
    const loadSuggestionHistory = async () => {
      setIsLoadingSuggestionHistory(true);
      setSuggestionHistoryFailed(false);
      const collectedTexts: string[] = [];
      let nextCursor: string | null = null;
      try {
        while (!disposed && collectedTexts.length < SUGGESTION_HISTORY_ENTRY_LIMIT) {
          const remaining = SUGGESTION_HISTORY_ENTRY_LIMIT - collectedTexts.length;
          const result = await queryHistory({
            requestKey: "dictionary-suggestions",
            limit: Math.min(SUGGESTION_HISTORY_PAGE_SIZE, remaining),
            cursor: nextCursor,
          });
          if (disposed || result?.cancelled) {
            return;
          }
          if (result?.error) {
            throw new Error(result.error);
          }

          const page = result?.items || [];
          for (const item of page) {
            if (item?.text) {
              collectedTexts.push(item.text);
            }
          }
          if (!result?.hasMore || collectedTexts.length >= SUGGESTION_HISTORY_ENTRY_LIMIT) {
            setSuggestionHistoryTexts(collectedTexts);
            return;
          }
          if (page.length === 0) {
            throw new Error("History paging stopped before all records were loaded");
          }
          nextCursor = result?.nextCursor || null;
          if (!nextCursor) {
            throw new Error("History paging stopped before all records were loaded");
          }
        }
      } catch (error) {
        if (!disposed) {
          console.error("Failed to load full history for dictionary suggestions:", error);
          setSuggestionHistoryFailed(true);
        }
      } finally {
        if (!disposed) {
          setIsLoadingSuggestionHistory(false);
        }
      }
    };

    void loadSuggestionHistory();
    return () => {
      disposed = true;
    };
  }, []);

  const texts = suggestionHistoryTexts ?? recentTexts;

  const suggestions = useMemo(() => {
    return getDictionarySuggestions(texts, customDictionary, ignoredWords);
  }, [texts, customDictionary, ignoredWords]);

  const persistDictionary = useCallback(
    async (words: string[]) => {
      const result = await setCustomDictionary(words);
      if (result === false) {
        toast({
          title: t("settingsPage.dictionary.syncFailedTitle"),
          description: t("settingsPage.dictionary.syncFailedDescription"),
          variant: "destructive",
        });
        return false;
      }
      return true;
    },
    [setCustomDictionary, t, toast]
  );

  const trimmedInput = newDictionaryWord.trim();
  const isDuplicate = useMemo(() => {
    if (!trimmedInput) return false;
    const lower = trimmedInput.toLowerCase();
    return customDictionary.some((w) => w.toLowerCase() === lower);
  }, [trimmedInput, customDictionary]);

  return (
    <div className={embedded ? "space-y-4" : "space-y-5"}>
      {showPageHeader && (
        <SectionHeader
          title={t("settingsPage.dictionary.title")}
          description={t("settingsPage.dictionary.description")}
        />
      )}

      <div>
        {!showPageHeader && !embedded && (
          <SectionHeader
            title={t("settingsPage.dictionary.title")}
            description={t("settingsPage.dictionary.description")}
          />
        )}

        <SettingsPanel>
          <SettingsPanelRow>
            <div className="space-y-2">
              <p className="text-[14px] font-semibold text-foreground tracking-tight">
                {t("settingsPage.dictionary.addWordOrPhrase")}
              </p>
              <div className="flex gap-2">
                <Input
                  name="dictionaryEntry"
                  autoComplete="off"
                  placeholder={t("settingsPage.dictionary.placeholder")}
                  aria-label={t("settingsPage.dictionary.addWordOrPhrase")}
                  value={newDictionaryWord}
                  onChange={(e) => setNewDictionaryWord(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !isDuplicate) {
                      handleAddDictionaryWord();
                    }
                  }}
                  aria-invalid={isDuplicate}
                  aria-describedby="dictionary-add-hint"
                  className={`flex-1 h-8 text-[14px] ${isDuplicate ? "border-warning focus-visible:ring-warning/40" : ""}`}
                />
                <Button
                  onClick={handleAddDictionaryWord}
                  disabled={!trimmedInput || isDuplicate}
                  size="sm"
                  className="h-8"
                >
                  {t("settingsPage.dictionary.add")}
                </Button>
              </div>
              <p
                id="dictionary-add-hint"
                aria-live="polite"
                className={`text-[13px] ${isDuplicate ? "text-warning" : "text-muted-foreground/70"}`}
              >
                {isDuplicate
                  ? t("settingsPage.dictionary.duplicateWord", {
                      defaultValue: "“{{word}}” already exists in dictionary.",
                      word: trimmedInput,
                    })
                  : t("settingsPage.dictionary.pressEnterToAdd")}
              </p>
            </div>
          </SettingsPanelRow>
        </SettingsPanel>
      </div>

      {isLoadingSuggestionHistory ? (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground" role="status">
          <Loader2 size={12} className="animate-spin" />
          {t("settingsPage.dictionary.loadingSuggestionHistory")}
        </div>
      ) : null}
      {suggestionHistoryFailed ? (
        <p className="text-[12px] text-warning" role="status">
          {t("settingsPage.dictionary.suggestionHistoryLoadFailed")}
        </p>
      ) : null}

      {suggestions.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[14px] font-semibold text-foreground tracking-tight">
              {t("settingsPage.dictionary.suggestionsTitle")}
            </p>
            {ignoredWords.length > 0 && (
              <button
                type="button"
                onClick={() => setIgnoredWords([])}
                className="text-[12px] text-muted-foreground/60 hover:text-foreground transition-colors focus:outline-none focus:ring-1 focus:ring-primary/20 rounded px-1"
              >
                {t("settingsPage.dictionary.resetIgnored")}
              </button>
            )}
          </div>
          <SettingsPanel>
            <SettingsPanelRow>
              <div className="flex flex-wrap gap-2">
                {suggestions.map((word) => (
                  <span
                    key={word}
                    className="inline-flex items-center gap-1 bg-primary/5 hover:bg-primary/10 border border-primary/20 rounded-md pl-2.5 pr-1.5 py-1 text-[13px] text-foreground transition-all"
                  >
                    <span className="font-medium">{word}</span>
                    <button
                      type="button"
                      onClick={() => {
                        void persistDictionary([...customDictionary, word]);
                      }}
                      className="ml-1 p-0.5 rounded text-primary hover:bg-primary hover:text-primary-foreground transition-colors cursor-pointer"
                      title={t("settingsPage.dictionary.addToDictionary")}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <line x1="12" y1="5" x2="12" y2="19"></line>
                        <line x1="5" y1="12" x2="19" y2="12"></line>
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIgnoredWords([...ignoredWords, word]);
                      }}
                      className="p-0.5 rounded text-muted-foreground/75 hover:text-destructive hover:bg-destructive/10 transition-colors cursor-pointer"
                      title={t("settingsPage.dictionary.ignoreSuggestion")}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                      </svg>
                    </button>
                  </span>
                ))}
              </div>
            </SettingsPanelRow>
          </SettingsPanel>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-[14px] font-semibold text-foreground tracking-tight">
            {t("settingsPage.dictionary.yourWords")}
            {customDictionary.length > 0 && (
              <span className="ml-1.5 text-muted-foreground/70 font-normal text-[13px]">
                {customDictionary.length}
              </span>
            )}
          </p>
          {customDictionary.length > 0 && (
            <button
              onClick={() => {
                showConfirmDialog({
                  title: t("settingsPage.dictionary.clearDictionaryTitle"),
                  description: t("settingsPage.dictionary.clearDictionaryDescription"),
                  confirmText: t("settingsPage.dictionary.clearAll"),
                  variant: "destructive",
                  onConfirm: () =>
                    void persistDictionary(customDictionary.filter((w) => w === agentName)),
                });
              }}
              className="text-[13px] text-muted-foreground/70 hover:text-destructive transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-ring)] rounded-sm"
            >
              {t("settingsPage.dictionary.clearAll")}
            </button>
          )}
        </div>

        {customDictionary.length > 0 ? (
          <SettingsPanel>
            <SettingsPanelRow>
              <div className="flex flex-wrap gap-1">
                {customDictionary.map((word) => {
                  const isAgentName = word === agentName;
                  return (
                    <span
                      key={word}
                      className={`group inline-flex items-center gap-0.5 py-0.5 rounded-[5px] text-[13px] border transition-all ${
                        isAgentName
                          ? "glass-chip glass-chip--accent pl-2 pr-2 text-primary"
                          : "pl-2 pr-1 bg-surface-3 text-foreground border-border/30 hover:border-destructive/40 hover:bg-destructive/8"
                      }`}
                      title={
                        isAgentName ? t("settingsPage.dictionary.agentNameAutoManaged") : undefined
                      }
                    >
                      {word}
                      {!isAgentName && (
                        <button
                          onClick={() => handleRemoveDictionaryWord(word)}
                          className="ml-0.5 p-0.5 rounded-sm text-muted-foreground/70 hover:text-destructive transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-ring)]"
                          title={t("settingsPage.dictionary.removeWord")}
                          aria-label={t("settingsPage.dictionary.removeWordAria", {
                            defaultValue: "Remove “{{word}}”",
                            word,
                          })}
                        >
                          <svg
                            width="11"
                            height="11"
                            aria-hidden="true"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                          >
                            <path d="M18 6L6 18M6 6l12 12" />
                          </svg>
                        </button>
                      )}
                    </span>
                  );
                })}
              </div>
            </SettingsPanelRow>
          </SettingsPanel>
        ) : (
          <div className="rounded-lg border border-dashed border-border py-6 flex flex-col items-center justify-center text-center gap-2 px-4">
            <p className="text-[14px] font-medium text-muted-foreground/80">
              {t("settingsPage.dictionary.noWords")}
            </p>
            <p className="text-[13px] text-muted-foreground/70">
              {t("settingsPage.dictionary.wordsAppearHere")}
            </p>
            <p className="text-[13px] text-muted-foreground/60 mt-1">
              {t("settingsPage.dictionary.examplesHint", {
                defaultValue:
                  "Try words like “ChordVox”, “Anthropic”, your project codename, or technical jargon.",
              })}
            </p>
          </div>
        )}
      </div>

      <div>
        <SubsectionHeader title={t("settingsPage.dictionary.howItWorksTitle")} />
        <SettingsPanel>
          <SettingsPanelRow>
            <p className="text-[14px] text-muted-foreground leading-relaxed">
              {t("settingsPage.dictionary.howItWorksDescription")}
            </p>
          </SettingsPanelRow>
          <SettingsPanelRow>
            <p className="text-[14px] text-muted-foreground leading-relaxed">
              <span className="font-medium text-foreground">
                {t("settingsPage.dictionary.tipLabel")}
              </span>{" "}
              {t("settingsPage.dictionary.tipDescription")}
            </p>
          </SettingsPanelRow>
        </SettingsPanel>
      </div>
    </div>
  );
}
