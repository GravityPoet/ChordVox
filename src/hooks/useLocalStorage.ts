import { useState, useCallback, useEffect, useRef } from "react";

const LOCAL_STORAGE_CHANGED_EVENT = "chordvox:local-storage";

function emitLocalStorageChanged(key: string): void {
  window.dispatchEvent(new CustomEvent(LOCAL_STORAGE_CHANGED_EVENT, { detail: { key } }));
  window.electronAPI?.notifyLocalStorageChanged?.(key);
}

export function writeLocalStorageValue(key: string, rawString: string) {
  try {
    localStorage.setItem(key, rawString);
    emitLocalStorageChanged(key);
    return localStorage.getItem(key) === rawString;
  } catch (error) {
    console.error(`Error writeLocalStorageValue for key "${key}":`, error);
    return false;
  }
}

export function useLocalStorage<T>(
  key: string,
  defaultValue: T,
  options?: {
    serialize?: (value: T) => string;
    deserialize?: (value: string) => T;
  }
) {
  const serialize = options?.serialize || JSON.stringify;
  const deserialize = options?.deserialize || JSON.parse;

  const [state, setState] = useState<T>(() => {
    try {
      const item = localStorage.getItem(key);
      if (item === null) {
        // Persist the default so direct localStorage.getItem() reads
        // (e.g. in audioManager, PromptStudio) see the intended value.
        localStorage.setItem(key, serialize(defaultValue));
        return defaultValue;
      }
      return deserialize(item);
    } catch {
      return defaultValue;
    }
  });

  const setValue = useCallback(
    (value: T | ((prevState: T) => T)) => {
      setState((currentState) => {
        try {
          const valueToStore = value instanceof Function ? value(currentState) : value;
          const serializedValue = serialize(valueToStore);
          const currentStored = localStorage.getItem(key);
          if (currentStored !== serializedValue) {
            localStorage.setItem(key, serializedValue);
            queueMicrotask(() => {
              emitLocalStorageChanged(key);
            });
          }
          return valueToStore;
        } catch (error) {
          console.error(`Error setting localStorage key "${key}":`, error);
          return currentState;
        }
      });
    },
    [key, serialize]
  );

  const remove = useCallback(() => {
    try {
      localStorage.removeItem(key);
      queueMicrotask(() => {
        emitLocalStorageChanged(key);
      });
      setState(defaultValue);
    } catch (error) {
      console.error(`Error removing localStorage key "${key}":`, error);
    }
  }, [key, defaultValue]);

  // Callers almost always pass inline deserialize/defaultValue, so keep them in
  // refs: the subscription below must not detach/reattach on every render
  // (useSettings alone mounts ~50 instances of this hook).
  const deserializeRef = useRef(deserialize);
  deserializeRef.current = deserialize;
  const defaultValueRef = useRef(defaultValue);
  defaultValueRef.current = defaultValue;

  useEffect(() => {
    const syncFromStorage = () => {
      try {
        const item = localStorage.getItem(key);
        if (item === null) {
          setState(defaultValueRef.current);
        } else {
          setState(deserializeRef.current(item));
        }
      } catch {
        setState(defaultValueRef.current);
      }
    };
    const handleStorageChange = (e: Event) => {
      const customEvent = e as CustomEvent<{ key: string }>;
      if (customEvent.detail && customEvent.detail.key === key) {
        syncFromStorage();
      }
    };
    const removeIpcListener = window.electronAPI?.onLocalStorageChanged?.((payload) => {
      if (payload?.key === key) {
        syncFromStorage();
      }
    });

    window.addEventListener(LOCAL_STORAGE_CHANGED_EVENT, handleStorageChange);
    return () => {
      window.removeEventListener(LOCAL_STORAGE_CHANGED_EVENT, handleStorageChange);
      removeIpcListener?.();
    };
  }, [key]);

  return [state, setValue, remove] as const;
}
