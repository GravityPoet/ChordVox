const PROVIDER_GUIDE_LINKS: Record<string, string> = {
  openai: "openai",
  openrouter: "openrouter",
  anthropic: "anthropic",
  gemini: "gemini",
  "google-cloud": "https://cloud.google.com/speech-to-text/v2/docs/chirp_3-model",
  groq: "groq",
  cerebras: "https://inference-docs.cerebras.ai/quickstart",
  soniox: "https://soniox.com/docs/stt/rt/real-time-transcription",
  deepgram: "https://developers.deepgram.com/docs/pre-recorded-audio",
  doubao: "https://www.volcengine.com/docs/6561/1354869?lang=zh",
  mistral: "mistral",
  bedrock: "bedrock",
  custom: "custom-provider",
};

const DEFAULT_GUIDE_URL = "https://chordvox.com/tutorial.html#ai-config";

export function getProviderGuideUrl(provider: string): string {
  const target = PROVIDER_GUIDE_LINKS[provider];
  if (!target) return DEFAULT_GUIDE_URL;
  if (/^https?:\/\//i.test(target)) return target;
  return `https://chordvox.com/tutorial.html#${target}`;
}
