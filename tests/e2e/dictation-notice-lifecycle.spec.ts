import { _electron as electron, expect, test } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import { applyTestLocalStorage, getDictationPage } from "./helpers/dictationFlow";
import { closeElectronApp } from "./helpers/electron";

test("closing a dictation notice does not restore the idle capsule", async () => {
  const appPath = path.resolve(__dirname, "../..");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chordvox-notice-lifecycle-"));
  const electronApp = await electron.launch({
    args: [path.join(appPath, "main.js"), `--user-data-dir=${userDataDir}`],
    env: { ...process.env, CHORDVOX_E2E: "1" },
  });

  try {
    const firstWindow = await electronApp.firstWindow();
    await firstWindow.waitForLoadState("domcontentloaded");
    await applyTestLocalStorage(firstWindow, { uiLanguage: "zh-CN" });
    await firstWindow.reload({ waitUntil: "domcontentloaded" });

    const dictationPage = await getDictationPage(electronApp);
    await applyTestLocalStorage(dictationPage, { uiLanguage: "zh-CN" });
    await dictationPage.reload({ waitUntil: "domcontentloaded" });

    await electronApp.evaluate(({ BrowserWindow }) => {
      const target = BrowserWindow.getAllWindows().find((window) => {
        const url = window.webContents.getURL();
        return (
          url.includes("index.html") &&
          !url.includes("panel=true") &&
          !url.includes("commandMenu=true") &&
          !url.includes("completionAlert=")
        );
      });
      if (!target) throw new Error("Dictation window not found");
      target.showInactive();
      target.webContents.send("prepare-dictation-ui", { profileId: "primary" });
    });

    const capsule = dictationPage.locator(".dv-capsule");
    await expect(capsule).toBeVisible();

    await electronApp.evaluate(({ BrowserWindow }) => {
      const target = BrowserWindow.getAllWindows().find((window) => {
        const url = window.webContents.getURL();
        return url.includes("index.html") && !url.includes("panel=true");
      });
      if (!target) throw new Error("Dictation window not found");
      target.webContents.send("hotkey-fallback-used", {
        original: "CommandOrControl+Shift+Space",
        fallback: "CommandOrControl+Shift+F12",
      });
    });

    const toastViewport = dictationPage.locator('[data-toast-viewport="true"]');
    await expect(toastViewport).toBeVisible();
    await expect(capsule).toHaveCount(0);

    await toastViewport.getByRole("button", { name: /关闭|Close/i }).click();
    await expect(toastViewport).toHaveCount(0);

    await expect(capsule).toHaveCount(0, { timeout: 600 });
    await expect
      .poll(
        () =>
          electronApp.evaluate(({ BrowserWindow }) => {
            const target = BrowserWindow.getAllWindows().find((window) => {
              const url = window.webContents.getURL();
              return url.includes("index.html") && !url.includes("panel=true");
            });
            return target?.isVisible() ?? false;
          }),
        { timeout: 600 }
      )
      .toBe(false);
  } finally {
    await closeElectronApp(electronApp);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
