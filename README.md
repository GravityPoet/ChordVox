## 🌐 [Click here for English Version](./README.en.md)

<h1 align="center">ChordVox IME</h1>

<p align="center">
  <strong>“你的嘴巴只管说，AI 负责把它们变成完美的文章。”</strong><br>
  用说话的速度写代码和报告。本地听写免费，光标处直接落字。
</p>

<p align="center">
  <a href="https://github.com/GravityPoet/ChordVox/releases/latest"><img src="https://img.shields.io/github/v/release/GravityPoet/ChordVox?label=release&color=6366f1" alt="Latest Release" /></a>
  <a href="https://github.com/GravityPoet/ChordVox/releases"><img src="https://img.shields.io/github/downloads/GravityPoet/ChordVox/total?style=flat&color=06b6d4" alt="Downloads" /></a>
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

<p align="center">
  <img src="https://chordvox.com/assets/chordvox-demo-zh-v35.webp?v=20260410s" alt="ChordVox 中文动态演示" />
</p>

---

### 为什么你需要 ChordVox？

键盘打字早已成为思考的瓶颈——大脑每分钟涌出 **150+ 字**，手指却只能敲出 **40 个词**。

而传统的语音输入工具往往让人抓狂：原样记录口水话和结巴、标点混乱，甚至逼你在听写软件与工作软件之间反复切换、手动复制粘贴，或者偷偷将私密录音上传至云端服务器。

**ChordVox 将这一整套繁琐流程彻底删减为一步：** 按住快捷键自然说话，AI 实时提炼润色为清晰排版的文字，松开即刻精准粘贴至当前光标所在应用。

> 💡 **本地离线语音识别永久免费。** 音频全程不出本机。支持本地大语言模型或自带 API Key（BYOK），随心开启深度润色。

---

### 痛点对比：使用前 vs. 使用后

| 传统输入 / 普通听写 | 使用 ChordVox |
|---|---|
| 打字速度跟不上思维流转（每分钟 40–50 字） | 自然说话，即刻转换（每分钟 150+ 字） |
| 原样转录口水话：“*嗯那个下午三点开会……不对四点*” | AI 自动精修排版：`【会议通知】时间：今日下午 4:00` |
| 在听写软件与工作软件之间反复切换、手动复制粘贴 | 单个快捷键：录音 → 转写 → 润色 → 自动粘贴光标处，全程零切窗 |
| 私密录音、会议记录与商业机密上传至未知云端 | 本地引擎离线运行（`whisper.cpp` / `Parakeet` / `SenseVoice`），音频不出机器 |
| 行业黑话、人名、代码缩写屡屡识别错误 | 自定义词汇库，深度定制专属专业词典 |
| 无法按场景区分不同处理策略 | 多套独立快捷键（Multi-Shortcut Workflows）：极速草稿、专业精修、外语翻译一键分流 |

---

### 三大杀手级特性

- ⌨️ **光标处直接落字（全程零切窗）**
  - **用户价值：** 告别复制粘贴。无论在 VS Code、Slack、Notion、微信还是浏览器中，按住快捷键说话，松开后文字直接落在光标闪烁处，思维流畅不中断。
  - **底层支撑：** 深度系统级挂钩，macOS 采用 AppleScript 与 Swift 原生事件监听，Windows 采用 SendKeys 与底层键盘钩子，Linux 全覆盖 XTest/ydotool。

- 🧠 **AI 润色管线与专属职场助理**
  - **用户价值：** 自动剔除口水话与语气词，理顺逻辑、完善标点排版；更可对它说“*Hi ChordVox，帮我起草一封委婉的拒绝信……*”，瞬间化身执行复杂指令的私人助理。
  - **底层支撑：** 支持对接 OpenAI、Anthropic Claude、Google Gemini、Groq、DeepSeek 等顶级模型，亦可通过内置 `llama.cpp` 运行本地 GGUF 模型。

- 🔒 **完全离线隐私、永久免费基础转写与自带模型/Key**
  - **用户价值：** 核心语音转文字完全在本地 CPU/GPU 运行，断网可用，录音绝不外发；支持 BYOK 自带 API Key 或本地大模型，完全掌控自己的数据。
  - **底层支撑：** 内置高性能 `whisper.cpp`、NVIDIA `Parakeet`、阿里 `SenseVoice` 引擎，无需配置 Python 环境。

