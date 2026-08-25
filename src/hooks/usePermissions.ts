import { useState, useCallback, useEffect } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { PasteToolsResult } from "../types/electron";
import { useLocalStorage } from "./useLocalStorage";
import { useToast } from "../components/ui/toastContext";

export interface UsePermissionsReturn {
  // State
  micPermissionGranted: boolean;
  accessibilityPermissionGranted: boolean;
  micPermissionError: string | null;
  pasteToolsInfo: PasteToolsResult | null;
  isCheckingPasteTools: boolean;
  macAccessibilityRegrantRequired: boolean;

  requestMicPermission: () => Promise<void>;
  testAccessibilityPermission: () => Promise<void>;
  checkPasteToolsAvailability: () => Promise<PasteToolsResult | null>;
  openMicPrivacySettings: () => Promise<void>;
  openSoundInputSettings: () => Promise<void>;
  openAccessibilitySettings: () => Promise<void>;
  setMicPermissionGranted: (granted: boolean) => void;
  setAccessibilityPermissionGranted: (granted: boolean) => void;
}

export interface UsePermissionsProps {
  showAlertDialog: (dialog: { title: string; description?: string }) => void;
}

const stopTracks = (stream?: MediaStream) => {
  try {
    stream?.getTracks?.().forEach((track) => track.stop());
  } catch {
    // ignore track cleanup errors
  }
};

const getPlatformSettingsPath = (t: TFunction): string => {
  const platform = getPlatform();
  if (platform === "win32") return t("hooks.permissions.paths.windowsMicrophone");
  if (platform === "linux") return t("hooks.permissions.paths.linuxSound");
  return t("hooks.permissions.paths.defaultSound");
};

const getPlatformPrivacyPath = (t: TFunction): string => {
  const platform = getPlatform();
  if (platform === "win32") return t("hooks.permissions.paths.windowsMicrophone");
  if (platform === "linux") return t("hooks.permissions.paths.linuxPrivacy");
  return t("hooks.permissions.paths.defaultPrivacy");
};

const getPlatform = (): "darwin" | "win32" | "linux" => {
  if (typeof window !== "undefined" && window.electronAPI?.getPlatform) {
    const platform = window.electronAPI.getPlatform();
    if (platform === "darwin" || platform === "win32" || platform === "linux") {
      return platform;
    }
  }
  // Fallback to user agent detection
  if (typeof navigator !== "undefined") {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("mac")) return "darwin";
    if (ua.includes("win")) return "win32";
    if (ua.includes("linux")) return "linux";
  }
  return "darwin"; // Default fallback
};

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const describeMicError = (error: unknown, t: TFunction): string => {
  if (!error || typeof error !== "object") {
    return t("hooks.permissions.micErrors.accessFailed");
  }

  const err = error as { name?: string; message?: string };
  const name = err.name || "";
  const message = (err.message || "").toLowerCase();
  const settingsPath = getPlatformSettingsPath(t);
  const privacyPath = getPlatformPrivacyPath(t);

  if (name === "NotFoundError") {
    return t("hooks.permissions.micErrors.noMicrophones", { settingsPath });
  }

  if (name === "NotAllowedError" || name === "SecurityError") {
    return t("hooks.permissions.micErrors.permissionDenied", { privacyPath });
  }

  if (name === "NotReadableError" || name === "AbortError") {
    return t("hooks.permissions.micErrors.couldNotStart", { settingsPath });
  }

  if (message.includes("no audio input") || message.includes("not available")) {
    return t("hooks.permissions.micErrors.noActiveInput", { settingsPath });
  }

  return t("hooks.permissions.micErrors.unknown", {
    error: err.message || t("hooks.permissions.micErrors.unknownFallback"),
  });
};

