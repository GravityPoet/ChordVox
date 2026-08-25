const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("macPrivacyHelper", {
  startDrag: () => ipcRenderer.send("start-mac-app-bundle-drag"),
  reveal: () => ipcRenderer.invoke("reveal-mac-app-bundle"),
  openSettings: (permission) => ipcRenderer.invoke("open-mac-privacy-helper-settings", permission),
  close: () => ipcRenderer.invoke("hide-mac-privacy-drag-helper"),
});
