import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import WindowControls from "./WindowControls";
import { Button } from "./ui/button";
import { Power } from "lucide-react";
import { ConfirmDialog } from "./ui/dialog";
import { useToast } from "./ui/toastContext";

interface TitleBarProps {
  title?: string;
  showTitle?: boolean;
  children?: React.ReactNode;
  className?: string;
  actions?: React.ReactNode;
  /** Settings modal open: hide all bar visuals (they bleed through the
      translucent glass sheet) but keep the window draggable. */
  dragOnly?: boolean;
}

export default function TitleBar({
  title = "",
  showTitle = false,
  children,
  className = "",
  actions,
  dragOnly = false,
}: TitleBarProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [showQuitConfirm, setShowQuitConfirm] = useState(false);

  const platform =
    typeof window !== "undefined" && window.electronAPI?.getPlatform
      ? window.electronAPI.getPlatform()
      : "darwin";

  const handleQuit = async () => {
    try {
      const quit = window.electronAPI?.appQuit;
      if (!quit) throw new Error("appQuit API is unavailable");
      await quit();
    } catch (error) {
      console.error("Failed to quit ChordVox:", error);
      toast({
        title: t("windowControls.actionFailedTitle"),
        description: t("windowControls.actionFailedDescription", {
          action: t("titleBar.quit"),
        }),
        variant: "destructive",
      });
    }
  };

  const getActionsContent = () => {
    if (!actions) return null;

    if (platform !== "darwin" && React.isValidElement(actions)) {
      const el = actions as React.ReactElement<{ children?: React.ReactNode }>;
      const childrenArray = React.Children.toArray(el.props.children);
      return <>{[...childrenArray].reverse()}</>;
    }

    return actions;
  };

  // Settings modal open: the bar's icons (help / settings / power) sit behind the
  // see-through glass sheet and bleed through. Drop all bar visuals. On macOS keep
  // a transparent drag strip above the modal so the frameless window stays
  // draggable from the top; on other platforms the modal carries its own close.
  if (dragOnly) {
    return platform === "darwin" ? (
      <div
        className="fixed inset-x-0 top-0 h-10 z-[60]"
        style={{ WebkitAppRegion: "drag" }}
        aria-hidden="true"
      />
    ) : null;
  }

  return (
    <div className={`titlebar-glass select-none ${className}`}>
      <div
        className="flex items-center justify-between h-12 px-4"
        style={{ WebkitAppRegion: "drag" }}
      >
        <div className="flex items-center gap-2" style={{ WebkitAppRegion: "no-drag" }}>
          {platform !== "darwin" ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setShowQuitConfirm(true)}
                className="h-8 w-8 text-destructive hover:text-destructive/90 hover:bg-destructive/10"
                title={t("titleBar.quitTitle")}
                aria-label={t("titleBar.quitTitle")}
              >
                <Power size={16} />
              </Button>
              {getActionsContent()}
            </>
          ) : (
            <>
              {showTitle && title && (
                <h1 className="text-sm font-semibold text-foreground">{title}</h1>
              )}
              {children}
            </>
          )}
        </div>

        <div className="flex items-center gap-2" style={{ WebkitAppRegion: "no-drag" }}>
          {platform !== "darwin" ? (
            <>
              <WindowControls />
            </>
          ) : (
            <>
              {actions}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setShowQuitConfirm(true)}
                className="h-8 w-8 text-destructive hover:text-destructive/90 hover:bg-destructive/10"
                title={t("titleBar.quitTitle")}
                aria-label={t("titleBar.quitTitle")}
              >
                <Power size={16} />
              </Button>
            </>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={showQuitConfirm}
        onOpenChange={setShowQuitConfirm}
        title={t("titleBar.quitConfirmTitle")}
        description={t("titleBar.quitConfirmDescription")}
        confirmText={t("titleBar.quit")}
        cancelText={t("titleBar.cancel")}
        onConfirm={handleQuit}
        variant="destructive"
      />
    </div>
  );
}
