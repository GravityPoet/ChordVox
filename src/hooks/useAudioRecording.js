import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import AudioManager from "../helpers/audioManager";
import logger from "../utils/logger";
import { playStartCue, playStopCue } from "../utils/dictationCues";

const SUCCESS_FEEDBACK_DURATION_MS = 1200;

export const useAudioRecording = (toast, options = {}) => {
  const { t } = useTranslation();
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [micFeedbackState, setMicFeedbackState] = useState("idle"); // idle | pasting | success
  const [transcript, setTranscript] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");
  const audioManagerRef = useRef(null);
  const startLockRef = useRef(false);
  const stopLockRef = useRef(false);
  const successFeedbackTimerRef = useRef(null);
  const { onToggle } = options;
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
  const triggerSuccessFeedback = useCallback(() => {
    if (successFeedbackTimerRef.current) {
      clearTimeout(successFeedbackTimerRef.current);
      successFeedbackTimerRef.current = null;
    }
    setMicFeedbackState("success");
    successFeedbackTimerRef.current = setTimeout(() => {
      successFeedbackTimerRef.current = null;
      setMicFeedbackState("idle");
    }, SUCCESS_FEEDBACK_DURATION_MS);
  }, []);

  const performStartRecording = useCallback(async (profileId = "primary") => {
    if (startLockRef.current) return false;
    startLockRef.current = true;
    try {
      if (!audioManagerRef.current) return false;
      clearSuccessFeedback();
      audioManagerRef.current.setActiveHotkeyProfile?.(profileId);

      const currentState = audioManagerRef.current.getState();
      if (currentState.isRecording || currentState.isProcessing) return false;

      const didStart = audioManagerRef.current.shouldUseStreaming()
        ? await audioManagerRef.current.startStreamingRecording()
        : await audioManagerRef.current.startRecording();

      if (didStart) {
        void playStartCue();
      }

      return didStart;
    } finally {
      startLockRef.current = false;
    }
  }, [clearSuccessFeedback]);

  const performStopRecording = useCallback(async () => {
    if (stopLockRef.current) return false;
    stopLockRef.current = true;
    try {
      if (!audioManagerRef.current) return false;

      const currentState = audioManagerRef.current.getState();
      if (!currentState.isRecording && !currentState.isStreamingStartInProgress) return false;

      if (currentState.isStreaming || currentState.isStreamingStartInProgress) {
        void playStopCue();
        return await audioManagerRef.current.stopStreamingRecording();
      }

      const didStop = audioManagerRef.current.stopRecording();

      if (didStop) {
        void playStopCue();
      }

      return didStop;
    } finally {
      stopLockRef.current = false;
    }
  }, []);

  useEffect(() => {
    audioManagerRef.current = new AudioManager();

    audioManagerRef.current.setCallbacks({
      onStateChange: ({ isRecording, isProcessing, isStreaming }) => {
        setIsRecording(isRecording);
        setIsProcessing(isProcessing);
        setIsStreaming(isStreaming ?? false);
        if (isRecording || isProcessing) {
          clearSuccessFeedback();
        }
        if (!isStreaming) {
          setPartialTranscript("");
        }
      },
      onError: (error) => {
        clearSuccessFeedback();
        const isPasteFailed =
          error?.code === "PASTE_FAILED" ||
          error?.title === "Paste Error" ||
          error?.title === "PASTE_FAILED";

        // Provide specific titles for cloud error codes
        const title =
          error.code === "AUTH_EXPIRED"
            ? t("hooks.audioRecording.errorTitles.sessionExpired")
            : error.code === "OFFLINE"
              ? t("hooks.audioRecording.errorTitles.offline")
              : error.code === "LIMIT_REACHED"
                ? t("hooks.audioRecording.errorTitles.dailyLimitReached")
                : isPasteFailed
                  ? t("hooks.clipboard.pasteFailed.title")
                  : error.title;

        const description = isPasteFailed
          ? t("hooks.clipboard.pasteFailed.description")
          : error.description;

        toast({
          title,
          description,
          variant: "destructive",
          duration: error.code === "AUTH_EXPIRED" ? 8000 : undefined,
        });
      },
      onPartialTranscript: (text) => {
        setPartialTranscript(text);
      },
      onTranscriptionComplete: async (result) => {
        if (result.success) {
          setTranscript(result.text);
          // Keep non-idle visual state while paste result is pending,
          // so users don't see an idle gray flash before success.
          setMicFeedbackState("pasting");

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
            audioManagerRef.current.saveTranscription(result.text);
          }

          if (result.source === "openai" && localStorage.getItem("useLocalWhisper") === "true") {
            toast({
              title: t("hooks.audioRecording.fallback.title"),
              description: t("hooks.audioRecording.fallback.description"),
              variant: "default",
            });
          }

          // Cloud usage: limit reached after this transcription
          if (result.source === "openwhispr" && result.limitReached) {
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

      if (!currentState.isRecording && !currentState.isProcessing) {
        audioManagerRef.current.setActiveHotkeyProfile?.(profileId);
        await performStartRecording(profileId);
      } else if (currentState.isRecording) {
        await performStopRecording();
      }
    };

    const handleStart = async (payload) => {
      const profileId = resolveProfileId(payload);
      await performStartRecording(profileId);
    };

    const handleStop = async () => {
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
  ]);

  const startRecording = async () => {
    return performStartRecording();
  };

  const stopRecording = async () => {
    return performStopRecording();
  };

  const cancelRecording = async () => {
    clearSuccessFeedback();
    if (audioManagerRef.current) {
      const state = audioManagerRef.current.getState();
      if (state.isStreaming) {
        return await audioManagerRef.current.stopStreamingRecording();
      }
      return audioManagerRef.current.cancelRecording();
    }
    return false;
  };

  const cancelProcessing = () => {
    clearSuccessFeedback();
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
    micFeedbackState,
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
