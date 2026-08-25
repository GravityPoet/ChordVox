export type WindowSurface = "control-panel" | "command-menu" | "completion-alert" | "dictation";

type LocationLike = Pick<Location, "pathname" | "search">;

const CONTROL_PANEL_PATHS = new Set(["/control", "/control-panel"]);

export function resolveWindowSurface(location: LocationLike): WindowSurface {
  const params = new URLSearchParams(location.search || "");
  if (params.get("commandMenu") === "true") return "command-menu";
  if (params.get("completionAlert") === "fileTranscription") return "completion-alert";

  const normalizedPath = `/${String(location.pathname || "")
    .split("/")
    .filter(Boolean)
    .join("/")}`.toLowerCase();
  if (params.get("panel") === "true" || CONTROL_PANEL_PATHS.has(normalizedPath)) {
    return "control-panel";
  }

  return "dictation";
}
