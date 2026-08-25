# 第四录音动效「星球 / Planet」实施计划书 SOP

状态:待实施(助手执行)→ 待审核(Claude 审核)
日期:2026-06-13
风格 ID:`planet`(zh-CN「星球」/ en「Planet」)

---

## 1. 视觉概念

一颗带球面光照的圆形星球,外层环绕一圈彩色星雾。说话时**星雾跟随音量跳动**(扩张、增亮、提饱和),星球本体只做极轻微的呼吸缩放——重的东西稳、轻的东西动,质量感分离是本方案高级感的核心。

与现有 `nebula`(星云:银河盘+轨道+彗星,无实体球)的区分:`planet` 有**实体球面**——固定光源、明暗交界线(terminator)、大气边缘光(rim light)、表面纹理慢漂移。

```
        ✦      ·   ✧        ← deepfield 远星场(静态闪烁)
     ░░▒▒▓▓░░░              ← mist 彩色星雾(audio-reactive 主层)
   ░▒ ╭──────╮ ▒░
  ░▒  │ ◐◐◐◐ │  ▒░          ← globe 星球本体(左上受光,右下暗)
   ░▒ ╰──────╯ ▒░           ← atmo 大气边缘辉光
     ░░▒▒▓▓░░░              ← mistring 倾斜雾环(星球后方,慢旋)
```

## 2. 设计依据(按 UI-DESIGN-WORKFLOW)

1. **仓库现实(最高优先)**:复用现有 `dv-*` 设计系统——`--dv-amp` 音频包络(attack 0.7 / release 0.22,感知曲线 pow 0.75,见 `useCapsuleAmplitude.ts`)、`--dv-tempo: 2.4s` 节奏基准、`--dv-ease-silk: cubic-bezier(0.22,1,0.36,1)`、四态调色板变量 `--dv-accent-{cool,mid,warm}-rgb`。纯 CSS 分层,不引入 WebGL/canvas。
2. **模板参照**:design-catalog 的 ElevenLabs DESIGN.md(dark cinematic + 音频美学)确认暗空间底色 + 高饱和点缀的方向;未照搬其排版与配色,只取「深空底 + 局部高光」氛围结论。
3. **联网分析(native + Exa 双轮)**:2026 Siri 改版方向为 Liquid Glass 辉光渐现;ChatGPT voice orb、orb-ui、vapiblocks 等主流 audio-reactive orb 均为「level → scale + brightness」单层均匀脉动;CSS 星球的业界标准技法 = radial-gradient 球面光 + 多层 radial 雾 + blur + 倾斜 ring。本方案的差异化:**分层差异响应**(雾跳球稳),超越单层脉动的均质感。
4. 缺失说明:本产品无线上品牌页可对照(桌面 app),竞品近三月改版无公开 changelog 可查,该两类信息以主流 voice orb 实现代替。

## 3. 涉及文件清单(8 处,1 新增 + 7 修改)

| # | 文件 | 改动 |
|---|------|------|
| 1 | `src/utils/recordingAnimationStyle.ts` | `RECORDING_ANIMATION_STYLE_VALUES` 加 `"planet"`;`LEGACY_RECORDING_ANIMATION_STYLE_MAP` 加 `planet: "planet"` |
| 2 | `src/components/capsule/PlanetOrb.tsx` | **新文件**,DOM 见 §4 |
| 3 | `src/components/capsule/Capsule.tsx` | `animationStyle === "nebula"` 的无壳分支改为 `animationStyle === "nebula" \|\| animationStyle === "planet"`;planet 时渲染 `<PlanetOrb />`,根类名 `dv-capsule--nebula` 同款无壳路线(可加 `dv-capsule--planet`) |
| 4 | `src/styles/pill-v2.css` | 新增 `.dv-planet` 全套样式 + 状态区块 + keyframes,见 §5–§7 |
| 5 | `src/App.jsx` | 窗口尺寸:planet 复用 200×168。`pillWindowSize` 三元改为:`recordingAnimationStyle === "nebula" \|\| recordingAnimationStyle === "planet" ? NEBULA_ORB_WINDOW_SIZE : ACTIVE_PILL_WINDOW_SIZE`(不新建常量,免改主进程尺寸缓存链) |
| 6 | `src/components/settings/GeneralSection.tsx` | `recordingAnimationOptions` 加 planet 项;`PREVIEW_WAVES` 加 `planet: PlanetOrb`;预览组件里 `style === "nebula"` 的无壳分支同样放行 planet |
| 7 | `src/types/electron.ts` | 两处 `"flow" \| "stardust" \| "nebula"` 联合类型补 `\| "planet"`(约 1501/1503 行) |
| 8 | `src/locales/*/translation.json` | `settingsPage.general.floatingIcon.animationStyles.planet`:zh-CN「星球」、en「Planet」、zh-TW「星球」**必改**;de `Planet` / es `Planeta` / fr `Planète` / it `Pianeta` / ja `惑星` / pt `Planeta` / ru `Планета` 一并补齐 |

