# Agent 思考过程可视化 + Thinking 控制 计划

> **状态**: 待执行
> **目标**: Agent Console 网页端展示 Agent 思考过程（折叠面板），QQ 端保持只输出结果
> **策略**: 按钮控制 thinking 开关，默认关闭
> **新增**: Plan/Build 模式切换 + Composer 自动补全（/ @ #）

---

## 问题诊断

### 根因

`api.js:138` 主请求路径只对 DashScope 禁用了 thinking：

```js
...(isDashScopeConfig(config) ? { enable_thinking: false } : {}),
// ← mimo/glm/kimi 没有禁用 thinking！
```

而 `buildManagedThinkingArgs`（line 69-78）已正确处理了所有 provider：

```js
if (/glm|mimo|kimi/i.test(model)) return { thinking: { type: 'disabled' } }
```

但**只在 fallback 路径生效**（通过 `rebuildFallbackExtraBody` 调用），主请求路径漏了。

### 现象

- mimo-v2-omni 是 thinking 模型，默认启用思考
- 思考过程消耗 token 预算 → `content` 可能为空
- `api.js:162-168` 检测到空 content → 触发 fallback 链
- 多次 fallback 总时间接近/超过 90s queue timeout
- 前端一直显示 "执行中..." 直到超时

### 验证结果（服务器实测）

| 模型 | 无 thinking 控制 | thinking: disabled |
|------|:----------------:|:------------------:|
| mimo-v2-omni | content 可能为空 ✗ | 正常返回 ✓ |
| glm-4.6v-flash | HTTP 429 (限流) | HTTP 429 (限流) |
| deepseek-v4-flash | 正常返回 ✓ | 正常返回 ✓ |

---

## 改动范围（5 个文件）

| 文件 | 改动 |
|------|------|
| `lib/api.js` | 主请求统一用 `buildManagedThinkingArgs`；返回 `{ content, reasoning, tool_calls }` |
| `lib/agent/engine.js` | 按渠道/参数控制 thinking；累积每轮 `{ reasoning, toolName, toolResult }`；返回 `rounds` 数组 |
| `standalone.js` | `/agent/chat` 透传 `rounds`；接收 `enableThinking` 参数 |
| `agent-console/src/api/client.ts` | `chat` 方法增加 `enableThinking` 参数 |
| `agent-console/src/main.tsx` | Plan/Build 切换 + Thinking 开关 + Timeline UI + Composer 自动补全 |

---

## Step 1 — `api.js` 修复 thinking 控制 + 返回 reasoning

### 1a — 主请求路径统一用 `buildManagedThinkingArgs`

**`api.js:136-141`** 改为：

```js
body: JSON.stringify({
  model: config.model, temperature: 0.9, max_tokens: maxTokens,
  ...filteredExtraBody, messages: providerMessages,
  ...(tools && Array.isArray(tools) && tools.length ? { tools, tool_choice: 'auto' } : {}),
  ...buildManagedThinkingArgs(config, !!extraBody._thinkingEnabled),
}),
```

删除原来的 DashScope 专用逻辑：
```js
// 删除这行
...(isDashScopeConfig(config) ? { enable_thinking: false } : {}),
```

### 1b — 返回值改为对象，保留 reasoning_content

**`api.js:154-177`** 修改返回逻辑：

```js
const data = await response.json()
const m = data?.choices?.[0]?.message || {}

// tool_calls 优先
if (tools && m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
  return { type: 'tool_calls', tool_calls: m.tool_calls, message: m, reasoning: m.reasoning_content || '' }
}

let content = m.content && m.content.trim() ? m.content : ''

// 有 reasoning_content 但无 content 时，不再 fallback，而是返回 reasoning
if (!content && m.reasoning_content) {
  return { type: 'text', content: '', reasoning: m.reasoning_content }
}

if (!content) throw new Error('Empty model response.')
return { type: 'text', content: String(content).replace(/\s+/g, ' ').trim(), reasoning: m.reasoning_content || '' }
```

