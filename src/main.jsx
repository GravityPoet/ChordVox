import React from "react";
import ReactDOM from "react-dom/client";
import * as SentryRenderer from "@sentry/electron/renderer";
import { I18nextProvider } from "react-i18next";
import AppRouter from "./components/AppRouter.jsx";
import ErrorBoundary from "./components/ErrorBoundary.tsx";
import { ToastProvider } from "./components/ui/Toast.tsx";
import { SettingsProvider } from "./hooks/useSettings";
import i18n, { i18nReady } from "./i18n";
import "./index.css";

let root = null;

void bootstrapRenderer();

async function bootstrapRenderer() {
  try {
    await i18nReady;
  } catch (error) {
    console.error("Failed to initialize renderer i18n:", error);
  }

  mountApp();
}

function mountApp() {
  if (!root) {
    root = ReactDOM.createRoot(document.getElementById("root"));
  }
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <I18nextProvider i18n={i18n}>
          <SettingsProvider>
            <ToastProvider>
              <AppRouter />
            </ToastProvider>
          </SettingsProvider>
        </I18nextProvider>
      </ErrorBoundary>
    </React.StrictMode>
  );
}

function registerRendererErrorLogging() {
  const logRenderer = (level, message, meta = {}) => {
    void window.electronAPI?.log?.({
      level,
      message,
      meta,
      scope: "renderer",
      source: "window",
    });
  };

  // React 19 dev-mode StrictMode + Suspense + lazy + HMR commit-deletion race.
  // Benign — the node was already removed by a concurrent reconciliation pass.
  // Demote to warn to avoid alarming red logs while preserving observability.
  const isReactCommitDeletionRace = (error, message) => {
    const text = error?.message || message || "";
    return (
      (error?.name === "NotFoundError" || text.includes("NotFoundError")) &&
      text.includes("removeChild") &&
      text.includes("not a child")
    );
  };

  const isBenignResizeObserverLoop = (message) => {
    const text = String(message || "");
    return (
      text.includes("ResizeObserver loop limit exceeded") ||
      text.includes("ResizeObserver loop completed with undelivered notifications")
    );
  };

  window.addEventListener("error", (event) => {
    const stack = event.error?.stack || null;
    const isBenignReactRace =
      isReactCommitDeletionRace(event.error, event.message) ||
      (typeof stack === "string" &&
        stack.includes("NotFoundError") &&
        stack.includes("removeChild") &&
        stack.includes("not a child"));
    const isBenignResizeObserver = isBenignResizeObserverLoop(event.message);
    logRenderer(
      isBenignReactRace || isBenignResizeObserver ? "warn" : "error",
      isBenignReactRace
        ? "[window.onerror] React commit-deletion race (suppressed)"
        : isBenignResizeObserver
          ? "[window.onerror] ResizeObserver notification loop (suppressed)"
          : "[window.onerror] Unhandled renderer error",
      {
        message: event.message || "unknown",
        filename: event.filename || null,
        lineno: event.lineno || null,
        colno: event.colno || null,
        stack,
      }
    );
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    logRenderer("error", "[window.unhandledrejection] Unhandled promise rejection", {
      reason:
        typeof reason === "string"
          ? reason
          : reason?.message ||
            (typeof reason?.toString === "function" ? reason.toString() : "unknown"),
      stack: reason?.stack || null,
    });
  });
}

registerRendererErrorLogging();

let sentryInitialized = false;

function scrubString(str) {
  if (typeof str !== "string") return str;
  let result = str;
  const piiPatterns = [/sk-[a-zA-Z0-9]{32,}/g, /AIzaSy[a-zA-Z0-9-_]{33}/g, /gsk_[a-zA-Z0-9]{24,}/g];
  for (const pattern of piiPatterns) {
    result = result.replace(pattern, "[SCRUBBED_KEY]");
  }
  result = result.replace(/\/Users\/[a-zA-Z0-9_.-]+\//g, "/Users/[USER]/");
  result = result.replace(/C:\\Users\\[a-zA-Z0-9_.-]+\\/gi, "C:\\Users\\[USER]\\");
  result = result.replace(
    /(transcription|transcript|speech|audio|paste|clipboard|text)[:\s]+.+/gi,
    "$1: [SCRUBBED]"
  );
  return result;
}

function scrubObject(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => {
      if (typeof item === "string") return scrubString(item);
      if (typeof item === "object") return scrubObject(item);
      return item;
    });
  }
  const scrubbed = {};
  for (const [key, val] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (
      [
        "text",
        "transcript",
        "audio",
        "clipboard",
        "paste",
        "input",
        "body",
        "headers",
        "query",
        "user",
        "email",
        "name",
        "username",
      ].some((k) => lowerKey.includes(k))
    ) {
      scrubbed[key] = "[SCRUBBED]";
    } else if (typeof val === "string") {
      scrubbed[key] = scrubString(val);
    } else if (typeof val === "object") {
      scrubbed[key] = scrubObject(val);
    } else {
      scrubbed[key] = val;
    }
  }
  return scrubbed;
}

function scrubSentryEvent(event) {
  if (!event) return null;
  event.user = null;
  if (event.message) event.message = scrubString(event.message);
  if (event.logentry?.message) event.logentry.message = scrubString(event.logentry.message);
  if (event.exception && event.exception.values) {
    for (const val of event.exception.values) {
      if (val.value) val.value = scrubString(val.value);
      if (val.stacktrace && val.stacktrace.frames) {
        for (const frame of val.stacktrace.frames) {
          if (frame.filename) frame.filename = scrubString(frame.filename);
          if (frame.abs_path) frame.abs_path = scrubString(frame.abs_path);
          if (frame.pre_context) frame.pre_context = frame.pre_context.map(scrubString);
          if (frame.post_context) frame.post_context = frame.post_context.map(scrubString);
          if (frame.context_line) frame.context_line = scrubString(frame.context_line);
        }
      }
    }
  }
  event.breadcrumbs = [];
  if (event.request) event.request = scrubObject(event.request);
  if (event.extra) event.extra = scrubObject(event.extra);
  if (event.contexts) event.contexts = scrubObject(event.contexts);
  if (event.tags) event.tags = scrubObject(event.tags);
  return event;
}

async function initSentryRenderer() {
  if (typeof window === "undefined" || !window.electronAPI?.getSentryDsn) return;
  if (sentryInitialized) return;
  try {
    const dsn = await window.electronAPI.getSentryDsn();
    if (!dsn) return;
    const telemetryEnabled = localStorage.getItem("telemetryEnabled") === "true";
    SentryRenderer.init({
      dsn,
      enabled: telemetryEnabled,
      beforeSend(event) {
        return scrubSentryEvent(event);
      },
    });
    sentryInitialized = true;
  } catch (err) {
    console.error("Failed to initialize Sentry in renderer:", err);
  }
}

initSentryRenderer();

if (import.meta.hot) {
  import.meta.hot.accept();
}
