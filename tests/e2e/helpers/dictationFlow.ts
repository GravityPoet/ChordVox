import { expect, type ElectronApplication, type Page } from "@playwright/test";

export const STUB_TEXT = "E2E stub dictation pasted and saved.";
export const APP_READY_SETTLE_MS = 1_500;
export const RECORDING_START_SETTLE_MS = 2_000;
export const RECORDING_HOLD_MS = 2_500;

export const TEST_LOCAL_STORAGE = {
  onboardingCompleted: "true",
  authenticationSkipped: "true",
  skipAuth: "true",
  permissionRecheckShown: "true",
  micPermissionGranted: "true",
  accessibilityPermissionGranted: "true",
  audioCuesEnabled: "false",
  dictationCueStyle: "off",
  useLocalWhisper: "true",
  localTranscriptionProvider: "whisper",
  recordingAnimationStyle: "nebula",
  useLocalStreaming: "false",
  cloudTranscriptionMode: "byok",
  useReasoningModel: "false",
  transcriptionHistoryEnabled: "true",
} as const;

export type TestLocalStorageOverrides = Record<string, string>;

export type E2eEvent = {
  type: string;
  at?: number;
  payload?: {
    text?: string;
    stub?: string;
    success?: boolean;
    hasText?: boolean;
    error?: unknown;
    message?: string | null;
    [key: string]: unknown;
  };
};

export type ListenerRegistrationState = {
  onboardingCompleted: string | null;
  startListenerRegistrations: number;
  stopListenerRegistrations: number;
  startListener: string;
  stopListener: string;
};

export async function getE2eEvents(electronApp: ElectronApplication): Promise<E2eEvent[]> {
  return electronApp.evaluate(() => {
    return Array.isArray(globalThis.__CHORDVOX_E2E_EVENTS) ? globalThis.__CHORDVOX_E2E_EVENTS : [];
  });
}

export async function getRendererE2eEvents(page: Page): Promise<E2eEvent[]> {
  return page.evaluate(() => {
    const events = (
      window as unknown as {
        __CHORDVOX_E2E_RENDERER_EVENTS?: E2eEvent[];
      }
    ).__CHORDVOX_E2E_RENDERER_EVENTS;
    return Array.isArray(events) ? events : [];
  });
}

export async function waitForEvents(
  electronApp: ElectronApplication,
  predicate: (events: E2eEvent[]) => boolean,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate(await getE2eEvents(electronApp))) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export function isDictationPage(page: Page): boolean {
  const url = page.url();
  return (
    url.includes("index.html") &&
    !url.includes("panel=true") &&
    !url.includes("commandMenu=true") &&
    !url.includes("completionAlert=")
  );
}

export async function getDictationPage(electronApp: ElectronApplication): Promise<Page> {
  await expect
    .poll(async () => electronApp.windows().some(isDictationPage), { timeout: 10_000 })
    .toBe(true);

  const page = electronApp.windows().find(isDictationPage);
  if (!page) {
    throw new Error("Dictation page not found");
  }
  await page.waitForLoadState("domcontentloaded");
  return page;
}

export async function applyTestLocalStorage(
  page: Page,
  overrides: TestLocalStorageOverrides = {}
): Promise<void> {
  const entries = { ...TEST_LOCAL_STORAGE, ...overrides };
  await page.evaluate((entries) => {
    for (const [key, value] of Object.entries(entries)) {
      localStorage.setItem(key, value);
    }
    sessionStorage.setItem("permissionRecheckShown", "true");
  }, entries);
}

export async function getListenerRegistrationState(page: Page): Promise<ListenerRegistrationState> {
  return page.evaluate(() => {
    const api = (
      window as unknown as {
        electronAPI?: {
          getE2eListenerRegistrations?: () => Record<string, { active?: number; total?: number }>;
          onStartDictation?: unknown;
          onStopDictation?: unknown;
        };
      }
    ).electronAPI;
    const registrations = api?.getE2eListenerRegistrations?.() || {};
    return {
      onboardingCompleted: localStorage.getItem("onboardingCompleted"),
      startListenerRegistrations: registrations["start-dictation"]?.active || 0,
      stopListenerRegistrations: registrations["stop-dictation"]?.active || 0,
      startListener: typeof api?.onStartDictation,
      stopListener: typeof api?.onStopDictation,
    };
  });
}

export async function prepareDictationWindow(
  electronApp: ElectronApplication,
  localStorageOverrides: TestLocalStorageOverrides = {}
): Promise<Page> {
  for (const page of electronApp.windows()) {
    if (page.url().includes("index.html")) {
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await applyTestLocalStorage(page, localStorageOverrides);
    }
  }

  const dictationPage = await getDictationPage(electronApp);
  await applyTestLocalStorage(dictationPage, localStorageOverrides);
  await dictationPage.reload({ waitUntil: "domcontentloaded" });
  await applyTestLocalStorage(dictationPage, localStorageOverrides);

  await expect
    .poll(() => getListenerRegistrationState(dictationPage), { timeout: 10_000 })
    .toEqual({
      onboardingCompleted: "true",
      startListenerRegistrations: 1,
      stopListenerRegistrations: 1,
      startListener: "function",
      stopListener: "function",
    });

  await dictationPage.waitForTimeout(APP_READY_SETTLE_MS);
  return dictationPage;
}

