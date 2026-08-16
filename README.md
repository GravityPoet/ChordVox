<h2 align="center">🌐 <a href="./README.zh.md">中文用户：点击查看中文版本</a></h2>

<p align="center">
  <img src="https://raw.githubusercontent.com/GravityPoet/ChordVox/main/src/assets/icon.png" alt="ChordVox Logo" width="128" />
</p>

<h1 align="center">ChordVox IME</h1>

<p align="center">
  <strong>"Just speak your mind. Let AI write it out perfectly."</strong><br>
  Type code and reports at the speed of speech. Free local dictation, pasted right at your cursor.
</p>

<p align="center">
  <a href="https://github.com/GravityPoet/ChordVox/releases/latest"><img src="https://img.shields.io/github/v/release/GravityPoet/ChordVox?label=release&color=6366f1" alt="Latest Release" /></a>
  <a href="https://github.com/GravityPoet/ChordVox/releases"><img src="https://img.shields.io/github/downloads/GravityPoet/ChordVox/total?style=flat&color=06b6d4" alt="Downloads" /></a>
  <a href="#"><img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-a78bfa" alt="Platform" /></a>
</p>

<p align="center">
  <a href="https://github.com/GravityPoet/ChordVox/releases"><strong>Download</strong></a>
  ·
  <a href="https://github.com/GravityPoet/ChordVox/releases/latest">Latest Release</a>
  ·
  <a href="https://chordvox.com">Website</a>
</p>

<p align="center">
  <strong>Join the ChordVox Community</strong><br>
  Get release updates, ask questions, and share feedback in our Telegram channel:<br>
  <a href="https://t.me/chordvox6">https://t.me/chordvox6</a>
</p>

---

<p align="center">
  <img src="https://chordvox.com/assets/chordvox-demo-en-v35.webp?v=20260410s" alt="ChordVox English Demo" width="100%" />
</p>

---

### Why You Need ChordVox

Typing by hand is a bottleneck—your thoughts flow at **150+ WPM**, but fingers crawl at **40 WPM**.

Standard dictation tools are frustrating: they leave in every filler word, garble punctuation, force you to copy-paste between separate windows, or upload your private voice recordings to cloud servers.

**ChordVox removes every piece of friction:** Press one hotkey, speak naturally, let AI polish your speech into crisp, formatted prose, and watch it paste instantly into whatever app you are using.

> 💡 **Free forever local speech-to-text.** Audio never leaves your machine. Use local AI models or bring your own API keys (BYOK) whenever you want deep refinement.

---

### Before vs. After

| Before ChordVox | With ChordVox |
|---|---|
| Typing speed bottlenecks deep thinking (40 WPM) | Speak naturally at full train-of-thought speed (150+ WPM) |
| Raw dictation dumps filler words: *"Umm, let's meet at 3... no, 4pm"* | AI formats into crisp prose: `[Meeting Notice] Time: 4:00 PM today` |
| Switching to a dictation app, copying text, and pasting back | One shortcut: records, transcribes, refines, and pastes directly at cursor |
| Voice clips and proprietary text uploaded to third-party clouds | 100% offline local transcription (`whisper.cpp`, `Parakeet`, `SenseVoice`) |
| Industry jargon, medical terms, and code acronyms get mangled | Custom dictionary biases the engine toward your domain terms |
| One-size-fits-all model for all dictation tasks | Multi-Shortcut Workflows: instant draft vs. deep reasoning on different keys |

---

### 3 Killer Features

- ⌨️ **Instant Paste at Cursor (Zero Window Switching)**
  - **Result:** Never copy-paste again. Hold your shortcut in VS Code, Slack, Notion, Word, or any browser, speak, and release. ChordVox transcribes, refines, and inserts the result directly where your cursor was blinking.
  - **Under the Hood:** Deep native OS hooks via AppleScript/Swift on macOS, SendKeys/low-level keyboard hooks on Windows, and XTest/ydotool on Linux.

- 🧠 **AI Refinement Pipeline & Executive Assistant**
  - **Result:** Transforms conversational rambles into structured bullet points, executive summaries, or clean code comments. Say *"Hi ChordVox, draft a reply declining this politely..."*, and it switches from dictation to an instruction-following assistant.
  - **Under the Hood:** Connect to OpenAI, Anthropic Claude, Google Gemini, Groq, DeepSeek, or run private local GGUF models via bundled `llama.cpp`.

