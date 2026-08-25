import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Minus, Square, X, Copy } from "lucide-react";
import { useToast } from "./ui/toastContext";

/**
 * Window control buttons for Linux and Windows platforms
 * Provides minimize, maximize/restore, and close functionality
 * macOS uses native window controls so this component is not rendered there
 */
export default function WindowControls() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [isMaximized, setIsMaximized] = useState(false);

  const showActionFailure = (action: string, error: unknown) => {
    console.error(`Window action failed (${action}):`, error);
    toast({
      title: t("windowControls.actionFailedTitle"),
      description: t("windowControls.actionFailedDescription", { action }),
      variant: "destructive",
    });
  };

  useEffect(() => {
    let mounted = true;

    // Sync maximized state with main process
    const syncIsMaximized = async () => {
      try {
        const maximized = await window.electronAPI?.windowIsMaximized?.();
        if (mounted) {
          setIsMaximized(!!maximized);
        }
      } catch {
        // Silently handle if API not available
      }
    };

    // Initial sync
    syncIsMaximized();

    // Poll for changes (window can be maximized via double-click on title bar, etc.)
    const intervalId = setInterval(syncIsMaximized, 1000);

    return () => {
      mounted = false;
      clearInterval(intervalId);
    };
  }, []);

  const handleMinimize = async () => {
    try {
      const minimize = window.electronAPI?.windowMinimize;
      if (!minimize) throw new Error("windowMinimize API is unavailable");
      await minimize();
    } catch (error) {
      showActionFailure(t("windowControls.minimize"), error);
    }
  };

  const handleMaximize = async () => {
    try {
      const maximize = window.electronAPI?.windowMaximize;
      if (!maximize) throw new Error("windowMaximize API is unavailable");
      await maximize();
      setIsMaximized((current) => !current);

      // Reconcile with the real window state when available. A failed status
      // query should not report the already-successful maximize action as failed.
      try {
        const maximized = await window.electronAPI?.windowIsMaximized?.();
        if (typeof maximized === "boolean") setIsMaximized(maximized);
      } catch (error) {
        console.warn("Could not refresh maximized window state:", error);
      }
    } catch (error) {
      showActionFailure(
        isMaximized ? t("windowControls.restore") : t("windowControls.maximize"),
        error
      );
    }
  };

  const handleClose = async () => {
    try {
      const close = window.electronAPI?.windowClose;
      if (!close) throw new Error("windowClose API is unavailable");
      await close();
    } catch (error) {
      showActionFailure(t("windowControls.close"), error);
    }
  };

  return (
    <div className="flex items-center gap-1 pointer-events-auto">
      <Button
        variant="ghost"
        size="icon"
        onClick={handleMinimize}
        title={t("windowControls.minimize")}
        aria-label={t("windowControls.minimize")}
        className="h-8 w-8"
      >
        <Minus size={14} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={handleMaximize}
        title={isMaximized ? t("windowControls.restore") : t("windowControls.maximize")}
        aria-label={isMaximized ? t("windowControls.restore") : t("windowControls.maximize")}
        className="h-8 w-8"
      >
        {isMaximized ? <Copy size={14} /> : <Square size={12} />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={handleClose}
        className="h-8 w-8 hover:text-destructive hover:bg-destructive/10"
        title={t("windowControls.close")}
        aria-label={t("windowControls.close")}
      >
        <X size={14} />
      </Button>
    </div>
  );
}
