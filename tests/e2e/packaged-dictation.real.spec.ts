import { extractFile } from "@electron/asar";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import {
  _electron as electron,
  chromium,
  expect,
  test,
  type Browser,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { closeElectronApp } from "./helpers/electron";
import { isDictationPage, TEST_LOCAL_STORAGE } from "./helpers/dictationFlow";

const ENABLED = process.env.CHORDVOX_PACKAGED_DICTATION === "1";
const repoRoot = path.resolve(__dirname, "../..");
const pasteTargetMain = path.join(repoRoot, "tests", "e2e", "fixtures", "paste-target.cjs");
const LOOPBACK_HOST = "localhost";
const MAC_FOCUS_RETRY_INTERVAL_MS = 500;
const MAC_FOCUS_TIMEOUT_MS = 15_000;

const MAC_NATIVE_ACTIVATE_SCRIPT = `
on run argv
  set targetPid to (item 1 of argv) as integer
  tell application "System Events"
    set targetProcess to first application process whose unix id is targetPid
    set frontmost of targetProcess to true
  end tell
end run`;

test.skip(!ENABLED, "packaged dictation acceptance is opt-in");

type RuntimeInfo = {
  appPath: string;
  arch: string;
  executablePath: string;
  isPackaged: boolean;
  pid: number;
  platform: NodeJS.Platform;
  userDataPath: string;
  version: string;
};

type PasteTargetEvent = {
  inputType: string | null;
  isTrusted: boolean;
  key: string | null;
  type: string;
};

type PackagedAppHandle = {
  appAsarPath: string;
  browser: Browser;
  devToolsActivePortPath: string;
  page: Page;
  process: ChildProcess;
};

function requiredEnv(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function launchSwitches(userDataDir: string, audioFile: string): string[] {
  const switches = [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${audioFile}`,
    "--autoplay-policy=no-user-gesture-required",
    `--user-data-dir=${userDataDir}`,
  ];
  if (
    process.env.CHORDVOX_PACKAGED_DISABLE_SANDBOX === "1" ||
    (process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0)
  ) {
    switches.push("--no-sandbox");
  }
  if (process.env.CHORDVOX_PACKAGED_DISABLE_GPU === "1") {
    switches.push("--disable-gpu");
  }
  return switches;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveAppAsarPath(executablePath: string): string {
  const executableDir = path.dirname(executablePath);
  const candidates = [
    path.resolve(executableDir, "resources", "app.asar"),
    path.resolve(executableDir, "..", "Resources", "app.asar"),
  ];
  const appAsarPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!appAsarPath) {
    throw new Error(`Packaged app.asar not found for ${executablePath}`);
  }
  return appAsarPath;
}

function readPackagedVersion(appAsarPath: string): string {
  const metadata = JSON.parse(extractFile(appAsarPath, "package.json").toString("utf8")) as {
    version?: unknown;
  };
  const version = String(metadata.version || "").trim();
  if (!version) throw new Error(`Packaged version missing from ${appAsarPath}`);
  return version;
}

function readPackagedSourceSha(appAsarPath: string): string {
  const metadata = JSON.parse(extractFile(appAsarPath, "package.json").toString("utf8")) as {
    releaseSourceSha?: unknown;
  };
  const sourceSha = String(metadata.releaseSourceSha || "").trim();
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error(`Packaged releaseSourceSha is missing or invalid in ${appAsarPath}`);
  }
  return sourceSha;
}

function platformFromNavigator(value: string): NodeJS.Platform {
  if (/^win/i.test(value)) return "win32";
  if (/^mac/i.test(value)) return "darwin";
  if (/linux/i.test(value)) return "linux";
  throw new Error(`Unsupported packaged navigator.platform: ${value}`);
}

async function waitForDevToolsEndpoint(
  child: ChildProcess,
  userDataDir: string
): Promise<{ activePortPath: string; endpoint: string }> {
  const activePortPath = path.join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Packaged app exited before CDP became ready (code ${child.exitCode})`);
    }
    if (fs.existsSync(activePortPath)) {
      const port = String(
        fs.readFileSync(activePortPath, "utf8").split(/\r?\n/, 1)[0] || ""
      ).trim();
      if (/^\d+$/.test(port)) {
        return { activePortPath, endpoint: `http://${LOOPBACK_HOST}:${port}` };
      }
    }
    await delay(100);
  }
  throw new Error(`Packaged app did not expose loopback CDP in ${userDataDir}`);
}

