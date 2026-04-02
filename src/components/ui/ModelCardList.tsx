import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Globe, Download, Trash2, X, ChevronDown, ChevronUp, Search } from "lucide-react";
import { Button } from "./button";
import { Input } from "./input";
import type { ColorScheme } from "../../utils/modelPickerStyles";

export interface ModelCardOption {
  value: string;
  label: string;
  description?: string;
  icon?: string;
  invertInDark?: boolean;
  // Local model properties (optional)
  isDownloaded?: boolean;
  isDownloading?: boolean;
  recommended?: boolean;
}

interface ModelCardListProps {
  models: ModelCardOption[];
  selectedModel: string;
  onModelSelect: (modelId: string) => void;
  colorScheme?: ColorScheme;
  className?: string;
  // Local model actions (optional - when provided, enables local model UI)
  onDownload?: (modelId: string) => void;
  onDelete?: (modelId: string) => void;
  onCancelDownload?: () => void;
  isCancelling?: boolean;
  enableSearch?: boolean;
  noSearchResultsText?: string;
}

const COLOR_CONFIG: Record<
  ColorScheme,
  {
    selected: string;
    default: string;
  }
> = {
  indigo: {
    selected:
      "border-primary/30 bg-primary/8 dark:bg-primary/6 dark:border-primary/20 shadow-[0_0_0_1px_oklch(0.62_0.22_260/0.12),0_0_10px_-3px_oklch(0.62_0.22_260/0.18)]",
    default:
      "border-border bg-surface-1 hover:border-border-hover hover:bg-muted dark:border-white/5 dark:bg-white/3 dark:hover:border-white/20 dark:hover:bg-white/8",
  },
  purple: {
    selected:
      "border-primary/30 bg-primary/8 dark:bg-primary/6 dark:border-primary/20 shadow-[0_0_0_1px_oklch(0.62_0.22_260/0.12),0_0_10px_-3px_oklch(0.62_0.22_260/0.18)]",
    default:
      "border-border bg-surface-1 hover:border-border-hover hover:bg-muted dark:border-white/5 dark:bg-white/3 dark:hover:border-white/20 dark:hover:bg-white/8",
  },
  blue: {
    selected:
      "border-primary/30 bg-primary/10 dark:bg-primary/6 shadow-[0_0_0_1px_oklch(0.62_0.22_260/0.15),0_0_12px_-3px_oklch(0.62_0.22_260/0.2)]",
    default:
      "border-border bg-surface-1 hover:border-border-hover hover:bg-muted dark:border-white/5 dark:bg-white/3 dark:hover:border-white/20 dark:hover:bg-white/8",
  },
};

