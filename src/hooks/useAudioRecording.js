import { createElement, useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import AudioManager from "../helpers/audioManager";
import logger from "../utils/logger";
import { CHORDVOX_CLOUD_SOURCE, normalizeChordVoxSource } from "../utils/chordvoxCloud";
import { playStartCue, playStopCue } from "../utils/dictationCues";
import { PRO_REASONING_PREVIEW_DAILY_LIMIT } from "../utils/reasoningPreviewQuota";
import { matchTailCommand } from "../utils/dictationTailCommands";

const SUCCESS_FEEDBACK_DURATION_MS = 820;
// When a completion toast follows a successful dictation, defer the toast by
// this long so the capsule's success FX can draw, remain readable, and settle
// before the toast takes over the floating window and unmounts the capsule.
const SUCCESS_FX_GUARD_MS = 900;
const ERROR_FEEDBACK_DURATION_MS = 3500;
const PASTE_CANCEL_GRACE_PERIOD_MS = 180;
const DICTATION_REENTRY_WINDOW_MS = 120;
const RETRY_START_READY_TIMEOUT_MS = 5000;
// The one-time Pro nudge waits until the user has this many saved dictations,
// so it lands on people who demonstrably use the product, not new installs.
const PRO_NUDGE_MIN_DICTATIONS = 20;
const TAIL_COMMANDS_RUNTIME_ENABLED = false;
const PASTE_CONFIRM_RUNTIME_ENABLED = false;

// Cancellation must not depend on the cue implementation keeping its own
// promise contract.  The cue receives the signal (so it can stop tones), and
// this wrapper also releases the recording start immediately if a platform
// audio API remains stuck despite the signal.
const playStartCueWithCancellation = (signal) => {
  const cuePromise = Promise.resolve().then(() =>
    playStartCue({
      waitForEnd: true,
      signal,
    })
  );
  if (!signal) {
    return cuePromise;
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      signal.removeEventListener?.("abort", handleAbort);
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const handleAbort = () => finish(false);

    if (signal.aborted) {
      finish(false);
      return;
    }

    signal.addEventListener?.("abort", handleAbort, { once: true });
    cuePromise.then(finish, (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
};

const resolveSpeechRecognitionCtor = () => {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
};

const resolvePreviewLanguage = (audioManager) => {
  const preferredLanguage =
    audioManager?.getStringSetting?.("preferredLanguage", "auto") ||
    localStorage.getItem("preferredLanguage") ||
    "auto";

  switch (preferredLanguage) {
    case "zh":
    case "auto":
      return "zh-CN";
    case "yue":
      return "zh-HK";
    case "en":
      return "en-US";
    case "ja":
      return "ja-JP";
    case "ko":
      return "ko-KR";
    default:
      return preferredLanguage;
  }
};

export const useAudioRecording = (toast, options = {}) => {
  const { t } = useTranslation();
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [dictationStage, setDictationStage] = useState("idle");
  const [micFeedbackState, setMicFeedbackState] = useState("idle"); // idle | pasting | success | error
  const [transcript, setTranscript] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [audioLevel, setAudioLevel] = useState(0);
  const [errorMessage, setErrorMessage] = useState("");
  const [pasteCountdown, setPasteCountdown] = useState(null);
  const [pendingPasteText, setPendingPasteText] = useState(null);
  const resolvePastePromiseRef = useRef(null);
  const audioManagerRef = useRef(null);
  const previewRecognitionRef = useRef(null);
  const previewActiveRef = useRef(false);
  // The Web Speech preview opens a SECOND system-mic session (lights the macOS mic
  // indicator) and streams audio to Google. Once it fails for an environmental
  // reason (no network, denied, unsupported) it never works for the rest of the
  // session, so we stop re-opening it on every recording — that repeated open whose
  // teardown can wedge mid network-retry is what left the mic indicator stuck on
  // after dictation completed.
  const previewUnavailableRef = useRef(false);
  const micFeedbackStateRef = useRef("idle");
  const startLockRef = useRef(false);
  const startAbortControllerRef = useRef(null);
  const stopLockRef = useRef(false);
  const systemRecoveryInProgressRef = useRef(false);
  const systemSuspendInterruptedRef = useRef(false);
  const lastDictationActionRef = useRef({ type: null, at: 0 });
  const successFeedbackTimerRef = useRef(null);
  const deferredCompletionToastTimersRef = useRef(new Set());
  const deferredProNudgeTimerRef = useRef(null);
  const pendingRetryStartRef = useRef(null);
  const pendingCompletionCancelledRef = useRef(false);
  const pendingPasteRequestRef = useRef(null);
  const {
    onToggle,
    onLicenseRequired,
    onOverlayDismiss,
    dismissToast,
    shouldSuppressDictationHotkey,
  } = options;
  const partialTranscriptFrameRef = useRef(null);
  const pendingPartialTranscriptRef = useRef("");
  const isMountedRef = useRef(true);
  const lastAudioLevelRef = useRef({ value: 0, at: 0 });
  const clearPendingPartialTranscriptFrame = useCallback(() => {
    if (!partialTranscriptFrameRef.current) {
      return;
    }
    cancelAnimationFrame(partialTranscriptFrameRef.current);
    partialTranscriptFrameRef.current = null;
  }, []);
  const setPartialTranscriptImmediate = useCallback(
    (text) => {
      pendingPartialTranscriptRef.current = "";
      clearPendingPartialTranscriptFrame();
      if (!isMountedRef.current) {
        return;
      }
      setPartialTranscript(text);
    },
    [clearPendingPartialTranscriptFrame]
  );
  const schedulePartialTranscript = useCallback((text) => {
    pendingPartialTranscriptRef.current = text;
    if (partialTranscriptFrameRef.current) {
      return;
    }

    partialTranscriptFrameRef.current = requestAnimationFrame(() => {
      partialTranscriptFrameRef.current = null;
      if (!isMountedRef.current) {
        return;
      }
      setPartialTranscript(pendingPartialTranscriptRef.current);
    });
  }, []);
  const resolveProfileId = useCallback((payload) => {
    const candidate = typeof payload?.profileId === "string" ? payload.profileId.trim() : "";
    return candidate === "secondary" || /^workflow-[a-z0-9-]{1,72}$/i.test(candidate)
      ? candidate
      : "primary";
  }, []);
  const clearDeferredCompletionToasts = useCallback(() => {
    for (const timerId of deferredCompletionToastTimersRef.current) {
      clearTimeout(timerId);
    }
    deferredCompletionToastTimersRef.current.clear();
  }, []);
  const clearDeferredProNudge = useCallback(() => {
    if (deferredProNudgeTimerRef.current) {
      clearTimeout(deferredProNudgeTimerRef.current);
      deferredProNudgeTimerRef.current = null;
    }
  }, []);
  const cancelPendingRetryStart = useCallback(() => {
    const pending = pendingRetryStartRef.current;
    if (!pending) {
      return false;
    }
    clearTimeout(pending.timeoutId);
    pendingRetryStartRef.current = null;
    return true;
  }, []);
  const clearSuccessFeedback = useCallback(() => {
    if (successFeedbackTimerRef.current) {
      clearTimeout(successFeedbackTimerRef.current);
      successFeedbackTimerRef.current = null;
    }
    clearDeferredCompletionToasts();
    clearDeferredProNudge();
    if (!isMountedRef.current) {
      return;
    }
    setMicFeedbackState("idle");
    setErrorMessage("");
  }, [clearDeferredCompletionToasts, clearDeferredProNudge]);
  const cancelActivePasteRequest = useCallback(() => {
    const pendingRequest = pendingPasteRequestRef.current;
    if (!pendingRequest) {
      return false;
    }

    pendingRequest.cancelled = true;
    void window.electronAPI?.cancelPasteText?.(pendingRequest.requestId).catch(() => {});
    pendingRequest.resolveWindow?.();
    pendingPasteRequestRef.current = null;
    return true;
  }, []);
  const createPendingPasteRequest = useCallback(() => {
    const requestId = `paste-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const pendingRequest = {
      requestId,
      cancelled: false,
      resolveWindow: null,
    };
    pendingPasteRequestRef.current = pendingRequest;
    return pendingRequest;
  }, []);
  const waitForPasteCancellationWindow = useCallback((pendingRequest, text) => {
    return new Promise((resolve) => {
      let settled = false;
      let intervalId = null;
      let timeoutId = null;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (intervalId) clearInterval(intervalId);
        if (timeoutId) clearTimeout(timeoutId);
        setPasteCountdown(null);
        setPendingPasteText(null);
        resolvePastePromiseRef.current = null;
        if (pendingRequest.resolveWindow === finish) {
          pendingRequest.resolveWindow = null;
        }
        resolve();
      };

      const pasteConfirmEnabled =
        PASTE_CONFIRM_RUNTIME_ENABLED && localStorage.getItem("pasteConfirmEnabled") === "true";
      const rawThreshold = localStorage.getItem("pasteConfirmThreshold");
      const pasteConfirmThreshold = rawThreshold ? Number(rawThreshold) : 300;

      if (pasteConfirmEnabled && text && text.length >= pasteConfirmThreshold) {
        setPendingPasteText(text);
        setPasteCountdown(5);
        resolvePastePromiseRef.current = finish;

        let remaining = 5;
        intervalId = setInterval(() => {
          remaining -= 1;
          if (remaining <= 0) {
            clearInterval(intervalId);
            finish();
          } else {
            setPasteCountdown(remaining);
          }
        }, 1000);
      } else {
        timeoutId = setTimeout(finish, PASTE_CANCEL_GRACE_PERIOD_MS);
      }

      pendingRequest.resolveWindow = finish;
    });
  }, []);

  const confirmPaste = useCallback(() => {
    if (resolvePastePromiseRef.current) {
      resolvePastePromiseRef.current();
    }
  }, []);

  const cancelPaste = useCallback(() => {
    if (resolvePastePromiseRef.current) {
      if (pendingPasteRequestRef.current) {
        pendingPasteRequestRef.current.cancelled = true;
      }
      resolvePastePromiseRef.current();
    }
  }, []);
  const isPendingPasteCancelled = useCallback((pendingRequest) => {
    return (
      !pendingRequest ||
      pendingRequest.cancelled ||
      pendingCompletionCancelledRef.current ||
      pendingPasteRequestRef.current !== pendingRequest
    );
  }, []);
  const updateAudioLevel = useCallback((nextLevel) => {
    if (!isMountedRef.current) {
      return;
    }

    const normalized = Math.max(0, Math.min(1, Number(nextLevel) || 0));
    const now = performance.now();
    const previous = lastAudioLevelRef.current;
    if (Math.abs(previous.value - normalized) < 0.02 && now - previous.at < 33) {
      return;
    }

    lastAudioLevelRef.current = { value: normalized, at: now };
    setAudioLevel(normalized);
  }, []);
  const resetPendingCompletionCancellation = useCallback(() => {
    pendingCompletionCancelledRef.current = false;
  }, []);
  const abortRecordingStart = useCallback(() => {
    const controller = startAbortControllerRef.current;
    if (!controller || controller.signal.aborted) {
      return false;
    }
    controller.abort();
    return true;
  }, []);
  const markPendingCompletionCancelled = useCallback(() => {
    pendingCompletionCancelledRef.current = true;
    abortRecordingStart();
    cancelPendingRetryStart();
    cancelActivePasteRequest();
  }, [abortRecordingStart, cancelActivePasteRequest, cancelPendingRetryStart]);
  const triggerErrorFeedback = useCallback(
    (message) => {
      if (successFeedbackTimerRef.current) {
        clearTimeout(successFeedbackTimerRef.current);
        successFeedbackTimerRef.current = null;
      }
      clearDeferredCompletionToasts();
      clearDeferredProNudge();
      if (!isMountedRef.current) {
        return;
      }
      setErrorMessage(message || "");
      setMicFeedbackState("error");
      setDictationStage("idle");
      successFeedbackTimerRef.current = setTimeout(() => {
        successFeedbackTimerRef.current = null;
        if (!isMountedRef.current) {
          return;
        }
        setMicFeedbackState("idle");
        setErrorMessage("");
        window.electronAPI?.hideWindow?.();
      }, ERROR_FEEDBACK_DURATION_MS);
    },
    [clearDeferredCompletionToasts, clearDeferredProNudge]
  );
  const openAccessibilitySettings = useCallback(async () => {
    try {
      // Register ChordVox in the Accessibility list first (toggled off) so the user
      // only flips the switch instead of dragging the app in manually.
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
        closeLabel: t("common.close"),
      });
    } catch (error) {
      logger.error("Failed to open accessibility settings", error, "permissions");
    }
  }, [t]);
  const getCurrentPlatform = useCallback(() => {
    const platform = window.electronAPI?.getPlatform?.();
    if (platform === "darwin" || platform === "win32" || platform === "linux") {
      return platform;
    }
    return "darwin";
  }, []);
  useEffect(() => {
    micFeedbackStateRef.current = micFeedbackState;
  }, [micFeedbackState]);
  useEffect(() => {
    isMountedRef.current = true;
    const deferredToastTimers = deferredCompletionToastTimersRef.current;
    return () => {
      isMountedRef.current = false;
      cancelPendingRetryStart();
      clearPendingPartialTranscriptFrame();
      if (successFeedbackTimerRef.current) {
        clearTimeout(successFeedbackTimerRef.current);
        successFeedbackTimerRef.current = null;
      }
      for (const timerId of deferredToastTimers) {
        clearTimeout(timerId);
      }
      deferredToastTimers.clear();
      if (deferredProNudgeTimerRef.current) {
        clearTimeout(deferredProNudgeTimerRef.current);
        deferredProNudgeTimerRef.current = null;
      }
    };
  }, [cancelPendingRetryStart, clearPendingPartialTranscriptFrame]);
  const stopLiveTranscriptPreview = useCallback(
    ({ keepText = true } = {}) => {
      previewActiveRef.current = false;

      const recognition = previewRecognitionRef.current;
      if (recognition) {
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        previewRecognitionRef.current = null;
        try {
          // abort() releases the mic immediately; stop() lets the engine finish and
          // can wedge mid network-retry, leaving the mic session (and the macOS mic
          // indicator) open until the app quits.
          recognition.abort();
        } catch {
          // Ignore abort errors from already-ended preview sessions.
        }
      }

      if (!keepText) {
        setPartialTranscriptImmediate("");
      }
    },
    [setPartialTranscriptImmediate]
  );

  const startLiveTranscriptPreview = useCallback(() => {
    const audioManager = audioManagerRef.current;
    if (
      !audioManager ||
      audioManager.shouldUseStreaming() ||
      audioManager.shouldUseLocalStreaming()
    ) {
      return false;
    }

    if (previewUnavailableRef.current) {
      return false;
    }

    const SpeechRecognitionCtor = resolveSpeechRecognitionCtor();
    if (!SpeechRecognitionCtor) {
      return false;
    }

    stopLiveTranscriptPreview({ keepText: false });

    try {
      const recognition = new SpeechRecognitionCtor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      recognition.lang = resolvePreviewLanguage(audioManager);

      recognition.onresult = (event) => {
        let nextText = "";
        for (let index = 0; index < event.results.length; index += 1) {
          const transcriptChunk = event.results[index]?.[0]?.transcript || "";
          nextText += transcriptChunk;
        }
        const normalizedText = nextText.trim();
        if (normalizedText) {
          schedulePartialTranscript(normalizedText);
        }
      };

      recognition.onerror = (event) => {
        const errorCode = event?.error || "unknown";
        if (errorCode === "aborted" || errorCode === "no-speech") {
          return;
        }
        if (
          errorCode === "network" ||
          errorCode === "not-allowed" ||
          errorCode === "service-not-allowed" ||
          errorCode === "audio-capture" ||
          errorCode === "language-not-supported"
        ) {
          logger.debug("Live transcript preview disabled", { error: errorCode }, "speech-preview");
          previewUnavailableRef.current = true;
          stopLiveTranscriptPreview({ keepText: true });
          return;
        }
        logger.debug("Live transcript preview error", { error: errorCode }, "speech-preview");
      };

      recognition.onend = () => {
        const stillRecording = audioManagerRef.current?.getState?.().isRecording;
        if (!previewActiveRef.current || !stillRecording) {
          return;
        }
        try {
          recognition.start();
        } catch (error) {
          logger.debug(
            "Live transcript preview restart skipped",
            { error: error?.message || "restart_failed" },
            "speech-preview"
          );
        }
      };

      previewRecognitionRef.current = recognition;
      previewActiveRef.current = true;
      recognition.start();
      return true;
    } catch (error) {
      logger.debug(
        "Live transcript preview unavailable",
        { error: error?.message || "unsupported" },
        "speech-preview"
      );
      previewRecognitionRef.current = null;
      previewActiveRef.current = false;
      return false;
    }
  }, [schedulePartialTranscript, stopLiveTranscriptPreview]);

  const triggerSuccessFeedback = useCallback(
    (holdForToast = false) => {
      if (successFeedbackTimerRef.current) {
        clearTimeout(successFeedbackTimerRef.current);
        successFeedbackTimerRef.current = null;
      }
      if (!isMountedRef.current) {
        return;
      }
      setMicFeedbackState("success");
      setDictationStage("completed");
      // Keep the post-paste stellar completion visible through its full settle
      // sequence. When a completion toast will follow, extend the hold to match
      // the toast delay and let the toast lifecycle (+ App overlay logic) hide
      // the window — hiding here would close it before the deferred toast appears.
      const holdMs = holdForToast ? SUCCESS_FX_GUARD_MS : SUCCESS_FEEDBACK_DURATION_MS;
      successFeedbackTimerRef.current = setTimeout(() => {
        successFeedbackTimerRef.current = null;
        if (!isMountedRef.current) {
          return;
        }
        setMicFeedbackState("idle");
        setDictationStage("idle");
        if (holdForToast) {
          return;
        }
        onOverlayDismiss?.();
        void window.electronAPI?.hideWindow?.();
      }, holdMs);
    },
    [onOverlayDismiss]
  );

  // One-time, post-success-only Pro nudge. Fires from the history-save success
  // path so it can never interrupt an active dictation, stays silent for
  // licensed and trial users, and treats every query failure as "don't show".
  const maybeShowProNudge = useCallback(async () => {
    try {
      if (localStorage.getItem("proNudgeShown") === "true") return;
      if (!isMountedRef.current) return;
      const state = audioManagerRef.current?.getState?.();
      if (state?.isRecording || state?.isProcessing || state?.isStreaming) return;
      const status = await window.electronAPI?.licenseGetStatus?.();
      if (!status || status.success === false || status.isActive === true) return;
      const stats = await window.electronAPI?.getTranscriptionStats?.();
      const totalEntries = Number(stats?.totalEntries);
      if (!Number.isFinite(totalEntries) || totalEntries < PRO_NUDGE_MIN_DICTATIONS) return;
      if (!isMountedRef.current) return;
      const latestState = audioManagerRef.current?.getState?.();
      if (latestState?.isRecording || latestState?.isProcessing || latestState?.isStreaming) return;
      localStorage.setItem("proNudgeShown", "true");
      toast({
        title: t("hooks.audioRecording.proNudge.title", { total: totalEntries }),
        description: t("hooks.audioRecording.proNudge.description"),
        duration: 10000,
        action: createElement(
          "button",
          {
            type: "button",
            className:
              "shrink-0 rounded-[4px] border border-white/10 bg-white/8 px-2 py-1 text-[10px] font-medium text-white/85 transition-colors hover:bg-white/14",
            onClick: () => {
              void window.electronAPI?.openControlPanelSection?.("account");
            },
          },
          t("hooks.audioRecording.proNudge.action")
        ),
      });
    } catch {
      /* the nudge must never affect the dictation flow */
    }
  }, [t, toast]);

  // Let the stellar completion finish before an optional growth toast takes
  // over the floating window. The timer is cancelled by a new dictation,
  // cancellation, error, or unmount, so it cannot appear over active work.
  const scheduleProNudge = useCallback(() => {
    clearDeferredProNudge();
    const timerId = setTimeout(() => {
      deferredProNudgeTimerRef.current = null;
      if (!isMountedRef.current || pendingCompletionCancelledRef.current) return;
      void maybeShowProNudge();
    }, SUCCESS_FX_GUARD_MS);
    deferredProNudgeTimerRef.current = timerId;
  }, [clearDeferredProNudge, maybeShowProNudge]);

  const performStartRecording = useCallback(
    async (profileId = "primary") => {
      // Any direct start supersedes a deferred toast retry. The deferred path
      // clears itself before calling here, while a hotkey/manual start prevents
      // the old toast from launching a second, ghost recording later.
      cancelPendingRetryStart();
      if (systemRecoveryInProgressRef.current) {
        toast({
          title: t("hooks.audioRecording.systemRecovery.recoveringTitle"),
          description: t("hooks.audioRecording.systemRecovery.recoveringDescription"),
          variant: "default",
        });
        return false;
      }
      if (startLockRef.current) return false;
      startLockRef.current = true;
      const startAbortController =
        typeof AbortController === "function" ? new AbortController() : null;
      startAbortControllerRef.current = startAbortController;
      setIsStarting(true);
      try {
        if (!audioManagerRef.current) {
          logger.warn(
            "performStartRecording skipped because audioManager is unavailable",
            {
              profileId,
            },
            "dictation"
          );
          return false;
        }
        // Reject before touching any state: a start that arrives while a
        // recording or transcription is still active must not clear the
        // pending-cancellation flag (the only guard that keeps a cancelled
        // transcription from pasting later) or wipe the in-flight UI.
        const currentState = audioManagerRef.current.getState();
        logger.debug(
          "performStartRecording invoked",
          {
            profileId,
            currentState,
            useLocalStreaming: audioManagerRef.current.shouldUseLocalStreaming(),
            useStreaming: audioManagerRef.current.shouldUseStreaming(),
          },
          "dictation"
        );
        if (currentState.isRecording || currentState.isProcessing) {
          logger.debug(
            "performStartRecording ignored because recording is already active",
            {
              profileId,
              currentState,
            },
            "dictation"
          );
          if (currentState.isProcessing && !currentState.isRecording) {
            // Push-to-talk pressed while the previous dictation is still
            // transcribing: nothing records, so tell the user now instead of
            // letting them dictate into the void.
            toast({
              title: t("hooks.audioRecording.previousStillProcessing.title"),
              description: t("hooks.audioRecording.previousStillProcessing.description"),
              duration: 4000,
            });
          }
          return false;
        }
        resetPendingCompletionCancellation();
        cancelActivePasteRequest();
        dismissToast?.();
        clearSuccessFeedback();
        setTranscript("");
        setPartialTranscriptImmediate("");
        setAudioLevel(0);
        setDictationStage("starting");
        audioManagerRef.current.setActiveHotkeyProfile?.(profileId);
        await playStartCueWithCancellation(startAbortController?.signal);

        // Push-to-talk can be released while the start cue is still playing.
        // Honour that release before touching the microphone or model service.
        if (startAbortController?.signal.aborted || pendingCompletionCancelledRef.current) {
          logger.debug(
            "Recording startup cancelled before microphone acquisition",
            { profileId },
            "dictation"
          );
          setDictationStage("idle");
          return false;
        }

        let didStart = false;
        let usedDirectBatchStart = false;

        if (audioManagerRef.current.shouldUseLocalStreaming()) {
          didStart = await audioManagerRef.current.startLocalStreamingRecording();

          if (!didStart) {
            const failure = audioManagerRef.current.getLastLocalStreamingStartFailure?.();
            const modelMissingFailure = /model not downloaded/i.test(
              String(failure?.error || failure?.description || "")
            );
            logger.warn(
              "Local streaming start failed, falling back to batch recording",
              {
                profileId,
                failureTitle: failure?.title || null,
                failureDescription: failure?.description || null,
                failureError: failure?.error || null,
                requestedModelId: failure?.requestedModelId || null,
                modelsDir: failure?.modelsDir || null,
                useLocalStreaming: audioManagerRef.current.shouldUseLocalStreaming(),
              },
              "audio"
            );
            if (modelMissingFailure) {
              localStorage.setItem("useLocalStreaming", "false");
            }
            const batchFallbackRoute =
              await audioManagerRef.current.resolveLocalStreamingBatchFallbackRoute?.(failure);
            if (batchFallbackRoute) {
              audioManagerRef.current.setNextBatchFallbackRoute?.(batchFallbackRoute);
            }
            didStart = await audioManagerRef.current.startRecording();
            if (!didStart) {
              audioManagerRef.current.clearNextBatchFallbackRoute?.();
            }
            if (didStart && failure) {
              logger.info(
                "Showing local streaming fallback toast",
                {
                  profileId,
                  failureTitle: failure?.title || null,
                  failureDescription: failure?.description || null,
                  failureError: failure?.error || null,
                  requestedModelId: failure?.requestedModelId || null,
                  modelsDir: failure?.modelsDir || null,
                  modelMissingFailure,
                  batchFallbackRoute: batchFallbackRoute || null,
                },
                "audio",
                "renderer"
              );
              toast({
                title: t("controlPanel.streamingFallback.title"),
                description: t("controlPanel.streamingFallback.description", {
                  reason: failure.description || failure.error || t("common.unknown"),
                }),
                // A missing model is fixable in one click — take the user to the
                // transcription settings instead of leaving a dead-end toast.
                action: modelMissingFailure
                  ? createElement(
                      "button",
                      {
                        type: "button",
                        className:
                          "shrink-0 rounded-[4px] border border-white/10 bg-white/8 px-2 py-1 text-[10px] font-medium text-white/85 transition-colors hover:bg-white/14",
                        onClick: () => {
                          void window.electronAPI?.openControlPanelSection?.("transcription");
                        },
                      },
                      t("hooks.audioRecording.modelMissingAction")
                    )
                  : undefined,
                variant: "default",
                duration: 6500,
              });
            }
          }
        } else if (audioManagerRef.current.shouldUseStreaming()) {
          didStart = await audioManagerRef.current.startStreamingRecording();
        } else {
          didStart = await audioManagerRef.current.startRecording();
          usedDirectBatchStart = didStart;
        }

        if (pendingCompletionCancelledRef.current) {
          logger.debug(
            "Recording startup completed after cancellation request; cleaning up",
            { profileId, didStart },
            "dictation"
          );
          if (didStart && audioManagerRef.current) {
            const stateAfterStart = audioManagerRef.current.getState();
            if (stateAfterStart.isStreaming || stateAfterStart.isStreamingStartInProgress) {
              if (audioManagerRef.current.shouldUseLocalStreaming()) {
                await audioManagerRef.current.stopLocalStreamingRecording(true);
              } else {
                await audioManagerRef.current.stopStreamingRecording(true);
              }
            } else {
              audioManagerRef.current.cancelRecording();
            }
          }
          return false;
        }

        if (didStart) {
          setDictationStage("recording");
          startLiveTranscriptPreview();
          // First-reach funnel milestone; the database keeps it idempotent, so
          // invoking on every start matches first_successful_dictation's style.
          Promise.resolve(
            window.electronAPI?.trackOnboardingEvent?.("first_dictation_attempt")
          ).catch((error) => {
            logger.warn(
              "Failed to record first_dictation_attempt milestone",
              { error: error?.message || String(error) },
              "telemetry"
            );
          });
          if (usedDirectBatchStart) {
            // Advisory preflight: warn about a missing local model while the
            // user is still speaking instead of after they finish. The
            // streaming path has its own fallback toast above.
            void (async () => {
              const missing = await audioManagerRef.current?.getMissingActiveBatchModel?.();
              if (!missing || !isMountedRef.current) return;
              toast({
                title: t("hooks.audioRecording.modelMissingPreflight.title"),
                description: t("hooks.audioRecording.modelMissingPreflight.description", {
                  model: missing.model,
                }),
                variant: "destructive",
                duration: 8000,
                action: createElement(
                  "button",
                  {
                    type: "button",
                    className:
                      "shrink-0 rounded-[4px] border border-white/10 bg-white/8 px-2 py-1 text-[10px] font-medium text-white/85 transition-colors hover:bg-white/14",
                    onClick: () => {
                      void window.electronAPI?.openControlPanelSection?.("transcription");
                    },
                  },
                  t("hooks.audioRecording.modelMissingAction")
                ),
              });
            })();
          }
        }

        logger.debug("performStartRecording completed", { profileId, didStart }, "dictation");

        return didStart;
      } catch (error) {
        logger.error(
          "performStartRecording threw an unexpected error",
          { profileId, error: error?.message || "unknown" },
          "dictation"
        );
        return false;
      } finally {
        if (startAbortControllerRef.current === startAbortController) {
          startAbortControllerRef.current = null;
        }
        setIsStarting(false);
        startLockRef.current = false;
      }
    },
    [
      cancelActivePasteRequest,
      cancelPendingRetryStart,
      clearSuccessFeedback,
      dismissToast,
      resetPendingCompletionCancellation,
      setPartialTranscriptImmediate,
      startLiveTranscriptPreview,
      t,
      toast,
    ]
  );

  const requestRetryStartWhenReady = useCallback(
    (profileId = "primary") => {
      cancelPendingRetryStart();
      const manager = audioManagerRef.current;
      if (!manager || !isMountedRef.current) {
        return false;
      }

      dismissToast?.();

      if (manager.getState?.().isReadyForRecordingStart === true) {
        void performStartRecording(profileId);
        return true;
      }

      const pending = { profileId, timeoutId: null };
      pending.timeoutId = window.setTimeout(() => {
        if (pendingRetryStartRef.current !== pending) {
          return;
        }
        pendingRetryStartRef.current = null;
        logger.warn(
          "Deferred recording retry expired before AudioManager became ready",
          { profileId, timeoutMs: RETRY_START_READY_TIMEOUT_MS },
          "dictation"
        );
        toast({
          title: t("hooks.audioRecording.failures.recording.title"),
          description: t("hooks.audioRecording.failures.recording.description"),
          variant: "destructive",
          duration: 6000,
        });
      }, RETRY_START_READY_TIMEOUT_MS);
      pendingRetryStartRef.current = pending;
      return true;
    },
    [cancelPendingRetryStart, dismissToast, performStartRecording, t, toast]
  );

  const startPendingRetryIfReady = useCallback(() => {
    const pending = pendingRetryStartRef.current;
    const manager = audioManagerRef.current;
    if (
      !pending ||
      !manager ||
      !isMountedRef.current ||
      manager.getState?.().isReadyForRecordingStart !== true
    ) {
      return false;
    }

    clearTimeout(pending.timeoutId);
    pendingRetryStartRef.current = null;
    void performStartRecording(pending.profileId);
    return true;
  }, [performStartRecording]);

  const performStopRecording = useCallback(async () => {
    if (stopLockRef.current) return false;
    stopLockRef.current = true;
    try {
      if (startLockRef.current) {
        setIsStarting(false);
        markPendingCompletionCancelled();
        clearSuccessFeedback();
        stopLiveTranscriptPreview({ keepText: false });
        setDictationStage("idle");
        setAudioLevel(0);

        if (!audioManagerRef.current) {
          return true;
        }

        const currentState = audioManagerRef.current.getState();
        if (currentState.isStreaming || currentState.isStreamingStartInProgress) {
          return audioManagerRef.current.shouldUseLocalStreaming()
            ? await audioManagerRef.current.stopLocalStreamingRecording(true)
            : await audioManagerRef.current.stopStreamingRecording(true);
        }
        if (currentState.isRecordingStartInProgress) {
          return audioManagerRef.current.cancelRecording();
        }
        return true;
      }

      if (!audioManagerRef.current) return false;

      const currentState = audioManagerRef.current.getState();

      if (currentState.isProcessing) {
        // Reached only from a push-to-talk release (toggle-mode cancel lives
        // in handleToggle's processing branch, and the overlay X goes through
        // cancelProcessing directly). Releasing the key while the previous
        // dictation is still transcribing must not kill that transcription —
        // the rejected start already told the user to wait.
        logger.debug(
          "performStopRecording ignored because a transcription is still in flight",
          {},
          "dictation"
        );
        return false;
      }

      if (
        !currentState.isRecording &&
        !currentState.isRecordingStartInProgress &&
        !currentState.isStreamingStartInProgress
      )
        return false;

      stopLiveTranscriptPreview({ keepText: true });

      if (currentState.isStreaming || currentState.isStreamingStartInProgress) {
        void playStopCue();
        // Route to the correct stop method based on streaming mode
        return audioManagerRef.current.shouldUseLocalStreaming()
          ? await audioManagerRef.current.stopLocalStreamingRecording()
          : await audioManagerRef.current.stopStreamingRecording();
      }

      const didStop = audioManagerRef.current.stopRecording();

      if (didStop) {
        void playStopCue();
      }

      return didStop;
    } finally {
      stopLockRef.current = false;
    }
  }, [clearSuccessFeedback, markPendingCompletionCancelled, stopLiveTranscriptPreview]);

  // Latest-ref bridge for the mount-once effect below. Every volatile value the
  // effect's AudioManager callbacks and IPC handlers need is mirrored here on
  // each render, so the effect can depend on [] — constructing AudioManager and
  // registering the 5 IPC listeners exactly once per mount — while its callbacks
  // always read the latest closures instead of the ones captured at mount.
  // Without this, identity churn of t / toast / the option callbacks tore down
  // and rebuilt AudioManager on every language switch or parent re-render.
  const latestRef = useRef(null);
  latestRef.current = {
    clearSuccessFeedback,
    createPendingPasteRequest,
    getCurrentPlatform,
    isPendingPasteCancelled,
    markPendingCompletionCancelled,
    scheduleProNudge,
    onLicenseRequired,
    onOverlayDismiss,
    onToggle,
    openAccessibilitySettings,
    performStartRecording,
    performStopRecording,
    requestRetryStartWhenReady,
    resolveProfileId,
    schedulePartialTranscript,
    setPartialTranscriptImmediate,
    shouldSuppressDictationHotkey,
    stopLiveTranscriptPreview,
    startPendingRetryIfReady,
    t,
    toast,
    triggerErrorFeedback,
    triggerSuccessFeedback,
    updateAudioLevel,
    waitForPasteCancellationWindow,
    confirmPaste,
    cancelPaste,
  };

  useEffect(() => {
    audioManagerRef.current = new AudioManager();

    audioManagerRef.current.setCallbacks({
      onStateChange: ({ isRecording, isProcessing, isStreaming, stage }) => {
        const { clearSuccessFeedback, setPartialTranscriptImmediate, startPendingRetryIfReady } =
          latestRef.current;
        setIsRecording(isRecording);
        setIsProcessing(isProcessing);
        setIsStreaming(isStreaming ?? false);
        if (isRecording || isProcessing || isStreaming) {
          setIsStarting(false);
        }
        if (isRecording || isProcessing) {
          clearSuccessFeedback();
        }
        if (stage) {
          if (stage !== "idle" || micFeedbackStateRef.current === "idle") {
            setDictationStage(stage);
          }
        } else if (isRecording) {
          setDictationStage("recording");
        } else if (isProcessing) {
          setDictationStage((current) =>
            current === "polishing" || current === "pasting" ? current : "transcribing"
          );
        } else if (micFeedbackStateRef.current === "idle") {
          setDictationStage("idle");
        }
        if (!isRecording && !isProcessing && !isStreaming) {
          setPartialTranscriptImmediate("");
          setAudioLevel(0);
        }
        startPendingRetryIfReady();
      },
      onError: (error) => {
        const {
          markPendingCompletionCancelled,
          clearSuccessFeedback,
          stopLiveTranscriptPreview,
          setPartialTranscriptImmediate,
          onLicenseRequired,
          t,
          getCurrentPlatform,
          openAccessibilitySettings,
          triggerErrorFeedback,
          onOverlayDismiss,
          toast,
        } = latestRef.current;
        if (error?.recoverable === true && error?.code === "LOCAL_STREAMING_START_FAILED") {
          logger.debug(
            "Recoverable local streaming startup error; waiting for batch fallback",
            { description: error?.description || "" },
            "dictation"
          );
          return;
        }

        setIsStarting(false);
        markPendingCompletionCancelled();
        clearSuccessFeedback();
        stopLiveTranscriptPreview({ keepText: false });
        setDictationStage("idle");
        setTranscript("");
        setPartialTranscriptImmediate("");
        setAudioLevel(0);
        const isLicenseRequired = error?.code === "LICENSE_REQUIRED";
        if (isLicenseRequired) {
          onLicenseRequired?.({
            title: t("app.trialExpiredModal.title"),
            description:
              error?.description || error?.message || t("app.trialExpiredModal.description"),
            licenseStatus: error?.licenseStatus || null,
          });
          return;
        }
        const requiresAccessibilityPermission =
          error?.code === "PASTE_ACCESSIBILITY_REQUIRED" ||
          error?.title === "PASTE_ACCESSIBILITY_REQUIRED" ||
          error?.requiresAccessibilityPermission === true;
        const isPasteFailed =
          requiresAccessibilityPermission ||
          error?.code === "PASTE_FAILED" ||
          error?.title === "Paste Error" ||
          error?.title === "PASTE_FAILED";
        // Rescue save: after a failed paste the text only lives in the
        // clipboard, where the next copy overwrites it. Persist it to history
        // (excluded from usage stats) so the dictation can always be recovered.
        const pasteFailedText = typeof error?.text === "string" ? error.text.trim() : "";
        if (
          isPasteFailed &&
          pasteFailedText &&
          localStorage.getItem("transcriptionHistoryEnabled") !== "false"
        ) {
          void audioManagerRef.current
            ?.saveTranscription(pasteFailedText, { excludeFromStats: true })
            .then((saveResult) => {
              if (saveResult?.success === false) {
                logger.warn(
                  "Rescue history save failed after paste failure",
                  { error: saveResult?.error || "unknown" },
                  "history"
                );
              }
            });
        }
        const isMacPasteFailureNeedingGuidance = isPasteFailed && getCurrentPlatform() === "darwin";
        const shouldShowAccessibilityGuidance =
          requiresAccessibilityPermission || isMacPasteFailureNeedingGuidance;
        const accessibilityGuidanceHandledBySystemDialog =
          error?.handledBySystemDialog === true || error?.suppressRendererToast === true;
        const normalizedErrorText =
          `${error?.title || ""} ${error?.description || ""}`.toLowerCase();
        const microphoneFailureCodes = new Set([
          "MICROPHONE_PERMISSION_DENIED",
          "MICROPHONE_NOT_FOUND",
          "MICROPHONE_NOT_READABLE",
        ]);
        const isMicrophoneFailure =
          microphoneFailureCodes.has(error?.code) || normalizedErrorText.includes("microphone");
        const isMicrophonePermissionFailure =
          error?.code === "MICROPHONE_PERMISSION_DENIED" ||
          (isMicrophoneFailure &&
            (normalizedErrorText.includes("denied") || normalizedErrorText.includes("permission")));
        const isRecordingStartFailure =
          isMicrophoneFailure ||
          error?.code === "RECORDING_START_FAILED" ||
          normalizedErrorText.includes("recording error");

        // Provide specific titles for cloud error codes
        const title =
          error?.code === "AUTH_EXPIRED"
            ? t("hooks.audioRecording.errorTitles.sessionExpired")
            : error?.code === "OFFLINE"
              ? t("hooks.audioRecording.errorTitles.offline")
              : error?.code === "LIMIT_REACHED"
                ? t("hooks.audioRecording.errorTitles.dailyLimitReached")
                : shouldShowAccessibilityGuidance
                  ? t("hooks.permissions.titles.accessibilityNeeded")
                  : isPasteFailed
                    ? t("hooks.clipboard.pasteFailed.title")
                    : isMicrophonePermissionFailure
                      ? t("hooks.permissions.titles.microphonePermissionRequired")
                      : isMicrophoneFailure
                        ? t("hooks.permissions.titles.microphoneUnavailable")
                        : isRecordingStartFailure
                          ? t("hooks.audioRecording.failures.recording.title")
                          : t("hooks.audioRecording.failures.transcription.title");

        const pasteFailedDescription =
          getCurrentPlatform() === "darwin"
            ? t("hooks.clipboard.pasteFailed.macosDescription")
            : getCurrentPlatform() === "win32"
              ? t("hooks.clipboard.pasteFailed.windowsDescription")
              : t("hooks.clipboard.pasteFailed.linuxDescription");
        const description = shouldShowAccessibilityGuidance
          ? pasteFailedDescription
          : isPasteFailed
            ? pasteFailedDescription
            : isMicrophoneFailure
              ? error?.description || t("hooks.audioRecording.failures.recording.description")
              : isRecordingStartFailure
                ? t("hooks.audioRecording.failures.recording.description")
                : t("hooks.audioRecording.failures.transcription.description", {
                    reason:
                      error?.description ||
                      error?.title ||
                      t("hooks.audioRecording.failures.transcription.unknownReason"),
                  });
        const action = shouldShowAccessibilityGuidance
          ? createElement(
              "button",
              {
                type: "button",
                className:
                  "shrink-0 rounded-[4px] border border-white/10 bg-white/8 px-2 py-1 text-[10px] font-medium text-white/85 transition-colors hover:bg-white/14",
                onClick: () => {
                  void openAccessibilitySettings();
                },
              },
              t("hooks.permissions.settingsTitles.accessibility")
            )
          : isPasteFailed
            ? undefined
            : isMicrophoneFailure
              ? createElement(
                  "button",
                  {
                    type: "button",
                    className:
                      "shrink-0 rounded-[4px] border border-white/10 bg-white/8 px-2 py-1 text-[10px] font-medium text-white/85 transition-colors hover:bg-white/14",
                    onClick: () => {
                      if (isMicrophonePermissionFailure) {
                        void window.electronAPI?.openMicrophoneSettings?.();
                      } else {
                        void window.electronAPI?.openSoundInputSettings?.();
                      }
                    },
                  },
                  isMicrophonePermissionFailure
                    ? t("hooks.audioRecording.failureActions.openMicrophoneSettings")
                    : t("hooks.audioRecording.failureActions.openSoundSettings")
                )
              : createElement(
                  "button",
                  {
                    type: "button",
                    className:
                      "shrink-0 rounded-[4px] border border-white/10 bg-white/8 px-2 py-1 text-[10px] font-medium text-white/85 transition-colors hover:bg-white/14",
                    onClick: () => {
                      latestRef.current.requestRetryStartWhenReady();
                    },
                  },
                  t("hooks.audioRecording.failureActions.retry")
                );

        const shouldShowToast = !accessibilityGuidanceHandledBySystemDialog;
        if (shouldShowToast) {
          setMicFeedbackState("idle");
          setErrorMessage("");
          setDictationStage("idle");
          onOverlayDismiss?.();
        } else {
          const fallbackMessage =
            description || title || t("hooks.audioRecording.errorTitles.transcriptionFailed");
          triggerErrorFeedback(fallbackMessage);
        }

        if (shouldShowToast) {
          toast({
            title,
            description,
            action,
            variant: "destructive",
            duration: 8000,
          });
        }
      },
      onPartialTranscript: (text) => {
        latestRef.current.schedulePartialTranscript(text);
      },
      onAudioLevel: (level) => latestRef.current.updateAudioLevel(level),
      onTranscriptionComplete: async (result) => {
        const {
          markPendingCompletionCancelled,
          clearSuccessFeedback,
          stopLiveTranscriptPreview,
          setPartialTranscriptImmediate,
          createPendingPasteRequest,
          waitForPasteCancellationWindow,
          isPendingPasteCancelled,
          triggerSuccessFeedback,
          scheduleProNudge,
          t,
          toast,
          onLicenseRequired,
        } = latestRef.current;
        if (result.success) {
          if (result.emptyTranscript || result.silentDismiss || !String(result.text || "").trim()) {
            markPendingCompletionCancelled();
            clearSuccessFeedback();
            stopLiveTranscriptPreview({ keepText: false });
            setTranscript("");
            setPartialTranscriptImmediate("");
            setAudioLevel(0);
            setDictationStage("idle");
            toast({
              title: t("hooks.audioRecording.noAudio.title"),
              description: t("hooks.audioRecording.noAudio.description"),
              action: createElement(
                "button",
                {
                  type: "button",
                  className:
                    "shrink-0 rounded-[4px] border border-white/10 bg-white/8 px-2 py-1 text-[10px] font-medium text-white/85 transition-colors hover:bg-white/14",
                  onClick: () => {
                    latestRef.current.requestRetryStartWhenReady();
                  },
                },
                t("hooks.audioRecording.failureActions.retry")
              ),
              variant: "destructive",
              duration: 8000,
            });
            return;
          }

          const tailCommandsEnabled =
            TAIL_COMMANDS_RUNTIME_ENABLED && localStorage.getItem("tailCommandsEnabled") === "true";
          if (tailCommandsEnabled) {
            const commandResult = matchTailCommand(result.text);
            if (commandResult) {
              markPendingCompletionCancelled();
              clearSuccessFeedback();
              stopLiveTranscriptPreview({ keepText: false });
              setTranscript("");
              setPartialTranscriptImmediate("");
              setAudioLevel(0);
              setDictationStage("idle");

              if (commandResult.command === "cancel") {
                toast({
                  title: t("app.toasts.dictationCancelled.title"),
                  description: t("app.toasts.dictationCancelled.description"),
                  duration: 3000,
                });
                await window.electronAPI?.hideWindow?.();
              } else if (commandResult.command === "redo") {
                toast({
                  title: t("app.toasts.dictationRestarted.title"),
                  description: t("app.toasts.dictationRestarted.description"),
                  duration: 2000,
                });
                setTimeout(() => {
                  void latestRef.current.performStartRecording();
                }, 100);
              }
              return;
            }
          }

          setTranscript(result.text);
          setPartialTranscriptImmediate("");
          setAudioLevel(0);
          stopLiveTranscriptPreview({ keepText: true });
          if (pendingCompletionCancelledRef.current) {
            setDictationStage("idle");
            return;
          }
          // Keep non-idle visual state while paste result is pending,
          // so users don't see an idle gray flash before success.
          const pendingPasteRequest = createPendingPasteRequest();
          setMicFeedbackState("pasting");
          setDictationStage("pasting");

          const isStreaming = result.source?.includes("streaming");
          const pasteStart = performance.now();
          let didPaste = false;
          let willDeferCompletionToast = false;
          try {
            await waitForPasteCancellationWindow(pendingPasteRequest, result.text);
            if (isPendingPasteCancelled(pendingPasteRequest)) {
              // When a new recording superseded this paste, its start sequence
              // owns the UI state now — resetting to idle here would stomp it.
              if (!startLockRef.current) {
                clearSuccessFeedback();
                setDictationStage("idle");
              }
              return;
            }

            didPaste = await audioManagerRef.current.safePaste(
              result.text,
              isStreaming
                ? {
                    fromStreaming: true,
                    pasteRequestId: pendingPasteRequest.requestId,
                    traceId: result.traceId,
                    source: result.source,
                  }
                : {
                    pasteRequestId: pendingPasteRequest.requestId,
                    traceId: result.traceId,
                    source: result.source,
                  }
            );

            if (isPendingPasteCancelled(pendingPasteRequest)) {
              if (!startLockRef.current) {
                clearSuccessFeedback();
                setDictationStage("idle");
              }
              return;
            }

            if (didPaste) {
              // Mirror the deferred completion-toast conditions below: when a
              // toast will follow, hold the success FX so it isn't cut off when
              // the toast takes over (and unmounts) the floating capsule window.
              const reasoningNoticeCode = result.reasoningNotice?.code;
              const reasoningPreviewRemaining = result.reasoningNotice?.previewRemaining ?? 0;
              const usedByokFallback = result.source?.includes("-byok-fallback");
              const willShowReasoningNotice =
                reasoningNoticeCode === "LICENSE_REQUIRED" ||
                reasoningNoticeCode === "REASONING_FAILED" ||
                reasoningNoticeCode === "PRO_REASONING_PREVIEW_LIMIT_REACHED" ||
                (reasoningNoticeCode === "PRO_REASONING_PREVIEW_USED" &&
                  reasoningPreviewRemaining <= 0);
              willDeferCompletionToast =
                (result.source === "openai" &&
                  localStorage.getItem("useLocalWhisper") === "true") ||
                usedByokFallback ||
                willShowReasoningNotice ||
                (reasoningNoticeCode === "PRO_REASONING_PREVIEW_USED" &&
                  reasoningPreviewRemaining > 0);
              triggerSuccessFeedback(willDeferCompletionToast);
            } else {
              clearSuccessFeedback();
              setDictationStage("idle");
            }
          } finally {
            if (pendingPasteRequestRef.current === pendingPasteRequest) {
              pendingPasteRequestRef.current = null;
            }
          }
          logger.info(
            "Paste timing",
            {
              pasteMs: Math.round(performance.now() - pasteStart),
              source: result.source,
              textLength: result.text.length,
            },
            "streaming"
          );

          const saveHistory = localStorage.getItem("transcriptionHistoryEnabled") !== "false";
          if (didPaste && !pendingCompletionCancelledRef.current) {
            Promise.resolve(
              window.electronAPI?.trackOnboardingEvent?.("first_successful_dictation")
            ).catch((error) => {
              logger.warn(
                "Failed to record first_successful_dictation milestone",
                { error: error?.message || String(error) },
                "telemetry"
              );
            });
          }
          if (saveHistory && didPaste && !pendingCompletionCancelledRef.current) {
            const showHistorySaveFailure = () => {
              if (!isMountedRef.current || pendingCompletionCancelledRef.current) {
                return;
              }
              if (successFeedbackTimerRef.current) {
                clearTimeout(successFeedbackTimerRef.current);
                successFeedbackTimerRef.current = null;
              }
              setMicFeedbackState("idle");
              setDictationStage("idle");
              toast({
                title: t("hooks.audioRecording.failures.historySave.title"),
                description: t("hooks.audioRecording.failures.historySave.description"),
                variant: "destructive",
                duration: 8000,
              });
            };
            void audioManagerRef.current
              .saveTranscription(result.text, {
                recordingDurationMs: result.recordingDurationMs,
              })
              .then((saveResult) => {
                if (saveResult?.success === false) {
                  showHistorySaveFailure();
                  return;
                }
                if (!willDeferCompletionToast) {
                  scheduleProNudge();
                }
              })
              .catch(showHistorySaveFailure);
          }

          // Completion toasts steal the floating window from the capsule (App
          // unmounts the capsule whenever a toast is visible). Defer them so the
          // success FX plays first, then the toast takes over the window.
          const deferCompletionToast = (toastProps) => {
            const timerId = setTimeout(() => {
              deferredCompletionToastTimersRef.current.delete(timerId);
              if (!isMountedRef.current || pendingCompletionCancelledRef.current) {
                return;
              }
              toast(toastProps);
            }, SUCCESS_FX_GUARD_MS);
            deferredCompletionToastTimersRef.current.add(timerId);
          };

          if (result.source === "openai" && localStorage.getItem("useLocalWhisper") === "true") {
            deferCompletionToast({
              title: t("hooks.audioRecording.fallback.title"),
              description: t("hooks.audioRecording.fallback.description"),
              variant: "default",
            });
          }

          if (result.source?.includes("-byok-fallback")) {
            deferCompletionToast({
              title: t("hooks.audioRecording.byokFallback.title"),
              description: t("hooks.audioRecording.byokFallback.description"),
              variant: "default",
            });
          }

          if (result.reasoningNotice?.code === "REASONING_FAILED") {
            deferCompletionToast({
              title: t("hooks.audioRecording.reasoningFailed.title"),
              description: t("hooks.audioRecording.reasoningFailed.description"),
              variant: "default",
            });
          }

          if (
            result.reasoningNotice?.code === "LICENSE_REQUIRED" ||
            result.reasoningNotice?.code === "PRO_REASONING_PREVIEW_USED" ||
            result.reasoningNotice?.code === "PRO_REASONING_PREVIEW_LIMIT_REACHED"
          ) {
            const noticeCode = result.reasoningNotice.code;
            const previewRemaining = result.reasoningNotice.previewRemaining ?? 0;
            const previewLimit =
              result.reasoningNotice.previewLimit ?? PRO_REASONING_PREVIEW_DAILY_LIMIT;
            const didUseFinalReasoningPreview =
              noticeCode === "PRO_REASONING_PREVIEW_USED" && previewRemaining <= 0;
            const isReasoningPreviewLimitNotice =
              noticeCode === "PRO_REASONING_PREVIEW_LIMIT_REACHED" || didUseFinalReasoningPreview;

            if (noticeCode === "PRO_REASONING_PREVIEW_USED" && !didUseFinalReasoningPreview) {
              // Free previews below the daily limit should stay silent.
            } else {
              const title = isReasoningPreviewLimitNotice
                ? t("hooks.audioRecording.reasoningPreviewLimit.title")
                : t("app.trialExpiredModal.title");
              const description = isReasoningPreviewLimitNotice
                ? t("hooks.audioRecording.reasoningPreviewLimit.description", {
                    limit: previewLimit,
                  })
                : t("hooks.audioRecording.reasoningRequiresPro.description");
              const effectiveNoticeCode = isReasoningPreviewLimitNotice
                ? "PRO_REASONING_PREVIEW_LIMIT_REACHED"
                : noticeCode;

              if (onLicenseRequired) {
                onLicenseRequired({
                  title,
                  description,
                  code: effectiveNoticeCode,
                  licenseStatus: result.reasoningNotice.licenseStatus || null,
                  previewDateKey: result.reasoningNotice.previewDateKey || null,
                });
              } else {
                toast({
                  title,
                  description,
                  variant: "default",
                  duration: 0,
                });
              }
            }
          }

          // Cloud usage: limit reached after this transcription
          if (
            normalizeChordVoxSource(result.source) === CHORDVOX_CLOUD_SOURCE &&
            result.limitReached
          ) {
            // Notify control panel to show UpgradePrompt dialog
            window.electronAPI?.notifyLimitReached?.({
              wordsUsed: result.wordsUsed,
              limit:
                result.wordsRemaining !== undefined
                  ? result.wordsUsed + result.wordsRemaining
                  : 2000,
            });
          } else if (
            normalizeChordVoxSource(result.source) === CHORDVOX_CLOUD_SOURCE &&
            typeof result.wordsUsed === "number" &&
            typeof result.wordsRemaining === "number" &&
            result.wordsRemaining > 0
          ) {
            // Soft landing: warn once per day at >=80% usage so hitting the
            // hard limit is never a surprise.
            const totalQuota = result.wordsUsed + result.wordsRemaining;
            const usedPercent = totalQuota > 0 ? (result.wordsUsed / totalQuota) * 100 : 0;
            const seenKey = `chordvox:cloud-usage-near-limit-seen:${new Date().toISOString().slice(0, 10)}`;
            if (usedPercent >= 80 && localStorage.getItem(seenKey) !== "1") {
              try {
                localStorage.setItem(seenKey, "1");
              } catch {
                /* best effort — worst case the warning repeats */
              }
              deferCompletionToast({
                title: t("hooks.audioRecording.usageNearLimit.title"),
                description: t("hooks.audioRecording.usageNearLimit.description", {
                  percent: Math.floor(usedPercent),
                  remaining: result.wordsRemaining.toLocaleString(),
                }),
                variant: "default",
                duration: 8000,
              });
            }
          }

          audioManagerRef.current.warmupStreamingConnection();
        }
      },
    });

    audioManagerRef.current.warmupStreamingConnection();

    if (typeof window.electronAPI?.getE2eListenerRegistrations === "function") {
      window.__CHORDVOX_E2E_PROCESS_AUDIO_BYTES = async ({
        bytes,
        mimeType = "audio/wav",
        sourceFileName = "e2e-audio.wav",
      } = {}) => {
        const byteArray = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
        const audioBlob =
          typeof File === "function"
            ? new File([byteArray], sourceFileName, { type: mimeType })
            : new Blob([byteArray], { type: mimeType });
        await audioManagerRef.current.transcribeFile(audioBlob, {
          sourceType: "file",
          sourceFileName,
          mimeType,
        });
      };
    }

    const isDuplicateDictationAction = (type) => {
      const now = Date.now();
      const last = lastDictationActionRef.current;
      if (last.type === type && now - last.at < DICTATION_REENTRY_WINDOW_MS) {
        logger.debug(
          "Dropping duplicate dictation action",
          { type, sinceLastMs: now - last.at },
          "dictation"
        );
        return true;
      }
      lastDictationActionRef.current = { type, at: now };
      return false;
    };

    const shouldIgnoreDictationHotkey = () =>
      Boolean(latestRef.current.shouldSuppressDictationHotkey?.());

    const handleToggle = async (payload) => {
      const {
        resolveProfileId,
        performStopRecording,
        performStartRecording,
        markPendingCompletionCancelled,
        clearSuccessFeedback,
        stopLiveTranscriptPreview,
      } = latestRef.current;
      if (!audioManagerRef.current) return;
      if (isDuplicateDictationAction("toggle")) return;
      const profileId = resolveProfileId(payload);
      const currentState = audioManagerRef.current.getState();
      logger.debug("Renderer received toggle-dictation", { profileId, currentState }, "dictation");

      if (startLockRef.current) {
        // A second tap/hotkey during cue or microphone startup is a cancel,
        // not a duplicate start. This matters when the renderer has not yet
        // painted the updated isStarting state.
        await performStopRecording();
      } else if (
        currentState.isRecording ||
        currentState.isRecordingStartInProgress ||
        currentState.isStreamingStartInProgress
      ) {
        if (stopLockRef.current) {
          logger.debug("Toggle ignored: stop already in flight", { profileId }, "dictation");
          return;
        }
        await performStopRecording();
      } else if (!currentState.isProcessing) {
        audioManagerRef.current.setActiveHotkeyProfile?.(profileId);
        await performStartRecording(profileId);
      } else {
        // Hotkey acts as cancel while a transcription is in flight, mirroring
        // the overlay X button so a wedged pipeline can always be dismissed.
        logger.debug(
          "Toggle while processing: cancelling transcription",
          { profileId },
          "dictation"
        );
        setIsStarting(false);
        markPendingCompletionCancelled();
        clearSuccessFeedback();
        stopLiveTranscriptPreview({ keepText: false });
        setDictationStage("idle");
        setAudioLevel(0);
        audioManagerRef.current.cancelProcessing();
      }
    };

    const handleStart = async (payload) => {
      const { resolveProfileId, performStartRecording } = latestRef.current;
      if (isDuplicateDictationAction("start")) return;
      const profileId = resolveProfileId(payload);
      logger.debug("Renderer received start-dictation", { profileId }, "dictation");
      await performStartRecording(profileId);
    };

    const handleStop = async () => {
      const { performStopRecording } = latestRef.current;
      if (isDuplicateDictationAction("stop")) return;
      logger.debug("Renderer received stop-dictation", {}, "dictation");
      await performStopRecording();
    };

    const electronAPI = window.electronAPI;

    const handleSystemSuspend = () => {
      latestRef.current.markPendingCompletionCancelled();
      const manager = audioManagerRef.current;
      if (!manager) return;
      const state = manager.getState?.() || {};
      systemSuspendInterruptedRef.current = Boolean(
        state.isRecording || state.isProcessing || state.isStreaming
      );
      systemRecoveryInProgressRef.current = true;
      setIsStarting(false);
      void manager.resetAfterSystemPowerChange?.();
    };

    const handleSystemResumeRecovering = () => {
      systemRecoveryInProgressRef.current = true;
      latestRef.current.markPendingCompletionCancelled();
      setIsStarting(false);
    };

    const handleSystemResumed = async (payload = {}) => {
      const manager = audioManagerRef.current;
      let recoveryResult = { interrupted: false };
      let degraded = payload.degraded === true;
      try {
        recoveryResult = (await manager?.resetAfterSystemPowerChange?.()) || recoveryResult;
      } catch (error) {
        degraded = true;
        logger.warn(
          "Renderer audio recovery after system resume failed",
          { error: error?.message || String(error) },
          "audio"
        );
      } finally {
        systemRecoveryInProgressRef.current = false;
      }

      const interrupted = systemSuspendInterruptedRef.current || recoveryResult.interrupted;
      systemSuspendInterruptedRef.current = false;
      if (interrupted || degraded) {
        const { t, toast } = latestRef.current;
        toast({
          title: t("hooks.audioRecording.systemRecovery.title"),
          description: degraded
            ? t("hooks.audioRecording.systemRecovery.degradedDescription")
            : t("hooks.audioRecording.systemRecovery.interruptedDescription"),
          variant: degraded ? "destructive" : "default",
        });
      }
    };

    const disposeToggle = electronAPI?.onToggleDictation?.((payload) => {
      if (shouldIgnoreDictationHotkey()) {
        logger.debug("Toggle ignored while dictation hotkeys are suppressed", {}, "dictation");
        return;
      }
      handleToggle(payload);
      latestRef.current.onToggle?.();
    });

    const disposeStart = electronAPI?.onStartDictation?.((payload) => {
      if (shouldIgnoreDictationHotkey()) {
        logger.debug("Start ignored while dictation hotkeys are suppressed", {}, "dictation");
        return;
      }
      handleStart(payload);
      latestRef.current.onToggle?.();
    });

    const disposeStop = electronAPI?.onStopDictation?.((_payload) => {
      if (shouldIgnoreDictationHotkey()) {
        logger.debug("Stop ignored while dictation hotkeys are suppressed", {}, "dictation");
        return;
      }
      handleStop();
      latestRef.current.onToggle?.();
    });

    const disposeSecondaryHotkeyLocked = electronAPI?.onSecondaryHotkeyLocked?.(() => {
      const { t, onLicenseRequired, toast } = latestRef.current;
      const title = t("settingsPage.general.hotkey.secondary.requiresProTitle");
      const description = t("settingsPage.general.hotkey.secondary.requiresProDescription");
      if (onLicenseRequired) {
        onLicenseRequired({ title, description, licenseStatus: null });
        return;
      }
      toast({ title, description, variant: "default" });
    });

    const handleNoAudioDetected = () => {
      const {
        markPendingCompletionCancelled,
        clearSuccessFeedback,
        stopLiveTranscriptPreview,
        setPartialTranscriptImmediate,
        t,
        toast,
      } = latestRef.current;
      markPendingCompletionCancelled();
      clearSuccessFeedback();
      stopLiveTranscriptPreview({ keepText: false });
      setTranscript("");
      setPartialTranscriptImmediate("");
      setAudioLevel(0);
      setDictationStage("idle");
      toast({
        title: t("hooks.audioRecording.noAudio.title"),
        description: t("hooks.audioRecording.noAudio.description"),
        action: createElement(
          "button",
          {
            type: "button",
            className:
              "shrink-0 rounded-[4px] border border-white/10 bg-white/8 px-2 py-1 text-[10px] font-medium text-white/85 transition-colors hover:bg-white/14",
            onClick: () => {
              latestRef.current.requestRetryStartWhenReady();
            },
          },
          t("hooks.audioRecording.failureActions.retry")
        ),
        variant: "destructive",
        duration: 8000,
      });
    };

    const disposeNoAudio = electronAPI?.onNoAudioDetected?.(handleNoAudioDetected);
    const disposeSystemSuspend = electronAPI?.onSystemSuspend?.(handleSystemSuspend);
    const disposeSystemResumeRecovering = electronAPI?.onSystemResumeRecovering?.(
      handleSystemResumeRecovering
    );
    const disposeSystemResumed = electronAPI?.onSystemResumed?.((payload) => {
      void handleSystemResumed(payload);
    });

    // Cleanup
    return () => {
      const { markPendingCompletionCancelled, stopLiveTranscriptPreview } = latestRef.current;
      disposeToggle?.();
      disposeStart?.();
      disposeStop?.();
      disposeSecondaryHotkeyLocked?.();
      disposeNoAudio?.();
      disposeSystemSuspend?.();
      disposeSystemResumeRecovering?.();
      disposeSystemResumed?.();
      delete window.__CHORDVOX_E2E_PROCESS_AUDIO_BYTES;
      markPendingCompletionCancelled();
      if (successFeedbackTimerRef.current) {
        clearTimeout(successFeedbackTimerRef.current);
        successFeedbackTimerRef.current = null;
      }
      stopLiveTranscriptPreview({ keepText: true });
      if (audioManagerRef.current) {
        audioManagerRef.current.cleanup();
      }
    };
    // Mount-once: AudioManager is constructed and the 5 IPC listeners are
    // registered a single time per mount, and torn down only on unmount. Every
    // volatile value the callbacks need is read fresh from latestRef.current at
    // call time (see the latestRef assignment above), so this effect must NOT
    // depend on those identities — re-running it would needlessly rebuild
    // AudioManager and re-register listeners on each render.
  }, []);

  const startRecording = async () => {
    // A long-paste confirmation window may still be counting down. Starting a
    // new recording supersedes it: cancel the pending paste so its late
    // finish() cannot clear the new recording's UI or paste stale text.
    if (resolvePastePromiseRef.current) {
      cancelPaste();
    }
    return performStartRecording();
  };

  const stopRecording = async () => {
    return performStopRecording();
  };

  const cancelRecording = async () => {
    const wasStarting = startLockRef.current || Boolean(startAbortControllerRef.current);
    setIsStarting(false);
    markPendingCompletionCancelled();
    clearSuccessFeedback();
    stopLiveTranscriptPreview({ keepText: false });
    setDictationStage("idle");
    setAudioLevel(0);
    if (audioManagerRef.current) {
      const state = audioManagerRef.current.getState();
      if (state.isStreaming || state.isStreamingStartInProgress) {
        const didCancel = await (audioManagerRef.current.shouldUseLocalStreaming()
          ? audioManagerRef.current.stopLocalStreamingRecording(true)
          : audioManagerRef.current.stopStreamingRecording(true));
        return wasStarting || didCancel;
      }
      return wasStarting || (await audioManagerRef.current.cancelRecording());
    }
    return wasStarting;
  };

  const cancelProcessing = () => {
    setIsStarting(false);
    markPendingCompletionCancelled();
    clearSuccessFeedback();
    stopLiveTranscriptPreview({ keepText: false });
    setDictationStage("idle");
    setAudioLevel(0);
    if (audioManagerRef.current) {
      return audioManagerRef.current.cancelProcessing();
    }
    return false;
  };

  const cancelPendingPaste = () => {
    setIsStarting(false);
    markPendingCompletionCancelled();
    clearSuccessFeedback();
    stopLiveTranscriptPreview({ keepText: false });
    setTranscript("");
    setPartialTranscriptImmediate("");
    setAudioLevel(0);
    setDictationStage("idle");
    if (audioManagerRef.current) {
      return audioManagerRef.current.cancelProcessing();
    }
    return false;
  };

  const toggleListening = async () => {
    if (isStarting) {
      await cancelRecording();
    } else if (!isRecording && !isProcessing) {
      await startRecording();
    } else if (isRecording) {
      await stopRecording();
    }
  };

  const warmupStreaming = useCallback((opts) => {
    audioManagerRef.current?.warmupStreamingConnection(opts);
  }, []);

  return {
    isRecording,
    isProcessing,
    isStreaming,
    isStarting,
    dictationStage,
    micFeedbackState,
    errorMessage,
    audioLevel,
    isSuccessFeedback: micFeedbackState === "success",
    transcript,
    partialTranscript,
    startRecording,
    stopRecording,
    cancelRecording,
    cancelProcessing,
    cancelPendingPaste,
    toggleListening,
    warmupStreaming,
    pasteCountdown,
    pendingPasteText,
    confirmPaste,
    cancelPaste,
  };
};
