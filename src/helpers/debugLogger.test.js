import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { createRequire } from "module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

describe("debugLogger", () => {
  let logger;
  const temporaryDirectories = [];

  const createTemporaryDirectory = () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chordvox-call-traces-"));
    temporaryDirectories.push(directory);
    return directory;
  };

  beforeEach(() => {
    vi.resetModules();
    delete require.cache[require.resolve("./debugLogger")];
    logger = require("./debugLogger");
    logger.clearRecentEntries();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("redacts reasoning request and response body fields before retaining recent log entries", () => {
    const requestBody = "please rewrite this confidential customer transcript";
    const fullResponse = "the rewritten confidential response text";
    const requestPreview = "preview of a private dictation";

    logger.info(
      "reasoning payload",
      { requestBody, fullResponse, requestPreview },
      "reasoning",
      "test"
    );

    const [entry] = logger.getRecentEntries({ scope: "reasoning", limit: 1 });
    expect(entry.meta.requestBody).toMatch(/^\[REDACTED_TEXT length=\d+\]$/);
    expect(entry.meta.fullResponse).toMatch(/^\[REDACTED_TEXT length=\d+\]$/);
    expect(entry.meta.requestPreview).toMatch(/^\[REDACTED_TEXT length=\d+\]$/);
    expect(JSON.stringify(entry.meta)).not.toContain("confidential");
    expect(JSON.stringify(entry.meta)).not.toContain("private dictation");
  });

  it("redacts raw child-process output that can contain dictated text", () => {
    logger.info("runtime stdout", {
      processOutput: "private dictated words from a local speech process",
    });

    const [entry] = logger.getRecentEntries({ limit: 1 });
    expect(entry.meta.processOutput).toMatch(/^\[REDACTED_TEXT length=\d+\]$/);
    expect(JSON.stringify(entry.meta)).not.toContain("private dictated words");
  });

  it("does not redact unrelated structured data fields", () => {
    logger.info("model startup metadata", {
      data: "backend=metal status=ready",
    });

    const [entry] = logger.getRecentEntries({ limit: 1 });
    expect(entry.meta.data).toBe("backend=metal status=ready");
  });

  it("keeps model and provider metadata readable in call diagnostics", () => {
    logger.info(
      "transcription route",
      {
        transcriptionProvider: "paraformer",
        transcriptionModel: "paraformer-large-zh",
        reasoningProvider: "openai",
        reasoningModel: "gpt-5-mini",
        transcript: "private dictated words",
      },
      "call-trace",
      "test"
    );

    const [entry] = logger.getRecentEntries({ scope: "call-trace", limit: 1 });
    expect(entry.meta).toMatchObject({
      transcriptionProvider: "paraformer",
      transcriptionModel: "paraformer-large-zh",
      reasoningProvider: "openai",
      reasoningModel: "gpt-5-mini",
    });
    expect(entry.meta.transcript).toMatch(/^\[REDACTED_TEXT length=\d+\]$/);
  });

  it("uses the renderer occurrence time for call-trace sessions and events", () => {
    const startedAt = "2026-07-17T11:50:03.100Z";
    const completedAt = "2026-07-17T11:50:13.170Z";

    logger.info(
      "CALL_TRACE",
      {
        runId: "run-timestamp",
        phase: "session",
        status: "start",
        occurredAt: startedAt,
      },
      "call-trace",
      "renderer"
    );
    logger.info(
      "CALL_TRACE",
      {
        runId: "run-timestamp",
        phase: "session",
        status: "success",
        occurredAt: completedAt,
      },
      "call-trace",
      "renderer"
    );

    const [session] = logger.getCallTraceSessions(1);
    const events = logger.getCallTraceEvents("run-timestamp", 10);

    expect(session).toMatchObject({ startedAt, updatedAt: completedAt });
    expect(events.map((event) => event.timestamp)).toEqual([startedAt, completedAt]);
  });

  it("keeps session bounds correct when renderer events arrive out of order", () => {
    const startedAt = "2026-07-17T11:50:03.100Z";
    const completedAt = "2026-07-17T11:50:13.170Z";

    logger.info(
      "CALL_TRACE",
      {
        runId: "run-out-of-order",
        phase: "session",
        status: "success",
        occurredAt: completedAt,
      },
      "call-trace",
      "renderer"
    );
    logger.info(
      "CALL_TRACE",
      {
        runId: "run-out-of-order",
        phase: "session",
        status: "start",
        occurredAt: startedAt,
      },
      "call-trace",
      "renderer"
    );

    const [session] = logger.getCallTraceSessions(1);

    expect(session).toMatchObject({ startedAt, updatedAt: completedAt });
  });

  it("restores privacy-filtered call diagnostics after an app restart", () => {
    const userDataPath = createTemporaryDirectory();
    const { DebugLogger } = require("./debugLogger");
    const firstSession = new DebugLogger({ userDataPath });

    firstSession.info(
      "CALL_TRACE",
      {
        runId: "run-persisted",
        phase: "transcription",
        status: "success",
        occurredAt: "2026-08-18T03:14:27.000Z",
        transcriptionProvider: "paraformer",
        transcriptionModel: "paraformer-large-zh",
        transcriptionProcessingDurationMs: 1_800,
        transcript: "private dictated words must never be persisted",
        error: "Bearer private-auth-token-123 support@example.com",
      },
      "call-trace",
      "renderer"
    );

    const restartedSession = new DebugLogger({ userDataPath });
    expect(restartedSession.getCallTraceSessions(30)).toEqual([
      expect.objectContaining({
        runId: "run-persisted",
        transcriptionStatus: "success",
        transcriptionProvider: "paraformer",
        transcriptionModel: "paraformer-large-zh",
        transcriptionProcessingDurationMs: 1_800,
      }),
    ]);
    expect(restartedSession.getCallTraceEvents("run-persisted", 120)).toHaveLength(1);

    const storePath = path.join(userDataPath, "diagnostics", "call-traces-v1.jsonl");
    const storedContent = fs.readFileSync(storePath, "utf8");
    expect(storedContent).not.toContain("private dictated words");
    expect(storedContent).not.toContain("private-auth-token");
    expect(storedContent).not.toContain("support@example.com");
    const storedEntry = JSON.parse(storedContent.trim());
    expect(storedEntry.meta).not.toHaveProperty("transcript");
    if (process.platform !== "win32") {
      expect(fs.statSync(storePath).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps cleared call diagnostics empty after the next app restart", () => {
    const userDataPath = createTemporaryDirectory();
    const { DebugLogger } = require("./debugLogger");
    const firstSession = new DebugLogger({ userDataPath });

    firstSession.info(
      "CALL_TRACE",
      {
        runId: "run-to-clear",
        phase: "session",
        status: "success",
        occurredAt: "2026-08-18T03:14:27.000Z",
      },
      "call-trace",
      "renderer"
    );
    firstSession.clearCallTraces();

    const restartedSession = new DebugLogger({ userDataPath });
    expect(restartedSession.getCallTraceSessions(30)).toEqual([]);
    expect(restartedSession.getCallTraceEvents("run-to-clear", 120)).toEqual([]);
  });

  it("recovers from a damaged call diagnostic store", () => {
    const userDataPath = createTemporaryDirectory();
    const diagnosticsPath = path.join(userDataPath, "diagnostics");
    const storePath = path.join(diagnosticsPath, "call-traces-v1.jsonl");
    fs.mkdirSync(diagnosticsPath, { recursive: true });
    fs.writeFileSync(storePath, "not-json\n", "utf8");

    const { DebugLogger } = require("./debugLogger");
    const recoveredSession = new DebugLogger({ userDataPath });
    expect(recoveredSession.getCallTraceSessions(30)).toEqual([]);

    recoveredSession.info(
      "CALL_TRACE",
      {
        runId: "run-after-recovery",
        phase: "session",
        status: "success",
        occurredAt: "2026-08-18T03:15:00.000Z",
      },
      "call-trace",
      "renderer"
    );

    const restartedSession = new DebugLogger({ userDataPath });
    expect(restartedSession.getCallTraceSessions(30)).toEqual([
      expect.objectContaining({ runId: "run-after-recovery", sessionStatus: "success" }),
    ]);
  });

  it("keeps call diagnostics in memory when persistent storage is unavailable", () => {
    const userDataPath = createTemporaryDirectory();
    const blockedUserDataPath = path.join(userDataPath, "not-a-directory");
    fs.writeFileSync(blockedUserDataPath, "blocked", "utf8");

    const { DebugLogger } = require("./debugLogger");
    const degradedSession = new DebugLogger({ userDataPath: blockedUserDataPath });
    expect(() =>
      degradedSession.info(
        "CALL_TRACE",
        {
          runId: "run-in-memory-only",
          phase: "session",
          status: "success",
          occurredAt: "2026-08-18T03:16:00.000Z",
        },
        "call-trace",
        "renderer"
      )
    ).not.toThrow();
    expect(degradedSession.getCallTraceSessions(30)).toEqual([
      expect.objectContaining({ runId: "run-in-memory-only", sessionStatus: "success" }),
    ]);
  });

  it("keeps restored call diagnostics visible after unrelated log churn", () => {
    const userDataPath = createTemporaryDirectory();
    const { DebugLogger } = require("./debugLogger");
    const firstSession = new DebugLogger({ userDataPath });
    firstSession.info(
      "CALL_TRACE",
      {
        runId: "run-survives-log-churn",
        phase: "session",
        status: "success",
        occurredAt: "2026-08-18T03:17:00.000Z",
      },
      "call-trace",
      "renderer"
    );

    const restartedSession = new DebugLogger({ userDataPath });
    expect(restartedSession.getCallTraceSessions(30)).toHaveLength(1);
    for (let index = 0; index < 2_100; index += 1) {
      restartedSession.info("unrelated log", { index }, "system", "test");
    }

    expect(restartedSession.getCallTraceSessions(30)).toEqual([
      expect.objectContaining({ runId: "run-survives-log-churn", sessionStatus: "success" }),
    ]);
  });

  it("keeps detailed log storage private and repairs existing permissions", () => {
    const userDataPath = createTemporaryDirectory();
    const logsDirectory = path.join(userDataPath, "logs");
    const existingLogPath = path.join(logsDirectory, "debug-existing.log");
    fs.mkdirSync(logsDirectory, { recursive: true });
    fs.writeFileSync(existingLogPath, "existing log\n", "utf8");

    if (process.platform !== "win32") {
      fs.chmodSync(logsDirectory, 0o777);
      fs.chmodSync(existingLogPath, 0o666);
    }

    const { DebugLogger } = require("./debugLogger");
    const session = new DebugLogger({ userDataPath });
    session.initializeFileLogging();

    expect(session.getLogPath()).toMatch(/debug-.*\.log$/);
    if (process.platform !== "win32") {
      expect(fs.statSync(logsDirectory).mode & 0o777).toBe(0o700);
      expect(fs.statSync(existingLogPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(session.getLogPath()).mode & 0o777).toBe(0o600);
    }

    session.close();
  });
});
