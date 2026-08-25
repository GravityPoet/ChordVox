import { _electron as electron, test, expect } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import { closeElectronApp } from "./helpers/electron";
import {
  STUB_TEXT,
  driveCycleUntilTranscribe,
  getE2eEvents,
  prepareDictationWindow,
} from "./helpers/dictationFlow";

// DICTATION ERROR-PATH E2E (stubbed) — the failure counterpart to
// dictation-flow.stub.spec.ts. It drives the same real record -> stop pipeline,
// but forces the main-process transcription/paste IPC to FAIL (via the
// E2E_MODE-gated CHORDVOX_E2E_STUB_*_FAIL switches) and asserts the renderer
// reacts correctly:
//   - a failed transcription is NEVER pasted, and an actionable error remains visible;
//   - a failed paste rescue-saves the transcript to history (excluded from
//     usage stats), and its clipboard recovery is explained.
//
// Like the happy-path stub test, this exercises the renderer's error handling
// end to end, not "dictation works". The stubs live behind E2E_MODE
// (CHORDVOX_E2E === "1" && !app.isPackaged), so they can never fire in a
// shipped build.

const appPath = path.resolve(__dirname, "../../");

test("a stubbed transcription FAILURE is surfaced as an error and never pasted", async () => {
  test.setTimeout(90_000);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chordvox-dictation-err-tx-"));
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
      CHORDVOX_E2E_STUB_TRANSCRIPTION_FAIL: "1",
    },
  });

  try {
    const dictationPage = await prepareDictationWindow(electronApp, { uiLanguage: "en" });
    const hideCountBeforeCycle = (await getE2eEvents(electronApp)).filter(
      (event) => event.type === "hide-window"
    ).length;

    const reachedTranscribe = await driveCycleUntilTranscribe(electronApp, dictationPage);
    expect(
      reachedTranscribe,
      "recording never reached the transcription step (fake-audio capture flake)"
    ).toBe(true);

    // The transcription failure must propagate to the renderer's error handling:
    // the fail stub ran, NOTHING was pasted (a failed transcription is never
    // pasted), and the floating window stays visible for recovery guidance.
    await expect
      .poll(
        async () => {
          const events = await getE2eEvents(electronApp);
          return {
            transcribeFailStub: events.some(
              (event) => event.type === "transcribe-local-whisper" && event.payload?.stub === "fail"
            ),
            pasted: events.some((event) => event.type === "paste-text"),
            hidden:
              events.filter((event) => event.type === "hide-window").length > hideCountBeforeCycle,
          };
        },
        { timeout: 12_000 }
      )
      .toEqual({
        transcribeFailStub: true,
        pasted: false,
        hidden: false,
      });
    const toast = dictationPage.locator('[data-toast-viewport="true"]');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("Transcription failed");
    await expect(toast).toContainText("No text was pasted or added to history");
  } finally {
    await closeElectronApp(electronApp);
  }
});

// NOTE on the empty/silent-result path (#3's third error path): it is already
// covered at the renderer level by the "discards an empty/silent transcription
// instead of pasting whitespace" unit test in useAudioRecording.test.tsx, and
// it needs no new production stub. An E2E version cannot reuse the existing
// success stub with CHORDVOX_E2E_TRANSCRIPTION_TEXT="" because that env var is
// coalesced with `|| <default>` (an empty string is falsy, so it falls back to
// the non-empty default). Adding a dedicated empty-result E2E would therefore
// require a new stub switch, which is out of this change's minimal scope and
// redundant with the existing unit coverage.

test("a stubbed paste FAILURE is surfaced as an error and rescue-saved to history", async () => {
  test.setTimeout(90_000);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chordvox-dictation-err-paste-"));
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
      // Transcription succeeds so the flow reaches the paste step, then paste fails.
      CHORDVOX_E2E_STUB_TRANSCRIPTION: "1",
      CHORDVOX_E2E_TRANSCRIPTION_TEXT: STUB_TEXT,
      CHORDVOX_E2E_STUB_PASTE_FAIL: "1",
      CHORDVOX_E2E_STUB_SAVE_TRANSCRIPTION: "1",
    },
  });

  try {
    const dictationPage = await prepareDictationWindow(electronApp, { uiLanguage: "en" });
    const hideCountBeforeCycle = (await getE2eEvents(electronApp)).filter(
      (event) => event.type === "hide-window"
    ).length;

    const reachedTranscribe = await driveCycleUntilTranscribe(electronApp, dictationPage);
    expect(
      reachedTranscribe,
      "recording never reached the transcription step (fake-audio capture flake)"
    ).toBe(true);

    // Transcription succeeded and the paste fail stub ran. The transcript is
    // rescue-saved to history (excluded from usage stats) so the dictation
    // survives the clipboard being overwritten; recovery guidance stays visible.
    await expect
      .poll(
        async () => {
          const events = await getE2eEvents(electronApp);
          return {
            transcribed: events.some(
              (event) => event.type === "transcribe-local-whisper" && event.payload?.stub !== "fail"
            ),
            pasteFailStub: events.some(
              (event) => event.type === "paste-text" && event.payload?.stub === "fail"
            ),
            rescueSaved: events.some(
              (event) =>
                event.type === "db-save-transcription" &&
                event.payload?.metadata?.excludeFromStats === true
            ),
            hidden:
              events.filter((event) => event.type === "hide-window").length > hideCountBeforeCycle,
          };
        },
        { timeout: 12_000 }
      )
      .toEqual({
        transcribed: true,
        pasteFailStub: true,
        rescueSaved: true,
        hidden: false,
      });
    const toast = dictationPage.locator('[data-toast-viewport="true"]');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("Accessibility Permissions Needed");
    await expect(toast).toContainText("text is in your clipboard");
    await expect(toast).toContainText("saved to local history");
    await expect(dictationPage.locator(".dv-nebula-completion")).toHaveCount(0);
  } finally {
    await closeElectronApp(electronApp);
  }
});
