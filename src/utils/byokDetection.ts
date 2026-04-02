export const hasStoredByokKey = () =>
  !!(
    localStorage.getItem("openaiApiKey") ||
    localStorage.getItem("openrouterApiKey") ||
    localStorage.getItem("groqApiKey") ||
    localStorage.getItem("doubaoAccessToken") ||
    localStorage.getItem("doubaoAppId") ||
    localStorage.getItem("customTranscriptionApiKey")
  );
