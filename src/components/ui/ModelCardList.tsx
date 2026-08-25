import { useMemo, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Globe, Download, Trash2, X, ChevronDown, ChevronUp, Search, Check } from "lucide-react";
import { Button } from "./button";
import { Input } from "./input";
import type { ColorScheme } from "../../utils/modelPickerStyles";
import { Card } from "./card";

export interface ModelCardOption {
  value: string;
  label: string;
  description?: string;
  badge?: string;
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
  selectedLabel?: string;
  selectedTone?: "active" | "selected";
}

export default function ModelCardList({
  models,
  selectedModel,
  onModelSelect,
  colorScheme: _colorScheme = "indigo",
  className = "",
  onDownload,
  onDelete,
  onCancelDownload,
  isCancelling = false,
  enableSearch = false,
  noSearchResultsText,
  selectedLabel = "Active",
  selectedTone = "active",
}: ModelCardListProps) {
  const { t } = useTranslation();
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
              aria-label={t("languageSelector.searchPlaceholder")}
              className="h-9 pl-9 text-sm"
            />
          </div>
        )}
        <p className="text-sm text-muted-foreground py-2">
          {hasSearchQuery
            ? noSearchResultsText || t("common.noMatchingModels")
            : isLocalMode
              ? t("common.noModelsAvailableForProvider")
              : t("common.noModelsAvailable")}
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
            aria-label={t("languageSelector.searchPlaceholder")}
            className="h-9 pl-9 text-sm"
          />
        </div>
      )}
      {displayedModels.map((model) => {
        const isSelected = selectedModel === model.value;
        const isDownloaded = model.isDownloaded;
        const isDownloading = model.isDownloading;
        const showActiveSelection = selectedTone === "active";
        const canSelectModel = !isLocalMode || Boolean(isDownloaded && !isSelected);

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

        const handleCardKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
          if (!canSelectModel || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          handleCardClick();
        };

        // Apple-style status dot：实心小圆点、无外发光
        const getStatusDotClass = () => {
          if (!isLocalMode) {
            return isSelected ? "bg-primary" : "bg-muted-foreground/30";
          }
          if (isDownloaded) {
            return isSelected ? "bg-primary" : "bg-success";
          }
          if (isDownloading) {
            return "bg-warning";
          }
          return "bg-muted-foreground/25";
        };

        return (
          <Card
            key={model.value}
            onClick={handleCardClick}
            onKeyDown={handleCardKeyDown}
            role={canSelectModel ? "button" : undefined}
            tabIndex={canSelectModel ? 0 : undefined}
            aria-label={canSelectModel ? model.label : undefined}
            aria-pressed={!isLocalMode ? isSelected : undefined}
            variant={isSelected ? "selected" : "default"}
            className={`relative w-full overflow-hidden p-2 pl-2.5 text-left transition-[background-color,border-color,box-shadow,color,transform] duration-200 group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
              isSelected
                ? "border-primary/60 bg-primary/10 ring-2 ring-primary/35 shadow-[0_10px_24px_rgba(37,99,235,0.16)] dark:bg-primary/8"
                : "glass-panel glass-panel--soft glass-panel--hoverable hover:shadow-[var(--shadow-card-hover)] hover:-translate-y-px"
            } ${!isLocalMode || (isDownloaded && !isSelected) ? "cursor-pointer" : ""}`}
          >
            {/* Left accent bar for selected */}
            {isSelected && (
              <div
                className={`absolute left-0 top-0 bottom-0 w-1 rounded-l-md ${
                  showActiveSelection
                    ? "bg-linear-to-b from-primary via-primary to-primary/80"
                    : "bg-muted-foreground/40"
                }`}
              />
            )}

            <div className="flex items-center gap-1.5 min-w-0">
              {/* Status dot with LED glow */}
              <div
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${getStatusDotClass()} ${
                  isSelected && isDownloaded && showActiveSelection
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
                  width={14}
                  height={14}
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
                {model.badge && (
                  <span
                    title={model.badge}
                    className="glass-chip max-w-[12rem] truncate rounded-sm px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground shrink-0"
                  >
                    {model.badge}
                  </span>
                )}
              </div>

              {/* Recommended badge */}
              {model.recommended && (
                <span className="glass-chip glass-chip--accent rounded-sm px-1.5 py-0.5 text-[10px] font-medium text-primary shrink-0">
                  {t("common.recommended")}
                </span>
              )}

              {/* Actions - right aligned */}
              <div className="ml-auto flex items-center gap-1.5 shrink-0">
                {/* Selected/Active badge */}
                {isSelected && (
                  <span
                    className={`inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-[10px] font-medium ${
                      showActiveSelection
                        ? "glass-chip glass-chip--accent text-primary"
                        : "border border-primary/25 bg-primary/8 text-primary"
                    }`}
                  >
                    <Check className="h-3 w-3" strokeWidth={2.4} />
                    {selectedLabel}
                  </span>
                )}

                {/* Local model action buttons */}
                {isLocalMode && (
                  <>
                    {isDownloaded ? (
                      <Button
                        type="button"
                        onKeyDown={(event) => event.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete?.(model.value);
                        }}
                        aria-label={`${t("common.delete")}: ${model.label}`}
                        title={`${t("common.delete")}: ${model.label}`}
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0 text-muted-foreground/40 hover:text-destructive opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-[background-color,color,opacity,transform] active:scale-95"
                      >
                        <Trash2 size={12} aria-hidden="true" />
                      </Button>
                    ) : isDownloading ? (
                      <Button
                        type="button"
                        onKeyDown={(event) => event.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          onCancelDownload?.();
                        }}
                        disabled={isCancelling}
                        size="sm"
                        variant="outline"
                        className="h-6 px-2.5 text-[11px] text-destructive border-destructive/25 hover:bg-destructive/8"
                      >
                        <X size={11} className="mr-0.5" aria-hidden="true" />
                        {isCancelling ? `${t("common.cancel")}…` : t("common.cancel")}
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        onKeyDown={(event) => event.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          onDownload?.(model.value);
                        }}
                        size="sm"
                        variant="default"
                        className="h-6 px-2.5 text-[11px]"
                      >
                        <Download size={11} className="mr-1" />
                        {t("common.download")}
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>
          </Card>
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
