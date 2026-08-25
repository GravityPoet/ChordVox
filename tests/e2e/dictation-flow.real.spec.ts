import { _electron as electron, test, expect } from "@playwright/test";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { closeElectronApp } from "./helpers/electron";
import {
  closePasteSinkWindow,
  createPasteSinkWindow,
  findEventIndex,
  focusPasteSinkWindow,
  getE2eEvents,
  getPasteSinkText,
  getRendererE2eEvents,
  prepareDictationWindow,
  processAudioBytesInDictationWindow,
  sendToDictationWindow,
  type E2eEvent,
} from "./helpers/dictationFlow";

const appPath = path.resolve(__dirname, "../../");
const REAL_DICTATION_ENABLED = process.env.CHORDVOX_E2E_REAL_DICTATION === "1";
const DEFAULT_REAL_TIMEOUT_MS = 180_000;
const DEFAULT_FLOW_TIMEOUT_MS = 90_000;
const DEFAULT_MANUAL_RECORDING_HOLD_MS = 8_000;
const DEFAULT_MAC_SAY_TEXT = "hello world this is a ChordVox real dictation walkthrough";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test.skip(
  !REAL_DICTATION_ENABLED,
  "real dictation walkthrough is opt-in: set CHORDVOX_E2E_REAL_DICTATION=1"
);

function parsePositiveInt(rawValue: string | undefined, fallback: number): number {
  const parsed = Number(rawValue);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getLaunchArgs(userDataDir: string): string[] {
  const args = [
    path.join(appPath, "main.js"),
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    `--user-data-dir=${userDataDir}`,
  ];

  const fakeAudioFile = String(process.env.CHORDVOX_E2E_REAL_FAKE_AUDIO_FILE || "").trim();
  if (fakeAudioFile && process.env.CHORDVOX_E2E_REAL_FIXTURE_INJECTION !== "1") {
    args.push("--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${fakeAudioFile}`);
  }

  return args;
}

async function speakTextWithMacOS(text: string): Promise<void> {
  if (!text.trim()) {
    return;
  }
  if (process.platform !== "darwin") {
    throw new Error("CHORDVOX_E2E_REAL_SAY_TEXT is only supported on macOS via `say`");
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn("say", [text], { stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`say exited with code ${code}`));
    });
  });
}

function summarizeEvents(events: E2eEvent[]): E2eEvent[] {
  return events.slice(-8).map((event) => ({
    type: event.type,
    payload: event.payload,
    at: event.at,
  }));
}

