const { app } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const fsPromises = require("fs/promises");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { pipeline } = require("stream/promises");
const unzipper = require("unzipper");
const debugLogger = require("./debugLogger");
const { cleanupStaleDownloads, checkDiskSpace, createDownloadSignal } = require("./downloadUtils");
const {
  buildDownloadSources,
  downloadArtifactFromSources,
  validateDownloadedArtifact,
} = require("./modelDownloadSources");
const {
  computeFloat32RMS,
  convertToWav,
  isWavFormat,
  wavToFloat32Samples,
} = require("./ffmpegUtils");
const { getSafeTempDir } = require("./safeTempDir");
const { getModelsDirForService } = require("./modelDirUtils");
const { extractTarArchiveSafe } = require("./archiveSecurity");
const { resolveInsideDirectory } = require("./pathSecurity");
const {
  appendBoundedOutput,
  findAvailablePort,
  gracefulStopProcess,
  isPortInUseError,
  summarizeStartupFailure,
} = require("../utils/serverUtils");
const { transcribeExternalAsrRuntime } = require("./externalAsrRuntime");

const modelRegistryData = require("../models/modelRegistryData.json");

const DEFAULT_MODEL_NAME = "granite-4.0-1b-speech";
const HF_REPO_ID = "ibm-granite/granite-4.0-1b-speech";
const SERVER_HOST = "127.0.0.1";
const PORT_RANGE_START = 6130;
const PORT_RANGE_END = 6169;
const STARTUP_PORT_RETRY_LIMIT = 5;
const STARTUP_TIMEOUT_MS = 10 * 60 * 1000;
const HEALTH_CHECK_TIMEOUT_MS = 2000;
const HEALTH_CHECK_INTERVAL_MS = 5000;
const HEALTH_CHECK_FAILURE_THRESHOLD = 3;
const TRANSCRIPTION_TIMEOUT_MS = 10 * 60 * 1000;
const SILENCE_RMS_THRESHOLD = 0.001;

function createAbortError(message = "Granite runtime startup cancelled") {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "ERR_LOCAL_TRANSCRIPTION_CANCELLED";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError();
}
const RUNTIME_DIR_NAME = "granite-runtime";
const VENV_DIR_NAME = "python";
const SERVER_SCRIPT_NAME = "granite_server.py";
const UV_BIN_DIR_NAME = "uv-bin";
const UV_PYTHON_DIR_NAME = "uv-python";
const UV_CACHE_DIR_NAME = "uv-cache";
const MANAGED_PYTHON_VERSION = "3.12";
const UV_VERSION = "0.11.4";
const UV_RELEASE_BASE_URL = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;
const UV_ASSETS = {
  "darwin-arm64": {
    fileName: "uv-aarch64-apple-darwin.tar.gz",
    sha256: "9b9cb6c6f58c3246dbf3351ed4e97c500bc3266f5f237d2fd620b66e1c31dc56",
  },
  "darwin-x64": {
    fileName: "uv-x86_64-apple-darwin.tar.gz",
    sha256: "c326edaf3fd492f53d1c58777f3459c0d87bf9dae8d89e80aec4b0da6622dcf3",
  },
  "win32-arm64": {
    fileName: "uv-aarch64-pc-windows-msvc.zip",
    sha256: "708b1c210109e50ff520bcd9b6d29cbd8cee584bb55e84d3d1941bf75ab0893d",
  },
  "win32-x64": {
    fileName: "uv-x86_64-pc-windows-msvc.zip",
    sha256: "26d84455a40b0272b2ab4785cad298ff2c89cd0765b482e9f85b5a1bd880a863",
  },
  "linux-arm64": {
    fileName: "uv-aarch64-unknown-linux-gnu.tar.gz",
    sha256: "f5aa91bba0b98d85a4e5262e2847f9ab2273c754f6374dff62b37ef18c65a2e7",
  },
  "linux-x64": {
    fileName: "uv-x86_64-unknown-linux-gnu.tar.gz",
    sha256: "12f9a192bb32d70470aa22cbd2a193d1323a3f58f6ac5f9e3866aaca760c98c6",
  },
};

const PIP_PACKAGES = [
  "torch==2.7.1",
  "torchaudio==2.7.1",
  "transformers==4.52.4",
  "accelerate==1.8.1",
  "soundfile==0.13.1",
  "huggingface_hub==0.33.2",
  "numpy==2.2.6",
];

const PYTHON_MODULES = ["torch", "torchaudio", "transformers", "soundfile", "huggingface_hub"];

