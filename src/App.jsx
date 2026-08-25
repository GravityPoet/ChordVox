import React, { useState, useEffect, useLayoutEffect, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import "./index.css";
import { X } from "lucide-react";
import { useToast } from "./components/ui/toastContext";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { useHotkey } from "./hooks/useHotkey";
import { useWindowDrag } from "./hooks/useWindowDrag";
import { useAnimationFrameGate } from "./hooks/useAnimationFrameGate";
import { useWindowActivity } from "./hooks/useWindowActivity";
import { useAudioRecording } from "./hooks/useAudioRecording";
import { Capsule } from "./components/capsule/Capsule";
import { normalizeRecordingAnimationStyle } from "./utils/recordingAnimationStyle";
import { getDictationWindowSize } from "./utils/dictationWindowLayout";
import { getDictationOverlayPrimaryAction } from "./utils/dictationOverlayAction";
import { shouldShowNebulaStreamingPreview } from "./utils/streamingTranscriptPreview";
import { getDictationNoticeOverlayAction } from "./utils/dictationNoticeLifecycle";
import {
  getReasoningPreviewQuota,
  hasSeenReasoningLimitDialog,
  markReasoningLimitDialogSeen,
  PRO_REASONING_PREVIEW_DAILY_LIMIT,
} from "./utils/reasoningPreviewQuota";

const getDisplayUnits = (text = "") =>
  Array.from(String(text)).reduce((total, char) => {
    if (/\s/.test(char)) return total + 0.45;
    if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(char)) return total + 1;
    return total + 0.62;
  }, 0);

const getTrailingDisplayText = (text = "", maxUnits = 16) => {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";

  if (getDisplayUnits(normalized) <= maxUnits) {
    return normalized;
  }

  const chars = Array.from(normalized);
  let collected = "";

  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const next = chars[index] + collected;
    const nextUnits = getDisplayUnits(next);
    if (nextUnits > maxUnits) {
      break;
    }
    collected = next;
  }

  return collected;
};

const IDLE_AUTO_HIDE_DELAY_MS = 1200;
// The recording hook owns the normal 820ms completion lifecycle. This later
// fallback must stay beyond the 900ms deferred-toast handoff so it cannot hide
// the window just before a completion notice takes over.
const SUCCESS_AUTO_HIDE_FALLBACK_DELAY_MS = 1000;
const NO_SPEECH_AUTO_HIDE_DELAY_MS = 5 * 60 * 1000;
const NO_SPEECH_AUDIO_LEVEL_THRESHOLD = 0.04;
const DEFAULT_EXPANDED_OVERLAY_WIDTH = 452;
const NEBULA_STREAMING_PREVIEW_MAX_UNITS = 18;
const REASONING_PREVIEW_LIMIT_REACHED_CODE = "PRO_REASONING_PREVIEW_LIMIT_REACHED";

const getInitialRecordingAnimationStyle = () => {
  const stored = localStorage.getItem("recordingAnimationStyle");
  const normalized = normalizeRecordingAnimationStyle(stored);
  if (stored !== normalized) {
    localStorage.setItem("recordingAnimationStyle", normalized);
  }
  return normalized;
};

// Enhanced Tooltip Component
const Tooltip = ({ children, content, disabled = false, emoji }) => {
  const [isVisible, setIsVisible] = useState(false);

  return (
    <div className="relative inline-block">
      <div
        onMouseEnter={() => {
          if (!disabled) setIsVisible(true);
        }}
        onMouseLeave={() => setIsVisible(false)}
      >
        {children}
      </div>
      {!disabled && isVisible && (
        <div
          className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-1 py-1 text-popover-foreground bg-popover border border-border rounded-md whitespace-nowrap z-10 transition-opacity duration-150 shadow-lg"
          style={{ fontSize: "9.7px", maxWidth: "96px" }}
        >
          {emoji && <span className="mr-1">{emoji}</span>}
          {content}
          <div className="absolute top-full left-1/2 transform -translate-x-1/2 w-0 h-0 border-l-2 border-r-2 border-t-2 border-transparent border-t-popover"></div>
        </div>
      )}
    </div>
  );
};

const AnimatedCapsule = React.memo(function AnimatedCapsule({
  animationStyle,
  audioLevel,
  dataExiting,
  isRecording,
  isPastePending,
  state,
  text,
  textAnimationKey,
  textMode,
}) {
  const [animatedLevel, setAnimatedLevel] = useState(0);
  const audioLevelRef = useRef(audioLevel);
  const isRecordingRef = useRef(isRecording);
  audioLevelRef.current = audioLevel;
  isRecordingRef.current = isRecording;

  const animationActive =
    isRecording || state === "starting" || state === "recording" || state === "processing";
  const shouldAnimate = useAnimationFrameGate(animationActive);

  useEffect(() => {
    if (!shouldAnimate) {
      setAnimatedLevel(isRecording ? audioLevel : 0);
    }
  }, [audioLevel, isRecording, shouldAnimate]);

  useEffect(() => {
    if (!shouldAnimate) {
      return undefined;
    }

    let frameId;

    const animate = () => {
      setAnimatedLevel((current) => {
        const target = isRecordingRef.current ? audioLevelRef.current : 0;
        const next = current + (target - current) * 0.5;
        return Math.abs(next - target) < 0.01 ? target : next;
      });
      frameId = window.requestAnimationFrame(animate);
    };

    frameId = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frameId);
  }, [shouldAnimate]);

  return (
    <Capsule
      animationStyle={animationStyle}
      data-exiting={dataExiting}
      isPastePending={isPastePending}
      level={animatedLevel}
      state={state}
      text={text}
      textAnimationKey={textAnimationKey}
      textMode={textMode}
    />
  );
});

