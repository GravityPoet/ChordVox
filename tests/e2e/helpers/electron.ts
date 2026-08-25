import { expect, type ElectronApplication } from "@playwright/test";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until the control panel window (the second BrowserWindow, identified by
 * its `panel=true` URL) has loaded and rendered non-empty body text, then return
 * that text.
 *
 * The control panel opens in parallel with the main floating window. A test that
 * only awaits `firstWindow()` can tear the Electron app down while the panel is
 * still loading its renderer; that interrupted in-flight load is what surfaced as
 * a native "failed to load" dialog during teardown. Awaiting the panel here
 * closes that race AND gives real second-window coverage — a green assertion
 * means the panel renderer actually mounted, not just that the main window did.
 */
export async function waitForControlPanelReady(
  electronApp: ElectronApplication,
  timeoutMs = 15_000
): Promise<string> {
  let panelText = "";
  await expect
    .poll(
      async () => {
        for (const candidate of electronApp.windows()) {
          if (!candidate.url().includes("panel=true")) {
            continue;
          }
          const text = await candidate
            .evaluate(() => document.body?.innerText || "")
            .catch(() => "");
          if (text.trim()) {
            panelText = text;
            return true;
          }
        }
        return false;
      },
      { timeout: timeoutMs }
    )
    .toBe(true);
  return panelText;
}

export async function closeElectronApp(
  electronApp: ElectronApplication | null | undefined,
  timeoutMs = 1_500
): Promise<void> {
  if (!electronApp) {
    return;
  }

  const closePromise = electronApp.close().then(
    () => true,
    () => true
  );

  if ((await Promise.race([closePromise, delay(timeoutMs).then(() => false)])) === true) {
    return;
  }

  await electronApp
    .evaluate(({ app }) => {
      app.exit(0);
    })
    .catch(() => {});

  if ((await Promise.race([closePromise, delay(timeoutMs).then(() => false)])) === true) {
    return;
  }

  electronApp.process().kill("SIGKILL");
  await Promise.race([closePromise, delay(timeoutMs).then(() => false)]);
}
