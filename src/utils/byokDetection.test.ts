import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { hasStoredByokKey } from "./byokDetection";

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

const mockLocalStorage = new MemoryStorage();

// Define global.localStorage for node environment
const originalLocalStorage = (global as typeof globalThis & { localStorage?: Storage })
  .localStorage;
Object.defineProperty(global, "localStorage", {
  value: mockLocalStorage,
  writable: true,
  configurable: true,
});

describe("hasStoredByokKey", () => {
  beforeEach(() => {
    mockLocalStorage.clear();
  });

  afterAll(() => {
    if (originalLocalStorage) {
      Object.defineProperty(global, "localStorage", {
        value: originalLocalStorage,
        writable: true,
        configurable: true,
      });
    } else {
      delete (global as any).localStorage;
    }
  });

  it("returns false when no keys are stored", () => {
    expect(hasStoredByokKey()).toBe(false);
  });

  const keys = [
    "openaiApiKey",
    "openrouterApiKey",
    "groqApiKey",
    "cerebrasApiKey",
    "sonioxApiKey",
    "deepgramApiKey",
    "googleSttApiKey",
    "doubaoAccessToken",
    "doubaoAppId",
    "customTranscriptionApiKey",
  ];

  it.each(keys)("returns true when %s is set", (key) => {
    mockLocalStorage.setItem(key, "some-api-key");
    expect(hasStoredByokKey()).toBe(true);
  });

  it("returns false if keys are empty strings", () => {
    mockLocalStorage.setItem("openaiApiKey", "");
    expect(hasStoredByokKey()).toBe(false);
  });
});
