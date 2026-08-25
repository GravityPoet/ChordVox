export interface OpenExternalLinkResult {
  success: boolean;
  error?: string;
}

export interface OpenExternalLinkOptions {
  showError?: boolean;
}

export async function openExternalLink(
  url: string,
  options: OpenExternalLinkOptions = { showError: true }
): Promise<OpenExternalLinkResult> {
  if (window.electronAPI?.openExternal) {
    const result = await window.electronAPI.openExternal(url, options);
    return result?.success
      ? { success: true }
      : { success: false, error: result?.error || "Failed to open external link" };
  }

  const openedWindow = window.open(url, "_blank", "noopener,noreferrer");
  return openedWindow
    ? { success: true }
    : { success: false, error: "The browser blocked the new window" };
}

export function createExternalLinkHandler(url: string) {
  return async (e: React.MouseEvent): Promise<void> => {
    e.preventDefault();
    await openExternalLink(url);
  };
}
