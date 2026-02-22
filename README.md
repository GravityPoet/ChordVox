
<h1 align="center">AriaKey</h1>

<p align="center">
  <strong>Your voice, refined by AI, pasted where you need it.</strong>
</p>

<p align="center">
  <a href="https://github.com/GravityPoet/AriaKey/releases/latest"><img src="https://img.shields.io/github/v/release/GravityPoet/AriaKey?label=release&color=6366f1" alt="Latest Release" /></a>
  <a href="https://github.com/GravityPoet/AriaKey/releases"><img src="https://img.shields.io/github/downloads/GravityPoet/AriaKey/total?style=flat&color=06b6d4" alt="Downloads" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-22c55e" alt="License" /></a>
  <a href="#"><img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-a78bfa" alt="Platform" /></a>
</p>

<p align="center">
  <strong>English</strong> | <a href="./README.zh-CN.md">中文</a>
</p>

---

### One-liner

> **Desktop voice keyboard that transcribes locally, refines with AI, and pastes directly at your cursor — no cloud account required.**

---

### Key Features

- 🔒 **Privacy-first, Local-first** — Ship with built-in STT engines (whisper.cpp · NVIDIA Parakeet · SenseVoice). Your audio never leaves your machine unless you choose it to. Zero Python dependency; a single native binary handles everything.

- 🧠 **AI Refinement Pipeline** — Raw speech → polished text. Connect to OpenAI / Anthropic / Google Gemini / Groq / any OpenAI-compatible endpoint, or run a local GGUF model via bundled llama.cpp. Custom system prompts, named-agent invocation ("Hey Aria, draft an email…"), and per-word custom dictionary for jargon accuracy.

- ⌨️ **Cursor-level Paste** — One hotkey triggers → records → transcribes → refines → pastes at your active cursor. Works across every app on macOS (AppleScript), Windows (SendKeys + nircmd), and Linux (XTest / xdotool / wtype / ydotool). True Push-to-Talk with native keyboard hooks on macOS (Globe/Fn key via Swift listener) and Windows (low-level `WH_KEYBOARD_LL` hook).

- 🌍 **58 Languages · 10 Interface Languages** — Auto-detect or pin your language. Full UI localization in EN / ZH-CN / ZH-TW / JA / DE / FR / ES / PT / IT / RU.

- 🔄 **Dual-Profile Hotkeys** — Bind two independent hotkey profiles, each with its own STT engine, AI model, and refinement strategy. Switch workflows in a single keystroke.

---

### Use Cases / Problems Solved

| Pain Point | AriaKey Solution |
|---|---|
| Typing is slow; you think faster than you type | Speak naturally → get polished text in < 2 seconds |
| Cloud voice tools send audio to unknown servers | Local STT means audio stays on-device |
| Dictation output is raw and messy | AI refinement fixes grammar, punctuation, and formatting automatically |
| Switching between dictation app and target app breaks flow | Paste-at-cursor removes the copy-paste step entirely |
| Enterprise / medical / legal jargon gets mangled | Custom Dictionary biases the model toward your domain-specific terms |
| You need different AI quality for different tasks | Dual-profile hotkeys: one for fast drafts (Groq), one for polished output (GPT-5 / Claude) |

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

### Download

Current stable: [`v1.5.18`](https://github.com/GravityPoet/AriaKey/releases/tag/v1.5.18)

| System | Chip | Format | Link |
|---|---|---|---|
| macOS | Apple Silicon | dmg | [⬇ Download](https://github.com/GravityPoet/AriaKey/releases/download/v1.5.18/AriaKey-1.5.18-arm64.dmg) |
| macOS | Intel | dmg | Coming soon |
| Windows | x64 | exe | Coming soon |
| Linux | x64 | AppImage / deb | Coming soon |

#### macOS First Launch

Unsigned builds may trigger Gatekeeper. Fix with:

```bash
xattr -dr com.apple.quarantine /Applications/AriaKey.app
open /Applications/AriaKey.app
```

---

### Quick Links

- 📦 [All Releases](https://github.com/GravityPoet/AriaKey/releases)
- 📖 [Legacy Technical README](docs/README_LEGACY.md)
- 📬 Contact: `gravitypoet@icloud.com`

---

### License

MIT — derived from an MIT-licensed upstream project. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
