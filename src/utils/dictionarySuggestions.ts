export const CHINESE_STOPWORDS = new Set([
  "的",
  "了",
  "和",
  "是",
  "就",
  "都",
  "而",
  "及",
  "与",
  "着",
  "也",
  "在",
  "于",
  "有",
  "我",
  "你",
  "他",
  "她",
  "它",
  "我们",
  "你们",
  "他们",
  "它们",
  "咱们",
  "今天",
  "明天",
  "昨天",
  "这个",
  "那个",
  "这些",
  "那些",
  "这里",
  "那里",
  "什么",
  "怎么",
  "哪个",
  "哪里",
  "因为",
  "所以",
  "如果",
  "但是",
  "虽然",
  "可是",
  "可以",
  "没有",
  "已经",
  "觉得",
  "自己",
  "现在",
  "知道",
  "很多",
  "可能",
  "应该",
  "必须",
  "需要",
  "这样",
  "那样",
  "进行",
  "工作",
  "问题",
  "通过",
  "使用",
  "实现",
  "为了",
  "关于",
  "对于",
  "一些",
  "非常",
  "特别",
  "真的",
  "还是",
  "或者",
  "比如",
  "例如",
  "大家",
  "时间",
  "地方",
  "事情",
  "东西",
  "一下",
  "开始",
  "发现",
  "比较",
  "之后",
  "之前",
  "最后",
  "第一",
  "目前",
  "其实",
  "甚至",
  "而且",
  "不仅",
  "因此",
  "然后",
  "就是",
  "不是",
  "还有",
  "大概",
  "基本",
  "感觉",
  "希望",
  "结果",
  "内容",
  "方面",
  "方式",
  "方法",
  "要求",
  "继续",
  "处理",
  "直接",
  "支持",
  "提供",
  "包括",
  "相关",
  "主要",
  "重要",
  "谢谢",
  "麻烦",
  "请问",
  "反正",
  "确实",
  "差不多",
  "有点",
  "一点",
  "一直",
  "一起",
  "每个",
  "各种",
  "多少",
  "几个",
  "帮忙",
  "告诉",
]);

/**
 * Filter and suggest custom vocabulary from transcription texts.
 * Uses Intl.Segmenter to segment Chinese text, and applies word filters:
 * - Chinese words: length >= 2, frequency >= 3, not in Chinese stop words
 * - English words: not all-lowercase (retains proper nouns like React, API, macOS), length >= 2, frequency >= 3
 * - Mix/Numbers: excludes pure numbers, punctuation, spaces, existing dictionary words and ignored words.
 */
export function getDictionarySuggestions(
  texts: string[],
  existingDictionary: string[] = [],
  ignoredWords: string[] = []
): string[] {
  if (!texts || texts.length === 0) {
    return [];
  }

  const existingSet = new Set(existingDictionary.map((w) => w.trim().toLowerCase()));
  const ignoredSet = new Set(ignoredWords.map((w) => w.trim().toLowerCase()));

  const wordCounts = new Map<string, number>();

  // Ensure segmenter is supported, fall back to simple regex split if not available
  let segmenter: Intl.Segmenter | null = null;
  try {
    if (typeof Intl !== "undefined" && Intl.Segmenter) {
      segmenter = new Intl.Segmenter("zh", { granularity: "word" });
    }
  } catch (err) {
    console.error("Intl.Segmenter is not supported:", err);
  }

  const validWordRegex = /^[\u4e00-\u9fa5a-zA-Z0-9_]+$/;
  const pureNumberRegex = /^\d+$/;
  const pureEnglishRegex = /^[a-zA-Z_]+$/;
  const allLowercaseRegex = /^[a-z_]+$/;

  for (const text of texts) {
    if (!text || !text.trim()) continue;

    let tokens: string[] = [];
    if (segmenter) {
      const segments = segmenter.segment(text);
      for (const seg of segments) {
        if (seg.isWordLike) {
          tokens.push(seg.segment);
        }
      }
    } else {
      // Fallback simple regex splitting for non-Intl environments (e.g. basic node test runner fallback)
      tokens = text.split(/[^a-zA-Z0-9\u4e00-\u9fa5_]+/);
    }

    for (const rawToken of tokens) {
      const token = rawToken.trim();
      if (!token || token.length < 2 || token.length > 15) {
        continue;
      }

      // Must be valid word character without special symbol/punctuation
      if (!validWordRegex.test(token)) {
        continue;
      }

      // Exclude pure numbers
      if (pureNumberRegex.test(token)) {
        continue;
      }

      // Check if it is pure English
      if (pureEnglishRegex.test(token)) {
        // Exclude all-lowercase words (e.g., hello, standard dictionary words)
        if (allLowercaseRegex.test(token)) {
          continue;
        }
      } else {
        // Contains Chinese characters
        // Exclude Chinese stop words
        if (CHINESE_STOPWORDS.has(token)) {
          continue;
        }
      }

      const lowerToken = token.toLowerCase();
      if (existingSet.has(lowerToken) || ignoredSet.has(lowerToken)) {
        continue;
      }

      wordCounts.set(token, (wordCounts.get(token) || 0) + 1);
    }
  }

  // Filter words with frequency >= 3
  const candidates: Array<{ word: string; count: number }> = [];
  for (const [word, count] of wordCounts.entries()) {
    if (count >= 3) {
      candidates.push({ word, count });
    }
  }

  // Sort: by count descending, then by length descending, then alphabetically
  candidates.sort((a, b) => {
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    if (b.word.length !== a.word.length) {
      return b.word.length - a.word.length;
    }
    return a.word.localeCompare(b.word);
  });

  return candidates.slice(0, 5).map((c) => c.word);
}