const GRANITE_SERVER_SCRIPT = String.raw`#!/usr/bin/env python3
import argparse
import json
import os
import sys
import tempfile
import traceback
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


MAX_REQUEST_BYTES = 250 * 1024 * 1024


def write_json(handler, status, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def parse_multipart(headers, body):
    content_type = headers.get("Content-Type", "")
    if "multipart/form-data" not in content_type:
        raise ValueError("Expected multipart/form-data")

    message = BytesParser(policy=policy.default).parsebytes(
        b"Content-Type: " + content_type.encode("utf-8") + b"\r\n"
        + b"MIME-Version: 1.0\r\n\r\n"
        + body
    )
    fields = {}
    files = {}
    for part in message.iter_parts():
        disposition = part.get("Content-Disposition", "")
        if "form-data" not in disposition:
            continue
        name = part.get_param("name", header="content-disposition")
        filename = part.get_param("filename", header="content-disposition")
        payload = part.get_payload(decode=True) or b""
        if filename:
            files[name or "file"] = {
                "filename": filename,
                "content_type": part.get_content_type(),
                "content": payload,
            }
        elif name:
            fields[name] = payload.decode("utf-8", errors="replace")
    return fields, files


class GraniteEngine:
    def __init__(self, model_dir, model_id):
        self.model_dir = model_dir
        self.model_id = model_id
        self.loaded = False
        self.device = "cpu"
        self.dtype_name = "float32"
        self.torch = None
        self.torchaudio = None
        self.processor = None
        self.tokenizer = None
        self.model = None

    def load(self):
        import torch
        import torchaudio
        from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor

        if torch.cuda.is_available():
            self.device = "cuda"
            dtype = torch.bfloat16
            self.dtype_name = "bfloat16"
        elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            self.device = "mps"
            dtype = torch.float16
            self.dtype_name = "float16"
        else:
            self.device = "cpu"
            dtype = torch.float32
            self.dtype_name = "float32"

        self.processor = AutoProcessor.from_pretrained(self.model_dir)
        self.tokenizer = self.processor.tokenizer
        self.model = AutoModelForSpeechSeq2Seq.from_pretrained(
            self.model_dir,
            torch_dtype=dtype,
            low_cpu_mem_usage=True,
        )
        self.model.to(self.device)
        self.model.eval()
        self.torch = torch
        self.torchaudio = torchaudio
        self.loaded = True

    def transcribe(self, audio_bytes, filename, prompt="", max_new_tokens=200):
        if not self.loaded:
            raise RuntimeError("Model is not loaded")

        suffix = os.path.splitext(filename or "audio.wav")[1] or ".wav"
        with tempfile.NamedTemporaryFile(prefix="chordvox-granite-", suffix=suffix, delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name

        try:
            wav, sr = self.torchaudio.load(tmp_path, normalize=True)
            if wav.shape[0] > 1:
                wav = wav.mean(dim=0, keepdim=True)
            if sr != 16000:
                wav = self.torchaudio.transforms.Resample(orig_freq=sr, new_freq=16000)(wav)

            question = "can you transcribe the speech into a written format?"
            cleaned_prompt = str(prompt or "").strip()
            if cleaned_prompt:
                question = question + " Keywords: " + cleaned_prompt[:1000]

            chat = [{"role": "user", "content": "<|audio|>" + question}]
            text_prompt = self.tokenizer.apply_chat_template(
                chat,
                tokenize=False,
                add_generation_prompt=True,
            )
            model_inputs = self.processor(
                text_prompt,
                wav,
                device=self.device,
                return_tensors="pt",
            ).to(self.device)

            with self.torch.inference_mode():
                model_outputs = self.model.generate(
                    **model_inputs,
                    max_new_tokens=max_new_tokens,
                    do_sample=False,
                    num_beams=1,
                )

            num_input_tokens = model_inputs["input_ids"].shape[-1]
            new_tokens = model_outputs[0, num_input_tokens:].unsqueeze(0)
            output_text = self.tokenizer.batch_decode(
                new_tokens,
                add_special_tokens=False,
                skip_special_tokens=True,
            )
            return (output_text[0] if output_text else "").strip()
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def build_handler(engine):
    class GraniteHandler(BaseHTTPRequestHandler):
        server_version = "ChordVoxGranite/1.0"

        def log_message(self, fmt, *args):
            sys.stderr.write("[granite-server] " + (fmt % args) + "\n")
            sys.stderr.flush()

        def do_GET(self):
            if self.path == "/health":
                write_json(self, 200, {
                    "ok": True,
                    "model": engine.model_id,
                    "device": engine.device,
                    "dtype": engine.dtype_name,
                })
                return
            if self.path in ("/v1/models", "/models"):
                write_json(self, 200, {
                    "object": "list",
                    "data": [
                        {"id": engine.model_id, "object": "model"},
                        {"id": "ibm-granite/granite-4.0-1b-speech", "object": "model"},
                    ],
                })
                return
            write_json(self, 404, {"error": {"message": "Not found"}})

        def do_HEAD(self):
            if self.path in ("/v1/audio/transcriptions", "/audio/transcriptions"):
                self.send_response(405)
                self.send_header("Allow", "POST")
                self.end_headers()
                return
            self.send_response(404)
            self.end_headers()

        def do_POST(self):
            if self.path not in ("/v1/audio/transcriptions", "/audio/transcriptions"):
                write_json(self, 404, {"error": {"message": "Not found"}})
                return

            try:
                content_length = int(self.headers.get("Content-Length", "0") or "0")
            except ValueError:
                write_json(self, 400, {"error": {"message": "Invalid Content-Length"}})
                return

            if content_length <= 0:
                write_json(self, 400, {"error": {"message": "No audio uploaded"}})
                return
            if content_length > MAX_REQUEST_BYTES:
                write_json(self, 413, {"error": {"message": "Audio upload is too large"}})
                return

            try:
                body = self.rfile.read(content_length)
                fields, files = parse_multipart(self.headers, body)
                uploaded = files.get("file") or next(iter(files.values()), None)
                if not uploaded or not uploaded.get("content"):
                    write_json(self, 400, {"error": {"message": "No audio file in request"}})
                    return

                max_new_tokens = 200
                try:
                    max_new_tokens = max(16, min(int(fields.get("max_new_tokens", "200")), 512))
                except ValueError:
                    pass

                text = engine.transcribe(
                    uploaded["content"],
                    uploaded.get("filename", "audio.wav"),
                    prompt=fields.get("prompt", ""),
                    max_new_tokens=max_new_tokens,
                )
                write_json(self, 200, {"text": text, "model": engine.model_id})
            except Exception as exc:
                traceback.print_exc()
                write_json(self, 500, {"error": {"message": str(exc)}})

    return GraniteHandler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--model-id", default="granite-4.0-1b-speech")
    args = parser.parse_args()

    engine = GraniteEngine(args.model_dir, args.model_id)
    print(json.dumps({"event": "loading", "model": args.model_id}), flush=True)
    engine.load()
    print(json.dumps({"event": "loaded", "model": args.model_id, "device": engine.device}), flush=True)

    server = ThreadingHTTPServer((args.host, args.port), build_handler(engine))
    print(json.dumps({"event": "ready", "host": args.host, "port": args.port}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
`;

function getGraniteModelConfig(modelName) {
  return modelRegistryData.graniteModels[modelName] || null;
}

function getValidModelNames() {
  return Object.keys(modelRegistryData.graniteModels || {});
}

function toBuffer(audioBlob) {
  if (Buffer.isBuffer(audioBlob)) return audioBlob;
  if (audioBlob instanceof ArrayBuffer) return Buffer.from(audioBlob);
  if (ArrayBuffer.isView(audioBlob)) {
    return Buffer.from(audioBlob.buffer, audioBlob.byteOffset, audioBlob.byteLength);
  }
  if (audioBlob && audioBlob.buffer && typeof audioBlob.byteLength === "number") {
    return Buffer.from(audioBlob.buffer, audioBlob.byteOffset || 0, audioBlob.byteLength);
  }
  if (typeof audioBlob === "string") return Buffer.from(audioBlob, "base64");
  return Buffer.from([]);
}

function formatModuleList(modules) {
  return modules.length > 0 ? modules.join(", ") : "";
}

function createDownloadCancelledError() {
  return Object.assign(new Error("Download cancelled by user"), {
    code: "DOWNLOAD_CANCELLED",
    isAbort: true,
  });
}

function throwIfDownloadAborted(signal) {
  if (signal?.aborted) {
    throw createDownloadCancelledError();
  }
}

function isPythonVersionSupported(version) {
  if (!version) return false;
  return version.major > 3 || (version.major === 3 && version.minor >= 11);
}

class GraniteRuntimeManager {
  constructor() {
    this.currentDownloadProcess = null;
    this.process = null;
    this.port = null;
    this.ready = false;
    this.modelName = null;
    this.startupPromise = null;
    this.healthCheckInterval = null;
    this.healthCheckFailures = 0;
    this.lastEndpoint = "";
  }

  getRuntimeRoot() {
    return path.join(app.getPath("userData"), RUNTIME_DIR_NAME);
  }

