const fs = require("fs");
const fsPromises = require("fs/promises");
const os = require("os");
const path = require("path");
const { app } = require("electron");
const {
  getConfiguredSpeechModelsRoot,
  getDefaultSpeechModelsRoot,
  getLegacyModelsRoot,
  getServiceModelsDir,
  resolveModelsDirForService,
} = require("./helpers/modelDirUtils");
const secureSecrets = require("./helpers/secureSecrets");

const MODEL_SERVICES = [
  "whisper",
  "streaming",
  "parakeet",
  "paraformer",
  "granite",
  "cohere",
  "punctuation",
];
const USER_ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "SONIOX_API_KEY",
  "DEEPGRAM_API_KEY",
  "GOOGLE_STT_API_KEY",
  "DOUBAO_APP_ID",
  "DOUBAO_ACCESS_TOKEN",
  "CUSTOM_TRANSCRIPTION_API_KEY",
  "CUSTOM_REASONING_API_KEY",
  "GRANITE_RUNTIME_API_KEY",
  "COHERE_RUNTIME_API_KEY",
  "BEDROCK_ACCESS_KEY_ID",
  "BEDROCK_SECRET_ACCESS_KEY",
  "BEDROCK_SESSION_TOKEN",
  "LICENSE_API_BASE_URL",
  "LICENSE_PRODUCT_ID",
  "LICENSE_ALLOW_DEV_KEYS",
  "LOCAL_TRANSCRIPTION_PROVIDER",
  "PARAKEET_MODEL",
  "PARAFORMER_MODEL",
  "LOCAL_WHISPER_MODEL",
  "GRANITE_MODEL",
  "COHERE_MODEL",
  "GRANITE_RUNTIME_URL",
  "COHERE_RUNTIME_URL",
  "REASONING_PROVIDER",
  "LOCAL_REASONING_MODEL",
  "DICTATION_KEY",
  "ACTIVATION_MODE",
  "AUTO_START_ENABLED",
  "TRAY_ICON_ENABLED",
  "AUTO_CHECK_UPDATE",
  "UI_LANGUAGE",
  "MODEL_STORAGE_ROOT",
];

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function removePath(targetPath, label, errors) {
  if (!targetPath) return;
  try {
    await fsPromises.rm(targetPath, { recursive: true, force: true });
    if (fs.existsSync(targetPath)) {
      throw new Error("path still exists after deletion");
    }
  } catch (error) {
    errors.push({ step: label, error: errorMessage(error) });
  }
}

async function stopManagedServices(managers, errors) {
  const tasks = [
    ["Whisper download", managers.whisperManager?.cancelDownload?.bind(managers.whisperManager)],
    ["Parakeet download", managers.parakeetManager?.cancelDownload?.bind(managers.parakeetManager)],
    [
      "Paraformer download",
      managers.paraformerManager?.cancelDownload?.bind(managers.paraformerManager),
    ],
    [
      "Granite download",
      managers.graniteRuntimeManager?.cancelDownload?.bind(managers.graniteRuntimeManager),
    ],
    [
      "streaming model download",
      managers.sherpaStreaming?.cancelDownload?.bind(managers.sherpaStreaming),
    ],
    ["whisper server", managers.whisperManager?.stopServer?.bind(managers.whisperManager)],
    ["Parakeet server", managers.parakeetManager?.stopServer?.bind(managers.parakeetManager)],
    ["Paraformer server", managers.paraformerManager?.stopServer?.bind(managers.paraformerManager)],
    [
      "Granite server",
      managers.graniteRuntimeManager?.stopServer?.bind(managers.graniteRuntimeManager),
    ],
    [
      "streaming model worker",
      managers.sherpaStreaming?.stopStream?.bind(managers.sherpaStreaming),
    ],
  ];

  try {
    const modelManager = require("./helpers/modelManagerBridge").default;
    for (const modelId of modelManager.activeRequests?.keys?.() || []) {
      modelManager.cancelDownload(modelId);
    }
    tasks.push(["local reasoning server", modelManager.stopServer?.bind(modelManager)]);
  } catch (error) {
    errors.push({ step: "local reasoning server", error: errorMessage(error) });
  }

  const results = await Promise.allSettled(
    tasks.filter(([, action]) => typeof action === "function").map(([, action]) => action())
  );
  let resultIndex = 0;
  for (const [label, action] of tasks) {
    if (typeof action !== "function") continue;
    const result = results[resultIndex++];
    if (result.status === "rejected") {
      errors.push({ step: label, error: errorMessage(result.reason) });
    }
  }
}

