import React, { useState, useEffect, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import "./index.css";
import { Check, Mic, X } from "lucide-react";
import { useToast } from "./components/ui/Toast";
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
import { useAudioRecording } from "./hooks/useAudioRecording";
import { useAuth } from "./hooks/useAuth";

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));

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

  const segments = normalized
    .split(/[\n。！？!?]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const latestSegment = segments.at(-1) || normalized;

  if (getDisplayUnits(latestSegment) <= maxUnits) {
    return latestSegment;
  }

  const chars = Array.from(latestSegment);
  let collected = "";
  let units = 0;

  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const next = chars[index] + collected;
    const nextUnits = getDisplayUnits(next);
    if (nextUnits > maxUnits) {
      break;
    }
    collected = next;
    units = nextUnits;
  }

  return units < getDisplayUnits(latestSegment) ? `…${collected}` : collected;
};

const IDLE_AUTO_HIDE_DELAY_MS = 1200;
const NO_SPEECH_AUTO_HIDE_DELAY_MS = 5 * 60 * 1000;
const NO_SPEECH_AUDIO_LEVEL_THRESHOLD = 0.04;
const ACTIVE_PILL_WINDOW_SIZE = { width: 492, height: 88 };

const WAVEFORM_VARIANTS = {
  line: { bars: 17, barWidth: 5, clusterWidth: 196, sparkles: 0 },
  level: { bars: 13, barWidth: 6, clusterWidth: 178, sparkles: 0 },
  particles: { bars: 15, barWidth: 5, clusterWidth: 188, sparkles: 0 },
};

const WAVEFORM_PALETTES = {
  recording: ["#ff7a5c", "#ff49b7", "#9c68ff"],
  neutral: ["#9a8dff", "#7e92ff", "#63baf7"],
};

const hexToRgb = (hex) => {
  const normalized = hex.replace("#", "");
  const expanded =
    normalized.length === 3
      ? normalized
          .split("")
          .map((value) => value + value)
          .join("")
      : normalized;
  const int = Number.parseInt(expanded, 16);

  return {
    r: (int >> 16) & 255,
    g: (int >> 8) & 255,
    b: int & 255,
  };
};

const mixHex = (from, to, amount) => {
  const source = hexToRgb(from);
  const target = hexToRgb(to);
  const blend = clamp(amount);

  const channel = (start, end) => Math.round(start + (end - start) * blend);
  return `rgb(${channel(source.r, target.r)}, ${channel(source.g, target.g)}, ${channel(source.b, target.b)})`;
};

