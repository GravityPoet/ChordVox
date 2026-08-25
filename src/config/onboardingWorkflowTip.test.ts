import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("onboarding workflow tip", () => {
  it("promotes the current multi-workflow feature instead of the retired dual-profile model", () => {
    const onboarding = readRepoFile("src/components/OnboardingFlow.tsx");
    const readme = readRepoFile("README.md");
    const zh = JSON.parse(readRepoFile("src/locales/zh-CN/translation.json"));
    const tip = zh.onboarding.workflowHotkeyTip;

    expect(onboarding).toContain('t("onboarding.workflowHotkeyTip.title")');
    expect(onboarding).toContain('t("onboarding.workflowHotkeyTip.description")');
    expect(tip.title).toContain("多套快捷键");
    expect(tip.description).toContain("听写、翻译、润色或询问 AI");
    expect(tip.description).toContain("每套工作流选择不同模型");
    expect(JSON.stringify(zh.onboarding)).not.toContain("双快捷键");
    expect(JSON.stringify(zh.onboarding)).not.toContain("第二套快捷键");
    expect(onboarding).not.toContain("dualHotkeyTip");
    expect(zh.settingsPage.account.trialCta.description).toContain("多套快捷键工作流");
    expect(zh.settingsPage.account.trialStartDialog.description).toContain("多套快捷键工作流");
    expect(readme).toContain("Multi-Shortcut Workflows");
    expect(readme).not.toContain("Dual-Profile Hotkeys");
  });
});