async function waitForDownloadsToSettle(managers, errors) {
  const activeDownloads = [
    ["Whisper download", () => Boolean(managers.whisperManager?.currentDownloadProcess)],
    ["Parakeet download", () => Boolean(managers.parakeetManager?.currentDownloadProcess)],
    ["Paraformer download", () => Boolean(managers.paraformerManager?.currentDownloadProcess)],
    ["Granite download", () => Boolean(managers.graniteRuntimeManager?.currentDownloadProcess)],
    ["streaming model download", () => Boolean(managers.sherpaStreaming?.currentDownload)],
  ];
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    if (activeDownloads.every(([, isActive]) => !isActive())) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const unsettled = activeDownloads.filter(([, isActive]) => isActive()).map(([label]) => label);
  if (unsettled.length > 0) {
    errors.push({
      step: "download cancellation",
      error: `Timed out waiting for: ${unsettled.join(", ")}`,
    });
  }
}

async function readAndClearRendererStorage(mainWindow, errors) {
  let legacyStreamingModelsDir = "";
  const webContents = mainWindow?.webContents;
  if (!webContents || webContents.isDestroyed?.()) {
    return { legacyStreamingModelsDir };
  }

  try {
    const rendererState = await webContents.executeJavaScript(
      `(() => {
        const legacyStreamingModelsDir = localStorage.getItem("localStreamingModelsDir") || "";
        localStorage.clear();
        sessionStorage.clear();
        return { legacyStreamingModelsDir };
      })()`
    );
    legacyStreamingModelsDir = String(rendererState?.legacyStreamingModelsDir || "");
  } catch (error) {
    errors.push({ step: "renderer storage", error: errorMessage(error) });
  }

  try {
    await webContents.session?.clearStorageData?.({
      storages: ["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage"],
    });
    await webContents.session?.clearCache?.();
  } catch (error) {
    errors.push({ step: "Electron session storage", error: errorMessage(error) });
  }

  return { legacyStreamingModelsDir };
}

async function removeDatabaseFiles(userDataDir, errors) {
  let entries = [];
  try {
    entries = await fsPromises.readdir(userDataDir);
  } catch (error) {
    errors.push({ step: "database discovery", error: errorMessage(error) });
    return;
  }

  const databasePattern =
    /^transcriptions(?:-dev)?\.db(?:-(?:wal|shm))?(?:\.plaintext-backup-[A-Za-z0-9-]+)?$/;
  for (const entry of entries) {
    if (databasePattern.test(entry)) {
      await removePath(path.join(userDataDir, entry), `database file ${entry}`, errors);
    }
  }
}

class AppUtils {
  static async cleanup(options = {}) {
    const errors = [];
    const userDataDir = app.getPath("userData");
    const mainWindow = options.mainWindow || null;

    await stopManagedServices(options, errors);
    await waitForDownloadsToSettle(options, errors);

    try {
      await options.environmentManager?.prepareForReset?.();
    } catch (error) {
      errors.push({ step: "environment persistence", error: errorMessage(error) });
    }

    try {
      await options.databaseManager?.close?.();
    } catch (error) {
      errors.push({ step: "database close", error: errorMessage(error) });
    }

    const { legacyStreamingModelsDir } = await readAndClearRendererStorage(mainWindow, errors);
    await removeDatabaseFiles(userDataDir, errors);

    const roots = [
      getConfiguredSpeechModelsRoot(),
      getDefaultSpeechModelsRoot(),
      getLegacyModelsRoot(),
    ].filter(Boolean);
    const modelPaths = new Set();
    for (const root of roots) {
      for (const service of MODEL_SERVICES) {
        modelPaths.add(getServiceModelsDir(root, service));
      }
    }
    if (legacyStreamingModelsDir) {
      try {
        modelPaths.add(resolveModelsDirForService("streaming", legacyStreamingModelsDir));
      } catch (error) {
        errors.push({ step: "legacy streaming model path", error: errorMessage(error) });
      }
    }
    modelPaths.add(path.join(os.homedir(), ".cache", "chordvox", "models"));

    for (const modelPath of modelPaths) {
      await removePath(modelPath, `model cache ${modelPath}`, errors);
    }

    const secureStorePath = secureSecrets.getSecretStorePath();
    const userDataPaths = [
      path.join(userDataDir, ".env"),
      path.join(userDataDir, ".env.bak"),
      secureStorePath,
      `${secureStorePath}.bak`,
      path.join(userDataDir, "license-state.json"),
      path.join(userDataDir, "license-state.json.bak"),
      path.join(userDataDir, "context-settings.json"),
      path.join(userDataDir, "context-settings.json.bak"),
      path.join(userDataDir, "onboarding-state.json"),
      path.join(userDataDir, "onboarding-state.json.bak"),
      path.join(userDataDir, "main-window-state.json"),
      path.join(userDataDir, "updater-install-marker.json"),
      path.join(userDataDir, "granite-runtime"),
      path.join(userDataDir, "llama-cpp"),
    ];
    for (const targetPath of userDataPaths) {
      await removePath(targetPath, `app data ${path.basename(targetPath)}`, errors);
    }

    for (const key of USER_ENV_KEYS) {
      delete process.env[key];
    }

    return {
      success: errors.length === 0,
      message:
        errors.length === 0
          ? "All ChordVox application data was removed."
          : "Some application data could not be removed.",
      errors,
      requiresRestart: true,
    };
  }
}

module.exports = AppUtils;
