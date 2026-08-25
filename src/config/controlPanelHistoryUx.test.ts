import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("transcription history customer hierarchy", () => {
  it("puts the history controls and records before unrelated status or upsell content", () => {
    const source = fs.readFileSync(path.join(srcRoot, "components/ControlPanel.tsx"), "utf8");
    const historyPanel = source.indexOf(
      '<section className="premium-panel premium-panel--subtle overflow-hidden">'
    );
    const historySearch = source.indexOf(
      'placeholder={t("controlPanel.history.searchPlaceholder")}'
    );
    const historyRows = source.indexOf("renderedHistory.map((item, index)");

    expect(historyPanel).toBeGreaterThan(-1);
    expect(historySearch).toBeGreaterThan(historyPanel);
    expect(historyRows).toBeGreaterThan(historySearch);
    expect(source).not.toContain("<ModelStatusBanner");
    expect(source).not.toContain("premium-stat-card");
    expect(source).not.toContain("controlPanel.aiCta");
  });

  it("keeps file transcription as a compact toolbar action", () => {
    const source = fs.readFileSync(path.join(srcRoot, "components/ControlPanel.tsx"), "utf8");

    expect(source).toContain('className="h-8 gap-1.5 px-2.5 text-[11px]"');
    expect(source).toContain("max-h-[calc(100vh-176px)]");
  });

  it("removes history from rendering behind the translucent settings sheet", () => {
    const source = fs.readFileSync(path.join(srcRoot, "components/ControlPanel.tsx"), "utf8");
    const fileInput = source.indexOf("ref={fileInputRef}");
    const unmountGuard = source.indexOf("{!showSettings && (");
    const historyPanel = source.indexOf(
      '<section className="premium-panel premium-panel--subtle overflow-hidden">'
    );

    expect(fileInput).toBeGreaterThan(-1);
    expect(unmountGuard).toBeGreaterThan(fileInput);
    expect(historyPanel).toBeGreaterThan(unmountGuard);
    expect(source).toContain('data-testid="transcription-history-root"');
    expect(source).not.toContain("hidden={showSettings}");
    expect(source).not.toContain('showSettings ? "invisible"');
  });
});
