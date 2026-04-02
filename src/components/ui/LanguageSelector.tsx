import React, { useState, useRef, useEffect, useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { ChevronDown, Search, X, Check } from "lucide-react";
import registry from "../../config/languageRegistry.json";

export interface LanguageOption {
  value: string;
  label: string;
  subtitle?: string;
  flag: string;
}

const REGISTRY_OPTIONS: LanguageOption[] = registry.languages.map(({ code, label, flag }) => ({
  value: code,
  label,
  flag,
}));

interface LanguageSelectorProps {
  value: string;
  onChange: (value: string) => void;
  options?: LanguageOption[];
  className?: string;
  variant?: "default" | "onboarding";
}

const SEARCH_THRESHOLD = 12;
const DROPDOWN_GAP = 4;
const DROPDOWN_MARGIN = 16;
const MIN_LIST_HEIGHT = 120;

type DropdownSide = "top" | "bottom";

export default function LanguageSelector({
  value,
  onChange,
  options,
  className = "",
  variant = "default",
}: LanguageSelectorProps) {
  const { t } = useTranslation();
  const items = options ?? REGISTRY_OPTIONS;
  const showSearch = items.length > SEARCH_THRESHOLD;
  const isOnboardingVariant = variant === "onboarding";
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [dropdownPosition, setDropdownPosition] = useState({
    top: 0,
    left: 0,
    width: 0,
    side: "bottom" as DropdownSide,
    maxListHeight: isOnboardingVariant ? 320 : 192,
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const filteredLanguages = showSearch
    ? items.filter(
        (lang) =>
          lang.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
          lang.value.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : items;

  useEffect(() => {
    setHighlightedIndex(0);
  }, [searchQuery]);

  // Determine the portal container: use the closest dialog if inside one (to stay
  // within Radix's focus trap), otherwise fall back to document.body.
  const portalTarget = useRef<HTMLElement>(document.body);

  useEffect(() => {
    if (containerRef.current) {
      const dialog = containerRef.current.closest('[role="dialog"]');
      portalTarget.current = (dialog as HTMLElement) ?? document.body;
    }
  }, []);

  useLayoutEffect(() => {
    if (isOpen && triggerRef.current) {
      const updateDropdownPosition = () => {
        if (!triggerRef.current) {
          return;
        }

        const triggerRect = triggerRef.current.getBoundingClientRect();
        const target = portalTarget.current;
        const targetRect =
          target === document.body
            ? {
                left: 0,
                top: 0,
                width: window.innerWidth,
                height: window.innerHeight,
              }
            : target.getBoundingClientRect();

        // When portaled into a transformed ancestor (e.g. Radix Dialog),
        // fixed positioning is relative to that ancestor, not the viewport.
        const offsetX = target === document.body ? 0 : targetRect.left;
        const offsetY = target === document.body ? 0 : targetRect.top;
        const localTriggerTop = triggerRect.top - offsetY;
        const localTriggerBottom = triggerRect.bottom - offsetY;
        const availableBelow =
          targetRect.height - localTriggerBottom - DROPDOWN_GAP - DROPDOWN_MARGIN;
        const availableAbove = localTriggerTop - DROPDOWN_GAP - DROPDOWN_MARGIN;
        const preferredListHeight = isOnboardingVariant ? 320 : 192;
        const searchHeight = showSearch ? (isOnboardingVariant ? 56 : 42) : 0;
        const chromeHeight = 18;
        const desiredHeight = preferredListHeight + searchHeight + chromeHeight;
        const side: DropdownSide =
          availableBelow >= desiredHeight || availableBelow >= availableAbove ? "bottom" : "top";
        const availableOnChosenSide = Math.max(
          MIN_LIST_HEIGHT,
          side === "bottom" ? availableBelow : availableAbove
        );
        const maxListHeight = Math.max(
          MIN_LIST_HEIGHT,
          Math.min(preferredListHeight, availableOnChosenSide - searchHeight - chromeHeight)
        );
        const totalHeight = maxListHeight + searchHeight + chromeHeight;
        const top =
          side === "bottom"
            ? Math.min(
                localTriggerBottom + DROPDOWN_GAP,
                targetRect.height - totalHeight - DROPDOWN_MARGIN
              )
            : Math.max(
                DROPDOWN_MARGIN,
                localTriggerTop - totalHeight - DROPDOWN_GAP
              );

        setDropdownPosition({
          top,
          left: triggerRect.left - offsetX,
          width: triggerRect.width,
          side,
          maxListHeight,
        });
      };

      updateDropdownPosition();
      requestAnimationFrame(() => {
        updateDropdownPosition();
        searchInputRef.current?.focus();
      });

      window.addEventListener("resize", updateDropdownPosition);
      document.addEventListener("scroll", updateDropdownPosition, true);
      return () => {
        window.removeEventListener("resize", updateDropdownPosition);
        document.removeEventListener("scroll", updateDropdownPosition, true);
      };
    }
  }, [isOpen, isOnboardingVariant, showSearch]);
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        (!dropdownRef.current || !dropdownRef.current.contains(target))
      ) {
        setIsOpen(false);
        setSearchQuery("");
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setIsOpen(true);
      }
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlightedIndex((prev) => (prev < filteredLanguages.length - 1 ? prev + 1 : 0));
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : filteredLanguages.length - 1));
        break;
      case "Enter":
        e.preventDefault();
        if (filteredLanguages[highlightedIndex]) {
          handleSelect(filteredLanguages[highlightedIndex].value);
        }
        break;
      case "Escape":
        e.preventDefault();
        setIsOpen(false);
        setSearchQuery("");
        break;
    }
  };

  const handleSelect = (languageValue: string) => {
    onChange(languageValue);
    setIsOpen(false);
    setSearchQuery("");
  };

  const clearSearch = () => {
    setSearchQuery("");
    if (searchInputRef.current) {
      searchInputRef.current.focus();
    }
  };

  return (
    <div className={`relative ${className}`} ref={containerRef}>
      {/* Trigger button - premium, tight, tactile macOS-style */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={handleKeyDown}
        className={`
          group relative w-full flex items-center justify-between gap-2 text-left
          border shadow-sm backdrop-blur-sm
          transition-all duration-200 ease-out
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-1
          ${
            isOnboardingVariant
              ? "min-h-14 rounded-xl px-4 py-3 text-sm font-semibold"
              : "h-7 rounded px-2.5 text-xs font-medium"
          }
          ${
            isOpen
              ? "border-border-active bg-surface-2/90 shadow ring-1 ring-primary/20"
              : "border-border/70 bg-surface-1/80 hover:border-border-hover hover:bg-surface-2/70 hover:shadow active:scale-[0.985]"
          }
        `}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        {(() => {
          const selectedLanguage = items.find((l) => l.value === value);
          const selectedFlag = selectedLanguage?.flag ?? "\uD83C\uDF10";
          const selectedLabel = selectedLanguage?.label ?? value;
          const selectedSubtitle = selectedLanguage?.subtitle;

          return (
            <span className="min-w-0 flex items-center gap-3 text-foreground">
              <span className={isOnboardingVariant ? "text-xl leading-none" : "text-base leading-none"}>
                {selectedFlag}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{selectedLabel}</span>
                {isOnboardingVariant && selectedSubtitle ? (
                  <span className="mt-0.5 block truncate text-xs font-normal text-muted-foreground">
                    {selectedSubtitle}
                  </span>
                ) : null}
              </span>
            </span>
          );
        })()}
        <ChevronDown
          className={`shrink-0 text-muted-foreground transition-all duration-200 ${
            isOnboardingVariant ? "h-4 w-4" : "h-3.5 w-3.5"
          } ${
            isOpen ? "rotate-180 text-primary" : "group-hover:text-foreground"
          }`}
        />
      </button>

      {/* Dropdown - ultra-premium glassmorphic panel (rendered via portal) */}
      {isOpen &&
        createPortal(
          <div
            ref={dropdownRef}
            style={{
              position: "fixed",
              top: `${dropdownPosition.top}px`,
              left: `${dropdownPosition.left}px`,
              width: `${dropdownPosition.width}px`,
            }}
            className={`
              z-9999 overflow-hidden rounded border border-border/70 bg-popover/95 shadow-xl backdrop-blur-xl
              transition-transform duration-150 ease-out
              ${dropdownPosition.side === "top" ? "origin-bottom translate-y-0" : "origin-top translate-y-0"}
            `}
          >
            {showSearch && (
              <div
                className={`border-b border-border/50 ${isOnboardingVariant ? "px-3 pb-2 pt-3" : "px-2 pb-1.5 pt-2"}`}
              >
                <div className="relative">
                  <Search
                    className={`absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none ${
                      isOnboardingVariant ? "h-3.5 w-3.5" : "h-3 w-3"
                    }`}
                  />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={t("languageSelector.searchPlaceholder")}
                    className={`w-full bg-transparent text-foreground border-0 focus:outline-none placeholder:text-muted-foreground/50 ${
                      isOnboardingVariant ? "h-9 pl-8 pr-7 text-sm" : "h-7 pl-7 pr-6 text-xs"
                    }`}
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={clearSearch}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors rounded p-0.5 hover:bg-muted/50"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Language list - tight, premium with smart scrollbar */}
            <div
              className="overflow-y-auto px-1 pb-1 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-border"
              style={{ maxHeight: `${dropdownPosition.maxListHeight}px` }}
            >
              {filteredLanguages.length === 0 ? (
                <div className="px-2.5 py-2 text-xs text-muted-foreground">
                  {t("languageSelector.noLanguagesFound")}
                </div>
              ) : (
                <div role="listbox" className="space-y-0.5 pt-1">
                  {filteredLanguages.map((language, index) => {
                    const isSelected = language.value === value;
                    const isHighlighted = index === highlightedIndex;

                    return (
                      <button
                        key={language.value}
                        type="button"
                        onClick={() => handleSelect(language.value)}
                        className={`
                          group w-full flex items-center justify-between gap-2
                          text-left transition-all duration-150 ease-out
                          ${
                            isOnboardingVariant
                              ? "min-h-14 rounded-xl px-3 py-3 text-sm"
                              : "h-7 rounded px-2.5 text-xs font-medium"
                          }
                          ${
                            isSelected
                              ? "bg-primary/15 text-primary shadow-sm"
                              : isHighlighted
                                ? "bg-muted/70 text-foreground"
                                : "text-foreground hover:bg-muted/50 active:scale-[0.98]"
                          }
                        `}
                        role="option"
                        aria-selected={isSelected}
                      >
                        <span className="min-w-0 flex items-center gap-3">
                          <span
                            className={isOnboardingVariant ? "text-xl leading-none" : "text-base leading-none"}
                          >
                            {language.flag}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{language.label}</span>
                            {isOnboardingVariant && language.subtitle ? (
                              <span
                                className={`mt-0.5 block truncate text-xs ${
                                  isSelected ? "text-primary/80" : "text-muted-foreground"
                                }`}
                              >
                                {language.subtitle}
                              </span>
                            ) : null}
                          </span>
                        </span>
                        {isSelected && <Check className="w-3 h-3 shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>,
          portalTarget.current
        )}
    </div>
  );
}