- 🔒 **100% Private, Free Forever Local STT & BYOK**
  - **Result:** Core transcription runs completely offline on your CPU/GPU. No audio ever touches the network. Bring Your Own Key (BYOK) for cloud AI or use local reasoning for zero-cloud privacy.
  - **Under the Hood:** Built-in high-performance `whisper.cpp`, NVIDIA `Parakeet`, and `SenseVoice` engines with zero Python runtime required.

<details>
<summary><b>👀 Hardcore Geek Specs & Architecture</b></summary>
<br>

```
┌─────────────┐    ┌──────────────────────────┐    ┌─────────────────┐    ┌──────────────┐
│  Hotkey      │───▶│  Audio Capture           │───▶│  STT Engine     │───▶│  AI Refine   │───▶ Paste
│  (Globe/Fn/  │    │  MediaRecorder → IPC     │    │  whisper.cpp    │    │  GPT / Claude│    at
│   Custom)    │    │  → temp .wav file        │    │  Parakeet       │    │  Gemini/Groq │    Cursor
└─────────────┘    └──────────────────────────┘    │  SenseVoice     │    │  Local GGUF  │
                                                    │  Cloud STT      │    └──────────────┘
                                                    └─────────────────┘
```

- **Tech Stack**: Electron 41 · React 19 · TypeScript · Vite · Tailwind CSS v4 · shadcn/ui · better-sqlite3 · whisper.cpp · sherpa-onnx (Parakeet) · llama.cpp · FFmpeg (bundled)
- **Multi-Shortcut Workflows**: Assign independent hotkeys to different workflows with separate transcription and reasoning models.
- **Custom Dictionary**: Add colleague names, internal acronyms, and technical terms to guide both the STT and LLM engines.
- **Model Cache Management**: 1-click cleanup of Whisper/GGUF model caches to reclaim disk space whenever needed.
</details>

---

### Who Needs This / Use Cases

- 👤 **Everyday Users & Everyone:** Casual messaging, searching the web, journaling, posting on social media, and capturing quick thoughts—speak naturally and get crisp, polished text without typing.
- 👨‍💻 **Software Engineers:** Write PR descriptions, code comments, architecture RFCs, and commit messages without taking hands off the thinking flow.
- ✍️ **Writers & Researchers:** Capture first-draft brainstorms, blog posts, and scripts at natural speech velocity.
- 👔 **Managers & Executives:** Triage Slack messages, compose detailed email responses, and summarize meeting outcomes in seconds.
- 🔒 **Privacy-Sensitive Teams:** Legal, medical, and financial professionals who require 100% on-device speech processing with zero third-party telemetry.

---

### Download

- [Download ChordVox on GitHub Releases](https://github.com/GravityPoet/ChordVox/releases)
- [Download the latest release](https://github.com/GravityPoet/ChordVox/releases/latest)

Once you open the release page, click the file that matches your system:

- macOS (Apple Silicon): `ChordVox-*-arm64.dmg`
- Windows (x64): `ChordVox-Setup-*.exe`
- Linux (x64): `ChordVox-*-linux-x86_64.AppImage`, `ChordVox-*-linux-amd64.deb`, or `ChordVox-*-linux-x86_64.rpm`

> [!IMPORTANT]
> **Essential for macOS First Launch**: The macOS customer build uses ChordVox's stable self-signed certificate and is not Apple-notarized. Drag `ChordVox.app` into `Applications`, then open it from Applications. On each new Mac, you will normally need to choose **Open Anyway** in **System Settings > Privacy & Security** once. If it is still blocked, go back to the DMG and double-click `Fix & Open.command` on the right — it only removes the quarantine flag from the installed app and then opens ChordVox.

> Free forever local speech-to-text. AI enhancement, file transcription, BYOK, and advanced workflows are available through optional Pro features.

### Quick Links

- 🌐 [Website chordvox.com](https://chordvox.com)
- 📦 [All Releases](https://github.com/GravityPoet/ChordVox/releases)
- 💬 [Telegram Community](https://t.me/chordvox6)
- 📖 [Legacy Technical README](docs/README_LEGACY.md)
- 📬 Contact: `moonlitpoet@proton.me`

---

### License & Open Source Commitment

ChordVox Community Edition is open source under the **[AGPL-3.0 License](./LICENSE)**.

- **Open Source Free Use:** Free for individual and enterprise use in accordance with AGPL-3.0 terms.
- **Commercial Dual-License:** For proprietary integration or closed-source redistribution without AGPL-3.0 copyleft obligations, please contact `moonlitpoet@proton.me`.
- **Third-Party Attributions:** See [NOTICE](./NOTICE) and [Open Source Notices](./resources/legal/OPEN_SOURCE_NOTICES.txt).