async function launchPackagedApp(
  executablePath: string,
  userDataDir: string,
  audioFile: string
): Promise<PackagedAppHandle> {
  const child = spawn(
    executablePath,
    [
      `--remote-debugging-address=${LOOPBACK_HOST}`,
      "--remote-debugging-port=0",
      ...launchSwitches(userDataDir, audioFile),
    ],
    {
      cwd: path.dirname(executablePath),
      env: { ...process.env, CHORDVOX_E2E: "0" },
      stdio: "ignore",
      windowsHide: false,
    }
  );
  const { activePortPath, endpoint } = await waitForDevToolsEndpoint(child, userDataDir);
  const browser = await chromium.connectOverCDP(endpoint);
  const page = await getPackagedDictationPage(browser);
  return {
    appAsarPath: resolveAppAsarPath(executablePath),
    browser,
    devToolsActivePortPath: activePortPath,
    page,
    process: child,
  };
}

async function getPackagedDictationPage(browser: Browser): Promise<Page> {
  await expect
    .poll(
      async () => {
        const candidate = browser
          .contexts()
          .flatMap((context) => context.pages())
          .filter((page) => !page.isClosed())
          .find(isDictationPage);
        if (!candidate) return false;
        try {
          return await candidate.evaluate(() => document.readyState === "complete");
        } catch {
          return false;
        }
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .filter((candidate) => !candidate.isClosed())
    .find(isDictationPage);
  if (!page) throw new Error("Packaged dictation window not found through CDP");
  await page.waitForLoadState("domcontentloaded");
  return page;
}

async function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    delay(timeoutMs).then(() => false),
  ]);
}

async function closePackagedApp(handle: PackagedAppHandle | null): Promise<void> {
  if (!handle) return;
  try {
    await Promise.race([handle.browser.close(), delay(5_000)]);
  } catch {
    // The exact spawned process is terminated below if CDP shutdown failed.
  }
  if (await waitForProcessExit(handle.process, 2_000)) return;
  const pid = handle.process.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    await waitForProcessExit(handle.process, 5_000);
    return;
  }
  handle.process.kill("SIGTERM");
  if (await waitForProcessExit(handle.process, 2_000)) return;
  handle.process.kill("SIGKILL");
  await waitForProcessExit(handle.process, 2_000);
}

async function applyProductionSettings(page: Page, modelPath: string): Promise<void> {
  const settings: Record<string, string> = {
    ...TEST_LOCAL_STORAGE,
    allowOpenAIFallback: "false",
    cloudTranscriptionMode: "byok",
    localTranscriptionProvider: "whisper",
    pasteConfirmEnabled: "false",
    preferredLanguage: "en",
    uiLanguage: "en",
    useLocalStreaming: "false",
    useLocalWhisper: "true",
    useReasoningModel: "false",
    whisperModel: modelPath,
  };
  await page.evaluate((entries) => {
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
    sessionStorage.setItem("permissionRecheckShown", "true");
  }, settings);
}

