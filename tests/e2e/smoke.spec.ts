import { _electron as electron, test, expect } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import { closeElectronApp, waitForControlPanelReady } from "./helpers/electron";
import { applyTestLocalStorage } from "./helpers/dictationFlow";

// SMOKE TEST — intentionally NOT a dictation end-to-end test.
//
// It verifies that the Electron app boots, the main window loads, and the
// preload contextBridge exposes the electronAPI surface the renderer depends on.
// It does NOT exercise the real record → transcribe → refine → paste flow: that
// needs real microphone audio and downloaded speech/LLM models, and belongs to a
// later, dedicated E2E stage. Treat a green run here as "the app starts and the
// IPC bridge is wired", not "dictation works".
test("boots the Electron app and exposes the electronAPI bridge", async () => {
  const appPath = path.resolve(__dirname, "../../");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chordvox-smoke-"));

  const electronApp = await electron.launch({
    args: [
      path.join(appPath, "main.js"),
      "--use-fake-device-for-media-stream",
      `--user-data-dir=${userDataDir}`,
    ],
  });

  try {
    // Main window opens and finishes its initial load.
    const window = await electronApp.firstWindow();
    expect(window).toBeTruthy();
    await window.waitForLoadState("domcontentloaded");

    // Each smoke launch uses an isolated user-data directory. Seed both
    // surfaces before asserting the post-onboarding bridge; otherwise the
    // control panel legitimately opens the first-run wizard and the history
    // navigation below is not an actionable target.
    await applyTestLocalStorage(window);
    await window.reload({ waitUntil: "domcontentloaded" });
    await expect
      .poll(() => electronApp.windows().some((candidate) => candidate.url().includes("panel=true")))
      .toBe(true);
    const panelForSetup = electronApp
      .windows()
      .find((candidate) => candidate.url().includes("panel=true"));
    if (panelForSetup) {
      await panelForSetup.waitForLoadState("domcontentloaded");
      await applyTestLocalStorage(panelForSetup);
      await panelForSetup.reload({ waitUntil: "domcontentloaded" });
    }

    const title = await window.title();
    expect(title).toBeDefined();

    // The preload bridge must expose electronAPI with the core dictation
    // entrypoints. Missing methods means a broken/partial preload — the kind of
    // regression this smoke test exists to catch.
    const api = await window.evaluate(() => {
      const a = (window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI;
      if (!a || typeof a !== "object") return null;
      return {
        pasteText: typeof a.pasteText,
        transcribeLocalWhisper: typeof a.transcribeLocalWhisper,
        getPlatform: typeof a.getPlatform,
        licenseGetStatus: typeof a.licenseGetStatus,
        saveTranscription: typeof a.saveTranscription,
      };
    });

    expect(api).not.toBeNull();
    expect(api!.pasteText).toBe("function");
    expect(api!.transcribeLocalWhisper).toBe("function");
    expect(api!.getPlatform).toBe("function");
    expect(api!.licenseGetStatus).toBe("function");
    expect(api!.saveTranscription).toBe("function");

    // The control panel window loads in parallel with the main floating window.
    // Explicitly await it (rather than tearing the app down right after the main
    // window's bridge check) so closeElectronApp never interrupts an in-flight
    // panel load — the teardown race that previously popped a native load-failure
    // dialog — and so this smoke run actually covers the second window rendering.
    const panelText = await waitForControlPanelReady(electronApp);
    expect(panelText.trim()).not.toBe("");

    const panel = electronApp.windows().find((candidate) => candidate.url().includes("panel=true"));
    expect(panel).toBeTruthy();

    // The shipped desktop path renders the account page first. Keep the
    // support destinations visible and correctly wired at the real Electron
    // boundary, not only in a renderer unit test.
    const supportCard = panel!.getByTestId("account-support-card");
    await expect(supportCard).toBeVisible();
    expect(await panel!.getByTestId("account-support-github").getAttribute("href")).toBe(
      "https://github.com/GravityPoet/ChordVox"
    );
    const supportEmailAction = panel!.getByTestId("account-support-email");
    expect(await supportEmailAction.evaluate((element) => element.tagName)).toBe("BUTTON");
    expect(await supportEmailAction.getAttribute("href")).toBeNull();

    await electronApp.evaluate(({ ipcMain }) => {
      const state = globalThis as typeof globalThis & {
        __CHORDVOX_SUPPORT_EMAIL_COPIES?: string[];
        __CHORDVOX_SUPPORT_EXTERNAL_OPENS?: string[];
      };
      state.__CHORDVOX_SUPPORT_EMAIL_COPIES = [];
      state.__CHORDVOX_SUPPORT_EXTERNAL_OPENS = [];
      ipcMain.removeHandler("write-clipboard");
      ipcMain.handle("write-clipboard", (_event, text) => {
        state.__CHORDVOX_SUPPORT_EMAIL_COPIES?.push(String(text));
        return { success: true };
      });
      ipcMain.removeHandler("open-external");
      ipcMain.handle("open-external", (_event, url) => {
        state.__CHORDVOX_SUPPORT_EXTERNAL_OPENS?.push(String(url));
        return { success: true };
      });
    });
    await supportEmailAction.click();
    await expect
      .poll(() =>
        electronApp.evaluate(() => {
          const state = globalThis as typeof globalThis & {
            __CHORDVOX_SUPPORT_EMAIL_COPIES?: string[];
            __CHORDVOX_SUPPORT_EXTERNAL_OPENS?: string[];
          };
          return {
            copies: state.__CHORDVOX_SUPPORT_EMAIL_COPIES || [],
            externalOpens: state.__CHORDVOX_SUPPORT_EXTERNAL_OPENS || [],
          };
        })
      )
      .toEqual({ copies: ["gravitypoet@icloud.com"], externalOpens: [] });

    const historyRoot = panel!.getByTestId("transcription-history-root");
    await expect(historyRoot).toHaveCount(0);

    await panel!.locator('[data-section-id="transcriptionHistory"]').click();
    await expect(historyRoot).toBeVisible();

    await panel!
      .getByRole("button", { name: /返回主页|Back to home/i })
      .last()
      .click();
    await expect(historyRoot).toHaveCount(0);
  } finally {
    await closeElectronApp(electronApp);
  }
});
