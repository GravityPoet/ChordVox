function shouldHideDictationWindowBeforePaste(mainWindow, platform = process.platform) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }

  if (mainWindow.isFocused()) {
    return true;
  }

  // A trusted pointer click can make the Windows overlay the foreground
  // window before Electron's isFocused() state catches up. Hiding any visible
  // overlay lets Windows reactivate the user's previous target before Ctrl+V.
  return platform === "win32" && mainWindow.isVisible();
}

module.exports = { shouldHideDictationWindowBeforePaste };
