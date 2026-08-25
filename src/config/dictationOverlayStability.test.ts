import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(srcRoot, relativePath), "utf8");
}

function getCssBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("dictation overlay position stability", () => {
  it("fills the transparent BrowserWindow so drag bounds match the visible overlay", () => {
    const css = readSource("index.css");
    const rootSizing = getCssBlock(
      css,
      "html:has(body .dictation-window),",
      "html:has(body .completion-alert-window),"
    );

    expect(rootSizing).toContain("height: 100vh");
    expect(rootSizing).toContain("min-height: 100vh");
  });

  it("does not translate or scale the shared capsule entrance animation", () => {
    const css = readSource("styles/pill-v2.css");
    const entrance = getCssBlock(css, "@keyframes dv-capsule-enter", "@keyframes dv-capsule-exit");

    expect(entrance).not.toMatch(/translate[XY]\(|scale\(/);
  });

  it("shows the streaming transcript above the nebula without expanding its drag bounds", () => {
    const css = readSource("index.css");
    const app = readSource("App.jsx");
    const layout = readSource("config/dictationWindowLayout.json");
    const preview = getCssBlock(
      css,
      ".streaming-transcript-preview {",
      '.streaming-transcript-preview[data-visible="true"]'
    );
    const entrance = getCssBlock(
      css,
      "@keyframes streaming-transcript-preview-enter",
      ".dictation-floating-close"
    );

    expect(preview).toContain("width: 258px");
    expect(preview).toContain("height: var(--dictation-nebula-preview-height)");
    expect(preview).toContain("position: absolute");
    expect(preview).toContain("bottom: calc(100% + var(--dictation-nebula-preview-gap))");
    expect(app).toContain("{showNebulaStreamingPreview && (");
    expect(app).toContain("getDictationWindowSize(recordingAnimationStyle)");
    expect(layout).not.toContain('"height": 228');
    expect(JSON.parse(layout).styles.nebula.height).toBe(132 + 10 + 36 + 2);
    expect(entrance).not.toMatch(/translate[XY]\(|scale\(/);
  });

  it("lets the main process perform the only pre-show resize", () => {
    const app = readSource("App.jsx");
    const preparation = getCssBlock(
      app,
      "useLayoutEffect(() => {\n    if (!dictationUiPreparation)",
      "  useEffect(() => {\n    if (hasExpandedOverlay)"
    );

    expect(preparation).not.toContain("resizeMainWindow");
    expect(preparation).toContain("notifyDictationUiReady");
  });

  it("routes a streaming nebula click through the recording stop path", () => {
    const app = readSource("App.jsx");
    const clickHandler = getCssBlock(
      app,
      "const selection = window.getSelection?.();",
      "                onContextMenu={(e) => {"
    );

    expect(clickHandler).toContain("getDictationOverlayPrimaryAction({");
    expect(clickHandler).toContain("isStreaming,");
    expect(clickHandler).toContain('if (action === "cancel-start")');
    expect(clickHandler).toContain("await cancelRecording()");
    expect(clickHandler).toContain('if (action === "stop-recording")');
    expect(clickHandler).toContain("await stopRecording()");
    expect(clickHandler).toContain('else if (action === "cancel-processing")');
    expect(app).toContain("isRecording || isStarting");
  });

  it("hides the overlay before waiting for engine cancellation", () => {
    const app = readSource("App.jsx");
    const dismissHandler = getCssBlock(
      app,
      "  const dismissOverlay = React.useCallback(async () => {",
      "  const getMicState = () => {"
    );

    expect(dismissHandler.indexOf("window.electronAPI?.hideWindow?.()")).toBeGreaterThanOrEqual(0);
    expect(dismissHandler.indexOf("window.electronAPI?.hideWindow?.()")).toBeLessThan(
      dismissHandler.indexOf("cancelRecording()")
    );
    expect(dismissHandler).toContain("Promise.all");
  });

  it("starts idle auto-hide only after the dictation flow is truly idle", () => {
    const app = readSource("App.jsx");
    const idleAutoHide = getCssBlock(
      app,
      "  // Keep the compact capsule visible after activation",
      "  useEffect(() => {\n    const hasSpeechSignal"
    );

    expect(idleAutoHide).toContain("}, IDLE_AUTO_HIDE_DELAY_MS);");
    expect(idleAutoHide).not.toContain("Date.now()");
    expect(app).not.toContain("idleAutoHideGraceUntilRef");
  });

  it("requires a held primary pointer for dragging and closes every release path", () => {
    const app = readSource("App.jsx");
    const dragHandlers = getCssBlock(
      app,
      "                onPointerDown={(e) => {",
      "                onClick={async (e) => {"
    );

    expect(dragHandlers).toContain("e.button !== 0");
    expect(dragHandlers).toContain("setPointerCapture");
    expect(dragHandlers).toContain("(e.buttons & 1) === 0");
    expect(dragHandlers).toContain("hasDraggedRef.current = true");
    expect(dragHandlers).toContain("onPointerUp");
    expect(dragHandlers).toContain("onPointerCancel");
    expect(dragHandlers).toContain("onLostPointerCapture");
    expect(dragHandlers).toContain("stopDragging()");
  });

  it("anchors the nebula close control to the orb instead of the transcript column", () => {
    const css = readSource("index.css");
    const app = readSource("App.jsx");
    const geometry = getCssBlock(
      css,
      ".dictation-window__chrome--nebula {",
      ".dictation-window__chrome--nebula .dictation-floating-close {"
    );
    const closePosition = getCssBlock(
      css,
      ".dictation-window__chrome--nebula .dictation-floating-close {",
      ".dictation-mic--nebula"
    );
    const closeBase = getCssBlock(
      css,
      ".dictation-floating-close {",
      '.dictation-window__chrome[data-close-ready="true"] .dictation-floating-close'
    );
    const closeReveal = getCssBlock(
      css,
      '.dictation-window__chrome[data-close-ready="true"] .dictation-floating-close,',
      ".dictation-floating-close:hover"
    );

    expect(geometry).toContain("--dictation-nebula-size: 132px");
    expect(geometry).toContain("--dictation-close-size: 24px");
    expect(geometry).toContain("--dictation-nebula-preview-height: 36px");
    expect(geometry).toContain("--dictation-nebula-preview-gap: 10px");
    expect(closePosition).toContain("position: absolute");
    expect(closePosition).toContain("top: 27px");
    expect(closePosition).toContain("right: 38px");
    expect(closePosition).not.toContain("top: calc(");
    expect(closePosition).not.toContain("margin-top");
    expect(closeBase).toContain("opacity: 0");
    expect(closeBase).toContain("pointer-events: none");
    expect(app).toContain('data-close-ready={isClosePointerReady ? "true" : undefined}');
    expect(app).toContain("await setWindowInteractivity(true)");
    expect(closeReveal).toContain("opacity: 1");
    expect(closeReveal).toContain("pointer-events: auto");
    expect(closeReveal).toContain(".dictation-floating-close:focus-visible");
    expect(closeReveal).not.toContain("focus-within");

    const nebulaButton = getCssBlock(
      css,
      ".dictation-mic--nebula {",
      ".streaming-transcript-preview {"
    );
    const nebulaCapsule = getCssBlock(
      css,
      ".dictation-mic--nebula .dv-capsule {",
      ".streaming-transcript-preview {"
    );
    expect(nebulaButton).toContain("pointer-events: none");
    expect(nebulaCapsule).toContain("pointer-events: auto");
  });

  it("keeps the focus indicator on the visible capsule instead of its layout box", () => {
    const css = readSource("index.css");
    const outerFocus = getCssBlock(
      css,
      ".dictation-window button:focus-visible {",
      ".dictation-window__chrome > button:focus-visible .dv-capsule"
    );
    const capsuleFocus = getCssBlock(
      css,
      ".dictation-window__chrome > button:focus-visible .dv-capsule {",
      ".dictation-window__chrome > button:focus-visible .dv-capsule::before"
    );

    expect(outerFocus).toContain("outline: none");
    expect(outerFocus).toContain("box-shadow: none");
    expect(capsuleFocus).toContain("outline: 2px solid");
    expect(capsuleFocus).toContain("outline-offset: 3px");
  });

  it("lets macOS users drag the visible overlay into the Dock region", () => {
    const dragManager = readSource("helpers/dragManager.js");

    expect(dragManager).toContain('process.platform === "darwin"');
    expect(dragManager).toContain("clampVisiblePanelPosition");
  });

  it("uses an opaque nebula base and no static dark particle layer", () => {
    const css = readSource("styles/pill-v2.css");
    const nebula = getCssBlock(css, ".dv-capsule--nebula {", ".dv-capsule--nebula::after");
    const component = readSource("components/capsule/NebulaCluster.tsx");

    expect(nebula).toContain("background-color: #b59aee");
    expect(nebula).not.toContain("background-color: transparent");
    expect(component).not.toContain("dv-nebula__deepfield");
  });

  it("uses a glyph-free stellar completion instead of replaying the full entrance flash", () => {
    const css = readSource("styles/pill-v2.css");
    const app = readSource("App.jsx");
    const audioRecording = readSource("hooks/useAudioRecording.js");
    const capsule = readSource("components/capsule/Capsule.tsx");
    const completionPulse = readSource("components/capsule/NebulaCompletionPulse.tsx");
    const successPalette = getCssBlock(
      css,
      '.dv-capsule[data-state="success"][data-style="nebula"] {',
      '.dv-capsule[data-state="error"] {'
    );

    expect(successPalette).toContain("--dv-accent-cool-rgb: 174, 228, 255");
    expect(successPalette).toContain("--dv-accent-mid-rgb: 154, 190, 255");
    expect(successPalette).toContain("--dv-accent-warm-rgb: 210, 164, 255");
    expect(successPalette).toContain("dv-nebula-completion-sequence 820ms");
    expect(successPalette).toContain(".dv-nebula-completion__flare");
    expect(successPalette).toContain(".dv-nebula-completion__wave");
    expect(successPalette).not.toContain("170, 238, 230");
    expect(successPalette).not.toContain("dv-nebula-success__check");
    expect(successPalette).not.toContain("dv-nebula-success__lens");
    expect(successPalette).not.toContain("stroke-dasharray");
    expect(successPalette).not.toContain(".dv-sparkles__trail");
    expect(app).toContain("isPastePending={isPastePending}");
    expect(capsule).toContain('data-pasting={isPastePending ? "true" : undefined}');
    expect(capsule).toContain("<NebulaCompletionPulse />");
    expect(completionPulse).toContain('className="dv-nebula-completion__flare"');
    expect(completionPulse).toContain('className="dv-nebula-completion__wave"');
    expect(completionPulse).not.toContain("<svg");
    expect(completionPulse).not.toContain("check");
    expect(completionPulse).not.toContain("lens");
    expect(app).toContain("const SUCCESS_AUTO_HIDE_FALLBACK_DELAY_MS = 1000");
    expect(audioRecording).toContain("const SUCCESS_FEEDBACK_DURATION_MS = 820");
    expect(
      audioRecording.indexOf("didPaste = await audioManagerRef.current.safePaste")
    ).toBeLessThan(audioRecording.indexOf("triggerSuccessFeedback(willDeferCompletionToast)"));
  });

  it("reduces the stellar completion to a core brightness change", () => {
    const css = readSource("styles/pill-v2.css");
    const reducedMotion = getCssBlock(
      css,
      "@media (prefers-reduced-motion: reduce) {",
      "@media (max-width: 640px) {"
    );

    expect(reducedMotion).toContain(
      "animation: dv-nebula-reduced-core 220ms ease-out both !important"
    );
    expect(reducedMotion).toContain(".dv-nebula-completion {");
    expect(reducedMotion).not.toContain("dv-nebula-success__check");
    expect(reducedMotion).not.toContain("stroke-dashoffset");
    expect(reducedMotion).toContain("display: none");
  });
});
