import { afterEach, describe, expect, it, vi } from "vitest";
import GoogleCloudSttClient from "./googleCloudStt";
import DeepgramAsrClient from "./deepgramAsr";

const originalFetch = globalThis.fetch;

function installAbortableFetch() {
  globalThis.fetch = vi.fn((_url, options = {}) => {
    return new Promise((_resolve, reject) => {
      const rejectAsAborted = () => {
        const error = new Error("request aborted");
        error.name = "AbortError";
        reject(error);
      };

      if (options.signal?.aborted) {
        rejectAsAborted();
        return;
      }
      options.signal?.addEventListener?.("abort", rejectAsAborted, { once: true });
    });
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("cloud transcription cancellation", () => {
  it("links the caller signal to Google Cloud STT fetch", async () => {
    installAbortableFetch();
    const controller = new AbortController();
    const client = new GoogleCloudSttClient();
    const request = client.transcribe({
      audioBuffer: Buffer.from([1, 2, 3]),
      endpoint:
        "https://us-speech.googleapis.com/v2/projects/test/locations/us/recognizers/_:recognize",
      credential: "test-api-key",
      model: "chirp_3",
      language: "en",
      signal: controller.signal,
    });

    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("links the caller signal to Deepgram fetch", async () => {
    installAbortableFetch();
    const controller = new AbortController();
    const client = new DeepgramAsrClient();
    const request = client.transcribe({
      audioBuffer: Buffer.from([1, 2, 3]),
      apiKey: "test-api-key",
      endpoint: "https://api.deepgram.com/v1/listen",
      model: "nova-3",
      language: "en",
      mimeType: "audio/webm",
      signal: controller.signal,
    });

    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
