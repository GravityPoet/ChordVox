
<h1 align="center">ChordVox IME</h1>

<p align="center">
  <strong>Still typing manually or fixing speech-to-text typos? Try this entirely local AI dictation app. Speak and instantly get polished text, auto-pasted in one go. Your privacy is in your hands—no registration required, ready to use out of the box. Your mouth is the fastest keyboard.</strong>
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

> **An AI dictation app: speak to input, let AI refine, and auto-paste in one go. We push privacy, efficiency, and AI refinement to the extreme, letting you say goodbye to tedious typing and fixing. No cloud account needed, ready out of the box.**

---

### How Can This App Help You?

| Pain Point | How We Solve It |
|---|---|
| **"Typing is too slow, I lose my train of thought."** | Just say whatever is on your mind. Even if you stutter, it'll spit out a beautiful, coherent text in under 2 seconds. |
| **"I'm afraid to upload meeting notes or papers for fear of leaks."** | **Unplug the internet and use it anyway.** We've embedded a powerful local AI brain directly into the app. Your trade secrets rot safely on your hard drive. |
| **"Dictation apps make too many typos, I still have to fix them."** | Built-in top-tier AI grammar correction. Say filler words or use Yoda syntax—the LLM automatically straightens it into proper formal writing, complete with correct punctuation and formatting. |
| **"I have to copy the transcribed text and switch windows."** | As simple as sending a WhatsApp voice note. Hold a hotkey to speak in any input box; release it, and the polished text is **automatically pasted at your cursor**. No mouse needed. |
| **"My industry has jargon, the AI always gets it wrong."** | Custom dictionaries. Throw your client names and industry jargon in there, and it'll never spell them wrong again. |

---

### Killer Features That Will Change How You Work

- 🔒 **100% Local, Hardcore Privacy Protection** — No messing around with complex Python setups. Download the app, double-click, and open it. Even with a microscope, no one could find your audio leaving this machine.

- 🧠 **AI Refinement (Eradicate Typos and Grammar Errors)** — Top-tier text polishing pipeline. The raw transcript isn't just slapped onto your screen; it is refined through an LLM. Tie it to OpenAI / Claude / Gemini, or run a local model to handle auto-formatting.

- ⌨️ **Walkie-Talkie-Like Immersive Experience** — We use low-level system hooks to catch your global hotkeys. Whether you're in Word, WhatsApp, or a browser, hold your hotkey to speak, and the text is automatically typed for you. This is the ultimate "seamless typing."

- 🎯 **Not Just Dictation, Give Commands Too** — Setup a name for your assistant and tell it: "Hey ChordVox, write a polite salary raise request..." Boom, a perfectly crafted petition appears instantly on your screen.

- 🔄 **Switch Workflows with Ease** — We provide dual hotkey setups. Map one hotkey for quick drafts (fastest transcription) and the other for highly rigorous formal documents (using your strongest reasoning LLM)—without interfering with each other.

---

### Download & Install

👉 **[Go to GitHub Releases to download the latest version](https://github.com/GravityPoet/ChordVox/releases/latest)**

> [!IMPORTANT]
> **macOS Users: Required First-Launch Unlock**
> 
> Because this is an open-source app and not downloaded from the Mac App Store, macOS may block it on its first run. After installing the app for the first time, please open your `Terminal` and run the following command to remove this restriction (this only needs to be done once):
> 
> ```bash
> xattr -dr com.apple.quarantine /Applications/ChordVox.app
> open /Applications/ChordVox.app
> ```
> 
> The code for this software is entirely transparent and open source. You can feel safe running it.

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
