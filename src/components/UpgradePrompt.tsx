import { Dialog, DialogContent } from "./ui/dialog";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUsage } from "../hooks/useUsage";
import { useSettings } from "../hooks/useSettings";
import { Card } from "./ui/card";

interface UpgradePromptProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wordsUsed?: number;
  limit?: number;
}

export default function UpgradePrompt({
  open,
  onOpenChange,
  wordsUsed = 2000,
  limit = 2000,
}: UpgradePromptProps) {
  const { t } = useTranslation();
  const usage = useUsage();
  const { setUseLocalWhisper, setCloudTranscriptionMode } = useSettings();
  const isPastDue = usage?.isPastDue ?? false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <div className="text-center space-y-2 pt-2">
          <h2 className="text-xl font-semibold text-foreground">
            {isPastDue ? t("upgradePrompt.paymentFailed") : t("upgradePrompt.weeklyLimit")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {(isPastDue
              ? t("upgradePrompt.pastDueDescription", { limit: limit.toLocaleString() })
              : t("upgradePrompt.limitDescription", {
                  used: wordsUsed.toLocaleString(),
                  limit: limit.toLocaleString(),
                })
            )
              .split("\n")
              .map((line, i, arr) => (
                <span key={i}>
                  {line}
                  {i < arr.length - 1 && <br />}
                </span>
              ))}
          </p>
        </div>

        <div className="space-y-2 pt-2">
          {isPastDue ? (
            <OptionCard
              title={t("upgradePrompt.updatePayment")}
              description={t("upgradePrompt.updatePaymentDescription")}
              onClick={() => {
                usage?.openBillingPortal();
              }}
              highlighted
              disabled={usage?.checkoutLoading}
            />
          ) : (
            <OptionCard
              title={t("upgradePrompt.upgradeToPro")}
              description={t("upgradePrompt.upgradeDescription")}
              onClick={() => {
                usage?.openCheckout();
              }}
              highlighted
              disabled={usage?.checkoutLoading}
            />
          )}
          <OptionCard
            title={t("upgradePrompt.useApiKey")}
            description={t("upgradePrompt.useApiKeyDescription")}
            onClick={() => {
              setCloudTranscriptionMode("byok");
              onOpenChange(false);
            }}
          />
          <OptionCard
            title={t("upgradePrompt.switchToLocal")}
            description={t("upgradePrompt.switchToLocalDescription")}
            onClick={() => {
              setUseLocalWhisper(true);
              onOpenChange(false);
            }}
          />
        </div>

        <p className="text-xs text-muted-foreground/60 text-center">
          {t("upgradePrompt.rollingWeeklyLimit")}
        </p>
      </DialogContent>
    </Dialog>
  );
}

function OptionCard({
  title,
  description,
  onClick,
  highlighted = false,
  disabled = false,
}: {
  title: string;
  description: string;
  onClick: () => void;
  highlighted?: boolean;
  disabled?: boolean;
}) {
  return (
    <Card
      variant={highlighted ? "featured" : "default"}
      className={`overflow-hidden transition-all duration-150 ${
        highlighted ? "backdrop-blur-lg" : "glass-panel glass-panel--soft backdrop-blur-md"
      } ${disabled ? "opacity-60" : "hover:shadow-[var(--ui-glass-panel-shadow-hover)]"}`}
    >
      <button
        onClick={onClick}
        disabled={disabled}
        className={`flex w-full items-center justify-between gap-4 p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed ${
          highlighted
            ? "hover:bg-primary/12 active:bg-primary/16"
            : "hover:bg-surface-2/78 active:bg-surface-3/72"
        }`}
      >
        <div>
          <div className="font-medium text-foreground">{title}</div>
          <div className="text-sm text-muted-foreground">{description}</div>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60" />
      </button>
    </Card>
  );
}