async function installFixedWavMediaDevice(page: Page, audioFile: string): Promise<void> {
  const wavBase64 = fs.readFileSync(audioFile).toString("base64");
  const install = ({ fixtureBase64 }: { fixtureBase64: string }) => {
    const state = window as unknown as {
      __CHORDVOX_EXTERNAL_FIXED_WAV_CALLS?: number;
      __CHORDVOX_EXTERNAL_FIXED_WAV_CONTEXTS?: AudioContext[];
      __CHORDVOX_EXTERNAL_FIXED_WAV_DEVICE?: boolean;
    };
    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    state.__CHORDVOX_EXTERNAL_FIXED_WAV_CONTEXTS = [];
    state.__CHORDVOX_EXTERNAL_FIXED_WAV_DEVICE = true;
    state.__CHORDVOX_EXTERNAL_FIXED_WAV_CALLS = 0;

    navigator.mediaDevices.getUserMedia = async (
      constraints?: MediaStreamConstraints
    ): Promise<MediaStream> => {
      if (!constraints?.audio) return originalGetUserMedia(constraints);
      state.__CHORDVOX_EXTERNAL_FIXED_WAV_CALLS =
        (state.__CHORDVOX_EXTERNAL_FIXED_WAV_CALLS || 0) + 1;

      const binary = atob(fixtureBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }

      const context = new AudioContext();
      await context.resume();
      const audioBuffer = await context.decodeAudioData(bytes.buffer.slice(0));
      const destination = context.createMediaStreamDestination();
      const source = context.createBufferSource();
      source.buffer = audioBuffer;
      source.loop = true;
      source.connect(destination);
      source.start();
      state.__CHORDVOX_EXTERNAL_FIXED_WAV_CONTEXTS?.push(context);

      for (const track of destination.stream.getAudioTracks()) {
        const originalStop = track.stop.bind(track);
        track.stop = () => {
          try {
            source.stop();
          } catch {
            // The application may stop a completed track more than once.
          }
          void context.close();
          originalStop();
        };
      }
      return destination.stream;
    };
  };
  const fixture = { fixtureBase64: wavBase64 };
  await page.context().addInitScript(install, fixture);
  await page.evaluate(install, fixture);
}

type PasteTargetFocusState = {
  windowFocused: boolean;
  webContentsFocused: boolean;
  domFocused: boolean;
  nativeActivationError: string | null;
};

function activateMacProcess(processId: number): string | null {
  if (process.platform !== "darwin") return null;

  const result = spawnSync(
    "/usr/bin/osascript",
    ["-e", MAC_NATIVE_ACTIVATE_SCRIPT, "--", String(processId)],
    {
      encoding: "utf8",
      timeout: 2_000,
    }
  );
  if (result.error) return result.error.message;
  if (result.status !== 0) {
    return String(
      result.stderr || result.stdout || `osascript exited with ${result.status}`
    ).trim();
  }
  return null;
}

async function readPasteTargetFocusState(
  app: ElectronApplication,
  page: Page,
  nativeActivationError: string | null
): Promise<PasteTargetFocusState> {
  const windowState = await app
    .evaluate(({ BrowserWindow }) => {
      const target = BrowserWindow.getAllWindows()[0];
      return {
        windowFocused: Boolean(target?.isFocused()),
        webContentsFocused: Boolean(target?.webContents?.isFocused()),
      };
    })
    .catch(() => ({ windowFocused: false, webContentsFocused: false }));
  const domFocused = await page
    .locator("#paste-target")
    .evaluate((element) => document.hasFocus() && document.activeElement === element)
    .catch(() => false);
  return { ...windowState, domFocused, nativeActivationError };
}

