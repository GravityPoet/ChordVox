import { useTranslation } from "react-i18next";
import appIcon from "../assets/icon.png";
import { LiquidGlassFilters } from "./ui/LiquidGlassFilters";

export default function LoadingFallback({
  message,
  glass = false,
}: {
  message?: string;
  glass?: boolean;
}) {
  const { t } = useTranslation();
  const fallbackMessage = message || t("app.loading");

  return (
    <div
      className={`min-h-screen flex items-center justify-center ${
        glass ? "app-glass-shell" : "bg-background"
      }`}
    >
      {glass ? <LiquidGlassFilters /> : null}
      <div className="flex flex-col items-center gap-4 animate-[scale-in_300ms_ease-out]">
        <img
          src={appIcon}
          alt="ChordVox"
          className="w-12 h-12 object-contain rounded-xl drop-shadow-[0_2px_8px_rgba(37,99,235,0.18)] dark:drop-shadow-[0_2px_12px_rgba(100,149,237,0.25)]"
        />
        <div className="w-7 h-7 rounded-full border-[2.5px] border-transparent border-t-primary animate-[spinner-rotate_0.8s_cubic-bezier(0.4,0,0.2,1)_infinite] motion-reduce:animate-none motion-reduce:border-t-muted-foreground motion-reduce:opacity-50" />
        {fallbackMessage ? (
          <p className="text-[13px] font-medium text-muted-foreground dark:text-foreground/60 tracking-[-0.01em]">
            {fallbackMessage}
          </p>
        ) : null}
      </div>
    </div>
  );
}
