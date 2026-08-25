import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("macOS Dock badge policy", () => {
  it("clears restored badge state on startup and activation", () => {
    const mainProcess = fs.readFileSync(path.join(repoRoot, "main.js"), "utf8");
    const helperStart = mainProcess.indexOf("function clearMacDockBadge()");
    const helperEnd = mainProcess.indexOf("\n}", helperStart);
    const helper = mainProcess.slice(helperStart, helperEnd);
    const startup = mainProcess.slice(
      mainProcess.indexOf("app\n    .whenReady()"),
      mainProcess.indexOf('app.on("window-all-closed"')
    );
    const activation = mainProcess.slice(
      mainProcess.indexOf('app.on("activate"'),
      mainProcess.indexOf('app.on("before-quit"')
    );

    expect(helperStart).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helperStart);
    expect(helper).toContain('process.platform !== "darwin"');
    expect(helper).toContain("app.setBadgeCount(0)");
    expect(startup).toContain("clearMacDockBadge();");
    expect(activation).toContain("clearMacDockBadge();");
  });
});
