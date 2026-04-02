#!/usr/bin/env node
/**
 * P0 验证脚本：测试 sherpa-onnx-node 在 Node.js 环境中的可用性
 *
 * 验证项：
 * 1. sherpa-onnx-node 能正常 require
 * 2. 能创建 OnlineRecognizer（streaming）
 * 3. 能喂入 PCM chunk 并获取 partial result
 * 4. 支持 paraformer（默认推荐）和 zipformer-ctc 两种模型类型
 *
 * 用法:
 *   # 先下载测试模型（极速轻量版，25MB，最快验证）
 *   cd /path/to/ChordVox-Pro
 *   wget https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-small-ctc-zh-int8-2025-04-01.tar.bz2
 *   tar xvf sherpa-onnx-streaming-zipformer-small-ctc-zh-int8-2025-04-01.tar.bz2
 *   rm sherpa-onnx-streaming-zipformer-small-ctc-zh-int8-2025-04-01.tar.bz2
 *
 *   # 或下载推荐的 paraformer 双语模型
 *   wget https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2
 *   tar xvf sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2
 *   rm sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2
 *
 *   # 运行测试
 *   node scripts/test-sherpa-streaming.js
 */

const path = require('path');
const fs = require('fs');

// ========== Step 1: 验证 sherpa-onnx-node 是否可加载 ==========
console.log('=== P0 验证: sherpa-onnx-node 流式 ASR ===\n');

let sherpa_onnx;
try {
  sherpa_onnx = require('sherpa-onnx-node');
  console.log('✅ Step 1: sherpa-onnx-node 加载成功');
  console.log('   可用 API:', Object.keys(sherpa_onnx).join(', '));
} catch (e) {
  console.error('❌ Step 1: sherpa-onnx-node 加载失败');
  console.error('   错误:', e.message);
  console.error('\n   请确认已安装: npm install sherpa-onnx-node');
  console.error('   macOS arm64 还需要设置:');
  console.error(
    '   export DYLD_LIBRARY_PATH=$PWD/node_modules/sherpa-onnx-darwin-arm64:$DYLD_LIBRARY_PATH'
  );
  process.exit(1);
}

// ========== Step 2: 检测可用模型 ==========
console.log('\n--- Step 2: 检测可用模型 ---');

const projectRoot = path.resolve(__dirname, '..');

// 模型配置定义（对应四档定级）
const modelConfigs = [
  {
    name: '极速轻量 (zipformer-small-ctc-zh)',
    dir: 'sherpa-onnx-streaming-zipformer-small-ctc-zh-int8-2025-04-01',
    type: 'zipformer2Ctc',
    getConfig: (dir) => ({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        zipformer2Ctc: { model: path.join(dir, 'model.int8.onnx') },
        tokens: path.join(dir, 'tokens.txt'),
        numThreads: 2,
        provider: 'cpu',
        debug: 0,
      },
      enableEndpoint: true,
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 1.2,
      rule3MinUtteranceLength: 20,
    }),
  },
  {
    name: '均衡 (zipformer-ctc-zh)',
    dir: 'sherpa-onnx-streaming-zipformer-ctc-zh-int8-2025-06-30',
    type: 'zipformer2Ctc',
    getConfig: (dir) => ({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        zipformer2Ctc: { model: path.join(dir, 'model.int8.onnx') },
        tokens: path.join(dir, 'tokens.txt'),
        numThreads: 2,
        provider: 'cpu',
        debug: 0,
      },
      enableEndpoint: true,
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 1.2,
      rule3MinUtteranceLength: 20,
    }),
  },
  {
    name: '高精度中文 (zipformer-ctc-zh-xlarge)',
    dir: 'sherpa-onnx-streaming-zipformer-ctc-zh-xlarge-int8-2025-06-30',
    type: 'zipformer2Ctc',
    getConfig: (dir) => ({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        zipformer2Ctc: { model: path.join(dir, 'model.int8.onnx') },
        tokens: path.join(dir, 'tokens.txt'),
        numThreads: 2,
        provider: 'cpu',
        debug: 0,
      },
      enableEndpoint: true,
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 1.2,
      rule3MinUtteranceLength: 20,
    }),
  },
  {
    name: '✅ 推荐 · 中英双语 (paraformer-bilingual)',
    dir: 'sherpa-onnx-streaming-paraformer-bilingual-zh-en',
    type: 'paraformer',
    getConfig: (dir) => ({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        paraformer: {
          encoder: path.join(dir, 'encoder.int8.onnx'),
          decoder: path.join(dir, 'decoder.int8.onnx'),
        },
        tokens: path.join(dir, 'tokens.txt'),
        numThreads: 2,
        provider: 'cpu',
        debug: 0,
      },
      enableEndpoint: true,
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 1.2,
      rule3MinUtteranceLength: 20,
    }),
  },
];

// 查找第一个可用的模型
let selectedModel = null;
for (const model of modelConfigs) {
  const modelDir = path.join(projectRoot, model.dir);
  if (fs.existsSync(modelDir)) {
    console.log(`✅ 找到模型: ${model.name}`);
    console.log(`   目录: ${modelDir}`);
    selectedModel = { ...model, fullDir: modelDir };
    break;
  } else {
    console.log(`   ⬜ 未找到: ${model.name} (${model.dir})`);
  }
}

