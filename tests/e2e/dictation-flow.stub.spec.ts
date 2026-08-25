import { _electron as electron, test, expect } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import { closeElectronApp } from "./helpers/electron";
import {
  STUB_TEXT,
  driveCycleUntilTranscribe,
  findEventIndex,
  getE2eEvents,
  getListenerRegistrationState,
  prepareDictationWindow,
  sendToDictationWindow,
} from "./helpers/dictationFlow";

const appPath = path.resolve(__dirname, "../../");

test("runs the core dictation flow with stubbed transcription, paste, and history save", async () => {
  test.setTimeout(90_000);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chordvox-dictation-flow-"));
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
      CHORDVOX_E2E_STUB_TRANSCRIPTION: "1",
      CHORDVOX_E2E_STUB_PASTE: "1",
      CHORDVOX_E2E_STUB_SAVE_TRANSCRIPTION: "1",
      CHORDVOX_E2E_TRANSCRIPTION_TEXT: STUB_TEXT,
    },
  });

  try {
    const dictationPage = await prepareDictationWindow(electronApp);
    const beforeRegistrations = await getListenerRegistrationState(dictationPage);

    const success = await driveCycleUntilTranscribe(electronApp, dictationPage);
    expect(success, "should complete transcription cycle successfully").toBe(true);

    const completionPulse = dictationPage.locator(".dv-nebula-completion");
    await expect(completionPulse).toBeVisible();
    await expect(completionPulse.locator(".dv-nebula-completion__flare")).toHaveCount(1);
    await expect(completionPulse.locator("svg")).toHaveCount(0);

    await expect
      .poll(
        async () => {
          const events = await getE2eEvents(electronApp);
          return {
            transcribed: events.some((event) => event.type === "transcribe-local-whisper"),
            pasted: events.some(
              (event) => event.type === "paste-text" && event.payload?.text === STUB_TEXT
            ),
            saved: events.some(
              (event) => event.type === "db-save-transcription" && event.payload?.text === STUB_TEXT
            ),
            hidden: events.some((event) => event.type === "hide-window"),
          };
        },
        { timeout: 15_000 }
      )
      .toEqual({
        transcribed: true,
        pasted: true,
        saved: true,
        hidden: true,
      });

    const events = await getE2eEvents(electronApp);
    const transcribeIndex = findEventIndex(events, "transcribe-local-whisper");
    const pasteIndex = findEventIndex(
      events,
      "paste-text",
      (event) => event.payload?.text === STUB_TEXT
    );
    const saveIndex = findEventIndex(
      events,
      "db-save-transcription",
      (event) => event.payload?.text === STUB_TEXT
    );
    expect(transcribeIndex, "transcription must run before paste").toBeGreaterThanOrEqual(0);
    expect(pasteIndex, "paste must run after transcription").toBeGreaterThan(transcribeIndex);
    expect(saveIndex, "history save must run after paste succeeds").toBeGreaterThan(pasteIndex);
    const pasteAt = events[pasteIndex]?.at || 0;
    await expect
      .poll(
        async () => {
          const latestEvents = await getE2eEvents(electronApp);
          const hideEvent = latestEvents
            .slice(pasteIndex + 1)
            .find((event) => event.type === "hide-window");
          return hideEvent ? (hideEvent.at || 0) - pasteAt : -1;
        },
        { timeout: 5_000 }
      )
      .toBeGreaterThanOrEqual(700);

    await expect
      .poll(() => getListenerRegistrationState(dictationPage), { timeout: 5_000 })
      .toEqual(beforeRegistrations);
  } finally {
    await closeElectronApp(electronApp);
  }
});

test("reduces nebula motion to the intentional core brightness cue", async () => {
  test.setTimeout(30_000);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chordvox-reduced-motion-"));
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
    await dictationPage.emulateMedia({ reducedMotion: "reduce" });
    await sendToDictationWindow(electronApp, "start-dictation");

    const capsule = dictationPage.locator('.dv-capsule[data-style="nebula"]');
    await expect(capsule).toBeVisible();

    const recordingMotion = await dictationPage.evaluate(() => {
      const spin = document.querySelector<HTMLElement>(".dv-nebula__orbit-spin");
      if (!spin) throw new Error("Nebula orbit was not rendered");
      const style = getComputedStyle(spin);
      return {
        durationSeconds: Number.parseFloat(style.animationDuration),
        iterationCount: style.animationIterationCount,
      };
    });
    expect(recordingMotion.durationSeconds).toBeLessThanOrEqual(0.001);
    expect(recordingMotion.iterationCount).toBe("1");

    const completionMotion = await dictationPage.evaluate(() => {
      const capsuleElement = document.querySelector<HTMLElement>(
        '.dv-capsule[data-style="nebula"]'
      );
      const core = document.querySelector<HTMLElement>(".dv-nebula__core");
      if (!capsuleElement || !core) throw new Error("Nebula core was not rendered");
      capsuleElement.dataset.state = "success";
      const style = getComputedStyle(core);
      return {
        animationName: style.animationName,
        durationSeconds: Number.parseFloat(style.animationDuration),
      };
    });
    expect(completionMotion).toEqual({
      animationName: "dv-nebula-reduced-core",
      durationSeconds: 0.22,
    });
  } finally {
    await closeElectronApp(electronApp);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
