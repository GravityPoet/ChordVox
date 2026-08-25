# ChordVox v{{VERSION}}

## Downloads / 下载资源

### English 🌐

Please select the appropriate package based on your operating system and processor architecture:

- **macOS (Apple Silicon — M1/M2/M3/M4/etc.)**
  - 🚀 **[Download Recommended DMG](https://github.com/GravityPoet/ChordVox/releases/download/v{{VERSION}}/ChordVox-{{VERSION}}-arm64.dmg)** — Recommended for most Mac users. Open the DMG, drag `ChordVox.app` to Applications, then launch it from Applications.
- **macOS (Intel)**
  - 🖥️ **[Download Intel DMG](https://github.com/GravityPoet/ChordVox/releases/download/v{{VERSION}}/ChordVox-{{VERSION}}-x64.dmg)** — For Intel-based Macs. Installation and first-launch approval are the same as the Apple Silicon build.
- **Windows 10 / 11 (64-bit)**
  - ⚡ **[Download Recommended Setup (.exe)](https://github.com/GravityPoet/ChordVox/releases/download/v{{VERSION}}/ChordVox-Setup-{{VERSION}}.exe)** — Standard installation wizard. Recommended for automatic background updates.
  - 💼 **[Download Portable Package (.exe)](https://github.com/GravityPoet/ChordVox/releases/download/v{{VERSION}}/ChordVox-{{VERSION}}.exe)** — Runs directly without installation. Perfect for USB drives or restricted environments.
- **Linux (64-bit)**
  - 🐧 **[Download Universal AppImage](https://github.com/GravityPoet/ChordVox/releases/download/v{{VERSION}}/ChordVox-{{VERSION}}-linux-x86_64.AppImage)** — Single-file portable executable. Runs on almost all distributions.
  - 📦 **[Download Debian / Ubuntu (.deb)](https://github.com/GravityPoet/ChordVox/releases/download/v{{VERSION}}/ChordVox-{{VERSION}}-linux-amd64.deb)** — Native package for Debian, Ubuntu, Mint, etc.
  - 📦 **[Download RedHat / Fedora (.rpm)](https://github.com/GravityPoet/ChordVox/releases/download/v{{VERSION}}/ChordVox-{{VERSION}}-linux-x86_64.rpm)** — Native package for RHEL, Fedora, CentOS, Rocky, etc.
  - 📦 **[Download Linux Tarball (.tar.gz)](https://github.com/GravityPoet/ChordVox/releases/download/v{{VERSION}}/ChordVox-{{VERSION}}-linux-x64.tar.gz)** — Raw tarball for custom installation.

> [!NOTE]
> Automatic updater metadata (`latest.yml`, `latest-mac.yml`, `latest-linux.yml`), blockmaps (`*.blockmap`), and release verification manifests (`release-manifest-*.json`) are listed in the **Assets** block below. These are processed automatically by the application and do not require manual download.

---

### 中文 🇨🇳

请根据您的操作系统与硬件架构，选择最适合的安装包下载：

- **macOS (Apple 芯片 — M1/M2/M3/M4/等新版 Mac)**
  - 🚀 **[下载推荐 DMG 安装包](https://github.com/GravityPoet/ChordVox/releases/download/v{{VERSION}}/ChordVox-{{VERSION}}-arm64.dmg)** — 推荐大多数 Mac 用户下载。打开 DMG，把 `ChordVox.app` 拖到 Applications，再从 Applications 启动。
- **macOS (Intel)**
  - 🖥️ **[下载 Intel DMG 安装包](https://github.com/GravityPoet/ChordVox/releases/download/v{{VERSION}}/ChordVox-{{VERSION}}-x64.dmg)** — 适用于 Intel 芯片 Mac，安装与首次放行方式和 Apple 芯片版相同。
- **Windows 10 / 11 (64位)**
  - ⚡ **[下载推荐安装版 (.exe)](https://github.com/GravityPoet/ChordVox/releases/download/v{{VERSION}}/ChordVox-Setup-{{VERSION}}.exe)** — 标准安装引导程序，完美支持后续应用内自动检查与一键更新。
  - 💼 **[下载便携免安装版 (.exe)](https://github.com/GravityPoet/ChordVox/releases/download/v{{VERSION}}/ChordVox-{{VERSION}}.exe)** — 双击即用，无需写入系统目录，适合随身携带。
- **Linux (64位)**
  - 🐧 **[下载通用 AppImage 包](https://github.com/GravityPoet/ChordVox/releases/download/v{{VERSION}}/ChordVox-{{VERSION}}-linux-x86_64.AppImage)** — 单文件免安装版，兼容绝大多数主流 Linux 发行版。
  - 📦 **[下载 Debian / Ubuntu 专属包 (.deb)](https://github.com/GravityPoet/ChordVox/releases/download/v{{VERSION}}/ChordVox-{{VERSION}}-linux-amd64.deb)** — 适用于 Ubuntu、Debian、Linux Mint 等系统的原生安装包。
  - 📦 **[下载 RedHat / Fedora 专属包 (.rpm)](https://github.com/GravityPoet/ChordVox/releases/download/v{{VERSION}}/ChordVox-{{VERSION}}-linux-x86_64.rpm)** — 适用于 RHEL、Fedora、CentOS 等系统的原生安装包。
  - 📦 **[下载 Linux Tarball 压缩包 (.tar.gz)](https://github.com/GravityPoet/ChordVox/releases/download/v{{VERSION}}/ChordVox-{{VERSION}}-linux-x64.tar.gz)** — 原始压缩包，供自定义安装。

> [!NOTE]
> 页面最下方的 Assets 列表中可能包含自动更新配置文件（`latest.yml` 等）、差分更新包（`*.blockmap`）和发布校验清单（`release-manifest-*.json`），这些仅供应用后台自动校验和更新使用，普通用户无需手动下载。

---

## What's New / 更新亮点

### English 🌐

- 🎙️ **Recording starts and cancels reliably**
  The cue, recording runtime, sidecar, and Globe helper startup chain now has bounded waits and cancellation. Even before the microphone opens, you can cancel “Preparing to record” immediately instead of being trapped in a startup state.
- 🌌 **A cleaner, tighter dictation capsule**
  The Nebula completion animation is more restrained and the close control has a stable hit area. Mouse clicks no longer create a giant frame over the content, while keyboard interaction keeps a clear focus treatment.
- ⚡ **Lower idle memory and battery use**
  Background glass layers and animation frames pause when the window is hidden or inactive. History mounting is bounded and renderer/model background work is reduced so an idle app does less work.
- 🗂️ **History and local model data scale better**
  History queries now use a worker and keyset pagination instead of loading large result sets at once. Nested model folders, empty custom-model lists, and missing-model warnings behave predictably; environment and license state use durable atomic writes so restarts do not silently lose them.
- 🛡️ **A clearer recovery path when something fails**
  Failed pastes preserve the transcript, and startup or in-progress cancellation follows one cleanup path. Unknown failures expose a recovery action instead of leaving the user to force-quit.
- 📦 **Stronger package and update verification**
  Formal packages are bound to the source SHA and macOS arm64/x64 both run installed real-dictation gates. Update downloads strip sensitive headers before cross-origin redirects, and releases stop automatically when a high-severity npm advisory remains.

### 中文 🇨🇳

- 🎙️ **录音启动和取消更可靠**
  提示音、录音运行时、sidecar 与 Globe helper 的启动链路现在支持有界等待和取消；即使麦克风还没有真正打开，也可以立即取消“正在准备录音”。
- 🌌 **更克制、更紧凑的听写胶囊反馈**
  粘贴成功后的星云动画更简洁，关闭按钮命中区更稳定；鼠标点击不会再出现覆盖整块内容的巨大方框，键盘操作仍有清晰焦点反馈。
- ⚡ **空闲时更省内存和电量**
  窗口不可见或不活跃时暂停背景玻璃层和动画帧，历史列表限制挂载数量，模型与渲染器的后台资源占用进一步降低。
- 🗂️ **历史记录和本地模型数据更适合长期使用**
  历史查询改用 worker 与 keyset 分页，避免记录增长后一次性加载大量数据；嵌套本地模型目录、空模型列表和缺失模型提示更可预期。环境配置与 license 状态采用持久、原子写入，重启后不会无故丢失。
- 🛡️ **出错时更容易恢复**
  粘贴失败会保留转录内容，启动阶段和处理中断都能沿着同一取消路径收尾；未知错误会给出明确的恢复动作。
- 📦 **发布包和更新校验更完整**
  每个正式包都绑定源代码 SHA，并在 macOS 两种架构上执行真实安装后听写门禁；更新下载会在跨域重定向前移除敏感请求头，存在 high 级 npm 公告时发布会自动熔断。

---

## macOS First Launch / macOS 首次启动

### English 🌐

Open the DMG, drag `ChordVox.app` to Applications, then open ChordVox from Applications.

ChordVox uses a stable self-signed certificate and is not Apple-notarized. On each new Mac, open **System Settings > Privacy & Security** and choose **Open Anyway** once. Only if it is still blocked, reopen the DMG and double-click `Fix & Open.command`; it removes quarantine from the installed app and then opens ChordVox. Existing installs signed with the same certificate keep the same app identity during updates.

### 中文 🇨🇳

打开 DMG，把 `ChordVox.app` 拖到 Applications，然后从 Applications 打开 ChordVox。

ChordVox 使用固定自签名证书且未经 Apple 公证。每台新 Mac 首次安装时，请到 **“系统设置 > 隐私与安全性”** 选择一次 **“仍要打开”**。只有仍打不开时，再回到 DMG 双击右侧 `Fix & Open.command`；它会解除已安装 App 的隔离标记，然后打开 ChordVox。使用同一证书签名的现有安装在更新时会保持相同的应用身份。