不需要改:`main.js`(IPC 纯透传)、`preload.js`(字符串透传)、主进程窗口尺寸逻辑(`lastExpandedPanelSize` 机制自动适配)。

## 4. DOM 结构(PlanetOrb.tsx)

参照 `NebulaCluster.tsx` 同构:纯展示组件,接收 `{ level, state }` props 但**不直接消费**(音频经父级 `--dv-amp` CSS 变量继承,与 nebula 一致;props 仅为满足 `WaveProps` 接口与预览复用)。

```tsx
export function PlanetOrb({ className }: { className?: string }) {
  return (
    <div className={className ? `dv-planet ${className}` : "dv-planet"}>
      <span className="dv-planet__deepfield" />   {/* 远星场 */}
      <span className="dv-planet__mist" />         {/* 彩色星雾(amp 主响应层)*/}
      <span className="dv-planet__mistring">       {/* 倾斜雾环,星球后方 */}
        <span className="dv-planet__mistring-spin" />
      </span>
      <span className="dv-planet__globe">          {/* 星球本体 */}
        <span className="dv-planet__surface" />    {/* 表面纹理(慢漂移)*/}
        <span className="dv-planet__terminator" /> {/* 明暗交界 */}
      </span>
      <span className="dv-planet__atmo" />          {/* 大气边缘辉光 */}
      <span className="dv-planet__glint" />         {/* 左上高光点 */}
    </div>
  );
}
```

z 序(从底到顶):deepfield → mist → mistring → globe → atmo → glint。
**雾环固定放星球后方**,不做「土星环前后穿越」——纯 CSS 拆前后半环穿帮风险高、收益低,禁止自行加。

## 5. 布局与几何参数

| 元素 | 参数 |
|------|------|
| `.dv-planet` | `position:absolute; inset:0; pointer-events:none;` 容器即 `.dv-capsule--nebula` 的圆区(窗口 200×168,圆区约 136×136 居中,与 nebula 相同) |
| `__deepfield` | 1×1px 锚点 + box-shadow 散点星,直接复制 `.dv-nebula__deepfield` 的 19 颗星坐标表(`pill-v2.css:918-945`),动画同 `dv-deepfield-twinkle calc(var(--dv-tempo)*2.5)` |
| `__mist` | `inset:-12px; border-radius:50%;` 四层 radial-gradient(见 §6),`filter: blur(8px)` |
| `__mistring` | `width:128px; height:128px;` 居中(`left:50%; top:50%; margin:-64px 0 0 -64px`),`transform: perspective(220px) rotateZ(-18deg) rotateX(62deg)` |
| `__mistring-spin` | `inset:0; border-radius:50%;` conic-gradient 雾带(见 §6),`filter: blur(4px)`,`-webkit-mask/mask: radial-gradient(circle, transparent 56%, #000 64%, #000 86%, transparent 96%)`(只留环带) |
| `__globe` | `width:84px; height:84px;` 居中(`left:50%; top:50%; margin:-42px 0 0 -42px`),`border-radius:50%; overflow:hidden;` |
| `__surface` | `inset:-20% -40%;`(超采样画布,供漂移),repeating-linear-gradient 条纹(见 §6) |
| `__terminator` | `inset:0; border-radius:50%;` 右下暗影 radial(见 §6) |
| `__atmo` | `inset` 比 globe 外扩 3px(即直径 90px 同心圆),`border-radius:50%;` 双层辉光(见 §6) |
| `__glint` | `width:18px; height:18px;` 球面左上(相对容器 `left:calc(50% - 26px); top:calc(50% - 30px)`),radial 白点,`filter: blur(1px)` |

