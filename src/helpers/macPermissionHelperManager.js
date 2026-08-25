const { spawn } = require("child_process");
const path = require("path");
const EventEmitter = require("events");
const fs = require("fs");

const BINARY_NAME = "macos-permission-helper";

/**
 * Spawns and supervises the native macOS drag-to-grant permission helper
 * (resources/macos-permission-helper.swift -> resources/bin/macos-permission-helper).
 *
 * The native helper renders a nonactivating NSPanel guide card whose draggable
 * app-icon chip can be dropped straight into the System Settings permission list.
 * A native panel receives the click that starts the drag (and the panel
 * clicks) even while System Settings is the key app — the exact thing the old
 * Electron transparent/showInactive() panel could not do.
 *
 * Protocol (helper stdout): READY, CLOSED.
 * Commands (helper stdin):  GRANTED (success flash then exit), CLOSE (exit).
 * The helper also self-destructs on stdin EOF (parent died) or getppid()==1.
 */
class MacPermissionHelperManager extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.isSupported = process.platform === "darwin";
  }

  isRunning() {
    return Boolean(this.process);
  }

  /**
   * Spawn the helper. Returns true if it started, false if the binary is
   * missing/unusable (caller should fall back to the BrowserWindow helper).
   */
  start(options = {}) {
    if (!this.isSupported) return false;
    if (this.process) {
      // Already showing — refresh by restarting so new strings/bundle apply.
      this.stop();
    }

    const binaryPath = this.resolveBinary();
    if (!binaryPath) return false;

    try {
      fs.accessSync(binaryPath, fs.constants.X_OK);
    } catch {
      try {
        fs.chmodSync(binaryPath, 0o755);
      } catch {
        return false;
      }
    }

    const args = [
      "--kind",
      options.kind === "screenRecording" ? "screenRecording" : "accessibility",
      "--bundle",
      String(options.bundlePath || ""),
      "--app-name",
      String(options.appName || "ChordVox"),
      "--title",
      String(options.title || ""),
      "--description",
      String(options.description || ""),
      "--drag-hint",
      String(options.dragHint || ""),
      "--unavailable-label",
      String(options.unavailableLabel || ""),
      "--reveal-label",
      String(options.revealLabel || ""),
      "--close-label",
      String(options.closeLabel || ""),
      "--granted-label",
      String(options.grantedLabel || ""),
      "--can-drag",
      options.canDrag ? "1" : "0",
    ];

    try {
      // argv array (no shell) — option strings cannot inject commands.
      this.process = spawn(binaryPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      this.process = null;
      console.error("MacPermissionHelperManager spawn failed:", error);
      return false;
    }

    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => {
      chunk
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach((line) => {
          if (line === "READY") {
            this.emit("ready");
          } else if (line === "CLOSED") {
            this.emit("closed");
          }
        });
    });

    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (data) => {
      const message = data.toString().trim();
      if (message.length > 0) {
        console.error("MacPermissionHelperManager stderr:", message);
      }
    });

    this.process.on("error", (error) => {
      console.error("MacPermissionHelperManager error:", error);
      this.process = null;
      this.emit("exit");
    });

    this.process.on("exit", () => {
      this.process = null;
      this.emit("exit");
    });

    return true;
  }

  /** Tell the helper the permission was granted: success flash, then it exits. */
  signalGranted() {
    this.#writeCommand("GRANTED");
  }

  /** Ask the helper to close itself (mirrors a user ×). */
  signalClose() {
    this.#writeCommand("CLOSE");
  }

  #writeCommand(command) {
    if (!this.process || !this.process.stdin || this.process.stdin.destroyed) {
      return;
    }
    try {
      this.process.stdin.write(`${command}\n`);
    } catch (error) {
      console.error("MacPermissionHelperManager write failed:", error);
    }
  }

  stop() {
    if (this.process) {
      const child = this.process;
      // Null first + detach listeners so a restart's old-child exit can't clobber
      // the new process or emit a spurious "exit".
      this.process = null;
      try {
        child.removeAllListeners("exit");
        child.removeAllListeners("error");
        child.kill();
      } catch {
        // ignore
      }
    }
  }

  resolveBinary() {
    const candidates = new Set([
      path.join(__dirname, "..", "..", "resources", "bin", BINARY_NAME),
      path.join(__dirname, "..", "..", "resources", BINARY_NAME),
    ]);

    if (process.resourcesPath) {
      [
        path.join(process.resourcesPath, BINARY_NAME),
        path.join(process.resourcesPath, "bin", BINARY_NAME),
        path.join(process.resourcesPath, "resources", BINARY_NAME),
        path.join(process.resourcesPath, "resources", "bin", BINARY_NAME),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", BINARY_NAME),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", "bin", BINARY_NAME),
      ].forEach((candidate) => candidates.add(candidate));
    }

    for (const candidate of [...candidates]) {
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        continue;
      }
    }

    return null;
  }
}

module.exports = MacPermissionHelperManager;
