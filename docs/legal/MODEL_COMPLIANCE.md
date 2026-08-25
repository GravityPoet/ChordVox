# Local Model Compliance Notes

This file tracks the commercial-use basis for local ASR models that ChordVox downloads or runs through bundled local runtimes.

## Paraformer-Large

- Product model id: `paraformer-large-zh`
- Runtime package used by the app: `sherpa-onnx-paraformer-zh-2023-03-28.tar.bz2`
- Runtime model file used by the app: `model.onnx` (full precision, not `model.int8.onnx`)
- Runtime package URL: `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2023-03-28.tar.bz2`
- Runtime package mirror: `https://huggingface.co/csukuangfj/sherpa-onnx-paraformer-zh-2023-03-28`
- Primary upstream source: ModelScope `damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch`
- Primary upstream URL: `https://www.modelscope.cn/models/damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch/summary`
- License basis: Apache License 2.0 from the ModelScope upstream model page.
- Conversion reference: `https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-paraformer/paraformer-models.html#csukuangfj-sherpa-onnx-paraformer-zh-2023-03-28-chinese-english`

The Hugging Face `funasr/paraformer-zh` page and the FunASR custom `MODEL_LICENSE` must not be used as the commercial license basis for this product model. They are a separate distribution path and are not the clean Apache-2.0 source of record for release compliance.

## Release Evidence Checklist

Before shipping a binary release that offers Paraformer or BELLE Whisper downloads, archive:

- Screenshot or exported copy of the source model page showing model name, URL, download date, and license label.
- Download command or server log for the runtime package.
- SHA-256 hash of the exact runtime package distributed or downloaded by the app.
- A copy of the runtime package model card or README when available.
- A copy of Apache License 2.0 in the packaged legal notices for Apache-2.0 models.
- Any NOTICE file shipped inside the downloaded package, if present.

Recommended attribution:

```text
This product includes or uses the Paraformer speech recognition model by Alibaba DAMO Academy / FunASR.
Licensed under the Apache License, Version 2.0.
The runtime package is converted for sherpa-onnx deployment.
```

## Streaming Paraformer Bilingual

- Product model id: `paraformer-bilingual-zh-en`
- Runtime package used by the app: `sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2`
- Runtime package URL: `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2`
- Runtime package mirror: `https://huggingface.co/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en`
- Primary upstream source: ModelScope `damo/speech_paraformer_asr_nat-zh-cn-16k-common-vocab8404-online`
- Primary upstream URL: `https://www.modelscope.cn/models/damo/speech_paraformer_asr_nat-zh-cn-16k-common-vocab8404-online/summary`
- License basis: Apache License 2.0 from the ModelScope upstream model page.
- Conversion reference: `https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-paraformer/paraformer-models.html#csukuangfj-sherpa-onnx-streaming-paraformer-bilingual-zh-en-chinese-english`

Do not use wording that implies Alibaba, DAMO Academy, FunASR, ModelScope, k2-fsa, or sherpa-onnx endorses or certifies ChordVox.

## BELLE Whisper GGML Models

These product model ids are downloaded as whisper.cpp-compatible GGML model files:

- `belle-whisper-large-v3-zh-punct-full`
- `belle-whisper-large-v3-turbo-zh-full`

Runtime package URLs:

- `https://huggingface.co/dixyes/Belle-whisper-large-v3-zh-punct-GGML/resolve/main/ggml-model.bin`
- `https://huggingface.co/BELLE-2/Belle-whisper-large-v3-turbo-zh-ggml/resolve/main/ggml-model.bin`

Primary upstream sources:

- `BELLE-2/Belle-whisper-large-v3-zh-punct`
- `BELLE-2/Belle-whisper-large-v3-turbo-zh`

License basis: Apache License 2.0 from the Hugging Face model cards for the GGML runtime packages and upstream BELLE model pages.

Recommended attribution:

```text
This product includes or uses BELLE Whisper speech recognition models by BELLE-2 contributors.
Licensed under the Apache License, Version 2.0.
The runtime packages are converted or quantized for whisper.cpp / GGML deployment.
```

Do not imply BELLE-2, Hugging Face, whisper.cpp, or OpenAI endorses or certifies ChordVox.
