# Fallback 链重构 + 视觉识别优化 + Will 值修复 完整计划

> **状态**: 待执行
> **前置条件**: 等待 yun 提交最新版后开始
> **执行顺序**: 按 P0→P6 依次执行，每步 `node --check` 验证

---

## P0 — Will 值修复

### 问题

`calculateWillFactor()` 忽略人格文件的 `will` 字段。

**当前代码** (`utils.js:285`):
```js
function calculateWillFactor(channelKey, personaName, channelSharedCache) {
  // 只接受 3 个参数！第 4 个参数被静默丢弃
  const personaFactor = { '长离': 0.8, '椿': 1.3, '特蕾西娅': 0.9 }[personaName] || 1.0
  // 硬编码的 personaFactor，完全不看 frontmatter 的 will 值
}
```

**调用方** (`index.js:932`):
```js
calculateWillFactor(channelKey, currentPersonaName, channelSharedCache, personaWillContent)
//                                                                   ↑ 传了但被忽略
```

所有自定义人格文件的 will 值（爱弥斯 `will: 1.0`, 椿 `will: 1.3` 等）全部被无视，
由一行硬编码 `{ '长离': 0.8, '椿': 1.3, '特蕾西娅': 0.9 }` 替代。

### 修复方案

**`utils.js:285`** — 加第 4 个参数，解析 frontmatter 的 will 值：
```js
function calculateWillFactor(channelKey, personaName, channelSharedCache, personaContent) {
  let willValue = 1.0
  if (personaContent) {
    const m = personaContent.match(/^will:\s*([\d.]+)$/m)
    if (m) willValue = parseFloat(m[1])
  }
  // ...现有 crowdFactor 逻辑不变...
  const personaFactor = willValue  // 用 frontmatter 的 will，替代硬编码
  // ...
}
```

**`index.js:932`** — 删掉现成的 `personaWillContent` 传参？不变，它已经在传了，只是函数没接。

### 影响

| 人格 | 原 personaFactor | 修复后 | 变化 |
|------|:----------------:|:------:|:----:|
| 爱弥斯 | 1.0 | 1.0（`will: 1.0`） | 无 |
| 椿 | 1.3 | 1.3（`will: 1.3`） | 无 |
| 特蕾西娅 | 0.9 | 0.9（`will: 0.9`） | 无 |
| 长离 | 0.8 | 0.8（`will: 0.8`） | 无 |
| 新模式/未来人格 | 1.0（兜底） | 读取实际 will 值 | ✅ 真正生效 |

### 涉及文件

| 文件 | 改动 |
|------|------|
| `lib/utils.js:285` | `calculateWillFactor` 加第 4 参数 + 解析 will |
| `frontend/.../PersonaPanel.vue` | 人格编辑表单加 will 滑动条 |

---

## P1 — API Fallback 三卡重构

### P1a — 三条默认 fallback 链

**`api.js`** 新增常量，区分三条链：

```js
DEFAULT_CHAT_FALLBACK = [
  { model: 'glm-4.6v-flash', provider: 'glm' },
  { model: 'deepseek-v4-flash', provider: 'opencode' },
  { model: 'qwen3.5-omni-flash', provider: 'dashscope' },
  { model: 'qwen3.5-plus', provider: 'dashscope' },
]

DEFAULT_VISION_FALLBACK = [
  { model: 'glm-4.6v-flash', provider: 'glm' },
  { model: 'mimo-v2-omni', provider: 'mimorium' },
  { model: 'qwen3.5-omni-flash', provider: 'dashscope' },
  { model: 'qwen3.5-plus', provider: 'dashscope' },
]

DEFAULT_LIGHTWEIGHT_FALLBACK = [
  { model: 'glm-4.6v-flash', provider: 'glm' },
  { model: 'deepseek-v4-flash', provider: 'opencode' },
  { model: 'qwen3.5-omni-flash', provider: 'dashscope' },
  { model: 'qwen3.5-plus', provider: 'dashscope' },
]
```

