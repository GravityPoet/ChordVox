const EXISTING_PUNCTUATION_REGEX = /[。！？!?…，,；;：:]$/u;
const CJK_PUNCTUATION_REGEX = /[，。！？；：、]/u;
const CJK_CHAR_REGEX = /[\u3400-\u9fff]/u;
const CJK_CHAR_GLOBAL_REGEX = /[\u3400-\u9fff]/gu;
const ENGLISH_WORD_REGEX = /[A-Za-z]/;
const ASCII_WORD_CHAR_REGEX = /[A-Za-z0-9]/;

const CJK_LONG_RUN_MIN_CHARS = 34;
const CJK_LONG_RUN_TARGET_CHARS = 24;
const CJK_LONG_RUN_MAX_CHARS = 32;
const CJK_NO_PUNCTUATION_CLASS = "，。！？；：、";

// Connectives that almost always open a fresh clause. Only ever used at the very
// start of an utterance, where a trailing comma is safe and natural.
const CJK_LEADING_COMMA_MARKERS = [
  "所以",
  "因此",
  "然后",
  "但是",
  "不过",
  "不過",
  "另外",
  "其实",
  "其實",
  "首先",
  "总之",
  "總之",
  "例如",
  "比如",
];

// Strong connectives that reliably mark a clause boundary even mid-sentence.
// Deliberately excludes ambiguous words (结果/同时/首先/接下来…) that also live
// inside ordinary noun phrases and used to produce mis-placed commas.
const CJK_MID_COMMA_MARKERS = [
  "但是",
  "不过",
  "不過",
  "可是",
  "因为",
  "因為",
  "所以",
  "因此",
  "否则",
  "否則",
  "而且",
  "并且",
  "並且",
  "然后",
];

const CJK_CLAUSE_END_CHARS = new Set(
  Array.from("了的着著过過好行完上中下后後前里裡内內吗嗎嘛呢吧呀啊哦")
);

// Tiny generic protect list so a long-run split never lands inside a Latin token
// or a couple of product names. No sentence-specific phrases (those over-fit).
const CJK_AVOID_CUT_TERMS = ["API", "Paraformer", "ChordVox"];

const EN_LEADING_COMMA_MARKERS = [
  "however",
  "therefore",
  "meanwhile",
  "actually",
  "basically",
  "frankly",
  "honestly",
  "anyway",
  "overall",
  "first",
  "next",
  "finally",
  "for example",
  "for instance",
  "by the way",
  "in fact",
];

const EN_MID_COMMA_MARKERS = ["but", "so", "however", "therefore", "instead", "otherwise"];

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countCjkChars(value) {
  const matches = String(value || "").match(CJK_CHAR_GLOBAL_REGEX);
  return matches ? matches.length : 0;
}

function shouldInsertSpace(leftText, rightText) {
  const leftChar = String(leftText || "").slice(-1);
  const rightChar = String(rightText || "").slice(0, 1);

  if (!leftChar || !rightChar) {
    return false;
  }

  if (/[.?!,:;\])}]/.test(leftChar) && /[A-Za-z0-9("']/.test(rightChar)) {
    return true;
  }

  if (/[A-Za-z0-9)]/.test(leftChar) && /[A-Za-z0-9("'`]/.test(rightChar)) {
    return true;
  }

  return false;
}

function applyLightPunctuation(rawText) {
  const text = String(rawText || "").trim();
  if (!text) {
    return "";
  }

  const explicitReplacement = replaceExplicitSpokenPunctuation(text);
  const withLightPauses = insertLightPauses(explicitReplacement);
  if (EXISTING_PUNCTUATION_REGEX.test(withLightPauses)) {
    return withLightPauses;
  }

  return `${withLightPauses}${selectTerminalPunctuation(withLightPauses)}`;
}

function replaceExplicitSpokenPunctuation(text) {
  const usesCjk = CJK_CHAR_REGEX.test(text);
  const replacements = [
    {
      pattern: /(句号|句點|period)$/iu,
      replacement: usesCjk ? "。" : ".",
    },
    {
      pattern: /(问号|問號|疑问号|疑問號|question mark)$/iu,
      replacement: usesCjk ? "？" : "?",
    },
    {
      pattern: /(感叹号|感嘆號|惊叹号|驚嘆號|exclamation mark)$/iu,
      replacement: usesCjk ? "！" : "!",
    },
    {
      pattern: /(逗号|逗號|comma)$/iu,
      replacement: usesCjk ? "，" : ",",
    },
  ];

  for (const { pattern, replacement } of replacements) {
    if (pattern.test(text)) {
      return text
        .replace(pattern, replacement)
        .replace(/\s+([,.;:?!，。？！；：])/g, "$1")
        .trim();
    }
  }

  return text;
}

function insertLightPauses(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return "";
  }

  if (CJK_CHAR_REGEX.test(trimmed)) {
    return insertCjkPauses(trimmed);
  }

  if (ENGLISH_WORD_REGEX.test(trimmed)) {
    return insertEnglishPauses(trimmed);
  }

  return trimmed;
}

