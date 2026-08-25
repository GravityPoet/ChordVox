export interface ModelDownloadState {
  model: string;
  downloaded?: boolean;
  size_mb?: number;
  size_bytes?: number;
  modelPath?: string;
  path?: string;
}

/**
 * Reconcile UI state after a model delete was accepted (or was already absent).
 * The delete IPC result is authoritative for the target model, so stale download
 * metadata from a refresh response must not keep rendering it as installed.
 */
export function markDeletedModelUnavailable(
  models: readonly ModelDownloadState[],
  deletedModelId: string
): ModelDownloadState[] {
  return models.map((model) => {
    if (model.model !== deletedModelId) return model;

    return {
      ...model,
      downloaded: false,
      size_mb: undefined,
      size_bytes: undefined,
      modelPath: undefined,
      path: undefined,
    };
  });
}
