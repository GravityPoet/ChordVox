import { createElement, useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import AudioManager from "../helpers/audioManager";
import logger from "../utils/logger";
import { CHORDVOX_CLOUD_SOURCE, normalizeChordVoxSource } from "../utils/chordvoxCloud";
import { playStartCue, playStopCue } from "../utils/dictationCues";

const SUCCESS_FEEDBACK_DURATION_MS = 1200;

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
  const [micFeedbackState, setMicFeedbackState] = useState("idle"); // idle | pasting | success
  const [transcript, setTranscript] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");
  const [audioLevel, setAudioLevel] = useState(0);
  const audioManagerRef = useRef(null);
  const previewRecognitionRef = useRef(null);
  const previewActiveRef = useRef(false);
  const micFeedbackStateRef = useRef("idle");
  const startLockRef = useRef(false);
  const stopLockRef = useRef(false);
  const successFeedbackTimerRef = useRef(null);
  const { onToggle, onLicenseRequired } = options;
  const resolveProfileId = useCallback(
    (payload) => (payload?.profileId === "secondary" ? "secondary" : "primary"),
    []
  );
  const clearSuccessFeedback = useCallback(() => {
    if (successFeedbackTimerRef.current) {
      clearTimeout(successFeedbackTimerRef.current);
      successFeedbackTimerRef.current = null;
    }
    setMicFeedbackState("idle");
  }, []);
  const openAccessibilitySettings = useCallback(async () => {
    try {
      await window.electronAPI?.openAccessibilitySettings?.();
    } catch (error) {
      logger.error("Failed to open accessibility settings", error, "permissions");
    }
  }, []);
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
  const stopLiveTranscriptPreview = useCallback(({ keepText = true } = {}) => {
    previewActiveRef.current = false;

    const recognition = previewRecognitionRef.current;
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      previewRecognitionRef.current = null;
      try {
        recognition.stop();
      } catch {
        // Ignore stop errors from already-ended preview sessions.
      }
    }

    if (!keepText) {
      setPartialTranscript("");
    }
  }, []);

  const startLiveTranscriptPreview = useCallback(() => {
    const audioManager = audioManagerRef.current;
    if (
      !audioManager ||
      audioManager.shouldUseStreaming() ||
      audioManager.shouldUseLocalStreaming()
    ) {
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
          setPartialTranscript(normalizedText);
        }
      };

      recognition.onerror = (event) => {
        const errorCode = event?.error || "unknown";
        if (errorCode === "aborted" || errorCode === "no-speech") {
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
  }, [stopLiveTranscriptPreview]);

  const triggerSuccessFeedback = useCallback(() => {
    if (successFeedbackTimerRef.current) {
      clearTimeout(successFeedbackTimerRef.current);
      successFeedbackTimerRef.current = null;
    }
    setMicFeedbackState("success");
    setDictationStage("completed");
    successFeedbackTimerRef.current = setTimeout(() => {
      successFeedbackTimerRef.current = null;
      setMicFeedbackState("idle");
      setDictationStage("idle");
    }, SUCCESS_FEEDBACK_DURATION_MS);
  }, []);

  const performStartRecording = useCallback(
    async (profileId = "primary") => {
      if (startLockRef.current) return false;
      startLockRef.current = true;
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
        clearSuccessFeedback();
        setTranscript("");
        setPartialTranscript("");
        setAudioLevel(0);
        setDictationStage("starting");
        audioManagerRef.current.setActiveHotkeyProfile?.(profileId);

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
          return false;
        }

        let didStart = false;

        if (audioManagerRef.current.shouldUseLocalStreaming()) {
          didStart = await audioManagerRef.current.startLocalStreamingRecording();

          if (!didStart) {
            const failure = audioManagerRef.current.getLastLocalStreamingStartFailure?.();
            logger.warn(
              "Local streaming start failed, falling back to batch recording",
              { profileId, failure: failure?.error || failure?.description || null },
              "audio"
            );
            didStart = await audioManagerRef.current.startRecording();
            if (didStart && failure) {
              toast({
                title: t("controlPanel.streamingFallback.title"),
                description: t("controlPanel.streamingFallback.description", {
                  reason: failure.description || failure.error || t("common.unknown"),
                }),
                variant: "default",
                duration: 6500,
              });
            }
          }
        } else if (audioManagerRef.current.shouldUseStreaming()) {
          didStart = await audioManagerRef.current.startStreamingRecording();
        } else {
          didStart = await audioManagerRef.current.startRecording();
        }

        if (didStart) {
          setDictationStage("recording");
          startLiveTranscriptPreview();
          void playStartCue();
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
        setIsStarting(false);
        startLockRef.current = false;
      }
    },
    [clearSuccessFeedback, startLiveTranscriptPreview, t, toast]
  );

  const performStopRecording = useCallback(async () => {
    if (stopLockRef.current) return false;
    stopLockRef.current = true;
    try {
      if (!audioManagerRef.current) return false;

      const currentState = audioManagerRef.current.getState();
      if (!currentState.isRecording && !currentState.isStreamingStartInProgress) return false;

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
  }, [stopLiveTranscriptPreview]);

  useEffect(() => {
    audioManagerRef.current = new AudioManager();

    audioManagerRef.current.setCallbacks({
      onStateChange: ({ isRecording, isProcessing, isStreaming, stage }) => {
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
          setPartialTranscript("");
          setAudioLevel(0);
        }
      },
      onError: (error) => {
        setIsStarting(false);
        clearSuccessFeedback();
        stopLiveTranscriptPreview({ keepText: false });
        setDictationStage("idle");
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
        const isMacPasteFailureNeedingGuidance = isPasteFailed && getCurrentPlatform() === "darwin";
        const shouldShowAccessibilityGuidance =
          requiresAccessibilityPermission || isMacPasteFailureNeedingGuidance;

        // Provide specific titles for cloud error codes
        const title =
          error.code === "AUTH_EXPIRED"
            ? t("hooks.audioRecording.errorTitles.sessionExpired")
            : error.code === "OFFLINE"
              ? t("hooks.audioRecording.errorTitles.offline")
              : error.code === "LIMIT_REACHED"
                ? t("hooks.audioRecording.errorTitles.dailyLimitReached")
                : shouldShowAccessibilityGuidance
                  ? t("hooks.permissions.titles.accessibilityNeeded")
                  : isPasteFailed
                    ? t("hooks.clipboard.pasteFailed.title")
                    : error.title;

        const pasteFailedDescription =
          getCurrentPlatform() === "darwin"
            ? t("hooks.clipboard.pasteFailed.macosDescription")
            : getCurrentPlatform() === "win32"
              ? t("hooks.clipboard.pasteFailed.windowsDescription")
              : t("hooks.clipboard.pasteFailed.linuxDescription");
        const description = shouldShowAccessibilityGuidance
          ? t("hooks.permissions.descriptions.accessibilityNeeded")
          : isPasteFailed
            ? pasteFailedDescription
            : error.description;
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
          : undefined;

        toast({
          title,
          description,
          action,
          variant: "destructive",
          duration: error.code === "AUTH_EXPIRED" ? 8000 : undefined,
        });
      },
      onPartialTranscript: (text) => {
        setPartialTranscript(text);
      },
      onAudioLevel: (level) => {
        setAudioLevel(level || 0);
      },
      onTranscriptionComplete: async (result) => {
        if (result.success) {
          setTranscript(result.text);
          setPartialTranscript("");
          setAudioLevel(0);
          stopLiveTranscriptPreview({ keepText: true });
          // Keep non-idle visual state while paste result is pending,
          // so users don't see an idle gray flash before success.
          setMicFeedbackState("pasting");
          setDictationStage("pasting");

          const isStreaming = result.source?.includes("streaming");
          const pasteStart = performance.now();
          const didPaste = await audioManagerRef.current.safePaste(
            result.text,
            isStreaming
              ? { fromStreaming: true, traceId: result.traceId, source: result.source }
              : { traceId: result.traceId, source: result.source }
          );
          if (didPaste) {
            triggerSuccessFeedback();
          } else {
            clearSuccessFeedback();
            setDictationStage("idle");
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
          if (saveHistory) {
            audioManagerRef.current.saveTranscription(result.text, {
              recordingDurationMs: result.recordingDurationMs,
            });
          }

          if (result.source === "openai" && localStorage.getItem("useLocalWhisper") === "true") {
            toast({
              title: t("hooks.audioRecording.fallback.title"),
              description: t("hooks.audioRecording.fallback.description"),
              variant: "default",
            });
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
          }

          audioManagerRef.current.warmupStreamingConnection();
        }
      },
    });

    audioManagerRef.current.warmupStreamingConnection();

    const handleToggle = async (payload) => {
      if (!audioManagerRef.current) return;
      const profileId = resolveProfileId(payload);
      const currentState = audioManagerRef.current.getState();
      logger.debug("Renderer received toggle-dictation", { profileId, currentState }, "dictation");

      if (!currentState.isRecording && !currentState.isProcessing) {
        audioManagerRef.current.setActiveHotkeyProfile?.(profileId);
        await performStartRecording(profileId);
      } else if (currentState.isRecording) {
        await performStopRecording();
      }
    };

    const handleStart = async (payload) => {
      const profileId = resolveProfileId(payload);
      logger.debug("Renderer received start-dictation", { profileId }, "dictation");
      await performStartRecording(profileId);
    };

    const handleStop = async () => {
      logger.debug("Renderer received stop-dictation", {}, "dictation");
      await performStopRecording();
    };

    const disposeToggle = window.electronAPI.onToggleDictation((payload) => {
      handleToggle(payload);
      onToggle?.();
    });

    const disposeStart = window.electronAPI.onStartDictation?.((payload) => {
      handleStart(payload);
      onToggle?.();
    });

    const disposeStop = window.electronAPI.onStopDictation?.((_payload) => {
      handleStop();
      onToggle?.();
    });

    const handleNoAudioDetected = () => {
      toast({
        title: t("hooks.audioRecording.noAudio.title"),
        description: t("hooks.audioRecording.noAudio.description"),
        variant: "default",
      });
    };

    const disposeNoAudio = window.electronAPI.onNoAudioDetected?.(handleNoAudioDetected);

    // Cleanup
    return () => {
      disposeToggle?.();
      disposeStart?.();
      disposeStop?.();
      disposeNoAudio?.();
      clearSuccessFeedback();
      stopLiveTranscriptPreview({ keepText: false });
      if (audioManagerRef.current) {
        audioManagerRef.current.cleanup();
      }
    };
  }, [
    clearSuccessFeedback,
    onToggle,
    performStartRecording,
    performStopRecording,
    resolveProfileId,
    t,
    toast,
    triggerSuccessFeedback,
    onLicenseRequired,
    openAccessibilitySettings,
    getCurrentPlatform,
    stopLiveTranscriptPreview,
  ]);

  const startRecording = async () => {
    return performStartRecording();
  };

  const stopRecording = async () => {
    return performStopRecording();
  };

  const cancelRecording = async () => {
    setIsStarting(false);
    clearSuccessFeedback();
    stopLiveTranscriptPreview({ keepText: false });
    setDictationStage("idle");
    setAudioLevel(0);
    if (audioManagerRef.current) {
      const state = audioManagerRef.current.getState();
      if (state.isStreaming || state.isStreamingStartInProgress) {
        return audioManagerRef.current.shouldUseLocalStreaming()
          ? await audioManagerRef.current.stopLocalStreamingRecording(true)
          : await audioManagerRef.current.stopStreamingRecording(true);
      }
      return audioManagerRef.current.cancelRecording();
    }
    return false;
  };

  const cancelProcessing = () => {
    setIsStarting(false);
    clearSuccessFeedback();
    stopLiveTranscriptPreview({ keepText: false });
    setDictationStage("idle");
    setAudioLevel(0);
    if (audioManagerRef.current) {
      return audioManagerRef.current.cancelProcessing();
    }
    return false;
  };

  const toggleListening = async () => {
    if (!isRecording && !isProcessing) {
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
    audioLevel,
    isSuccessFeedback: micFeedbackState === "success",
    transcript,
    partialTranscript,
    startRecording,
    stopRecording,
    cancelRecording,
    cancelProcessing,
    toggleListening,
    warmupStreaming,
  };
};