  getVenvDir() {
    return path.join(this.getRuntimeRoot(), VENV_DIR_NAME);
  }

  getVenvPythonPath() {
    return process.platform === "win32"
      ? path.join(this.getVenvDir(), "Scripts", "python.exe")
      : path.join(this.getVenvDir(), "bin", "python");
  }

  getManagedUvDir() {
    return path.join(this.getRuntimeRoot(), UV_BIN_DIR_NAME);
  }

  getManagedUvPath() {
    return process.platform === "win32"
      ? path.join(this.getManagedUvDir(), "uv.exe")
      : path.join(this.getManagedUvDir(), "uv");
  }

  getUvPythonInstallDir() {
    return path.join(this.getRuntimeRoot(), UV_PYTHON_DIR_NAME);
  }

  getUvCacheDir() {
    return path.join(this.getRuntimeRoot(), UV_CACHE_DIR_NAME);
  }

  getServerScriptPath() {
    return path.join(this.getRuntimeRoot(), SERVER_SCRIPT_NAME);
  }

  getModelsDir() {
    return getModelsDirForService("granite");
  }

  getHfCacheDir() {
    return path.join(this.getRuntimeRoot(), "hf-cache");
  }

  getModelPath(modelName = DEFAULT_MODEL_NAME) {
    this.validateModelName(modelName);
    return path.join(this.getModelsDir(), modelName);
  }

  validateModelName(modelName) {
    const validModels = getValidModelNames();
    if (!validModels.includes(modelName)) {
      throw new Error(
        `Invalid Granite model: ${modelName}. Valid models: ${validModels.join(", ")}`
      );
    }
    return true;
  }

  async ensureRuntimeFiles() {
    await fsPromises.mkdir(this.getRuntimeRoot(), { recursive: true });
    await fsPromises.writeFile(this.getServerScriptPath(), GRANITE_SERVER_SCRIPT, {
      encoding: "utf8",
      mode: 0o755,
    });
  }

  async initializeAtStartup(settings = {}) {
    try {
      await cleanupStaleDownloads(this.getModelsDir());
      await this.ensureRuntimeFiles();

      if (settings.localTranscriptionProvider === "granite" && settings.graniteModel) {
        const runtime = await this.checkInstallation();
        const model = await this.checkModelStatus(settings.graniteModel);
        if (runtime.working && model.downloaded) {
          this.startServer(settings.graniteModel).catch((error) => {
            debugLogger.warn("Granite pre-warm failed (will start on first use)", {
              error: error.message,
              model: settings.graniteModel,
            });
          });
        }
      }
    } catch (error) {
      debugLogger.warn("Granite startup initialization skipped", { error: error.message });
    }
  }

