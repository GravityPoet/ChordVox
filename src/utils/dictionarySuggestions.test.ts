import { describe, it, expect } from "vitest";
import { getDictionarySuggestions, CHINESE_STOPWORDS } from "./dictionarySuggestions";

describe("getDictionarySuggestions", () => {
  it("should return empty array for empty inputs", () => {
    expect(getDictionarySuggestions([])).toEqual([]);
    expect(getDictionarySuggestions(["   "])).toEqual([]);
  });

  it("should suggest proper English nouns with frequency >= 3", () => {
    const texts = [
      "I love using TypeScript for projects.",
      "TypeScript is awesome and static typed.",
      "We write code in TypeScript everyday.",
    ];
    // TypeScript appears 3 times, hello appears 3 times but is lowercase
    const texts2 = [...texts, "hello hello hello"];
    const suggestions = getDictionarySuggestions(texts2);
    expect(suggestions).toContain("TypeScript");
    expect(suggestions).not.toContain("hello");
  });

  it("should suggest Chinese words with frequency >= 3 and skip stop words", () => {
    // "分词" appears 3 times
    // "今天" appears 3 times but is a stop word
    const texts = [
      "进行分词处理今天很好",
      "通过分词我们能做词典建议今天很好",
      "使用分词来实现词频统计今天很好",
    ];
    const suggestions = getDictionarySuggestions(texts);
    expect(suggestions).toContain("分词");
    expect(suggestions).not.toContain("今天");
    expect(suggestions).not.toContain("我们");
  });

  it("should respect existing dictionary and ignored list", () => {
    const texts = [
      "We use ChordVox every day.",
      "ChordVox is an IME assistant.",
      "Install ChordVox now.",
    ];
    // ChordVox appears 3 times
    expect(getDictionarySuggestions(texts, ["ChordVox"])).toEqual([]);
    expect(getDictionarySuggestions(texts, [], ["chordvox"])).toEqual([]);
  });

  it("should filter out pure numbers and punctuation", () => {
    const texts = ["12345 12345 12345 !!! !!! !!!", "12345 !!!", "12345 !!!"];
    expect(getDictionarySuggestions(texts)).toEqual([]);
  });

  it("should pass the garbage stopwords matrix test", () => {
    // All stop words appearing 3 times should be completely filtered out
    const stopWordsList = Array.from(CHINESE_STOPWORDS);
    const texts = [stopWordsList.join(" "), stopWordsList.join(" "), stopWordsList.join(" ")];
    const suggestions = getDictionarySuggestions(texts);
    expect(suggestions).toEqual([]);
  });

  it("should sort suggestions by frequency descending, then length descending", () => {
    const texts = [
      "React React React React React", // React: 5
      "Vite Vite Vite", // Vite: 3
      "Electron Electron Electron", // Electron: 3
    ];
    const suggestions = getDictionarySuggestions(texts);
    // React is first (freq 5)
    expect(suggestions[0]).toBe("React");
    // Electron (len 8) is before Vite (len 4) since both have freq 3
    expect(suggestions[1]).toBe("Electron");
    expect(suggestions[2]).toBe("Vite");
  });
});
