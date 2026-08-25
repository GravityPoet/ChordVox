/**
 * Utility functions for audio device detection and management.
 * Shared between renderer components and audio manager.
 */

/**
 * Determines if a microphone device is a built-in device based on its label.
 * Works across macOS, Windows, and Linux platforms.
 */
export function isBuiltInMicrophone(label: string): boolean {
  const lowerLabel = label.normalize("NFKC").toLowerCase();
  const accentFoldedLabel = lowerLabel.normalize("NFKD").replace(/\p{M}/gu, "");

  const builtInIndicators = [
    "built-in",
    "built in",
    "internal",
    "macbook",
    "studio display",
    "integrated",
    "integriert",
    "eingebaut",
    "integre",
    "integré",
    "integrado",
    "integrato",
    "встро",
    "内置",
    "內置",
    "内建",
    "內建",
    "内蔵",
    "내장",
  ];
  if (
    builtInIndicators.some(
      (indicator) => lowerLabel.includes(indicator) || accentFoldedLabel.includes(indicator)
    )
  )
    return true;

  return false;
}

type AudioInputDevice = Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">;

/**
 * Prefer an explicitly identifiable built-in input. If localized or unusual
 * labels make that impossible, use the browser's system-default pseudo device
 * instead of guessing from an arbitrary microphone name.
 */
export function findPreferredBuiltInMicrophone(
  devices: readonly AudioInputDevice[]
): AudioInputDevice | undefined {
  const inputs = devices.filter((device) => device.kind === "audioinput");
  return (
    inputs.find((device) => isBuiltInMicrophone(device.label || "")) ||
    inputs.find((device) => device.deviceId === "default")
  );
}
