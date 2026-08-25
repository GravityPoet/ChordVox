import * as React from "react";
import { X, Copy, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { ToastContext, type ToastProps } from "./toastContext";

interface ToastState extends ToastProps {
  id: string;
  isExiting?: boolean;
  createdAt: number;
}

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = React.useState<ToastState[]>([]);
  const timersRef = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const clearTimer = React.useCallback((id: string) => {
    const timer = timersRef.current[id];
    if (timer) {
      clearTimeout(timer);
      delete timersRef.current[id];
    }
  }, []);

  const startExitAnimation = React.useCallback((id: string) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, isExiting: true } : t)));
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 200);
  }, []);

  const toast = React.useCallback(
    (props: Omit<ToastProps, "id">) => {
      const id = Math.random().toString(36).substring(2, 11);
      const duration = props.duration ?? (props.variant === "destructive" ? 6000 : 3500);
      const newToast: ToastState = { ...props, duration, id, createdAt: Date.now() };

      setToasts((prev) => [...prev, newToast]);

      if (duration > 0) {
        const timer = setTimeout(() => {
          startExitAnimation(id);
        }, duration);
        timersRef.current[id] = timer;
      }

      return id;
    },
    [startExitAnimation]
  );

  const dismiss = React.useCallback(
    (id?: string) => {
      if (id) {
        clearTimer(id);
        startExitAnimation(id);
      } else {
        const lastToast = toasts[toasts.length - 1];
        if (lastToast) {
          clearTimer(lastToast.id);
          startExitAnimation(lastToast.id);
        }
      }
    },
    [toasts, clearTimer, startExitAnimation]
  );

  const pauseTimer = React.useCallback(
    (id: string) => {
      clearTimer(id);
    },
    [clearTimer]
  );

  const resumeTimer = React.useCallback(
    (id: string, remainingTime: number) => {
      if (remainingTime > 0) {
        const timer = setTimeout(() => {
          startExitAnimation(id);
        }, remainingTime);
        timersRef.current[id] = timer;
      }
    },
    [startExitAnimation]
  );

  React.useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const id in timers) {
        clearTimeout(timers[id]);
      }
    };
  }, []);

  return (
    <ToastContext.Provider value={{ toast, dismiss, toastCount: toasts.length }}>
      {children}
      <ToastViewport
        toasts={toasts}
        onDismiss={dismiss}
        onPauseTimer={pauseTimer}
        onResumeTimer={resumeTimer}
      />
    </ToastContext.Provider>
  );
};

