export const hasStoredByokKey = () =>
  !!(
    localStorage.getItem("openaiApiKey") ||
    localStorage.getItem("openrouterApiKey") ||
    localStorage.getItem("groqApiKey") ||
    localStorage.getItem("cerebrasApiKey") ||
    localStorage.getItem("sonioxApiKey") ||
    localStorage.getItem("deepgramApiKey") ||
    localStorage.getItem("googleSttApiKey") ||
    localStorage.getItem("doubaoAccessToken") ||
    localStorage.getItem("doubaoAppId") ||
    localStorage.getItem("customTranscriptionApiKey")
  );
