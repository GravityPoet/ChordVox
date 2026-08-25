import { Brain, Wrench, HardDrive } from "lucide-react";
import { getProviderIcon } from "@/utils/providerIcons";

interface ProviderIconProps {
  provider: string;
  className?: string;
}

const MONOCHROME_PROVIDERS = ["openai", "whisper", "anthropic", "openai-oss"];

export function ProviderIcon({ provider, className = "w-5 h-5" }: ProviderIconProps) {
  if (provider === "custom") {
    return <Wrench className={className} aria-hidden="true" />;
  }

  if (provider === "local") {
    return <HardDrive className={className} aria-hidden="true" />;
  }

  const iconUrl = getProviderIcon(provider);

  if (!iconUrl) {
    return <Brain className={className} aria-hidden="true" />;
  }

  const isMonochrome = MONOCHROME_PROVIDERS.includes(provider);

  return (
    <img
      src={iconUrl}
      alt=""
      width={20}
      height={20}
      aria-hidden="true"
      className={`${className} ${isMonochrome ? "icon-monochrome" : ""}`}
    />
  );
}
