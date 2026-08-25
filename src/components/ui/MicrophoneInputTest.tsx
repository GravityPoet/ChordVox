import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Mic, Settings, Volume2 } from "lucide-react";
import { findPreferredBuiltInMicrophone } from "../../utils/audioDeviceUtils";
import { calculateMicrophoneLevel } from "../../utils/microphoneLevel";
import { cn } from "../lib/utils";
import { Button } from "./button";

const TEST_DURATION_MS = 8_000;
const SOUND_DETECTION_THRESHOLD = 0.035;
const LEVEL_SEGMENTS = 16;

type TestResult = "idle" | "heard" | "silent" | "error";
type TestErrorKind = "permission" | "device" | "unavailable" | "unknown" | null;

interface MicrophoneInputTestProps {
  preferBuiltInMic: boolean;
  selectedMicDeviceId: string;
  onPermissionGranted: () => void;
  onOpenPrivacySettings: () => void;
  onOpenSoundSettings: () => void;
}

async function resolveMicrophoneConstraints(
  preferBuiltInMic: boolean,
  selectedMicDeviceId: string
): Promise<MediaStreamConstraints> {
  const audio: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };

  if (preferBuiltInMic) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const builtInMic = findPreferredBuiltInMicrophone(devices);
      if (builtInMic) {
        return { audio: { ...audio, deviceId: { ideal: builtInMic.deviceId } } };
      }
    } catch {
      // Fall back to the system default input when device enumeration is unavailable.
    }
  } else if (selectedMicDeviceId) {
    return { audio: { ...audio, deviceId: { ideal: selectedMicDeviceId } } };
  }

  return { audio };
}

function classifyMicrophoneError(error: unknown): TestErrorKind {
  if (!error || typeof error !== "object") return "unknown";
  const name = String((error as { name?: unknown }).name || "");
  if (name === "NotAllowedError" || name === "SecurityError") return "permission";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "device";
  if (name === "NotReadableError" || name === "AbortError") return "unavailable";
  return "unknown";
}