**光源纪律:全部层共享固定光源方位「左上 32% / 36%」**(与 nebula haze 一致)。球面高光、terminator 暗侧(右下)、glint 位置、mist 受光偏亮侧必须服从同一光源,禁止各层各画各的光。

## 6. 渐变与颜色规格

全部颜色经 `--dv-accent-{cool,mid,warm}-rgb` 变量,**禁止硬编码 RGB 常量**(四态换装全靠变量,见 §8)。

```css
/* __mist 彩色星雾(四层 radial)*/
background:
  radial-gradient(circle at 32% 36%, rgba(var(--dv-accent-cool-rgb), 0.50), transparent 54%),
  radial-gradient(circle at 72% 62%, rgba(var(--dv-accent-warm-rgb), 0.44), transparent 58%),
  radial-gradient(circle at 58% 28%, rgba(var(--dv-accent-mid-rgb), 0.32), transparent 50%),
  radial-gradient(circle at 50% 56%, rgba(var(--dv-accent-mid-rgb), 0.22), transparent 74%);

/* __mistring-spin 雾环(conic,留暗口造成不均匀云带)*/
background: conic-gradient(
  from 0deg,
  transparent 0deg,
  rgba(var(--dv-accent-cool-rgb), 0.55) 40deg,
  rgba(var(--dv-accent-mid-rgb), 0.35) 95deg,
  transparent 150deg,
  rgba(var(--dv-accent-warm-rgb), 0.5) 205deg,
  rgba(var(--dv-accent-cool-rgb), 0.3) 260deg,
  transparent 320deg
);

/* __globe 底色(球面光照,左上受光)— 挂在 __globe 自身 */
background: radial-gradient(
  circle at 34% 32%,
  rgba(var(--dv-accent-cool-rgb), 0.95) 0%,
  rgba(var(--dv-accent-mid-rgb), 0.78) 34%,
  rgba(var(--dv-accent-warm-rgb), 0.52) 62%,
  rgba(12, 16, 38, 0.92) 100%
);

/* __surface 表面条纹(微弱,叠加在球底色上)*/
background: repeating-linear-gradient(
  104deg,
  transparent 0px,
  rgba(255, 255, 255, 0.05) 5px,
  transparent 11px,
  rgba(var(--dv-accent-cool-rgb), 0.07) 17px,
  transparent 24px
);
mix-blend-mode: screen;

/* __terminator 明暗交界(右下吃掉约 1/3 球面)*/
background: radial-gradient(
  circle at 30% 28%,
  transparent 52%,
  rgba(4, 6, 18, 0.55) 78%,
  rgba(2, 3, 12, 0.85) 100%
);

/* __atmo 大气辉光:inset 描边 + 外溢光晕(box-shadow 静态预制,见 §9 禁区)*/
box-shadow:
  inset 0 0 10px rgba(var(--dv-accent-cool-rgb), 0.65),
  0 0 18px rgba(var(--dv-accent-cool-rgb), 0.4),
  0 0 34px rgba(var(--dv-accent-mid-rgb), 0.22);

/* __glint 高光 */
background: radial-gradient(circle, rgba(255,255,255,0.95), rgba(255,255,255,0) 70%);
```

## 7. 动画与音频映射(核心参数表)

### 7.1 `--dv-amp` 映射(说话跳动)

| 层 | 属性 | amp=0(静默) | amp=1(峰值) | CSS 公式 |
|----|------|------|------|------|
| `__mist` | scale | 1.0 | 1.22 | `transform: scale(calc(1 + var(--dv-amp, 0) * 0.22))` |
| `__mist` | opacity | 0.52 | 1.0 | `opacity: calc(0.52 + var(--dv-amp, 0) * 0.48)` |
| `__mist` | brightness/saturate | 1 / 1 | 1.55 / 1.4 | `filter: blur(8px) brightness(calc(1 + var(--dv-amp,0)*0.55)) saturate(calc(1 + var(--dv-amp,0)*0.4))` |
| `__mistring` | opacity | 0.5 | 0.95 | `opacity: calc(0.5 + var(--dv-amp, 0) * 0.45)` |
| `__globe` | scale | 1.0 | 1.06 | `transform: scale(calc(1 + var(--dv-amp, 0) * 0.06))`(星球稳重,**禁止调大**) |
| `__atmo` | opacity | 0.55 | 1.0 | `opacity: calc(0.55 + var(--dv-amp, 0) * 0.45)` |
| `__glint` | opacity | 0.6 | 0.9 | `opacity: calc(0.6 + var(--dv-amp, 0) * 0.3)` |