async function focusPasteTarget(
  app: ElectronApplication,
  page: Page,
  options: { required?: boolean; timeoutMs?: number; label?: string } = {}
): Promise<PasteTargetFocusState> {
  const required = options.required !== false;
  const timeoutMs = options.timeoutMs || MAC_FOCUS_TIMEOUT_MS;
  const label = options.label || "paste target";
  const targetPid = await app.evaluate(() => process.pid);
  let nativeActivationError: string | null = null;
  let lastNativeActivationAt = 0;
  let state: PasteTargetFocusState = {
    windowFocused: false,
    webContentsFocused: false,
    domFocused: false,
    nativeActivationError: null,
  };

  await app.evaluate(({ BrowserWindow, app: electronApp }) => {
    const target = BrowserWindow.getAllWindows()[0];
    if (!target) throw new Error("Independent paste target window not found");
    electronApp.focus?.({ steal: true });
    target.show();
    target.focus();
    target.moveTop();
    target.webContents.focus();
  });
  await page.bringToFront();
  await page.locator("#paste-target").focus();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = Date.now();
    if (
      process.platform === "darwin" &&
      now - lastNativeActivationAt >= MAC_FOCUS_RETRY_INTERVAL_MS
    ) {
      nativeActivationError = activateMacProcess(targetPid);
      lastNativeActivationAt = now;
    }

    await app
      .evaluate(({ BrowserWindow, app: electronApp }) => {
        const target = BrowserWindow.getAllWindows()[0];
        electronApp.focus?.({ steal: true });
        target?.show();
        target?.focus();
        target?.moveTop();
        target?.webContents?.focus();
      })
      .catch(() => {});
    await page
      .locator("#paste-target")
      .focus()
      .catch(() => {});
    state = await readPasteTargetFocusState(app, page, nativeActivationError);
    if (state.windowFocused && state.webContentsFocused && state.domFocused) return state;
    await delay(100);
  }

  state = await readPasteTargetFocusState(app, page, nativeActivationError);
  if (required && (!state.windowFocused || !state.webContentsFocused || !state.domFocused)) {
    throw new Error(`Unable to focus ${label}: ${JSON.stringify(state)}`);
  }
  return state;
}

async function revealInteractiveMic(page: Page, micButton: ReturnType<Page["locator"]>) {
  // The production capsule intentionally auto-hides an idle overlay after a
  // short delay. A slow packaged runner can observe the DOM node while it is
  // already non-interactive, so re-arm through the same production IPC until
  // the button has real layout and pointer interactivity.
  await expect
    .poll(
      async () => {
        let interactive = false;
        try {
          interactive = await micButton.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return (
              !element.classList.contains("pointer-events-none") &&
              !element.classList.contains("opacity-0") &&
              bounds.width > 0 &&
              bounds.height > 0
            );
          });
        } catch {
          interactive = false;
        }

        if (!interactive) {
          await page.evaluate(() => window.electronAPI?.showDictationPanel?.());
        }
        return interactive;
      },
      { timeout: 20_000, intervals: [50, 100, 200, 400] }
    )
    .toBe(true);
}

async function armNativeMicPointer(page: Page, micButton: ReturnType<Page["locator"]>) {
  // The production window is click-through until the pointer enters the
  // capsule. Reused X11 displays can leave the pointer inside the button from
  // a prior run, which produces no new mouseenter. Move outside first, then use
  // the same hover path as a user and wait for the native acknowledgement.
  const chrome = page.locator(".dictation-window__chrome").first();
  const capsule = chrome.locator(".dv-capsule").first();
  await page.mouse.move(0, 0);
  await page.evaluate(async () => {
    await window.electronAPI?.showDictationPanel?.();
    // On macOS an installed, click-through panel can be visible before its
    // native window has become the active hit-test surface. A focus request
    // here is only the short arming phase; the paste target is explicitly
    // focused again before the stop/paste assertion below.
    await window.electronAPI?.setMainWindowInteractivity?.(true, { focus: true });
  });
  await revealInteractiveMic(page, micButton);
  await chrome.hover({ force: true });
  await capsule.hover({ force: true });
  await micButton.hover({ force: true });
  await expect
    .poll(
      async () => {
        const ready = await chrome.getAttribute("data-close-ready");
        if (ready === "true") return ready;

        // React can re-render the capsule after the native window call. Keep
        // the pointer on the rendered hit target and re-arm the native window
        // instead of assuming a second mouseenter will happen by itself.
        await page.evaluate(async () => {
          await window.electronAPI?.showDictationPanel?.();
          await window.electronAPI?.setMainWindowInteractivity?.(true, { focus: true });
        });
        await chrome.hover({ force: true }).catch(() => {});
        await capsule.hover({ force: true }).catch(() => {});
        await micButton.hover({ force: true }).catch(() => {});
        return await chrome.getAttribute("data-close-ready");
      },
      {
        timeout: 15_000,
        intervals: [100, 200, 400, 800],
      }
    )
    .toBe("true");
}

