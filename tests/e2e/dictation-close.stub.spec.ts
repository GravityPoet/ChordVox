import { _electron as electron, expect, test } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import { closeElectronApp } from "./helpers/electron";
import {
  getE2eEvents,
  prepareDictationWindow,
  sendToDictationWindow,
} from "./helpers/dictationFlow";

const appPath = path.resolve(__dirname, "../../");

test("arms the floating close control before accepting its click", async () => {
  test.setTimeout(60_000);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chordvox-dictation-close-"));
  const electronApp = await electron.launch({
    args: [
      path.join(appPath, "main.js"),
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      `--user-data-dir=${userDataDir}`,
    ],
    env: {
      ...process.env,
      CHORDVOX_E2E: "1",
    },
  });

  try {
    const dictationPage = await prepareDictationWindow(electronApp);
    await sendToDictationWindow(electronApp, "start-dictation");

    const chrome = dictationPage.locator(".dictation-window__chrome");
    const close = dictationPage.locator(".dictation-floating-close");
    await expect(chrome).toBeVisible();
    await chrome.hover();
    await expect(chrome).toHaveAttribute("data-close-ready", "true");
    await expect(close).toBeVisible();
    await expect
      .poll(async () =>
        dictationPage.evaluate(() => {
          const close = document.querySelector<HTMLElement>(".dictation-floating-close");
          if (!close) return "missing";
          const rect = close.getBoundingClientRect();
          const hit = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2
          );
          return hit?.closest(".dictation-floating-close") ? "close" : hit?.className || "other";
        })
      )
      .toBe("close");
    const hideCountBeforeClick = (await getE2eEvents(electronApp)).filter(
      (event) => event.type === "hide-window"
    ).length;
    await close.click();

    await expect
      .poll(
        async () =>
          (await getE2eEvents(electronApp)).filter((event) => event.type === "hide-window").length,
        { timeout: 5_000 }
      )
      .toBeGreaterThan(hideCountBeforeClick);
  } finally {
    await closeElectronApp(electronApp);
  }
});
