<p align="center">
  <img src="assets/logo.png" alt="ChordVox" width="128" />
</p>

<h1 align="center">ChordVox AI语音输入法</h1>

<p align="center">
  <strong>还在手动打字 or 改语音识别的错别字？</strong>
</p>

<h2 align="center">你的嘴，就是最快的键盘。</h2>

<p align="center">
  <strong>说话秒变精修长文，自动粘贴一气呵成。</strong><br/>
  纯本地免费，隐私掌握在你手中。
</p>

<p align="center">
  <a href="https://github.com/GravityPoet/ChordVox/releases/latest"><img src="https://img.shields.io/github/v/release/GravityPoet/ChordVox?label=release&color=6366f1" alt="Latest Release" /></a>
  <a href="https://github.com/GravityPoet/ChordVox/releases"><img src="https://img.shields.io/github/downloads/GravityPoet/ChordVox/total?style=flat&color=06b6d4" alt="Downloads" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-22c55e" alt="License" /></a>
  <a href="#"><img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-a78bfa" alt="Platform" /></a>
</p>

<p align="center">
  <strong>选择语言：</strong><br/>
  <a href="./README.md"><img src="assets/button-english-homepage-v2.svg" alt="English Homepage" /></a>
  <a href="./README.zh.md"><img src="assets/button-zh-intro-v2.svg" alt="中文介绍页面" /></a>
</p>

<p align="center">
  <a href="https://github.com/GravityPoet/ChordVox/releases"><strong>下载</strong></a>
</p>

<p align="center">
  <img src="assets/chordvox-demo.webp" alt="ChordVox 演示" width="100%" />
</p>

---

### 应用场景 / 痛点解决

| 😩 痛点 | ✅ ChordVox 方案 |
|---|---|
| 打字太慢，思维跑在手指前面 | 自然说话 → 2 秒内获得精修文本 |
| 云端语音工具将录音发往未知服务器 | 本地 STT，音频不出机器 |
| 语音识别原文粗糙、标点混乱 | AI 润色自动修正语法、标点和排版 |
| 在听写软件和目标应用之间反复切窗 | 光标处直接粘贴，零中断 |
| 专业术语（医学 / 法律 / 代码）被识别错误 | 自定义词典引导模型偏好你的领域用词 |
| 不同任务需要不同 AI 质量 | 双配置热键：一路快速草稿（Groq），一路精修输出（GPT-5 / Claude） |

---

### 核心特性

- 🔒 **隐私优先，本地运行** — 内置三大语音引擎（whisper.cpp · NVIDIA Parakeet · SenseVoice），音频不出本机。无需 Python 环境，原生二进制开箱即用。

- 🧠 **AI 润色管线** — 语音原文 → 精修成文。对接 OpenAI / Anthropic / Gemini / Groq / 自定义端点，或通过内置 llama.cpp 跑本地 GGUF 模型。支持自动纠正句法、上下文智能修复与排版。

- ⌨️ **光标处落字** — 快捷键一按：录音 → 转写 → 润色 → 粘贴到当前光标，全程无需切换窗口。macOS Globe/Fn 键原生 Swift 监听，Windows 底层键盘钩子，支持真正的 Push-to-Talk。

- 🎯 **助手命名与指令模式** — 为 AI 助手设定专属名字。对它说"Hi ChordVox，帮我起草一封回信……"，AI 瞬间从打字模式切换为智能助理模式。

- 📖 **专业自定义词典** — 添加专属人名、术语、缩写，大幅提升医学 / 法律 / 代码等领域的转录准确度。

- 🌍 **58 种语言 · 10 种界面语言** — 自动检测或手动锁定语种。界面完整本地化：中 / 英 / 日 / 德 / 法 / 西 / 葡 / 意 / 俄。

- 🔄 **双配置热键** — 两套独立快捷键绑定不同 STT 引擎、AI 模型与润色策略，一键切换工作流。

- 🧹 **存储空间管理** — 在设置面板一键卸载 Whisper / GGUF 模型缓存，释放磁盘空间。

---

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

### 下载

<p align="center">
  <a href="https://github.com/GravityPoet/ChordVox/releases"><img src="https://img.shields.io/badge/%E4%B8%8B%E8%BD%BD-111827?style=for-the-badge" alt="下载" /></a>
</p>

进入发布页后，如有需要先点 `Show all assets`，再选择你的系统对应文件：

- macOS（Apple Silicon）：`ChordVox-*-arm64.dmg`
- Windows（x64）：`ChordVox-Setup-*.exe`
- Linux（x64）：`ChordVox-*-linux-x86_64.AppImage`、`ChordVox-*-linux-amd64.deb` 或 `ChordVox-*-linux-x86_64.rpm`

> 永久免费本地语音转文字。AI 文本增强、文件转录、BYOK 和高级工作流可选 Pro。

#### macOS 首次启动

非 App Store 下载可能被 Gatekeeper 拦截，执行以下命令解除：

```bash
xattr -dr com.apple.quarantine /Applications/ChordVox.app && open /Applications/ChordVox.app
```

---

### 快速链接

- 🌐 [官网 chordvox.com](https://chordvox.com)
- 📦 [所有版本](https://github.com/GravityPoet/ChordVox/releases)
- 📖 [完整技术文档](docs/README_LEGACY.md)
- 📬 联系方式：`moonlitpoet@proton.me`

---

### 许可证

MIT License. 详见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE) 文件。