<details>
<summary><b>👀 点击查看硬核架构与极客参数</b></summary>
<br>

```
┌─────────────┐    ┌──────────────────────────┐    ┌─────────────────┐    ┌──────────────┐
│  快捷键      │───▶│  音频采集                │───▶│  语音引擎       │───▶│  AI 润色     │───▶ 粘贴至
│  (Globe/Fn/  │    │  MediaRecorder → IPC     │    │  whisper.cpp    │    │  GPT / Claude│    光标
│   自定义)    │    │  → 临时 .wav 文件        │    │  Parakeet       │    │  Gemini/Groq │
└─────────────┘    └──────────────────────────┘    │  SenseVoice     │    │  本地 GGUF   │
                                                    │  云端 STT       │    └──────────────┘
                                                    └─────────────────┘
```

- **技术栈**：Electron 41 · React 19 · TypeScript · Vite · Tailwind CSS v4 · shadcn/ui · better-sqlite3 · whisper.cpp · sherpa-onnx (Parakeet) · llama.cpp · FFmpeg（内置）
- **多套快捷键工作流**：独立快捷键绑定不同 STT 引擎与润色策略，一键自由切。
- **专业自定义词典**：添加专属人名、术语、缩写，大幅提升医学 / 法律 / 代码等领域的转录准确度。
- **存储空间管理**：设置面板一键卸载几十 GB 庞大的模型缓存，释放磁盘空间。
</details>

---

### 适用人群与典型场景

- 👤 **普通人 / 每个人：** 日常聊天、搜索、写日记、发朋友圈、记录随想，说话就能直接变成通顺工整的文字，彻底告别键盘慢打。
- 👨‍💻 **软件工程师：** 撰写 PR 描述、代码注释、设计文档与提交记录，双手无需离开思考心流。
- ✍️ **内容创作者与研究者：** 以自然说话的速度极速记录灵感、草稿与长篇论述。
- 👔 **管理者与职场人士：** 快速回复 Slack/微信/邮件，秒级整理会议要点与工作周报。
- 🔒 **隐私敏感型专业人士：** 法律、医疗、金融等行业需 100% 离线保护商业机密与客户隐私。

---

### 下载

- [下载 ChordVox（GitHub Releases）](https://github.com/GravityPoet/ChordVox/releases)
- [下载最新版本](https://github.com/GravityPoet/ChordVox/releases/latest)

进入下载页后，直接点击与你系统对应的文件即可：

- macOS（Apple Silicon）：`ChordVox-*-arm64.dmg`
- Windows（x64）：`ChordVox-Setup-*.exe`
- Linux（x64）：`ChordVox-*-linux-x86_64.AppImage`、`ChordVox-*-linux-amd64.deb` 或 `ChordVox-*-linux-x86_64.rpm`

> [!IMPORTANT]
> **macOS 首次启动**：macOS 客户版使用 ChordVox 固定自签名证书，但未经 Apple 公证。打开 DMG 后，把 `ChordVox.app` 拖到 `Applications`，再从 `Applications` 打开；每台新 Mac 首次安装通常需要到“系统设置 > 隐私与安全性”选择“仍要打开”。只有仍打不开时，再回到 DMG 双击右侧 `Fix & Open.command`，它只会解除已安装 App 的隔离标记并打开 ChordVox。

> 本地离线语音识别永久免费；AI 增强、文件转录、BYOK 和高级工作流可按需使用 Pro 能力。

### 快速链接

- 📦 [所有版本](https://github.com/GravityPoet/ChordVox/releases)
- 📖 [完整技术文档](docs/README_LEGACY.md)
- 📬 联系方式：`moonlitpoet@proton.me`

---

### 开源承诺与许可证说明

ChordVox 社区版基于 **[AGPL-3.0 许可证](./LICENSE)** 开源。

- **开源自由使用：** 任何个人或企业均可在遵守 AGPL-3.0 条款的前提下免费使用和分发。
- **商业双重授权：** 若企业需要闭源集成或免除 AGPL-3.0 传染义务，请联系 `moonlitpoet@proton.me` 获取商业授权。
- **第三方开源致谢：** 详见 [NOTICE](./NOTICE) 与 [开源组件声明](./resources/legal/OPEN_SOURCE_NOTICES.txt)。