  async runProcess(command, args = [], options = {}) {
    const {
      timeoutMs = 30000,
      env = process.env,
      cwd = this.getRuntimeRoot(),
      signal = null,
    } = options;
    throwIfDownloadAborted(signal);

    return await new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;

      const child = spawn(command, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      const clearAbortHandler = () => {
        if (signal?.onAbort === handleAbort) {
          signal.onAbort = null;
        }
      };

      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearAbortHandler();
        callback();
      };

      function handleAbort() {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearAbortHandler();
        gracefulStopProcess(child)
          .catch(() => {})
          .finally(() => reject(createDownloadCancelledError()));
      }

      const timeout = setTimeout(() => {
        finish(() => {
          gracefulStopProcess(child).catch(() => {});
          const error = new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s`);
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        });
      }, timeoutMs);

      if (signal) {
        signal.onAbort = handleAbort;
        if (signal.aborted) handleAbort();
      }

      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });
      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      child.on("error", (error) => {
        finish(() => {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        });
      });
      child.on("close", (code) => {
        finish(() => {
          if (code === 0) {
            resolve({ stdout, stderr, code });
            return;
          }
          const error = new Error(
            stderr.trim() || stdout.trim() || `Command exited with code ${code}`
          );
          error.stdout = stdout;
          error.stderr = stderr;
          error.code = code;
          reject(error);
        });
      });
    });
  }

  getPythonCandidates() {
    const candidates = [
      process.env.CHORDVOX_GRANITE_PYTHON,
      process.env.PYTHON3,
      "python3.12",
      "python3.11",
      "python3",
      "python",
    ];

    if (process.platform === "darwin") {
      candidates.push(
        "/opt/homebrew/bin/python3.12",
        "/opt/homebrew/bin/python3.11",
        "/usr/local/bin/python3.12",
        "/usr/local/bin/python3.11",
        "/usr/bin/python3"
      );
    } else if (process.platform === "win32") {
      candidates.push(
        { command: "py", args: ["-3.12"] },
        { command: "py", args: ["-3.11"] },
        "py",
        "python3.12.exe",
        "python3.11.exe",
        "python.exe"
      );

      const addWindowsPythonPaths = (baseDir) => {
        if (!baseDir) return;
        candidates.push(
          path.join(baseDir, "Programs", "Python", "Python312", "python.exe"),
          path.join(baseDir, "Programs", "Python", "Python311", "python.exe"),
          path.join(baseDir, "Python312", "python.exe"),
          path.join(baseDir, "Python311", "python.exe")
        );
      };

      addWindowsPythonPaths(process.env.LOCALAPPDATA);
      addWindowsPythonPaths(process.env.ProgramFiles);
      addWindowsPythonPaths(process.env["ProgramFiles(x86)"]);
    } else if (process.platform === "linux") {
      candidates.push(
        "/usr/local/bin/python3.12",
        "/usr/local/bin/python3.11",
        "/usr/bin/python3.12",
        "/usr/bin/python3.11",
        "/usr/bin/python3"
      );
    }

    const seen = new Set();
    return candidates.filter(Boolean).filter((candidate) => {
      const key =
        typeof candidate === "string"
          ? candidate
          : `${candidate.command} ${(candidate.args || []).join(" ")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async probePython(candidate, options = {}) {
    const command = typeof candidate === "string" ? candidate : candidate.command;
    const argsPrefix = typeof candidate === "string" ? [] : candidate.args || [];
    const commandLabel = [command, ...argsPrefix].join(" ");

    try {
      const result = await this.runProcess(
        command,
        [
          ...argsPrefix,
          "-c",
          "import json,sys; print(json.dumps({'executable':sys.executable,'major':sys.version_info.major,'minor':sys.version_info.minor,'micro':sys.version_info.micro}))",
        ],
        { timeoutMs: 5000, cwd: os.tmpdir(), signal: options.signal }
      );
      const parsed = JSON.parse(result.stdout.trim());
      return {
        command: commandLabel,
        executable: parsed.executable,
        version: { major: parsed.major, minor: parsed.minor, micro: parsed.micro },
        supported: isPythonVersionSupported(parsed),
      };
    } catch {
      return null;
    }
  }

  async findPython(options = {}) {
    for (const candidate of this.getPythonCandidates()) {
      throwIfDownloadAborted(options.signal);
      const probe = await this.probePython(candidate, options);
      if (probe?.supported) return probe;
    }

    for (const candidate of this.getPythonCandidates()) {
      throwIfDownloadAborted(options.signal);
      const probe = await this.probePython(candidate, options);
      if (probe) return probe;
    }

    return null;
  }

  buildUvEnv() {
    return {
      ...process.env,
      UV_NO_MODIFY_PATH: "1",
      UV_UNMANAGED_INSTALL: this.getManagedUvDir(),
      UV_CACHE_DIR: this.getUvCacheDir(),
      UV_PYTHON_INSTALL_DIR: this.getUvPythonInstallDir(),
      UV_PYTHON_BIN_DIR: path.join(this.getRuntimeRoot(), "uv-python-bin"),
      UV_PYTHON_INSTALL_REGISTRY: "0",
    };
  }

  async probeUv(command, options = {}) {
    try {
      const result = await this.runProcess(command, ["--version"], {
        timeoutMs: 5000,
        env: this.buildUvEnv(),
        signal: options.signal,
      });
      return {
        command,
        version: result.stdout.trim() || result.stderr.trim(),
      };
    } catch {
      return null;
    }
  }

  async findUv(options = {}) {
    const includeSystem = options.includeSystem !== false;
    const managedUv = this.getManagedUvPath();
    const candidates = includeSystem ? [managedUv, "uv"] : [managedUv];
    for (const candidate of candidates) {
      throwIfDownloadAborted(options.signal);
      const probe = await this.probeUv(candidate, options);
      if (probe) return probe;
    }
    return null;
  }

  isExpectedManagedUv(probe) {
    return Boolean(probe?.version && probe.version.trim().startsWith(`uv ${UV_VERSION}`));
  }

  getUvAsset() {
    const key = `${process.platform}-${process.arch}`;
    const asset = UV_ASSETS[key];
    if (!asset) {
      throw new Error(
        `Granite managed runtime does not support uv for ${process.platform}/${process.arch}.`
      );
    }
    return {
      ...asset,
      url: `${UV_RELEASE_BASE_URL}/${asset.fileName}`,
      archivePath: path.join(this.getRuntimeRoot(), asset.fileName),
    };
  }

  async hashFileSha256(filePath) {
    const hash = crypto.createHash("sha256");
    await pipeline(fs.createReadStream(filePath), hash);
    return hash.digest("hex");
  }

  async downloadVerifiedUvArchive(progressCallback = null, options = {}) {
    throwIfDownloadAborted(options.signal);
    const asset = this.getUvAsset();
    progressCallback?.({ type: "installing", model: DEFAULT_MODEL_NAME, percentage: 8 });

    await downloadArtifactFromSources({
      artifactLabel: asset.fileName,
      modelId: DEFAULT_MODEL_NAME,
      destination: asset.archivePath,
      sources: buildDownloadSources(
        {
          primaryUrl: asset.url,
          mirrorPath: path.posix.join("runtime", "uv", UV_VERSION, asset.fileName),
        },
        options
      ),
      sha256: asset.sha256,
      strictSize: false,
      timeout: 600000,
      progressCallback,
      signal: options.signal,
    });

    throwIfDownloadAborted(options.signal);
    const actualSha256 = await this.hashFileSha256(asset.archivePath);
    throwIfDownloadAborted(options.signal);
    if (actualSha256.toLowerCase() !== asset.sha256.toLowerCase()) {
      await fsPromises.unlink(asset.archivePath).catch(() => {});
      throw new Error(
        `uv archive checksum mismatch for ${asset.fileName}: expected ${asset.sha256}, got ${actualSha256}`
      );
    }

    return asset;
  }

  async findExtractedUvBinary(rootDir) {
    const expectedName = process.platform === "win32" ? "uv.exe" : "uv";
    const stack = [rootDir];

    while (stack.length > 0) {
      const current = stack.pop();
      const entries = await fsPromises.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = resolveInsideDirectory(current, entry.name, "uv archive entry");
        if (entry.isDirectory()) {
          stack.push(entryPath);
        } else if (entry.isFile() && entry.name === expectedName) {
          return entryPath;
        }
      }
    }

    throw new Error(`uv archive did not contain ${expectedName}.`);
  }

  async extractUvArchive(asset, options = {}) {
    const extractDir = path.join(this.getManagedUvDir(), "extract");
    const targetPath = this.getManagedUvPath();
    const targetTempPath = `${targetPath}.tmp`;

    await fsPromises.rm(extractDir, { recursive: true, force: true });
    await fsPromises.mkdir(extractDir, { recursive: true });

    try {
      throwIfDownloadAborted(options.signal);
      if (asset.fileName.endsWith(".zip")) {
        const directory = await unzipper.Open.file(asset.archivePath);
        const expectedName = process.platform === "win32" ? "uv.exe" : "uv";
        const file = directory.files.find((entry) => {
          resolveInsideDirectory(extractDir, entry.path, "uv zip entry path");
          return path.basename(entry.path) === expectedName && entry.type !== "Directory";
        });
        if (!file) {
          throw new Error(`uv archive did not contain ${expectedName}.`);
        }
        await pipeline(file.stream(), fs.createWriteStream(targetTempPath));
      } else {
        await extractTarArchiveSafe(asset.archivePath, extractDir, { signal: options.signal });
        const extractedUv = await this.findExtractedUvBinary(extractDir);
        await fsPromises.copyFile(extractedUv, targetTempPath);
      }

      throwIfDownloadAborted(options.signal);
      await fsPromises.chmod(targetTempPath, 0o755).catch(() => {});
      await fsPromises.rename(targetTempPath, targetPath);
    } finally {
      await fsPromises.unlink(targetTempPath).catch(() => {});
      await fsPromises.unlink(asset.archivePath).catch(() => {});
      await fsPromises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async installUv(progressCallback = null, options = {}) {
    throwIfDownloadAborted(options.signal);
    await fsPromises.mkdir(this.getManagedUvDir(), { recursive: true });
    const existing = await this.findUv({ includeSystem: false, signal: options.signal });
    if (this.isExpectedManagedUv(existing)) return existing;
    if (existing) {
      await fsPromises.unlink(this.getManagedUvPath()).catch(() => {});
    }

    const asset = await this.downloadVerifiedUvArchive(progressCallback, options);
    await this.extractUvArchive(asset, options);

    const installed = await this.findUv({ includeSystem: false, signal: options.signal });
    if (!this.isExpectedManagedUv(installed)) {
      throw new Error(`Failed to install uv ${UV_VERSION} for managed Granite runtime.`);
    }
    return installed;
  }

  async createManagedPythonVenv(progressCallback = null, options = {}) {
    const uv = await this.installUv(progressCallback, options);
    progressCallback?.({ type: "installing", model: DEFAULT_MODEL_NAME, percentage: 18 });
    await this.runProcess(
      uv.command,
      ["venv", "--python", MANAGED_PYTHON_VERSION, this.getVenvDir()],
      {
        timeoutMs: 30 * 60 * 1000,
        env: this.buildUvEnv(),
        signal: options.signal,
      }
    );
    return this.getVenvPythonPath();
  }

  async installPythonPackages(venvPython, progressCallback = null, options = {}) {
    const uv = await this.installUv(progressCallback, options);
    progressCallback?.({ type: "installing", model: DEFAULT_MODEL_NAME, percentage: 25 });
    await this.runProcess(uv.command, ["pip", "install", "--python", venvPython, ...PIP_PACKAGES], {
      timeoutMs: 30 * 60 * 1000,
      env: this.buildUvEnv(),
      signal: options.signal,
    });
  }

  async checkMissingModules(pythonPath, options = {}) {
    try {
      const result = await this.runProcess(
        pythonPath,
        [
          "-c",
          `import importlib.util,json; modules=${JSON.stringify(PYTHON_MODULES)}; print(json.dumps([m for m in modules if importlib.util.find_spec(m) is None]))`,
        ],
        { timeoutMs: 10000, signal: options.signal }
      );
      return JSON.parse(result.stdout.trim());
    } catch {
      return PYTHON_MODULES;
    }
  }

  async checkInstallation(options = {}) {
    throwIfDownloadAborted(options.signal);
    await this.ensureRuntimeFiles();

    const systemPython = await this.findPython(options);
    const venvPython = this.getVenvPythonPath();
    const venvExists = fs.existsSync(venvPython);

    if (!venvExists) {
      return {
        installed: false,
        working: false,
        repairNeeded: false,
        pythonMissing: false,
        python: systemPython,
        uv: await this.findUv(options),
        runtimePath: this.getRuntimeRoot(),
        venvPath: this.getVenvDir(),
        serverScriptPath: this.getServerScriptPath(),
        missingModules: PYTHON_MODULES,
        message: "Granite runtime is not installed.",
      };
    }

    const missingModules = await this.checkMissingModules(venvPython, options);
    const working = missingModules.length === 0;
    return {
      installed: true,
      working,
      repairNeeded: !working,
      pythonMissing: false,
      python: { executable: venvPython, supported: true },
      uv: await this.findUv(options),
      runtimePath: this.getRuntimeRoot(),
      venvPath: this.getVenvDir(),
      serverScriptPath: this.getServerScriptPath(),
      missingModules,
      message: working
        ? "Granite runtime is ready."
        : `Granite runtime is missing modules: ${formatModuleList(missingModules)}`,
    };
  }

  async installRuntime(progressCallback = null, options = {}) {
    throwIfDownloadAborted(options.signal);
    await this.ensureRuntimeFiles();

    const python = await this.findPython(options);
    progressCallback?.({ type: "installing", model: DEFAULT_MODEL_NAME, percentage: 5 });

    await fsPromises.mkdir(this.getRuntimeRoot(), { recursive: true });
    const venvPython = this.getVenvPythonPath();
    if (!fs.existsSync(venvPython)) {
      if (python?.supported) {
        try {
          await this.runProcess(
            python.executable || python.command,
            ["-m", "venv", this.getVenvDir()],
            {
              timeoutMs: 180000,
              signal: options.signal,
            }
          );
        } catch (error) {
          if (error?.isAbort || options.signal?.aborted) throw error;
          debugLogger.warn(
            "System Python venv creation failed; falling back to managed uv Python",
            {
              python: python.executable || python.command,
              error: error.message,
            }
          );
          await fsPromises.rm(this.getVenvDir(), { recursive: true, force: true }).catch(() => {});
          await this.createManagedPythonVenv(progressCallback, options);
        }
      } else {
        await this.createManagedPythonVenv(progressCallback, options);
      }
    }

    await this.installPythonPackages(venvPython, progressCallback, options);

    const status = await this.checkInstallation(options);
    if (!status.working) {
      const error = new Error(status.message || "Granite runtime installation is incomplete.");
      error.code = "RUNTIME_INSTALL_INCOMPLETE";
      throw error;
    }

    progressCallback?.({ type: "installing", model: DEFAULT_MODEL_NAME, percentage: 100 });
    return { success: true, ...status };
  }

  async ensureRuntimeInstalled(progressCallback = null, options = {}) {
    const status = await this.checkInstallation(options);
    if (status.working) return status;
    return await this.installRuntime(progressCallback, options);
  }

  getModelFiles(modelName) {
    const config = getGraniteModelConfig(modelName);
    return Array.isArray(config?.files) ? config.files : [];
  }

  getGraniteFileUrl(config, file) {
    return (
      file.url ||
      `${config.downloadBaseUrl || `https://huggingface.co/${HF_REPO_ID}/resolve/main/`}${encodeURIComponent(file.path).replace(/%2F/g, "/")}`
    );
  }

  getGraniteMirrorPath(config, modelName, file) {
    const root = String(config.mirrorPathRoot || modelName || "").replace(/^[/\\]+|[/\\]+$/g, "");
    const relativePath = String(file.mirrorPath || file.path || "").replace(/^[/\\]+/, "");
    return root ? path.posix.join(root, relativePath.split(path.sep).join("/")) : relativePath;
  }

  getModelTotalSize(modelName) {
    return this.getModelFiles(modelName).reduce(
      (sum, file) => sum + Number(file.sizeBytes || 0),
      0
    );
  }

  isModelDirectoryValid(modelName) {
    const modelPath = this.getModelPath(modelName);
    const files = this.getModelFiles(modelName);
    if (!files.length || !fs.existsSync(modelPath)) return false;

    return files.every((file) => {
      try {
        const target = resolveInsideDirectory(modelPath, file.path, "Granite model file path");
        const stats = fs.statSync(target);
        return stats.size === Number(file.sizeBytes || 0);
      } catch {
        return false;
      }
    });
  }

  async validateModelDirectoryFiles(modelName, progressCallback = null, signal = null) {
    const modelPath = this.getModelPath(modelName);
    const files = this.getModelFiles(modelName);
    for (const file of files) {
      throwIfDownloadAborted(signal);
      const target = resolveInsideDirectory(modelPath, file.path, "Granite model file path");
      progressCallback?.({
        type: "verifying",
        model: modelName,
        percentage: 0,
      });
      await validateDownloadedArtifact(target, {
        expectedSize: Number(file.sizeBytes || 0),
        sha256: file.sha256 || "",
        strictSize: Boolean(file.sizeBytes || file.sha256),
      });
    }
  }

  async checkModelStatus(modelName = DEFAULT_MODEL_NAME) {
    try {
      this.validateModelName(modelName);
    } catch {
      return { success: true, model: modelName, downloaded: false };
    }

    const modelPath = this.getModelPath(modelName);
    const downloaded = this.isModelDirectoryValid(modelName);
    let sizeBytes = 0;
    if (downloaded) {
      sizeBytes = this.getModelTotalSize(modelName);
    }

    return {
      success: true,
      model: modelName,
      downloaded,
      path: modelPath,
      size_bytes: sizeBytes,
      size_mb: Math.round(sizeBytes / (1024 * 1024)),
      runtime: await this.checkInstallation(),
    };
  }

  async listGraniteModels() {
    const models = [];
    for (const modelName of getValidModelNames()) {
      models.push(await this.checkModelStatus(modelName));
    }
    return { success: true, models, cache_dir: this.getModelsDir() };
  }

  async downloadGraniteModel(
    modelName = DEFAULT_MODEL_NAME,
    progressCallback = null,
    options = {}
  ) {
    this.validateModelName(modelName);
    const config = getGraniteModelConfig(modelName);
    const files = this.getModelFiles(modelName);
    if (!files.length) {
      throw new Error(`Granite model ${modelName} has no managed download file manifest.`);
    }

    if (this.currentDownloadProcess) {
      const error = new Error("A Granite model download is already in progress");
      error.code = "DOWNLOAD_IN_PROGRESS";
      throw error;
    }

    const { signal, abort } = createDownloadSignal();
    this.currentDownloadProcess = { abort };
    const downloadOptions = { ...options, signal };

    try {
      await fsPromises.mkdir(this.getModelsDir(), { recursive: true });
      await cleanupStaleDownloads(this.getModelsDir());
      await this.ensureRuntimeInstalled(progressCallback, downloadOptions);
      throwIfDownloadAborted(signal);

      const modelPath = this.getModelPath(modelName);
      await fsPromises.mkdir(modelPath, { recursive: true });

      if (this.isModelDirectoryValid(modelName)) {
        try {
          await this.validateModelDirectoryFiles(modelName, progressCallback, signal);
          return { success: true, model: modelName, downloaded: true, path: modelPath };
        } catch (error) {
          if (error?.isAbort || signal.aborted) throw error;
          debugLogger.warn("Removing invalid Granite model before repair download", {
            model: modelName,
            path: modelPath,
            error: error.message,
          });
          progressCallback?.({ type: "repairing", model: modelName, percentage: 0 });
          await fsPromises.rm(modelPath, { recursive: true, force: true }).catch(() => {});
          await fsPromises.mkdir(modelPath, { recursive: true });
        }
      }

      const totalBytes = this.getModelTotalSize(modelName);
      const spaceCheck = await checkDiskSpace(this.getModelsDir(), Math.ceil(totalBytes * 1.15));
      if (!spaceCheck.ok) {
        throw new Error(
          `Not enough disk space to download Granite. Need ~${Math.round((totalBytes * 1.15) / 1_000_000)}MB, only ${Math.round(spaceCheck.availableBytes / 1_000_000)}MB available.`
        );
      }

      let completedBytes = 0;

      for (const file of files) {
        if (signal.aborted) {
          throw Object.assign(new Error("Download cancelled"), { isAbort: true });
        }

        const targetPath = resolveInsideDirectory(modelPath, file.path, "Granite model file path");
        await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
        const expectedSize = Number(file.sizeBytes || 0);

        try {
          const stats = await fsPromises.stat(targetPath);
          if (expectedSize > 0 && stats.size === expectedSize) {
            await validateDownloadedArtifact(targetPath, {
              expectedSize,
              sha256: file.sha256 || "",
              strictSize: Boolean(expectedSize || file.sha256),
            });
            completedBytes += expectedSize;
            progressCallback?.({
              type: "progress",
              model: modelName,
              downloaded_bytes: completedBytes,
              total_bytes: totalBytes,
              percentage: Math.round((completedBytes / totalBytes) * 100),
            });
            continue;
          }
          await fsPromises.unlink(targetPath).catch(() => {});
        } catch (error) {
          await fsPromises.unlink(targetPath).catch(() => {});
          if (error?.code && error.code !== "ENOENT") {
            progressCallback?.({ type: "repairing", model: modelName, percentage: 0 });
            debugLogger.warn("Discarding invalid Granite model file", {
              model: modelName,
              file: file.path,
              error: error.message,
            });
          }
        }

        const sourceUrl = this.getGraniteFileUrl(config, file);

        await downloadArtifactFromSources({
          artifactLabel: file.path,
          modelId: modelName,
          destination: targetPath,
          sources: buildDownloadSources(
            {
              primaryUrl: sourceUrl,
              mirrors: file.mirrors || config.mirrors || [],
              mirrorPath: this.getGraniteMirrorPath(config, modelName, file),
            },
            downloadOptions
          ),
          expectedSize,
          sha256: file.sha256 || "",
          strictSize: Boolean(expectedSize || file.sha256),
          signal,
          timeout: 600000,
          completedBytes,
          totalBytes,
          progressCallback,
        });

        completedBytes += expectedSize;
      }

      if (!this.isModelDirectoryValid(modelName)) {
        throw new Error("Granite model download completed but file validation failed.");
      }
      await this.validateModelDirectoryFiles(modelName, progressCallback, signal);

      await fsPromises.writeFile(
        path.join(modelPath, ".chordvox-model-ready.json"),
        JSON.stringify(
          {
            model: modelName,
            repo: HF_REPO_ID,
            installedAt: new Date().toISOString(),
            totalBytes,
            sha256Validated: true,
          },
          null,
          2
        )
      );

      progressCallback?.({ type: "complete", model: modelName, percentage: 100 });

      this.startServer(modelName).catch((error) => {
        debugLogger.warn("Post-download Granite pre-warm failed (non-fatal)", {
          error: error.message,
          model: modelName,
        });
      });

      return { success: true, model: modelName, downloaded: true, path: modelPath };
    } catch (error) {
      if (error.isAbort || signal.aborted) {
        throw new Error("Download interrupted by user");
      }
      throw error;
    } finally {
      this.currentDownloadProcess = null;
    }
  }

  async cancelDownload() {
    if (!this.currentDownloadProcess) {
      return { success: false, error: "No active download to cancel" };
    }
    this.currentDownloadProcess.abort();
    return { success: true, message: "Download cancelled" };
  }

  async deleteGraniteModel(modelName = DEFAULT_MODEL_NAME) {
    this.validateModelName(modelName);
    const modelPath = this.getModelPath(modelName);
    let freedBytes = 0;

    if (fs.existsSync(modelPath)) {
      for (const file of this.getModelFiles(modelName)) {
        try {
          const stats = fs.statSync(
            resolveInsideDirectory(modelPath, file.path, "Granite model file path")
          );
          freedBytes += stats.size;
        } catch {}
      }
      if (this.modelName === modelName) {
        await this.stopServer();
      }
      await fsPromises.rm(modelPath, { recursive: true, force: true });
      if (fs.existsSync(modelPath)) {
        throw new Error(`Granite model files still exist after deleting ${modelName}`);
      }
      return {
        success: true,
        model: modelName,
        deleted: true,
        freed_bytes: freedBytes,
        freed_mb: Math.round(freedBytes / (1024 * 1024)),
      };
    }

    return { success: false, model: modelName, deleted: false, error: "Model not found" };
  }

  async deleteAllGraniteModels() {
    const results = [];
    for (const modelName of getValidModelNames()) {
      if (!fs.existsSync(this.getModelPath(modelName))) continue;
      results.push(await this.deleteGraniteModel(modelName));
    }

    const failed = results.filter((result) => !result.success);
    if (failed.length > 0) {
      return {
        success: false,
        error: failed.map((result) => result.error || result.model).join("; "),
      };
    }

    return {
      success: true,
      deleted_count: results.length,
      freed_bytes: results.reduce((sum, result) => sum + Number(result.freed_bytes || 0), 0),
    };
  }

  buildServerEnv() {
    return {
      ...process.env,
      HF_HOME: this.getHfCacheDir(),
      TRANSFORMERS_CACHE: this.getHfCacheDir(),
      TOKENIZERS_PARALLELISM: "false",
      PYTHONUNBUFFERED: "1",
    };
  }

  async startServer(modelName = DEFAULT_MODEL_NAME, options = {}) {
    const signal = options.signal || null;
    throwIfAborted(signal);
    if (this.startupPromise) return this.awaitStartupWithAbort(this.startupPromise, signal);
    if (this.ready && this.modelName === modelName && this.process) {
      return { success: true, port: this.port, endpoint: this.lastEndpoint };
    }
    if (this.process) {
      await this.stopServer();
    }

    this.startupPromise = this._doStartServer(modelName, options);
    try {
      return await this.awaitStartupWithAbort(this.startupPromise, signal);
    } finally {
      this.startupPromise = null;
    }
  }

  awaitStartupWithAbort(promise, signal) {
    if (!signal) return promise;
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(createAbortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(promise).then(
        (value) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
  }

  async _doStartServer(modelName, options = {}) {
    const signal = options.signal || null;
    throwIfAborted(signal);
    this.validateModelName(modelName);
    await this.ensureRuntimeFiles();

    const runtime = await this.checkInstallation();
    if (!runtime.working) {
      throw new Error(runtime.message || "Granite runtime is not installed.");
    }
    if (!this.isModelDirectoryValid(modelName)) {
      throw new Error(`Granite model "${modelName}" is not downloaded.`);
    }

    const venvPython = this.getVenvPythonPath();
    const modelPath = this.getModelPath(modelName);
    let nextPortStart = PORT_RANGE_START;
    let lastError = null;

    for (let attempt = 1; attempt <= STARTUP_PORT_RETRY_LIMIT; attempt += 1) {
      throwIfAborted(signal);
      this.port = await findAvailablePort(nextPortStart, PORT_RANGE_END, SERVER_HOST);
      this.modelName = modelName;
      this.lastEndpoint = `http://${SERVER_HOST}:${this.port}/v1/audio/transcriptions`;

      const args = [
        this.getServerScriptPath(),
        "--host",
        SERVER_HOST,
        "--port",
        String(this.port),
        "--model-dir",
        modelPath,
        "--model-id",
        modelName,
      ];

      try {
        await this.spawnAndWaitForReady(venvPython, args, attempt, signal);
        this.startHealthCheck();
        debugLogger.info("Granite runtime server started", {
          port: this.port,
          endpoint: this.lastEndpoint,
          model: modelName,
        });
        return { success: true, port: this.port, endpoint: this.lastEndpoint, model: modelName };
      } catch (error) {
        lastError = error;
        const failedPort = this.port;
        await this.stopServer();

        if (
          !isPortInUseError(error) ||
          failedPort >= PORT_RANGE_END ||
          attempt >= STARTUP_PORT_RETRY_LIMIT
        ) {
          throw error;
        }

        nextPortStart = failedPort + 1;
        debugLogger.warn("Granite runtime port busy; retrying on next port", {
          failedPort,
          nextPortStart,
          attempt,
          modelName,
        });
      }
    }

    throw lastError || new Error("Failed to start Granite runtime server.");
  }

  async spawnAndWaitForReady(pythonPath, args, attempt, signal = null) {
    throwIfAborted(signal);
    debugLogger.info("Starting Granite runtime server", { port: this.port, attempt, args });

    this.process = spawn(pythonPath, args, {
      cwd: this.getRuntimeRoot(),
      env: this.buildServerEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let exitCode = null;

    this.process.stdout.on("data", (data) => {
      const text = data.toString();
      stdoutBuffer = appendBoundedOutput(stdoutBuffer, text);
      debugLogger.debug("granite-runtime stdout", { processOutput: text.trim() });
    });

    this.process.stderr.on("data", (data) => {
      const text = data.toString();
      stderrBuffer = appendBoundedOutput(stderrBuffer, text);
      debugLogger.debug("granite-runtime stderr", { processOutput: text.trim() });
    });

    this.process.on("error", (error) => {
      debugLogger.error("granite-runtime process error", { error: error.message });
      this.ready = false;
    });

    this.process.on("close", (code) => {
      exitCode = code;
      debugLogger.debug("granite-runtime process exited", { code });
      this.ready = false;
      this.process = null;
      this.stopHealthCheck();
    });

    const onAbort = () => {
      try {
        if (this.process && !this.process.killed) this.process.kill();
      } catch {}
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
    try {
      await this.waitForReady(
        () => ({
          stdout: stdoutBuffer,
          stderr: stderrBuffer,
          exitCode,
        }),
        signal
      );
    } finally {
      signal?.removeEventListener?.("abort", onAbort);
    }
  }

  async waitForReady(getProcessInfo, signal = null) {
    const startTime = Date.now();

    while (Date.now() - startTime < STARTUP_TIMEOUT_MS) {
      throwIfAborted(signal);
      if (!this.process || this.process.killed) {
        const info = getProcessInfo ? getProcessInfo() : {};
        const details =
          summarizeStartupFailure(info, 800) ||
          (info.exitCode !== null ? `exit code: ${info.exitCode}` : "");
        throw new Error(`Granite runtime died during startup${details ? `: ${details}` : ""}`);
      }

      if (await this.checkHealth()) {
        this.ready = true;
        debugLogger.debug("Granite runtime ready", {
          startupTimeMs: Date.now() - startTime,
          port: this.port,
        });
        return;
      }

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener?.("abort", onAbort);
          resolve();
        }, 1000);
        const onAbort = () => {
          clearTimeout(timer);
          reject(createAbortError());
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener?.("abort", onAbort, { once: true });
      });
    }

    throw new Error(
      `Granite runtime failed to start within ${Math.round(STARTUP_TIMEOUT_MS / 1000)}s`
    );
  }

  checkHealth() {
    if (!this.port) return Promise.resolve(false);

    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: SERVER_HOST,
          port: this.port,
          path: "/health",
          method: "GET",
          timeout: HEALTH_CHECK_TIMEOUT_MS,
        },
        (res) => {
          resolve(res.statusCode === 200);
          res.resume();
        }
      );

      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  startHealthCheck() {
    this.stopHealthCheck();
    this.healthCheckFailures = 0;
    this.healthCheckInterval = setInterval(async () => {
      if (!this.process) {
        this.stopHealthCheck();
        return;
      }
      if (await this.checkHealth()) {
        this.healthCheckFailures = 0;
        return;
      }
      this.healthCheckFailures += 1;
      if (this.healthCheckFailures >= HEALTH_CHECK_FAILURE_THRESHOLD) {
        debugLogger.warn("Granite runtime health check failed", {
          consecutiveFailures: this.healthCheckFailures,
          port: this.port,
        });
        this.ready = false;
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  async stopServer() {
    this.stopHealthCheck();
    if (!this.process) {
      this.ready = false;
      this.port = null;
      this.modelName = null;
      this.lastEndpoint = "";
      return { success: true };
    }

    await gracefulStopProcess(this.process);
    this.process = null;
    this.ready = false;
    this.port = null;
    this.modelName = null;
    this.lastEndpoint = "";
    return { success: true };
  }

  getServerStatus() {
    return {
      available: fs.existsSync(this.getVenvPythonPath()),
      running: this.ready && this.process !== null,
      port: this.port,
      endpoint: this.lastEndpoint,
      model: this.modelName,
      runtimePath: this.getRuntimeRoot(),
      modelsDir: this.getModelsDir(),
    };
  }

  async ensureWav(audioBuffer, signal = null) {
    if (isWavFormat(audioBuffer)) {
      return { wavBuffer: audioBuffer, filesToCleanup: [] };
    }

    const tempDir = getSafeTempDir();
    const timestamp = `${Date.now()}-${process.pid}`;
    const tempInputPath = path.join(tempDir, `granite-input-${timestamp}.webm`);
    const tempWavPath = path.join(tempDir, `granite-${timestamp}.wav`);

    await fsPromises.writeFile(tempInputPath, audioBuffer, { signal });
    await convertToWav(tempInputPath, tempWavPath, {
      sampleRate: 16000,
      channels: 1,
      signal,
    });

    return {
      wavBuffer: await fsPromises.readFile(tempWavPath, { signal }),
      filesToCleanup: [tempInputPath, tempWavPath],
    };
  }

  async ensureWavFromFile(inputPath, signal = null) {
    const resolvedInputPath = path.resolve(inputPath);
    const tempDir = getSafeTempDir();
    const timestamp = `${Date.now()}-${process.pid}`;
    const tempWavPath = path.join(tempDir, `granite-${timestamp}.wav`);

    await convertToWav(resolvedInputPath, tempWavPath, {
      sampleRate: 16000,
      channels: 1,
      signal,
    });

    return {
      wavBuffer: await fsPromises.readFile(tempWavPath, { signal }),
      filesToCleanup: [tempWavPath],
    };
  }

  cleanupFiles(files) {
    for (const file of files) {
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch {}
    }
  }

  async transcribeLocalGranite(audioBlob, options = {}) {
    const modelName = String(options.model || DEFAULT_MODEL_NAME).trim() || DEFAULT_MODEL_NAME;
    this.validateModelName(modelName);

    const audioBuffer = toBuffer(audioBlob);
    if (!audioBuffer.length) {
      return { success: false, error: "no_audio_data", message: "No audio detected" };
    }

    const { wavBuffer, filesToCleanup } = await this.ensureWav(audioBuffer, options.signal);
    try {
      const samples = wavToFloat32Samples(wavBuffer);
      const rms = computeFloat32RMS(samples);
      debugLogger.debug("Granite audio analysis", { rms, wavBytes: wavBuffer.length, modelName });
      if (rms < SILENCE_RMS_THRESHOLD) {
        return { success: false, message: "No audio detected" };
      }

      const server = await this.startServer(modelName, { signal: options.signal });
      const result = await transcribeExternalAsrRuntime(wavBuffer, {
        provider: "granite",
        model: modelName,
        runtimeUrl: server.endpoint,
        mimeType: "audio/wav",
        fileName: "audio.wav",
        language: options.language || "",
        prompt: options.prompt || "",
        timeoutMs: TRANSCRIPTION_TIMEOUT_MS,
        signal: options.signal,
      });

      return {
        success: true,
        text: result.text,
        provider: "granite",
        model: modelName,
        endpoint: server.endpoint,
        statusCode: result.statusCode,
      };
    } finally {
      this.cleanupFiles(filesToCleanup);
    }
  }

  async transcribeLocalGraniteFile(filePath, options = {}) {
    const modelName = String(options.model || DEFAULT_MODEL_NAME).trim() || DEFAULT_MODEL_NAME;
    this.validateModelName(modelName);

    const { wavBuffer, filesToCleanup } = await this.ensureWavFromFile(filePath, options.signal);
    try {
      const samples = wavToFloat32Samples(wavBuffer);
      const rms = computeFloat32RMS(samples);
      debugLogger.debug("Granite file audio analysis", {
        rms,
        wavBytes: wavBuffer.length,
        modelName,
      });
      if (rms < SILENCE_RMS_THRESHOLD) {
        return { success: false, message: "No audio detected" };
      }

      const server = await this.startServer(modelName, { signal: options.signal });
      const result = await transcribeExternalAsrRuntime(wavBuffer, {
        provider: "granite",
        model: modelName,
        runtimeUrl: server.endpoint,
        mimeType: "audio/wav",
        fileName: "audio.wav",
        language: options.language || "",
        prompt: options.prompt || "",
        timeoutMs: TRANSCRIPTION_TIMEOUT_MS,
        signal: options.signal,
      });

      return {
        success: true,
        text: result.text,
        provider: "granite",
        model: modelName,
        endpoint: server.endpoint,
        statusCode: result.statusCode,
      };
    } finally {
      this.cleanupFiles(filesToCleanup);
    }
  }

  async getDiagnostics() {
    return {
      platform: process.platform,
      arch: process.arch,
      resourcesPath: process.resourcesPath || null,
      isPackaged: app.isPackaged,
      runtime: await this.checkInstallation(),
      server: this.getServerStatus(),
      modelsDir: this.getModelsDir(),
      models: (await this.listGraniteModels()).models,
    };
  }
}

module.exports = GraniteRuntimeManager;
