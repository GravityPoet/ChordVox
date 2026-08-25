import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readLocale(locale: string) {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, `src/locales/${locale}/translation.json`), "utf8")
  );
}

describe("privacy experience copy", () => {
  it("leads telemetry opt-in with the customer benefit and a precise privacy promise", () => {
    const zh = readLocale("zh-CN");
    const en = readLocale("en");
    const zhPrivacy = zh.settingsPage.privacy;
    const enPrivacy = en.settingsPage.privacy;

    expect(zhPrivacy.usageAnalytics).toBe("帮助我们更快修复问题");
    expect(zhPrivacy.usageAnalyticsDescription).toContain("经隐私处理");
    expect(zhPrivacy.usageAnalyticsDescription).toContain("不会上传你的转录文字、音频或输入内容");
    expect(zhPrivacy.usageAnalyticsDescription).toContain("随时关闭");
    expect(zhPrivacy.usageAnalyticsDescription).not.toContain("崩溃信息");

    expect(enPrivacy.usageAnalytics).toBe("Help us fix problems faster");
    expect(enPrivacy.usageAnalyticsDescription).toContain("privacy-filtered");
    expect(enPrivacy.usageAnalyticsDescription).toContain("never uploads");
    expect(enPrivacy.usageAnalyticsDescription).toContain("turn it off at any time");
  });

  it("presents sensitive-app exclusions as a privacy protection customers can understand", () => {
    const zh = readLocale("zh-CN");
    const en = readLocale("en");
    const zhContext = zh.settingsPage.context;
    const enContext = en.settingsPage.context;

    expect(zhContext.sensitiveAppsTitle).toBe("敏感应用隐私保护");
    expect(zhContext.sensitiveAppsDescription).toContain("读取文字或截取画面前直接跳过");
    expect(zhContext.sensitiveAppsDescription).toContain("密码、密钥等敏感信息");
    expect(zhContext.sensitiveAppsChoose).toBe("添加受保护应用");
    expect(zhContext.sensitiveAppsSelected).toBe("已保护的应用");

    expect(enContext.sensitiveAppsTitle).toBe("Privacy protection for sensitive apps");
    expect(enContext.sensitiveAppsDescription).toContain(
      "before reading text or taking a screenshot"
    );
    expect(enContext.sensitiveAppsChoose).toBe("Add protected apps");
    expect(enContext.sensitiveAppsSelected).toBe("Protected apps");
  });
});
