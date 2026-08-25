import { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ProviderIcon } from "./ProviderIcon";
import { Badge } from "./badge";
import type { ColorScheme as BaseColorScheme } from "../../utils/modelPickerStyles";

export interface ProviderTabItem {
  id: string;
  name: string;
  recommended?: boolean;
  subtitle?: string;
}

type ColorScheme = Exclude<BaseColorScheme, "blue"> | "dynamic";

interface ProviderTabsProps {
  providers: ProviderTabItem[];
  selectedId: string;
  onSelect: (id: string) => void;
  renderIcon?: (providerId: string) => ReactNode;
  colorScheme?: ColorScheme;
  /** Allow horizontal scrolling for many providers */
  scrollable?: boolean;
  /** Whether tabs should fill the available row, balance across rows, or hug their content */
  distribution?: "fill" | "balanced" | "content";
  /** Fixed responsive column layout for balanced rows, currently used by provider grids. */
  balancedMaxColumns?: 4;
}

export function ProviderTabs({
  providers,
  selectedId,
  onSelect,
  renderIcon,
  colorScheme = "indigo",
  scrollable = false,
  distribution = "content",
  balancedMaxColumns,
}: ProviderTabsProps) {
  const { t } = useTranslation();

  const shouldUseScrollableRow = scrollable && distribution === "content";
  const balancedFourColumnClassName =
    providers.length <= 3
      ? "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 items-stretch gap-1.5"
      : "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 items-stretch gap-1.5";
  const containerClassName =
    distribution === "fill"
      ? "grid items-stretch gap-1"
      : distribution === "balanced" && balancedMaxColumns === 4
        ? balancedFourColumnClassName
        : distribution === "balanced"
          ? "grid items-stretch gap-1.5"
          : shouldUseScrollableRow
            ? "flex min-w-full w-max items-stretch gap-1.5"
            : "flex flex-wrap items-stretch gap-1";
  const containerStyle =
    distribution === "fill"
      ? { gridTemplateColumns: `repeat(${Math.max(providers.length, 1)}, minmax(0, 1fr))` }
      : distribution === "balanced" && balancedMaxColumns === 4
        ? undefined
        : distribution === "balanced"
          ? {
              gridTemplateColumns: "repeat(auto-fit, minmax(min(11rem, 100%), 1fr))",
            }
          : undefined;

  const content = (
    <div className={containerClassName} style={containerStyle}>
      {providers.map((provider) => {
        const isSelected = selectedId === provider.id;

        return (
          <button
            key={provider.id}
            type="button"
            data-tab-button
            onClick={() => onSelect(provider.id)}
            className={`relative flex ${provider.subtitle ? "min-h-14" : "min-h-11"} min-w-0 items-center justify-center gap-2 rounded-[0.9rem] border px-3 py-2 text-[13px] font-medium transition-all duration-150 active:scale-100 ${
              distribution === "fill" || distribution === "balanced"
                ? "w-full"
                : "shrink-0 whitespace-nowrap"
            } ${
              isSelected
                ? "glass-panel glass-panel--selected border-primary/30 text-foreground shadow-[0_10px_26px_rgba(96,165,250,0.14)]"
                : "border-transparent bg-transparent text-muted-foreground hover:border-border/70 hover:bg-white/45 hover:text-foreground"
            }`}
          >
            {renderIcon ? renderIcon(provider.id) : <ProviderIcon provider={provider.id} />}
            <span
              className={`min-w-0 ${
                provider.subtitle ? "flex flex-col items-start gap-0.5 leading-tight" : "truncate"
              }`}
            >
              <span className="max-w-full truncate tracking-[-0.01em]" translate="no">
                {provider.name}
              </span>
              {provider.subtitle ? (
                <span className="max-w-full truncate rounded-[var(--radius-sm)] bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                  {provider.subtitle}
                </span>
              ) : null}
            </span>
            {provider.recommended && (
              <Badge
                variant="info"
                className="h-5 shrink-0 rounded-[var(--radius-sm)] px-1.5 py-0 text-[10px] font-semibold tracking-normal"
              >
                {t("common.recommended")}
              </Badge>
            )}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="glass-panel glass-panel--soft rounded-[1rem] p-1">
      {shouldUseScrollableRow ? (
        <div className="overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {content}
        </div>
      ) : (
        content
      )}
    </div>
  );
}