### 1c — 所有调用方适配

需要适配 `requestChatCompletions` 返回对象的地方：

| 文件 | 改动 |
|------|------|
| `chat.js:302,306,310,317` | 已有 `getThinkingArgs`，返回值需适配对象 |
| `conversation.js:198` | 取 `.content` |
| `conversation.js:572` | 取 `.content` |
| `agent/engine.js:90` | 取 `.content` + `.reasoning` + `.tool_calls` |
| `agent/router.js:44` | 取 `.content` |
| `retaliation.js:21` | 取 `.content` |
| `health-check.js:48` | 取 `.content` |
| `agent/tools/web-search.js:143` | 取 `.content` |

**兼容方案**：让 `requestChatCompletions` 返回对象，但调用方用 `typeof` 判断：

```js
const result = await requestChatCompletions(messages, config, extraBody, tools)
const content = typeof result === 'string' ? result : result.content
const reasoning = typeof result === 'string' ? '' : (result.reasoning || '')
```

---

## Step 2 — `engine.js` 累积 thinking 和工具调用记录

### 2a — `runAgent` 接收 `enableThinking` 参数

**`engine.js:177`** 函数签名增加：

```js
async function runAgent({ userMessage, userName, userId, channelKey, channel = 'qq', systemExtra = [], history = [], forceTools = [], preExecuteTools = [], onProgress, bot, enableThinking = false }) {
```

### 2b — `continueAgent` 接收并传递 `enableThinking`

**`engine.js:85`** 函数签名增加：

```js
async function continueAgent({ messages, config, tools, allowedToolNames, channel, channelKey, userId, userName, userMessage, toolCount = 0, toolResults = [], onProgress, bot, enableThinking = false }) {
```

### 2c — 构建每轮 thinking 控制参数

在 `continueAgent` 循环内，调用 `requestChatCompletions` 前：

```js
const thinkingArgs = enableThinking
  ? {}  // 启用 thinking，不传参数（让 buildManagedThinkingArgs 按模型默认处理）
  : buildManagedThinkingArgs(config, false)  // 禁用 thinking
```

### 2d — 累积 rounds 数据

```js
const rounds = []  // 新增

// 在每轮循环中：
const response = await requestChatCompletions(messages, config, thinkingArgs, tools)

const reasoning = typeof response === 'string' ? '' : (response.reasoning || '')
const toolCalls = typeof response === 'string' ? [] : (response.tool_calls || [])
const assistantContent = typeof response === 'string' ? response : (response.message?.content || '')

if (reasoning || toolCalls.length > 0) {
  rounds.push({
    reasoning: reasoning || null,
    toolCalls: toolCalls.map(tc => ({
      name: tc.function.name,
      args: JSON.parse(tc.function.arguments || '{}'),
    })),
  })
}

// 工具执行后记录结果
for (const tc of activeToolCalls) {
  const outcome = await executeAgentToolCall(...)
  // 在 rounds 中补充 toolResult
  const lastRound = rounds[rounds.length - 1]
  if (lastRound && lastRound.toolCalls) {
    lastRound.toolResults = lastRound.toolResults || []
    lastRound.toolResults.push({
      name: tc.function.name,
      result: String(outcome.result || '').slice(0, 2000),
      ok: outcome.status === 'done' || outcome.status === 'fallback',
    })
  }
}
```

### 2e — 返回 rounds

```js
return { reply, toolCalls: toolCount, pendingId: null, toolResults, rounds, reasoning: rounds.map(r => r.reasoning).filter(Boolean).join('\n\n') }
```

---

## Step 3 — `standalone.js` 透传 rounds + 接收 enableThinking

### 3a — `/agent/chat` 接收 `enableThinking`

**`standalone.js:3777-3807`** 修改：

