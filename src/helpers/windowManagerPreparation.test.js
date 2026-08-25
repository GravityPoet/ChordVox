import { describe, expect, it, vi } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const WindowManager = require("./windowManager");

function createManager() {
  let visible = false;
  const mainWindow = {
    isDestroyed: () => false,
    isVisible: () => visible,
    isMinimized: () => false,
    showInactive: vi.fn(() => {
      visible = true;
    }),
    show: vi.fn(() => {
      visible = true;
    }),
    setOpacity: vi.fn(),
    focus: vi.fn(),
    webContents: {
      send: vi.fn(),
    },
  };
  const manager = Object.create(WindowManager.prototype);
  Object.assign(manager, {
    mainWindow,
    _cachedRecordingAnimationStyle: "nebula",
    _dictationUiPreparationSequence: 0,
    _pendingDictationUiPreparation: null,
    _dictationPanelShowGeneration: 0,
    _scheduledDictationPanelShow: null,
    _dictationPanelRevealTimer: null,
    userAnchorCenterX: 640,
    userAnchorBottomY: 800,
    resizeMainWindow: vi.fn(() => ({ success: true })),
    applyVisibleUserAnchor: vi.fn(),
    repositionCommandMenuWindow: vi.fn(),
  });
  return { mainWindow, manager };
}

describe("WindowManager dictation UI preparation", () => {
  it.each([
    ["flow", { width: 504, height: 104 }],
    ["stardust", { width: 504, height: 104 }],
    ["nebula", { width: 320, height: 180 }],
  ])("waits for the %s layout before making the panel visible", async (style, size) => {
    const { mainWindow, manager } = createManager();

    manager.setRecordingAnimationStyleCache(style);
    manager.showDictationPanel();

    const preparationPayload = mainWindow.webContents.send.mock.calls[0][1];
    expect(mainWindow.webContents.send.mock.calls[0][0]).toBe("prepare-dictation-ui");
    expect(mainWindow.showInactive).not.toHaveBeenCalled();

    manager.completeDictationUiPreparation({
      requestId: preparationPayload.requestId,
      animationStyle: style,
      size,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(manager.resizeMainWindow).toHaveBeenCalledWith(size);
    if (process.platform === "darwin") {
      expect(mainWindow.setOpacity).toHaveBeenCalledWith(0);
    } else {
      expect(mainWindow.setOpacity).not.toHaveBeenCalled();
    }
    expect(mainWindow.showInactive).toHaveBeenCalledOnce();
    expect(manager.applyVisibleUserAnchor).toHaveBeenCalledOnce();
  });

  it("re-arms the renderer overlay when the native window is already visible", () => {
    const { mainWindow, manager } = createManager();

    mainWindow.showInactive();
    manager.showDictationPanel({ profileId: "secondary" });

    expect(mainWindow.webContents.send).toHaveBeenCalledWith("prepare-dictation-ui", {
      profileId: "secondary",
    });
    expect(manager.repositionCommandMenuWindow).toHaveBeenCalledOnce();
  });
});
