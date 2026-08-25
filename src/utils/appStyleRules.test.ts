import { describe, it, expect } from "vitest";
import {
  matchAppStyleRule,
  getAppStylePrompt,
  StyleRule,
  BUILTIN_STYLE_PROMPTS,
} from "./appStyleRules";

describe("appStyleRules", () => {
  const mockRules: StyleRule[] = [
    {
      match: { appNameContains: "wechat" },
      styleKey: "casual",
    },
    {
      match: { bundleIdPrefix: "com.microsoft.VSCode" },
      styleKey: "technical",
    },
    {
      match: { appNameContains: "chrome", bundleIdPrefix: "com.google.Chrome" },
      styleKey: "professional",
    },
    {
      match: { appNameContains: "custom-app" },
      styleKey: "custom",
      customPrompt: "custom prompt style",
    },
  ];

  describe("matchAppStyleRule", () => {
    it("should match by appNameContains (case insensitive)", () => {
      const match = matchAppStyleRule("WeChat", "com.tencent.xin", mockRules);
      expect(match).not.toBeNull();
      expect(match?.styleKey).toBe("casual");
    });

    it("should match by bundleIdPrefix (case insensitive)", () => {
      const match = matchAppStyleRule(
        "Visual Studio Code",
        "com.microsoft.VSCode.helper",
        mockRules
      );
      expect(match).not.toBeNull();
      expect(match?.styleKey).toBe("technical");
    });

    it("should prioritize bundleIdPrefix match over appNameContains match", () => {
      // Create rules where appName contains chrome but matches casual, while bundleId com.google.Chrome matches professional
      const rules: StyleRule[] = [
        {
          match: { appNameContains: "chrome" },
          styleKey: "casual",
        },
        {
          match: { bundleIdPrefix: "com.google.Chrome" },
          styleKey: "professional",
        },
      ];
      // matchAppStyleRule internally searches bundleIdPrefix first across ALL rules
      const match = matchAppStyleRule("Google Chrome", "com.google.Chrome.helper", rules);
      expect(match?.styleKey).toBe("professional");
    });

    it("should return null if no rules match", () => {
      const match = matchAppStyleRule("Safari", "com.apple.Safari", mockRules);
      expect(match).toBeNull();
    });

    it("should handle empty or null values gracefully", () => {
      expect(matchAppStyleRule("", "", mockRules)).toBeNull();
      expect(matchAppStyleRule("", "", [])).toBeNull();
    });
  });

  describe("getAppStylePrompt", () => {
    it("should return casual prompt for casual style in zh-CN", () => {
      const prompt = getAppStylePrompt("WeChat", "com.tencent.xin", mockRules, "zh-CN");
      expect(prompt).toBe(BUILTIN_STYLE_PROMPTS.casual["zh-CN"]);
    });

    it("should return technical prompt for technical style in en", () => {
      const prompt = getAppStylePrompt("VSCode", "com.microsoft.VSCode", mockRules, "en");
      expect(prompt).toBe(BUILTIN_STYLE_PROMPTS.technical.en);
    });

    it("should return custom prompt for custom style", () => {
      const prompt = getAppStylePrompt("Custom-App", "com.custom.app", mockRules, "zh-CN");
      expect(prompt).toBe("custom prompt style");
    });

    it("should return null if there is no match", () => {
      const prompt = getAppStylePrompt("Safari", "com.apple.Safari", mockRules, "en");
      expect(prompt).toBeNull();
    });
  });
});