export async function sendToDictationWindow(
  electronApp: ElectronApplication,
  channel: string
): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }, eventChannel) => {
    const target = BrowserWindow.getAllWindows().find(
      (window) =>
        !window.isDestroyed() &&
        window.webContents.getURL().includes("index.html") &&
        !window.webContents.getURL().includes("panel=true") &&
        !window.webContents.getURL().includes("commandMenu=true") &&
        !window.webContents.getURL().includes("completionAlert=")
    );
    if (!target) {
      throw new Error("Dictation window not found");
    }
    target.showInactive();
    target.webContents.send(eventChannel, { profileId: "primary" });
  }, channel);
}

export async function driveDictationCycle(
  electronApp: ElectronApplication,
  dictationPage: Page,
  holdMs = RECORDING_START_SETTLE_MS
): Promise<void> {
  await sendToDictationWindow(electronApp, "start-dictation");
  await dictationPage.waitForTimeout(holdMs);
  await sendToDictationWindow(electronApp, "stop-dictation");
}

/**
 * Drive one or more real record -> stop cycles until the transcription IPC is
 * actually reached (a `transcribe-local-whisper` event appears).
 */
export async function driveCycleUntilTranscribe(
  electronApp: ElectronApplication,
  dictationPage: Page,
  maxAttempts = 5
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await driveDictationCycle(electronApp, dictationPage, RECORDING_HOLD_MS);

    const reached = await waitForEvents(
      electronApp,
      (events) => events.some((event) => event.type === "transcribe-local-whisper"),
      4_000
    );
    if (reached) {
      return true;
    }
    await dictationPage.waitForTimeout(600);
  }
  return false;
}

export function findEventIndex(
  events: E2eEvent[],
  type: string,
  predicate: (event: E2eEvent) => boolean = () => true
): number {
  return events.findIndex((event) => event.type === type && predicate(event));
}

export async function createPasteSinkWindow(electronApp: ElectronApplication): Promise<number> {
  const html = String.raw`<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>ChordVox E2E Paste Sink</title>
        <style>
          html,
          body {
            margin: 0;
            height: 100%;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          }
          textarea {
            box-sizing: border-box;
            width: 100%;
            height: 100%;
            padding: 16px;
            border: 0;
            outline: 0;
            resize: none;
            font: 16px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
          }
        </style>
      </head>
      <body>
        <textarea id="sink" autofocus></textarea>
        <script>
          const sink = document.getElementById("sink");
          sink.focus();
          window.addEventListener("focus", () => sink.focus());
        </script>
      </body>
    </html>`;

  return electronApp.evaluate(async ({ BrowserWindow }, sinkHtml) => {
    const sinkWindow = new BrowserWindow({
      width: 720,
      height: 240,
      show: true,
      title: "ChordVox E2E Paste Sink",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await sinkWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(sinkHtml)}`);
    sinkWindow.show();
    sinkWindow.focus();
    sinkWindow.webContents.focus();
    await sinkWindow.webContents.executeJavaScript(
      'document.getElementById("sink")?.focus(); undefined'
    );
    return sinkWindow.id;
  }, html);
}

export async function focusPasteSinkWindow(
  electronApp: ElectronApplication,
  sinkWindowId: number
): Promise<void> {
  await electronApp.evaluate(async ({ BrowserWindow }, windowId) => {
    const sinkWindow = BrowserWindow.fromId(windowId);
    if (!sinkWindow || sinkWindow.isDestroyed()) {
      throw new Error("Paste sink window not found");
    }
    sinkWindow.show();
    sinkWindow.focus();
    sinkWindow.webContents.focus();
    await sinkWindow.webContents.executeJavaScript(
      'document.getElementById("sink")?.focus(); undefined'
    );
  }, sinkWindowId);
}

export async function getPasteSinkText(
  electronApp: ElectronApplication,
  sinkWindowId: number
): Promise<string> {
  return electronApp.evaluate(async ({ BrowserWindow }, windowId) => {
    const sinkWindow = BrowserWindow.fromId(windowId);
    if (!sinkWindow || sinkWindow.isDestroyed()) {
      return "";
    }
    return sinkWindow.webContents.executeJavaScript(
      'document.getElementById("sink")?.value || ""'
    );
  }, sinkWindowId);
}

export async function closePasteSinkWindow(
  electronApp: ElectronApplication,
  sinkWindowId: number
): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }, windowId) => {
    const sinkWindow = BrowserWindow.fromId(windowId);
    if (sinkWindow && !sinkWindow.isDestroyed()) {
      sinkWindow.close();
    }
  }, sinkWindowId);
}

export async function processAudioBytesInDictationWindow(
  page: Page,
  bytes: Uint8Array,
  options: { mimeType: string; sourceFileName: string }
): Promise<void> {
  await page.evaluate(
    async ({ byteValues, mimeType, sourceFileName }) => {
      const processAudioBytes = (
        window as unknown as {
          __CHORDVOX_E2E_PROCESS_AUDIO_BYTES?: (payload: {
            bytes: number[];
            mimeType: string;
            sourceFileName: string;
          }) => Promise<void>;
        }
      ).__CHORDVOX_E2E_PROCESS_AUDIO_BYTES;
      if (typeof processAudioBytes !== "function") {
        throw new Error("E2E audio fixture processor is not available");
      }
      await processAudioBytes({ bytes: byteValues, mimeType, sourceFileName });
    },
    {
      byteValues: Array.from(bytes),
      mimeType: options.mimeType,
      sourceFileName: options.sourceFileName,
    }
  );
}
