
<h1 align="center">ChordVox IME</h1>

<p align="center">
  <strong>Your voice, refined by AI, pasted where you need it.</strong>
</p>

<p align="center">
  <a href="https://github.com/GravityPoet/ChordVox/releases/latest"><img src="https://img.shields.io/github/v/release/GravityPoet/ChordVox?label=release&color=6366f1" alt="Latest Release" /></a>
  <a href="https://github.com/GravityPoet/ChordVox/releases"><img src="https://img.shields.io/github/downloads/GravityPoet/ChordVox/total?style=flat&color=06b6d4" alt="Downloads" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-22c55e" alt="License" /></a>
  <a href="#"><img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-a78bfa" alt="Platform" /></a>
</p>

<p align="center">
  <strong>English</strong> | <a href="./README.zh.md">中文</a>
</p>

---

### One-liner

> **Desktop voice keyboard that transcribes locally, refines with AI, and pastes directly at your cursor — no cloud account required.**

---

### Key Features

- 🔒 **Privacy-first, Local-first** — Ship with built-in STT engines (whisper.cpp · NVIDIA Parakeet · SenseVoice). Your audio never leaves your machine unless you choose it to. Zero Python dependency; a single native binary handles everything.

- 🎯 **Agent Naming & Command Mode** — Personalize your AI assistant's name. Address it directly ("Hi ChordVox, draft an email…") to instantly switch from normal dictation to instruction-following mode.

- 📖 **Custom Dictionary** — Add domain-specific jargon, names, and technical terms to the in-app dictionary to drastically improve transcription accuracy for your specific workflows.

- 🧠 **AI Refinement Pipeline** — Raw speech → polished text. Connect to OpenAI / Anthropic / Google Gemini / Groq / any OpenAI-compatible endpoint, or run a local GGUF model via bundled llama.cpp. Includes smart contextual repair and format correction.

- ⌨️ **Cursor-level Paste** — One hotkey triggers → records → transcribes → refines → pastes at your active cursor. Works across every app on macOS (AppleScript), Windows (SendKeys + nircmd), and Linux (XTest / xdotool / wtype / ydotool). True Push-to-Talk with native keyboard hooks on macOS (Globe/Fn key via Swift listener) and Windows (low-level `WH_KEYBOARD_LL` hook).

- 🌍 **58 Languages · 10 Interface Languages** — Auto-detect or pin your language. Full UI localization in EN / ZH-CN / ZH-TW / JA / DE / FR / ES / PT / IT / RU.

- 🔄 **Dual-Profile Hotkeys** — Bind two independent hotkey profiles, each with its own STT engine, AI model, and refinement strategy. Switch workflows in a single keystroke.

- 🧹 **Storage Management** — Built-in cache cleanup tools. Easily remove downloaded Whisper/GGUF models to free up disk space with a single click in Settings.

---

### Use Cases / Problems Solved

| Pain Point | ChordVox Solution |
|---|---|
| Typing is slow; you think faster than you type | Speak naturally → get polished text in < 2 seconds |
| Cloud voice tools send audio to unknown servers | Local STT means audio stays on-device |
| Dictation output is raw and messy | AI refinement fixes grammar, punctuation, and formatting automatically |
| Switching between dictation app and target app breaks flow | Paste-at-cursor removes the copy-paste step entirely |
| Enterprise / medical / legal jargon gets mangled | Custom Dictionary biases the model toward your domain-specific terms |
| You need different AI quality for different tasks | Dual-profile hotkeys: one for fast drafts (Groq), one for polished output (GPT-5 / Claude) |

---

### Download & Install

👉 **[Go to GitHub Releases to download the latest version](https://github.com/GravityPoet/ChordVox/releases/latest)**

> [!IMPORTANT]
> **macOS Users: Required First-Launch Unlock**
> 
> Because this open-source app is not self-signed with an Apple Developer certificate, macOS Gatekeeper will block it on the first run. After dragging `ChordVox.app` to your `Applications ` folder, **you must open your `Terminal` and run this command once to unlock the app**:
> 
> ```bash
> xattr -dr com.apple.quarantine /Applications/ChordVox.app
> open /Applications/ChordVox.app
> ```

---

### How It Works

```
┌─────────────┐    ┌──────────────────────────┐    ┌─────────────────┐    ┌──────────────┐
│  Hotkey      │───▶│  Audio Capture           │───▶│  STT Engine     │───▶│  AI Refine   │───▶ Paste
│  (Globe/Fn/  │    │  MediaRecorder → IPC     │    │  whisper.cpp    │    │  GPT / Claude│    at
│   Custom)    │    │  → temp .wav file        │    │  Parakeet       │    │  Gemini/Groq │    Cursor
└─────────────┘    └──────────────────────────┘    │  SenseVoice     │    │  Local GGUF  │
                                                    │  Cloud STT      │    └──────────────┘
                                                    └─────────────────┘
```

**Tech Stack**: Electron 36 · React 19 · TypeScript · Vite · Tailwind CSS v4 · shadcn/ui · better-sqlite3 · whisper.cpp · sherpa-onnx (Parakeet) · llama.cpp · FFmpeg (bundled)

---


### Quick Links

- 📦 [All Releases](https://github.com/GravityPoet/ChordVox/releases)
- 📖 [Legacy Technical README](docs/README_LEGACY.md)
- 📬 Contact: `moonlitpoet@proton.me`

---

### License

MIT License. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