export default function MicrophoneInputTest({
  preferBuiltInMic,
  selectedMicDeviceId,
  onPermissionGranted,
  onOpenPrivacySettings,
  onOpenSoundSettings,
}: MicrophoneInputTestProps) {
  const { t } = useTranslation();
  const [isTesting, setIsTesting] = useState(false);
  const [hasDetectedSound, setHasDetectedSound] = useState(false);
  const [level, setLevel] = useState(0);
  const [result, setResult] = useState<TestResult>("idle");
  const [errorKind, setErrorKind] = useState<TestErrorKind>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const detectedSoundRef = useRef(false);
  const testRunRef = useRef(0);

  const releaseResources = useCallback(() => {
    testRunRef.current += 1;

    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    try {
      sourceRef.current?.disconnect();
      analyserRef.current?.disconnect();
    } catch {
      // Nodes may already be disconnected during window teardown.
    }
    sourceRef.current = null;
    analyserRef.current = null;

    const stream = streamRef.current;
    streamRef.current = null;
    try {
      stream?.getTracks().forEach((track) => track.stop());
    } catch {
      // Tracks may already be stopped by the operating system.
    }

    const audioContext = audioContextRef.current;
    audioContextRef.current = null;
    if (audioContext && audioContext.state !== "closed") {
      void audioContext.close().catch(() => undefined);
    }
  }, []);

  const finishTest = useCallback(() => {
    const heardSound = detectedSoundRef.current;
    releaseResources();
    setIsTesting(false);
    setLevel(0);
    setResult(heardSound ? "heard" : "silent");
  }, [releaseResources]);

  const startTest = useCallback(async () => {
    releaseResources();
    const runId = testRunRef.current;
    detectedSoundRef.current = false;
    setIsTesting(true);
    setHasDetectedSound(false);
    setLevel(0);
    setResult("idle");
    setErrorKind(null);

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw Object.assign(new Error("mediaDevices unavailable"), { name: "NotSupportedError" });
      }

      await window.electronAPI?.requestMicrophoneAccess?.();
      const constraints = await resolveMicrophoneConstraints(preferBuiltInMic, selectedMicDeviceId);
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (testRunRef.current !== runId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      onPermissionGranted();
      streamRef.current = stream;

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.72;
      source.connect(analyser);
      sourceRef.current = source;
      analyserRef.current = analyser;

      const samples = new Uint8Array(analyser.fftSize);
      const updateLevel = () => {
        if (testRunRef.current !== runId) return;
        analyser.getByteTimeDomainData(samples);
        const nextLevel = calculateMicrophoneLevel(samples);
        setLevel(nextLevel);
        if (nextLevel >= SOUND_DETECTION_THRESHOLD && !detectedSoundRef.current) {
          detectedSoundRef.current = true;
          setHasDetectedSound(true);
        }
        animationFrameRef.current = window.requestAnimationFrame(updateLevel);
      };

      animationFrameRef.current = window.requestAnimationFrame(updateLevel);
      timeoutRef.current = window.setTimeout(finishTest, TEST_DURATION_MS);
    } catch (error) {
      if (testRunRef.current !== runId) return;
      const nextErrorKind = classifyMicrophoneError(error);
      releaseResources();
      setIsTesting(false);
      setLevel(0);
      setResult("error");
      setErrorKind(nextErrorKind);
    }
  }, [finishTest, onPermissionGranted, preferBuiltInMic, releaseResources, selectedMicDeviceId]);

  useEffect(() => releaseResources, [releaseResources]);

  const activeSegments = Math.round(level * LEVEL_SEGMENTS);
  const statusText = isTesting
    ? hasDetectedSound
      ? t("settingsPage.permissions.microphoneTest.heardLive")
      : t("settingsPage.permissions.microphoneTest.listening")
    : result === "heard"
      ? t("settingsPage.permissions.microphoneTest.success")
      : result === "silent"
        ? t("settingsPage.permissions.microphoneTest.silent")
        : result === "error"
          ? t(`settingsPage.permissions.microphoneTest.errors.${errorKind || "unknown"}`)
          : t("settingsPage.permissions.microphoneTest.idle");

  return (
    <div className="rounded-xl border border-border/40 bg-muted/10 px-4 py-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className={cn(
              "glass-chip flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors motion-reduce:transition-none",
              hasDetectedSound || result === "heard"
                ? "glass-chip--success text-success"
                : "glass-chip--muted text-muted-foreground"
            )}
          >
            <Volume2 className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-foreground">
              {t("settingsPage.permissions.microphoneTest.title")}
            </p>
            <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground/80">
              {t("settingsPage.permissions.microphoneTest.description")}
            </p>
          </div>
        </div>

        <Button
          type="button"
          variant={isTesting ? "outline" : "tinted"}
          size="sm"
          className="h-8 shrink-0 px-3 text-[12px]"
          onClick={() => (isTesting ? finishTest() : void startTest())}
        >
          <Mic className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {isTesting
            ? t("settingsPage.permissions.microphoneTest.stop")
            : t("settingsPage.permissions.microphoneTest.start")}
        </Button>
      </div>

      <div className="mt-4">
        <div
          role="meter"
          aria-label={t("settingsPage.permissions.microphoneTest.meterLabel")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(level * 100)}
          className="grid grid-cols-[repeat(16,minmax(0,1fr))] gap-1"
        >
          {Array.from({ length: LEVEL_SEGMENTS }, (_, index) => (
            <span
              key={index}
              aria-hidden="true"
              className={cn(
                "h-2 rounded-full transition-colors duration-75 motion-reduce:transition-none",
                index < activeSegments
                  ? hasDetectedSound
                    ? "bg-success"
                    : "bg-primary"
                  : "bg-muted-foreground/15"
              )}
            />
          ))}
        </div>

        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p
            className={cn(
              "text-[11px] leading-relaxed",
              result === "error" || result === "silent"
                ? "text-[color:var(--ui-warning-ink)]"
                : hasDetectedSound || result === "heard"
                  ? "text-success"
                  : "text-muted-foreground"
            )}
            aria-live="polite"
          >
            {statusText}
          </p>

          {!isTesting && (result === "silent" || result === "error") ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 self-start px-2 text-[11px] sm:self-auto"
              onClick={errorKind === "permission" ? onOpenPrivacySettings : onOpenSoundSettings}
            >
              <Settings className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {errorKind === "permission"
                ? t("settingsPage.permissions.microphoneTest.openPrivacySettings")
                : t("settingsPage.permissions.microphoneTest.openSoundSettings")}
            </Button>
          ) : null}
        </div>
      </div>

      <p className="mt-3 border-t border-border/30 pt-3 text-[10px] leading-relaxed text-muted-foreground/65">
        {t("settingsPage.permissions.microphoneTest.privacyNote")}
      </p>
    </div>
  );
}
