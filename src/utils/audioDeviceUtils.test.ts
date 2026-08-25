import { describe, expect, it } from "vitest";
import { findPreferredBuiltInMicrophone, isBuiltInMicrophone } from "./audioDeviceUtils";

const input = (deviceId: string, label: string) => ({
  deviceId,
  label,
  kind: "audioinput" as const,
});

describe("audioDeviceUtils", () => {
  it.each([
    "MacBook Pro Microphone",
    "Studio Display Microphone",
    "内置麦克风",
    "內建麥克風",
    "内蔵マイク",
    "내장 마이크",
    "Integriertes Mikrofon",
    "Microphone intégré",
    "Micrófono integrado",
    "Встроенный микрофон",
  ])("recognizes localized and Apple built-in labels: %s", (label) => {
    expect(isBuiltInMicrophone(label)).toBe(true);
  });

  it("does not guess that an arbitrary external microphone is built in", () => {
    expect(isBuiltInMicrophone("USB Microphone")).toBe(false);
    expect(isBuiltInMicrophone("AirPods Microphone")).toBe(false);
  });

  it("falls back to the system-default input when labels are unfamiliar", () => {
    const preferred = findPreferredBuiltInMicrophone([
      input("external", "特殊音频设备"),
      input("default", "系统默认"),
    ]);
    expect(preferred?.deviceId).toBe("default");
  });
});
