"use strict";

const { app, BrowserWindow } = require("electron");
const path = require("path");

for (let index = 0; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  const value =
    arg === "--user-data-dir"
      ? process.argv[index + 1]
      : arg.startsWith("--user-data-dir=")
        ? arg.slice("--user-data-dir=".length)
        : "";
  if (String(value || "").trim()) {
    app.setPath("userData", path.resolve(value));
    break;
  }
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 720,
    height: 260,
    show: true,
    title: "ChordVox Packaged Paste Target",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const html = String.raw`<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>ChordVox Packaged Paste Target</title>
        <style>
          html, body { margin: 0; height: 100%; }
          textarea {
            box-sizing: border-box;
            width: 100%;
            height: 100%;
            border: 0;
            outline: 0;
            padding: 18px;
            resize: none;
            font: 18px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          }
        </style>
      </head>
      <body>
        <textarea id="paste-target" aria-label="Independent paste target" autofocus></textarea>
        <script>
          window.__CHORDVOX_PASTE_TARGET_EVENTS = [];
          const target = document.getElementById("paste-target");
          for (const type of ["paste", "beforeinput", "input", "keydown", "keyup"]) {
            target.addEventListener(type, (event) => {
              window.__CHORDVOX_PASTE_TARGET_EVENTS.push({
                type,
                isTrusted: event.isTrusted,
                inputType: event.inputType || null,
                key: event.key || null,
              });
            });
          }
          target.focus();
          window.addEventListener("focus", () => target.focus());
        </script>
      </body>
    </html>`;

  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  window.show();
  window.focus();
  window.webContents.focus();
});

app.on("window-all-closed", () => app.quit());
