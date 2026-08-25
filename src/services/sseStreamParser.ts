/**
 * Minimal SSE line parser shared by OpenAI/Gemini/Groq streaming polish paths.
 * Yields raw payload strings (everything after `data: `), with `[DONE]`
 * terminating the stream. Provider-specific JSON parsing is the caller's job.
 *
 * Handles cross-chunk line boundaries by buffering the trailing fragment until
 * the next read fills it in.
 */
export async function* parseSseStream(response: Response): AsyncGenerator<string> {
  if (!response.body) {
    throw new Error("SSE response has no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        const remainder = buffer.trim();
        if (remainder.startsWith("data:")) {
          const payload = remainder.slice(5).trim();
          if (payload && payload !== "[DONE]") yield payload;
        }
        return;
      }

      buffer += decoder.decode(value, { stream: true });

      // Split on LF; trailing fragment (incomplete line) goes back in buffer.
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith(":")) continue; // SSE comment
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === "[DONE]") return;
        yield payload;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* reader already released */
    }
  }
}

export function createSsePayloadParser(onPayload: (payload: string) => void): {
  push: (chunk: string) => void;
  flush: () => void;
} {
  let buffer = "";
  let done = false;

  const consumeLine = (rawLine: string) => {
    if (done) return;
    const line = rawLine.trim();
    if (!line) return;
    if (line.startsWith(":")) return;
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      done = true;
      return;
    }
    onPayload(payload);
  };

  return {
    push(chunk: string) {
      if (done || !chunk) return;
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
    },
    flush() {
      if (done) return;
      const remainder = buffer;
      buffer = "";
      if (remainder) consumeLine(remainder);
    },
  };
}

/**
 * 30 fps throttle for onProgress callbacks. Final emit (forceFlush) bypasses
 * the cooldown so the last partial always lands.
 */
export function createProgressThrottle(
  onProgress: (text: string) => void,
  minIntervalMs = 33
): { emit: (text: string) => void; flush: (text: string) => void } {
  let lastEmit = 0;
  return {
    emit(text: string) {
      const now = Date.now();
      if (now - lastEmit < minIntervalMs) return;
      lastEmit = now;
      onProgress(text);
    },
    flush(text: string) {
      lastEmit = Date.now();
      onProgress(text);
    },
  };
}