### P1b — `buildFallbackConfig()` 改造逻辑

```
requestChatCompletions(messages, config, { _fallbackSet: 'chat'|'vision'|'lightweight' })
                                    │
                                    ▼
                    buildFallbackConfig(config, step, fallbackSet)
                                    │
            ┌───────────────────────┼───────────────────────┐
            ▼                       ▼                       ▼
      _fallbackSet='chat'    _fallbackSet='vision'   _fallbackSet='lightweight'
            │                       │                       │
      ai-fallback-chains.json  ai-fallback-chains.json  ai-fallback-chains.json
      .chat 数组 / DEFAULT     .vision 数组 / DEFAULT   .lightweight 数组 / DEFAULT
            │                       │                       │
            ▼                       ▼                       ▼
      每个 step 解析 provider:
        ├─ 内置 provider → PROVIDERS.baseURL + 对应 key 文件
        └─ 自定义 provider → ai-providers-custom.json 的 baseURL + keyFile
            │                       │                       │
            └───────────────────────┼───────────────────────┘
                                    ▼
                        全部 4 步耗尽 → _originalConfig 主模型兜底
```

### P1c — `_fallbackSet` 标注表

| 文件:行 | 调用点 | 标记 |
|----------|--------|:----:|
| `chat.js:259,778,789,800` | 主聊天 + 重试 | `chat` |
| `handler.js:234` | 吐槽我 | `chat` |
| `handler.js:249` | 帮我说话 | `chat` |
| `retaliation.js:21` | 反击打分 | `lightweight` |
| `conversation.js:76` | 群聊摘要 | `lightweight` |
| `conversation.js:300` | 敏感检测 | `lightweight` |
| `chat.js:112` | 话题切换检测 | `lightweight` |
| `chat.js:294` | 越狱回复 | `lightweight` |
| `chat.js:647` | 评价总结 | `lightweight` |
| `handler.js:444,479` | 今日情绪 | `lightweight` |
| 视觉调用 | 多模态/识图 | `vision` |

### P1d — `chatJailbreak` 裸 fetch 修复

**`chat.js:294`** — 当前使用裸 `fetch()`，无任何 fallback。

改为走 `requestChatCompletions`：
```js
const reply = await requestChatCompletions(
  messages,
  config,
  { max_tokens: 60, _fallbackSet: 'lightweight' }
)
```

---

## P2 — 视觉模型识别改造

### 问题

```js
// 当前：硬编码正则，自定义供应商的视觉模型匹配不到
function isVisionModel(provider, modelId) {
  if (/qwen/i.test(modelId)) return true
  if (/glm/i.test(modelId)) return true
  if (/kimi/i.test(modelId)) return true
  if (provider === 'mimorium' && /omni/i.test(modelId)) return true
  return false
}
```

### 修复

**`constants.js`** — `PROVIDERS` 每个模型加 `vision` 标记：

```js
const PROVIDERS = {
  glm: { name: '智谱GLM', baseURL: '...', models: [
    { id: 'glm-4.6v-flash', name: 'GLM 4.6', vision: true },
  ]},
  opencode: { name: 'OpenCode Go', baseURL: '...', models: [
    { id: 'deepseek-v4-flash', name: 'DSv4', vision: false },
    { id: 'kimi-k2.5', name: 'Kimi K2.5', vision: true },
  ]},
  // ...
}
```

**`api.js`** — `isVisionModel` 改查标记：

```js
function isVisionModel(provider, modelId) {
  // 1. 查内置 PROVIDERS
  const p = PROVIDERS[provider]
  if (p) {
    const m = p.models.find(x => x.id === modelId)
    if (m) return !!m.vision
  }
  // 2. 查自定义供应商
  const custom = readCustomProviders()
  const cp = custom.find(x => x.id === provider)
  if (cp) return cp.models?.some(x => x.id === modelId && x.vision)
  // 3. fallback 正则（兼容旧数据）
  return /qwen|glm|kimi|omni/i.test(modelId)
}
```

