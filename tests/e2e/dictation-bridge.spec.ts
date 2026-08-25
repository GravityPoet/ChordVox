import { _electron as electron, test, expect, type ElectronApplication } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import { closeElectronApp, waitForControlPanelReady } from "./helpers/electron";

// CORE DICTATION BRIDGE CONTRACT — an integration test, NOT a real dictation run.
//
// `smoke.spec.ts` only checks 5 representative electronAPI methods. This file
// widens that to the WHOLE preload surface the core dictation loop depends on —
// trigger listeners, transcription engines, the paste/hide close-out, history
// persistence, and the license gate — so a partial/renamed preload (preload.js
// is 650+ lines and easy to break during a refactor) fails CI here instead of
// silently dropping a method the renderer calls at runtime.
//
// Like smoke, it does NOT exercise record → transcribe → refine → paste: that
// needs real microphone audio, downloaded speech/LLM models, and accessibility
// permission, and is covered by the opt-in dictation-flow.real.spec.ts. A
// green run means "every core IPC
// entrypoint the dictation flow calls is present, typed, and the listener
// register/dispose contract holds", not "dictation works".

const appPath = path.resolve(__dirname, "../../");

// Methods the renderer calls directly while driving the core dictation loop.
// Grouped by stage so a failure points at which part of the loop lost its bridge.
const CORE_CALL_METHODS = [
  // record → close-out (paste at cursor, then hide the floating capsule)
  "pasteText",
  "cancelPasteText",
  "hideWindow",
  // transcription engines the AudioManager routes to
  "transcribeLocalWhisper",
  "transcribeLocalParakeet",
  "transcribeLocalParaformer",
  "transcribeExternalAsr",
  // history persistence after a successful paste
  "saveTranscription",
  // license gate (Pro reasoning / trial enforcement)
  "licenseGetStatus",
  "licenseEnsureProAccess",
  "licenseActivate",
  "licenseValidate",
  "licenseClear",
  // usage limit + platform + accessibility guidance used by the error path
  "notifyLimitReached",
  "getPlatform",
  "requestAccessibilityPermission",
  "openAccessibilitySettings",
  "openExternal",
] as const;

// Main-process → renderer event listeners that DRIVE the dictation loop. Each is
// produced by preload's `registerListener`, so calling it must return a dispose
// function — the renderer relies on that disposer to unregister on unmount and
// avoid IPC listener leaks (see useAudioRecording cleanup).
const CORE_EVENT_LISTENERS = [
  "onToggleDictation",
  "onStartDictation",
  "onStopDictation",
  "onPrepareDictationUi",
  "onSecondaryHotkeyLocked",
  "onNoAudioDetected",
] as const;

let electronApp: ElectronApplication;

test.beforeAll(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chordvox-dictation-bridge-"));
  electronApp = await electron.launch({
    args: [
      path.join(appPath, "main.js"),
      "--use-fake-device-for-media-stream",
      `--user-data-dir=${userDataDir}`,
    ],
  });
  const window = await electronApp.firstWindow();
  await window.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await closeElectronApp(electronApp);
});

test("control panel window finishes loading and renders content", async () => {
  // The control panel (panel=true) is the app's second BrowserWindow and loads
  // in parallel with the main window the bridge tests use. Awaiting it to a
  // non-empty render gives real second-window coverage AND ensures afterAll's
  // closeElectronApp never interrupts an in-flight panel load — the teardown
  // race that previously surfaced as a native load-failure dialog.
  const panelText = await waitForControlPanelReady(electronApp);
  expect(panelText.trim()).not.toBe("");
});

test("exposes every core dictation call method as a function", async () => {
  const window = await electronApp.firstWindow();

  const types = await window.evaluate(
    (names) => {
      const api = (window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI;
      if (!api || typeof api !== "object") return null;
      return Object.fromEntries(names.map((name) => [name, typeof api[name]]));
    },
    CORE_CALL_METHODS as unknown as string[]
  );

  expect(types, "electronAPI bridge must be present").not.toBeNull();
  // Assert per-method so a failure names the exact missing/renamed entrypoint.
  for (const name of CORE_CALL_METHODS) {
    expect(types![name], `electronAPI.${name} must be a function`).toBe("function");
  }
});

test("dictation event listeners honor the register → dispose contract", async () => {
  const window = await electronApp.firstWindow();

  const result = await window.evaluate(
    (names) => {
      const api = (window as unknown as { electronAPI?: Record<string, (cb: unknown) => unknown> })
        .electronAPI;
      if (!api || typeof api !== "object") return null;

      return names.map((name) => {
        const register = api[name];
        if (typeof register !== "function") {
          return {
            name,
            registerType: typeof register,
            disposerType: "n/a",
            noopForBadArg: false,
            threw: false,
          };
        }
        try {
          // A real callback registers a listener and must hand back a disposer fn.
          const dispose = register(() => {});
          const disposerType = typeof dispose;
          if (disposerType === "function") (dispose as () => void)();
          // A non-function arg must be tolerated with a noop disposer (preload guard),
          // never throw into the renderer.
          const noopDispose = register(null);
          const noopForBadArg = typeof noopDispose === "function";
          if (noopForBadArg) (noopDispose as () => void)();
          return { name, registerType: "function", disposerType, noopForBadArg, threw: false };
        } catch {
          return {
            name,
            registerType: "function",
            disposerType: "throw",
            noopForBadArg: false,
            threw: true,
          };
        }
      });
    },
    CORE_EVENT_LISTENERS as unknown as string[]
  );

  expect(result, "electronAPI bridge must be present").not.toBeNull();
  for (const entry of result!) {
    expect(entry.registerType, `electronAPI.${entry.name} must be a function`).toBe("function");
    expect(entry.threw, `electronAPI.${entry.name} must not throw on register`).toBe(false);
    expect(entry.disposerType, `electronAPI.${entry.name}(cb) must return a disposer`).toBe(
      "function"
    );
    expect(
      entry.noopForBadArg,
      `electronAPI.${entry.name}(non-fn) must return a noop disposer`
    ).toBe(true);
  }
});
