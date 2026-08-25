const SherpaStreamingEngine = require("./sherpaStreamingManager");

const engine = new SherpaStreamingEngine();

function send(message) {
  if (process.send) {
    process.send(message);
  }
}

function serializeError(error) {
  return {
    message: error?.message || String(error || "Unknown error"),
    code: error?.code || null,
    stack: error?.stack || null,
  };
}

function sendResponse(id, ok, payload) {
  if (!id) {
    if (!ok) {
      send({ kind: "event", event: "error", payload: serializeError(payload) });
    }
    return;
  }
  if (ok) {
    send({ kind: "response", id, ok: true, result: payload });
    return;
  }
  send({ kind: "response", id, ok: false, error: serializeError(payload) });
}

engine.onPartialTranscript = (text) => {
  send({ kind: "event", event: "partial", payload: text || "" });
};

engine.onFinalTranscript = (text) => {
  send({ kind: "event", event: "final", payload: text || "" });
};

engine.onError = (error) => {
  send({ kind: "event", event: "error", payload: serializeError(error) });
};

engine.onAutoStopRequested = (payload) => {
  send({ kind: "event", event: "autoStop", payload: payload || {} });
};

async function handleRequest(message) {
  const { id, type, payload = {} } = message || {};

  try {
    switch (type) {
      case "transcribeFile": {
        const result = await engine.transcribeFile(payload.audioBuffer, payload.options || {});
        sendResponse(id, true, result);
        break;
      }
      case "transcribeFilePath": {
        const result = await engine.transcribeFilePath(payload.filePath, payload.options || {});
        sendResponse(id, true, result);
        break;
      }
      case "startStream": {
        await engine.startStream(payload.modelId, payload.modelsDir || "", payload.options || {});
        sendResponse(id, true, { success: true, modelId: payload.modelId });
        break;
      }
      case "warmupModel": {
        const result = await engine.warmupModel(
          payload.modelId,
          payload.modelsDir || "",
          payload.options || {}
        );
        sendResponse(id, true, result);
        break;
      }
      case "feedAudioChunk": {
        engine.feedAudioChunk(payload.audioBuffer);
        break;
      }
      case "stopStream": {
        sendResponse(id, true, engine.stopStream());
        break;
      }
      case "getStatus": {
        sendResponse(id, true, engine.getStatus());
        break;
      }
      case "cleanup": {
        engine.cleanup();
        sendResponse(id, true, { success: true });
        break;
      }
      default:
        throw new Error(`Unknown worker command: ${type}`);
    }
  } catch (error) {
    sendResponse(id, false, error);
  }
}

process.on("message", (message) => {
  handleRequest(message);
});

process.on("disconnect", () => {
  try {
    engine.cleanup();
  } finally {
    process.exit(0);
  }
});

process.on("uncaughtException", (error) => {
  send({ kind: "fatal", error: serializeError(error) });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  send({ kind: "fatal", error: serializeError(reason) });
  process.exit(1);
});

send({ kind: "ready" });
