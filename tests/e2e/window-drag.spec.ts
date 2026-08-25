import { _electron as electron, expect, test } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import { closeElectronApp } from "./helpers/electron";
import { prepareDictationWindow, sendToDictationWindow } from "./helpers/dictationFlow";

const appPath = path.resolve(__dirname, "../../");

test("a quick pointer release stops the main-process window drag loop", async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chordvox-window-drag-"));
  const electronApp = await electron.launch({
    args: [path.join(appPath, "main.js"), `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      CHORDVOX_E2E: "1",
      CHORDVOX_CHANNEL: "production",
      CHORDVOX_LOG_LEVEL: "debug",
    },
  });

  try {
    const actualUserDataDir = await electronApp.evaluate(({ app }) => app.getPath("userData"));
    expect(fs.realpathSync(actualUserDataDir)).toBe(fs.realpathSync(userDataDir));

    const dictationPage = await prepareDictationWindow(electronApp, {
      recordingAnimationStyle: "nebula",
    });
    await sendToDictationWindow(electronApp, "prepare-dictation-ui");

    const capsuleButton = dictationPage.locator(".dictation-mic--nebula");
    await expect(capsuleButton).toBeVisible();

    const logsDir = path.join(actualUserDataDir, "logs");
    const readLogs = () => {
      if (!fs.existsSync(logsDir)) return "";
      return fs
        .readdirSync(logsDir)
        .filter((name) => name.endsWith(".log"))
        .map((name) => fs.readFileSync(path.join(logsDir, name), "utf8"))
        .join("\n");
    };

    expect(readLogs()).not.toContain("[WindowManager] Drag stopped");

    await capsuleButton.evaluate((element) => {
      const button = element as HTMLButtonElement;
      const pointerId = 41;
      const setPointerCapture = button.setPointerCapture;
      button.setPointerCapture = () => {};

      const dispatch = (type: string, x: number, y: number, buttons: number) => {
        button.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            button: 0,
            buttons,
            clientX: x,
            clientY: y,
            isPrimary: true,
            pointerId,
            pointerType: "mouse",
          })
        );
      };

      dispatch("pointerdown", 20, 20, 1);
      dispatch("pointermove", 32, 20, 1);
      dispatch("pointerup", 32, 20, 0);
      button.setPointerCapture = setPointerCapture;
    });

    await expect
      .poll(() => readLogs(), { timeout: 5_000 })
      .toContain("[WindowManager] Drag stopped");
  } finally {
    await closeElectronApp(electronApp);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
