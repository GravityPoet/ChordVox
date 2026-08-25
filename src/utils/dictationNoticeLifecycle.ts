export type DictationNoticeOverlayAction = "none" | "suppress-capsule" | "hide-window";

interface DictationNoticeOverlayState {
  previousToastCount: number;
  toastCount: number;
  isBusy: boolean;
  isCommandMenuOpen: boolean;
  licenseLimitDialogOpen: boolean;
}

export function getDictationNoticeOverlayAction({
  previousToastCount,
  toastCount,
  isBusy,
  isCommandMenuOpen,
  licenseLimitDialogOpen,
}: DictationNoticeOverlayState): DictationNoticeOverlayAction {
  if (toastCount > 0 && !isBusy && !licenseLimitDialogOpen) {
    return "suppress-capsule";
  }

  if (
    previousToastCount > 0 &&
    toastCount === 0 &&
    !isBusy &&
    !isCommandMenuOpen &&
    !licenseLimitDialogOpen
  ) {
    return "hide-window";
  }

  return "none";
}