test("runs the real local dictation path without transcription/paste/save stubs", async () => {
  const realTimeoutMs = parsePositiveInt(process.env.CHORDVOX_E2E_REAL_TIMEOUT_MS, DEFAULT_REAL_TIMEOUT_MS);
  const manualHoldMs = parsePositiveInt(
    process.env.CHORDVOX_E2E_REAL_MANUAL_HOLD_MS,
    DEFAULT_MANUAL_RECORDING_HOLD_MS
  );
  test.setTimeout(realTimeoutMs);

  const modelPath = String(process.env.CHORDVOX_E2E_REAL_WHISPER_MODEL || "").trim();
  test.skip(Boolean(modelPath) && !fs.existsSync(modelPath), `Whisper model not found: ${modelPath}`);

  const fakeAudioFile = String(process.env.CHORDVOX_E2E_REAL_FAKE_AUDIO_FILE || "").trim();
  const useFixtureInjection = process.env.CHORDVOX_E2E_REAL_FIXTURE_INJECTION === "1";
  test.skip(
    Boolean(fakeAudioFile) && !fs.existsSync(fakeAudioFile),
    `Fake audio file not found: ${fakeAudioFile}`
  );
  test.skip(useFixtureInjection && !fakeAudioFile, "fixture injection requires CHORDVOX_E2E_REAL_FAKE_AUDIO_FILE");

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chordvox-real-dictation-"));
  const electronApp = await electron.launch({
    args: getLaunchArgs(userDataDir),
    env: {
      ...process.env,
      CHORDVOX_E2E: "1",
    },
  });
  let sinkWindowId: number | null = null;

  try {
    const localStorageOverrides: Record<string, string> = {
      useLocalWhisper: "true",
      localTranscriptionProvider: "whisper",
      useReasoningModel: "false",
      allowOpenAIFallback: "false",
      transcriptionHistoryEnabled: "true",
      preferredLanguage: process.env.CHORDVOX_E2E_REAL_LANGUAGE || "en",
    };
    if (modelPath) {
      localStorageOverrides.whisperModel = modelPath;
    } else if (process.env.CHORDVOX_E2E_REAL_WHISPER_MODEL_ID) {
      localStorageOverrides.whisperModel = process.env.CHORDVOX_E2E_REAL_WHISPER_MODEL_ID;
    }

    const dictationPage = await prepareDictationWindow(electronApp, localStorageOverrides);
    sinkWindowId = await createPasteSinkWindow(electronApp);
    await focusPasteSinkWindow(electronApp, sinkWindowId);

    if (useFixtureInjection) {
      const audioBytes = fs.readFileSync(fakeAudioFile);
      await processAudioBytesInDictationWindow(dictationPage, audioBytes, {
        mimeType: process.env.CHORDVOX_E2E_REAL_FIXTURE_MIME_TYPE || "audio/wav",
        sourceFileName: path.basename(fakeAudioFile),
      });
    } else {
      await sendToDictationWindow(electronApp, "start-dictation");
      await dictationPage.waitForTimeout(800);
      await focusPasteSinkWindow(electronApp, sinkWindowId);

      const sayText =
        process.env.CHORDVOX_E2E_REAL_SAY_TEXT ??
        (process.platform === "darwin" && !fakeAudioFile ? DEFAULT_MAC_SAY_TEXT : "");
      if (sayText) {
        await speakTextWithMacOS(sayText);
        await dictationPage.waitForTimeout(800);
      } else {
        await dictationPage.waitForTimeout(manualHoldMs);
      }

      await sendToDictationWindow(electronApp, "stop-dictation");
      await focusPasteSinkWindow(electronApp, sinkWindowId);
    }

    const flowTimeoutMs = parsePositiveInt(
      process.env.CHORDVOX_E2E_REAL_FLOW_TIMEOUT_MS,
      Math.min(DEFAULT_FLOW_TIMEOUT_MS, Math.max(30_000, realTimeoutMs - 20_000))
    );
    const deadline = Date.now() + flowTimeoutMs;
    let observedState = {
      transcribed: false,
      pasted: false,
      saved: false,
      sinkHasText: false,
      sinkText: "",
      mainEvents: [] as E2eEvent[],
      rendererEvents: [] as E2eEvent[],
    };
    while (Date.now() < deadline) {
      const mainEvents = await getE2eEvents(electronApp);
      const rendererEvents = await getRendererE2eEvents(dictationPage);
      const sinkText = await getPasteSinkText(electronApp, sinkWindowId);
      observedState = {
        transcribed: mainEvents.some(
          (event) =>
            event.type === "transcribe-local-whisper" &&
            event.payload?.success === true &&
            event.payload?.hasText === true &&
            event.payload?.stub === undefined
        ),
        pasted: mainEvents.some(
          (event) =>
            event.type === "paste-text" &&
            event.payload?.success === true &&
            event.payload?.stub === undefined
        ),
        saved: mainEvents.some(
          (event) => event.type === "db-save-transcription" && event.payload?.stub === undefined
        ),
        sinkHasText: sinkText.trim().length > 0,
        sinkText,
        mainEvents,
        rendererEvents,
      };
      if (
        observedState.transcribed &&
        observedState.pasted &&
        observedState.saved &&
        observedState.sinkHasText
      ) {
        break;
      }
      await delay(250);
    }

    expect(
      {
        transcribed: observedState.transcribed,
        pasted: observedState.pasted,
        saved: observedState.saved,
        sinkHasText: observedState.sinkHasText,
      },
      JSON.stringify(
        {
          sinkText: observedState.sinkText,
          mainEvents: summarizeEvents(observedState.mainEvents),
          rendererEvents: summarizeEvents(observedState.rendererEvents),
        },
        null,
        2
      )
    ).toEqual({
      transcribed: true,
      pasted: true,
      saved: true,
      sinkHasText: true,
    });

    const events = await getE2eEvents(electronApp);
    const transcribeIndex = findEventIndex(
      events,
      "transcribe-local-whisper",
      (event) => event.payload?.success === true
    );
    const pasteIndex = findEventIndex(
      events,
      "paste-text",
      (event) => event.payload?.success === true
    );
    const saveIndex = findEventIndex(events, "db-save-transcription");
    expect(transcribeIndex, "real transcription must run before paste").toBeGreaterThanOrEqual(0);
    expect(pasteIndex, "real paste must run after transcription").toBeGreaterThan(transcribeIndex);
    expect(saveIndex, "history save must run after real paste succeeds").toBeGreaterThan(pasteIndex);

    const sinkText = await getPasteSinkText(electronApp, sinkWindowId);
    const expectedPattern = String(process.env.CHORDVOX_E2E_REAL_EXPECTED_PATTERN || "").trim();
    if (expectedPattern) {
      expect(sinkText).toMatch(new RegExp(expectedPattern, "i"));
    }
  } finally {
    if (sinkWindowId != null) {
      await closePasteSinkWindow(electronApp, sinkWindowId).catch(() => {});
    }
    await closeElectronApp(electronApp);
  }
});
