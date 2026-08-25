// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { DictionaryManager } from "./DictionaryManager";

// Mock i18next
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../ui/toastContext", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// Mock transcriptionStore
const mockTranscriptions = [
  { id: 1, text: "I love TypeScript very much." },
  { id: 2, text: "TypeScript is standard for web development." },
  { id: 3, text: "Let's code in TypeScript today." },
];

vi.mock("../../stores/transcriptionStore", () => ({
  useTranscriptions: () => mockTranscriptions,
}));

describe("DictionaryManager Component Suggestions", () => {
  let container: HTMLDivElement | null = null;
  let root: Root;
  let queryHistory: ReturnType<typeof vi.fn>;
  const mockProps = {
    agentName: "ChordVox",
    customDictionary: ["ChordVox"],
    newDictionaryWord: "",
    setNewDictionaryWord: vi.fn(),
    setCustomDictionary: vi.fn(),
    handleAddDictionaryWord: vi.fn(),
    handleRemoveDictionaryWord: vi.fn(),
    showConfirmDialog: vi.fn(),
    showPageHeader: true,
    embedded: false,
  };

  const storageMock: Record<string, string> = {};

  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (key: string) => storageMock[key] || null,
        setItem: (key: string, value: string) => {
          storageMock[key] = value.toString();
        },
        removeItem: (key: string) => {
          delete storageMock[key];
        },
        clear: () => {
          for (const key in storageMock) {
            delete storageMock[key];
          }
        },
      },
      writable: true,
    });
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockProps.setCustomDictionary.mockReset();
    mockProps.setNewDictionaryWord.mockReset();
    mockProps.handleAddDictionaryWord.mockReset();
    mockProps.handleRemoveDictionaryWord.mockReset();
    localStorage.clear();
    queryHistory = vi.fn().mockResolvedValue({
      items: mockTranscriptions,
      hasMore: false,
      totalCount: mockTranscriptions.length,
      truncated: false,
    });
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { queryTranscriptionHistory: queryHistory },
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    if (container) {
      document.body.removeChild(container);
      container = null;
    }
  });

  it("renders suggested words based on history", async () => {
    await act(async () => {
      root.render(<DictionaryManager {...mockProps} />);
    });

    // Check if suggestion title exists
    const bodyText = container!.innerHTML;
    expect(bodyText).toContain("settingsPage.dictionary.suggestionsTitle");
    // TypeScript has count 3, so it should be suggested
    expect(bodyText).toContain("TypeScript");
  });

  it("handles adding suggested word to custom dictionary", async () => {
    await act(async () => {
      root.render(<DictionaryManager {...mockProps} />);
    });

    // Find the add button for "TypeScript" (the first button inside the chip after word text)
    const addButtons = container!.querySelectorAll(
      'button[title="settingsPage.dictionary.addToDictionary"]'
    );
    expect(addButtons.length).toBeGreaterThan(0);

    await act(async () => {
      (addButtons[0] as HTMLButtonElement).click();
    });

    expect(mockProps.setCustomDictionary).toHaveBeenCalledWith(["ChordVox", "TypeScript"]);
  });

  it("handles ignoring a suggested word", async () => {
    await act(async () => {
      root.render(<DictionaryManager {...mockProps} />);
    });

    const ignoreButtons = container!.querySelectorAll(
      'button[title="settingsPage.dictionary.ignoreSuggestion"]'
    );
    expect(ignoreButtons.length).toBeGreaterThan(0);

    await act(async () => {
      (ignoreButtons[0] as HTMLButtonElement).click();
    });

    // The ignoredWords list should persist in localStorage
    const ignoredStr = localStorage.getItem("dictionarySuggestionIgnored");
    expect(ignoredStr).toBeTruthy();
    expect(JSON.parse(ignoredStr!)).toContain("TypeScript");
  });

  it("bounds long-term suggestions to the most recent 400 history entries", async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => ({
      id: 600 - index,
      text: `LegacyBrand recent ${index}`,
    }));
    const secondPage = Array.from({ length: 200 }, (_, index) => ({
      id: 400 - index,
      text: `LegacyBrand older ${index}`,
    }));
    queryHistory.mockImplementation(({ cursor = null }: { cursor?: string | null }) => {
      if (cursor === null) {
        return Promise.resolve({
          items: firstPage,
          hasMore: true,
          totalCount: 600,
          truncated: false,
          nextCursor: "cursor-page-2",
        });
      }
      if (cursor === "cursor-page-2") {
        return Promise.resolve({
          items: secondPage,
          hasMore: false,
          totalCount: 600,
          truncated: false,
        });
      }
      throw new Error(`Unexpected history cursor: ${cursor}`);
    });

    await act(async () => {
      root.render(<DictionaryManager {...mockProps} />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(queryHistory).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        requestKey: "dictionary-suggestions",
        cursor: null,
        limit: 200,
      })
    );
    expect(queryHistory).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        requestKey: "dictionary-suggestions",
        cursor: "cursor-page-2",
        limit: 200,
      })
    );
    expect(queryHistory).toHaveBeenCalledTimes(2);
    expect(container!.textContent).toContain("LegacyBrand");
  });
});