function insertCjkPauses(text) {
  let result = normalizeCjkSpacing(text);

  result = insertCjkEnumerationPauses(result);
  result = insertCjkTemporalPauses(result);
  result = insertCjkConditionalPauses(result);

  for (const marker of CJK_LEADING_COMMA_MARKERS) {
    const pattern = new RegExp(`^(${escapeRegExp(marker)})(?![，。！？；：])(.{4,})$`, "u");
    result = result.replace(pattern, (_match, lead, rest) => `${lead}，${rest}`);
  }

  result = insertCjkMarkerPauses(result, CJK_MID_COMMA_MARKERS, 4, 4);
  result = splitLongCjkRuns(result);

  return normalizeCjkPunctuation(result);
}

function normalizeCjkSpacing(text) {
  return String(text || "")
    .replace(/\s+([，。！？；：、])/g, "$1")
    .replace(/([，。！？；：、])\s+/g, "$1")
    .trim();
}

function normalizeCjkPunctuation(text) {
  return String(text || "")
    .replace(/([，。！？；：、]){2,}/gu, (marks) => {
      if (/[。！？]/u.test(marks)) {
        return marks.match(/[。！？]/u)[0];
      }
      return marks.includes("：") ? "：" : "，";
    })
    .replace(/，([。！？；：])/gu, "$1")
    .replace(/([。！？；：])，/gu, "$1")
    .trim();
}

// Comma before 第二/第三… enumeration items, plus between consecutive items.
// General to any speech, unlike the old noun-list trigger ("两个问题…").
function insertCjkEnumerationPauses(text) {
  return String(text || "")
    .replace(
      new RegExp(
        `([^${CJK_NO_PUNCTUATION_CLASS}]{4,})(第[二三四五六七八九十]+(?:个|個|点|點)?(?:是)?)(?=[^${CJK_NO_PUNCTUATION_CLASS}]{2,})`,
        "gu"
      ),
      "$1，$2"
    )
    .replace(
      new RegExp(
        `(第[一二三四五六七八九十]+(?:个|個|点|點)?(?:是)?[^${CJK_NO_PUNCTUATION_CLASS}]{3,}?)(?=第[二三四五六七八九十]+(?:个|個|点|點)?(?:是)?)`,
        "gu"
      ),
      "$1，"
    );
}

// Comma after a time phrase (…的时候 / …以后 / …之后 / …之前) when the next
// clause starts with a connective or subject. Bare 时候 is excluded so 小时候 etc.
// never mis-fires.
function insertCjkTemporalPauses(text) {
  return String(text || "").replace(
    new RegExp(
      `([^${CJK_NO_PUNCTUATION_CLASS}]{3,}(?:的时候|的時候|以后|以後|之后|之後|之前))(?=(?:如果|假如|要是|只要|就|才|会|會|可以|需要|不要|直接|请|請|我|你|他|她|它|我们|我們|这|這|那)[^${CJK_NO_PUNCTUATION_CLASS}]{2,})`,
      "gu"
    ),
    "$1，"
  );
}

function insertCjkConditionalPauses(text) {
  return String(text || "").replace(
    new RegExp(
      `((?:如果|假如|要是|只要)[^${CJK_NO_PUNCTUATION_CLASS}]{2,20}?)(?=(?:就|才|不要|直接|可以|需要|会|會|能|应该|應該|默认|默認)[^${CJK_NO_PUNCTUATION_CLASS}]{2,})`,
      "gu"
    ),
    "$1，"
  );
}

function insertCjkMarkerPauses(text, markers, minLeftCjk, minRightCjk) {
  let result = String(text || "");

  for (const marker of markers) {
    const pattern = new RegExp(
      `([^，。！？；：、]{${minLeftCjk},})(${escapeRegExp(marker)})(?=[^，。！？；：、]{${minRightCjk},})`,
      "gu"
    );
    result = result.replace(pattern, (match, left, middle, offset, fullText) => {
      if (CJK_PUNCTUATION_REGEX.test(String(left || "").slice(-1))) {
        return match;
      }

      const rest = fullText.slice(offset + match.length);
      if (countCjkChars(left) < minLeftCjk || countCjkChars(rest) < minRightCjk) {
        return match;
      }

      const punctuation = shouldUseCjkSentenceBreak(left, middle, rest) ? "。" : "，";
      return `${left}${punctuation}${middle}`;
    });
  }

  return result;
}

function shouldUseCjkSentenceBreak(left, marker, rest) {
  const leftCjkCount = countCjkChars(left);
  const restCjkCount = countCjkChars(rest);
  if (leftCjkCount < 18 || restCjkCount < 8) {
    return false;
  }

  return /^(但是|不過|不过|另外|现在|現在|今天|明天|后天|後天|首先)$/u.test(marker);
}

function splitLongCjkRuns(text) {
  return String(text || "").replace(/[^，。！？；：、]+/gu, (segment) => {
    if (countCjkChars(segment) < CJK_LONG_RUN_MIN_CHARS) {
      return segment;
    }

    return splitLongCjkSegment(segment);
  });
}