```js
const data = JSON.parse(body || '{}')
const message = String(data.message || '').trim()
const enableThinking = !!data.enableThinking  // 新增
// ...
const result = await queue.enqueueAgentTask({
  // ...
  fn: () => engine.run({
    userMessage: message,
    userName: String(data.userName || 'Dashboard'),
    userId: String(data.userId || 'dashboard'),
    channelKey: 'dashboard',
    channel: 'dashboard',
    history,
    enableThinking,  // 新增
    ...searchRunOptions,
  }),
})
return json(res, { ok: true, ...result })  // rounds 自动透传
```

---

## Step 4 — `agent-console/src/api/client.ts` 增加 enableThinking

**`client.ts:66`** 修改：

```ts
chat: (message: string, history: any[], enableThinking = false) =>
  request<any>('/agent/chat', { method: 'POST', body: JSON.stringify({ message, history, enableThinking }) }, 90000),
```

---

## Step 5 — `agent-console/src/main.tsx` Plan/Build 切换 + Thinking 开关 + Timeline UI + Composer 自动补全

### 5a — ChatMessage 类型增加 rounds

```tsx
type ChatMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
  pendingId?: string
  id?: string
  pending?: boolean
  rounds?: RoundRecord[]  // 新增
}

type RoundRecord = {
  reasoning: string | null
  toolCalls: Array<{ name: string; args: Record<string, any> }>
  toolResults?: Array<{ name: string; result: string; ok: boolean }>
}
```

### 5b — Plan/Build 模式切换

类似 opencode，在 composer 左下角加切换按钮：

```tsx
type AgentMode = 'plan' | 'build'

const [mode, setMode] = useState<AgentMode>('build')  // 默认 build 模式

// Plan 模式：只读，Agent 只能规划、建议，不能执行修改文件/Shell 等危险工具
// Build 模式：完整权限，Agent 可以执行所有工具

// 在 composer 左侧：
<button
  className={`mode-toggle ${mode}`}
  onClick={() => setMode(mode === 'plan' ? 'build' : 'plan')}
  title={mode === 'plan' ? '切换到 Build 模式（可执行工具）' : '切换到 Plan 模式（仅规划）'}
>
  {mode === 'plan' ? '📋 Plan' : '🔨 Build'}
</button>
```

### 5c — Thinking 开关按钮

在 composer 区域，mode 按钮旁边：

```tsx
const [enableThinking, setEnableThinking] = useState(false)

<label className="thinking-toggle" title="启用思考过程可视化">
  <input type="checkbox" checked={enableThinking} onChange={e => setEnableThinking(e.target.checked)} />
  <span>思考</span>
</label>
```

### 5d — send 函数传递 enableThinking

```tsx
const result = await api.chat(text, history, enableThinking)
```

### 5e — 保存 rounds 到消息

```tsx
setMessages(prev => {
  const base = prev.filter(item => item.id !== pendingMessageId)
  const reply = result.ok ? (result.data?.reply || result.data?.result || result.data?.message || '(Agent 未返回内容)') : (result.message || result.data?.message || '请求失败')
  return [...base, {
    role: 'assistant',
    content: reply,
    pendingId: result.data?.pendingId,
    rounds: result.data?.rounds || [],  // 新增
  }]
})
```

### 5f — Timeline UI 渲染

```tsx
function renderRounds(rounds: RoundRecord[]) {
  if (!rounds || rounds.length === 0) return null

  return (
    <div className="timeline">
      {rounds.map((round, i) => (
        <div key={i} className="timeline-round">
          {round.reasoning && (
            <details className="timeline-thinking">
              <summary>🧠 思考过程</summary>
              <pre>{round.reasoning}</pre>
            </details>
          )}
          {round.toolCalls && round.toolCalls.map((tc, j) => (
            <div key={j} className="timeline-tool">
              <strong>🔧 {tc.name}</strong>
              {round.toolResults && round.toolResults[j] && (
                <pre className={round.toolResults[j].ok ? 'ok' : 'error'}>
                  {round.toolResults[j].result.slice(0, 500)}
                </pre>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
```

### 5g — 消息渲染整合

