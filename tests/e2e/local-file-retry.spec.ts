import { _electron as electron, test, expect } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import { closeElectronApp } from "./helpers/electron";

const appPath = path.resolve(__dirname, "../../");
const htmlPath = path.join(appPath, "src", "dist", "index.html");
const backupPath = path.join(appPath, "src", "dist", "index.html.e2e-missing");

// DESTRUCTIVE: this test renames the shared src/dist/index.html out of the way to
// force the real missing-file load path. A concurrently running ChordVox (npm
// start/dev) will pop a startup ERR_FAILED dialog during that ~1s window, so it is
// opt-in: run it deliberately with the app closed via
// CHORDVOX_E2E_DESTRUCTIVE=1 playwright test local-file-retry. The default suite skips it.
test("waits for a temporarily unavailable renderer html file", async () => {
  test.skip(
    process.env.CHORDVOX_E2E_DESTRUCTIVE !== "1",
    "destructive (renames src/dist/index.html); run with CHORDVOX_E2E_DESTRUCTIVE=1 and the app closed"
  );
  test.skip(!fs.existsSync(htmlPath), "run npm run build:renderer before Electron E2E tests");
  test.skip(fs.existsSync(backupPath), "previous renderer html backup still exists");

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chordvox-file-retry-"));
  fs.renameSync(htmlPath, backupPath);

  let restored = false;
  const restore = () => {
    if (!restored && fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, htmlPath);
      restored = true;
    }
  };

  // Signal-safe net: a Ctrl-C/SIGINT-killed worker still restores synchronously on
  // exit, so an interrupted run never leaves the renderer build renamed away.
  process.once("exit", restore);

  const restoreTimer = setTimeout(restore, 800);
  let electronApp: Awaited<ReturnType<typeof electron.launch>> | null = null;

  try {
    electronApp = await electron.launch({
      args: [
        path.join(appPath, "main.js"),
        "--use-fake-device-for-media-stream",
        `--user-data-dir=${userDataDir}`,
      ],
    });

    const windows = electronApp.windows();
    const controlPanel = windows.find((page) => page.url().includes("panel=true"));
    const page = controlPanel ?? (await electronApp.firstWindow());

    await expect
      .poll(
        async () => {
          const pages = electronApp?.windows() ?? [];
          for (const candidate of pages) {
            if (!candidate.url().includes("panel=true")) continue;
            const text = await candidate
              .evaluate(() => document.body?.innerText || "")
              .catch(() => "");
            if (text.trim()) return true;
          }
          return await page
            .evaluate(() => Boolean((document.body?.innerText || "").trim()))
            .catch(() => false);
        },
        { timeout: 15_000 }
      )
      .toBe(true);
  } finally {
    clearTimeout(restoreTimer);
    restore();
    await closeElectronApp(electronApp);
  }
});
