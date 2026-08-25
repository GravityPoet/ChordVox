export const PRO_REASONING_PREVIEW_DAILY_LIMIT = 10;
export const PRO_REASONING_PREVIEW_USAGE_KEY = "proReasoningPreviewDailyUsage";
const PRO_REASONING_PREVIEW_AUTO_DISABLED_KEY = "proReasoningPreviewAutoDisabled";
export const REASONING_MODEL_SETTING_CHANGED_EVENT = "chordvox:reasoning-model-setting-changed";
const REASONING_LIMIT_DIALOG_SEEN_PREFIX = "chordvox:reasoning-preview-limit-dialog-seen:";
const LOCAL_STORAGE_CHANGED_EVENT = "chordvox:local-storage";

export interface ReasoningPreviewQuota {
  dateKey: string;
  limit: number;
  used: number;
  remaining: number;
}

interface ReasoningPreviewAutoDisabledState {
  dateKey: string;
}

function getLocalDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function clampReasoningPreviewUsed(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.min(PRO_REASONING_PREVIEW_DAILY_LIMIT, Math.floor(parsed)));
}

function getBrowserStorage(storage?: Storage | null): Storage | null {
  if (storage) return storage;
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

export function getReasoningPreviewQuota(
  storage?: Storage | null,
  date = new Date()
): ReasoningPreviewQuota {
  const targetStorage = getBrowserStorage(storage);
  const dateKey = getLocalDateKey(date);
  let used = 0;

  try {
    const raw = targetStorage?.getItem(PRO_REASONING_PREVIEW_USAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as { dateKey?: unknown; used?: unknown }) : null;
    if (parsed?.dateKey === dateKey) {
      used = clampReasoningPreviewUsed(parsed.used);
    }
  } catch {
    used = 0;
  }

  return {
    dateKey,
    limit: PRO_REASONING_PREVIEW_DAILY_LIMIT,
    used,
    remaining: Math.max(0, PRO_REASONING_PREVIEW_DAILY_LIMIT - used),
  };
}

export function writeReasoningPreviewUsage(
  usage: Pick<ReasoningPreviewQuota, "dateKey" | "used">,
  storage?: Storage | null
): void {
  const targetStorage = getBrowserStorage(storage);
  if (!targetStorage) return;

  targetStorage.setItem(
    PRO_REASONING_PREVIEW_USAGE_KEY,
    JSON.stringify({
      dateKey: usage.dateKey,
      used: clampReasoningPreviewUsed(usage.used),
      updatedAt: new Date().toISOString(),
    })
  );
}

export function consumeReasoningPreviewQuota(storage?: Storage | null): ReasoningPreviewQuota {
  const quota = getReasoningPreviewQuota(storage);
  const nextQuota = {
    ...quota,
    used: Math.min(PRO_REASONING_PREVIEW_DAILY_LIMIT, quota.used + 1),
  };
  const consumed = {
    ...nextQuota,
    remaining: Math.max(0, PRO_REASONING_PREVIEW_DAILY_LIMIT - nextQuota.used),
  };
  writeReasoningPreviewUsage(consumed, storage);
  return consumed;
}

function dispatchReasoningModelSettingChanged(useReasoningModel: boolean): void {
  if (typeof window === "undefined") return;

  window.dispatchEvent(
    new CustomEvent(REASONING_MODEL_SETTING_CHANGED_EVENT, {
      detail: { useReasoningModel },
    })
  );
  window.dispatchEvent(
    new CustomEvent(LOCAL_STORAGE_CHANGED_EVENT, {
      detail: { key: "useReasoningModel" },
    })
  );
  window.electronAPI?.notifyLocalStorageChanged?.("useReasoningModel");
}

function parseAutoDisabledState(raw: string | null): ReasoningPreviewAutoDisabledState | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as { dateKey?: unknown };
    return typeof parsed.dateKey === "string" && parsed.dateKey
      ? { dateKey: parsed.dateKey }
      : null;
  } catch {
    return null;
  }
}

export function isReasoningModelAutoDisabledForPreviewLimit(
  storage?: Storage | null,
  date = new Date()
): boolean {
  const targetStorage = getBrowserStorage(storage);
  if (!targetStorage) return false;

  const state = parseAutoDisabledState(
    targetStorage.getItem(PRO_REASONING_PREVIEW_AUTO_DISABLED_KEY)
  );
  if (!state) return false;

  const quota = getReasoningPreviewQuota(targetStorage, date);
  return state.dateKey === quota.dateKey && quota.remaining <= 0;
}

export function disableReasoningModelForPreviewLimit(storage?: Storage | null): void {
  const targetStorage = getBrowserStorage(storage);
  if (!targetStorage) return;

  const quota = getReasoningPreviewQuota(targetStorage);
  targetStorage.setItem(
    PRO_REASONING_PREVIEW_AUTO_DISABLED_KEY,
    JSON.stringify({
      dateKey: quota.dateKey,
      disabledAt: new Date().toISOString(),
    })
  );
  targetStorage.setItem("useReasoningModel", "false");
  dispatchReasoningModelSettingChanged(false);
}

function getReasoningLimitSeenKey(dateKey: string, storage?: Storage | null): string {
  const resolvedDateKey = dateKey || getReasoningPreviewQuota(storage).dateKey;
  return `${REASONING_LIMIT_DIALOG_SEEN_PREFIX}${resolvedDateKey}`;
}

/** The daily limit dialog is shown at most once per local day. `mark` runs when
    the dialog opens (not on dismiss) so repeated limit notices from subsequent
    dictations stay silent even if the user never interacts with the dialog. */
export function hasSeenReasoningLimitDialog(dateKey: string, storage?: Storage | null): boolean {
  const targetStorage = getBrowserStorage(storage);
  try {
    return targetStorage?.getItem(getReasoningLimitSeenKey(dateKey, targetStorage)) === "1";
  } catch {
    return false;
  }
}

export function markReasoningLimitDialogSeen(dateKey: string, storage?: Storage | null): void {
  const targetStorage = getBrowserStorage(storage);
  try {
    targetStorage?.setItem(getReasoningLimitSeenKey(dateKey, targetStorage), "1");
  } catch {
    // Ignore storage failures; the dialog will simply be shown again later.
  }
}

export function restoreReasoningModelAfterPreviewReset(
  storage?: Storage | null,
  date = new Date()
): boolean {
  const targetStorage = getBrowserStorage(storage);
  if (!targetStorage) return false;

  const rawState = targetStorage.getItem(PRO_REASONING_PREVIEW_AUTO_DISABLED_KEY);
  const state = parseAutoDisabledState(rawState);
  if (!state) {
    if (rawState) {
      targetStorage.removeItem(PRO_REASONING_PREVIEW_AUTO_DISABLED_KEY);
    }
    return false;
  }

  if (targetStorage.getItem("useReasoningModel") === "true") {
    targetStorage.removeItem(PRO_REASONING_PREVIEW_AUTO_DISABLED_KEY);
    return false;
  }

  const quota = getReasoningPreviewQuota(targetStorage, date);
  if (state.dateKey === quota.dateKey || quota.remaining <= 0) {
    return false;
  }

  targetStorage.setItem("useReasoningModel", "true");
  targetStorage.removeItem(PRO_REASONING_PREVIEW_AUTO_DISABLED_KEY);
  dispatchReasoningModelSettingChanged(true);
  return true;
}
