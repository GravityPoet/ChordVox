export type SettingsStorageLike = Pick<
  Storage,
  "clear" | "getItem" | "key" | "length" | "removeItem" | "setItem"
>;

function snapshotStorage(storage: SettingsStorageLike): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key) continue;
    const value = storage.getItem(key);
    if (value !== null) {
      snapshot[key] = value;
    }
  }
  return snapshot;
}

function restoreStorage(storage: SettingsStorageLike, snapshot: Record<string, string>): void {
  storage.clear();
  for (const [key, value] of Object.entries(snapshot)) {
    storage.setItem(key, value);
  }
}

export function replaceImportedSettingsStorage(
  storage: SettingsStorageLike,
  importedData: Record<string, string>,
  knownSettingsKeys: ReadonlySet<string>
): void {
  const previousStorage = snapshotStorage(storage);
  try {
    for (const key of knownSettingsKeys) {
      storage.removeItem(key);
    }
    for (const [key, value] of Object.entries(importedData)) {
      if (!knownSettingsKeys.has(key)) continue;
      storage.setItem(key, value);
    }
  } catch (error) {
    restoreStorage(storage, previousStorage);
    throw error;
  }
}
