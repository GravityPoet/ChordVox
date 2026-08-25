import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Clipboard, FolderOpen, X } from "lucide-react";
import { Button } from "./ui/button";
import type { FileTranscriptionCompletionAlertPayload } from "../types/electron";

const truncateMiddle = (value: string, maxLength = 72) => {
  const text = String(value || "").trim();
  if (text.length <= maxLength) return text;
  const headLength = Math.ceil((maxLength - 1) * 0.56);
  const tailLength = Math.max(8, maxLength - headLength - 1);
  return `${text.slice(0, headLength)}...${text.slice(-tailLength)}`;
};

export default function FileTranscriptionCompletionAlert() {
  const { t } = useTranslation();
  const [payload, setPayload] = useState<FileTranscriptionCompletionAlertPayload | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => {
    let mounted = true;

    const loadPayload = async () => {
      const nextPayload = await window.electronAPI?.getFileTranscriptionCompletionAlert?.();
      if (mounted) {
        setPayload(nextPayload || null);
      }
    };

    void loadPayload();

    const dispose = window.electronAPI?.onFileTranscriptionCompletionAlert?.((nextPayload) => {
      setCopied(false);
      setCopyFailed(false);
      setPayload(nextPayload || null);
    });

    return () => {
      mounted = false;
      dispose?.();
    };
  }, []);

  const fileName = useMemo(
    () => truncateMiddle(payload?.fileName || t("controlPanel.history.selectedFileFallback"), 76),
    [payload?.fileName, t]
  );

  const handleClose = useCallback(() => {
    void window.electronAPI?.hideFileTranscriptionCompletionAlert?.();
  }, []);

  const handleOpenHistory = useCallback(() => {
    void window.electronAPI?.openTranscriptionHistory?.();
  }, []);

  const handleCopy = useCallback(async () => {
    const text = String(payload?.text || "");
    if (!text) {
      return;
    }

    const result = await window.electronAPI?.writeClipboard?.(text);
    if (result?.success === true) {
      setCopyFailed(false);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
      return;
    }
    setCopied(false);
    setCopyFailed(true);
    window.setTimeout(() => setCopyFailed(false), 2400);
  }, [payload?.text]);

  return (
    <div className="completion-alert-window min-h-screen p-3">
      <div className="completion-alert-surface animate-in fade-in-0 slide-in-from-bottom-2 duration-200">
        <button
          type="button"
          onClick={handleClose}
          className="completion-alert-close"
          aria-label={t("common.close")}
        >
          <X size={14} />
        </button>

        <div className="flex items-start gap-3 pr-6">
          <div className="completion-alert-icon">
            <Check size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-foreground">
              {payload?.title || t("controlPanel.history.transcribedFileTitle")}
            </p>
            <p className="completion-alert-description mt-1 break-words text-[12px] leading-5 text-muted-foreground">
              {payload?.description ||
                t("controlPanel.history.transcribedFileDescription", {
                  name: fileName,
                })}
            </p>
            <p className="mt-1 truncate text-[11px] text-muted-foreground/70" title={fileName}>
              {fileName}
            </p>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCopy}
            disabled={!payload?.text}
            title={copyFailed ? t("controlPanel.history.couldNotCopyDescription") : undefined}
            className="h-8 px-3 text-[11px]"
          >
            {copied ? (
              <Check size={13} className="mr-1.5" />
            ) : (
              <Clipboard size={13} className="mr-1.5" />
            )}
            {copied
              ? t("controlPanel.history.copiedTitle")
              : copyFailed
                ? t("controlPanel.history.couldNotCopyTitle")
                : t("common.copy")}
          </Button>
          {Number(payload?.id) > 0 ? (
            <Button
              type="button"
              size="sm"
              onClick={handleOpenHistory}
              className="h-8 px-3 text-[11px]"
            >
              <FolderOpen size={13} className="mr-1.5" />
              {t("settingsPage.fileTranscription.historyButton")}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
