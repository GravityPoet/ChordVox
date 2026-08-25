import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import { Copy, Trash2, ChevronDown, ChevronUp, Star, Sparkles, Loader2 } from "lucide-react";
import type { TranscriptionItem as TranscriptionItemType } from "../../types/electron";
import { cn } from "../lib/utils";

interface TranscriptionItemProps {
  item: TranscriptionItemType;
  index: number;
  total: number;
  isSelected?: boolean;
  onCopy: (text: string) => void;
  onDelete: (id: number) => void;
  onSelectChange?: (id: number, selected: boolean) => void;
  onPolish?: (item: TranscriptionItemType) => Promise<void>;
  onFavoriteChange?: (item: TranscriptionItemType, favorite: boolean) => Promise<boolean>;
}

const TEXT_PREVIEW_LENGTH = 120;

export default function TranscriptionItem({
  item,
  index,
  total,
  isSelected = false,
  onCopy,
  onDelete,
  onSelectChange,
  onPolish,
  onFavoriteChange,
}: TranscriptionItemProps) {
  const { i18n, t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isPolishing, setIsPolishing] = useState(false);
  const [isUpdatingFavorite, setIsUpdatingFavorite] = useState(false);

  const isStarred = item.favorite === 1;

  const handleToggleStar = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onFavoriteChange || isUpdatingFavorite) {
      return;
    }
    setIsUpdatingFavorite(true);
    try {
      const updated = await onFavoriteChange(item, !isStarred);
      if (!updated) {
        console.warn("Favorite update was not applied for transcription:", item.id);
      }
    } catch (error) {
      console.error("Failed to update transcription favorite:", error);
    } finally {
      setIsUpdatingFavorite(false);
    }
  };

  const handlePolish = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onPolish) return;
    setIsPolishing(true);
    try {
      await onPolish(item);
    } catch (err) {
      console.error("Failed to polish transcription:", err);
    } finally {
      setIsPolishing(false);
    }
  };

  const timestampSource = item.timestamp.endsWith("Z") ? item.timestamp : `${item.timestamp}Z`;
  const timestampDate = new Date(timestampSource);
  const formattedTimestamp = Number.isNaN(timestampDate.getTime())
    ? item.timestamp
    : timestampDate.toLocaleString(i18n.language, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

  const isLongText = item.text.length > TEXT_PREVIEW_LENGTH;
  const displayText =
    isExpanded || !isLongText ? item.text : `${item.text.slice(0, TEXT_PREVIEW_LENGTH)}…`;

  return (
    <div
      className={cn(
        "group relative px-3 py-2.5 transition-colors duration-150 hover:bg-muted/30",
        isSelected && "bg-primary/5 hover:bg-primary/10"
      )}
      style={{ contentVisibility: "auto", containIntrinsicSize: "0 84px" }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={(event) => onSelectChange?.(item.id, event.target.checked)}
            onClick={(event) => event.stopPropagation()}
            aria-label={
              isSelected
                ? t("controlPanel.history.deselectRecordAria")
                : t("controlPanel.history.selectRecordAria")
            }
            className="h-4 w-4 rounded border-border/70 bg-background/70 accent-[var(--color-primary)] focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>

        {/* Number badge - compact pill */}
        <div className="flex-shrink-0 mt-0.5">
          <span className="glass-chip glass-chip--accent inline-flex min-h-5 min-w-[28px] items-center justify-center rounded-sm px-1.5 text-[10px] font-semibold tabular-nums text-primary">
            {total - index}
          </span>
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Text */}
          <p
            className={cn(
              "text-foreground text-[13px] leading-[1.5] break-words",
              !isExpanded && isLongText && "line-clamp-2"
            )}
          >
            {displayText}
          </p>

          {/* Metadata row */}
          <div className="flex items-center gap-2 mt-1">
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {formattedTimestamp}
            </span>
            {isLongText && (
              <button
                onClick={() => setIsExpanded(!isExpanded)}
                aria-expanded={isExpanded}
                className="inline-flex items-center gap-0.5 text-[11px] text-primary/80 hover:text-primary transition-colors"
              >
                {isExpanded ? (
                  <>
                    <span>{t("common.less")}</span>
                    <ChevronUp size={12} />
                  </>
                ) : (
                  <>
                    <span>{t("common.more")}</span>
                    <ChevronDown size={12} />
                  </>
                )}
              </button>
            )}
          </div>
        </div>

        {/* Actions - fade in on hover */}
        <div
          className={cn(
            "flex items-center gap-0.5 flex-shrink-0 transition-opacity duration-150",
            isHovered ? "opacity-100" : "opacity-0 group-focus-within:opacity-100"
          )}
        >
          {onPolish && (
            <Button
              size="icon"
              variant="ghost"
              disabled={isPolishing}
              onClick={handlePolish}
              aria-label={t("controlPanel.history.rePolishRecordAria")}
              title={t("controlPanel.history.rePolishRecordAria")}
              className="h-6 w-6 rounded-sm text-muted-foreground hover:text-foreground hover:bg-foreground/10"
            >
              {isPolishing ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Sparkles size={12} />
              )}
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            onClick={handleToggleStar}
            disabled={isUpdatingFavorite}
            aria-label={t("controlPanel.history.favoriteRecordAria")}
            title={t("controlPanel.history.favoriteRecordAria")}
            className={cn(
              "h-6 w-6 rounded-sm",
              isStarred
                ? "text-yellow-500 hover:text-yellow-600 hover:bg-yellow-500/10"
                : "text-muted-foreground hover:text-foreground hover:bg-foreground/10"
            )}
          >
            {isUpdatingFavorite ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Star size={12} fill={isStarred ? "currentColor" : "none"} />
            )}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => onCopy(item.text)}
            aria-label={t("controlPanel.history.copyRecordAria")}
            title={t("controlPanel.history.copyRecordAria")}
            className="h-6 w-6 rounded-sm text-muted-foreground hover:text-foreground hover:bg-foreground/10"
          >
            <Copy size={12} />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => onDelete(item.id)}
            aria-label={t("controlPanel.history.deleteRecordAria")}
            title={t("controlPanel.history.deleteRecordAria")}
            className="h-6 w-6 rounded-sm text-muted-foreground hover:text-destructive hover:bg-destructive/10"
          >
            <Trash2 size={12} />
          </Button>
        </div>
      </div>
    </div>
  );
}
