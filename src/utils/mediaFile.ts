const SUPPORTED_MEDIA_EXTENSIONS = new Set([
  "aac",
  "aiff",
  "avi",
  "flac",
  "m4a",
  "m4v",
  "mka",
  "mkv",
  "mov",
  "mp3",
  "mp4",
  "mpeg",
  "mpg",
  "oga",
  "ogg",
  "opus",
  "wav",
  "webm",
  "wma",
]);

const VIDEO_EXTENSIONS = new Set(["avi", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "webm"]);

export const SUPPORTED_MEDIA_ACCEPT =
  "audio/*,video/*,.aac,.aiff,.avi,.flac,.m4a,.m4v,.mka,.mkv,.mov,.mp3,.mp4,.mpeg,.mpg,.oga,.ogg,.opus,.wav,.webm,.wma";

function getFileExtension(fileName: string): string {
  const match = String(fileName || "")
    .trim()
    .toLowerCase()
    .match(/\.([a-z0-9]+)$/);
  return match?.[1] || "";
}

export function isSupportedMediaFile(file: Pick<File, "name" | "type">): boolean {
  const mimeType = String(file?.type || "")
    .trim()
    .toLowerCase();
  if (mimeType.startsWith("audio/") || mimeType.startsWith("video/")) {
    return true;
  }

  return SUPPORTED_MEDIA_EXTENSIONS.has(getFileExtension(file?.name || ""));
}

export async function getMediaDurationSeconds(
  file: File,
  timeoutMs = 3000
): Promise<number | undefined> {
  if (typeof document === "undefined" || typeof URL?.createObjectURL !== "function") {
    return undefined;
  }

  const extension = getFileExtension(file?.name || "");
  const mimeType = String(file?.type || "").toLowerCase();
  const element = document.createElement(
    mimeType.startsWith("video/") || VIDEO_EXTENSIONS.has(extension) ? "video" : "audio"
  );
  let objectUrl: string;
  try {
    objectUrl = URL.createObjectURL(file);
  } catch {
    return undefined;
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (duration?: number) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      try {
        element.removeAttribute("src");
        element.load();
      } catch {
        // Metadata is best-effort and must never block transcription.
      }
      URL.revokeObjectURL(objectUrl);
      resolve(Number.isFinite(duration) && Number(duration) > 0 ? Number(duration) : undefined);
    };
    const timer = window.setTimeout(() => finish(), Math.max(250, timeoutMs));

    element.preload = "metadata";
    element.onloadedmetadata = () => finish(element.duration);
    element.onerror = () => finish();
    element.src = objectUrl;
  });
}