```tsx
{messages.map((message, index) => (
  <article key={index} className={'message ' + message.role}>
    <div className="avatar">{message.role === 'user' ? '你' : message.role === 'assistant' ? '莲' : '…'}</div>
    <div className="bubble">
      {message.role === 'assistant' && renderRounds(message.rounds)}
      <pre>{message.content}</pre>
      {message.pendingId && <span className="tag warn">等待确认 {message.pendingId}</span>}
    </div>
  </article>
))}
```

### 5h — Composer 自动补全（/ @ #）

输入 `/` 显示命令列表，`@` 显示文件列表，`#` 显示技能列表。

```tsx
type CompletionType = 'command' | 'file' | 'skill' | null

const [completion, setCompletion] = useState<{
  type: CompletionType
  query: string
  items: Array<{ label: string; description: string; value: string }>
  selectedIndex: number
} | null>(null)

// 命令列表
const commands = [
  { label: '/plan', description: '创建计划', value: '/plan ' },
  { label: '/approve', description: '确认工具', value: '/approve ' },
  { label: '/reject', description: '拒绝工具', value: '/reject ' },
  { label: '/status', description: '查看状态', value: '/status ' },
]

// 监听输入变化
function onInputChange(text: string) {
  setInput(text)

  // 检测触发字符
  const cursorPos = textareaRef.current?.selectionStart || 0
  const textBeforeCursor = text.slice(0, cursorPos)
  const slashMatch = textBeforeCursor.match(/\/(\w*)$/)
  const atMatch = textBeforeCursor.match(/@(\S*)$/)
  const hashMatch = textBeforeCursor.match(/#(\w*)$/)

  if (slashMatch) {
    const query = slashMatch[1].toLowerCase()
    const items = commands.filter(c => c.label.slice(1).startsWith(query))
    setCompletion({ type: 'command', query, items, selectedIndex: 0 })
  } else if (atMatch) {
    const query = atMatch[1].toLowerCase()
    // 从文件列表过滤
    const items = (files || []).filter(f => f.rel.toLowerCase().includes(query)).slice(0, 10).map(f => ({
      label: f.rel,
      description: `${f.size} bytes`,
      value: `@${f.rel} `,
    }))
    setCompletion({ type: 'file', query, items, selectedIndex: 0 })
  } else if (hashMatch) {
    const query = hashMatch[1].toLowerCase()
    // 从技能列表过滤
    const items = (skills || []).filter(s => s.name.toLowerCase().includes(query)).slice(0, 10).map(s => ({
      label: s.name,
      description: s.description || '',
      value: `#${s.name} `,
    }))
    setCompletion({ type: 'skill', query, items, selectedIndex: 0 })
  } else {
    setCompletion(null)
  }
}

// 键盘导航
function onComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
  if (completion && completion.items.length > 0) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setCompletion({ ...completion, selectedIndex: Math.min(completion.selectedIndex + 1, completion.items.length - 1) })
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setCompletion({ ...completion, selectedIndex: Math.max(completion.selectedIndex - 1, 0) })
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      selectCompletion(completion.items[completion.selectedIndex])
    } else if (event.key === 'Escape') {
      setCompletion(null)
    }
  } else {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) send()
    if (event.key === 'Escape') setInput('')
  }
}

