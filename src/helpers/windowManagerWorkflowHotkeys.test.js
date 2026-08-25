import { describe, expect, it, vi } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const WindowManager = require("./windowManager");

function createManager() {
  const registered = new Map();
  const blocked = new Set();
  const globalShortcut = {
    register: vi.fn((accelerator, callback) => {
      if (blocked.has(accelerator) || registered.has(accelerator)) return false;
      registered.set(accelerator, callback);
      return true;
    }),
    unregister: vi.fn((accelerator) => {
      registered.delete(accelerator);
    }),
  };
  const manager = Object.create(WindowManager.prototype);
  Object.assign(manager, {
    globalShortcut,
    workflowHotkeys: new Map(),
    secondaryHotkey: "",
    secondaryHotkeyAccelerator: null,
    hotkeyManager: { getCurrentHotkey: () => "Control+Shift+P" },
    ensureProAccess: vi.fn(async () => ({ allowed: true })),
    createHotkeyCallback: vi.fn((profileId) => () => profileId),
  });
  return { blocked, manager, registered };
}

describe("WindowManager workflow hotkeys", () => {
  it("registers several independent workflow shortcuts", async () => {
    const { manager, registered } = createManager();
    const onChanged = vi.fn();
    manager.setWorkflowHotkeysChangedHandler(onChanged);

    const result = await manager.syncHotkeyWorkflows([
      { id: "workflow-translate", hotkey: "Command+Shift+7", enabled: true },
      { id: "workflow-chat", hotkey: "Command+Shift+8", enabled: true },
    ]);

    expect(result.success).toBe(true);
    expect(manager.workflowHotkeys.size).toBe(2);
    expect(registered.has("Command+Shift+7")).toBe(true);
    expect(registered.has("Command+Shift+8")).toBe(true);
    expect(manager.createHotkeyCallback).toHaveBeenCalledWith("workflow-translate");
    expect(manager.createHotkeyCallback).toHaveBeenCalledWith("workflow-chat");
    expect(manager.hasMacPushWorkflowHotkeys("push")).toBe(true);
    expect(manager.hasMacPushWorkflowHotkeys("tap")).toBe(false);
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("does not require the macOS modifier listener for single-key workflows", async () => {
    const { manager } = createManager();

    await manager.syncHotkeyWorkflows([{ id: "workflow-dictate", hotkey: "F8", enabled: true }]);

    expect(manager.hasMacPushWorkflowHotkeys("push")).toBe(false);
  });

  it("notifies the native-listener sync when workflow shortcuts are cleared", async () => {
    const { manager } = createManager();
    const onChanged = vi.fn();
    manager.setWorkflowHotkeysChangedHandler(onChanged);
    await manager.syncHotkeyWorkflows([
      { id: "workflow-translate", hotkey: "Command+Shift+7", enabled: true },
    ]);

    await manager.unregisterWorkflowHotkeys();

    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(manager.hasMacPushWorkflowHotkeys("push")).toBe(false);
  });

  it("keeps registered workflow shortcuts when the change listener throws", async () => {
    const { manager, registered } = createManager();
    manager.setWorkflowHotkeysChangedHandler(() => {
      throw new Error("listener failed");
    });

    const result = await manager.syncHotkeyWorkflows([
      { id: "workflow-translate", hotkey: "Command+Shift+7", enabled: true },
    ]);

    expect(result.success).toBe(true);
    expect(manager.workflowHotkeys.has("workflow-translate")).toBe(true);
    expect(registered.has("Command+Shift+7")).toBe(true);
  });

  it("keeps the previous working set when a replacement shortcut cannot register", async () => {
    const { blocked, manager, registered } = createManager();
    await manager.syncHotkeyWorkflows([
      { id: "workflow-translate", hotkey: "Command+Shift+7", enabled: true },
      { id: "workflow-chat", hotkey: "Command+Shift+8", enabled: true },
    ]);
    blocked.add("Command+Shift+0");

    const result = await manager.syncHotkeyWorkflows([
      { id: "workflow-polish", hotkey: "Command+Shift+9", enabled: true },
      { id: "workflow-chat", hotkey: "Command+Shift+0", enabled: true },
    ]);

    expect(result.success).toBe(false);
    expect([...manager.workflowHotkeys.keys()]).toEqual(["workflow-translate", "workflow-chat"]);
    expect([...registered.keys()].sort()).toEqual(["Command+Shift+7", "Command+Shift+8"]);
  });

  it("rejects duplicates before disturbing registered workflows", async () => {
    const { manager, registered } = createManager();
    await manager.syncHotkeyWorkflows([
      { id: "workflow-translate", hotkey: "Command+Shift+7", enabled: true },
    ]);

    const result = await manager.syncHotkeyWorkflows([
      { id: "workflow-polish", hotkey: "Command+Shift+9", enabled: true },
      { id: "workflow-chat", hotkey: "command+shift+9", enabled: true },
    ]);

    expect(result.success).toBe(false);
    expect([...registered.keys()]).toEqual(["Command+Shift+7"]);
  });
});
