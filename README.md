<p align="center">
  <img src="resources/icon.png" width="120" alt="AriaKey Logo" />
</p>

<h1 align="center">AriaKey</h1>

<p align="center">
  <strong>Your voice, refined by AI, pasted where you need it.</strong><br/>
  <strong>开口即输入，AI 润色，光标处落字。</strong>
</p>

<p align="center">
  <a href="https://github.com/GravityPoet/AriaKey/releases/latest"><img src="https://img.shields.io/github/v/release/GravityPoet/AriaKey?label=release&color=6366f1" alt="Latest Release" /></a>
  <a href="https://github.com/GravityPoet/AriaKey/releases"><img src="https://img.shields.io/github/downloads/GravityPoet/AriaKey/total?style=flat&color=06b6d4" alt="Downloads" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-22c55e" alt="License" /></a>
  <a href="#"><img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-a78bfa" alt="Platform" /></a>
</p>

---

## English

### One-liner

> **Desktop voice keyboard that transcribes locally, refines with AI, and pastes directly at your cursor — no cloud account required.**

### Key Features

- 🔒 **Privacy-first, Local-first** — Ship with built-in STT engines (whisper.cpp · NVIDIA Parakeet · SenseVoice). Your audio never leaves your machine unless you choose it to. Zero Python dependency; a single native binary handles everything.

- 🧠 **AI Refinement Pipeline** — Raw speech → polished text. Connect to OpenAI / Anthropic / Google Gemini / Groq / any OpenAI-compatible endpoint, or run a local GGUF model via bundled llama.cpp. Custom system prompts, named-agent invocation ("Hey Aria, draft an email…"), and per-word custom dictionary for jargon accuracy.

- ⌨️ **Cursor-level Paste** — One hotkey triggers → records → transcribes → refines → pastes at your active cursor. Works across every app on macOS (AppleScript), Windows (SendKeys + nircmd), and Linux (XTest / xdotool / wtype / ydotool). True Push-to-Talk with native keyboard hooks on macOS (Globe/Fn key via Swift listener) and Windows (low-level `WH_KEYBOARD_LL` hook).

- 🌍 **58 Languages · 10 Interface Languages** — Auto-detect or pin your language. Full UI localization in EN / ZH-CN / ZH-TW / JA / DE / FR / ES / PT / IT / RU.

- 🔄 **Dual-Profile Hotkeys** — Bind two independent hotkey profiles, each with its own STT engine, AI model, and refinement strategy. Switch workflows in a single keystroke.

### Use Cases / Problems Solved

| Pain Point | AriaKey Solution |
|---|---|
| Typing is slow; you think faster than you type | Speak naturally → get polished text in < 2 seconds |
| Cloud voice tools send audio to unknown servers | Local STT means audio stays on-device |
| Dictation output is raw and messy | AI refinement fixes grammar, punctuation, and formatting automatically |
| Switching between dictation app and target app breaks flow | Paste-at-cursor removes the copy-paste step entirely |
| Enterprise / medical / legal jargon gets mangled | Custom Dictionary biases the model toward your domain-specific terms |
| You need different AI quality for different tasks | Dual-profile hotkeys: one for fast drafts (Groq), one for polished output (GPT-5 / Claude) |

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

## 中文

### 一句话简介

> **桌面级 AI 语音输入法 — 本地转录、AI 润色、光标处自动粘贴，开箱即用，无需联网账号。**

### 核心特性

- 🔒 **隐私优先，本地运行** — 内置三大语音引擎（whisper.cpp · NVIDIA Parakeet · SenseVoice），音频不出本机。无需 Python 环境，原生二进制开箱即用。

- 🧠 **AI 润色管线** — 语音原文 → 精修成文。对接 OpenAI / Anthropic / Gemini / Groq / 自定义端点，或通过内置 llama.cpp 跑本地 GGUF 模型。支持自定义系统提示词、命名式 Agent 唤醒（"Hey Aria，帮我草拟一封邮件……"），与专业术语自定义词典。

- ⌨️ **光标处落字** — 快捷键一按：录音 → 转写 → 润色 → 粘贴到当前光标，全程无需切换窗口。macOS 使用 AppleScript 精准粘贴，Windows 使用 SendKeys + nircmd，Linux 全覆盖 XTest / xdotool / wtype / ydotool。macOS Globe/Fn 键原生 Swift 监听，Windows 底层键盘钩子，支持真 Push-to-Talk。

- 🌍 **58 种语言 · 10 种界面语言** — 自动检测或手动锁定语种。界面完整本地化：中 / 英 / 日 / 德 / 法 / 西 / 葡 / 意 / 俄。

- 🔄 **双配置热键** — 两套独立快捷键绑定不同 STT 引擎、AI 模型与润色策略，一键切换工作流。

### 应用场景 / 痛点解决

| 痛点 | AriaKey 方案 |
|---|---|
| 打字太慢，思维跑在手指前面 | 自然说话 → 2 秒内获得精修文本 |
| 云端语音工具将录音发往未知服务器 | 本地 STT，音频不出机器 |
| 语音识别原文粗糙、标点混乱 | AI 润色自动修正语法、标点和排版 |
| 在听写软件和目标应用之间反复切窗 | 光标处直接粘贴，不需要 Ctrl+V |
| 专业术语（医学/法律/代码）被识别错误 | 自定义词典引导模型偏好你的领域用词 |
| 不同任务需要不同 AI 质量 | 双配置热键：一路快速草稿（Groq），一路精修输出（GPT-5 / Claude） |

### 运行机制

```
┌─────────────┐    ┌──────────────────────────┐    ┌─────────────────┐    ┌──────────────┐
│  快捷键      │───▶│  音频采集                │───▶│  语音引擎       │───▶│  AI 润色     │───▶ 粘贴至
│  (Globe/Fn/  │    │  MediaRecorder → IPC     │    │  whisper.cpp    │    │  GPT / Claude│    光标
│   自定义)    │    │  → 临时 .wav 文件        │    │  Parakeet       │    │  Gemini/Groq │
└─────────────┘    └──────────────────────────┘    │  SenseVoice     │    │  本地 GGUF   │
                                                    │  云端 STT       │    └──────────────┘
                                                    └─────────────────┘
```

**技术栈**：Electron 36 · React 19 · TypeScript · Vite · Tailwind CSS v4 · shadcn/ui · better-sqlite3 · whisper.cpp · sherpa-onnx (Parakeet) · llama.cpp · FFmpeg（内置）

---

## Download / 下载

Current stable / 当前稳定版：[`v1.5.18`](https://github.com/GravityPoet/AriaKey/releases/tag/v1.5.18)

| System 系统 | Chip 芯片 | Format 格式 | Link 下载 |
|---|---|---|---|
| macOS | Apple Silicon | dmg | [⬇ Download](https://github.com/GravityPoet/AriaKey/releases/download/v1.5.18/AriaKey-1.5.18-arm64.dmg) |
| macOS | Intel | dmg | Coming soon |
| Windows | x64 | exe | Coming soon |
| Linux | x64 | AppImage / deb | Coming soon |

### macOS First Launch / macOS 首次启动

Unsigned builds may trigger Gatekeeper. Fix with:
未公证版本可能被拦截，执行以下命令解除：

```bash
xattr -dr com.apple.quarantine /Applications/AriaKey.app
open /Applications/AriaKey.app
```

---

## Quick Links

- 📦 [All Releases](https://github.com/GravityPoet/AriaKey/releases)
- 📖 [Legacy Technical README](docs/README_LEGACY.md)
- 📬 Contact: `moonlitpoet@proton.me`

---

## License

MIT — derived from an MIT-licensed upstream project. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