// 选择补全项
function selectCompletion(item: { value: string }) {
  const cursorPos = textareaRef.current?.selectionStart || 0
  const textBeforeCursor = input.slice(0, cursorPos)
  const textAfterCursor = input.slice(cursorPos)

  // 替换触发字符到光标位置
  let newText: string
  if (completion?.type === 'command') {
    const match = textBeforeCursor.match(/\/\w*$/)
    newText = match ? textBeforeCursor.slice(0, match.index) + item.value + textAfterCursor : input + item.value
  } else if (completion?.type === 'file') {
    const match = textBeforeCursor.match(/@\S*$/)
    newText = match ? textBeforeCursor.slice(0, match.index) + item.value + textAfterCursor : input + item.value
  } else {
    const match = textBeforeCursor.match(/#\w*$/)
    newText = match ? textBeforeCursor.slice(0, match.index) + item.value + textAfterCursor : input + item.value
  }

  setInput(newText)
  setCompletion(null)
  // 聚焦回 textarea
  setTimeout(() => textareaRef.current?.focus(), 0)
}

// 渲染补全面板
function renderCompletion() {
  if (!completion || completion.items.length === 0) return null

  return (
    <div className="completion-popup">
      {completion.items.map((item, i) => (
        <button
          key={item.label}
          className={`completion-item ${i === completion.selectedIndex ? 'selected' : ''}`}
          onClick={() => selectCompletion(item)}
        >
          <span className="completion-label">{item.label}</span>
          <span className="completion-desc">{item.description}</span>
        </button>
      ))}
    </div>
  )
}
```

### 5i — Composer 布局

```tsx
<div className="composer">
  <div className="composer-left">
    <button className={`mode-toggle ${mode}`} onClick={() => setMode(mode === 'plan' ? 'build' : 'plan')}>
      {mode === 'plan' ? '📋 Plan' : '🔨 Build'}
    </button>
    <label className="thinking-toggle">
      <input type="checkbox" checked={enableThinking} onChange={e => setEnableThinking(e.target.checked)} />
      <span>思考</span>
    </label>
  </div>
  <div className="composer-input-wrapper">
    <textarea
      ref={textareaRef}
      value={input}
      onChange={e => onInputChange(e.target.value)}
      onKeyDown={onComposerKeyDown}
      placeholder="/plan、/approve、@文件、#技能"
    />
    {renderCompletion()}
  </div>
  <div className="composer-actions">
    <span>{input.length} 字</span>
    <button onClick={send} disabled={sending || !input.trim()}>{sending ? '发送中' : '发送'}</button>
  </div>
</div>
```

---

## 执行顺序

```
Step  Order   File                              Change
────  ─────   ────                              ──────
1a    1       lib/api.js                        主请求用 buildManagedThinkingArgs
1b    2       lib/api.js                        返回对象 { content, reasoning, tool_calls }
1c    3       lib/chat.js                       适配对象返回值
1c    4       lib/conversation.js               适配对象返回值
1c    5       lib/agent/router.js               适配对象返回值
1c    6       lib/retaliation.js                适配对象返回值
1c    7       lib/health-check.js               适配对象返回值
1c    8       lib/agent/tools/web-search.js     适配对象返回值

2a    9       lib/agent/engine.js               runAgent 接收 enableThinking
2b    10      lib/agent/engine.js               continueAgent 接收 enableThinking
2c    11      lib/agent/engine.js               构建 thinkingArgs
2d    12      lib/agent/engine.js               累积 rounds 数据
2e    13      lib/agent/engine.js               返回 rounds

3a    14      standalone.js                     /agent/chat 透传 rounds + enableThinking

4     15      agent-console/src/api/client.ts   chat 增加 enableThinking 参数

5a    16      agent-console/src/main.tsx        ChatMessage 类型增加 rounds
5b    17      agent-console/src/main.tsx        Plan/Build 模式切换按钮
5c    18      agent-console/src/main.tsx        Thinking 开关按钮
5d    19      agent-console/src/main.tsx        send 传递 enableThinking
5e    20      agent-console/src/main.tsx        保存 rounds 到消息
5f    21      agent-console/src/main.tsx        Timeline UI 渲染
5g    22      agent-console/src/main.tsx        消息渲染整合
5h    23      agent-console/src/main.tsx        Composer 自动补全（/ @ #）
5i    24      agent-console/src/main.tsx        Composer 布局调整

语法  25      node --check 全部 JS 文件
构建  26      cd agent-console && npm run build
推送  27      git push
部署  28      scp + restart
```

---

## 验证清单

部署后验证：

- [ ] QQ 聊天正常回复（不受影响，thinking 默认关闭）
- [ ] Agent Console 默认关闭 thinking 时正常回复
- [ ] Agent Console 开启 thinking 后显示思考过程
- [ ] 思考过程可折叠/展开
- [ ] 工具调用显示名称和结果
- [ ] 多轮工具调用正确显示 Timeline
- [ ] 无 thinking 时不显示折叠面板
- [ ] 90s 超时问题已修复（不再因 thinking 消耗 token 导致空 content）
- [ ] Plan/Build 模式切换按钮正常
- [ ] 输入 `/` 显示命令补全
- [ ] 输入 `@` 显示文件补全
- [ ] 输入 `#` 显示技能补全
- [ ] 键盘上下键导航补全项
- [ ] Enter/Tab 选择补全项
- [ ] Escape 关闭补全面板

---

## 回退方案

如果出现问题：
1. `api.js` 回退到原来的 DashScope 专用逻辑
2. `engine.js` 回退到不传 enableThinking
3. 前端回退到不传 enableThinking 参数

所有改动向后兼容，旧调用方不传 `enableThinking` 时默认关闭。

---

# HTTP 搜索全链路优化

> **状态**: 待执行
> **目标**: 优化 HTTP 搜索链路，使"鸣潮最新角色"等中文游戏查询能拿到可靠结果
> **策略**: 加搜狗引擎 + 优化 query 生成 + 优化候选 URL + 降低正文阈值 + 摘要兜底

---

## 问题诊断

### 根因

1. **搜索引擎覆盖差**：只有 DuckDuckGo + Bing，对中文游戏内容覆盖极差
2. **`site:` 操作符无效**：`鸣潮 新角色 site:kurogames.com` 在 DuckDuckGo 上基本无效
3. **直接候选 URL 是 SPA**：官网 `wutheringwaves.kurogames.com` 是 JS 渲染，HTTP 拉到空 HTML
4. **正文提取过严**：40 字符最低限制，中文游戏资讯页正文刚好在 30-50 字符之间被拒绝
5. **无摘要兜底**：正文读不到直接返回失败，Agent 拿不到任何信息

### 实测结果

用 `websearch` 工具实际搜索"鸣潮最新角色 2026"，有效来源：
- 17173.com（游戏资讯站，HTML 渲染）
- 9game.cn/九游（游戏资讯站，HTML 渲染）
- cn486.com（资讯聚合站）
- sina.cn（新浪新闻）

这些站都是传统 HTML 渲染，HTTP 能拉到正文。而官网 SPA 拉不到。

---

## 改动范围（3 个文件）

| 文件 | 改动 |
|------|------|
| `lib/agent/http-search.js` | 加搜狗端点 + 降低正文阈值 + 摘要兜底 |
| `lib/agent/search-query.js` | 去掉 `site:` 操作符 + 优化候选 URL |
| `lib/agent/search-results.js` | 增强低质域名过滤 |

---

## Step 1 — `http-search.js` 搜索引擎端点 + 正文阈值 + 摘要兜底

### 1a — 加搜狗端点

**`http-search.js:10-14`** 改为：

```js
const HTTP_SEARCH_ENDPOINTS = [
  { name: 'Sogou', url: query => `https://www.sogou.com/web?query=${encodeURIComponent(query)}` },
  { name: 'DuckDuckGo HTML', url: query => `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}` },
  { name: 'Bing HTTP', url: query => `https://www.bing.com/search?q=${encodeURIComponent(query)}` },
]
```

**效果：** 中文查询走搜狗，英文查询 DuckDuckGo/Bing 兜底。不加百度避免广告干扰。

### 1b — 降低正文提取阈值

**`http-search.js:22`** 改为：

```js
const HTTP_SEARCH_MIN_PAGE_TEXT_CHARS = 20  // 从 40 降到 20
```

**效果：** 中文游戏资讯页正文通常 20-50 字符，降低阈值减少"正文过短"误判。

### 1c — 摘要兜底改为成功返回

**`http-search.js:342-351`** 改为：

```js
if (bestSearchOnlyResult) {
  return {
    ok: true,  // 改为 true，摘要也是有效信息
    text: `${bestSearchOnlyResult.text}\n\n（注：以下为搜索页摘要，未打开候选网页正文，置信度低于已打开正文的结果。）`,
    query: bestSearchOnlyResult.query,
    engine: bestSearchOnlyResult.engine,
    failures,
    pages: [],
  }
}
```

**效果：** Agent 至少能拿到搜索页摘要，而不是直接失败。

---

## Step 2 — `search-query.js` Query 生成 + 候选 URL

### 2a — 去掉 `site:` 操作符

**`search-query.js:54-58`** 改为：

```js
if (isWuwaLatestRoleQuery(query)) {
  pushSearchQuery(queries, '鸣潮 最新角色 2026')
  pushSearchQuery(queries, '鸣潮 新版本 角色 公告')
  pushSearchQuery(queries, '鸣潮 新共鸣者 资讯')
}
```

**效果：** 简单直接的 query 在搜狗上效果更好。去掉无效的 `site:` 操作符。

### 2b — 直接候选 URL 改为第三方资讯站

**`search-query.js:82-95`** 改为：

```js
if (WUWA_RE.test(value)) {
  candidates.push(
    {
      title: '鸣潮最新资讯 - 17173',
      url: 'https://news.17173.com/mingchao/',
      snippet: '鸣潮游戏资讯、攻略、版本更新与角色信息。',
    },
    {
      title: '鸣潮攻略 - 九游',
      url: 'https://www.9game.cn/mingchao/',
      snippet: '鸣潮游戏攻略、角色培养、卡池信息。',
    },
    {
      title: '鸣潮新闻 - TapTap',
      url: 'https://www.taptap.cn/app/228783',
      snippet: '鸣潮官方动态、玩家讨论与版本更新。',
    }
  )
}
```

**效果：** 这些站是传统 HTML 渲染，HTTP 能拉到正文。官网 SPA 拉不到。

---

## Step 3 — `search-results.js` 低质过滤增强

### 3a — 加广告/推广域名过滤

**`search-query.js:21`** 改为：

```js
const LOW_QUALITY_DOMAIN_RE = /(?:699pic|588ku|ibaotu|nipic|vcg|shutterstock|freepik|pngtree|58pic|lovepik|ooopic|素材|模板|壁纸|下载|图片|图库|站酷|千图|觅知|摄图|包图|昵图|推广|广告)/i
```

**效果：** 过滤百度/搜狗搜索结果中的广告和推广链接。

---

## 执行顺序

```
Step  Order   File                              Change
────  ─────   ────                              ──────
1a    1       lib/agent/http-search.js          加搜狗端点
1b    2       lib/agent/http-search.js          正文阈值 40→20
1c    3       lib/agent/http-search.js          摘要兜底改为成功返回

2a    4       lib/agent/search-query.js         去掉 site: 操作符
2b    5       lib/agent/search-query.js         候选 URL 改为第三方资讯站

3a    6       lib/agent/search-query.js         低质域名过滤加广告/推广

语法  7       node --check 全部 JS 文件
推送  8       git push
部署  9       scp + restart
```

---

## 验证清单

部署后验证：

- [ ] "鸣潮最新角色" 能拿到 17173/九游等资讯站结果
- [ ] "鸣潮 3.3 版本" 能拿到版本更新信息
- [ ] 英文查询 DuckDuckGo/Bing 正常
- [ ] 广告/推广链接被过滤
- [ ] 正文过短误判减少
- [ ] 摘要兜底生效（正文读不到时返回摘要）

---

## 预期效果对比

| 场景 | 当前 | 优化后 |
|------|------|--------|
| "鸣潮最新角色" | 搜索失败 | 搜狗拿到 17173/九游资讯 |
| "鸣潮 3.3 版本" | 搜索失败 | 搜狗拿到版本更新信息 |
| 英文查询 | DuckDuckGo 可用 | DuckDuckGo + Bing 双引擎 |
| 广告干扰 | 无 | 搜狗有广告但被低质域名过滤 |
