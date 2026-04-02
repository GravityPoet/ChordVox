import React from "react";
import i18n from "../i18n";

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("[ErrorBoundary] Uncaught error:", error, errorInfo);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-transparent p-6">
          <div className="max-w-md space-y-4 rounded-3xl border border-white/10 bg-[#0f1118]/92 p-6 text-center text-white shadow-2xl backdrop-blur-xl">
            <h1 className="text-lg font-semibold text-white">{i18n.t("errorBoundary.title")}</h1>
            <p className="text-sm text-white/70">{i18n.t("errorBoundary.description")}</p>
            {this.state.error && (
              <pre className="max-h-32 overflow-auto rounded-2xl border border-white/10 bg-black/25 p-3 text-left text-xs text-rose-200">
                {this.state.error.message}
              </pre>
            )}
            <button
              onClick={this.handleReload}
              className="inline-flex items-center justify-center rounded-full bg-white/12 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-white/18"
            >
              {i18n.t("errorBoundary.reload")}
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
