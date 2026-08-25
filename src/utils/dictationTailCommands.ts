export type TailCommandResult = {
  command: "cancel" | "redo";
  matchedText: string;
} | null;

// Command phrases must be intent-explicit. Bare words like "取消"/"cancel"/
// "重来"/"redo" are excluded on purpose: they appear at the end of normal
// dictation ("帮我把会议取消", "add a redo button") and would silently
// discard the user's text. Each phrase must also be preceded by a pause
// boundary (start of text, whitespace, or punctuation) so substrings inside
// longer words ("级别输出") never match.
const BOUNDARY = /(?:^|[\s，。,、；;！？!?.])/.source;
const TRAILING = /[\s。？！.!?]*$/.source;

const CANCEL_REGEX = new RegExp(
  `${BOUNDARY}(取消别输出|取消听写|别输出了|别输出|不要输出|cancel dictation|do not output)${TRAILING}`,
  "i"
);
const REDO_REGEX = new RegExp(
  `${BOUNDARY}(重新说|重来说吧|重来说|重新录音|重新来过|start over)${TRAILING}`,
  "i"
);

/**
 * Checks if the transcription ends with a voice command ("cancel" or "redo").
 * It cleans trailing spaces before matching.
 */
export function matchTailCommand(text: string): TailCommandResult {
  if (!text) return null;

  const trimmed = text.trim();

  // Test cancel command first
  const cancelMatch = trimmed.match(CANCEL_REGEX);
  if (cancelMatch) {
    return {
      command: "cancel",
      matchedText: cancelMatch[1],
    };
  }

  // Test redo command
  const redoMatch = trimmed.match(REDO_REGEX);
  if (redoMatch) {
    return {
      command: "redo",
      matchedText: redoMatch[1],
    };
  }

  return null;
}