const ToastViewport: React.FC<{
  toasts: ToastState[];
  onDismiss: (id: string) => void;
  onPauseTimer: (id: string) => void;
  onResumeTimer: (id: string, remainingTime: number) => void;
}> = ({ toasts, onDismiss, onPauseTimer, onResumeTimer }) => {
  const isDictationPanel = React.useMemo(() => {
    return (
      window.location.pathname.indexOf("control") === -1 &&
      window.location.search.indexOf("panel=true") === -1
    );
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      data-toast-viewport="true"
      className={cn(
        "fixed z-[60] flex flex-col gap-1.5 pointer-events-none",
        isDictationPanel
          ? "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 items-center"
          : "bottom-5 right-5"
      )}
    >
      {toasts.map((toast) => (
        <Toast
          key={toast.id}
          {...toast}
          prominent={isDictationPanel}
          onClose={() => onDismiss(toast.id)}
          onPauseTimer={() => onPauseTimer(toast.id)}
          onResumeTimer={(remaining) => onResumeTimer(toast.id, remaining)}
        />
      ))}
    </div>
  );
};

const variantConfig = {
  default: {
    accentClass: "bg-white/20",
    progressClass: "bg-white/15",
  },
  destructive: {
    accentClass: "bg-red-400",
    progressClass: "bg-red-400/30",
  },
  success: {
    accentClass: "bg-emerald-400",
    progressClass: "bg-emerald-400/30",
  },
};

const stopToastControlEvent = (event: React.SyntheticEvent) => {
  event.preventDefault();
  event.stopPropagation();
  const nativeEvent = event.nativeEvent as Event & {
    stopImmediatePropagation?: () => void;
  };
  nativeEvent.stopImmediatePropagation?.();
};

const Toast: React.FC<
  ToastState & {
    onClose?: () => void;
    onPauseTimer: () => void;
    onResumeTimer: (remaining: number) => void;
    prominent?: boolean;
  }
> = ({
  title,
  description,
  action,
  variant = "default",
  duration = 3500,
  isExiting,
  createdAt,
  onClose,
  onPauseTimer,
  onResumeTimer,
  prominent = false,
}) => {
  const { t } = useTranslation();
  const config = variantConfig[variant];
  const pausedAtRef = React.useRef<number | null>(null);
  const activeSinceRef = React.useRef(createdAt);
  const remainingTimeRef = React.useRef(duration);
  const [copied, setCopied] = React.useState(false);
  const isDestructive = variant === "destructive";

  const handleMouseEnter = () => {
    if (duration <= 0 || pausedAtRef.current !== null) return;
    const now = Date.now();
    remainingTimeRef.current = Math.max(
      remainingTimeRef.current - (now - activeSinceRef.current),
      0
    );
    pausedAtRef.current = now;
    onPauseTimer();
  };

  const handleMouseLeave = () => {
    if (pausedAtRef.current !== null && duration > 0) {
      const remaining = Math.max(remainingTimeRef.current, 500);
      remainingTimeRef.current = remaining;
      activeSinceRef.current = Date.now();
      onResumeTimer(remaining);
    }
    pausedAtRef.current = null;
  };

  const handleCopyError = async () => {
    if (!description) return;
    try {
      await navigator.clipboard.writeText(description);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Silently fail
    }
  };

  const handleCopyButtonClick = async (event: React.MouseEvent<HTMLButtonElement>) => {
    stopToastControlEvent(event);
    await handleCopyError();
  };

  const handleToastControlPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    stopToastControlEvent(event);
  };

  const handleToastControlMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
    stopToastControlEvent(event);
  };

  const handleCloseClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    stopToastControlEvent(event);
    onClose?.();
  };

  const message = title || description;
  const detail = title && description ? description : undefined;
  const isPersistent = duration <= 0;

  return (
    <div
      role={isDestructive ? "alert" : "status"}
      aria-live={isDestructive ? "assertive" : "polite"}
      aria-atomic="true"
      className={cn(
        "group toast-surface pointer-events-auto relative flex max-w-[calc(100vw-32px)] overflow-hidden",
        prominent ? "w-[468px] rounded-[14px]" : "w-96 rounded-[12px]",
        "transition-all duration-200 ease-out",
        isExiting
          ? "opacity-0 translate-y-1 scale-[0.98]"
          : "opacity-100 translate-y-0 scale-100 animate-in fade-in-0 zoom-in-95 duration-300"
      )}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className={cn("w-0.5 shrink-0", config.accentClass)} />

      <div
        className={cn(
          "flex items-start flex-1 min-w-0",
          prominent ? "gap-3 px-4 py-3.5 pr-10" : "gap-2 px-2.5 py-2 pr-7"
        )}
      >
        <div className="flex-1 min-w-0">
          {message && (
            <div
              className={cn(
                "font-semibold leading-tight text-white/90",
                prominent ? "text-[16px]" : "text-[12px]"
              )}
            >
              {message}
            </div>
          )}
          {detail &&
            (isDestructive ? (
              <div
                className={cn(
                  prominent
                    ? "mt-2 rounded-[5px] px-2 py-1.5 text-[13px]"
                    : "mt-1 rounded-[3px] px-1.5 py-1 text-[11px]",
                  "leading-snug font-mono",
                  "bg-white/4 border border-white/6",
                  "text-red-300/80"
                )}
              >
                <div className="flex items-start justify-between gap-1.5">
                  <span className="select-all wrap-break-word min-w-0">{detail}</span>
                  <button
                    type="button"
                    onPointerDown={handleToastControlPointerDown}
                    onMouseDown={handleToastControlMouseDown}
                    onClick={handleCopyButtonClick}
                    className={cn(
                      "shrink-0 p-0.5 rounded-xs mt-px",
                      "text-white/30 hover:text-white/70",
                      "hover:bg-white/6",
                      "transition-all duration-150"
                    )}
                    aria-label={t("common.copy")}
                  >
                    {copied ? (
                      <Check className="size-3" aria-hidden="true" />
                    ) : (
                      <Copy className="size-3" aria-hidden="true" />
                    )}
                  </button>
                </div>
              </div>
            ) : (
              <div
                className={cn(
                  "text-white/60",
                  prominent ? "mt-2 text-[14px] leading-[1.45]" : "mt-0.5 text-[11px] leading-snug"
                )}
              >
                {detail}
              </div>
            ))}
        </div>

        {action && <div className="shrink-0 self-center">{action}</div>}
      </div>

      {onClose && (
        <button
          type="button"
          onPointerDown={handleToastControlPointerDown}
          onMouseDown={handleToastControlMouseDown}
          onClick={handleCloseClick}
          aria-label={t("windowControls.close")}
          className={cn(
            "absolute rounded-[3px]",
            prominent ? "right-2 top-2 p-1.5" : "right-1 top-1 p-1",
            isPersistent
              ? "text-white/45 hover:!text-white/80"
              : "text-white/0 group-hover:text-white/50 hover:!text-white/80",
            "hover:bg-white/6",
            "transition-all duration-150",
            "focus-visible:!text-white/80",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          )}
        >
          <X className={cn(prominent ? "size-4" : "size-3")} aria-hidden="true" />
          <span className="sr-only">{t("windowControls.close")}</span>
        </button>
      )}

      {duration > 0 && !isExiting && (
        <div className="absolute bottom-0 left-0.5 right-0 h-px overflow-hidden" aria-hidden="true">
          <div
            className={cn("h-full", config.progressClass)}
            style={{
              animation: `toast-progress ${duration}ms linear forwards`,
            }}
          />
        </div>
      )}
    </div>
  );
};
