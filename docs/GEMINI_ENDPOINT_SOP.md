# Gemini Endpoint SOP

## Goal

避免把 “Gemini provider” 和 “Google 原生 Gemini API” 混为一谈，导致错误套用 `v1 / v1beta` 规则、拼错模型列表路由，或把 bridge 当作原生接口处理。

## Core Rule

`provider === gemini` 只说明模型供应商是 Gemini，不说明 endpoint 家族。

每次处理 Gemini 相关逻辑时，必须先判断 endpoint family，再决定：

- 模型列表 URL 怎么拼
- `generateContent` 请求打到哪里
- 是否允许自动切换 `v1 / v1beta`
- 是否向用户显示 “v1 适合稳定模型 / v1beta 适合 preview” 提示

## Endpoint Families

### 1. Google Official

识别特征：

- 域名包含 `generativelanguage.googleapis.com`

规则：

- 这是 Google 原生 Gemini API
- 允许使用 `v1 / v1beta`
- 只有这一类 endpoint 可以套用 preview 模型自动切换到 `v1beta` 的规则
- 只有这一类 endpoint 需要显示 `v1 / v1beta` 的用户提示

### 2. ChordVox Gemini Bridge

识别特征：

- 路径命中 `/gemini-bridge`

规则：

- 这是 ChordVox 自己的 bridge，不等于 Google 原生 API
- 不要对它套用原生 `v1 / v1beta` 自动切换逻辑
- 请求路径必须按 bridge 自己支持的路由来
- 当前已知兼容约束：
  - `/gemini-bridge/v1/` 有效
  - `/gemini-bridge/v1beta/` 不能假设存在

### 3. Gemini-Compatible Custom Endpoint

识别特征：

- provider 是 Gemini
- 但既不是 Google 官方域名，也不是 `/gemini-bridge`

规则：

- 把它当作兼容实现，不要擅自套用 Google 原生版本规则
- 默认不要自动改 endpoint
- 除非已有明确文档或实测证据，否则不要假设它支持 Google 原生所有路由形态

## Hard Rules

1. 先分家族，再写逻辑。
2. 自动 `v1 -> v1beta` 只允许用于 Google Official。
3. `gemini-bridge` 不能因为模型名包含 `preview` 就自动改成 `/v1beta`。
4. 模型列表请求和实际 `generateContent` 请求，必须使用同一套 endpoint family 规则。
5. 面向用户的提示只说“当前地址是否适合该能力”，不要暴露内部 bridge 实现细节。

## Safe Defaults

- 看到 `generativelanguage.googleapis.com`：
  - 可以讨论 `v1 / v1beta`
- 看到 `/gemini-bridge`：
  - 默认按 bridge 自己的 `/v1` 兼容路径处理
- 看到其他 Gemini endpoint：
  - 默认当作 custom-compatible，不自动切版本

## Pre-Ship Checklist

提交任何 Gemini endpoint 相关改动前，至少确认：

1. Google Official 是否仍然支持 `v1 / v1beta` 预期行为
2. `gemini-bridge` 是否没有被错误切到 `/v1beta`
3. 模型列表和真实生成请求是否使用了同一套 endpoint family 处理
4. 用户界面是否只展示对用户有价值的提示，而不是暴露内部 bridge 名称

## Pitfall

错误写法：

- “Gemini 的 preview 模型都应该切到 `v1beta`”

正确写法：

- “Google 原生 Gemini endpoint 的 preview 模型通常需要 `v1beta`；gemini-bridge 和其他兼容 endpoint 不自动套用这条规则。”