每个 amp 消费层加帧间平滑(数值与 nebula 根层一致):

```css
transition:
  transform 45ms var(--dv-ease-silk),
  opacity 45ms var(--dv-ease-silk),
  filter 65ms var(--dv-ease-silk);
```

注意:`.dv-planet` 根层**不加** nebula 式整体 `scale(1+amp*0.3)`——分层差异响应替代整体缩放,这是两个方案的本质区别。

### 7.2 常驻动画(无关音量)

| 层 | 动画 | 时长 | 缓动 |
|----|------|------|------|
| `__deepfield` | `dv-deepfield-twinkle`(复用) | `calc(var(--dv-tempo) * 2.5)` = 6s | ease-in-out infinite |
| `__mist` | `dv-planet-mist-drift`(新):`background-position` 微移 + `rotate(±3deg)` 呼吸 | `var(--dv-tempo-x3)` = 7.2s | ease-in-out infinite |
| `__mistring-spin` | `dv-nebula-spin`(复用,360° 旋转) | idle `calc(var(--dv-tempo)*6)` = 14.4s,见 §8 | linear infinite |
| `__surface` | `dv-planet-band-drift`(新):`translateX(0 → -14px)` | `calc(var(--dv-tempo) * 5)` = 12s | linear infinite alternate |

新增 keyframes(共 2 个):

```css
@keyframes dv-planet-mist-drift {
  0%, 100% { transform: scale(1) rotate(0deg); }
  50%      { transform: scale(1.05) rotate(3deg); }
}
/* 注意与 amp scale 复合:把 amp scale 挂在外层包装或用 CSS 变量合并,
   禁止同一元素同时由 animation 和行内 amp 各写一个 transform 互相覆盖。
   推荐:__mist 自身吃 amp(style 计算的 transform),drift 动画放到
   __mist::before 承载背景层;或者 drift 只动 background-position。
   实现者二选一,审核时说明选择理由。*/

@keyframes dv-planet-band-drift {
  from { transform: translateX(0); }
  to   { transform: translateX(-14px); }
}
```

### 7.3 状态转速(参照 nebula 的状态分速)

```css
.dv-capsule[data-state="idle"] .dv-planet__mistring-spin       { animation-duration: calc(var(--dv-tempo) * 6); }
.dv-capsule[data-state="recording"] .dv-planet__mistring-spin  { animation-duration: calc(var(--dv-tempo) * 2.5); }
.dv-capsule[data-state="processing"] .dv-planet__mistring-spin { animation-duration: var(--dv-tempo); }
.dv-capsule[data-state="processing"] .dv-planet__surface       { animation-duration: calc(var(--dv-tempo) * 2); }
```

## 8. 四态行为表

调色板自动继承 `.dv-capsule[data-state=…]` 现有变量,planet 只加一组与 nebula/stardust 同款的覆写(直接并入现有选择器组,**不新造色值**):

```css
/* 并入 pill-v2.css 现有规则(约 1511、1539 行)*/
.dv-capsule[data-state="recording"][data-style="planet"] { /* 与 nebula/stardust 同组:116,236,255 / 255,164,108 / 255,102,188 */ }
.dv-capsule[data-state="idle"][data-style="planet"]      { /* 与 nebula/stardust 同组:184,240,255 / 156,206,255 / 222,192,255 */ }
```

| 状态 | 表现 |
|------|------|
| idle | 冰蓝紫雾,慢旋 14.4s,整体 `saturate(0.92)`(并入 1731 行规则组) |
| starting | 复用现有 `data-bloom` 520ms 辉光脉冲机制,无需新代码 |
| recording | 霓虹三色(青/橙/品红),雾随 amp 跳动,环 6s 旋 |
| processing | 紫系调色板自动换装,环 2.4s 快旋 + 表面条纹加速 = "思考中" |
| success | 复用 `<Sparkles />`(Capsule.tsx 已对无壳分支渲染) |
| error | `filter: saturate(0.45) brightness(0.72)`(并入 1779 行 nebula error 规则) |

