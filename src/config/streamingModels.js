const STREAMING_MODELS = require("./streamingModels.json");

const DEFAULT_STREAMING_MODEL_ID =
  STREAMING_MODELS.find((model) => model.default)?.id || STREAMING_MODELS[0].id;

const streamingModelConfig = {
  STREAMING_MODELS,
  DEFAULT_STREAMING_MODEL_ID,
};

module.exports = streamingModelConfig;
module.exports.default = streamingModelConfig;