export default function App() {
  useWindowActivity();
  const [isHovered, setIsHovered] = useState(false);
  const [isClosePointerReady, setIsClosePointerReady] = useState(false);
  const [isCommandMenuOpen, setIsCommandMenuOpen] = useState(false);
  const buttonRef = useRef(null);
  const pillGroupRef = useRef(null);
  const overlayChromeRef = useRef(null);
  const closePointerRequestRef = useRef(0);
  const licenseNoticeToastIdRef = useRef(null);
  const { toast, toastCount, dismiss } = useToast();
  const { t, i18n } = useTranslation();
  const { hotkey } = useHotkey();
  const { isDragging, startDragging, stopDragging } = useWindowDrag();

  const dragGestureRef = useRef(null);
  const hasDraggedRef = useRef(false);

  const [recordingAnimationStyle, setRecordingAnimationStyle] = useState(
    getInitialRecordingAnimationStyle
  );
  const [dictationUiPreparation, setDictationUiPreparation] = useState(null);
  const [licenseLimitDialog, setLicenseLimitDialog] = useState({
    open: false,
    title: "",
    description: "",
    dateKey: "",
  });
  const [overlayTextAnimationKey, setOverlayTextAnimationKey] = useState(0);
  const [keepIdleOverlayVisible, setKeepIdleOverlayVisible] = useState(false);
  const prevMicStateRef = useRef("idle");
  const prevTextAnimationStateRef = useRef(null);
  const onboardingRecognitionStartedAtRef = useRef(0);
  const onboardingAudioRelayRef = useRef({
    lastSentAt: 0,
    lastSentLevel: -1,
    lastSentActive: false,
    lastSentState: "idle",
  });
  const noSpeechStartedAtRef = useRef(null);
  const previousToastCountRef = useRef(0);

  const handleDictationToggle = React.useCallback(() => {
    setKeepIdleOverlayVisible(true);
    setIsCommandMenuOpen(false);
  }, []);

  // Central guard: while the daily-limit dialog is open the window must stay
  // clickable. Hover-out, overlay dismissal, and success auto-hide paths all
  // call this with `false`; dropping those requests here (instead of racing
  // them with a keep-alive timer) is what keeps the dialog buttons working.
  const licenseLimitDialogOpenRef = useRef(false);
  const setWindowInteractivity = React.useCallback((shouldCapture, options) => {
    if (!shouldCapture && licenseLimitDialogOpenRef.current) {
      return Promise.resolve({ success: true, guarded: true });
    }
    return (
      window.electronAPI?.setMainWindowInteractivity?.(shouldCapture, options) ??
      Promise.resolve({ success: true })
    );
  }, []);

  const armClosePointer = React.useCallback(async () => {
    const requestId = ++closePointerRequestRef.current;
    setIsHovered(true);
    setIsClosePointerReady(false);

    try {
      const result = await setWindowInteractivity(true);
      if (closePointerRequestRef.current === requestId) {
        setIsClosePointerReady(result?.success !== false);
      }
    } catch {
      if (closePointerRequestRef.current === requestId) {
        setIsClosePointerReady(false);
      }
    }
  }, [setWindowInteractivity]);

  const disarmClosePointer = React.useCallback(() => {
    closePointerRequestRef.current += 1;
    setIsHovered(false);
    setIsClosePointerReady(false);
    void setWindowInteractivity(false);
  }, [setWindowInteractivity]);

  useEffect(() => {
    void setWindowInteractivity(false);
    return () => {
      void setWindowInteractivity(false);
    };
  }, [setWindowInteractivity]);

  useEffect(() => {
    const unsubscribeFallback = window.electronAPI?.onHotkeyFallbackUsed?.((data) => {
      toast({
        title: t("app.toasts.hotkeyChanged.title"),
        description: t("app.toasts.hotkeyChanged.description", {
          original: data?.original || "",
          fallback: data?.fallback || "",
        }),
        duration: 8000,
      });
    });

    const unsubscribeFailed = window.electronAPI?.onHotkeyRegistrationFailed?.((_data) => {
      toast({
        title: t("app.toasts.hotkeyUnavailable.title"),
        description: t("app.toasts.hotkeyUnavailable.description"),
        duration: 10000,
      });
    });

    const unsubscribePtt = window.electronAPI?.onWindowsPushToTalkUnavailable?.((data) => {
      const message = String(data?.message || "").trim();
      toast({
        title: t("app.toasts.pushToTalkUnavailable.title"),
        description: message
          ? t("app.toasts.pushToTalkUnavailable.descriptionWithReason", { reason: message })
          : t("app.toasts.pushToTalkUnavailable.description"),
        duration: 10000,
      });
    });

    return () => {
      unsubscribeFallback?.();
      unsubscribeFailed?.();
      unsubscribePtt?.();
    };
  }, [toast, t]);

  // Safety net for open-state changes that bypass the handlers above (e.g.
  // Radix onOpenChange). The handlers still flip the ref synchronously so a
  // dismissal's own interactivity(false) call is never swallowed.
  useEffect(() => {
    licenseLimitDialogOpenRef.current = licenseLimitDialog.open;
    if (licenseLimitDialog.open) {
      setWindowInteractivity(true, { focus: true });
    }
  }, [licenseLimitDialog.open, setWindowInteractivity]);

  useEffect(() => {
    const dispose = window.electronAPI?.onCommandMenuVisibilityChanged?.((payload) => {
      setIsCommandMenuOpen(Boolean(payload?.isVisible));
    });

    return () => {
      dispose?.();
    };
  }, []);

  useEffect(() => {
    const unsubscribeCueStyle = window.electronAPI?.onDictationCueStyleChanged?.((style) => {
      if (
        style === "off" ||
        style === "droplet1" ||
        style === "droplet2" ||
        style === "electronic"
      ) {
        localStorage.setItem("dictationCueStyle", style);
      }
    });

    const unsubscribeAnimationStyle = window.electronAPI?.onRecordingAnimationStyleChanged?.(
      (style) => {
        const normalized = normalizeRecordingAnimationStyle(style);
        localStorage.setItem("recordingAnimationStyle", normalized);
        setRecordingAnimationStyle(normalized);
      }
    );

    const handleStorage = (event) => {
      if (event.key === "recordingAnimationStyle") {
        setRecordingAnimationStyle(normalizeRecordingAnimationStyle(event.newValue));
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => {
      unsubscribeCueStyle?.();
      unsubscribeAnimationStyle?.();
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  useEffect(() => {
    window.electronAPI?.notifyRecordingAnimationStyleChanged?.(recordingAnimationStyle);
  }, [recordingAnimationStyle]);

  // Post-onboarding permission re-check: prompt once per session with an
  // actionable toast so a missing permission doesn't turn into a silent
  // failure on the first dictation attempt. On macOS the OS is queried live —
  // macOS revokes accessibility on app updates and users toggle permissions in
  // System Settings, so onboarding's cached flags can go stale in both
  // directions; the cache is only a fallback when the live query fails.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    if (sessionStorage.getItem("permissionRecheckShown") === "true") return undefined;
    if (localStorage.getItem("onboardingCompleted") !== "true") return undefined;
    // E2E runs on machines whose real permission state is unrelated to the
    // scenario under test; they pre-seed the cached flags instead.
    if (typeof window.electronAPI?.getE2eListenerRegistrations === "function") return undefined;

    let disposed = false;
    let timer = null;

    void (async () => {
      const platform = window.electronAPI?.getPlatform?.() || "";
      const needsAccessibility = platform === "darwin";

      let micGranted = localStorage.getItem("micPermissionGranted") === "true";
      let accessibilityGranted = localStorage.getItem("accessibilityPermissionGranted") === "true";
      if (platform === "darwin") {
        try {
          const micStatus = (await window.electronAPI?.getMicrophoneAccessStatus?.())?.status;
          if (micStatus === "granted") {
            micGranted = true;
          } else if (micStatus === "denied" || micStatus === "restricted") {
            micGranted = false;
          }
        } catch {
          /* keep cached value */
        }
        try {
          const live = await window.electronAPI?.checkAccessibilityPermission?.();
          if (typeof live === "boolean") {
            accessibilityGranted = live;
          }
        } catch {
          /* keep cached value */
        }
        localStorage.setItem("micPermissionGranted", micGranted ? "true" : "false");
        localStorage.setItem(
          "accessibilityPermissionGranted",
          accessibilityGranted ? "true" : "false"
        );
      }

      const missingMic = !micGranted;
      const missingAccessibility = needsAccessibility && !accessibilityGranted;
      if (disposed || (!missingMic && !missingAccessibility)) return;

      sessionStorage.setItem("permissionRecheckShown", "true");

      const title = missingMic
        ? t("hooks.permissions.titles.microphonePermissionRequired")
        : t("hooks.permissions.titles.accessibilityNeeded");
      const description = missingMic
        ? t("hooks.permissions.micErrors.permissionDenied", {
            privacyPath:
              platform === "win32"
                ? t("hooks.permissions.paths.windowsMicrophone")
                : platform === "linux"
                  ? t("hooks.permissions.paths.linuxPrivacy")
                  : t("hooks.permissions.paths.defaultPrivacy"),
          })
        : t("hooks.permissions.descriptions.accessibilityNeeded");

      const handleOpenSettings = () => {
        if (missingMic) {
          void window.electronAPI?.openMicrophoneSettings?.();
        } else {
          void (async () => {
            // Register ChordVox in the Accessibility list first (toggled off) so the
            // user only flips the switch instead of dragging the app in manually.
            await window.electronAPI?.requestAccessibilityPermission?.();
            const result = await window.electronAPI?.openAccessibilitySettings?.();
            if (result?.success === false) return;

            await new Promise((resolve) => window.setTimeout(resolve, 350));
            await window.electronAPI?.showMacPrivacyDragHelper?.({
              title: t("settingsPage.permissions.macAccessibilityDrag.title"),
              description: t("settingsPage.permissions.macAccessibilityDrag.description"),
              dragLabel: t("settingsPage.permissions.macAccessibilityDrag.dragLabel"),
              dragHint: t("settingsPage.permissions.macAccessibilityDrag.dragCardHint"),
              revealLabel: t("settingsPage.permissions.macAccessibilityDrag.openAccessibility"),
              unavailableLabel: t("settingsPage.permissions.macAccessibilityDrag.packagedOnly"),
              grantedLabel: t("settingsPage.permissions.macAccessibilityDrag.grantedLabel"),
              closeLabel: t("common.close"),
            });
          })();
        }
      };

      const action = (
        <button
          type="button"
          onClick={handleOpenSettings}
          className="shrink-0 rounded-[4px] border border-white/10 bg-white/8 px-2 py-1 text-[10px] font-medium text-white/85 transition-colors hover:bg-white/14"
        >
          {missingMic
            ? t("hooks.permissions.settingsTitles.microphone")
            : t("hooks.permissions.settingsTitles.accessibility")}
        </button>
      );

      timer = window.setTimeout(() => {
        toast({
          title,
          description,
          action,
          variant: "destructive",
          duration: 8000,
        });
      }, 800);
    })();

    return () => {
      disposed = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [t, toast]);

  const dismissLicenseLimitDialog = React.useCallback(() => {
    if (licenseLimitDialog.dateKey) {
      markReasoningLimitDialogSeen(licenseLimitDialog.dateKey);
    }
    licenseLimitDialogOpenRef.current = false;
    setLicenseLimitDialog({ open: false, title: "", description: "", dateKey: "" });
    if (!isHovered && toastCount === 0 && !isCommandMenuOpen) {
      setWindowInteractivity(false);
    }
  }, [
    isCommandMenuOpen,
    isHovered,
    licenseLimitDialog.dateKey,
    setWindowInteractivity,
    toastCount,
  ]);

  const handleOpenLicenseSettings = React.useCallback(async () => {
    if (licenseLimitDialog.dateKey) {
      markReasoningLimitDialogSeen(licenseLimitDialog.dateKey);
    }
    licenseLimitDialogOpenRef.current = false;
    setLicenseLimitDialog({ open: false, title: "", description: "", dateKey: "" });
    setIsCommandMenuOpen(false);
    setKeepIdleOverlayVisible(false);
    setWindowInteractivity(false);
    await window.electronAPI?.openControlPanelSection?.("account");
    await window.electronAPI?.hideWindow?.();
  }, [licenseLimitDialog.dateKey, setWindowInteractivity]);

  const handleOpenLicensePricing = React.useCallback(async () => {
    if (licenseLimitDialog.dateKey) {
      markReasoningLimitDialogSeen(licenseLimitDialog.dateKey);
    }
    licenseLimitDialogOpenRef.current = false;
    setLicenseLimitDialog({ open: false, title: "", description: "", dateKey: "" });
    setIsCommandMenuOpen(false);
    setKeepIdleOverlayVisible(false);
    setWindowInteractivity(false);

    const params = new URLSearchParams({
      source: "reasoning-preview-limit",
      lang: i18n.language || "en",
    });
    const result = await window.electronAPI?.openExternal?.(
      `https://chordvox.com/?${params.toString()}#pricing-plans`
    );

    if (!result || result.success === false) {
      await window.electronAPI?.openControlPanelSection?.("account");
    }
    await window.electronAPI?.hideWindow?.();
  }, [i18n.language, licenseLimitDialog.dateKey, setWindowInteractivity]);

  const handleTrialExpired = React.useCallback(
    ({ title, description, code, previewDateKey }) => {
      const isReasoningPreviewLimit = code === REASONING_PREVIEW_LIMIT_REACHED_CODE;
      const dateKey = previewDateKey || getReasoningPreviewQuota().dateKey;
      if (isReasoningPreviewLimit && hasSeenReasoningLimitDialog(dateKey)) {
        return;
      }

      setIsCommandMenuOpen(false);
      setKeepIdleOverlayVisible(true);
      if (licenseNoticeToastIdRef.current) {
        dismiss(licenseNoticeToastIdRef.current);
        licenseNoticeToastIdRef.current = null;
      }

      const resolvedTitle = title || t("app.trialExpiredModal.title");
      const resolvedDescription = description || t("app.trialExpiredModal.description");
      const actionLabel =
        code === REASONING_PREVIEW_LIMIT_REACHED_CODE
          ? t("app.trialExpiredModal.actions.buyNow")
          : t("app.trialExpiredModal.actions.haveKey");
      if (isReasoningPreviewLimit) {
        markReasoningLimitDialogSeen(dateKey);
        licenseLimitDialogOpenRef.current = true;
        setLicenseLimitDialog({
          open: true,
          title: resolvedTitle,
          description: resolvedDescription,
          dateKey,
        });
        setWindowInteractivity(true, { focus: true });
        return;
      }

      const action = (
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (licenseNoticeToastIdRef.current) {
              dismiss(licenseNoticeToastIdRef.current);
              licenseNoticeToastIdRef.current = null;
            }
            if (code === REASONING_PREVIEW_LIMIT_REACHED_CODE) {
              void handleOpenLicensePricing();
            } else {
              void handleOpenLicenseSettings();
            }
          }}
          className="shrink-0 rounded-[4px] border border-white/10 bg-white/8 px-2.5 py-1.5 text-[11px] font-medium text-white/90 transition-colors hover:bg-white/14"
        >
          {actionLabel}
        </button>
      );

      licenseNoticeToastIdRef.current = toast({
        title: resolvedTitle,
        description: resolvedDescription,
        action,
        variant: "default",
        duration: 0,
      });
      setWindowInteractivity(true);
    },
    [dismiss, handleOpenLicensePricing, handleOpenLicenseSettings, setWindowInteractivity, t, toast]
  );

  const handleOverlayDismiss = React.useCallback(() => {
    setIsCommandMenuOpen(false);
    setKeepIdleOverlayVisible(false);
    setWindowInteractivity(false);
  }, [setWindowInteractivity]);

  const {
    isRecording,
    isProcessing,
    isStreaming,
    isStarting,
    dictationStage,
    micFeedbackState,
    isSuccessFeedback,
    transcript,
    partialTranscript,
    audioLevel,
    errorMessage,
    toggleListening,
    stopRecording,
    cancelRecording,
    cancelProcessing,
    cancelPendingPaste,
    pasteCountdown,
    pendingPasteText,
    confirmPaste,
    cancelPaste,
  } = useAudioRecording(toast, {
    onToggle: handleDictationToggle,
    onLicenseRequired: handleTrialExpired,
    onOverlayDismiss: handleOverlayDismiss,
    dismissToast: dismiss,
    shouldSuppressDictationHotkey: () => licenseLimitDialogOpenRef.current,
  });
  const isPastePending = micFeedbackState === "pasting";
  const isBusy = isRecording || isProcessing || isStreaming || isStarting || isPastePending;

  // These effects read pasteCountdown/cancelPaste, so they must live below the
  // useAudioRecording destructuring: useEffect dependency arrays are evaluated
  // during render, and referencing those consts any earlier is a TDZ crash
  // that takes down the whole App tree.
  useEffect(() => {
    const shouldCapturePointer =
      isHovered ||
      isCommandMenuOpen ||
      toastCount > 0 ||
      licenseLimitDialog.open ||
      pasteCountdown !== null;
    setWindowInteractivity(shouldCapturePointer);
  }, [
    isCommandMenuOpen,
    isHovered,
    licenseLimitDialog.open,
    toastCount,
    pasteCountdown,
    setWindowInteractivity,
  ]);

  // Bonus path only: this keydown listener fires when the ChordVox window
  // itself is focused. During normal dictation the keyboard focus stays in the
  // target app, so Esc there does NOT reach this handler — the countdown bar's
  // Cancel button is the reliable way to abort. Real-machine validation gate.
  useEffect(() => {
    if (pasteCountdown === null) return;
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        cancelPaste();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [pasteCountdown, cancelPaste]);

  const dismissOverlay = React.useCallback(async () => {
    setIsCommandMenuOpen(false);
    setKeepIdleOverlayVisible(false);
    setWindowInteractivity(false);

    const hidePromise = Promise.resolve(window.electronAPI?.hideWindow?.());
    const cancellationPromise = (async () => {
      if (isRecording || isStarting || isStreaming) {
        await cancelRecording();
      } else if (isPastePending) {
        cancelPendingPaste();
      } else if (isProcessing) {
        await cancelProcessing();
      }
    })();

    await Promise.all([hidePromise, cancellationPromise]);
  }, [
    cancelPendingPaste,
    cancelProcessing,
    cancelRecording,
    isPastePending,
    isProcessing,
    isRecording,
    isStarting,
    isStreaming,
    setKeepIdleOverlayVisible,
    setWindowInteractivity,
  ]);

  const getMicState = () => {
    if (micFeedbackState === "error") return "error";
    if (micFeedbackState === "success" || dictationStage === "completed") return "success";
    if (isStarting) return "starting";
    if (dictationStage === "recording") return "recording";
    if (
      dictationStage === "transcribing" ||
      dictationStage === "polishing" ||
      dictationStage === "pasting"
    ) {
      return "processing";
    }
    if (isRecording) return "recording";
    if (isStreaming) return "processing";
    if (micFeedbackState === "pasting") return "processing";
    if (isProcessing) return "processing";
    if (isHovered && !isBusy && !isSuccessFeedback) return "hover";
    return "idle";
  };

  const micState = getMicState();

  useEffect(() => {
    const relayAudioLevel = window.electronAPI?.pushOnboardingAudioLevel;
    if (!relayAudioLevel) {
      return;
    }

    const normalizedLevel = isRecording ? Math.max(0, Math.min(1, audioLevel || 0)) : 0;
    const active = Boolean(isRecording);
    const now = Date.now();
    const relayState = onboardingAudioRelayRef.current;
    const stateChanged =
      relayState.lastSentActive !== active || relayState.lastSentState !== micState;
    const levelChanged = Math.abs(relayState.lastSentLevel - normalizedLevel) >= 0.03;
    const shouldSend =
      stateChanged ||
      levelChanged ||
      now - relayState.lastSentAt >= 33 ||
      (!active && relayState.lastSentLevel !== 0);

    if (!shouldSend) {
      return;
    }

    relayAudioLevel({
      level: normalizedLevel,
      active,
      micState,
      issuedAt: now,
    });

    onboardingAudioRelayRef.current = {
      lastSentAt: now,
      lastSentLevel: normalizedLevel,
      lastSentActive: active,
      lastSentState: micState,
    };
  }, [audioLevel, isRecording, micState]);

  // Keep the compact capsule visible after activation so the window does not
  // disappear immediately when a recording ends early or no speech is detected.
  useEffect(() => {
    let hideTimeout;

    if (!keepIdleOverlayVisible) {
      return undefined;
    }

    if (
      isRecording ||
      isProcessing ||
      isStreaming ||
      isStarting ||
      isPastePending ||
      isSuccessFeedback ||
      isHovered ||
      toastCount > 0 ||
      isCommandMenuOpen ||
      licenseLimitDialog.open
    ) {
      return undefined;
    }

    hideTimeout = setTimeout(() => {
      if (
        !isRecording &&
        !isProcessing &&
        !isStreaming &&
        !isStarting &&
        !isPastePending &&
        !isSuccessFeedback &&
        !isHovered &&
        toastCount === 0 &&
        !isCommandMenuOpen &&
        !licenseLimitDialog.open
      ) {
        setKeepIdleOverlayVisible(false);
        window.electronAPI?.hideWindow?.();
      }
    }, IDLE_AUTO_HIDE_DELAY_MS);

    return () => clearTimeout(hideTimeout);
  }, [
    keepIdleOverlayVisible,
    isRecording,
    isProcessing,
    isStreaming,
    isStarting,
    isPastePending,
    isSuccessFeedback,
    isHovered,
    isCommandMenuOpen,
    licenseLimitDialog.open,
    toastCount,
  ]);

  useEffect(() => {
    const hasSpeechSignal =
      (partialTranscript?.trim()?.length || 0) > 0 ||
      (transcript?.trim()?.length || 0) > 0 ||
      audioLevel > NO_SPEECH_AUDIO_LEVEL_THRESHOLD;

    if (
      !isRecording ||
      isProcessing ||
      isStreaming ||
      isStarting ||
      isPastePending ||
      hasSpeechSignal
    ) {
      noSpeechStartedAtRef.current = null;
      return undefined;
    }

    if (!noSpeechStartedAtRef.current) {
      noSpeechStartedAtRef.current = Date.now();
    }

    const elapsedMs = Date.now() - noSpeechStartedAtRef.current;
    const remainingMs = Math.max(0, NO_SPEECH_AUTO_HIDE_DELAY_MS - elapsedMs);
    const noSpeechTimer = window.setTimeout(async () => {
      const stillNoSpeech =
        !partialTranscript?.trim() &&
        !transcript?.trim() &&
        audioLevel <= NO_SPEECH_AUDIO_LEVEL_THRESHOLD;

      if (isRecording && stillNoSpeech) {
        noSpeechStartedAtRef.current = null;
        setKeepIdleOverlayVisible(false);
        await cancelRecording();
        window.electronAPI?.hideWindow?.();
      }
    }, remainingMs);

    return () => window.clearTimeout(noSpeechTimer);
  }, [
    audioLevel,
    cancelRecording,
    isPastePending,
    isProcessing,
    isRecording,
    isStarting,
    isStreaming,
    partialTranscript,
    transcript,
  ]);

  useEffect(() => {
    if (micState !== "success" || toastCount > 0 || licenseLimitDialog.open) {
      return undefined;
    }

    const successHideTimer = window.setTimeout(() => {
      if (licenseLimitDialogOpenRef.current) {
        return;
      }
      setIsHovered(false);
      setIsCommandMenuOpen(false);
      setKeepIdleOverlayVisible(false);
      setWindowInteractivity(false);
      void window.electronAPI?.hideWindow?.();
    }, SUCCESS_AUTO_HIDE_FALLBACK_DELAY_MS);

    return () => window.clearTimeout(successHideTimer);
  }, [licenseLimitDialog.open, micState, setWindowInteractivity, toastCount]);

  useEffect(() => {
    if (micState === "error") {
      setKeepIdleOverlayVisible(false);
    }
  }, [micState]);

  useEffect(() => {
    const handleKeyPress = (e) => {
      if (e.key === "Escape") {
        if (isCommandMenuOpen) {
          setIsCommandMenuOpen(false);
          void window.electronAPI?.hideCommandMenu?.();
        } else {
          void dismissOverlay();
        }
      }
    };

    document.addEventListener("keydown", handleKeyPress);
    return () => document.removeEventListener("keydown", handleKeyPress);
  }, [dismissOverlay, isCommandMenuOpen]);

  useEffect(() => {
    void window.electronAPI?.updateCommandMenuState?.({
      isRecording,
      isStarting,
      canStop: isRecording || isProcessing || isStarting || isStreaming || isPastePending,
    });
  }, [isPastePending, isProcessing, isRecording, isStarting, isStreaming]);

  const hasExpandedOverlay =
    keepIdleOverlayVisible ||
    micState === "starting" ||
    micState === "recording" ||
    micState === "processing" ||
    micState === "success" ||
    micState === "error";
  const [renderCapsule, setRenderCapsule] = useState(hasExpandedOverlay);
  const [capsuleExiting, setCapsuleExiting] = useState(false);

  useEffect(() => {
    const previousToastCount = previousToastCountRef.current;
    previousToastCountRef.current = toastCount;
    const action = getDictationNoticeOverlayAction({
      previousToastCount,
      toastCount,
      isBusy,
      isCommandMenuOpen,
      licenseLimitDialogOpen: licenseLimitDialog.open,
    });

    if (action === "suppress-capsule") {
      setKeepIdleOverlayVisible(false);
      setCapsuleExiting(false);
      setRenderCapsule(false);
      return;
    }

    if (action === "hide-window") {
      setIsHovered(false);
      setIsClosePointerReady(false);
      setKeepIdleOverlayVisible(false);
      setCapsuleExiting(false);
      setRenderCapsule(false);
      void setWindowInteractivity(false);
      void window.electronAPI?.hideWindow?.();
    }
  }, [isBusy, isCommandMenuOpen, licenseLimitDialog.open, setWindowInteractivity, toastCount]);

  const shouldRenderCapsule = hasExpandedOverlay || renderCapsule;
  const isCapsuleExitActive = !hasExpandedOverlay && capsuleExiting;
  const shouldUseCompactOverlayShell =
    shouldRenderCapsule && toastCount === 0 && !licenseLimitDialog.open;
  const shouldHideCapsuleForNotice = toastCount > 0 || licenseLimitDialog.open;
  const cleanedPartialTranscript = partialTranscript?.trim() || "";
  const cleanedTranscript = transcript?.trim() || "";
  const capsuleState = micState === "hover" ? "idle" : micState;
  const expandedOverlayWidth = DEFAULT_EXPANDED_OVERLAY_WIDTH;
  const showNebulaStreamingPreview = shouldShowNebulaStreamingPreview({
    animationStyle: recordingAnimationStyle,
    dictationStage,
    isRecording,
    isStreaming,
  });
  const useNebulaPreviewLayout = recordingAnimationStyle === "nebula" && shouldRenderCapsule;
  const pillWindowSize = getDictationWindowSize(recordingAnimationStyle);

  // Invariant: while the overlay is expanded and the pointer rests on the
  // chrome, the close control must be armed. A transient collapse bumps
  // closePointerRequestRef and discards the in-flight arm result, and no new
  // mouseenter fires while the pointer stays put — so re-arm here instead of
  // only clearing.
  useEffect(() => {
    if (!hasExpandedOverlay) {
      closePointerRequestRef.current += 1;
      setIsClosePointerReady(false);
      return;
    }
    if (isHovered && !isClosePointerReady) {
      void armClosePointer();
    }
  }, [hasExpandedOverlay, isHovered, isClosePointerReady, armClosePointer]);

  const preparedWindowResizeTarget = useMemo(() => {
    if (toastCount > 0 || licenseLimitDialog.open) {
      return "WITH_TOAST";
    }
    if (pasteCountdown !== null) {
      return {
        width: Math.max(pillWindowSize.width, 340),
        height: pillWindowSize.height + 72,
      };
    }
    return pillWindowSize;
  }, [licenseLimitDialog.open, pasteCountdown, pillWindowSize, toastCount]);

  useEffect(() => {
    const dispose = window.electronAPI?.onPrepareDictationUi?.((payload = {}) => {
      handleDictationToggle();
      const requestId = Number(payload.requestId);
      if (Number.isSafeInteger(requestId)) {
        setDictationUiPreparation({ requestId });
      }
    });

    return () => {
      dispose?.();
    };
  }, [handleDictationToggle]);

  useLayoutEffect(() => {
    if (!dictationUiPreparation) {
      return undefined;
    }

    // The main process owns the actual pre-show resize. Doing another awaited
    // resize here made preparation exceed its timeout, so the panel became
    // visible at the safe work-area position and jumped again moments later.
    const preparedSize =
      preparedWindowResizeTarget && typeof preparedWindowResizeTarget === "object"
        ? preparedWindowResizeTarget
        : pillWindowSize;
    window.electronAPI?.notifyDictationUiReady?.({
      requestId: dictationUiPreparation.requestId,
      animationStyle: recordingAnimationStyle,
      size: preparedSize,
    });
    setDictationUiPreparation((current) =>
      current?.requestId === dictationUiPreparation.requestId ? null : current
    );
    return undefined;
  }, [dictationUiPreparation, pillWindowSize, preparedWindowResizeTarget, recordingAnimationStyle]);

  useEffect(() => {
    if (hasExpandedOverlay) {
      setCapsuleExiting(false);
      setRenderCapsule(true);
      return undefined;
    }

    if (!renderCapsule) {
      return undefined;
    }

    setCapsuleExiting(true);
    const timeoutId = window.setTimeout(() => {
      setRenderCapsule(false);
    }, 420);

    return () => window.clearTimeout(timeoutId);
  }, [hasExpandedOverlay, renderCapsule]);

  const morphResize = React.useCallback(
    async (sizeKey) => {
      const capsule = document.querySelector(".dv-capsule");
      if (capsule && !isRecording) {
        capsule.classList.add("dv-capsule-morphing");
        await window.electronAPI?.resizeMainWindow?.(sizeKey);
        requestAnimationFrame(() => {
          capsule.classList.remove("dv-capsule-morphing");
        });
      } else {
        await window.electronAPI?.resizeMainWindow?.(sizeKey);
      }
    },
    [isRecording]
  );

  useEffect(() => {
    const resizeWindow = () => {
      if (toastCount > 0 || licenseLimitDialog.open) {
        morphResize("WITH_TOAST");
      } else if (pasteCountdown !== null) {
        // The paste-confirmation bar renders above the capsule (bottom-full),
        // and the window is bottom-anchored, so it needs extra headroom or the
        // bar is clipped at the window's top edge. Width must also cover the
        // bar's 280px minimum plus padding (the nebula layout is narrower).
        morphResize({
          width: Math.max(pillWindowSize.width, 340),
          height: pillWindowSize.height + 72,
        });
      } else if (hasExpandedOverlay) {
        morphResize(pillWindowSize);
      }
      // When hasExpandedOverlay is false (window is collapsing/hidden),
      // we intentionally skip sending "BASE" from the renderer side.
      // hideDictationPanel() in the main process already resizes to BASE
      // synchronously before hiding, so any IPC we send here would be a
      // stale duplicate that could race with the next showDictationPanel call.
    };
    resizeWindow();
  }, [
    hasExpandedOverlay,
    licenseLimitDialog.open,
    morphResize,
    pasteCountdown,
    pillWindowSize,
    toastCount,
  ]);

  const shouldShowHotkeyPrompt =
    keepIdleOverlayVisible &&
    dictationStage === "idle" &&
    !cleanedPartialTranscript &&
    !cleanedTranscript &&
    !isSuccessFeedback;

  const overlayText = useMemo(() => {
    if (isStarting) {
      return t("app.mic.placeholder.starting");
    }
    if (dictationStage === "recording") {
      return cleanedPartialTranscript || cleanedTranscript || t("app.mic.placeholder.listening");
    }
    if (dictationStage === "transcribing") {
      return cleanedPartialTranscript || cleanedTranscript || t("app.mic.placeholder.transcribing");
    }
    if (dictationStage === "polishing") {
      return cleanedTranscript || cleanedPartialTranscript || t("app.mic.placeholder.polishing");
    }
    if (dictationStage === "pasting") {
      return cleanedTranscript || cleanedPartialTranscript || t("app.mic.placeholder.pasting");
    }
    if (micState === "success") {
      return cleanedTranscript || cleanedPartialTranscript || t("app.mic.placeholder.completed");
    }
    if (micState === "error") {
      return errorMessage;
    }
    if (shouldShowHotkeyPrompt) {
      return t("app.mic.hotkeyToSpeak", { hotkey });
    }
    return "";
  }, [
    cleanedPartialTranscript,
    cleanedTranscript,
    dictationStage,
    hotkey,
    isStarting,
    shouldShowHotkeyPrompt,
    errorMessage,
    micState,
    t,
  ]);

  const hasCapsuleTranscriptText = Boolean(cleanedPartialTranscript || cleanedTranscript);
  const capsuleTextMode = hasCapsuleTranscriptText
    ? "live"
    : isStreaming
      ? "streaming-placeholder"
      : "batch-placeholder";
  const overlayDisplayText = useMemo(() => getTrailingDisplayText(overlayText, 16), [overlayText]);
  const nebulaStreamingPreviewText = useMemo(
    () => getTrailingDisplayText(overlayText, NEBULA_STREAMING_PREVIEW_MAX_UNITS),
    [overlayText]
  );

  useEffect(() => {
    if (!overlayDisplayText || prevTextAnimationStateRef.current === capsuleState) {
      return;
    }

    prevTextAnimationStateRef.current = capsuleState;
    setOverlayTextAnimationKey((key) => key + 1);
  }, [capsuleState, overlayDisplayText]);

  useEffect(() => {
    const previousMicState = prevMicStateRef.current;
    const transitionedIntoDictation =
      !["starting", "recording", "processing"].includes(previousMicState) &&
      ["starting", "recording", "processing"].includes(micState);
    const transitionedToProcessing = previousMicState !== "processing" && micState === "processing";
    const transitionedToSuccess = previousMicState !== "success" && micState === "success";

    if (transitionedIntoDictation) {
      onboardingRecognitionStartedAtRef.current = 0;
    }

    if (transitionedToProcessing) {
      onboardingRecognitionStartedAtRef.current = Date.now();
    }

    prevMicStateRef.current = micState;

    if (!transitionedToSuccess) {
      return;
    }

    const completedText = (cleanedTranscript || cleanedPartialTranscript || "").trim();
    const recognitionDurationMs = onboardingRecognitionStartedAtRef.current
      ? Math.max(0, Date.now() - onboardingRecognitionStartedAtRef.current)
      : null;

    localStorage.removeItem("onboardingLastDictationSuccessAt");
    localStorage.removeItem("onboardingLastDictationText");
    void window.electronAPI?.emitOnboardingDictationSuccess?.({
      text: completedText,
      recognitionDurationMs,
    });
  }, [cleanedPartialTranscript, cleanedTranscript, micState]);

  const getMicButtonProps = () => {
    const baseClasses =
      "relative border-0 bg-transparent p-0 transition-[opacity,transform] duration-180";

    switch (micState) {
      case "idle":
      case "hover":
        if (keepIdleOverlayVisible) {
          return {
            className: `${baseClasses} cursor-pointer`,
            tooltip: t("app.mic.hotkeyToSpeak", { hotkey }),
          };
        }
        return {
          className: "pointer-events-none h-0 w-0 opacity-0",
          tooltip: t("app.mic.hotkeyToSpeak", { hotkey }),
        };
      case "starting":
        return {
          className: `${baseClasses} cursor-pointer`,
          tooltip: t("app.mic.starting"),
        };
      case "recording":
        return {
          className: `${baseClasses} cursor-pointer`,
          tooltip: t("app.mic.recording"),
        };
      case "processing":
        return {
          className: `${baseClasses} cursor-pointer`,
          tooltip: t("app.buttons.cancelProcessing"),
        };
      case "success":
        return {
          className: `${baseClasses} cursor-pointer`,
          tooltip: t("app.mic.clickToSpeak"),
        };
      case "error":
        return {
          className: `${baseClasses} cursor-pointer`,
          tooltip: errorMessage || t("app.mic.clickToSpeak"),
        };
      default:
        return {
          className: `${baseClasses} bg-black/50 cursor-pointer`,
          style: { transform: "scale(0.8)" },
          tooltip: t("app.mic.clickToSpeak"),
        };
    }
  };

  const micProps = getMicButtonProps();

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy={isBusy}
      aria-label={t("app.aria.dictationOverlay")}
      className={
        shouldUseCompactOverlayShell
          ? "dictation-window dictation-window--compact"
          : licenseLimitDialog.open
            ? "dictation-window dictation-window--dialog-only"
            : "dictation-window"
      }
    >
      <Dialog
        open={licenseLimitDialog.open}
        onOpenChange={(open) => {
          if (!open) {
            dismissLicenseLimitDialog();
          }
        }}
      >
        <DialogContent
          className="reasoning-limit-dialog gap-5 p-7 sm:max-w-[520px]"
          overlayClassName="dialog-overlay--clear reasoning-limit-dialog__overlay"
        >
          <DialogHeader className="space-y-2 text-left">
            <DialogTitle className="text-[22px] leading-tight">
              {licenseLimitDialog.title || t("hooks.audioRecording.reasoningPreviewLimit.title")}
            </DialogTitle>
            <DialogDescription className="reasoning-limit-dialog__description text-[15px] leading-relaxed">
              {licenseLimitDialog.description ||
                t("hooks.audioRecording.reasoningPreviewLimit.description", {
                  limit: PRO_REASONING_PREVIEW_DAILY_LIMIT,
                })}
            </DialogDescription>
          </DialogHeader>
          <div className="reasoning-limit-dialog__value whitespace-pre-line rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-[13px] leading-relaxed text-muted-foreground">
            {t("app.trialExpiredModal.valueBullets")}
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button
              type="button"
              variant="outline"
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                dismissLicenseLimitDialog();
              }}
            >
              {t("app.trialExpiredModal.actions.later")}
            </Button>
            <Button
              type="button"
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void handleOpenLicensePricing();
              }}
            >
              {t("app.trialExpiredModal.actions.buyNow")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {!shouldHideCapsuleForNotice && (
        <div
          className={
            shouldUseCompactOverlayShell
              ? "dictation-window__overlay dictation-window__overlay--compact"
              : "dictation-window__overlay dictation-window__overlay--full"
          }
        >
          <div
            ref={(node) => {
              overlayChromeRef.current = node;
              pillGroupRef.current = node;
            }}
            data-close-ready={isClosePointerReady ? "true" : undefined}
            className={`dictation-window__chrome group relative inline-flex shrink-0 items-center justify-center${
              useNebulaPreviewLayout ? " dictation-window__chrome--nebula" : ""
            }`}
            onMouseEnter={() => {
              void armClosePointer();
            }}
            onMouseLeave={() => {
              disarmClosePointer();
            }}
          >
            {pasteCountdown !== null && (
              <div
                className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 z-50 flex items-center gap-3 px-3 py-2 rounded-lg border border-border/60 bg-background/90 shadow-[0_8px_30px_rgb(0,0,0,0.12)] backdrop-blur-md animate-in fade-in slide-in-from-bottom-2 duration-200 min-w-[280px]"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex flex-col gap-0.5 text-left max-w-[160px]">
                  <div className="text-[10px] text-primary/85 font-semibold uppercase tracking-wider">
                    {t("app.pasteConfirm.title")} ({pasteCountdown}s)
                  </div>
                  <div
                    className="text-[11px] text-foreground/90 font-normal truncate"
                    title={pendingPasteText}
                  >
                    {pendingPasteText}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0 ml-auto">
                  <button
                    type="button"
                    onClick={confirmPaste}
                    className="h-6 px-2 text-[10px] font-medium rounded bg-primary text-primary-foreground hover:bg-primary/95 active:scale-95 transition-all cursor-pointer"
                  >
                    {t("app.pasteConfirm.confirm")}
                  </button>
                  <button
                    type="button"
                    onClick={cancelPaste}
                    className="h-6 px-2 text-[10px] font-medium rounded border border-border bg-background hover:bg-muted text-muted-foreground hover:text-foreground active:scale-95 transition-all cursor-pointer"
                  >
                    {t("app.pasteConfirm.cancel")}
                  </button>
                </div>
              </div>
            )}
            <Tooltip content={micProps.tooltip} disabled={showNebulaStreamingPreview}>
              <button
                ref={buttonRef}
                type="button"
                aria-label={t(`app.aria.micButton.${micState}`, {
                  defaultValue: t("app.aria.micButton.idle"),
                })}
                aria-pressed={isRecording}
                aria-busy={isBusy}
                onPointerDown={(e) => {
                  if (e.button !== 0 || e.isPrimary === false) {
                    hasDraggedRef.current = false;
                    return;
                  }
                  if (isCommandMenuOpen) {
                    void window.electronAPI?.hideCommandMenu?.();
                    setIsCommandMenuOpen(false);
                  }
                  dragGestureRef.current = {
                    pointerId: e.pointerId,
                    startX: e.clientX,
                    startY: e.clientY,
                  };
                  hasDraggedRef.current = false;
                  e.currentTarget.setPointerCapture?.(e.pointerId);
                }}
                onPointerMove={(e) => {
                  const gesture = dragGestureRef.current;
                  if (!gesture || gesture.pointerId !== e.pointerId) return;
                  if ((e.buttons & 1) === 0) {
                    dragGestureRef.current = null;
                    stopDragging();
                    return;
                  }
                  if (
                    !hasDraggedRef.current &&
                    Math.hypot(e.clientX - gesture.startX, e.clientY - gesture.startY) > 5
                  ) {
                    hasDraggedRef.current = true;
                    startDragging();
                  }
                }}
                onPointerUp={(e) => {
                  if (dragGestureRef.current?.pointerId !== e.pointerId) return;
                  dragGestureRef.current = null;
                  stopDragging();
                  if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
                    e.currentTarget.releasePointerCapture?.(e.pointerId);
                  }
                }}
                onPointerCancel={(e) => {
                  if (dragGestureRef.current?.pointerId !== e.pointerId) return;
                  dragGestureRef.current = null;
                  stopDragging();
                }}
                onLostPointerCapture={() => {
                  dragGestureRef.current = null;
                  stopDragging();
                }}
                onClick={async (e) => {
                  const selection = window.getSelection?.();
                  const hasSelection = Boolean(selection && String(selection).trim().length > 0);
                  if (hasSelection) {
                    selection?.removeAllRanges?.();
                    e.preventDefault();
                    return;
                  }

                  if (!hasDraggedRef.current) {
                    if (isCommandMenuOpen) {
                      void window.electronAPI?.hideCommandMenu?.();
                      setIsCommandMenuOpen(false);
                    }
                    const action = getDictationOverlayPrimaryAction({
                      isRecording,
                      isStreaming,
                      isStarting,
                      isProcessing,
                      isPastePending,
                    });
                    if (action === "cancel-start") {
                      await cancelRecording();
                    } else if (action === "stop-recording") {
                      await stopRecording();
                    } else if (action === "cancel-paste") {
                      cancelPendingPaste();
                    } else if (action === "cancel-processing") {
                      await cancelProcessing();
                    } else {
                      await toggleListening();
                    }
                  }
                  e.preventDefault();
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!hasDraggedRef.current) {
                    setWindowInteractivity(true);
                    void window.electronAPI
                      ?.toggleCommandMenu({
                        isRecording,
                        isStarting,
                        canStop:
                          isRecording ||
                          isProcessing ||
                          isStarting ||
                          isStreaming ||
                          isPastePending,
                      })
                      ?.then((result) => {
                        if (typeof result?.isVisible === "boolean") {
                          setIsCommandMenuOpen(result.isVisible);
                        }
                      });
                  }
                }}
                onFocus={() => setIsHovered(true)}
                onBlur={() => {
                  setIsHovered(false);
                  dragGestureRef.current = null;
                  stopDragging();
                }}
                className={`${micProps.className}${
                  useNebulaPreviewLayout ? " dictation-mic--nebula" : ""
                }`}
                style={{
                  ...micProps.style,
                  cursor: isDragging ? "grabbing" : "pointer",
                  transition: "transform 320ms cubic-bezier(0.4, 0, 0.2, 1)",
                  "--dictation-pill-width": `${expandedOverlayWidth}px`,
                }}
              >
                {shouldRenderCapsule && (
                  <AnimatedCapsule
                    animationStyle={recordingAnimationStyle}
                    audioLevel={audioLevel}
                    dataExiting={isCapsuleExitActive ? "true" : undefined}
                    isRecording={isRecording}
                    isPastePending={isPastePending}
                    state={capsuleState}
                    text={overlayDisplayText}
                    textAnimationKey={overlayTextAnimationKey}
                    textMode={capsuleTextMode}
                  />
                )}
                {showNebulaStreamingPreview && (
                  <div
                    className="streaming-transcript-preview"
                    data-visible="true"
                    data-placeholder={!hasCapsuleTranscriptText ? "true" : undefined}
                    aria-hidden="true"
                  >
                    <span className="streaming-transcript-preview__text" dir="auto">
                      {nebulaStreamingPreviewText}
                    </span>
                  </div>
                )}
              </button>
            </Tooltip>
            {hasExpandedOverlay && (
              <button
                aria-label={
                  isRecording || isStarting
                    ? t("app.buttons.cancelRecording")
                    : t("app.commandMenu.hideForNow")
                }
                onMouseDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                }}
                onClick={async (e) => {
                  e.stopPropagation();
                  await dismissOverlay();
                }}
                className="dictation-floating-close"
              >
                <X
                  size={10}
                  strokeWidth={2.5}
                  className="dictation-floating-close__icon transition-colors duration-150"
                />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
