// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { useLocalStorage, writeLocalStorageValue } from "./useLocalStorage";

class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

const mockStorage = new MemoryStorage();

describe("useLocalStorage Hook Syncing", () => {
  let container: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeAll(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, "localStorage", {
      value: mockStorage,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(global, "localStorage", {
      value: mockStorage,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: mockStorage,
      writable: true,
      configurable: true,
    });
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockStorage.clear();
    Object.defineProperty(window, "electronAPI", {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
    }
    if (container) {
      document.body.removeChild(container);
    }
    container = null;
    root = null;
    mockStorage.clear();
    Object.defineProperty(window, "electronAPI", {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });

  it("synchronizes the value between two hook instances in the same window", async () => {
    let aVal: string | null = null;
    let setA: any = null;
    let bVal: string | null = null;
    let setB: any = null;

    const ComponentA = () => {
      const [val, set] = useLocalStorage("test-sync-key", "default");
      aVal = val;
      setA = set;
      return <div id="comp-a">{val}</div>;
    };

    const ComponentB = () => {
      const [val, set] = useLocalStorage("test-sync-key", "default");
      bVal = val;
      setB = set;
      return <div id="comp-b">{val}</div>;
    };

    // Initial render
    act(() => {
      root!.render(
        <div>
          <ComponentA />
          <ComponentB />
        </div>
      );
    });

    // Wait for React to layout
    await act(async () => {});

    expect(aVal).toBe("default");
    expect(bVal).toBe("default");
    expect(container!.querySelector("#comp-a")!.textContent).toBe("default");
    expect(container!.querySelector("#comp-b")!.textContent).toBe("default");

    // Component A updates key
    act(() => {
      setA("new-value");
    });
    await act(async () => {});

    expect(aVal).toBe("new-value");
    expect(bVal).toBe("new-value");
    expect(container!.querySelector("#comp-a")!.textContent).toBe("new-value");
    expect(container!.querySelector("#comp-b")!.textContent).toBe("new-value");
    expect(mockStorage.getItem("test-sync-key")).toBe(JSON.stringify("new-value"));

    // Component B updates key
    act(() => {
      setB("another-value");
    });
    await act(async () => {});

    expect(aVal).toBe("another-value");
    expect(bVal).toBe("another-value");
    expect(container!.querySelector("#comp-a")!.textContent).toBe("another-value");
    expect(container!.querySelector("#comp-b")!.textContent).toBe("another-value");
    expect(mockStorage.getItem("test-sync-key")).toBe(JSON.stringify("another-value"));
  });

  it("avoids redundant event dispatching if the value is unchanged", async () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    let setA: any = null;

    const TestComponent = () => {
      const [val, set] = useLocalStorage("test-dedup-key", "initial");
      setA = set;
      return <div>{val}</div>;
    };

    act(() => {
      root!.render(<TestComponent />);
    });
    await act(async () => {});

    dispatchSpy.mockClear();
    const notifyLocalStorageChanged = vi.fn();
    Object.defineProperty(window, "electronAPI", {
      value: {
        notifyLocalStorageChanged,
      } satisfies Partial<Window["electronAPI"]>,
      writable: true,
      configurable: true,
    });

    // Set to same value
    act(() => {
      setA("initial");
    });
    await act(async () => {});

    // Should not dispatch any event
    const calls = dispatchSpy.mock.calls.filter(
      (call) => call[0].type === "chordvox:local-storage"
    );
    expect(calls.length).toBe(0);
    expect(notifyLocalStorageChanged).not.toHaveBeenCalled();

    // Set to different value
    act(() => {
      setA("changed");
    });
    await act(async () => {});

    const callsChanged = dispatchSpy.mock.calls.filter(
      (call) => call[0].type === "chordvox:local-storage"
    );
    expect(callsChanged.length).toBe(1);
    expect((callsChanged[0][0] as CustomEvent).detail.key).toBe("test-dedup-key");
    expect(notifyLocalStorageChanged).toHaveBeenCalledWith("test-dedup-key");

    dispatchSpy.mockRestore();
  });

  it("syncs updates triggered by writeLocalStorageValue helper", async () => {
    let aVal: string | null = null;

    const TestComponent = () => {
      const [val] = useLocalStorage("test-helper-key", "default-val");
      aVal = val;
      return <div>{val}</div>;
    };

    act(() => {
      root!.render(<TestComponent />);
    });
    await act(async () => {});

    expect(aVal).toBe("default-val");

    // Call writeLocalStorageValue helper
    act(() => {
      writeLocalStorageValue("test-helper-key", JSON.stringify("external-update"));
    });
    await act(async () => {});

    expect(aVal).toBe("external-update");
  });

  it("syncs updates announced by the Electron localStorage bridge", async () => {
    let aVal: string | null = null;
    let ipcCallback: ((payload: { key?: string }) => void) | null = null;
    const disposeIpcListener = vi.fn();

    Object.defineProperty(window, "electronAPI", {
      value: {
        onLocalStorageChanged: (callback: (payload: { key?: string }) => void) => {
          ipcCallback = callback;
          return disposeIpcListener;
        },
      } satisfies Partial<Window["electronAPI"]>,
      writable: true,
      configurable: true,
    });

    const TestComponent = () => {
      const [val] = useLocalStorage("test-ipc-key", "default-val");
      aVal = val;
      return <div>{val}</div>;
    };

    act(() => {
      root!.render(<TestComponent />);
    });
    await act(async () => {});

    expect(aVal).toBe("default-val");
    mockStorage.setItem("test-ipc-key", JSON.stringify("ipc-update"));

    act(() => {
      ipcCallback?.({ key: "test-ipc-key" });
    });
    await act(async () => {});

    expect(aVal).toBe("ipc-update");

    act(() => {
      root!.unmount();
    });
    root = null;
    expect(disposeIpcListener).toHaveBeenCalledTimes(1);
  });
});
