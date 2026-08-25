export interface StyleRule {
  displayName?: string;
  match: {
    bundleIdPrefix?: string;
    appNameContains?: string;
  };
  styleKey: "casual" | "professional" | "technical" | "custom";
  customPrompt?: string;
}

export const BUILTIN_STYLE_PROMPTS: Record<
  "casual" | "professional" | "technical",
  Record<"zh-CN" | "zh-TW" | "en", string>
> = {
  casual: {
    "zh-CN":
      "润色语气：轻松、日常、口语化。保留口语人设，使用自然的短句和亲切的语气，像在与朋友聊天一样，适合即时通讯和日常交流。",
    "zh-TW":
      "潤色語氣：輕鬆、日常、口語化。保留口語人設，使用自然的短句和親切的語氣，像在與朋友聊天一樣，適合即時通訊和日常交流。",
    en: "Polish tone: Casual, conversational, and natural. Keep it friendly and informal, using short sentences and a warm tone suitable for chat or daily communication.",
  },
  professional: {
    "zh-CN":
      "润色语气：专业、严谨、商务。使用规范的用词和得体的句式，保持客观冷静，适用于工作邮件、正式报告和商务沟通。",
    "zh-TW":
      "潤色語氣：專業、嚴謹、商務。使用規範的用詞和得體的句式，保持客觀冷靜，適用於工作郵件、正式報告和商務溝通。",
    en: "Polish tone: Professional, formal, and polite. Use clear, structured business-appropriate language, maintaining an objective and respectful tone suitable for emails and official reports.",
  },
  technical: {
    "zh-CN":
      "润色语气：技术、精确、专业。准确使用行业技术术语、代码引用规范或逻辑紧凑的结构，适合在开发者论坛、Slack 技术讨论、GitHub issue 或 Bug 报告中沟通。",
    "zh-TW":
      "潤色語氣：技術、精確、專業。準確使用行業技術術語、代碼引用規範或邏輯緊湊的結構，適合在開發者論壇、Slack 技術討論、GitHub issue 或 Bug 報告中溝通。",
    en: "Polish tone: Technical, precise, and developer-oriented. Use accurate jargon, clear formatting for code terms, and logically structured sentences suitable for GitHub issues, Slack tech discussions, or developer documentation.",
  },
};

export function matchAppStyleRule(
  appName: string,
  bundleId: string,
  rules: StyleRule[]
): StyleRule | null {
  if (!rules || !Array.isArray(rules)) return null;

  const appNameLower = (appName || "").toLowerCase();
  const bundleIdLower = (bundleId || "").toLowerCase();

  // First pass: try matching by bundleIdPrefix (must have prefix value)
  for (const rule of rules) {
    if (rule.match?.bundleIdPrefix && rule.match.bundleIdPrefix.trim()) {
      const prefix = rule.match.bundleIdPrefix.trim().toLowerCase();
      if (bundleIdLower.startsWith(prefix)) {
        return rule;
      }
    }
  }

  // Second pass: try matching by appNameContains (must have contains value)
  for (const rule of rules) {
    if (rule.match?.appNameContains && rule.match.appNameContains.trim()) {
      const substr = rule.match.appNameContains.trim().toLowerCase();
      if (appNameLower.includes(substr)) {
        return rule;
      }
    }
  }

  return null;
}

export function getAppStylePrompt(
  appName: string,
  bundleId: string,
  rules: StyleRule[],
  uiLanguage: string = "en"
): string | null {
  const matchedRule = matchAppStyleRule(appName, bundleId, rules);
  if (!matchedRule) return null;

  if (matchedRule.styleKey === "custom") {
    return matchedRule.customPrompt || null;
  }

  const lang = uiLanguage === "zh-CN" || uiLanguage === "zh-TW" ? uiLanguage : "en";
  const builtin = BUILTIN_STYLE_PROMPTS[matchedRule.styleKey];
  return builtin ? builtin[lang] : null;
}
