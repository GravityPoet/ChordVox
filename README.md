<h1 align="center">ChordVox IME</h1>

<p align="center">
  <strong>“你的嘴巴只管说，AI 负责把它们变成完美的文章。”</strong><br>
  用说话的速度写代码和报告。本地免费，光标处直接落字。
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

<p align="center">
  <a href="https://github.com/GravityPoet/ChordVox/releases"><strong>下载</strong></a>
  ·
  <a href="https://github.com/GravityPoet/ChordVox/releases/latest">最新版本</a>
</p>

<!-- 演示视频/GIF 占位符：后续我们会将录制好的 WebP 动图或者 GIF 放在这里 -->
<p align="center">
  <img src="https://raw.githubusercontent.com/GravityPoet/ChordVox/main/docs/assets/chordvox_demo_apple.png" alt="ChordVox 动态演示" />
</p>

<p align="center">
  <img src="assets/chordvox-demo.webp" alt="ChordVox demo" width="100%" />
</p>

---

### 为什么你需要 ChordVox？

**你原本说的**：  
> “_嗯今天下午我们搞个会吧，大概三点，叫上老王，哦不对叫上小李，讨论下那个界面改版。_”

- 🟢 **普通单引擎转录**：原样转录，带有你的口水话和结巴，可能标点错乱。  
- 🚀 **ChordVox AI 润色**：`【会议通知】时间：今日下午 3:00；参与人：小李；主题：界面改版讨论说明。`

**💡 不只记录声音，更能重塑表达。永久免费的本地语音转文字引擎。**

---

### 核心特性

- ⌨️ **一键闭环，光标处直接落字** — 快捷键一按：录音 → 转写 → 润色 → 粘贴到当前光标，全程零切窗，思维永不中断。

- 🧠 **AI 润色管线** — 语音原文 → 精修成文。自动帮你剔除口水话，完善排版逻辑。（*进阶配置支持自主对接顶级 AI 接口或本地大语言模型*）

- 🎯 **唤醒专属职场助理** — 对它说“Hi ChordVox，帮我起草一封回信……”，瞬间从打字工具切换为执行复杂指令的私人秘书。

- 📖 **听懂你的专业黑话** — 自定义专属词汇表。添加你业务中的人名、行业黑话、医学/代码名词，让它越用越懂你。

- 🔒 **纯净本地运行 (永久免费)** — 音频转写全程不出本机，隐私绝对安全。无需折腾运行环境，开箱即用。

<details>
<summary><b>👀 点击查看硬核全量特性与极客参数</b></summary>
<br>

- **底层架构** — 内置三大语音引擎（whisper.cpp · NVIDIA Parakeet · SenseVoice），无需 Python 环境；对接任何 OpenAI Compatible API，或通过内置 llama.cpp 跑本地 GGUF 模型。
- **系统挂钩** — macOS 使用 AppleScript 精准粘贴与原生 Swift 监听 Globe/Fn 键，Windows SendKeys + 底层键盘钩子，Linux 全覆盖 XTest/ydotool 等协议。支持真正的 Push-to-Talk 硬件响应。
- **双配置热键** — 两套独立快捷键绑定不同 STT 引擎与润色策略，一键自由切。
- **存储空间管理** — 设置面板一键卸载几十 GB 庞大的模型缓存，释放磁盘空间。
</details>

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

- [下载 ChordVox（GitHub Releases）](https://github.com/GravityPoet/ChordVox/releases)
- [下载最新版本](https://github.com/GravityPoet/ChordVox/releases/latest)

进入下载页后，直接点击与你系统对应的文件即可：

- macOS（Apple Silicon）：`ChordVox-*-arm64.dmg`
- Windows（x64）：`ChordVox-Setup-*.exe`
- Linux（x64）：`ChordVox-*-linux-x86_64.AppImage`、`ChordVox-*-linux-amd64.deb` 或 `ChordVox-*-linux-x86_64.rpm`

> [!IMPORTANT]
> **macOS 首次启动必读**：由于版本非 App Store 下载，可能会被 Gatekeeper 拦截导致“文件损坏”或无法打开。请在终端执行以下命令解除拦截：
> ```bash
> xattr -dr com.apple.quarantine /Applications/ChordVox.app
> open /Applications/ChordVox.app
> ```

> 永久免费的本地离线语音识别。数据绝对隐私，你的声音只属于你。



### 快速链接

- 📦 [所有版本](https://github.com/GravityPoet/ChordVox/releases)
- 📖 [完整技术文档](docs/README_LEGACY.md)
- 📬 联系方式：`moonlitpoet@proton.me`

---

### 许可证

MIT License. 详见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE) 文件。
