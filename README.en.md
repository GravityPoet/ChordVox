
<p align="center">
  <img src="assets/logo.png" alt="ChordVox" width="128" />
</p>

<h1 align="center">ChordVox IME</h1>

<p align="center">
  <strong>"Just speak your mind. Let AI write it out perfectly."</strong><br>
  Type code and reports at the speed of speech. Local, free, and pastes right at your cursor.
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

<p align="center">
  <a href="https://github.com/GravityPoet/ChordVox/releases"><strong>Download</strong></a>
  ·
  <a href="https://github.com/GravityPoet/ChordVox/releases/latest">Latest Release</a>
</p>

---

### Why You Need ChordVox

**What you actually said**:  
> *"Umm... let's have a meeting this afternoon, maybe at 3, invite Bob... oh wait, I mean invite Alice. We need to discuss the UI redesign."*

- 🟢 **Standard Dictation**: Transcribes exactly that, keeping your filler words and hesitations.
- 🚀 **ChordVox AI**: `[Meeting Notice] Time: 3:00 PM today; Attendee: Alice; Topic: UI redesign discussion.`

**💡 A permanently free local speech-to-text engine that turns your spoken thoughts into perfect text.**

---

### Key Features

- ⌨️ **Speak into Text, Pasted Instantly** — One hotkey triggers the flow: record → transcribe → refine → paste right at your blinking cursor. Zero window switching, unbroken train of thought.

- 🧠 **AI Refinement Pipeline** — Raw speech → polished prose. Automatically strips filler words and perfects your punctuation. (*Power users can plug in their own local GGUF or top-tier APIs.*)

- 🎯 **Summon Your Executive Assistant** — Start your sentence with "Hi ChordVox, draft an email...", and it instantly transforms from a dictation tool into an instruction-following assistant.

- 📖 **Learns Your Jargon** — A built-in custom dictionary. Feed it your colleagues' names, coding acronyms, or medical terms, and it will transcribe them flawlessly.

- 🔒 **100% Local (Free Forever)** — Audio processing happens entirely on your machine. No Python setup, no cloud uploads, total privacy.

<details>
<summary><b>👀 Click to reveal hardcore geeky specs</b></summary>
<br>

- **Under the Hood** — Built on whisper.cpp, NVIDIA Parakeet, and SenseVoice. Connects to OpenAI compatible endpoints or uses bundled llama.cpp.
- **System Hooks** — Deep OS integration using AppleScript/Swift (macOS), SendKeys/low-level hooks (Windows), and XTest/ydotool (Linux). 
- **Dual-Profile Hotkeys** — Bind two completely independent hotkey and engine/model workflows.
- **Storage Management** — 1-click removal of hefty Whisper/GGUF model caches.
</details>

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

- [Download ChordVox on GitHub Releases](https://github.com/GravityPoet/ChordVox/releases)
- [Download the latest release](https://github.com/GravityPoet/ChordVox/releases/latest)

Once you open the release page, click the file that matches your system:

- macOS (Apple Silicon): `ChordVox-*-arm64.dmg`
- Windows (x64): `ChordVox-Setup-*.exe`
- Linux (x64): `ChordVox-*-linux-x86_64.AppImage`, `ChordVox-*-linux-amd64.deb`, or `ChordVox-*-linux-x86_64.rpm`

> [!IMPORTANT]
> **Essential for macOS First Launch**: Since this build is not from the App Store, it might be flagged as "damaged" by Gatekeeper. To fix this, run the following command in your terminal:
> ```bash
> xattr -dr com.apple.quarantine /Applications/ChordVox.app
> open /Applications/ChordVox.app
> ```

> Free forever local speech-to-text. Absolute privacy with offline processing.



### Quick Links

- 📦 [All Releases](https://github.com/GravityPoet/ChordVox/releases)
- 📖 [Legacy Technical README](docs/README_LEGACY.md)
- 📬 Contact: `moonlitpoet@proton.me`

---

### License

MIT License. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
