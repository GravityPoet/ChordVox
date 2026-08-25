import openaiIcon from "@/assets/icons/providers/openai.svg";
import anthropicIcon from "@/assets/icons/providers/anthropic.svg";
import doubaoIcon from "@/assets/icons/providers/doubao.png";
import geminiIcon from "@/assets/icons/providers/gemini.svg";
import llamaIcon from "@/assets/icons/providers/llama.svg";
import mistralIcon from "@/assets/icons/providers/mistral.svg";
import qwenIcon from "@/assets/icons/providers/qwen.svg";
import groqIcon from "@/assets/icons/providers/groq.svg";
import nvidiaIcon from "@/assets/icons/providers/nvidia.svg";
import openaiOssIcon from "@/assets/icons/providers/openai-oss.svg";
import openrouterIcon from "@/assets/icons/providers/openrouter.png";
import bedrockIcon from "@/assets/icons/providers/bedrock.png";
import sonioxIcon from "@/assets/icons/providers/soniox.svg";
import deepgramIcon from "@/assets/icons/providers/deepgram.svg";
// Official standalone mark from the Cerebras press kit:
// https://www.cerebras.ai/company/press-kit
import cerebrasIcon from "@/assets/icons/providers/cerebras.svg";

export const PROVIDER_ICONS: Record<string, string> = {
  openai: openaiIcon,
  whisper: openaiIcon,
  openrouter: openrouterIcon,
  anthropic: anthropicIcon,
  doubao: doubaoIcon,
  gemini: geminiIcon,
  "google-cloud": geminiIcon,
  llama: llamaIcon,
  mistral: mistralIcon,
  qwen: qwenIcon,
  groq: groqIcon,
  soniox: sonioxIcon,
  deepgram: deepgramIcon,
  cerebras: cerebrasIcon,
  nvidia: nvidiaIcon,
  "openai-oss": openaiOssIcon,
  bedrock: bedrockIcon,
};

export function getProviderIcon(provider: string): string | undefined {
  return PROVIDER_ICONS[provider];
}

export const MONOCHROME_PROVIDERS = ["openai", "whisper", "anthropic", "openai-oss"] as const;

export function isMonochromeProvider(provider: string): boolean {
  return (MONOCHROME_PROVIDERS as readonly string[]).includes(provider);
}