**自定义供应商数据格式**（`ai-providers-custom.json`）：
```json
{
  "id": "my-provider",
  "name": "我的视觉供应商",
  "baseURL": "https://...",
  "keyFile": "ai-my-key.txt",
  "models": [
    { "id": "my-vision-model", "name": "视觉模型", "vision": true },
    { "id": "my-text-model", "name": "文本模型", "vision": false }
  ]
}
```

---

## P3 — 自定义 Provider Key 解析

**`runtime-config.js`** — 新增函数：

```js
function resolveCustomProviderKey(customProviders, providerId, fallbackKey) {
  const cp = customProviders.find(p => p.id === providerId)
  if (!cp?.keyFile) return fallbackKey
  return readTextFile(cp.keyFile).catch(() => fallbackKey)
}
```

`buildFallbackConfig` 调用此函数代替原来直接读 `GLM_KEY_FILE` 等常量：

```js
// 原来
if (fallback.keyFile) {
  next.apiKey = (await readTextFile(fallback.keyFile).catch(() => '') || config.apiKey)
}
// 改为 — 也查自定义 provider
next.apiKey = resolveCustomProviderKey(customProviders, fallback.provider, fallbackKey)
```

---

## P4 — 后端 API 升级

**`standalone.js`**

### `GET /dashboard/api/fallback`

```json
{
  "chains": { "chat": [...], "vision": [...], "lightweight": [...] },
  "default": { "chat": DEFAULT_CHAT_FALLBACK, "vision": DEFAULT_VISION_FALLBACK, "lightweight": DEFAULT_LIGHTWEIGHT_FALLBACK },
  "providers": { "glm": { "name": "智谱GLM", "models": [...] }, "opencode": {...}, "dashscope": {...}, "mimorium": {...}, "my-provider": {...} }
}
```

### `PUT /dashboard/api/fallback`

写入 `ai-fallback-chains.json`，保存用户自定义的三条链。

### `GET/PUT /dashboard/api/providers/custom`

支持新增字段：
- `keyFile` — 自定义供应商的密钥文件路径
- `models[].vision` — 模型是否支持视觉

---

## P5 — 前端 ConfigPanel 改造

### 删除
旧「Fallback 链」UI 卡片（chat/vision/analysis 三栏目 + 重置按钮的复杂版）

### 新建三张卡片

#### 卡片 1：聊天 Fallback
```
┌──────────────────────────────────────────────────┐
│ 聊天 Fallback                                     │
│（主聊天 / 吐槽我 / 帮我说话）                       │
│                                                   │
│ 优先使用 → [主模型] ← 不可编辑                      │
│                                                   │
│ Step 1  [供应商▾] [模型▾]                    [✕]   │
│ Step 2  [供应商▾] [模型▾]                    [✕]   │
│ Step 3  [供应商▾] [模型▾]                    [✕]   │
│ Step 4  [供应商▾] [模型▾]                    [✕]   │
│                              [+ 添加步骤]          │
│                                                   │
│ 最后兜底 → [主模型] ← 不可编辑                      │
│                                                   │
│ [保存 Fallback 链]  [重置为默认]                    │
└──────────────────────────────────────────────────┘
```

#### 卡片 2：视觉 Fallback

同聊天结构。默认链：`glm → mimo-v2-omni → qwen-omni → qwen-plus`

#### 卡片 3：轻量功能 Fallback
```
┌──────────────────────────────────────────────────┐
│ 轻量功能 Fallback                                  │
│（反击打分 / 摘要 / 敏感检测 / 话题切换              │
│  越狱回复 / 今日情绪 / 评价总结）                   │
│                                                   │
│ Step 1  [供应商▾] [模型▾]                    [✕]   │
│ Step 2  [供应商▾] [模型▾]                    [✕]   │
│ Step 3  [供应商▾] [模型▾]                    [✕]   │
│ Step 4  [供应商▾] [模型▾]                    [✕]   │
│                              [+ 添加步骤]          │
│                                                   │
│ ☑ 主模型兜底（最后试一次主模型）                     │
│                                                   │
│ [保存 Fallback 链]  [重置为默认]                    │
└──────────────────────────────────────────────────┘
```

