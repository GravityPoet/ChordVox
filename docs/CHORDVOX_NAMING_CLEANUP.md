# ChordVox 命名清理说明

> 目标：把仓库里仍会误导开发、配置和排障的历史品牌命名统一到 `ChordVox`，同时保留必要的兼容和法务信息。

---

## 当前主路径

当前统一使用：

- `ChordVox`
- `ChordVox Cloud`
- `chordvox_cloud`
- `chordvox-cloud`
- `chordvox-models-cleared`
- `chordvox:lastSignInTime`
- `CHORDVOX_*`
- `VITE_CHORDVOX_*`

---

## 兼容策略

以下旧值仍允许读取，但不再作为主写入路径：

- 旧 cloud mode / provider / source
- 旧模型清理事件名
- 旧登录时间存储 key
- 旧环境变量前缀

兼容入口统一收敛到：

- `src/utils/chordvoxCloud.js`

这样做的目的：

- 老用户升级后不丢设置
- 老环境变量仍可启动
- 模型清理和登录态迁移不出回归

---

## 必须保留的历史事实

以下内容保留上游真实名称，不做品牌替换：

- `LICENSE`
- `NOTICE`
- `resources/legal/OPEN_SOURCE_NOTICES.txt`
- 明确指向上游来源与许可证归属的说明
- 用于清理旧安装残留的旧 bundle id、plist、缓存目录与临时文件名
- 外部真实仓库名、release 下载源与上游项目引用

---

## 仓库内执行原则

### 可直接替换

- 文档标题
- 产品文案
- 注释中的旧品牌称呼
- 示例路径与示例变量名
- 规划文档中的历史品牌描述

### 需兼容保留

- localStorage 旧值读取
- 旧事件名监听
- 旧环境变量 fallback
- 卸载脚本中用于清理老版本文件的旧路径模式

### 不应改写事实

- 上游仓库名
- 上游团队名
- 许可证原文
- 开源归属说明

---

## 验收口径

- 用户看到的当前产品名称统一为 `ChordVox`
- 新写入的内部标识统一为 `ChordVox` 命名
- 老用户升级后本地设置不丢失
- 清理脚本仍能删除旧安装遗留
- 法律归属文件仍保留真实上游来源
