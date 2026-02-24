<h1 align="center">
  <img src="src/assets/icon.png" width="120" height="120" alt="ChordVox Logo"><br/>
  ChordVox IME
</h1>

<p align="center">
  <strong>一款为你节省时间、保护隐私的全局 AI 智能输入法。</strong><br>
  <strong>满足效率需求：</strong>长按快捷键说话，AI 瞬间完成高精度识别与语病润色，松开快捷键直接粘贴排版好的文字，让打字速度终于跟上你的大脑。<br>
  <strong>满足隐私需求：</strong>内置本地大语言模型，无需联网，哪怕是敏感的商业机密和个人隐私，一切数据处理永远只停留在你的本机硬盘上。
</p>

<p align="center">
  <a href="https://github.com/GravityPoet/ChordVox/releases/latest"><img src="https://img.shields.io/github/v/release/GravityPoet/ChordVox?label=release&color=6366f1" alt="Latest Release" /></a>
  <a href="https://github.com/GravityPoet/ChordVox/releases"><img src="https://img.shields.io/github/downloads/GravityPoet/ChordVox/total?style=flat&color=06b6d4" alt="Downloads" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-22c55e" alt="License" /></a>
  <a href="#"><img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-a78bfa" alt="Platform" /></a>
</p>

<p align="center">
  <a href="./README.en.md">English</a> | <strong>中文</strong>
</p>

---

### 一句话简介

> **长按快捷键说话，AI 自动帮你把口语转换成精美的书面文字并瞬间粘贴。纯本地模型为你提供绝对的隐私保护和极速体验。**

---

### 核心特性

- 🔒 **隐私优先，本地运行** — 内置三大语音引擎（whisper.cpp · NVIDIA Parakeet · SenseVoice），音频不出本机。无需 Python 环境，原生二进制开箱即用。

- 💼 **企业级专属特性 (Pro)** — 除基础开源功能外，可平滑升级解锁更强大的商业重度需求：专业领域商业词库注入、复杂的上下文风控机制、反作弊策略及专属极速商用接口集成（即买即用，免去四处寻找和配置第三方 API Key）。

- 🎯 **助手命名与指令模式** — 为 AI 助手设定专属名字。比如对它说“Hi ChordVox，帮我起草一封回信……”，AI 会瞬间从打字模式切换为执行指令的智能助理模式。

- 📖 **专业自定义词典** — 提供内置的专有词汇表。添加你的专属人名、业务黑话、缩写名词，大幅度提升针对特定工作流的转录准确度。

- 🧠 **AI 润色管线** — 语音原文 → 精修成文。对接 OpenAI / Anthropic / Gemini / Groq / 自定义端点，或通过内置 llama.cpp 跑本地 GGUF 模型。支持自动纠正句法、上下文智能修复与排版。

- ⌨️ **光标处落字** — 快捷键一按：录音 → 转写 → 润色 → 粘贴到当前光标，全程无需切换窗口。macOS 使用 AppleScript 精准粘贴，Windows 使用 SendKeys + nircmd，Linux 全覆盖 XTest / xdotool / wtype / ydotool。macOS Globe/Fn 键原生 Swift 监听，Windows 底层键盘钩子，支持真正的 Push-to-Talk。

- 🌍 **58 种语言 · 10 种界面语言** — 自动检测或手动锁定语种。界面完整本地化：中 / 英 / 日 / 德 / 法 / 西 / 葡 / 意 / 俄。

- 🔄 **双配置热键** — 两套独立快捷键绑定不同 STT 引擎、AI 模型与润色策略，一键切换工作流。

- 🧹 **存储空间管理** — 贴心的磁盘清理。在设置面板只需一键即可轻松卸载那些庞大的本地下载的 Whisper / GGUF 模型缓存，释放你的磁盘空间。

---

### 应用场景 / 痛点解决

| 痛点 | ChordVox 方案 |
|---|---|
| 打字太慢，思维跑在手指前面 | 自然说话 → 2 秒内获得精修文本 |
| 云端语音工具将录音发往未知服务器 | 本地 STT，音频不出机器 |
| 语音识别原文粗糙、标点混乱 | AI 润色自动修正语法、标点和排版 |
| 在听写软件和目标应用之间反复切窗 | 光标处直接粘贴，零中断 |
| 专业术语（医学 / 法律 / 代码）被识别错误 | 自定义词典引导模型偏好你的领域用词 |
| 不同任务需要不同 AI 质量 | 双配置热键：一路快速草稿（Groq），一路精修输出（GPT-5 / Claude） |

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

您可以前往 [GitHub Releases](https://github.com/GravityPoet/ChordVox/releases/latest) 页面下载适合您操作系统的最新版本。

#### macOS 首次启动

版本非APP Store下载可能被 Gatekeeper 拦截，执行以下命令解除：

```bash
xattr -dr com.apple.quarantine /Applications/ChordVox.app
open /Applications/ChordVox.app
```

---

### 快速链接

- 📦 [所有版本](https://github.com/GravityPoet/ChordVox/releases)
- 📖 [完整技术文档](docs/README_LEGACY.md)
- 📬 联系方式：`moonlitpoet@proton.me`

---

### 许可证

MIT License. 详见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE) 文件。
