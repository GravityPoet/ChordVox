#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { downloadFileVerified, verifyFileSha256 } = require("./lib/download-utils");

const MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/80da2d8bfee42b0e836fc3a9890373e5defc00a6/ggml-tiny.bin";
const MODEL_SHA256 = "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21";
const MODEL_SIZE_BYTES = 77_691_713;
const repoRoot = path.resolve(__dirname, "..");
const defaultOutputPath = path.join(repoRoot, ".cache", "release-dictation-model", "ggml-tiny.bin");

function parseOutputPath(argv) {
  const outputIndex = argv.indexOf("--output");
  if (outputIndex === -1) return defaultOutputPath;
  const value = argv[outputIndex + 1];
  if (!value) throw new Error("--output requires a file path");
  return path.resolve(repoRoot, value);
}

function verifyModelFile(modelPath) {
  if (!fs.existsSync(modelPath)) return false;
  const stats = fs.statSync(modelPath);
  if (!stats.isFile() || stats.size !== MODEL_SIZE_BYTES) return false;
  return verifyFileSha256(modelPath, MODEL_SHA256) === MODEL_SHA256;
}

async function main() {
  const outputPath = parseOutputPath(process.argv.slice(2));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  if (verifyModelFile(outputPath)) {
    console.log(`[release-dictation-model] verified cached model: ${outputPath}`);
    console.log(`[release-dictation-model] sha256: ${MODEL_SHA256}`);
    return;
  }

  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath);
  }

  const tempPath = `${outputPath}.download-${process.pid}`;
  if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);

  try {
    console.log(`[release-dictation-model] downloading pinned model: ${MODEL_URL}`);
    await downloadFileVerified(MODEL_URL, tempPath, MODEL_SHA256);
    const stats = fs.statSync(tempPath);
    if (stats.size !== MODEL_SIZE_BYTES) {
      throw new Error(
        `Model size mismatch: expected ${MODEL_SIZE_BYTES} bytes, found ${stats.size} bytes`
      );
    }
    fs.renameSync(tempPath, outputPath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }

  if (!verifyModelFile(outputPath)) {
    throw new Error(`Downloaded release dictation model did not pass verification: ${outputPath}`);
  }

  console.log(`[release-dictation-model] installed: ${outputPath}`);
  console.log(`[release-dictation-model] sha256: ${MODEL_SHA256}`);
}

module.exports = {
  MODEL_SHA256,
  MODEL_SIZE_BYTES,
  MODEL_URL,
  parseOutputPath,
  verifyModelFile,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`[release-dictation-model] FAILED: ${error.message || error}`);
    process.exit(1);
  });
}
