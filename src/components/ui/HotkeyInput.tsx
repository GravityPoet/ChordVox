import React, { useState, useCallback, useRef, useEffect, useId } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { formatHotkeyLabel } from "../../utils/hotkeys";
import { getPlatform } from "../../utils/platform";

import { MODIFIER_CODES, mapKeyboardEventToHotkey } from "./hotkeyInputUtils";

export interface HotkeyInputProps {
  value: string;
  onChange: (hotkey: string) => void;
  onBlur?: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
  validate?: (hotkey: string) => string | null | undefined;
  captureScope?: string;
}

export interface HotkeyInputVariant {
  variant?: "default" | "hero";
}

export function HotkeyInput({
  value,
  onChange,
  onBlur,
  disabled = false,
  autoFocus = false,
  variant = "default",
  validate,
  captureScope = "primary",
}: HotkeyInputProps & HotkeyInputVariant) {
  const { t } = useTranslation();
  const [isCapturing, setIsCapturing] = useState(false);
  const [activeModifiers, setActiveModifiers] = useState<Set<string>>(new Set());
  const [validationWarning, setValidationWarning] = useState<string | null>(null);
  const [isFnHeld, setIsFnHeld] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastCapturedHotkeyRef = useRef<string | null>(null);
  const keyDownTimeRef = useRef<number>(0);
  const warningTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const validationWarningId = useId();
  const fnHeldRef = useRef(false);
  const fnCapturedKeyRef = useRef(false);
  const heldModifiersRef = useRef<{
    ctrl: boolean;
    meta: boolean;
    alt: boolean;
    shift: boolean;
  }>({ ctrl: false, meta: false, alt: false, shift: false });
  const modifierCodesRef = useRef<{
    ctrl?: string;
    meta?: string;
    alt?: string;
    shift?: string;
  }>({});
  const platform = getPlatform();
  const isMac = platform === "darwin";
  const isWindows = platform === "win32";

  const MODIFIER_HOLD_THRESHOLD_MS = 200;

  const buildModifierOnlyHotkey = useCallback(
    (
      modifiers: { ctrl: boolean; meta: boolean; alt: boolean; shift: boolean },
      codes: { ctrl?: string; meta?: string; alt?: string; shift?: string }
    ): string | null => {
      // Check for right-side single modifier first
      const rightSidePressed: string[] = [];
      if (codes.ctrl === "ControlRight") rightSidePressed.push("RightControl");
      if (codes.meta === "MetaRight") rightSidePressed.push(isMac ? "RightCommand" : "RightSuper");
      if (codes.alt === "AltRight") rightSidePressed.push(isMac ? "RightOption" : "RightAlt");
      if (codes.shift === "ShiftRight") rightSidePressed.push("RightShift");

      // If exactly one right-side modifier, allow it as single-key hotkey
      if (rightSidePressed.length === 1) {
        const activeCount = [modifiers.ctrl, modifiers.meta, modifiers.alt, modifiers.shift].filter(
          Boolean
        ).length;
        if (activeCount === 1) {
          return rightSidePressed[0];
        }
      }

      // Otherwise require 2+ modifiers (existing logic)
      const parts: string[] = [];
      if (modifiers.ctrl) parts.push("Control");
      if (modifiers.meta) parts.push(isMac ? "Command" : "Super");
      if (modifiers.alt) parts.push("Alt");
      if (modifiers.shift) parts.push("Shift");

      if (parts.length >= 2) {
        return parts.join("+");
      }
      return null;
    },
    [isMac]
  );

  const clearFnHeld = useCallback(() => {
    setIsFnHeld(false);
    fnHeldRef.current = false;
    fnCapturedKeyRef.current = false;
  }, []);

  const beginCapture = useCallback(() => {
    if (disabled || isCapturing) return;
    setIsCapturing(true);
    setValidationWarning(null);
    clearFnHeld();
    window.electronAPI?.setHotkeyListeningMode?.(true, null, captureScope);
  }, [captureScope, clearFnHeld, disabled, isCapturing]);

  const cancelCapture = useCallback(() => {
    setIsCapturing(false);
    setActiveModifiers(new Set());
    setValidationWarning(null);
    heldModifiersRef.current = { ctrl: false, meta: false, alt: false, shift: false };
    modifierCodesRef.current = {};
    keyDownTimeRef.current = 0;
    lastCapturedHotkeyRef.current = null;
    clearFnHeld();
    window.electronAPI?.setHotkeyListeningMode?.(false, null, captureScope);
  }, [captureScope, clearFnHeld]);

  const finalizeCapture = useCallback(
    (hotkey: string) => {
      if (warningTimeoutRef.current) {
        clearTimeout(warningTimeoutRef.current);
        warningTimeoutRef.current = null;
      }

      if (validate) {
        const errorMsg = validate(hotkey);
        if (errorMsg) {
          setValidationWarning(errorMsg);
          warningTimeoutRef.current = setTimeout(() => setValidationWarning(null), 4000);
          heldModifiersRef.current = { ctrl: false, meta: false, alt: false, shift: false };
          modifierCodesRef.current = {};
          setActiveModifiers(new Set());
          keyDownTimeRef.current = 0;
          clearFnHeld();
          return;
        }
      }

      setValidationWarning(null);
      lastCapturedHotkeyRef.current = hotkey;
      onChange(hotkey);
      setIsCapturing(false);
      setActiveModifiers(new Set());
      clearFnHeld();
      window.electronAPI?.setHotkeyListeningMode?.(false, null, captureScope);
      containerRef.current?.blur();
    },
    [captureScope, validate, onChange, clearFnHeld]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;

      if (!isCapturing) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          beginCapture();
        }
        return;
      }

      // Preserve normal forward/backward keyboard navigation. Modified Tab
      // combinations can still be captured as shortcuts.
      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        cancelCapture();
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      // Track held modifiers for modifier-only capture
      heldModifiersRef.current = {
        ctrl: e.ctrlKey,
        meta: e.metaKey,
        alt: e.altKey,
        shift: e.shiftKey,
      };

      // Track which specific keys are pressed (for left/right detection)
      const code = e.nativeEvent.code;
      if (code === "ControlLeft" || code === "ControlRight") {
        modifierCodesRef.current.ctrl = code;
      } else if (code === "MetaLeft" || code === "MetaRight") {
        modifierCodesRef.current.meta = code;
      } else if (code === "AltLeft" || code === "AltRight") {
        modifierCodesRef.current.alt = code;
      } else if (code === "ShiftLeft" || code === "ShiftRight") {
        modifierCodesRef.current.shift = code;
      }

      // Track when first pressed (for hold detection)
      if (keyDownTimeRef.current === 0) {
        keyDownTimeRef.current = Date.now();
      }

      const mods = new Set<string>();
      if (isMac) {
        if (e.metaKey) mods.add("Cmd");
        if (e.ctrlKey) mods.add("Ctrl");
      } else {
        if (e.ctrlKey) mods.add("Ctrl");
        if (e.metaKey) mods.add(isWindows ? "Win" : "Super");
      }
      if (e.altKey) mods.add(isMac ? "Option" : "Alt");
      if (e.shiftKey) mods.add("Shift");
      if (fnHeldRef.current) mods.add("Fn");
      setActiveModifiers(mods);

      // Try to get non-modifier hotkey first
      const hotkey = mapKeyboardEventToHotkey(e.nativeEvent);
      if (hotkey) {
        keyDownTimeRef.current = 0;
        if (fnHeldRef.current) {
          fnCapturedKeyRef.current = true;
          finalizeCapture(`Fn+${hotkey}`);
        } else {
          finalizeCapture(hotkey);
        }
      }
      // If no base key, modifiers are held - don't finalize yet
    },
    [beginCapture, cancelCapture, disabled, finalizeCapture, isCapturing, isMac, isWindows]
  );

  const handleKeyUp = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled || !isCapturing) return;
      e.preventDefault();

      const wasHoldingModifiers =
        heldModifiersRef.current.ctrl ||
        heldModifiersRef.current.meta ||
        heldModifiersRef.current.alt ||
        heldModifiersRef.current.shift;

      let attempted = false;

      if (wasHoldingModifiers && MODIFIER_CODES.has(e.nativeEvent.code)) {
        const holdDuration = Date.now() - keyDownTimeRef.current;

        if (holdDuration >= MODIFIER_HOLD_THRESHOLD_MS) {
          const modifierHotkey = buildModifierOnlyHotkey(
            heldModifiersRef.current,
            modifierCodesRef.current
          );
          if (modifierHotkey) {
            attempted = true;
            if (fnHeldRef.current) {
              fnCapturedKeyRef.current = true;
              finalizeCapture(`Fn+${modifierHotkey}`);
            } else {
              finalizeCapture(modifierHotkey);
            }
          }
        }
      }

      if (!attempted) {
        heldModifiersRef.current = { ctrl: false, meta: false, alt: false, shift: false };
        modifierCodesRef.current = {};
        setActiveModifiers(fnHeldRef.current ? new Set(["Fn"]) : new Set());
        keyDownTimeRef.current = 0;
      }
    },
    [disabled, buildModifierOnlyHotkey, finalizeCapture, isCapturing]
  );

  const handleBlur = useCallback(() => {
    setIsCapturing(false);
    setActiveModifiers(new Set());
    setValidationWarning(null);
    clearFnHeld();
    window.electronAPI?.setHotkeyListeningMode?.(
      false,
      lastCapturedHotkeyRef.current,
      captureScope
    );
    lastCapturedHotkeyRef.current = null;
    onBlur?.();
  }, [captureScope, onBlur, clearFnHeld]);

  useEffect(() => {
    if (autoFocus && containerRef.current) {
      containerRef.current.focus();
    }
  }, [autoFocus]);

  useEffect(() => {
    return () => {
      window.electronAPI?.setHotkeyListeningMode?.(false, null, captureScope);
      if (warningTimeoutRef.current) clearTimeout(warningTimeoutRef.current);
    };
  }, [captureScope]);

  useEffect(() => {
    if (!isCapturing || !isMac) return;

    const disposeDown = window.electronAPI?.onGlobeKeyPressed?.(() => {
      setValidationWarning(null);
      setIsFnHeld(true);
      fnHeldRef.current = true;
      fnCapturedKeyRef.current = false;
      setActiveModifiers((prev) => new Set([...prev, "Fn"]));
    });

    const disposeUp = window.electronAPI?.onGlobeKeyReleased?.(() => {
      if (fnHeldRef.current && !fnCapturedKeyRef.current) {
        finalizeCapture("GLOBE");
      }
      setIsFnHeld(false);
      fnHeldRef.current = false;
      fnCapturedKeyRef.current = false;
    });

    return () => {
      disposeDown?.();
      disposeUp?.();
    };
  }, [isCapturing, isMac, finalizeCapture]);

  const displayValue = formatHotkeyLabel(value);
  const isGlobe = value === "GLOBE";
  const hotkeyParts = value?.includes("+") ? displayValue.split("+") : [];
  const hotkeyAriaLabel = value
    ? `${t("hotkeyInput.ariaLabel")}: ${displayValue}`
    : t("hotkeyInput.ariaLabel");

  // Hero variant: large centered key display for onboarding
  if (variant === "hero") {
    return (
      <div
        ref={containerRef}
        tabIndex={disabled ? -1 : 0}
        role="button"
        aria-label={hotkeyAriaLabel}
        aria-pressed={isCapturing}
        aria-disabled={disabled}
        aria-describedby={validationWarning ? validationWarningId : undefined}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onClick={beginCapture}
        onBlur={handleBlur}
        className={`
          relative group flex flex-col items-center justify-center py-4 px-5 min-h-24
          rounded-md border cursor-pointer select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-background
          transition-[background-color,border-color,box-shadow] duration-150
          ${
            disabled
              ? "bg-muted/30 border-border cursor-not-allowed opacity-50"
              : isCapturing
                ? "glass-panel glass-panel--accent shadow-[var(--shadow-selected-glow)]"
                : "bg-surface-1 border-border hover:border-border-hover hover:bg-surface-2"
          }
        `}
      >
        {/* Recording state */}
        {isCapturing ? (
          <div className="flex flex-col items-center gap-3">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-primary rounded-full animate-pulse" />
              <span className="text-xs font-medium text-primary">{t("hotkeyInput.listening")}</span>
            </div>
            {activeModifiers.size > 0 ? (
              <div className="flex flex-col items-center gap-1.5">
                <div className="flex items-center gap-1.5">
                  {Array.from(activeModifiers).map((mod) => (
                    <kbd
                      key={mod}
                      className="glass-chip glass-chip--accent rounded-sm px-2.5 py-1 text-xs font-semibold text-primary"
                    >
                      {mod}
                    </kbd>
                  ))}
                  <span className="text-primary/50 text-sm font-medium">+</span>
                </div>
                {isFnHeld && (
                  <span className="text-[10px] text-muted-foreground">
                    {t("hotkeyInput.fnHeldHint")}
                  </span>
                )}
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">
                {isMac ? t("hotkeyInput.pressAnyKeyMac") : t("hotkeyInput.pressAnyKey")}
              </span>
            )}
            {validationWarning && (
              <div
                id={validationWarningId}
                role="alert"
                aria-live="polite"
                className="mt-2 flex items-center gap-1.5 rounded-md border border-warning/20 bg-warning/10 px-3 py-1.5 animate-in fade-in slide-in-from-top-1 duration-200"
              >
                <AlertTriangle className="w-3 h-3 text-warning shrink-0" />
                <span className="text-[11px] text-[color:var(--ui-warning-ink)]">
                  {validationWarning}
                </span>
              </div>
            )}
          </div>
        ) : value ? (
          /* Has value: show the hotkey prominently */
          <div className="flex flex-col items-center gap-2">
            <div className="flex items-center gap-1.5">
              {hotkeyParts.length > 0 ? (
                hotkeyParts.map((part, i) => (
                  <React.Fragment key={part}>
                    {i > 0 && (
                      <span className="text-muted-foreground/40 text-lg font-light">+</span>
                    )}
                    <kbd className="hotkey-keycap-hero min-w-[72px] px-3 py-2 text-sm font-semibold text-foreground sm:min-w-[84px]">
                      {part}
                    </kbd>
                  </React.Fragment>
                ))
              ) : isGlobe ? (
                <kbd className="hotkey-keycap-hero min-w-[72px] px-3 py-2 text-lg sm:min-w-[84px]">
                  🌐
                </kbd>
              ) : (
                <kbd className="hotkey-keycap-hero min-w-[72px] px-3 py-2 text-sm font-semibold text-foreground sm:min-w-[84px]">
                  {displayValue}
                </kbd>
              )}
            </div>
            <span className="text-[10px] text-muted-foreground/60 group-hover:text-muted-foreground transition-colors">
              {t("hotkeyInput.clickToChange")}
            </span>
          </div>
        ) : (
          /* Empty state */
          <div className="flex flex-col items-center gap-1.5 text-muted-foreground">
            <span className="text-sm font-medium">{t("hotkeyInput.clickToSet")}</span>
          </div>
        )}
      </div>
    );
  }

  // Default variant: compact inline display
  return (
    <div
      ref={containerRef}
      tabIndex={disabled ? -1 : 0}
      role="button"
      aria-label={hotkeyAriaLabel}
      aria-pressed={isCapturing}
      aria-disabled={disabled}
      aria-describedby={validationWarning ? validationWarningId : undefined}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onClick={beginCapture}
      onBlur={handleBlur}
      className={`
        relative overflow-hidden rounded-md border
        transition-[background-color,border-color,box-shadow] duration-150 cursor-pointer select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-background
        ${
          disabled
            ? "bg-muted/30 border-border cursor-not-allowed opacity-50"
            : isCapturing
              ? "glass-panel glass-panel--accent shadow-[var(--shadow-selected-glow)]"
              : "bg-surface-1 border-border hover:border-border-hover hover:bg-surface-2"
        }
      `}
    >
      {isCapturing && (
        <div className="absolute top-0 left-0 right-0 h-0.5 bg-primary animate-pulse" />
      )}

      <div className="px-4 py-3">
        {isCapturing ? (
          <>
            <div className="flex items-center justify-center gap-3">
              <div className="flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse" />
                <span className="text-xs font-medium text-muted-foreground">
                  {t("hotkeyInput.recording")}
                </span>
              </div>
              {activeModifiers.size > 0 ? (
                <div className="flex items-center gap-1">
                  {Array.from(activeModifiers).map((mod) => (
                    <kbd
                      key={mod}
                      className="glass-chip glass-chip--accent rounded-sm px-2 py-0.5 text-[11px] font-semibold text-primary"
                    >
                      {mod}
                    </kbd>
                  ))}
                  <span className="text-primary/40 text-[11px]">
                    {isFnHeld ? t("hotkeyInput.fnCaptureHint") : t("hotkeyInput.keyHint")}
                  </span>
                </div>
              ) : (
                <span className="text-[11px] text-muted-foreground">
                  {isMac ? t("hotkeyInput.tryShortcutMac") : t("hotkeyInput.tryShortcut")}
                </span>
              )}
            </div>
            {validationWarning && (
              <div
                id={validationWarningId}
                role="alert"
                aria-live="polite"
                className="mt-1.5 flex items-center gap-1.5 rounded-md border border-warning/20 bg-warning/10 px-3 py-1.5 animate-in fade-in slide-in-from-top-1 duration-200"
              >
                <AlertTriangle className="w-3 h-3 text-warning shrink-0" />
                <span className="text-[11px] text-[color:var(--ui-warning-ink)]">
                  {validationWarning}
                </span>
              </div>
            )}
          </>
        ) : value ? (
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t("hotkeyInput.hotkeyLabel")}
            </span>
            <div className="flex items-center gap-2">
              {hotkeyParts.length > 0 ? (
                <div className="flex items-center gap-1">
                  {hotkeyParts.map((part, i) => (
                    <React.Fragment key={part}>
                      {i > 0 && <span className="text-muted-foreground/30 text-[10px]">+</span>}
                      <kbd className="px-2 py-0.5 bg-surface-raised border border-border rounded-sm text-xs font-semibold text-foreground">
                        {part}
                      </kbd>
                    </React.Fragment>
                  ))}
                </div>
              ) : isGlobe ? (
                <div className="flex items-center gap-1.5">
                  <kbd className="px-2 py-0.5 bg-surface-raised border border-border rounded-sm text-base">
                    🌐
                  </kbd>
                  <span className="text-[11px] text-muted-foreground">
                    {t("hotkeyInput.globe")}
                  </span>
                </div>
              ) : (
                <kbd className="px-2.5 py-1 bg-surface-raised border border-border rounded-sm text-xs font-semibold text-foreground">
                  {displayValue}
                </kbd>
              )}
              <span className="text-[10px] text-muted-foreground/50">
                {t("hotkeyInput.clickToChangeLower")}
              </span>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center gap-2 text-muted-foreground">
            <span className="text-sm font-medium">{t("hotkeyInput.clickToSet")}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default HotkeyInput;
