import { describe, expect, it } from "vitest";
import { replaceImportedSettingsStorage } from "./settingsTransferStorage";

class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

describe("replaceImportedSettingsStorage", () => {
  it("replaces known settings while preserving unrelated localStorage state", () => {
    const storage = new MemoryStorage();
    storage.setItem("uiLanguage", "zh-CN");
    storage.setItem("reasoningProvider", "openai");
    storage.setItem("unrelated-window-state", "keep-me");

    replaceImportedSettingsStorage(
      storage,
      {
        reasoningProvider: "anthropic",
      },
      new Set(["uiLanguage", "reasoningProvider"])
    );

    expect(storage.getItem("reasoningProvider")).toBe("anthropic");
    expect(storage.getItem("uiLanguage")).toBeNull();
    expect(storage.getItem("unrelated-window-state")).toBe("keep-me");
  });

  it("does not persist unknown keys from imported settings", () => {
    const storage = new MemoryStorage();
    storage.setItem("unrelated-window-state", "keep-me");

    replaceImportedSettingsStorage(
      storage,
      {
        reasoningProvider: "anthropic",
        "attacker-controlled-key": "drop-me",
      },
      new Set(["uiLanguage", "reasoningProvider"])
    );

    expect(storage.getItem("reasoningProvider")).toBe("anthropic");
    expect(storage.getItem("attacker-controlled-key")).toBeNull();
    expect(storage.getItem("unrelated-window-state")).toBe("keep-me");
  });
});
