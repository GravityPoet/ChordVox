<h1 align="center">ChordVox IME</h1>

<p align="center">
  <strong> 还在手动打字 or 改语音识别的错别字？试试这套纯本地 AI 语音输入法。说话秒变精修长文，自动粘贴一气呵成。你的隐私掌握在你的手中，免注册开箱即用，你的嘴就是最快的键盘。</strong>
</p>

<p align="center">
  <a href="https://github.com/GravityPoet/ChordVox/releases/latest"><img src="https://img.shields.io/github/v/release/GravityPoet/ChordVox?label=release&color=6366f1" alt="Latest Release" /></a>
  <a href="https://github.com/GravityPoet/ChordVox/releases"><img src="https://img.shields.io/github/downloads/GravityPoet/ChordVox/total?style=flat&color=06b6d4" alt="Downloads" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-22c55e" alt="License" /></a>
  <a href="#"><img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-a78bfa" alt="Platform" /></a>
</p>

<p align="center">
  <a href="./README.md">English</a> | <strong>中文</strong>
</p>

---

### 一句话简介

> **AI语音输入法，开口即输入，AI 模型自动润色，自动粘贴，一气呵成。本 AI 语音输入法把隐私、效率、AI润色效果做到极致，让你彻底告别繁琐打字修改。无需联网账号，开箱即用。**

---

### 这个软件能怎么帮你？

| 痛点 | 我们怎么解决？ |
|---|---|
| **“打字太慢，灵感一闪而过全忘了”** | 嘴巴想说什么随便说。哪怕你说得坑坑巴巴，它也会在 2 秒内吐出一篇优美连贯的长文。 |
| **“写会议纪要、改论文，不敢传上去怕泄密”** | **拔掉网线照样用**。因为我们在安装包里直接塞入了一个强大的本地人工智能大脑，你的商业机密永远烂在你的硬盘里。 |
| **“那些听写软件错别字太多，还得回去一个个改”** | 自带最强的 AI 语病修正。你说了句废话或者倒装句，它会通过大语言模型自动帮你理顺成正儿八经的书面语，连标点和换行都排好了。 |
| **“转录出来的文字我还得复制粘贴，切窗口好烦”** | 类似发送微信语音那么简单。在一个输入框按下快捷键讲话，松开按键，精美的文字就会**自动粘贴在你的光标处**，全程不需要碰鼠标。 |
| **“我的行业老是有专有名词，AI 老是打不对”** | 自定义专属词典。把你的客户人名、业务黑话都丢进去，从此以后它就不会再拼错了。 |

---

### 能改变你工作习惯的杀手级功能

- 🔒 **纯本地，最硬核的隐私保护** — 无需折腾复杂的 Python 或者任何技术部署。下载一个安装包，双击打开。你的录音文件就算拿着显微镜找也绝不会飞出这台电脑。

- 🧠 **AI 润色（彻底消灭错别字与语病）** — 提供最顶尖的文字打磨管线。录音文字不是直接糊你脸上，而是通过智能大模型洗练之后再出现。只要你愿意，它能连上 OpenAI / Claude / Gemini 甚至你自己跑在大模型上，完成自动排版。

- ⌨️ **对讲机一样的沉浸感体验** — 我们利用了系统底层的通道为你抓取全局按键。不管你在 Word、微信 还是 浏览器里，按住你设定的热键开口说话就行了，文字会自动输入进去。这就是极致的“真·无缝打字”。

- 🎯 **不仅能打字，还能发号施令** — 觉得打字不够劲，直接把输入法变成你的超能助理。提前设置好名字，对它开口：“嘿，ChordVox，帮我写一封语气客气的加薪申请信…” 接下来，一封长长的完美请愿书就会瞬间出现在你的屏幕上。

- 🔄 **工作流随心切换** — 我们提供了双重热键设置。你可以设置一个热键专门用来速记、发草稿（只管快）；另一个热键专门用来写极度严谨的公文（调用最强的推理大脑），互相不干扰。 

- 💼 **企业满血版接口 (Pro 专属)** — 有极致速度或者专业工作流要求的重度用户，不需要你自己满世界去找各种乱七八糟的大模型 API Key。用我们的官方极速高速专网直接即插即用，还自带词库增强和商业级风控能力。

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

当前稳定版：[`v1.5.18`](https://github.com/GravityPoet/ChordVox/releases/tag/v1.5.18)

| 系统 | 芯片 | 格式 | 下载 |
|---|---|---|---|
| macOS | Apple Silicon | dmg | [⬇ 下载](https://github.com/GravityPoet/ChordVox/releases/download/v1.5.18/ChordVox-1.5.18-arm64.dmg) |
| macOS | Intel | dmg | 即将上线 |
| Windows | x64 | exe | 即将上线 |
| Linux | x64 | AppImage / deb | 即将上线 |

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