供应商下拉绑定 `allProviders`（内置 + 自定义合并），选择后模型下拉自动填充该供应商的模型列表。
新增/删除自定义供应商后即时同步，无需刷新页面（见下方「自定义供应商保存后即时同步到 Fallback 下拉框」）。

### 自定义供应商 UI 改造

当前：
```
[id] [name] [baseURL] [✕]
  模型1 [✕]
  模型2 [✕]
  [+模型]
```

改为：
```
[id] [name] [baseURL] [keyFile路径] [✕]
  模型1: [模型ID] ☐ 视觉 [✕]
  模型2: [模型ID] ☐ 视觉 [✕]
  [+ 模型]
```

### 前端 `api.js`

```js
export async function fetchFallbackChains() { return get('/fallback') }
export async function saveFallbackChains(chains) { return put('/fallback', { chains }, true) }
// fetchCustomProviders / saveCustomProviders 更新为支持 keyFile + vision
```

### 自定义供应商保存后即时同步到 Fallback 下拉框

**目标**：在自定义供应商卡片里新增/修改供应商并点「保存」后，Fallback 三张卡片的下拉框**立即出现新供应商**，无需刷新页面。

**方案**：`ConfigPanel.vue` 中自定义供应商和 Fallback 链共享同一个 `providers` 数据源。

```js
// 数据源结构（reactive，三张 Fallback 卡片共用）
const allProviders = ref({})  // { "glm": {...}, "opencode": {...}, "my-custom": {...} }

// 初始化时合并两个来源
async function loadAllProviders() {
  const [pRes, cpRes] = await Promise.all([fetchProviders(), fetchCustomProviders()])
  const merged = { ...(pRes.ok ? pRes.data : {}), ...(cpRes.ok ? cpRes.data : {}) }
  allProviders.value = merged
}

// 自定义供应商保存成功后 -> 立即合并到 allProviders
async function saveCustomProvidersAction() {
  // ...现有验证逻辑...
  const res = await saveCustomProviders(cleaned)
  if (res.ok) {
    // 合并新数据到 allProviders，Fallback 下拉自动刷新
    const customMap = {}
    for (const cp of cleaned) { customMap[cp.id] = cp }
    allProviders.value = { ...allProviders.value, ...customMap }
    // 清理掉已删除的自定义供应商
    for (const key of Object.keys(allProviders.value)) {
      if (!PROVIDERS_IDS.includes(key) && !cleaned.find(c => c.id === key)) {
        delete allProviders.value[key]
      }
    }
  }
}
```

Fallback 卡片的下拉框直接绑定 `allProviders`：
```html
<select v-model="step.provider">
  <option v-for="(p, key) in allProviders" :key="key" :value="key">{{ p.name }}</option>
</select>
```

选择供应商后模型下拉自动过滤：
```html
<select v-model="step.model">
  <option v-for="m in allProviders[step.provider]?.models || []" :key="m.id" :value="m.id">{{ m.name }}</option>
</select>
```

**效果**：
1. 新增自定义供应商 → 点保存 → `allProviders` 立即更新 → 三张 Fallback 卡片的供应商下拉立即出现
2. 删除自定义供应商 → 点保存 → `allProviders` 移除该条目 → 下拉消失
3. 如果某条 Fallback 正在使用已被删除的供应商 → 自动清空/标记为无效

---

## P6 — Will 值前端滑动条

**`PersonaPanel.vue`** — 人格编辑表单中 `will` 字段改为滑动条：

