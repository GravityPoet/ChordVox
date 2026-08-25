import { describe, expect, it } from "vitest";
import { X509Certificate } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("reviewed release and prompt guardrails", () => {
  it("captures the login-launch context before auto-start registration", () => {
    const mainProcess = readRepoFile("main.js");
    const startAppStart = mainProcess.indexOf("async function startApp()");
    const startAppEnd = mainProcess.indexOf("// Telemetry IPC handlers", startAppStart);
    const startApp = mainProcess.slice(startAppStart, startAppEnd);
    const launchContextIndex = startApp.indexOf("const launchedAtLogin = wasLaunchedAtLogin();");
    const autoStartSyncIndex = startApp.indexOf("syncAutoStartSetting();");

    expect(startAppStart).toBeGreaterThan(-1);
    expect(startAppEnd).toBeGreaterThan(startAppStart);
    expect(launchContextIndex).toBeGreaterThan(-1);
    expect(autoStartSyncIndex).toBeGreaterThan(launchContextIndex);
    expect(startApp).toContain(
      "await windowManager.createControlPanelWindow({ show: !launchedAtLogin });"
    );
  });

  it("does not use Bash 4 mapfile in the macOS release manifest step", () => {
    const releaseWorkflow = readRepoFile(".github/workflows/release.yml");
    const manifestStart = releaseWorkflow.indexOf("Generate macOS release manifest");
    const manifestEnd = releaseWorkflow.indexOf("Stage macOS release artifacts");
    const macManifestStep = releaseWorkflow.slice(manifestStart, manifestEnd);

    expect(manifestStart).toBeGreaterThan(-1);
    expect(manifestEnd).toBeGreaterThan(manifestStart);
    expect(macManifestStep.length).toBeGreaterThan(0);
    expect(macManifestStep).not.toContain("mapfile");
  });

  it("publishes only after every automated release asset is staged and verified", () => {
    const releaseWorkflow = readRepoFile(".github/workflows/release.yml");
    const publishJob = releaseWorkflow.slice(releaseWorkflow.indexOf("  publish-release:"));

    expect(releaseWorkflow).not.toContain("ensure-public-release");
    expect(releaseWorkflow).toContain("actions/upload-artifact@v4");
    expect(publishJob).toContain(
      "needs: [resolve-release, release-quality-gates, build-linux, build-windows, build-macos]"
    );
    expect(publishJob).toContain("scripts/merge-mac-update-metadata.js");
    expect(publishJob).toContain('gh release create "$TAG" -R "$REPO" --draft');
    expect(publishJob).toContain("Refusing to replace assets on an already-public release");
    expect(publishJob).toContain('MISSING_ASSETS="$(comm -23');
    expect(publishJob).toContain('UNEXPECTED_ASSETS="$(comm -13');
    expect(publishJob).toContain("gh release delete-asset");
    expect(publishJob).toContain("Release still contains assets that were not staged by this run");
    expect(publishJob).toContain('gh release edit "$TAG" -R "$REPO" --draft=false');
  });

  it("removes stale Windows assets before a manual UTM release retry", () => {
    const manualPublisher = readRepoFile("scripts/publish-utm-windows-release.sh");

    expect(manualPublisher).toContain("EXPECTED_UPLOAD_NAMES");
    expect(manualPublisher).toContain(
      "*.exe|*.exe.blockmap|latest.yml|release-manifest-windows.json"
    );
    expect(manualPublisher).toContain("gh release delete-asset");
    expect(manualPublisher).toContain('MISSING_UPLOADS="$(comm -23');
  });

  it("binds release metadata and macOS updates to the requested version and architecture", () => {
    const releaseWorkflow = readRepoFile(".github/workflows/release.yml");
    const metadataMerger = readRepoFile("scripts/merge-mac-update-metadata.js");
    const updater = readRepoFile("src/updater.js");

    expect(releaseWorkflow).toContain('git show "${SOURCE_SHA}:package.json"');
    expect(releaseWorkflow).toContain('if [ "$PACKAGE_VERSION" != "$VERSION" ]');
    expect(metadataMerger).toContain("both Intel and Apple Silicon ZIP files are required");
    expect(metadataMerger).toContain("path: x64Zip.url");
    expect(updater).toContain('NEW_APP="$STAGING_DIR/$EXPECTED_APP_BUNDLE_NAME"');
    expect(updater).not.toContain('find "$STAGING_DIR" -maxdepth 2 -name "*.app"');
    expect(updater).toContain('const EXPECTED_MAC_BUNDLE_NAME = "ChordVox.app"');
    expect(updater).toContain("expectedUpdateArch");
    expect(updater).not.toContain("process.arch,");
    expect(updater).toContain("EXPECTED_MAC_BUNDLE_ID");
    expect(updater).toContain("MACOS_SIGNING_CERTIFICATE_SHA256");
    expect(updater).toContain("macosCodeRequirement");
    expect(updater).toContain("--extract-certificates");
    expect(updater).not.toContain("EXPECTED_MAC_TEAM_ID");
    expect(updater).toContain("CFBundleShortVersionString");
    expect(updater).toContain("codesign --verify --deep --strict");
    expect(updater).toContain('/usr/bin/lipo -archs "$NEW_EXECUTABLE"');
  });

  it("binds packaged acceptance evidence to the app.asar source metadata", () => {
    const packagedVerifier = readRepoFile("scripts/verify-packaged-real-dictation.js");
    const packagedE2e = readRepoFile("tests/e2e/packaged-dictation.real.spec.ts");
    const metadataHelper = readRepoFile("scripts/lib/release-metadata.js");
    const macVerifier = readRepoFile("scripts/verify-mac-package.js");
    const releaseWorkflow = readRepoFile(".github/workflows/release.yml");
    const previewWorkflow = readRepoFile(".github/workflows/build-and-notarize.yml");

    expect(metadataHelper).toContain("releaseSourceSha");
    expect(packagedVerifier).toContain("readPackagedSourceSha");
    expect(packagedVerifier).toContain("CHORDVOX_PACKAGED_EXPECTED_SOURCE_SHA");
    expect(packagedE2e).toContain("readPackagedSourceSha");
    expect(macVerifier).toContain("CHORDVOX_EXPECTED_SOURCE_SHA");
    expect(macVerifier).toContain('path.join(distRoot, ".mac-dmg-work", "mac-x64"');
    expect(releaseWorkflow).toContain("--config.extraMetadata.releaseSourceSha=");
    expect(releaseWorkflow).toContain("scripts/verify-release-assets.js");
    for (const workflow of [releaseWorkflow, previewWorkflow]) {
      expect(workflow).toContain("runner: macos-15-intel");
      expect(workflow).toContain("runner: macos-15");
      expect(workflow).toContain("npm run verify:packaged:dictation");
      expect(workflow).toContain("npm run verify:installed:dictation");
      expect(workflow).toContain("scripts/install-macos-local-build.sh");
      expect(workflow).toContain("native-runtime-evidence-macos-${{ matrix.arch }}-installed.json");
    }
  });

  it("restores quit listeners after update installation fails and honors auto-download state", () => {
    const updater = readRepoFile("src/updater.js");
    const updaterHook = readRepoFile("src/hooks/useUpdater.ts");
    const generalSettings = readRepoFile("src/components/settings/GeneralSection.tsx");

    expect(updater).toContain("const restoreCloseListeners = () =>");
    expect(updater).toMatch(/catch \(error\) \{\s*restoreCloseListeners\(\);\s*throw error;/);
    expect(updater).toContain("this.clearInstallMarker();");
    expect(updaterHook).toContain("isDownloading: info?.autoDownload === true");
    expect(updaterHook).toContain("if (!result?.success)");
    expect(generalSettings).toContain("if (!openResult?.success)");
  });

  it("requires an explicit cross-repository token before publishing to the public release repo", () => {
    const releaseWorkflow = readRepoFile(".github/workflows/release.yml");

    expect(releaseWorkflow).toContain("HAS_PUBLIC_RELEASE_TOKEN");
    expect(releaseWorkflow).toContain("PUBLIC_RELEASE_REPO");
    expect(releaseWorkflow).toMatch(/PUBLIC_RELEASE_REPO[\s\S]*GITHUB_REPOSITORY/);
  });

  it("uses the pinned self-signed identity for every macOS package workflow", () => {
    const workflow = readRepoFile(".github/workflows/build-and-notarize.yml");
    const releaseWorkflow = readRepoFile(".github/workflows/release.yml");
    const builderConfig = JSON.parse(readRepoFile("electron-builder.json")) as {
      mac: Record<string, unknown>;
    };

    expect(workflow).not.toMatch(/(^|\s)electron-builder --mac/);
    expect(workflow).toContain("node scripts/build-mac-dmg.js");
    expect(workflow).toContain("CHORDVOX_MACOS_CERTIFICATE_BASE64");
    expect(workflow).toContain("CHORDVOX_MACOS_CERTIFICATE_PASSWORD");
    expect(releaseWorkflow).toContain("CHORDVOX_MACOS_CERTIFICATE_BASE64");
    expect(releaseWorkflow).toContain("resources/mac/chordvox-local-signing.crt");
    expect(releaseWorkflow).not.toContain("APPLE_API_KEY_BASE64");
    expect(builderConfig.mac.identity).toBe("ChordVox Local Code Signing");
    expect(builderConfig.mac.forceCodeSigning).toBe(true);
    expect(builderConfig.mac.notarize).toBe(false);
    expect(builderConfig.mac.hardenedRuntime).toBe(true);
  });

  it("pins stable macOS permissions and update identity to the ChordVox certificate", () => {
    const signingSetup = readRepoFile("scripts/ensure-macos-signing-identity.sh");
    const localInstaller = readRepoFile("scripts/install-macos-local-build.sh");
    const signingConfig = readRepoFile("src/config/macosSigningIdentity.js");
    const packageVerifier = readRepoFile("scripts/verify-mac-package.js");
    const accessibilityGuidance = readRepoFile("src/helpers/macosAccessibilityGuidance.js");
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      scripts: Record<string, string>;
    };
    const certificate = new X509Certificate(
      readRepoFile("resources/mac/chordvox-local-signing.crt")
    );
    const certificateSha1 = certificate.fingerprint.replaceAll(":", "").toLowerCase();
    const certificateSha256 = certificate.fingerprint256.replaceAll(":", "").toLowerCase();

    expect(signingSetup).toContain("verify_stable_requirement");
    expect(signingSetup).toContain("certificate root = H");
    expect(signingConfig).toContain(`"${certificateSha1}"`);
    expect(signingConfig).toContain(`"${certificateSha256}"`);
    expect(packageVerifier).toContain("verifyMacCodeSignature");
    expect(packageVerifier).toContain("MACOS_SIGNING_CERTIFICATE_SHA256");
    expect(accessibilityGuidance).toContain("stable_self_signed_signature");
    expect(packageJson.scripts["install:mac:local"]).toBe(
      "bash scripts/install-macos-local-build.sh"
    );
    expect(localInstaller).toContain("AppRollbacks.noindex");
    expect(localInstaller).toContain("ACCESSIBILITY_REGRANT_REQUIRED=0");
    expect(localInstaller).toContain('INSTALL_STAGING="/Applications/.chordvox-staging-$$.app"');
    expect(localInstaller).toContain('DISPLACED_APP="/Applications/.chordvox-displaced-$$.app"');
    expect(localInstaller).toContain('verify_app "$INSTALL_APP"');
    expect(localInstaller).not.toContain("tccutil reset");
  });

  it("verifies packaged outputs without consuming Actions artifact storage", () => {
    const workflow = readRepoFile(".github/workflows/build-and-notarize.yml");

    expect(workflow).not.toContain("actions/upload-artifact");
    expect(workflow).not.toMatch(/^\s+path: dist\/$/m);
    expect(workflow).toContain("dist/*.AppImage");
    expect(workflow).toContain("Get-ChildItem -Path dist -Filter *.exe -File");
    expect(workflow).toContain("dist/*.dmg");
    expect(workflow).toContain("Verify Linux package set");
    expect(workflow).toContain("Verify Windows package set");
    expect(workflow).toContain("Verify macOS package set");
    expect(workflow).toContain("Expected NSIS and portable Windows installers");
  });

  it("prepares every native runtime before preview packaging", () => {
    const workflow = readRepoFile(".github/workflows/build-and-notarize.yml");

    expect(workflow).toContain("npm run prebuild:linux");
    expect(workflow).toContain("npm run prebuild:win");
    expect(workflow).toContain("resources/bin/node-runtime/linux-x64/bin/node");
    expect(workflow).toContain("resources/bin/node-runtime/win32-x64/node.exe");
    expect(workflow).toContain("resources/bin/llama-server-linux-x64");
    expect(workflow).toContain("resources/bin/llama-server-win32-x64.exe");
  });

  it("builds Linux packages reproducibly and rejects helpers above the Ubuntu 22.04 ABI", () => {
    for (const workflowPath of [
      ".github/workflows/release.yml",
      ".github/workflows/build-and-notarize.yml",
    ]) {
      const workflow = readRepoFile(workflowPath);
      const linuxJobStart = workflow.indexOf("  build-linux:");
      const linuxJobEnd = workflow.indexOf("  build-windows:", linuxJobStart);
      const linuxJob = workflow.slice(linuxJobStart, linuxJobEnd);

      expect(linuxJobStart).toBeGreaterThan(-1);
      expect(linuxJobEnd).toBeGreaterThan(linuxJobStart);
      expect(linuxJob).toContain("runs-on: ubuntu-24.04");
      expect(linuxJob).toContain("binutils");
      expect(linuxJob).toContain("linux-ubuntu24-glibc235-x64-bin-");
      expect(linuxJob).toContain("scripts/build-linux-fast-paste.js");
      expect(linuxJob).toContain("resources/linux-fast-paste.c");
    }
  });

  it("validates the cached macOS permission helper binary architecture before skipping rebuild", () => {
    const script = readRepoFile("scripts/build-mac-permission-helper.js");

    expect(script).toContain("ARCH_TO_LIPO_ARCH");
    expect(script).toContain("binarySupportsTargetArch");
    expect(script).toContain("lipo");
    expect(script).toContain('x64: "x86_64-apple-macosx11.0"');
    expect(script).toMatch(/binarySupportsTargetArch\(outputBinary,\s*targetArch\)/);
  });

  it("keeps onboarding telemetry opt-in and scrubs top-level Sentry messages", () => {
    const mainProcess = readRepoFile("main.js");
    const renderer = readRepoFile("src/main.jsx");

    expect(mainProcess).toContain("setupSentry(false)");
    expect(mainProcess).toContain("!client?.getOptions()?.enabled");
    expect(mainProcess).toContain("buildOnboardingFunnelSentryEvent");
    expect(mainProcess).toContain("if (event.message) event.message = scrubString(event.message)");
    expect(renderer).toContain("if (event.message) event.message = scrubString(event.message)");
  });

  it("persists diagnostic logging through the private atomic environment writer", () => {
    const environmentManager = readRepoFile("src/helpers/environment.js");
    const ipcHandlers = readRepoFile("src/helpers/ipcHandlers.js");
    const persistedKeysStart = environmentManager.indexOf("const PERSISTED_KEYS");
    const persistedKeysEnd = environmentManager.indexOf("];", persistedKeysStart);
    const persistedKeys = environmentManager.slice(persistedKeysStart, persistedKeysEnd);
    const handlerStart = ipcHandlers.indexOf('ipcMain.handle("set-debug-logging"');
    const handlerEnd = ipcHandlers.indexOf('ipcMain.handle("open-logs-folder"', handlerStart);
    const handler = ipcHandlers.slice(handlerStart, handlerEnd);

    expect(persistedKeys).not.toContain('"CHORDVOX_LOG_LEVEL"');
    expect(environmentManager).toContain("options.persistLogLevel === true");
    expect(environmentManager).toContain(
      "atomicWriteFile(envPath, envContent, { mode: 0o600, backup: true })"
    );
    expect(handler).toContain(
      "this.environmentManager.saveAllKeysToEnvFile({ persistLogLevel: true })"
    );
    expect(handler).toContain('enabled === true ? "debug" : "info"');
    expect(handler).not.toContain("fsPromises.writeFile");
  });

  it("serializes environment writes and reports durable-save failures", () => {
    const environmentManager = readRepoFile("src/helpers/environment.js");
    const ipcHandlers = readRepoFile("src/helpers/ipcHandlers.js");

    expect(environmentManager).toContain(
      'const { SerialTaskQueue } = require("./serialTaskQueue");'
    );
    expect(environmentManager).toContain("this.persistenceQueue = new SerialTaskQueue();");
    expect(environmentManager).toContain(
      "const task = this.persistenceQueue.run(() => this._saveAllKeysToEnvFile(options));"
    );
    expect(environmentManager).toContain("await this.saveAllKeysToEnvFile({");
    expect(environmentManager).toContain('code: error?.code || "ENV_PERSISTENCE_FAILED"');
    expect(ipcHandlers).toContain(
      "const persisted = await this.environmentManager.saveAutoStartEnabled(enabled);"
    );
    expect(ipcHandlers).toContain(
      "const persisted = await this.environmentManager.saveTrayIconEnabled(normalized);"
    );
  });

  it("keeps local license transitions ordered and recoverable", () => {
    const licenseManager = readRepoFile("src/helpers/licenseManager.js");
    const atomicFile = readRepoFile("src/helpers/atomicFile.js");
    const secureSecrets = readRepoFile("src/helpers/secureSecrets.js");

    expect(licenseManager).toContain(
      'const { atomicWriteFile, readJsonWithBackup } = require("./atomicFile");'
    );
    expect(licenseManager).toContain("this.stateOperationQueue = new SerialTaskQueue();");
    expect(licenseManager).toContain(
      "return this._enqueueStateOperation(() => this._validateLicense());"
    );
    expect(licenseManager).toContain(
      "await atomicWriteFile(this.statePath, JSON.stringify(signedState, null, 2),"
    );
    expect(licenseManager).toContain("recoverCorrupt: true");
    expect(licenseManager).toContain("await fs.rm(`${this.statePath}.bak`, { force: true });");
    expect(atomicFile).toContain("const recoverCorrupt = options.recoverCorrupt === true;");
    expect(secureSecrets).toContain("atomicWriteFileSync(storePath");
  });

  it("keeps the onboarding dictation preview in memory and removes legacy disk copies", () => {
    const ipcHandlers = readRepoFile("src/helpers/ipcHandlers.js");
    const onboarding = readRepoFile("src/components/OnboardingFlow.tsx");
    const electronTypes = readRepoFile("src/types/electron.ts");
    const sanitizerStart = ipcHandlers.indexOf("_sanitizeOnboardingStatePatch");
    const sanitizerEnd = ipcHandlers.indexOf("async _readOnboardingStateFile", sanitizerStart);
    const sanitizer = ipcHandlers.slice(sanitizerStart, sanitizerEnd);
    const persistenceStart = onboarding.indexOf("?.saveOnboardingState?.({");
    const persistenceEnd = onboarding.indexOf("?.catch((error)", persistenceStart);
    const persistence = onboarding.slice(persistenceStart, persistenceEnd);

    expect(sanitizer).not.toContain("dictationTestPreview");
    expect(sanitizer).not.toContain("activationManualText");
    expect(persistence).not.toContain("dictationTestPreview");
    expect(persistence).not.toContain("activationManualText");
    expect(electronTypes).not.toContain("dictationTestPreview?: string");
    expect(electronTypes).not.toContain("activationManualText?: string");
    expect(ipcHandlers).toContain("backup: false");
    expect(ipcHandlers).toContain("mode: 0o600");
    expect(ipcHandlers).toContain("`${this.onboardingStatePath}.bak`");
    expect(ipcHandlers).not.toContain("dictationTestPreview: successEvent.previewText");
  });

  it("reports folder launch failures instead of claiming success", () => {
    const ipcHandlers = readRepoFile("src/helpers/ipcHandlers.js");
    for (const channel of ["open-model-cache-folder", "open-logs-folder"]) {
      const handlerStart = ipcHandlers.indexOf(`ipcMain.handle("${channel}"`);
      const handlerEnd = ipcHandlers.indexOf("ipcMain.handle(", handlerStart + 1);
      const handler = ipcHandlers.slice(handlerStart, handlerEnd);

      expect(handlerStart).toBeGreaterThan(-1);
      expect(handler).toContain("const openError = await shell.openPath");
      expect(handler).toContain("if (openError)");
      expect(handler).toContain("throw new Error(openError)");
    }
  });

  it("keeps unfinished ChordVox hosted-cloud routes disabled and out of customer UI", () => {
    const cloudAvailability = readRepoFile("src/utils/chordvoxCloud.js");
    const ipcHandlers = readRepoFile("src/helpers/ipcHandlers.js");
    const aiModels = readRepoFile("src/components/settings/AiModelsSection.tsx");
    const privacy = readRepoFile("src/components/settings/PrivacyPermissionsSection.tsx");
    const controlPanel = readRepoFile("src/components/ControlPanel.tsx");
    const settingsPage = readRepoFile("src/components/SettingsPage.tsx");

    expect(cloudAvailability).toContain("HOSTED_CLOUD_FEATURES_ENABLED = false");
    expect(ipcHandlers).toContain("HOSTED_CLOUD_FEATURES_ENABLED = false");
    expect(
      ipcHandlers.match(/if \(!HOSTED_CLOUD_FEATURES_ENABLED\)/g)?.length
    ).toBeGreaterThanOrEqual(5);
    expect(aiModels).not.toContain("settingsPage.aiModels.chordvoxCloud");
    expect(privacy).not.toContain("settingsPage.privacy.cloudBackup");
    expect(controlPanel).not.toContain("pendingCloudMigration");
    expect(controlPanel).not.toContain("useUsage");
    expect(settingsPage).not.toContain("useUsage");
  });

  it("keeps the shipped desktop flow account-free and license-key based", () => {
    const mainProcess = readRepoFile("main.js");
    const appRouter = readRepoFile("src/components/AppRouter.jsx");
    const rendererEntry = readRepoFile("src/main.jsx");
    const audioManager = readRepoFile("src/helpers/audioManager.js");
    const reasoningService = readRepoFile("src/services/ReasoningService.ts");
    const packageManifest = JSON.parse(readRepoFile("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const onboarding = readRepoFile("src/components/OnboardingFlow.tsx");
    const accountSection = readRepoFile("src/components/settings/AccountSection.tsx");

    expect(mainProcess).toContain("const ACCOUNT_AUTH_FEATURES_ENABLED = false");
    expect(mainProcess).toContain("if (ACCOUNT_AUTH_FEATURES_ENABLED) {");
    expect(appRouter).not.toContain("useAuth");
    expect(appRouter).not.toContain("AuthenticationStep");
    expect(appRouter).toContain("resolveWindowSurface(window.location)");
    expect(rendererEntry).not.toContain("isOAuthBrowserRedirect");
    expect(rendererEntry).not.toContain("VITE_CHORDVOX_AUTH_BRIDGE_URL");
    expect(audioManager).not.toContain("../lib/neonAuth");
    expect(reasoningService).not.toContain("../lib/neonAuth");
    expect(packageManifest.dependencies?.["@neondatabase/auth"]).toBeUndefined();
    expect(packageManifest.devDependencies?.["@neondatabase/auth"]).toBeTruthy();
    expect(onboarding).toContain('localStorage.setItem("authenticationSkipped", "true")');
    expect(accountSection).toContain("const accountAuthEnabled = false");
  });

  it("recovers audio services after sleep and fails cleanly after fatal main-process errors", () => {
    const mainProcess = readRepoFile("main.js");
    const audioManager = readRepoFile("src/helpers/audioManager.js");
    const audioHook = readRepoFile("src/hooks/useAudioRecording.js");
    const tray = readRepoFile("src/helpers/tray.js");

    expect(mainProcess).toContain('powerMonitor.on("suspend"');
    expect(mainProcess).toContain('powerMonitor.on("resume"');
    expect(mainProcess).toContain("recoverAfterSystemResume");
    expect(audioManager).toContain("resetAfterSystemPowerChange");
    expect(audioHook).toContain("onSystemResumeRecovering");
    expect(audioHook).toContain("onSystemResumed");
    expect(mainProcess).toContain("FATAL_RECOVERY_COOLDOWN_MS");
    expect(mainProcess).toContain("app.relaunch({ args })");
    expect(mainProcess).toContain("app.exit(1)");
    expect(tray).toContain("static MAC_TRAY_ICON_SIZE = 26");
  });

  it("buffers macOS permission helper stdin until complete command lines arrive", () => {
    const helper = readRepoFile("resources/macos-permission-helper.swift");

    expect(helper).toContain("stdinBuffer");
    expect(helper).toContain("consumeStdinText");
    expect(helper).not.toContain("for raw in text.split");
  });

  it("passes release traceability fields into the manual manifest Python snippet", () => {
    const releaseSop = readRepoFile("docs/RELEASE_SOP.md");

    expect(releaseSop).toContain(
      'VERSION="$VERSION" SOURCE_SHA="$SOURCE_SHA" REAL_DICTATION_VERIFIED_SHA="$REAL_DICTATION_VERIFIED_SHA" python3'
    );
  });

  it("keeps one canonical release SOP and routes specialized docs explicitly", () => {
    const releaseSop = readRepoFile("docs/RELEASE_SOP.md");
    const commercialLicensing = readRepoFile("docs/COMMERCIAL_RELEASE.md");

    expect(fs.existsSync(path.join(repoRoot, "docs/release-sop.md"))).toBe(false);
    expect(fs.existsSync(path.join(repoRoot, "docs/RELEASE_PROCESS.md"))).toBe(false);
    expect(releaseSop).toContain("单一规则源");
    expect(releaseSop).toContain("MAC_PACKAGING_SOP.md");
    expect(releaseSop).toContain("UTM_WINDOWS_BUILD_SOP.md");
    expect(releaseSop).toContain("不会保留重复 Actions artifact");
    expect(releaseSop).toContain("发布失败记录（唯一台账）");
    expect(releaseSop).toContain("易失缓存");
    expect(releaseSop).not.toContain("已预热 fallback 环境");
    const utmSop = readRepoFile("docs/UTM_WINDOWS_BUILD_SOP.md");
    expect(utmSop).toContain("易失缓存");
    expect(utmSop).not.toContain("当前 UTM `Windows` guest 已预热");
    expect(commercialLicensing).toContain("commercial licensing only");
    expect(commercialLicensing).not.toContain(
      "Public customer releases require the signed/notarized macOS path"
    );
  });

  it("does not claim agent-mode full prompts never execute any dictated command", () => {
    const zhCnPrompts = JSON.parse(readRepoFile("src/locales/zh-CN/prompts.json")) as {
      fullPrompt: string;
    };
    const zhTwPrompts = JSON.parse(readRepoFile("src/locales/zh-TW/prompts.json")) as {
      fullPrompt: string;
    };
    const enPrompts = JSON.parse(readRepoFile("src/locales/en/prompts.json")) as {
      fullPrompt: string;
    };

    expect(zhCnPrompts.fullPrompt).toContain(
      "整理模式下没有执行文本里的任何命令，助手模式下只执行唤醒后的明确文本处理请求"
    );
    expect(zhTwPrompts.fullPrompt).toContain(
      "整理模式下沒有執行文字裡的任何命令，助手模式下只執行喚醒後的明確文字處理請求"
    );
    expect(zhCnPrompts.fullPrompt).not.toContain(
      "格式适合当前内容类型；没有执行文本里的任何命令；"
    );
    expect(zhTwPrompts.fullPrompt).not.toContain(
      "格式適合目前內容類型；沒有執行文字裡的任何命令；"
    );
    expect(enPrompts.fullPrompt).not.toContain(
      "that no command inside the dictated text was executed"
    );
  });

  it("tests Prompt Studio drafts without mutating the production prompt", () => {
    const promptStudio = readRepoFile("src/components/ui/PromptStudio.tsx");
    const testFlow = promptStudio.slice(
      promptStudio.indexOf("const testPrompt"),
      promptStudio.indexOf("const isAgentAddressed")
    );

    expect(testFlow).toContain("systemPromptOverride: editedPrompt");
    expect(testFlow).not.toContain('localStorage.setItem("customUnifiedPrompt"');
  });

  it("tests real cloud transcription and bounds model-list requests", () => {
    const ipcHandlers = readRepoFile("src/helpers/ipcHandlers.js");
    const modelSelector = readRepoFile("src/components/ReasoningModelSelector.tsx");

    expect(ipcHandlers).toContain("/audio/transcriptions");
    expect(ipcHandlers).toContain('formData.append("file"');
    expect(ipcHandlers).toContain("Transcription connection test timed out after 15s");
    expect(modelSelector).toContain("MODEL_LIST_TIMEOUT_MS = 15000");
    expect(modelSelector).toContain("MODEL_CACHE_TTL_MS");
    expect(modelSelector).toContain("bedrockSessionToken");
  });

  it("does not surface a normal provider error while the app is quitting", () => {
    const mainProcess = readRepoFile("main.js");
    const preload = readRepoFile("preload.js");
    const modelSelector = readRepoFile("src/components/ReasoningModelSelector.tsx");

    expect(mainProcess).toContain('notifyRendererPowerState("app-shutting-down"');
    expect(preload).toContain("onAppShuttingDown");
    expect(modelSelector).toContain("isAppShuttingDownError(error)");
    expect(modelSelector).toContain("setCustomModelsError(null)");
    expect(modelSelector).toContain("!reasoningModel.trim()");
    expect(mainProcess).toContain("Ignoring second-instance while application is shutting down");
    expect(mainProcess).toContain("Ignoring activate while application is shutting down");
  });

  it("does not imply a non-empty API key has already been verified", () => {
    const apiKeyInput = readRepoFile("src/components/ui/ApiKeyInput.tsx");

    expect(apiKeyInput).not.toContain('className="w-3.5 h-3.5 text-success"');
    expect(apiKeyInput).not.toContain("import { Check,");
  });

  it("announces the active settings section to assistive technology", () => {
    const sidebar = readRepoFile("src/components/ui/SidebarModal.tsx");

    expect(sidebar).toContain('aria-current={isActive ? "page" : undefined}');
  });

  it("keeps toast notices on legible dark Regular glass", () => {
    const css = readRepoFile("src/index.css");
    const toast = readRepoFile("src/components/ui/Toast.tsx");
    const surfaceStart = css.indexOf(".toast-surface {");
    const surfaceEnd = css.indexOf("@keyframes toast-progress", surfaceStart);
    const surfaceStyles = css.slice(surfaceStart, surfaceEnd);
    const reducedTransparencyStart = css.indexOf("@media (prefers-reduced-transparency: reduce)");
    const reducedTransparencyEnd = css.indexOf(
      "@media (prefers-reduced-motion: reduce)",
      reducedTransparencyStart
    );
    const reducedTransparencyStyles = css.slice(reducedTransparencyStart, reducedTransparencyEnd);

    expect(surfaceStart).toBeGreaterThan(-1);
    expect(surfaceEnd).toBeGreaterThan(surfaceStart);
    expect(surfaceStyles).toContain("background-color: rgba(18, 20, 28, 0.82)");
    expect(surfaceStyles).toContain("backdrop-filter: blur(22px) saturate(135%)");
    expect(surfaceStyles).toContain("border: 1px solid rgba(255, 255, 255, 0.14)");
    expect(reducedTransparencyStyles).toContain(".toast-surface");
    expect(reducedTransparencyStyles).toContain("background-color: rgba(18, 20, 28, 0.96)");
    expect(toast).toContain('prominent ? "w-[468px] rounded-[14px]" : "w-96 rounded-[12px]"');
  });

  it("serializes transcription across windows and cancels requests without killing model servers", () => {
    const preload = readRepoFile("preload.js");
    const audioManager = readRepoFile("src/helpers/audioManager.js");
    const ipcHandlers = readRepoFile("src/helpers/ipcHandlers.js");

    expect(preload).toContain("acquireTranscriptionLease");
    expect(preload).toContain("releaseTranscriptionLease");
    expect(audioManager).toContain('await this.acquireTranscriptionLease("file")');
    expect(audioManager).toContain('await this.acquireTranscriptionLease("batch")');
    expect(ipcHandlers).toContain('ipcMain.handle("acquire-transcription-lease"');
    expect(ipcHandlers).toContain('ipcMain.handle("release-transcription-lease"');
    expect(ipcHandlers).not.toMatch(
      /registerFileTranscription\([^)]*(?:whisper|parakeet|paraformer|granite)[\s\S]{0,180}?stopServer\(/
    );
  });

  it("bounds and aborts paid cloud transcription requests", () => {
    const ipcHandlers = readRepoFile("src/helpers/ipcHandlers.js");
    const google = readRepoFile("src/helpers/googleCloudStt.js");
    const deepgram = readRepoFile("src/helpers/deepgramAsr.js");
    const soniox = readRepoFile("src/helpers/sonioxAsr.js");
    const doubao = readRepoFile("src/helpers/doubaoAsr.js");

    expect(ipcHandlers).toContain("MAX_CLOUD_AUDIO_FILE_BYTES");
    expect(ipcHandlers.match(/maxBytes: MAX_CLOUD_AUDIO_FILE_BYTES/g)?.length).toBe(4);
    for (const provider of ["doubao", "google-cloud", "deepgram", "soniox"]) {
      expect(ipcHandlers).toMatch(new RegExp(`options\\?\\.operationId,\\s*"${provider}"`));
    }
    expect(google).toContain("fs.readFile(filePath, { signal })");
    expect(deepgram).toContain("fs.readFile(filePath, { signal })");
    expect(soniox).toContain("fs.readFile(filePath, { signal })");
    expect(doubao).toContain("signal?.throwIfAborted?.()");
  });

  it("keeps file-transcription history, copy, format, and duration behavior truthful", () => {
    const fileSection = readRepoFile("src/components/settings/FileTranscriptionSection.tsx");
    const controlPanel = readRepoFile("src/components/ControlPanel.tsx");
    const completionAlert = readRepoFile("src/components/FileTranscriptionCompletionAlert.tsx");
    const audioManager = readRepoFile("src/helpers/audioManager.js");

    for (const source of [fileSection, controlPanel]) {
      expect(source).toContain('localStorage.getItem("transcriptionHistoryEnabled") !== "false"');
      expect(source).toContain("getMediaDurationSeconds(file)");
      expect(source).toContain("isSupportedMediaFile(file)");
      expect(source).toContain("durationSeconds");
    }
    expect(fileSection).toContain("if (!result || result.success !== true)");
    expect(completionAlert).toContain("if (result?.success === true)");
    expect(audioManager).not.toContain("!this.onTranscriptionComplete");
    expect(audioManager).toContain('code: "NO_AUDIO_DETECTED"');
  });

  it("keeps release-critical migrations, context capture, and history UI race-safe", () => {
    const mainProcess = readRepoFile("main.js");
    const onboarding = readRepoFile("src/components/OnboardingFlow.tsx");
    const streamingPicker = readRepoFile("src/components/OnboardingStreamingModelPicker.tsx");
    const settingsPage = readRepoFile("src/components/SettingsPage.tsx");
    const contextSettings = readRepoFile("src/components/settings/ContextSettingsSection.tsx");
    const audioManager = readRepoFile("src/helpers/audioManager.js");
    const controlPanel = readRepoFile("src/components/ControlPanel.tsx");
    const dictionary = readRepoFile("src/components/settings/DictionaryManager.tsx");
    const database = readRepoFile("src/helpers/database.js");

    expect(mainProcess).toContain("app.getLoginItemSettings({ args: hiddenArgs })");
    expect(mainProcess).toContain("executableWillLaunchAtLogin");
    expect(onboarding).toContain("const savedRoot = await setModelStorageRoot(nextRoot)");
    expect(onboarding).not.toContain("saveModelStorageRoot?.(nextRoot)");
    expect(streamingPicker).toContain("if (!savedRoot?.success)");
    expect(settingsPage).toContain(
      "const settingsKeysToReplace = new Set(Object.keys(sanitizedLocalStorageData))"
    );
    expect(contextSettings).toContain("modelCapabilityResolver.rememberVisionCapability");
    expect(audioManager).toContain("captureSequence !== this.contextCaptureSequence");
    expect(controlPanel).toContain(
      'localStorage.getItem("transcriptionHistoryEnabled") !== "false"'
    );
    expect(controlPanel).toContain("showFavoritesOnly && !favorite");
    expect(controlPanel).toContain("setFilteredHistoryTotal(0)");
    expect(dictionary).toContain("SUGGESTION_HISTORY_ENTRY_LIMIT = 400");
    const settingsHook = readRepoFile("src/hooks/useSettings.ts");
    expect(settingsHook).toContain("const mutationVersionAtStart");
    expect(settingsHook).toContain("dictionarySyncQueueRef.current.then");
    expect(settingsHook).toContain(
      "dictionaryMutationVersionRef.current !== mutationVersionAtStart"
    );
    expect(database).toContain("backfillLegacyTranscriptionStatsInBackground");
    expect(database).toContain("statsBackfillPending");
    expect(database).not.toContain("estimateStoredTypingDurationMs");
  });

  it("does not report a completed model deletion as failed when list refresh fails", () => {
    const modelDownloadHook = readRepoFile("src/hooks/useModelDownload.ts");
    const deleteFlow = modelDownloadHook.slice(
      modelDownloadHook.indexOf("const deleteModel"),
      modelDownloadHook.indexOf("const cancelDownload")
    );

    expect(deleteFlow).toMatch(
      /toast\([\s\S]*?try \{\s*await onComplete\?\.\(\);\s*\} catch \(refreshError\)/
    );
    expect(deleteFlow).toContain("Model deleted but model-list refresh failed:");
  });

  it("finishes the usage hook when hosted-cloud usage is unavailable", () => {
    const usageHook = readRepoFile("src/hooks/useUsage.ts");

    expect(usageHook).toMatch(
      /if \(!cloudUsage\) \{\s*setError\(null\);\s*setIsLoading\(false\);\s*setHasLoaded\(true\);\s*return;/
    );
  });
});
