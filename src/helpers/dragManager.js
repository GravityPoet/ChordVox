const { screen } = require("electron");
const { clampVisiblePanelPosition, clampWindowPositionToWorkArea } = require("./windowConfig");

class DragManager {
  constructor() {
    this.isDragging = false;
    this.dragOffset = { x: 0, y: 0 };
    this.mouseTrackingInterval = null;
    this.targetWindow = null;
  }

  setTargetWindow(window) {
    this.targetWindow = window;
  }

  async startWindowDrag() {
    if (!this.targetWindow || this.targetWindow.isDestroyed()) {
      return { success: false, message: "Window not available" };
    }

    try {
      this.isDragging = true;

      // Get current cursor position
      const cursorPos = screen.getCursorScreenPoint();
      const windowPos = this.targetWindow.getPosition();

      // Calculate offset from cursor to window position
      this.dragOffset = {
        x: cursorPos.x - windowPos[0],
        y: cursorPos.y - windowPos[1],
      };

      // Start tracking mouse movements
      this.setupMouseTracking();

      console.log("🖱️ Window drag started");
      return { success: true };
    } catch (error) {
      console.error("Failed to start window drag:", error);
      this.isDragging = false;
      return { success: false, message: error.message };
    }
  }

  async stopWindowDrag() {
    try {
      this.isDragging = false;
      this.stopMouseTracking();
      console.log("🖱️ Window drag stopped");
      return { success: true };
    } catch (error) {
      console.error("Failed to stop window drag:", error);
      return { success: false, message: error.message };
    }
  }

  setupMouseTracking() {
    if (this.mouseTrackingInterval) {
      clearInterval(this.mouseTrackingInterval);
    }

    this.mouseTrackingInterval = setInterval(() => {
      if (this.isDragging && this.targetWindow && !this.targetWindow.isDestroyed()) {
        this.updateWindowPosition();
      }
    }, 16); // ~60fps
  }

  updateWindowPosition() {
    try {
      const cursorPos = screen.getCursorScreenPoint();
      const newX = cursorPos.x - this.dragOffset.x;
      const newY = cursorPos.y - this.dragOffset.y;

      // Get the active display. On macOS the user must be able to place the
      // floating orb over the Dock region; a visible panel can stay there even
      // though macOS clamps hidden panels to workArea when they are revealed.
      const display = screen.getDisplayNearestPoint(cursorPos);
      const workArea = display.workArea || display.bounds;
      const displayBounds = display.bounds || workArea;

      // Get window size for boundary calculations
      const windowBounds = this.targetWindow.getBounds();

      // Manual dragging uses the full macOS display. Show-time placement is
      // handled separately by WindowManager so this does not reintroduce the
      // hidden-panel reveal jump.
      const requestedPosition = { x: newX, y: newY };
      const windowSize = { width: windowBounds.width, height: windowBounds.height };
      const { x: constrainedX, y: constrainedY } =
        process.platform === "darwin"
          ? clampVisiblePanelPosition(requestedPosition, windowSize, workArea, displayBounds)
          : clampWindowPositionToWorkArea(requestedPosition, windowSize, workArea);

      this.targetWindow.setPosition(constrainedX, constrainedY);
    } catch (error) {
      console.error("Error updating window position:", error);
      this.stopWindowDrag();
    }
  }

  stopMouseTracking() {
    if (this.mouseTrackingInterval) {
      clearInterval(this.mouseTrackingInterval);
      this.mouseTrackingInterval = null;
    }
  }

  isDragActive() {
    return this.isDragging;
  }

  getDragOffset() {
    return { ...this.dragOffset };
  }

  cleanup() {
    this.stopWindowDrag();
    this.targetWindow = null;
  }
}

module.exports = DragManager;
