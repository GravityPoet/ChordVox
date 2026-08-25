import React, { Suspense, useEffect, useState } from "react";
import App from "../App.jsx";
import DictationCommandMenu from "./DictationCommandMenu.tsx";
import ErrorBoundary from "./ErrorBoundary.tsx";
import LoadingFallback from "./LoadingFallback.tsx";
import FileTranscriptionCompletionAlert from "./FileTranscriptionCompletionAlert.tsx";
import { useTheme } from "../hooks/useTheme";
import { useNativeGlassCapability } from "../hooks/useNativeGlassCapability";
import { resolveWindowSurface } from "../utils/windowSurface";
import {
  ONBOARDING_ACTIVATION_STEP_INDEX,
  normalizeOnboardingStep,
} from "../utils/onboardingSteps";

const controlPanelImport = () => import("./ControlPanel.tsx");
const onboardingFlowImport = () => import("./OnboardingFlow.tsx");
const ControlPanel = React.lazy(controlPanelImport);
const OnboardingFlow = React.lazy(onboardingFlowImport);

export default function AppRouter() {
  useTheme();

  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showControlPanelHomeAfterOnboarding, setShowControlPanelHomeAfterOnboarding] =
    useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const windowSurface = resolveWindowSurface(window.location);
  const isControlPanel = windowSurface === "control-panel";
  const isCommandMenu = windowSurface === "command-menu";
  const isCompletionAlert = windowSurface === "completion-alert";
  const isDictationPanel = !isControlPanel && !isCommandMenu && !isCompletionAlert;
  useNativeGlassCapability(isControlPanel);

  // Preload lazy chunks while waiting for auth so Suspense resolves instantly.
  useEffect(() => {
    if (isControlPanel) {
      controlPanelImport().catch(() => {});
      if (!localStorage.getItem("onboardingCompleted")) {
        onboardingFlowImport().catch(() => {});
      }
    }
  }, [isControlPanel]);

  useEffect(() => {
    const onboardingCompleted = localStorage.getItem("onboardingCompleted") === "true";
    const resolved = onboardingCompleted;

    window.electronAPI?.notifyMacNativeHotkeyEligibilityChanged?.(resolved);

    if (isControlPanel) {
      if (!resolved) {
        setShowOnboarding(true);
      }
    }

    if (!isControlPanel && !isCommandMenu && !isCompletionAlert && !resolved) {
      const currentStep = normalizeOnboardingStep(localStorage.getItem("onboardingCurrentStep"));
      if (currentStep < ONBOARDING_ACTIVATION_STEP_INDEX) {
        window.electronAPI?.hideWindow?.();
      }
    }

    setIsLoading(false);
  }, [isCommandMenu, isCompletionAlert, isControlPanel, isDictationPanel]);

  const handleOnboardingComplete = () => {
    setShowOnboarding(false);
    setShowControlPanelHomeAfterOnboarding(true);
    localStorage.setItem("onboardingCompleted", "true");
    window.electronAPI?.notifyMacNativeHotkeyEligibilityChanged?.(true);
  };

  if (isLoading) {
    return <LoadingFallback glass={isControlPanel} />;
  }

  // First-time user: full onboarding wizard.
  if (isControlPanel && showOnboarding) {
    return (
      <ErrorBoundary context="onboarding">
        <Suspense fallback={<LoadingFallback glass />}>
          <OnboardingFlow onComplete={handleOnboardingComplete} />
        </Suspense>
      </ErrorBoundary>
    );
  }

  if (isCommandMenu) {
    return (
      <ErrorBoundary context="commandMenu">
        <DictationCommandMenu />
      </ErrorBoundary>
    );
  }

  if (isCompletionAlert) {
    return (
      <ErrorBoundary context="completionAlert">
        <FileTranscriptionCompletionAlert />
      </ErrorBoundary>
    );
  }

  return isControlPanel ? (
    <ErrorBoundary context="controlPanel">
      <Suspense fallback={<LoadingFallback />}>
        <ControlPanel
          forceShowHome={showControlPanelHomeAfterOnboarding}
          onForceShowHomeHandled={() => setShowControlPanelHomeAfterOnboarding(false)}
        />
      </Suspense>
    </ErrorBoundary>
  ) : (
    <ErrorBoundary context="dictation">
      <App />
    </ErrorBoundary>
  );
}