async function hideDictationPanelForMacFocus(page: Page): Promise<void> {
  if (process.platform !== "darwin") return;
  // The production panel is always-on-top while it is interactive. Hide it
  // before asking macOS to activate the independent paste target; otherwise
  // System Events can report success while Electron's target window remains
  // visually behind the panel (a false focus failure).
  await page.evaluate(async () => {
    await window.electronAPI?.setMainWindowInteractivity?.(false, { focus: false });
    await window.electronAPI?.hideWindow?.();
  });
  await delay(150);
}

test("fixed WAV traverses an installed production app and trusted-click paste path", async () => {
  test.setTimeout(240_000);

  const executablePath = requiredEnv("CHORDVOX_PACKAGED_APP_EXECUTABLE");
  const audioFile = requiredEnv("CHORDVOX_PACKAGED_DICTATION_AUDIO_FILE");
  const modelPath = requiredEnv("CHORDVOX_PACKAGED_DICTATION_WHISPER_MODEL");
  const evidencePath = requiredEnv("CHORDVOX_PACKAGED_EVIDENCE_PATH");
  const expectedSourceSha = requiredEnv("CHORDVOX_PACKAGED_SOURCE_SHA");
  const expectedPlatform = requiredEnv("CHORDVOX_PACKAGED_EXPECTED_PLATFORM") as NodeJS.Platform;
  const expectedPattern = new RegExp(
    process.env.CHORDVOX_PACKAGED_DICTATION_EXPECTED_PATTERN || "hello|world|chordvox",
    "i"
  );

  for (const [label, filePath] of [
    ["packaged executable", executablePath],
    ["fixed WAV", audioFile],
    ["Whisper model", modelPath],
    ["paste target", pasteTargetMain],
  ]) {
    expect(fs.existsSync(filePath), `${label} must exist: ${filePath}`).toBe(true);
  }

  const appProfile = fs.mkdtempSync(path.join(os.tmpdir(), "chordvox-packaged-app-"));
  const targetProfile = fs.mkdtempSync(path.join(os.tmpdir(), "chordvox-paste-target-"));
  let packagedApp: PackagedAppHandle | null = null;
  let pasteTargetApp: ElectronApplication | null = null;

  try {
    pasteTargetApp = await electron.launch({
      args: [pasteTargetMain, ...launchSwitches(targetProfile, audioFile)],
      env: { ...process.env, CHORDVOX_E2E: "0" },
    });
    const pasteTargetPage = await pasteTargetApp.firstWindow();
    await pasteTargetPage.waitForLoadState("domcontentloaded");
    const pasteTargetUserData = await pasteTargetApp.evaluate(({ app }) => app.getPath("userData"));
    expect(path.resolve(pasteTargetUserData)).toBe(path.resolve(targetProfile));

    packagedApp = await launchPackagedApp(executablePath, appProfile, audioFile);
    const dictationPage = packagedApp.page;
    dictationPage.setDefaultTimeout(15_000);
    const navigatorPlatform = await dictationPage.evaluate(() => navigator.platform);
    const runtimeInfo: RuntimeInfo = {
      appPath: packagedApp.appAsarPath,
      arch: process.arch,
      executablePath: path.resolve(executablePath),
      isPackaged: dictationPage.url().includes("app.asar"),
      pid: packagedApp.process.pid || 0,
      platform: platformFromNavigator(navigatorPlatform),
      userDataPath: appProfile,
      version: readPackagedVersion(packagedApp.appAsarPath),
    };
    const sourceSha = readPackagedSourceSha(packagedApp.appAsarPath);
    expect(sourceSha).toBe(expectedSourceSha);
    const pasteTargetPid = await pasteTargetApp.evaluate(() => process.pid);

    expect(runtimeInfo.isPackaged).toBe(true);
    expect(runtimeInfo.platform).toBe(expectedPlatform);
    expect(runtimeInfo.appPath).toContain("app.asar");
    expect(path.resolve(runtimeInfo.userDataPath)).toBe(path.resolve(appProfile));
    expect(runtimeInfo.pid).not.toBe(pasteTargetPid);
    await expect
      .poll(() => fs.existsSync(path.join(appProfile, "transcriptions.db")), { timeout: 10_000 })
      .toBe(true);

    await installFixedWavMediaDevice(dictationPage, audioFile);
    await applyProductionSettings(dictationPage, modelPath);

    const rendererHasFixtureHook = await dictationPage.evaluate(
      () =>
        typeof (window as unknown as { __CHORDVOX_E2E_PROCESS_AUDIO_BYTES?: unknown })
          .__CHORDVOX_E2E_PROCESS_AUDIO_BYTES !== "undefined"
    );
    const externalFixedWavDeviceActive = await dictationPage.evaluate(
      () =>
        (window as unknown as { __CHORDVOX_EXTERNAL_FIXED_WAV_DEVICE?: boolean })
          .__CHORDVOX_EXTERNAL_FIXED_WAV_DEVICE === true
    );
    expect(rendererHasFixtureHook).toBe(false);
    expect(externalFixedWavDeviceActive).toBe(true);

    // Focus the independent paste target before revealing the idle capsule.
    // The production UI intentionally auto-hides an idle capsule after a
    // short delay; doing this after show can race on slower Linux/X11 guests.
    const micButton = dictationPage.locator("button[aria-pressed][aria-busy]").first();
    await dictationPage.evaluate(() => {
      const state = window as unknown as { __CHORDVOX_PACKAGED_CLICK_TRUST?: boolean[] };
      state.__CHORDVOX_PACKAGED_CLICK_TRUST = [];
      const button = document.querySelector("button[aria-pressed][aria-busy]");
      if (!button) throw new Error("Dictation microphone button not found");
      button.addEventListener(
        "click",
        (event) => state.__CHORDVOX_PACKAGED_CLICK_TRUST?.push(event.isTrusted),
        true
      );
    });

    await focusPasteTarget(pasteTargetApp, pasteTargetPage, {
      required: false,
      label: "paste target before recording",
    });
    await dictationPage.evaluate(async () => {
      await window.electronAPI?.hideWindow?.();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await window.electronAPI?.showDictationPanel?.();
      await window.electronAPI?.setMainWindowInteractivity?.(true, { focus: false });
    });
    await revealInteractiveMic(dictationPage, micButton);
    await armNativeMicPointer(dictationPage, micButton);

    // X11 virtual displays can keep the Nebula transform in motion forever;
    // force only skips Playwright's animation-stability wait and still sends
    // native mouse input (the evidence below checks event.isTrusted).
    await micButton.click({ force: true });
    await expect(micButton).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
    await expect
      .poll(
        () =>
          dictationPage.evaluate(
            () =>
              (window as unknown as { __CHORDVOX_EXTERNAL_FIXED_WAV_CALLS?: number })
                .__CHORDVOX_EXTERNAL_FIXED_WAV_CALLS || 0
          ),
        { timeout: 10_000 }
      )
      .toBeGreaterThan(0);

    await dictationPage.waitForTimeout(4_000);
    await hideDictationPanelForMacFocus(dictationPage);
    await focusPasteTarget(pasteTargetApp, pasteTargetPage);
    await armNativeMicPointer(dictationPage, micButton);
    await micButton.click({ force: true });

    const clickTrustAfterStop = await dictationPage.evaluate(
      () =>
        (window as unknown as { __CHORDVOX_PACKAGED_CLICK_TRUST?: boolean[] })
          .__CHORDVOX_PACKAGED_CLICK_TRUST || []
    );
    expect(clickTrustAfterStop).toEqual([true, true]);

    let pastedText = "";
    const pasteDeadline = Date.now() + 90_000;
    while (Date.now() < pasteDeadline) {
      pastedText = await pasteTargetPage.locator("#paste-target").inputValue();
      if (expectedPattern.test(pastedText)) break;
      await dictationPage.waitForTimeout(500);
    }
    if (!expectedPattern.test(pastedText)) {
      const diagnostics = {
        micAriaPressed: await micButton.getAttribute("aria-pressed"),
        micAriaBusy: await micButton.getAttribute("aria-busy"),
        bodyText: (await dictationPage.locator("body").innerText()).slice(0, 2_000),
        fixedWavCalls: await dictationPage.evaluate(
          () =>
            (window as unknown as { __CHORDVOX_EXTERNAL_FIXED_WAV_CALLS?: number })
              .__CHORDVOX_EXTERNAL_FIXED_WAV_CALLS || 0
        ),
        pasteEvents: await pasteTargetPage.evaluate(
          () =>
            (window as unknown as { __CHORDVOX_PASTE_TARGET_EVENTS?: PasteTargetEvent[] })
              .__CHORDVOX_PASTE_TARGET_EVENTS || []
        ),
        userDataPath: runtimeInfo.userDataPath,
      };
      throw new Error(`Packaged click-to-paste timed out: ${JSON.stringify(diagnostics)}`);
    }

    const clickTrust = await dictationPage.evaluate(
      () =>
        (window as unknown as { __CHORDVOX_PACKAGED_CLICK_TRUST?: boolean[] })
          .__CHORDVOX_PACKAGED_CLICK_TRUST || []
    );
    const pasteEvents = await pasteTargetPage.evaluate(
      () =>
        (window as unknown as { __CHORDVOX_PASTE_TARGET_EVENTS?: PasteTargetEvent[] })
          .__CHORDVOX_PASTE_TARGET_EVENTS || []
    );
    const trustedPasteInput = pasteEvents.some(
      (event) => event.isTrusted && ["paste", "beforeinput", "input"].includes(event.type)
    );

    expect(clickTrust).toEqual([true, true]);
    expect(trustedPasteInput).toBe(true);

    const evidence = {
      schemaVersion: 1,
      sourceSha,
      platform: runtimeInfo.platform,
      arch: runtimeInfo.arch,
      version: runtimeInfo.version,
      installKind: process.env.CHORDVOX_PACKAGED_INSTALL_KIND || "packaged",
      appIsPackaged: runtimeInfo.isPackaged,
      appPathUsesAsar: runtimeInfo.appPath.includes("app.asar"),
      userDataIsolated: path.resolve(runtimeInfo.userDataPath) === path.resolve(appProfile),
      e2eHooksDisabled: process.env.CHORDVOX_E2E === "0" && !rendererHasFixtureHook,
      fixedWavMediaDeviceInjectedExternally: externalFixedWavDeviceActive,
      executableSha256: await sha256File(executablePath),
      fixedWavSha256: await sha256File(audioFile),
      whisperModelSha256: await sha256File(modelPath),
      transcript: pastedText.trim(),
      transcriptMatched: expectedPattern.test(pastedText),
      trustedButtonClicks: clickTrust.length === 2 && clickTrust.every(Boolean),
      trustedPasteInput,
      pasteTargetProcessDistinct: runtimeInfo.pid !== pasteTargetPid,
      completedAt: new Date().toISOString(),
    };
    const tempEvidence = `${evidencePath}.tmp-${process.pid}`;
    fs.writeFileSync(tempEvidence, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempEvidence, evidencePath);
  } finally {
    await closePackagedApp(packagedApp);
    await closeElectronApp(pasteTargetApp, 5_000);
    fs.rmSync(appProfile, { recursive: true, force: true });
    fs.rmSync(targetProfile, { recursive: true, force: true });
  }
});
