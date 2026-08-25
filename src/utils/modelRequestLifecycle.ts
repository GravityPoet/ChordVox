export const APP_SHUTTING_DOWN_CODE = "ERR_APP_SHUTTING_DOWN";

type ErrorLike = {
  code?: unknown;
  message?: unknown;
  response?: {
    code?: unknown;
    message?: unknown;
  };
};

export function isAppShuttingDownError(error: unknown): boolean {
  if (typeof error === "string") {
    return error.trim() === "Application is shutting down";
  }

  if (!error || typeof error !== "object") return false;

  const candidate = error as ErrorLike;
  const code = String(candidate.code || candidate.response?.code || "").trim();
  const message = String(candidate.message || candidate.response?.message || "").trim();

  return code === APP_SHUTTING_DOWN_CODE || message === "Application is shutting down";
}