const toRgba = (color, alpha) => {
  if (color.startsWith("rgb(")) {
    const values = color
      .replace("rgb(", "")
      .replace(")", "")
      .split(",")
      .map((value) => Number.parseInt(value.trim(), 10));
    return `rgba(${values[0]}, ${values[1]}, ${values[2]}, ${alpha})`;
  }

  const { r, g, b } = hexToRgb(color);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const getPalette = (tone) => WAVEFORM_PALETTES[tone] || WAVEFORM_PALETTES.neutral;

const pickPaletteColor = (palette, position) => {
  const clamped = clamp(position);

  if (clamped <= 0.5) {
    return mixHex(palette[0], palette[1], clamped / 0.5);
  }

  return mixHex(palette[1], palette[2], (clamped - 0.5) / 0.5);
};

const DictationSparkles = ({ count, tone }) => {
  if (!count) {
    return null;
  }

  const palette = getPalette(tone);

  return (
    <div className={`dictation-sparkles dictation-sparkles--${tone}`} aria-hidden="true">
      {[...Array(count)].map((_, index) => {
        const t = (index + 1) / (count + 1);
        const color = pickPaletteColor(palette, t);
        const side = index % 2 === 0 ? -1 : 1;
        const x = Math.round((t - 0.5) * 188 + side * (10 + (index % 3) * 7));
        const y = 6 + (index % 4) * 5;
        const rise = 18 + (index % 5) * 7;
        const driftX = side * (8 + (index % 4) * 4);

        return (
          <span
            key={index}
            className="dictation-sparkles__particle"
            style={{
              "--spark-x": `${x}px`,
              "--spark-y": `${y}px`,
              "--spark-rise": `${rise}px`,
              "--spark-drift-x": `${driftX}px`,
              "--spark-scale": `${0.75 + (index % 4) * 0.14}`,
              background: color,
              boxShadow: `0 0 12px ${toRgba(color, 0.6)}`,
              animationDelay: `${(index % 6) * 0.22}s`,
              animationDuration: `${2.3 + (index % 4) * 0.25}s`,
            }}
          />
        );
      })}
    </div>
  );
};

const DictationAnimation = ({ style, tone, level = 0 }) => {
  const variant = WAVEFORM_VARIANTS[style] || WAVEFORM_VARIANTS.level;
  const palette = getPalette(tone);
  const isRecording = tone === "recording";
  const barType = isRecording ? "live" : "processing";
  const sparkleCount = 0;

  return (
    <div className="dictation-wave-cluster" style={{ "--wave-width": `${variant.clusterWidth}px` }}>
      <DictationSparkles count={sparkleCount} tone={tone} />
      <div className={`premium-wave premium-wave--${style} premium-wave--${tone}`}>
        <div className="premium-wave__aurora" />
        <div className="premium-wave__bars">
          {[...Array(variant.bars)].map((_, index) => {
            const center = (variant.bars - 1) / 2;
            const distance = Math.abs(index - center) / Math.max(center, 1);
            const envelope = Math.pow(Math.cos((distance * Math.PI) / 2), 1.35);
            const tint = pickPaletteColor(palette, index / Math.max(variant.bars - 1, 1));

            if (isRecording) {
              const ripple = Math.sin((index + 1) * 0.9) * 0.04;
              const floor = 0.18 + envelope * 0.16;
              const scale = clamp(floor + level * (0.48 + envelope * 0.82) + ripple, 0.18, 1.36);
              const opacity = clamp(0.4 + scale * 0.42, 0.48, 1);

              return (
                <span
                  key={index}
                  className={`premium-wave__bar premium-wave__bar--${barType}`}
                  style={{
                    width: `${variant.barWidth}px`,
                    transform: `scaleY(${scale.toFixed(3)})`,
                    opacity,
                    background: `linear-gradient(180deg, rgba(255, 255, 255, 0.99), ${tint})`,
                    boxShadow: `0 0 18px ${toRgba(tint, 0.28)}`,
                  }}
                />
              );
            }

            const baseScale = 0.2 + envelope * 0.22;
            const peakScale = baseScale + 0.12 + envelope * 0.1;
            const opacity = 0.38 + envelope * 0.22;

            return (
              <span
                key={index}
                className={`premium-wave__bar premium-wave__bar--${barType}`}
                style={{
                  width: `${variant.barWidth}px`,
                  "--scale-start": baseScale.toFixed(3),
                  "--scale-peak": peakScale.toFixed(3),
                  "--bar-opacity": opacity.toFixed(3),
                  background: `linear-gradient(180deg, rgba(255, 255, 255, 0.96), ${tint})`,
                  boxShadow: `0 0 14px ${toRgba(tint, 0.16)}`,
                  animationDelay: `${index * 0.045}s`,
                  animationDuration: `${1.7 + distance * 0.3}s`,
                }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
};

// Enhanced Tooltip Component
const Tooltip = ({ children, content, emoji }) => {
  const [isVisible, setIsVisible] = useState(false);

  return (
    <div className="relative inline-block">
      <div onMouseEnter={() => setIsVisible(true)} onMouseLeave={() => setIsVisible(false)}>
        {children}
      </div>
      {isVisible && (
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

export default function App() {
  const [isHovered, setIsHovered] = useState(false);
  const [isCommandMenuOpen, setIsCommandMenuOpen] = useState(false);
  const buttonRef = useRef(null);
  const pillGroupRef = useRef(null);
  const overlayChromeRef = useRef(null);
  const { toast, toastCount } = useToast();
  const { t, i18n } = useTranslation();
  const { hotkey } = useHotkey();
  const { isDragging, handleMouseDown, handleMouseUp } = useWindowDrag();
  const { isSignedIn } = useAuth();

  const [dragStartPos, setDragStartPos] = useState(null);
  const [hasDragged, setHasDragged] = useState(false);

  const [recordingAnimationStyle, setRecordingAnimationStyle] = useState(
    () => localStorage.getItem("recordingAnimationStyle") || "level"
  );
  const [trialExpiredDialog, setTrialExpiredDialog] = useState({
    open: false,
    description: "",
  });
  const [animatedAudioLevel, setAnimatedAudioLevel] = useState(0);
  const [pillWindowSize] = useState(ACTIVE_PILL_WINDOW_SIZE);
  const [keepIdleOverlayVisible, setKeepIdleOverlayVisible] = useState(false);
  const prevMicStateRef = useRef("idle");
  const idleAutoHideGraceUntilRef = useRef(0);
  const noSpeechStartedAtRef = useRef(null);

  const setWindowInteractivity = React.useCallback((shouldCapture) => {
    window.electronAPI?.setMainWindowInteractivity?.(shouldCapture);
  }, []);

  useEffect(() => {
    setWindowInteractivity(false);
    return () => setWindowInteractivity(false);
  }, [setWindowInteractivity]);

  useEffect(() => {
    const unsubscribeFallback = window.electronAPI?.onHotkeyFallbackUsed?.((data) => {
      toast({
        title: t("app.toasts.hotkeyChanged.title"),
        description: data.message,
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

    return () => {
      unsubscribeFallback?.();
      unsubscribeFailed?.();
    };
  }, [toast, t]);

  useEffect(() => {
    if (isCommandMenuOpen || toastCount > 0) {
      setWindowInteractivity(true);
    } else if (!isHovered) {
      setWindowInteractivity(false);
    }
  }, [isCommandMenuOpen, isHovered, toastCount, setWindowInteractivity]);

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
        if (style === "line" || style === "particles" || style === "level") {
          localStorage.setItem("recordingAnimationStyle", style);
          setRecordingAnimationStyle(style);
        }
      }
    );

    const handleStorage = (event) => {
      if (
        event.key === "recordingAnimationStyle" &&
        (event.newValue === "line" || event.newValue === "particles" || event.newValue === "level")
      ) {
        setRecordingAnimationStyle(event.newValue);
      }
    };

    window.addEventListener("storage", handleStorage);
    return () => {
      unsubscribeCueStyle?.();
      unsubscribeAnimationStyle?.();
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const handleDictationToggle = React.useCallback(() => {
    idleAutoHideGraceUntilRef.current = Date.now() + IDLE_AUTO_HIDE_DELAY_MS;
    setKeepIdleOverlayVisible(true);
    setIsCommandMenuOpen(false);
    setWindowInteractivity(true);
  }, [setWindowInteractivity]);

  const openPurchasePage = React.useCallback(async () => {
    const lang = encodeURIComponent(i18n.language || "en");
    const url = `https://chordvox.com/?source=feature-locked&lang=${lang}#pricing`;
    await window.electronAPI?.openExternal?.(url);
  }, [i18n.language]);

  const handleOpenLicenseSettings = React.useCallback(async () => {
    setTrialExpiredDialog({ open: false, description: "" });
    await window.electronAPI?.showDictationPanel?.();
  }, []);

  const handleTrialExpired = React.useCallback(
    ({ description }) => {
      setIsCommandMenuOpen(false);
      setTrialExpiredDialog({
        open: true,
        description: description || t("app.trialExpiredModal.description"),
      });
      setWindowInteractivity(true);
    },
    [setWindowInteractivity, t]
  );

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
    toggleListening,
    cancelRecording,
    cancelProcessing,
    warmupStreaming,
  } = useAudioRecording(toast, {
    onToggle: handleDictationToggle,
    onLicenseRequired: handleTrialExpired,
  });
  const isPastePending = micFeedbackState === "pasting";
  const isBusy = isRecording || isProcessing || isStreaming || isStarting || isPastePending;

  const getMicState = () => {
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
    let frameId;

    const animate = () => {
      setAnimatedAudioLevel((current) => {
        const target = isRecording ? audioLevel : 0;
        const next = current + (target - current) * 0.28;
        return Math.abs(next - target) < 0.01 ? target : next;
      });
      frameId = window.requestAnimationFrame(animate);
    };

    frameId = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frameId);
  }, [audioLevel, isRecording]);

  // Trigger streaming warmup when user signs in (covers first-time account creation).
  // Pass isSignedIn directly to bypass the localStorage race condition where
  // useAuth's useEffect may not have written localStorage yet.
  useEffect(() => {
    if (isSignedIn) {
      warmupStreaming({ isSignedIn: true });
    }
  }, [isSignedIn, warmupStreaming]);

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
      toastCount > 0 ||
      isCommandMenuOpen ||
      trialExpiredDialog.open
    ) {
      return undefined;
    }

    const graceRemainingMs = Math.max(0, idleAutoHideGraceUntilRef.current - Date.now());
    hideTimeout = setTimeout(() => {
      if (
        !isRecording &&
        !isProcessing &&
        !isStreaming &&
        !isStarting &&
        !isPastePending &&
        !isSuccessFeedback &&
        toastCount === 0 &&
        !isCommandMenuOpen &&
        !trialExpiredDialog.open
      ) {
        setKeepIdleOverlayVisible(false);
        window.electronAPI?.hideWindow?.();
      }
    }, graceRemainingMs);

    return () => clearTimeout(hideTimeout);
  }, [
    keepIdleOverlayVisible,
    isRecording,
    isProcessing,
    isStreaming,
    isStarting,
    isPastePending,
    isSuccessFeedback,
    isCommandMenuOpen,
    trialExpiredDialog.open,
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
    if (micState !== "success") {
      return undefined;
    }

    const successHideTimer = window.setTimeout(() => {
      setKeepIdleOverlayVisible(false);
      window.electronAPI?.hideWindow?.();
    }, 900);

    return () => window.clearTimeout(successHideTimer);
  }, [micState]);

  const handleClose = () => {
    setIsCommandMenuOpen(false);
    void window.electronAPI?.hideCommandMenu?.();
    setKeepIdleOverlayVisible(false);
    window.electronAPI.hideWindow();
  };

  useEffect(() => {
    const handleKeyPress = (e) => {
      if (e.key === "Escape") {
        if (isCommandMenuOpen) {
          setIsCommandMenuOpen(false);
          void window.electronAPI?.hideCommandMenu?.();
        } else {
          handleClose();
        }
      }
    };

    document.addEventListener("keydown", handleKeyPress);
    return () => document.removeEventListener("keydown", handleKeyPress);
  }, [isCommandMenuOpen]);

  useEffect(() => {
    void window.electronAPI?.updateCommandMenuState?.({
      isRecording,
      canStop: isRecording || isProcessing || isStarting || isStreaming || isPastePending,
    });
  }, [isPastePending, isProcessing, isRecording, isStarting, isStreaming]);

  const hasExpandedOverlay =
    keepIdleOverlayVisible ||
    micState === "starting" ||
    micState === "recording" ||
    micState === "processing" ||
    micState === "success";
  const shouldUseCompactOverlayShell =
    hasExpandedOverlay && toastCount === 0 && !trialExpiredDialog.open;

  useEffect(() => {
    const resizeWindow = () => {
      if (toastCount > 0) {
        window.electronAPI?.resizeMainWindow?.("WITH_TOAST");
      } else if (hasExpandedOverlay) {
        window.electronAPI?.resizeMainWindow?.(pillWindowSize);
      } else {
        window.electronAPI?.resizeMainWindow?.("BASE");
      }
    };
    resizeWindow();
  }, [hasExpandedOverlay, pillWindowSize, toastCount]);

  const cleanedPartialTranscript = partialTranscript?.trim() || "";
  const cleanedTranscript = transcript?.trim() || "";
  const visualTone = micState === "recording" ? "recording" : "neutral";

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
      return cleanedTranscript || cleanedPartialTranscript || t("app.mic.placeholder.transcribing");
    }
    if (micState === "success") {
      return cleanedTranscript || cleanedPartialTranscript || t("app.mic.placeholder.completed");
    }
    if (keepIdleOverlayVisible) {
      return t("app.mic.hotkeyToSpeak", { hotkey });
    }
    return "";
  }, [
    cleanedPartialTranscript,
    cleanedTranscript,
    dictationStage,
    hotkey,
    isStarting,
    keepIdleOverlayVisible,
    micState,
    t,
  ]);

  const overlayDisplayText = useMemo(() => getTrailingDisplayText(overlayText, 18), [overlayText]);

  const overlayTextWidth = 150;
  const expandedOverlayWidth = 452;

  const dismissOverlay = React.useCallback(async () => {
    setIsCommandMenuOpen(false);
    setKeepIdleOverlayVisible(false);
    setWindowInteractivity(false);

    if (isRecording) {
      await cancelRecording();
    } else if (isProcessing || isStarting || isStreaming || isPastePending) {
      cancelProcessing();
    }
    await window.electronAPI?.hideWindow?.();
  }, [
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

  useEffect(() => {
    const transitionedToSuccess = prevMicStateRef.current !== "success" && micState === "success";
    prevMicStateRef.current = micState;

    if (!transitionedToSuccess) {
      return;
    }

    const completedText = (cleanedTranscript || cleanedPartialTranscript || "").trim();
    localStorage.setItem("onboardingLastDictationSuccessAt", String(Date.now()));
    if (completedText) {
      localStorage.setItem("onboardingLastDictationText", completedText.slice(0, 280));
    } else {
      localStorage.removeItem("onboardingLastDictationText");
    }
  }, [cleanedPartialTranscript, cleanedTranscript, micState]);

  const getMicButtonProps = () => {
    const baseClasses = "relative transition-all duration-300";

    switch (micState) {
      case "idle":
      case "hover":
        if (keepIdleOverlayVisible) {
          return {
            className: `${baseClasses} dictation-pill-shell dictation-pill-shell--neutral dictation-pill-shell--idle cursor-pointer`,
            tooltip: t("app.mic.hotkeyToSpeak", { hotkey }),
          };
        }
        return {
          className: "pointer-events-none h-0 w-0 opacity-0",
          tooltip: t("app.mic.hotkeyToSpeak", { hotkey }),
        };
      case "starting":
        return {
          className: `${baseClasses} dictation-pill-shell dictation-pill-shell--${visualTone} cursor-pointer`,
          tooltip: t("app.mic.starting"),
        };
      case "recording":
        return {
          className: `${baseClasses} dictation-pill-shell dictation-pill-shell--${visualTone} cursor-pointer`,
          tooltip: t("app.mic.recording"),
        };
      case "processing":
        return {
          className: `${baseClasses} dictation-pill-shell dictation-pill-shell--${visualTone} cursor-pointer`,
          tooltip: t("app.buttons.cancelProcessing"),
        };
      case "success":
        return {
          className: `${baseClasses} dictation-pill-shell dictation-pill-shell--neutral mic-success-shell`,
          tooltip: t("app.mic.clickToSpeak"),
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
    <div className="dictation-window">
      <Dialog
        open={trialExpiredDialog.open}
        onOpenChange={(open) => {
          setTrialExpiredDialog((prev) => ({ ...prev, open }));
          if (!open && !isHovered) {
            setWindowInteractivity(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>{t("app.trialExpiredModal.title")}</DialogTitle>
            <DialogDescription>{trialExpiredDialog.description}</DialogDescription>
          </DialogHeader>
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 text-sm text-muted-foreground">
            {t("app.trialExpiredModal.valueBullets")}
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button
              variant="outline"
              onClick={() => {
                setTrialExpiredDialog({ open: false, description: "" });
                if (!isHovered) {
                  setWindowInteractivity(false);
                }
              }}
            >
              {t("app.trialExpiredModal.actions.later")}
            </Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button variant="outline" onClick={handleOpenLicenseSettings}>
                {t("app.trialExpiredModal.actions.haveKey")}
              </Button>
              <Button
                onClick={async () => {
                  await openPurchasePage();
                }}
              >
                {t("app.trialExpiredModal.actions.buyNow")}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
          className="dictation-window__chrome group relative inline-flex shrink-0 items-center justify-center gap-2"
          onMouseEnter={() => {
            setIsHovered(true);
            setWindowInteractivity(true);
          }}
          onMouseLeave={() => {
            setIsHovered(false);
            setWindowInteractivity(false);
          }}
        >
          {hasExpandedOverlay && (
            <button
              aria-label={
                isRecording ? t("app.buttons.cancelRecording") : t("app.commandMenu.hideForNow")
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
                size={12}
                strokeWidth={2.5}
                className="dictation-floating-close__icon transition-colors duration-150"
              />
            </button>
          )}
          <Tooltip content={micProps.tooltip}>
            <button
              ref={buttonRef}
              onMouseDown={(e) => {
                if (isCommandMenuOpen) {
                  void window.electronAPI?.hideCommandMenu?.();
                  setIsCommandMenuOpen(false);
                }
                setDragStartPos({ x: e.clientX, y: e.clientY });
                setHasDragged(false);
                handleMouseDown(e);
              }}
              onMouseMove={(e) => {
                if (dragStartPos && !hasDragged) {
                  const distance = Math.sqrt(
                    Math.pow(e.clientX - dragStartPos.x, 2) +
                      Math.pow(e.clientY - dragStartPos.y, 2)
                  );
                  if (distance > 5) {
                    // 5px threshold for drag
                    setHasDragged(true);
                  }
                }
              }}
              onMouseUp={(e) => {
                handleMouseUp(e);
                setDragStartPos(null);
              }}
              onClick={(e) => {
                if (!hasDragged) {
                  if (isCommandMenuOpen) {
                    void window.electronAPI?.hideCommandMenu?.();
                    setIsCommandMenuOpen(false);
                  }
                  toggleListening();
                }
                e.preventDefault();
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                if (!hasDragged) {
                  setWindowInteractivity(true);
                  void window.electronAPI
                    ?.toggleCommandMenu({
                      isRecording,
                      canStop:
                        isRecording || isProcessing || isStarting || isStreaming || isPastePending,
                    })
                    ?.then((result) => {
                      if (typeof result?.isVisible === "boolean") {
                        setIsCommandMenuOpen(result.isVisible);
                      }
                    });
                }
              }}
              onFocus={() => setIsHovered(true)}
              onBlur={() => setIsHovered(false)}
              className={micProps.className}
              style={{
                ...micProps.style,
                cursor: isDragging ? "grabbing !important" : "pointer !important",
                transition:
                  "transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), background-color 0.25s ease-out",
                "--dictation-text-width": `${overlayTextWidth}px`,
                "--dictation-pill-width": `${expandedOverlayWidth}px`,
              }}
            >
              {hasExpandedOverlay && (
                <>
                  <div className="dictation-pill-shell__surface">
                    <div className="dictation-pill-shell__texture" />
                    <div className="dictation-pill-shell__noise" />
                    <div className="dictation-pill-shell__beam" />
                    <div className="dictation-pill-shell__content">
                      <div className={`dictation-pill-orb dictation-pill-orb--${visualTone}`}>
                        <div className="dictation-pill-orb__halo" />
                        {micState === "success" ? (
                          <Check
                            size={20}
                            strokeWidth={2.9}
                            className="dictation-pill-orb__icon mic-success-icon"
                          />
                        ) : (
                          <Mic size={20} strokeWidth={2.3} className="dictation-pill-orb__icon" />
                        )}
                      </div>
                      <div className="dictation-pill-main">
                        <div className="dictation-pill__signal-row">
                          <DictationAnimation
                            style={recordingAnimationStyle}
                            tone={visualTone}
                            level={animatedAudioLevel}
                          />
                          <div className="dictation-pill__text">{overlayDisplayText}</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
