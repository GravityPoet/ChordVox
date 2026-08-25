const STREAMING_MODELS = require("./streamingModels.json");

const DEFAULT_STREAMING_MODEL_ID =
  STREAMING_MODELS.find((model) => model.default)?.id || STREAMING_MODELS[0].id;
const LEGACY_STREAMING_MODEL_IDS = {
  "zipformer-small-ctc-zh": "zipformer-ctc-zh-large-fp16",
  "zipformer-ctc-zh": "zipformer-ctc-zh-large-fp16",
  "zipformer-ctc-zh-large": "zipformer-ctc-zh-large-fp16",
  "zipformer-ctc-zh-xlarge-fp16": "zipformer-ctc-zh-xlarge",
  "paraformer-bilingual-zh-en": "nemotron-streaming-en-0.6b",
};
const STREAMING_MODEL_IDS = new Set(STREAMING_MODELS.map((model) => model.id));

function resolveStreamingModelId(modelId) {
  const raw = String(modelId || "").trim();
  return raw ? LEGACY_STREAMING_MODEL_IDS[raw] || raw : DEFAULT_STREAMING_MODEL_ID;
}

function normalizeStreamingModelId(modelId) {
  const resolved = resolveStreamingModelId(modelId);
  return STREAMING_MODEL_IDS.has(resolved) ? resolved : DEFAULT_STREAMING_MODEL_ID;
}

const streamingModelConfig = {
  STREAMING_MODELS,
  DEFAULT_STREAMING_MODEL_ID,
  resolveStreamingModelId,
  normalizeStreamingModelId,
};

module.exports = streamingModelConfig;
module.exports.default = streamingModelConfig;
