# 流式模型国内镜像 SOP（ModelScope 魔搭）

面向：客户支持 + 维护者。
目的：解决“正式包只能打 GitHub、国内客户下载流式模型超时”的问题，把模型下载做成闭环，并给客服一份精确的镜像下载链接 + 校验值，避免让客户去 GitHub 碰运气。

## 1. 问题与现状

- App 内置多源下载框架（`src/helpers/modelDownloadSources.js`），支持 CDN / R2 / COS / OSS / 自定义镜像 + 官方源。
- 但正式包未配置任何 `CHORDVOX_MODEL_*` 镜像环境变量，且清单历史上没有 `mirrors` 字段、安装包不内置模型权重 → 实际只能命中 GitHub Release → 国内超时。
- 修复方式：把中文流式模型镜像到 **ModelScope 魔搭**（sherpa-onnx 官方国内镜像平台，命名空间 `ChillMars`），并在 `src/config/streamingModels.json` 为每个中文模型补 `mirrors` 字段。

## 2. 闭环如何生效（自动路径，优先）

- `inferSourceKind()` 识别 `modelscope.cn` → kind `modelscope`。
- `sourcePriority()` 在中文 locale 下，`modelscope` 命中 `(!official && !huggingface)` 分支 → 优先级 **1**，排在 GitHub 官方源（优先级 2）之前。
- `buildDownloadSources()` 读取清单的 `model.mirrors`（`sherpaStreamingManager.js` 下载存档时传入），排序后**国内优先打魔搭镜像，失败再回退 GitHub**。
- 镜像文件与上游 GitHub Release **逐字节一致**，因此清单里已有的 `sha256` 继续生效：非官方镜像强制校验 sha256（`assertDownloadSourceAllowed`），校验通过才落地。

结论：中文环境的客户**正常重试即可**，App 会自动走魔搭镜像，不再依赖 GitHub。

## 3. 镜像清单（客服可直接发给客户的精确链接 + 校验值）

所有镜像均为公开（PUBLIC），与上游字节一致，sha256 与 App 内置校验值相同。

### 快速实时（中文）· `zipformer-ctc-zh-large-fp16`（默认模型）

- 大小：297MB（存档 280100839 字节）
- sha256：`4fbf38c2ff7ba412b41f80a35de5f12643b56861e8e221191d2cc261c555d1d6`
- 魔搭镜像：https://www.modelscope.cn/models/ChillMars/sherpa-onnx-streaming-zipformer-ctc-zh-fp16-2025-06-30/resolve/master/sherpa-onnx-streaming-zipformer-ctc-zh-fp16-2025-06-30.tar.bz2
- GitHub 上游：https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-ctc-zh-fp16-2025-06-30.tar.bz2

### 高精度实时（中文）· `zipformer-ctc-zh-xlarge`

- 大小：728MB（存档 590044704 字节）
- sha256：`23f32059d502e87f4fe4b1a17dbedb65582bb0c42950b3d615f218bb25feafd5`
- 魔搭镜像：https://www.modelscope.cn/models/ChillMars/sherpa-onnx-streaming-zipformer-ctc-zh-xlarge-int8-2025-06-30/resolve/master/sherpa-onnx-streaming-zipformer-ctc-zh-xlarge-int8-2025-06-30.tar.bz2
- GitHub 上游：https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-ctc-zh-xlarge-int8-2025-06-30.tar.bz2

### 流式最高精度（中文，FP16）· `zipformer-ctc-zh-xlarge-fp16`（hidden / deprecated，已被 xlarge 取代）

- 大小：1.5GB（存档 1335125607 字节）
- sha256：`602c0e49dfe81f977c138fb3cb0a2e8ef486fe5f232f817de09d0959eddabea6`
- 魔搭镜像：https://www.modelscope.cn/models/ChillMars/sherpa-onnx-streaming-zipformer-ctc-zh-xlarge-fp16-2025-06-30/resolve/master/sherpa-onnx-streaming-zipformer-ctc-zh-xlarge-fp16-2025-06-30.tar.bz2
- GitHub 上游：https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-ctc-zh-xlarge-fp16-2025-06-30.tar.bz2

> 英文模型 `nemotron-streaming-en-0.6b` 走 HuggingFace 上游、且无 `mirrorPath`，不在国内镜像范围内。英文路径用户一般可直连 HuggingFace。

### 手动校验（客户本地核对）

```bash
# macOS / Linux
shasum -a 256 <下载的文件>.tar.bz2
# 对比上表 sha256，一致即为完整、可信文件
```

## 4. 维护者：如何新增 / 重镜像一个模型

前置：ModelScope 访问令牌（后台 → 访问令牌），Python venv 安装 `modelscope`。

```bash
python3 -m venv /tmp/ms_venv
/tmp/ms_venv/bin/pip install -q modelscope
```

镜像脚本逻辑（参考本次实现）：

1. 读 `src/config/streamingModels.json`，取 `downloadUrl`(GitHub) / `mirrorPath` / `sha256`。
2. 从 GitHub 下载存档，本地 `sha256` 校验**必须**与清单一致（不一致即中止，禁止上传）。
3. 在临时目录放 `<mirrorPath>` + `configuration.json`（`{"framework":"other","task":"auto-speech-recognition"}`）+ `README.md`。
4. `HubApi().login(token)` 后 `push_model(model_id="ChillMars/<mirrorPath 去掉 .tar.bz2>", model_dir=..., visibility=PUBLIC, license="Apache License 2.0")`。
5. 校验 `resolve/master/<mirrorPath>` 返回 `200`。
6. 在清单对应模型补 `mirrors` 字段：
   ```json
   "mirrors": [
     {
       "url": "https://www.modelscope.cn/models/ChillMars/<repo>/resolve/master/<mirrorPath>",
       "kind": "modelscope",
       "label": "ModelScope 魔搭（国内镜像）"
     }
   ]
   ```

安全约束：

- 令牌只放进程环境变量，**绝不写入仓库 / 提交**。
- 镜像文件必须与上游字节一致（保持 sha256 不变），否则 App 端校验会拒绝。
- 上传后令牌建议在魔搭后台 revoke 轮换。

## 5. 可选后续（未实现，留作改进项）

- `downloadArtifactFromSources()` 的 `error.manualDownloadUrl` 当前优先取官方（GitHub）源；中文 locale 下若要让“手动下载”提示也直接给魔搭镜像，可改为优先取排序后的首个国内镜像源。当前流式模型 UI 未展示该字段，自动镜像已覆盖主路径，故未改动。
- 如需为镜像配置 CDN/R2/COS/OSS，按 `parseMirrorBaseSources()` 设置 `CHORDVOX_MODEL_*` 环境变量即可叠加更多源。
