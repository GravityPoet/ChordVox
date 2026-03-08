export const hasStoredByokKey = () =>
  !!(
    localStorage.getItem("openaiApiKey") ||
    localStorage.getItem("openrouterApiKey") ||
    localStorage.getItem("groqApiKey") ||
    localStorage.getItem("mistralApiKey") ||
    localStorage.getItem("customTranscriptionApiKey")
  );
