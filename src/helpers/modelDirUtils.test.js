import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { getServiceModelsDir, migrateSpeechModelsRoot } = require("./modelDirUtils");

describe("migrateSpeechModelsRoot", () => {
  let tempRoot;
  let sourceRoot;
  let targetRoot;

  beforeEach(async () => {
    const realTempDir = await fs.realpath(os.tmpdir());
    tempRoot = await fs.mkdtemp(path.join(realTempDir, "chordvox-model-migration-"));
    sourceRoot = path.join(tempRoot, "source");
    targetRoot = path.join(tempRoot, "target");
    await fs.mkdir(sourceRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("copies, verifies, merges, and only then removes the old service folders", async () => {
    const sourceWhisper = getServiceModelsDir(sourceRoot, "whisper");
    const sourceStreaming = getServiceModelsDir(sourceRoot, "streaming");
    const targetWhisper = getServiceModelsDir(targetRoot, "whisper");
    await fs.mkdir(path.join(sourceWhisper, "large-v3"), { recursive: true });
    await fs.mkdir(sourceStreaming, { recursive: true });
    await fs.mkdir(targetWhisper, { recursive: true });
    await fs.writeFile(path.join(sourceWhisper, "large-v3", "model.bin"), "whisper-data");
    await fs.writeFile(path.join(sourceStreaming, "tokens.txt"), "streaming-data");
    await fs.writeFile(path.join(targetWhisper, "existing.bin"), "existing-data");

    const progress = [];
    const result = await migrateSpeechModelsRoot(sourceRoot, targetRoot, {
      onProgress: (item) => progress.push(item),
    });

    expect(result.success).toBe(true);
    expect(result.migratedServices).toEqual(["whisper", "streaming"]);
    expect(await fs.readFile(path.join(targetWhisper, "large-v3", "model.bin"), "utf8")).toBe(
      "whisper-data"
    );
    expect(await fs.readFile(path.join(targetWhisper, "existing.bin"), "utf8")).toBe(
      "existing-data"
    );
    expect(await fs.readFile(path.join(targetRoot, "streaming-models", "tokens.txt"), "utf8")).toBe(
      "streaming-data"
    );
    await expect(fs.access(sourceWhisper)).rejects.toThrow();
    await expect(fs.access(sourceStreaming)).rejects.toThrow();
    expect(progress.some((item) => item.phase === "verified")).toBe(true);
    expect(progress.some((item) => item.phase === "cleaned")).toBe(true);
  });

  it("keeps the old model intact when an existing target directory contains different data", async () => {
    const sourceWhisper = getServiceModelsDir(sourceRoot, "whisper");
    const targetWhisper = getServiceModelsDir(targetRoot, "whisper");
    await fs.mkdir(path.join(sourceWhisper, "large-v3"), { recursive: true });
    await fs.mkdir(path.join(targetWhisper, "large-v3"), { recursive: true });
    const sourceFile = path.join(sourceWhisper, "large-v3", "model.bin");
    const targetFile = path.join(targetWhisper, "large-v3", "model.bin");
    await fs.writeFile(sourceFile, "AAAA");
    await fs.writeFile(targetFile, "BBBB");

    await expect(migrateSpeechModelsRoot(sourceRoot, targetRoot)).rejects.toMatchObject({
      code: "MODEL_MIGRATION_CONFLICT",
    });
    expect(await fs.readFile(sourceFile, "utf8")).toBe("AAAA");
    expect(await fs.readFile(targetFile, "utf8")).toBe("BBBB");
  });

  it("switches to a populated child root when the current root has no managed model folders", async () => {
    const selectedRoot = path.join(sourceRoot, "Local-LLM");
    const selectedWhisper = getServiceModelsDir(selectedRoot, "whisper");
    const existingModel = path.join(selectedWhisper, "tiny", "model.bin");
    const unrelatedFile = path.join(sourceRoot, "unrelated-project.txt");
    await fs.mkdir(path.dirname(existingModel), { recursive: true });
    await fs.writeFile(existingModel, "existing-model");
    await fs.writeFile(unrelatedFile, "keep-me");

    const result = await migrateSpeechModelsRoot(sourceRoot, selectedRoot);

    expect(result).toEqual({
      success: true,
      migratedServices: [],
      cleanupWarnings: [],
    });
    expect(await fs.readFile(existingModel, "utf8")).toBe("existing-model");
    expect(await fs.readFile(unrelatedFile, "utf8")).toBe("keep-me");
  });

  it("keeps nested roots blocked when the current root still contains managed models", async () => {
    const sourceWhisper = getServiceModelsDir(sourceRoot, "whisper");
    const sourceModel = path.join(sourceWhisper, "tiny", "model.bin");
    const selectedRoot = path.join(sourceRoot, "Local-LLM");
    await fs.mkdir(path.dirname(sourceModel), { recursive: true });
    await fs.writeFile(sourceModel, "source-model");

    await expect(migrateSpeechModelsRoot(sourceRoot, selectedRoot)).rejects.toMatchObject({
      code: "MODEL_MIGRATION_NESTED_ROOT",
    });
    expect(await fs.readFile(sourceModel, "utf8")).toBe("source-model");
  });
});
