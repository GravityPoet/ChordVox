import React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import { HelpCircle, Copy, Bug } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { cn } from "../lib/utils";
import { useToast } from "./toastContext";

interface SupportDropdownProps {
  className?: string;
}

const SUPPORT_EMAIL_ADDRESS = "gravitypoet@icloud.com";

const openExternal = async (url: string): Promise<boolean> => {
  try {
    const result = await window.electronAPI?.openExternal(url);
    if (!result?.success) {
      console.error("Failed to open URL:", result?.error);
      return false;
    }
    return true;
  } catch (error) {
    console.error("Error opening URL:", error);
    return false;
  }
};

export default function SupportDropdown({ className }: SupportDropdownProps) {
  const { t } = useTranslation();
  const { toast } = useToast();

  const notifyOpenFailed = React.useCallback(
    (url: string) => {
      toast({
        title: t("support.openFailed.title"),
        description: t("support.openFailed.description", { url }),
        variant: "destructive",
      });
    },
    [t, toast]
  );

  const handleOpenExternal = React.useCallback(
    async (url: string) => {
      const opened = await openExternal(url);
      if (!opened) {
        notifyOpenFailed(url);
      }
    },
    [notifyOpenFailed]
  );

  const handleCopySupportEmail = React.useCallback(async () => {
    const result = await window.electronAPI?.writeClipboard?.(SUPPORT_EMAIL_ADDRESS);
    if (result?.success) {
      toast({
        title: t("support.emailCopied.title"),
        description: t("support.emailCopied.description", { email: SUPPORT_EMAIL_ADDRESS }),
        variant: "success",
      });
      return;
    }

    toast({
      title: t("support.copyFailed.title"),
      description: t("support.copyFailed.description", { email: SUPPORT_EMAIL_ADDRESS }),
      variant: "destructive",
    });
  }, [t, toast]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("support.menuLabel")}
          title={t("support.menuLabel")}
          className={cn(
            "text-foreground/70 hover:text-foreground hover:bg-foreground/10",
            className
          )}
        >
          <HelpCircle size={16} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => void handleCopySupportEmail()}>
          <Copy className="mr-2 h-4 w-4" />
          {t("support.contact")}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => handleOpenExternal("https://github.com/GravityPoet/ChordVox/issues")}
        >
          <Bug className="mr-2 h-4 w-4" />
          {t("support.submitBug")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