## 9. 技术禁区(违反任意一条退回返工)

1. **禁止把 `animation-duration` 绑定 `--dv-amp`**——运行中改 duration 会造成相位跳变(帧跳)。转速只按 data-state 分档。
2. **禁止把 `box-shadow` 绑定 `--dv-amp`**——box-shadow 不走 GPU 合成,每帧重绘代价高。辉光呼吸用「预制 shadow + opacity 渐变」实现(§7.1 的 `__atmo` 即此法)。
3. amp 只允许驱动 `transform` / `opacity` / `filter` 三类合成器友好属性。
4. 同一元素禁止 animation 与行内 amp transform 双写覆盖(见 §7.2 keyframes 注释)。
5. 禁止 WebGL / canvas / JS 逐帧计算(`useCapsuleAmplitude` 已是唯一 rAF 源)。
6. 禁止改动现有 flow / stardust / nebula 三风格的任何样式与组件。
7. 禁止改 `main.js` / `preload.js` / 主进程窗口尺寸逻辑(`lastExpandedPanelSize` 自动适配)。
8. 合成层预算:`.dv-planet` 子元素 ≤ 9 个 span,blur 合计不超过 nebula 现状量级(haze 6px + disk 3px 级别;本方案 mist 8px + mistring 4px,持平)。

## 10. 实现顺序

1. `recordingAnimationStyle.ts` + `types/electron.ts`(类型先行,TS 全链路报错导航)
2. `PlanetOrb.tsx` 静态 DOM
3. `pill-v2.css`:§5 布局 → §6 渐变 → §7.2 常驻动画 → §7.1 amp 映射 → §7.3/§8 状态区块
4. `Capsule.tsx` 接线(nebula 无壳分支放行 planet)
5. `App.jsx` 窗口尺寸放行
6. `GeneralSection.tsx` 设置项 + 预览
7. i18n 10 locale 补 key
8. 验收(§11)

## 11. 验收清单(执行 [A] / 验收 [B] / 熔断 [C] / 措施 [D])

- 执行 [A]:按 §10 顺序完成 8 个文件改动。
- 验收 [B],全部必须通过:
  1. `node scripts/check-i18n.js` — zh-CN/en 无缺键、占位符一致
  2. `npx tsc --noEmit`(或仓库等价 typecheck)— 类型联合补全无遗漏
  3. `npx eslint src/components/capsule/PlanetOrb.tsx src/components/settings/GeneralSection.tsx --no-warn-ignored` 0 error
  4. `npm run build`(或 `npm run dev` 启动)成功
  5. 视觉验收(真机,设置页预览 + 实际录音各过一遍):
     - 切到「星球」,预览出现星球+雾,雾随合成电平跳动
     - 快捷键唤起:200×168 圆区,无胶囊壳
     - 持续说话:雾明显扩张增亮,星球本体几乎不动(肉眼可辨的层次差)
     - 静音 2 秒:雾回落到 0.52 透明度基线,无残留高亮
     - processing 态:变紫 + 环快旋;error 态:褪色变暗;success:出 Sparkles
     - 切回 nebula / stardust / flow:三个旧风格逐一确认无回归
  6. 性能:录音 1 分钟,Activity Monitor 中 renderer 进程 CPU 与 nebula 风格对比差异 < 5 个百分点
- 熔断 [C]:任一禁区(§9)违反、旧三风格出现视觉回归、CPU 超标 → 停止合并,回到对应章节修正。
- 措施 [D]:全部改动为新增风格 + 少量放行分支,`git checkout -- <files>` + 删除 `PlanetOrb.tsx` 即完全回滚;不涉及数据/配置迁移。

## 12. 审核交接物(给 Claude)

1. `git diff` 全量
2. §11-B 六项验收的执行结果(命令输出贴原文)
3. 三张截图:idle / recording(说话峰值)/ processing
4. §7.2 keyframes 注释中「mist 双 transform 冲突」的解法选择与理由
