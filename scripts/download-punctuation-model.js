#!/usr/bin/env node
/**
 * Downloads the CT-Transformer ML punctuation model into the ChordVox
 * punctuation models dir. Thin CLI wrapper over the in-app downloader so dev,
 * CI, and manual installs share one verified download + safe-extract path.
 */
const {
  downloadPunctuationModel,
  isPunctuationModelAvailable,
  DEFAULT_PUNCTUATION_MODEL,
} = require("../src/helpers/punctuationModel");

function formatBytes(bytes = 0) {
  if (!bytes) return "0.0 MB";
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function main() {
  const modelName = DEFAULT_PUNCTUATION_MODEL;

  if (isPunctuationModelAvailable(modelName)) {
    console.log(`Punctuation model already installed: ${modelName}`);
    return;
  }

  console.log(`Downloading punctuation model: ${modelName}`);

  let lastPercentage = -1;
  const result = await downloadPunctuationModel({
    modelName,
    onProgress: (event) => {
      if (!event) return;
      if (event.type === "progress" && typeof event.percentage === "number") {
        if (event.percentage !== lastPercentage) {
          lastPercentage = event.percentage;
          process.stdout.write(
            `\r   ${event.percentage}%  ${formatBytes(event.downloaded_bytes)} / ${formatBytes(
              event.total_bytes
            )}   `
          );
        }
      } else if (event.type === "verifying") {
        process.stdout.write("\r   verifying checksum...            ");
      }
    },
  });

  process.stdout.write("\n");
  console.log(`Installed at: ${result.path}`);
}

main().catch((error) => {
  console.error(`\nPunctuation model download failed: ${error.message}`);
  process.exitCode = 1;
});