export default function ModelCardList({
  models,
  selectedModel,
  onModelSelect,
  colorScheme = "indigo",
  className = "",
  onDownload,
  onDelete,
  onCancelDownload,
  isCancelling = false,
  enableSearch = false,
  noSearchResultsText,
}: ModelCardListProps) {
  const { t } = useTranslation();
  const styles = COLOR_CONFIG[colorScheme];
  const isLocalMode = Boolean(onDownload);
  const [expanded, setExpanded] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const COLLAPSE_LIMIT = 20;
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const hasSearchQuery = enableSearch && normalizedSearchQuery.length > 0;

  const filteredModels = useMemo(() => {
    if (!hasSearchQuery) return models;

    return models.filter((model) =>
      [model.value, model.label, model.description]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(normalizedSearchQuery))
    );
  }, [hasSearchQuery, models, normalizedSearchQuery]);

  const canCollapse = !hasSearchQuery && filteredModels.length > COLLAPSE_LIMIT;

  const displayedModels = useMemo(() => {
    if (!canCollapse || expanded) return filteredModels;

    const initialModels = filteredModels.slice(0, COLLAPSE_LIMIT);
    if (!selectedModel || initialModels.some((model) => model.value === selectedModel)) {
      return initialModels;
    }

    const selected = filteredModels.find((model) => model.value === selectedModel);
    if (!selected) return initialModels;

    return [selected, ...initialModels.slice(0, COLLAPSE_LIMIT - 1)];
  }, [canCollapse, expanded, filteredModels, selectedModel]);

  if (displayedModels.length === 0) {
    return (
      <div className={`space-y-2 ${className}`}>
        {enableSearch && (
          <div className="relative">
            <Search
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/50"
            />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("languageSelector.searchPlaceholder")}
              className="h-9 pl-9 text-sm"
            />
          </div>
        )}
        <p className="text-sm text-muted-foreground py-2">
          {hasSearchQuery
            ? noSearchResultsText || t("common.noMatchingModels")
            : isLocalMode
              ? "No models available for this provider"
              : "No models available"}
        </p>
      </div>
    );
  }

  return (
    <div className={`space-y-0.5 ${className}`}>
      {enableSearch && (
        <div className="relative pb-2">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/50"
          />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("languageSelector.searchPlaceholder")}
            className="h-9 pl-9 text-sm"
          />
        </div>
      )}
      {displayedModels.map((model) => {
        const isSelected = selectedModel === model.value;
        const isDownloaded = model.isDownloaded;
        const isDownloading = model.isDownloading;

        // For local models, click to select if downloaded
        const handleCardClick = () => {
          if (isLocalMode) {
            if (isDownloaded && !isSelected) {
              onModelSelect(model.value);
            }
          } else {
            onModelSelect(model.value);
          }
        };

        // Determine status dot color for local mode
        const getStatusDotClass = () => {
          if (!isLocalMode) {
            return isSelected
              ? "bg-primary shadow-[0_0_6px_oklch(0.62_0.22_260/0.6)]"
              : "bg-muted-foreground/30";
          }
          if (isDownloaded) {
            return isSelected
              ? "bg-primary shadow-[0_0_6px_oklch(0.62_0.22_260/0.6)]"
              : "bg-success shadow-[0_0_4px_rgba(34,197,94,0.5)]";
          }
          if (isDownloading) {
            return "bg-amber-500 shadow-[0_0_4px_rgba(245,158,11,0.5)]";
          }
          return "bg-muted-foreground/20";
        };

        return (
          <div
            key={model.value}
            onClick={handleCardClick}
            className={`relative w-full p-2 pl-2.5 rounded-md border text-left transition-all duration-200 group overflow-hidden ${
              isSelected ? styles.selected : styles.default
            } ${!isLocalMode || (isDownloaded && !isSelected) ? "cursor-pointer" : ""}`}
          >
            {/* Left accent bar for selected */}
            {isSelected && (
              <div className="absolute left-0 top-0 bottom-0 w-1 bg-linear-to-b from-primary via-primary to-primary/80 rounded-l-md" />
            )}

            <div className="flex items-center gap-1.5 min-w-0">
              {/* Status dot with LED glow */}
              <div
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${getStatusDotClass()} ${
                  isSelected && isDownloaded
                    ? "animate-[pulse-glow_2s_ease-in-out_infinite]"
                    : isDownloading
                      ? "animate-[spinner-rotate_1s_linear_infinite]"
                      : ""
                }`}
              />

              {/* Icon */}
              {model.icon ? (
                <img
                  src={model.icon}
                  alt=""
                  className={`w-3.5 h-3.5 shrink-0 ${model.invertInDark ? "icon-monochrome" : ""}`}
                  aria-hidden="true"
                />
              ) : (
                <Globe className="w-3.5 h-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              )}

              {/* Model info - keep primary label visible; truncate description first */}
              <div className="flex items-center gap-1.5 min-w-0 flex-1">
                <span
                  title={model.label}
                  className="text-sm font-semibold text-foreground tracking-tight truncate min-w-[8rem] max-w-[60%]"
                >
                  {model.label}
                </span>
                {model.description && (
                  <span
                    title={model.description}
                    className="text-[11px] text-muted-foreground/50 tabular-nums min-w-0 flex-1 truncate"
                  >
                    {model.description}
                  </span>
                )}
              </div>

              {/* Recommended badge */}
              {model.recommended && (
                <span className="text-[10px] font-medium text-primary px-1.5 py-0.5 bg-primary/10 rounded-sm shrink-0">
                  Recommended
                </span>
              )}

              {/* Actions - right aligned */}
              <div className="ml-auto flex items-center gap-1.5 shrink-0">
                {/* Selected/Active badge */}
                {isSelected && (
                  <span className="text-[10px] font-medium text-primary px-2 py-0.5 bg-primary/10 rounded-sm">
                    Active
                  </span>
                )}

                {/* Local model action buttons */}
                {isLocalMode && (
                  <>
                    {isDownloaded ? (
                      <Button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete?.(model.value);
                        }}
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0 text-muted-foreground/40 hover:text-destructive opacity-0 group-hover:opacity-100 transition-all active:scale-95"
                      >
                        <Trash2 size={12} />
                      </Button>
                    ) : isDownloading ? (
                      <Button
                        onClick={(e) => {
                          e.stopPropagation();
                          onCancelDownload?.();
                        }}
                        disabled={isCancelling}
                        size="sm"
                        variant="outline"
                        className="h-6 px-2.5 text-[11px] text-destructive border-destructive/25 hover:bg-destructive/8"
                      >
                        <X size={11} className="mr-0.5" />
                        {isCancelling ? "..." : "Cancel"}
                      </Button>
                    ) : (
                      <Button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDownload?.(model.value);
                        }}
                        size="sm"
                        variant="default"
                        className="h-6 px-2.5 text-[11px]"
                      >
                        <Download size={11} className="mr-1" />
                        Download
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {canCollapse && (
        <div className="pt-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setExpanded((prev) => !prev)}
            className="w-full text-xs"
          >
            {expanded ? (
              <>
                <ChevronUp size={14} className="mr-1" />
                {t("common.less")}
              </>
            ) : (
              <>
                <ChevronDown size={14} className="mr-1" />
                {t("common.more")} ({filteredModels.length})
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
