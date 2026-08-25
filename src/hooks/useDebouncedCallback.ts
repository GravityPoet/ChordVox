import { useCallback, useEffect, useMemo, useRef } from "react";

export type DebouncedCallback<T extends (...args: any[]) => any> = ((
  ...args: Parameters<T>
) => void) & {
  cancel: () => void;
  flush: () => void;
};

export function useDebouncedCallback<T extends (...args: any[]) => any>(
  callback: T,
  delay: number
): DebouncedCallback<T> {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingArgsRef = useRef<Parameters<T> | null>(null);
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  const cancel = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    pendingArgsRef.current = null;
  }, []);

  const flush = useCallback(() => {
    const pendingArgs = pendingArgsRef.current;
    if (pendingArgs === null) {
      cancel();
      return;
    }

    cancel();
    callbackRef.current(...pendingArgs);
  }, [cancel]);

  const debounced = useCallback(
    (...args: Parameters<T>) => {
      cancel();
      pendingArgsRef.current = args;

      timeoutRef.current = setTimeout(() => {
        const pendingArgs = pendingArgsRef.current;
        timeoutRef.current = null;
        pendingArgsRef.current = null;
        if (pendingArgs !== null) {
          callbackRef.current(...pendingArgs);
        }
      }, delay);
    },
    [cancel, delay]
  );

  useEffect(() => cancel, [cancel]);

  return useMemo(
    () => Object.assign(debounced, { cancel, flush }) as DebouncedCallback<T>,
    [cancel, debounced, flush]
  );
}
