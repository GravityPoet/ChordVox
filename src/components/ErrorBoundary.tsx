import React from "react";
import i18n from "../i18n";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  context?: string;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  resetCount: number;
}

// React 19 in dev mode (StrictMode + Suspense + lazy + HMR) can race during
// commit-phase deletion and throw a NotFoundError from removeChild. The actual
// UI is fine — the node was already unmounted by a concurrent reconciliation
// pass. We swallow this specific class of error so the user never sees the
// crash screen for a benign dev-only race.
function isDevelopmentRuntime(): boolean {
  return (
    import.meta.env?.MODE === "development" ||
    (typeof process !== "undefined" && process.env?.NODE_ENV === "development")
  );
}

function isReactCommitDeletionRace(error: unknown): boolean {
  if (!isDevelopmentRuntime()) return false;
  if (!error || typeof error !== "object") return false;
  const err = error as { name?: string; message?: string };
  if (err.name !== "NotFoundError") return false;
  const message = err.message || "";
  return message.includes("removeChild") && message.includes("not a child");
}

export default class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, resetCount: 0 };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> | null {
    if (isReactCommitDeletionRace(error)) {
      return null;
    }
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    if (isReactCommitDeletionRace(error)) {
      void window.electronAPI?.log?.({
        level: "warn",
        message: "[ErrorBoundary] Suppressed React commit-deletion race",
        meta: {
          context: this.props.context || "root",
          error: error.message,
        },
        scope: "renderer",
        source: "error-boundary",
      });
      return;
    }
    console.error("[ErrorBoundary] Uncaught error:", error, errorInfo);
    void window.electronAPI?.log?.({
      level: "error",
      message: "[ErrorBoundary] Renderer crash",
      meta: {
        context: this.props.context || "root",
        error: error?.message || "unknown",
        stack: error?.stack || null,
        componentStack: errorInfo?.componentStack || null,
        resetCount: this.state.resetCount,
      },
      scope: "renderer",
      source: "error-boundary",
    });
  }

  handleReload = () => {
    window.location.reload();
  };

  handleReset = () => {
    this.setState((prev) => ({
      hasError: false,
      error: null,
      resetCount: prev.resetCount + 1,
    }));
    this.props.onReset?.();
  };

  render() {
    if (this.state.hasError) {
      const contextKey = this.props.context ? `errorBoundary.context.${this.props.context}` : null;
      const contextLabel = contextKey ? i18n.t(contextKey, { defaultValue: "" }) : "";
      return (
        <div className="min-h-screen flex items-center justify-center bg-transparent p-6">
          <div
            role="alert"
            aria-live="assertive"
            className="max-w-md space-y-4 rounded-3xl border border-white/10 bg-[#0f1118]/92 p-6 text-center text-white shadow-2xl backdrop-blur-xl"
          >
            <h1 className="text-lg font-semibold text-white">{i18n.t("errorBoundary.title")}</h1>
            {contextLabel ? (
              <p className="text-xs uppercase tracking-wide text-white/50">{contextLabel}</p>
            ) : null}
            <p className="text-sm text-white/70">{i18n.t("errorBoundary.description")}</p>
            {this.state.error && (
              <pre className="max-h-32 overflow-auto rounded-2xl border border-white/10 bg-black/25 p-3 text-left text-xs text-rose-200">
                {this.state.error.message}
              </pre>
            )}
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                onClick={this.handleReset}
                className="inline-flex items-center justify-center rounded-full bg-white/12 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-white/18"
              >
                {i18n.t("errorBoundary.tryAgain")}
              </button>
              <button
                onClick={this.handleReload}
                className="inline-flex items-center justify-center rounded-full border border-white/15 px-4 py-2 text-sm font-medium text-white/80 transition-colors hover:bg-white/10"
              >
                {i18n.t("errorBoundary.reload")}
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