export const usePermissions = (
  showAlertDialog?: UsePermissionsProps["showAlertDialog"]
): UsePermissionsReturn => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [micPermissionGranted, setMicPermissionGranted] = useLocalStorage(
    "micPermissionGranted",
    false,
    {
      serialize: String,
      deserialize: (value) => value === "true",
    }
  );
  const [micPermissionError, setMicPermissionError] = useState<string | null>(null);
  const [accessibilityPermissionGranted, setAccessibilityPermissionGranted] = useLocalStorage(
    "accessibilityPermissionGranted",
    false,
    {
      serialize: String,
      deserialize: (value) => value === "true",
    }
  );
  const [pasteToolsInfo, setPasteToolsInfo] = useState<PasteToolsResult | null>(null);
  const [isCheckingPasteTools, setIsCheckingPasteTools] = useState(false);
  const [macAccessibilityRegrantRequired, setMacAccessibilityRegrantRequired] = useState(false);

  const checkMicPermissionSilently = useCallback(async () => {
    try {
      if (getPlatform() === "darwin" && window.electronAPI?.getMicrophoneAccessStatus) {
        const result = await window.electronAPI.getMicrophoneAccessStatus();
        if (result?.status && result.status !== "unknown") {
          setMicPermissionGranted(result.status === "granted");
          return;
        }
      }

      if (navigator.permissions?.query) {
        const status = await navigator.permissions.query({
          name: "microphone" as PermissionName,
        });
        setMicPermissionGranted(status.state === "granted");
      }
    } catch (error) {
      // Some browsers do not expose the microphone permission through the
      // Permissions API. Keep the last known value when status is unknowable.
      console.debug("Microphone permission status is unavailable:", error);
    }
  }, [setMicPermissionGranted]);

  const checkAccessibilityPermissionSilently = useCallback(async () => {
    if (getPlatform() !== "darwin") {
      return;
    }

    try {
      const granted = await window.electronAPI?.checkAccessibilityPermission?.();
      if (typeof granted === "boolean") {
        setAccessibilityPermissionGranted(granted);
      }
    } catch (error) {
      console.warn("Failed to check accessibility permission:", error);
    }
  }, [setAccessibilityPermissionGranted]);

  const openSystemSettings = useCallback(
    async (
      settingType: "microphone" | "sound" | "accessibility",
      apiMethod: (() => Promise<{ success: boolean; error?: string }>) | undefined
    ): Promise<boolean> => {
      const titles = {
        microphone: t("hooks.permissions.settingsTitles.microphone"),
        sound: t("hooks.permissions.settingsTitles.sound"),
        accessibility: t("hooks.permissions.settingsTitles.accessibility"),
      };
      const unableToOpenDescriptions = {
        microphone: t("hooks.permissions.settingsErrors.unableToOpenMicrophone"),
        sound: t("hooks.permissions.settingsErrors.unableToOpenSound"),
        accessibility: t("hooks.permissions.settingsErrors.unableToOpenAccessibility"),
      };
      try {
        const result = await apiMethod?.();
        if (result && !result.success && result.error) {
          showAlertDialog?.({ title: titles[settingType], description: result.error });
          return false;
        }
        return true;
      } catch (error) {
        console.error(`Failed to open ${settingType} settings:`, error);
        showAlertDialog?.({
          title: titles[settingType],
          description: unableToOpenDescriptions[settingType],
        });
        return false;
      }
    },
    [showAlertDialog, t]
  );

  const showMacPrivacyDragHelper = useCallback(
    async (options: { title: string; description: string; dragLabel: string }) => {
      if (getPlatform() !== "darwin") return;

      await wait(350);
      await window.electronAPI?.showMacPrivacyDragHelper?.({
        title: options.title,
        description: options.description,
        dragLabel: options.dragLabel,
        dragHint: t("settingsPage.permissions.macAccessibilityDrag.dragCardHint"),
        revealLabel: t("settingsPage.permissions.macAccessibilityDrag.openAccessibility"),
        unavailableLabel: t("settingsPage.permissions.macAccessibilityDrag.packagedOnly"),
        grantedLabel: t("settingsPage.permissions.macAccessibilityDrag.grantedLabel"),
        closeLabel: t("common.close"),
      });
    },
    [t]
  );

  const openMicPrivacySettings = useCallback(async () => {
    await openSystemSettings("microphone", window.electronAPI?.openMicrophoneSettings);
  }, [openSystemSettings]);

  const openSoundInputSettings = useCallback(async () => {
    await openSystemSettings("sound", window.electronAPI?.openSoundInputSettings);
  }, [openSystemSettings]);

  const openAccessibilitySettings = useCallback(async () => {
    // Ask macOS to register ChordVox first so it appears (toggled off) in the
    // Accessibility list — the user then only flips the switch, no dragging needed.
    await window.electronAPI?.requestAccessibilityPermission?.();
    const opened = await openSystemSettings(
      "accessibility",
      window.electronAPI?.openAccessibilitySettings
    );
    if (!opened) return;

    await showMacPrivacyDragHelper({
      title: t("settingsPage.permissions.macAccessibilityDrag.title"),
      description: t("settingsPage.permissions.macAccessibilityDrag.description"),
      dragLabel: t("settingsPage.permissions.macAccessibilityDrag.dragLabel"),
    });
  }, [openSystemSettings, showMacPrivacyDragHelper, t]);

  const requestMicPermission = useCallback(async () => {
    if (!navigator?.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      const message = t("hooks.permissions.micUnavailable");
      setMicPermissionError(message);
      if (showAlertDialog) {
        showAlertDialog({
          title: t("hooks.permissions.titles.microphoneUnavailable"),
          description: message,
        });
      } else {
        alert(message);
      }
      return;
    }

    setMicPermissionError(null);

    try {
      // macOS hardened runtime requires main-process mic prompt before getUserMedia works
      if (window.electronAPI?.requestMicrophoneAccess) {
        try {
          await window.electronAPI.requestMicrophoneAccess();
        } catch {
          // ignored — getUserMedia below will surface the error
        }
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stopTracks(stream);
      setMicPermissionGranted(true);
      setMicPermissionError(null);
    } catch (err) {
      console.error("Microphone permission denied:", err);
      setMicPermissionGranted(false);
      const message = describeMicError(err, t);
      setMicPermissionError(message);
      if (showAlertDialog) {
        showAlertDialog({
          title: t("hooks.permissions.titles.microphonePermissionRequired"),
          description: message,
        });
      } else {
        alert(message);
      }
    }
  }, [setMicPermissionGranted, showAlertDialog, t]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      if (!cancelled) await checkMicPermissionSilently();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };

    void refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [checkMicPermissionSilently]);

  const checkPasteToolsAvailability = useCallback(
    async (options: { notifyOnFailure?: boolean } = {}): Promise<PasteToolsResult | null> => {
      setIsCheckingPasteTools(true);
      try {
        if (window.electronAPI?.checkPasteTools) {
          const result = await window.electronAPI.checkPasteTools();
          setPasteToolsInfo(result);

          // On Windows and Linux with tools available, auto-grant accessibility
          if (result.platform === "win32") {
            setAccessibilityPermissionGranted(true);
            // Windows is expected to always have at least PowerShell SendKeys; warn if pre-flight fails
            if (options.notifyOnFailure && result.available === false) {
              toast?.({
                title: t("hooks.permissions.titles.optionalPasteTool"),
                description: t("hooks.clipboard.pasteFailed.windowsDescription"),
                variant: "destructive",
              });
            }
          } else if (result.platform === "linux" && result.available) {
            setAccessibilityPermissionGranted(true);
          }
          return result;
        }
        return null;
      } catch (error) {
        console.error("Failed to check paste tools:", error);
        return null;
      } finally {
        setIsCheckingPasteTools(false);
      }
    },
    [setAccessibilityPermissionGranted, t, toast]
  );

  // Check paste tools on mount
  useEffect(() => {
    checkPasteToolsAvailability();
  }, [checkPasteToolsAvailability]);

  useEffect(() => {
    if (getPlatform() !== "darwin") {
      setMacAccessibilityRegrantRequired(false);
      return;
    }

    let cancelled = false;

    const loadGuidance = async () => {
      const guidance = await window.electronAPI?.getMacAccessibilityGuidance?.();
      if (!cancelled) {
        setMacAccessibilityRegrantRequired(Boolean(guidance?.shouldRegrantAfterUpdate));
      }
    };

    loadGuidance().catch((error) => {
      console.warn("Failed to load mac accessibility guidance:", error);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void checkAccessibilityPermissionSilently();
  }, [checkAccessibilityPermissionSilently]);

  useEffect(() => {
    if (getPlatform() !== "darwin") {
      return undefined;
    }

    let cancelled = false;
    let checking = false;

    const refresh = async () => {
      if (cancelled || checking) {
        return;
      }

      checking = true;
      try {
        await checkAccessibilityPermissionSilently();
      } finally {
        checking = false;
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    };

    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    const intervalMs = accessibilityPermissionGranted ? 5000 : 1000;
    const interval = window.setInterval(refresh, intervalMs);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.clearInterval(interval);
    };
  }, [accessibilityPermissionGranted, checkAccessibilityPermissionSilently]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI?.onMacPrivacyPermissionGranted) {
      return undefined;
    }
    return window.electronAPI.onMacPrivacyPermissionGranted(() => {
      void checkAccessibilityPermissionSilently();
    });
  }, [checkAccessibilityPermissionSilently]);

  const testAccessibilityPermission = useCallback(async () => {
    const platform = getPlatform();

    if (platform === "darwin") {
      try {
        // openAccessibilitySettings() already calls requestAccessibilityPermission()
        // (native auto-add) before opening the pane, so don't call it twice here.
        await openAccessibilitySettings();
        for (let attempt = 0; attempt < 6; attempt += 1) {
          const granted = (await window.electronAPI?.checkAccessibilityPermission?.()) ?? false;
          setAccessibilityPermissionGranted(Boolean(granted));
          if (granted) return;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (err) {
        console.error("Accessibility settings open/check failed:", err);
        setAccessibilityPermissionGranted(false);
      }
      return;
    }

    // On Windows, PowerShell SendKeys is always available
    if (platform === "win32") {
      const result = await checkPasteToolsAvailability({ notifyOnFailure: true });
      setAccessibilityPermissionGranted(true);
      if (result?.available === false) {
        return;
      }
      if (showAlertDialog) {
        showAlertDialog({
          title: t("hooks.permissions.titles.readyToGo"),
          description: t("hooks.permissions.descriptions.windowsReady"),
        });
      }
      return;
    }

    // On Linux, check if paste tools are available
    if (platform === "linux") {
      const result = await checkPasteToolsAvailability({ notifyOnFailure: true });

      if (result?.available) {
        setAccessibilityPermissionGranted(true);
        if (showAlertDialog) {
          const method = result.method || t("hooks.permissions.labels.defaultPasteTool");
          const methodLabel =
            result.isWayland && method === "xdotool"
              ? t("hooks.permissions.labels.xdotoolXwayland")
              : method;
          showAlertDialog({
            title: t("hooks.permissions.titles.readyToGo"),
            description: t("hooks.permissions.descriptions.linuxReadyWithMethod", {
              method: methodLabel,
            }),
          });
        }
      } else {
        // Don't block, but inform the user
        const isWayland = result?.isWayland;
        const xwaylandAvailable = result?.xwaylandAvailable;
        const recommendedTool = result?.recommendedInstall;
        const installCmd =
          recommendedTool === "wtype"
            ? "sudo dnf install wtype  # Fedora\nsudo apt install wtype  # Debian/Ubuntu"
            : "sudo apt install xdotool  # Debian/Ubuntu/Mint\nsudo dnf install xdotool  # Fedora";

        if (showAlertDialog) {
          if (isWayland && !xwaylandAvailable && !recommendedTool) {
            showAlertDialog({
              title: t("hooks.permissions.titles.waylandClipboardMode"),
              description: t("hooks.permissions.descriptions.waylandClipboardMode"),
            });
          } else {
            const waylandNote = isWayland
              ? recommendedTool === "wtype"
                ? t("hooks.permissions.notes.waylandWtype")
                : t("hooks.permissions.notes.waylandXwaylandOnly")
              : "";
            showAlertDialog({
              title: t("hooks.permissions.titles.optionalPasteTool"),
              description: t("hooks.permissions.descriptions.optionalPasteTool", {
                tool: recommendedTool || t("hooks.permissions.labels.defaultPasteTool"),
                installCmd,
                waylandNote,
              }),
            });
          }
        }
        // Still allow proceeding - this is optional
        setAccessibilityPermissionGranted(true);
      }
    }
  }, [
    showAlertDialog,
    checkPasteToolsAvailability,
    openAccessibilitySettings,
    setAccessibilityPermissionGranted,
    t,
  ]);

  return {
    micPermissionGranted,
    accessibilityPermissionGranted,
    micPermissionError,
    pasteToolsInfo,
    isCheckingPasteTools,
    macAccessibilityRegrantRequired,
    requestMicPermission,
    testAccessibilityPermission,
    checkPasteToolsAvailability,
    openMicPrivacySettings,
    openSoundInputSettings,
    openAccessibilitySettings,
    setMicPermissionGranted,
    setAccessibilityPermissionGranted,
  };
};