```
当前：
  [will input] 文本输入框，默认 1.0

改为：
  Will 值（影响随机回复触发率）
  [━━━━━━●━━━━━━] 1.0
  0.1             2.0
```

- 范围：0.1 ~ 2.0
- 步长：0.1
- 保存时作为 `will` 字段写入 frontmatter
- PUT 时 `standalone.js` 已支持（`willLine` 已有 `parseFloat(will)` 处理）

---

## 执行顺序总表

```
Step  Order   File                    Change
────  ─────   ────                    ──────
P0    1       lib/utils.js            calculateWillFactor 接第4参数 + 解析 will
P0    2       frontend/PersonaPanel   will 滑动条

P1    3       lib/api.js              DEFAULT_CHAT/VISION/LIGHTWEIGHT 常量
P1    4       lib/api.js              buildFallbackConfig 三链路由 + 主模型兜底
P1    5       lib/api.js              requestChatCompletions 存 _originalConfig
P1    6       lib/chat.js             chatJailbreak 改 requestChatCompletions
P1    7       lib/chat.js             标注 _fallbackSet
P1    8       lib/conversation.js     标注 _fallbackSet
P1    9       lib/handler.js          标注 _fallbackSet
P1    10      lib/retaliation.js      标注 _fallbackSet

P2    11      lib/constants.js        PROVIDERS 加 vision 标记
P2    12      lib/api.js              isVisionModel 改查标记

P3    13      lib/runtime-config.js   自定义 provider key 解析函数

P4    14      standalone.js           GET/PUT /fallback 升级
P4    15      standalone.js           GET/PUT /providers/custom 支持 keyFile+vision

P5    16      frontend/src/api.js     更新 fallback + providers 函数
P5    17      frontend/ConfigPanel    三张卡片 + 自定义供应商加字段

语法  18      node --check 全部 JS 文件
构建  19      npm run build（前端）
推送  20      git push qiongtu2077 bot_ZZY
部署  21      scp 变更文件 + restart.sh
```

---

## 文件变更汇总

| 文件 | P# | 改动类型 |
|------|:--:|----------|
| `lib/utils.js` | P0 | `calculateWillFactor` 加参数 + 解析 will |
| `lib/index.js` | P0 | 传参不变（已传第4个），无需改 |
| `lib/api.js` | P1,P2 | 新常量 + `buildFallbackConfig` 重构 + `isVisionModel` + `chatJailbreak` |
| `lib/chat.js` | P1 | chatJailbreak 改用 requestChatCompletions + 标注 |
| `lib/conversation.js` | P1 | 标注 `_fallbackSet: 'lightweight'` |
| `lib/handler.js` | P1 | 标注 `_fallbackSet` |
| `lib/retaliation.js` | P1 | 标注 `_fallbackSet: 'lightweight'` |
| `lib/constants.js` | P2 | PROVIDERS 模型加 `vision` 标记 |
| `lib/runtime-config.js` | P3 | 自定义 provider key 解析 |
| `standalone.js` | P4 | fallback API 升级 + custom providers 升级 |
| `frontend/src/api.js` | P5 | 更新函数 |
| `frontend/.../ConfigPanel.vue` | P5 | 三张卡片 + 自定义供应商改造 |
| `frontend/.../PersonaPanel.vue` | P0 | will 滑动条 |

---

## 验证清单

部署后验证以下场景是否正常：

- [ ] 主聊天正常回复（主模型优先）
- [ ] 主模型失败时 fallback 到 glm
- [ ] 全部 fallback 失败时主模型兜底
- [ ] 反击打分正常（轻量功能 fallback）
- [ ] 敏感话题检测正常（轻量功能）
- [ ] 视觉调用正确识别有无视觉能力的模型
- [ ] 自定义供应商的 keyFile 在 fallback 中生效
- [ ] 自定义供应商的视觉模型被 isVisionModel 识别
- [ ] will 值滑动条修改后保存生效
- [ ] will 值影响随机回复触发率
