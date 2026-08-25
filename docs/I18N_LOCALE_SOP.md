# i18n / 语音包检查与修复 SOP

适用场景：以后当用户说“检查语音包”“看看翻译有没有漏”“把语言包修一下”时，默认按这套流程执行。

说明：这个仓库里的“语音包”实际是 UI / prompt 本地化资源，主要位于：

- `src/locales/*/translation.json`
- `src/locales/*/prompts.json`

## 基准规则

- `zh-CN`：产品文案源语言
- `en`：运行时兜底语言
- `zh-CN` 与 `en`：必须双向同步，不能互相缺键
- 其他语言：允许缺键，运行时自动回退到英文

## 默认执行顺序

### 1. 先做结构检查

必看文件：

- `src/i18n.ts`
- `src/helpers/i18nMain.js`
- `scripts/check-i18n.js`
- `src/locales/*/translation.json`
- `src/locales/*/prompts.json`

先运行：

```bash
node scripts/check-i18n.js
```

判定规则：

- `zh-CN` / `en` 缺键：必须修
- 任意占位符不一致：必须修
- 其他语言缺键：日常开发允许，但要确认英文兜底正常
- 正式发布前：必须运行 `npm run i18n:check:release`，德/西/法/意/葡/俄 marketed locales 不允许缺 key 回落英文

### 2. 再查界面硬编码

优先查组件里直接写死、不会经过 i18n 的文案：

```bash
rg -n --glob '*.{jsx,tsx}' '>[[:space:]]*[A-Za-z][^<{]*<' src/components src/App.jsx src/main.jsx
rg -n --glob '*.{jsx,tsx}' 'aria-label=\"[A-Za-z]|placeholder=\"[A-Za-z]|label=\"[A-Za-z]' src/components src/App.jsx src/main.jsx
```

判定规则：

- 用户可见英文硬编码：必须改成 `t(...)`
- 注释、示例 URL、品牌名、模型名、快捷键名：按实际情况保留

### 3. 修复顺序

默认按下面顺序修，不要一上来全语言大重写：

1. 先修组件硬编码
2. 再补 `zh-CN` 与 `en` 的双向缺口
3. 其他语言只补“明显影响体验的高频文案”
4. 其余缺口允许先吃英文 fallback

正式发布前不能保留 marketed locales 的缺口；如果暂时不维护某个语言，先从 marketed locale 集合和对外宣传中移除，再发布。

## 写入规则

- 新增 key 时，必须同时写：
  - `src/locales/zh-CN/...`
  - `src/locales/en/...`
- 不要把“其他 8 个语言都补齐”当成默认要求，除非用户明确要“全语言补完”
- 技术名词、品牌名、API 名称、模型名可保留英文

## 验收

最少做这三步：

```bash
node scripts/check-i18n.js
npm run i18n:check:release
cd src && ../node_modules/.bin/tsc --noEmit
cd src && ../node_modules/.bin/vite build
```

如果仓库本身已有独立构建错误：

- 要明确区分“本次 i18n 改动引入的问题”和“仓库原有问题”
- 不要把现存无关报错混成 i18n 修复失败

## 回复用户时的默认输出

优先说明：

1. 结构是否通过
2. 是否发现硬编码
3. `zh-CN` / `en` 是否同步
4. 还有哪些语言在吃英文兜底
5. 验证结果是否通过

## 简化原则

- 默认最小修改面
- 优先修“看得到的问题”
- 优先保证 `zh-CN` / `en` 稳定
- 其他语言先可用，再完整
