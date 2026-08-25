import { beforeEach, describe, expect, it } from "vitest";
import {
  HOSTED_CLOUD_FEATURES_ENABLED,
  isHostedCloudModeEnabled,
  migrateUnavailableHostedCloudSettings,
  normalizeAvailableCloudMode,
  normalizeAvailableCloudProvider,
} from "./chordvoxCloud";

class MemoryStorage {
  constructor(initial = {}) {
    this.data = new Map(Object.entries(initial));
  }

  get length() {
    return this.data.size;
  }

  clear() {
    this.data.clear();
  }

  getItem(key) {
    return this.data.get(key) ?? null;
  }

  key(index) {
    return Array.from(this.data.keys())[index] ?? null;
  }

  removeItem(key) {
    this.data.delete(key);
  }

  setItem(key, value) {
    this.data.set(key, String(value));
  }
}

describe("hosted cloud availability", () => {
  let storage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it("keeps hosted routing disabled and normalizes legacy selections to BYOK", () => {
    expect(HOSTED_CLOUD_FEATURES_ENABLED).toBe(false);
    expect(isHostedCloudModeEnabled("chordvox_cloud")).toBe(false);
    expect(normalizeAvailableCloudMode("chordvox_cloud")).toBe("byok");
    expect(normalizeAvailableCloudProvider("chordvox_cloud")).toBe("openai");
  });

  it("migrates stale hosted settings to local-safe defaults when no BYOK key exists", () => {
    storage = new MemoryStorage({
      cloudTranscriptionMode: "chordvox_cloud",
      cloudTranscriptionProvider: "chordvox_cloud",
      cloudTranscriptionModel: "chordvox-cloud",
      useLocalWhisper: "false",
      cloudReasoningMode: "chordvox_cloud",
      reasoningProvider: "chordvox_cloud",
      reasoningModel: "chordvox-cloud",
      useReasoningModel: "true",
      cloudBackupEnabled: "true",
      pendingCloudMigration: "true",
      unrelatedSetting: "preserved",
    });

    const changedKeys = migrateUnavailableHostedCloudSettings(storage);

    expect(changedKeys).toContain("cloudTranscriptionMode");
    expect(storage.getItem("cloudTranscriptionMode")).toBe("byok");
    expect(storage.getItem("cloudTranscriptionProvider")).toBe("openai");
    expect(storage.getItem("cloudTranscriptionModel")).toBe("gpt-4o-mini-transcribe");
    expect(storage.getItem("useLocalWhisper")).toBe("true");
    expect(storage.getItem("cloudReasoningMode")).toBe("byok");
    expect(storage.getItem("reasoningProvider")).toBe("openai");
    expect(storage.getItem("reasoningModel")).toBe("");
    expect(storage.getItem("useReasoningModel")).toBe("false");
    expect(storage.getItem("cloudBackupEnabled")).toBe("false");
    expect(storage.getItem("pendingCloudMigration")).toBeNull();
    expect(storage.getItem("unrelatedSetting")).toBe("preserved");
  });

  it("migrates to an actually configured BYOK provider without forcing local mode", () => {
    storage = new MemoryStorage({
      cloudTranscriptionMode: "chordvox_cloud",
      cloudTranscriptionProvider: "chordvox_cloud",
      cloudTranscriptionModel: "chordvox-cloud",
      useLocalWhisper: "false",
      groqApiKey: "gsk-test",
    });

    migrateUnavailableHostedCloudSettings(storage);

    expect(storage.getItem("cloudTranscriptionMode")).toBe("byok");
    expect(storage.getItem("cloudTranscriptionProvider")).toBe("groq");
    expect(storage.getItem("cloudTranscriptionModel")).toBe("whisper-large-v3-turbo");
    expect(storage.getItem("useLocalWhisper")).toBe("false");
  });

  it("leaves existing local and BYOK settings unchanged", () => {
    storage = new MemoryStorage({
      useLocalWhisper: "true",
      cloudTranscriptionMode: "byok",
      cloudTranscriptionProvider: "deepgram",
      cloudTranscriptionModel: "nova-3",
      deepgramApiKey: "dg-test",
      cloudReasoningMode: "byok",
      reasoningProvider: "local",
      reasoningModel: "qwen-local",
      cloudBackupEnabled: "false",
    });

    expect(migrateUnavailableHostedCloudSettings(storage)).toEqual([]);
    expect(storage.getItem("cloudTranscriptionProvider")).toBe("deepgram");
    expect(storage.getItem("reasoningProvider")).toBe("local");
    expect(storage.getItem("reasoningModel")).toBe("qwen-local");
  });
});