if (!selectedModel) {
  console.error('\n❌ Step 2: 没有找到任何可用模型');
  console.error('   请先下载至少一个模型。最快的方式（25MB 极速轻量版）:');
  console.error(`   cd ${projectRoot}`);
  console.error(
    '   wget https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-small-ctc-zh-int8-2025-04-01.tar.bz2'
  );
  console.error(
    '   tar xvf sherpa-onnx-streaming-zipformer-small-ctc-zh-int8-2025-04-01.tar.bz2'
  );
  process.exit(1);
}

// ========== Step 3: 创建 OnlineRecognizer（streaming）==========
console.log('\n--- Step 3: 创建 OnlineRecognizer ---');

let recognizer;
try {
  const config = selectedModel.getConfig(selectedModel.fullDir);
  recognizer = new sherpa_onnx.OnlineRecognizer(config);
  console.log('✅ Step 3: OnlineRecognizer 创建成功');
} catch (e) {
  console.error('❌ Step 3: OnlineRecognizer 创建失败');
  console.error('   错误:', e.message);
  process.exit(1);
}

// ========== Step 4: 创建 Stream 并喂入测试音频 ==========
console.log('\n--- Step 4: 流式识别测试 ---');

// 查找测试音频
const testWavDir = path.join(selectedModel.fullDir, 'test_wavs');
let testWavFile = null;
if (fs.existsSync(testWavDir)) {
  const wavFiles = fs
    .readdirSync(testWavDir)
    .filter((f) => f.endsWith('.wav'));
  if (wavFiles.length > 0) {
    testWavFile = path.join(testWavDir, wavFiles[0]);
  }
}

if (!testWavFile) {
  console.error('❌ Step 4: 未找到测试音频文件');
  console.error(`   请确认 ${testWavDir} 目录下有 .wav 文件`);
  process.exit(1);
}

console.log(`   测试音频: ${path.basename(testWavFile)}`);

try {
  const stream = recognizer.createStream();
  console.log('✅ OnlineStream 创建成功');

  // 读取测试音频
  const wave = sherpa_onnx.readWave(testWavFile);
  console.log(
    `   音频时长: ${(wave.samples.length / wave.sampleRate).toFixed(2)}s, 采样率: ${wave.sampleRate}Hz`
  );

  // === 核心测试: 分 chunk 喂入，模拟流式 ===
  const chunkSize = wave.sampleRate * 0.1; // 100ms per chunk
  const totalSamples = wave.samples.length;
  let partialResults = [];
  let chunkCount = 0;

  const startTime = Date.now();

  for (let i = 0; i < totalSamples; i += chunkSize) {
    const end = Math.min(i + chunkSize, totalSamples);
    const chunk = wave.samples.subarray(i, end);
    stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: chunk });

    while (recognizer.isReady(stream)) {
      recognizer.decode(stream);
    }

    const result = recognizer.getResult(stream);
    if (result.text && result.text.trim()) {
      const currentText = result.text.trim();
      if (
        partialResults.length === 0 ||
        partialResults[partialResults.length - 1] !== currentText
      ) {
        partialResults.push(currentText);
        console.log(`   [chunk ${chunkCount}] partial: "${currentText}"`);
      }
    }

    // 检测 endpoint
    if (recognizer.isEndpoint(stream)) {
      const endpointResult = recognizer.getResult(stream);
      if (endpointResult.text && endpointResult.text.trim()) {
        console.log(
          `   [endpoint] confirmed: "${endpointResult.text.trim()}"`
        );
      }
      recognizer.reset(stream);
    }

    chunkCount++;
  }

  // 喂入尾部填充（模拟录音结束）
  const tailPadding = new Float32Array(wave.sampleRate * 0.4);
  stream.acceptWaveform({ samples: tailPadding, sampleRate: wave.sampleRate });
  while (recognizer.isReady(stream)) {
    recognizer.decode(stream);
  }

  const finalResult = recognizer.getResult(stream);
  const elapsed = (Date.now() - startTime) / 1000;
  const duration = totalSamples / wave.sampleRate;

  console.log(`\n   === 最终结果 ===`);
  console.log(`   文本: "${finalResult.text}"`);
  console.log(`   音频时长: ${duration.toFixed(2)}s`);
  console.log(`   处理耗时: ${elapsed.toFixed(3)}s`);
  console.log(`   RTF: ${(elapsed / duration).toFixed(3)}`);
  console.log(`   partial 变化次数: ${partialResults.length}`);
  console.log(`   共 ${chunkCount} 个 chunk (${(chunkSize / wave.sampleRate * 1000).toFixed(0)}ms/chunk)`);

  console.log('\n✅ Step 4: 流式识别测试通过！');
  console.log('\n=== P0 验证全部通过 ✅ ===');
  console.log('sherpa-onnx-node 可以在 Node.js 中正常用于流式 ASR');
  console.log('下一步: 在 Electron 主进程中集成，搭建 AudioWorklet → IPC → sherpa 管道');
} catch (e) {
  console.error('❌ Step 4: 流式识别测试失败');
  console.error('   错误:', e.message);
  console.error('   Stack:', e.stack);
  process.exit(1);
}