function splitLongCjkSegment(segment) {
  let remaining = String(segment || "");
  const pieces = [];

  while (countCjkChars(remaining) >= CJK_LONG_RUN_MIN_CHARS) {
    const cutIndex = findCjkCutIndex(remaining);
    if (cutIndex <= 0 || cutIndex >= remaining.length) {
      break;
    }

    const piece = remaining.slice(0, cutIndex).trim();
    remaining = remaining.slice(cutIndex).trim();
    if (piece) {
      pieces.push(piece);
    }
  }

  if (remaining) {
    pieces.push(remaining);
  }

  return pieces
    .map((piece, index) => {
      if (index === pieces.length - 1) {
        return piece;
      }

      return `${piece}${shouldUseCjkQuestionBreak(piece) ? "？" : "，"}`;
    })
    .join("");
}

// Cut a long run only right after a natural clause-ending character (了/的/吧/呢…).
// If there is none in range, return 0 so the caller leaves the run intact — never
// chop a word in half just to hit a length target.
function findCjkCutIndex(segment) {
  const chars = Array.from(String(segment || ""));
  const maxIndex = Math.min(chars.length - 1, CJK_LONG_RUN_MAX_CHARS);
  const minIndex = Math.min(CJK_LONG_RUN_TARGET_CHARS, maxIndex);

  for (let index = maxIndex; index >= minIndex; index -= 1) {
    const previous = chars[index - 1] || "";
    const next = chars[index] || "";
    if (ASCII_WORD_CHAR_REGEX.test(previous) && ASCII_WORD_CHAR_REGEX.test(next)) {
      continue;
    }

    const cutIndex = chars.slice(0, index).join("").length;
    if (isProtectedCjkCut(segment, cutIndex)) {
      continue;
    }

    if (CJK_CLAUSE_END_CHARS.has(previous)) {
      return cutIndex;
    }
  }

  // No clause-ending character in range — leave the run intact rather than drop a
  // comma at an arbitrary word boundary, which reads like a mistake.
  return 0;
}

function isProtectedCjkCut(segment, cutIndex) {
  const value = String(segment || "");
  for (const term of CJK_AVOID_CUT_TERMS) {
    let start = value.indexOf(term);
    while (start !== -1) {
      const end = start + term.length;
      if (cutIndex > start && cutIndex < end) {
        return true;
      }
      start = value.indexOf(term, start + 1);
    }
  }
  return false;
}

function shouldUseCjkQuestionBreak(text) {
  return /[吗嗎么麼呢]$/u.test(String(text || "").trim());
}

function insertEnglishPauses(text) {
  let result = text;

  for (const marker of EN_LEADING_COMMA_MARKERS) {
    const pattern = new RegExp(`^(${escapeRegExp(marker)})(?![,.!?;:])\\b\\s+(.{6,})$`, "i");
    result = result.replace(pattern, (_match, lead, rest) => {
      return `${lead}, ${String(rest || "").trimStart()}`;
    });
  }

  for (const marker of EN_MID_COMMA_MARKERS) {
    const pattern = new RegExp(
      `([A-Za-z0-9)"'\\]](?:[^,.!?;:]{6,}?))\\s+(${escapeRegExp(marker)})\\s+([^,.!?;:]{4,})`,
      "gi"
    );
    result = result.replace(pattern, (_match, left, middle, right) => {
      return `${String(left || "").trimEnd()}, ${middle} ${String(right || "").trimStart()}`;
    });
  }

  return result;
}

function selectTerminalPunctuation(text) {
  if (looksLikeQuestion(text)) {
    return CJK_CHAR_REGEX.test(text) ? "？" : "?";
  }

  if (looksLikeExclamation(text)) {
    return CJK_CHAR_REGEX.test(text) ? "！" : "!";
  }

  return CJK_CHAR_REGEX.test(text) ? "。" : ".";
}

// Conservative: trust reliable sentence-final markers (吗/呢/对不对…), and at the
// start only strongly interrogative openers. Bare 什么/怎么/哪/几/多少 are NOT
// triggers — they appear in plenty of statements ("什么都行", "怎么都可以").
function looksLikeQuestion(text) {
  const normalized = String(text || "")
    .trim()
    .toLowerCase();
  const normalizedWithoutGreeting = normalized.replace(/^(hi|hello|hey)\s+\S+\s+/i, "");

  if (
    /([吗嗎麼么呢？?]|怎么样|怎麼樣|如何|可不可以|行不行|好不好|对不对|對不對|是不是|有没有|有沒有)$/u.test(
      normalized
    ) ||
    /^(请问|請問|为什么|為什麼|为何|為何|是不是|是否|能不能|可不可以|有没有|有沒有|要不要)/u.test(
      normalized
    )
  ) {
    return true;
  }

  return /^(who|what|when|where|why|how|is|are|am|do|does|did|can|could|would|should|will|have|has|had)\b/i.test(
    normalizedWithoutGreeting
  );
}

function looksLikeExclamation(text) {
  return /(太好了|真棒|真好|太棒了|厉害|厲害|awesome|amazing|great)$/iu.test(
    String(text || "").trim()
  );
}

module.exports = {
  applyLightPunctuation,
  shouldInsertSpace,
};
