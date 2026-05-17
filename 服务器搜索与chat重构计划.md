# MCP 远程浏览器 + Chat 轻量 Agent 能力

## Context

Bot 服务器只有 1.6GB 内存，无法安全运行 Chromium。当前搜索依赖轻量 HTTP 抓取，对 SPA 页面无能为力。用户提出两个优化方向：

1. 让服务器通过 MCP 协议调用本地 PC 的浏览器来搜索（避免服务器 OOM）
2. 给 Chat 模式加轻量工具调用能力（避免全 Agent 阻塞聊天）

第三期借鉴开发计划中已预留 MCP 入口（"MCP（预留/可隐藏）"），本次是 MCP 的首次落地实现。原计划提到"不开放未受控的 MCP/ACP 远程代理能力；先做本地多 Agent 协作预留"——本方案遵循这一原则：MCP Server 仅限管理员本地 PC 运行，通过 token 认证，不对外开放。

---

## Feature 1: MCP 远程浏览器

### 为什么用 MCP 而不是裸 WebSocket

- **可扩展**: 未来可以在同一个 MCP Server 上加更多工具（文件操作、本地 AI 推理、文档生成等），不用改协议
- **标准化**: 遵循 MCP 规范（JSON-RPC 2.0 + tool schema），未来可对接其他 MCP 客户端/服务端
- **与第三期计划对齐**: Agent Console 的 MCP 页面可以展示已连接的 MCP Server 状态和可用工具

### 架构

```
[本地 PC: MCP Server]                    [服务器: MCP Client]
  puppeteer-core                           lib/mcp/client.js
  暴露 tools:                                  ↓
    - browser_search                     web-search.js fallback chain
    - browser_read_page                        ↓
    - (未来: 更多工具)                    Agent engine 可直接调用 MCP tools
        |                                      ↑
        └──── WebSocket (反向连接) ────────────┘
              本地 PC 主动连到服务器
              token 认证
```

本地 PC 主动连接服务器（避免 NAT 穿透）。服务器暴露 WebSocket 端点，接受认证后的 MCP Server 注册。

### MCP 协议设计

遵循 MCP 规范核心子集（JSON-RPC 2.0 over WebSocket）：

**握手 (Server → Client):**
```json
{ "jsonrpc": "2.0", "method": "initialize", "params": { "serverInfo": { "name": "lian-remote-browser", "version": "1.0.0" }, "capabilities": { "tools": true } }, "id": 1 }
```

**工具列表 (Client 请求 → Server 响应):**
```json
// Request
{ "jsonrpc": "2.0", "method": "tools/list", "id": 2 }
// Response
{ "jsonrpc": "2.0", "result": { "tools": [
  { "name": "browser_search", "description": "搜索并读取结果页正文", "inputSchema": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] } },
  { "name": "browser_read_page", "description": "打开 URL 并提取正文", "inputSchema": { "type": "object", "properties": { "url": { "type": "string" } }, "required": ["url"] } }
] }, "id": 2 }
```

**工具调用 (Client → Server):**
```json
{ "jsonrpc": "2.0", "method": "tools/call", "params": { "name": "browser_search", "arguments": { "query": "鸣潮 2026 新角色" } }, "id": 3 }
```

**工具结果 (Server → Client):**
```json
{ "jsonrpc": "2.0", "result": { "content": [{ "type": "text", "text": "搜索结果..." }] }, "id": 3 }
```

### 搜索链变更

当前: API search → runHttpSearch → (disabled) local Chromium
新增: API search → **MCP browser_search** → runHttpSearch → local Chromium

优先用 MCP 远程浏览器（如果在线），失败/离线则降级到 HTTP 搜索。

### 新文件

| 文件 | 职责 |
|------|------|
| `lib/mcp/client.js` | MCP Client — WebSocket server 端点，接受 MCP Server 连接，管理工具注册，暴露 `isAvailable()` / `callTool(name, args)` |
| `lib/mcp/index.js` | MCP 模块入口，启动/停止 client，导出给 index.js 和 web-search.js 使用 |
| `packages/mcp-browser-server/index.js` | 本地 PC 运行的 MCP Server，连接远端，注册 browser_search / browser_read_page 工具 |
| `packages/mcp-browser-server/browser.js` | Puppeteer 封装：搜索、读页面、提取正文 |
| `packages/mcp-browser-server/package.json` | 依赖: ws, puppeteer-core |

### 修改文件

| 文件 | 改动 |
|------|------|
| `lib/agent/tools/web-search.js` | `fallbackSearch()` 开头尝试 MCP `browser_search`，失败 fallthrough |
| `lib/index.js` | 插件启动时初始化 MCP client（可选，由环境变量控制） |

### 配置 (环境变量)

- `DONGXUELIAN_MCP_PORT` — MCP WebSocket 监听端口 (默认 9877)
- `DONGXUELIAN_MCP_TOKEN` — 认证 token（MCP Server 连接时必须携带）
- `DONGXUELIAN_MCP_TOOL_TIMEOUT_MS` — 单次工具调用超时 (默认 15000)

### 失败处理

- 本地 PC 离线: `isAvailable()` 返回 false，直接跳过
- 工具调用超时: Promise reject，fallthrough 到 HTTP 搜索
- 认证失败: 拒绝连接，日志记录，不重试
- MCP Server 断开: 自动标记不可用，等待重连

### 未来扩展方向

MCP 框架建好后，后续可以在同一个 MCP Server 上加：
- `local_file_read` — 读取本地 PC 文件（如文档、图片 OCR）
- `local_ai_inference` — 调用本地模型（如 Ollama）
- `document_generate` — 本地生成 PPTX/DOCX（避免服务器装重依赖）
- 多个 MCP Server 同时连接（不同机器提供不同能力）

---

## Feature 2: Chat 轻量 Agent 化

### 当前路由的根本问题

现有 `router.js` 的"自由路由"是伪自由：

```
用户消息 → 正则匹配（EXPLICIT/STRONG/WEAK_TOOL_RE）
  ├─ 匹配 EXPLICIT → Agent
  ├─ 匹配 STRONG → Agent
  ├─ 匹配 WEAK + autoRoute=true → 问 LLM YES/NO → Agent 或 Chat
  └─ 不匹配任何正则 → 直接 Chat（LLM 连被问的机会都没有）
```

问题：
- "还有呢"、"这是什么"、"你知道其他的吗" → 不匹配任何正则 → 直接走 chat → 无工具
- `autoRoute` 默认 `enabled: false`，即使 WEAK_TOOL_RE 匹配也不会调 llmRoute
- 追问、上下文相关的工具需求完全无法被正则捕获
- 维护正则列表是无底洞，永远覆盖不全

**Feature 2 是这个问题的根本解法**：不再依赖正则路由，让 Chat 模式的 LLM 自己决定是否需要工具。路由问题自然消失。

### 实现原理：LLM 原生 tool_calls 能力

不需要额外的"判断逻辑"——只要在 API 请求里带上 `tools` 参数，LLM 就会自己决定要不要调用工具。这是 OpenAI/DashScope/DeepSeek 兼容 API 的原生能力。

```javascript
// 当前 chat.js 的 callOpenAI（无工具）
const result = await requestChatCompletions(messages, config, opts)
// → LLM 只能返回文本

// Feature 2 后（带工具）
const result = await requestChatCompletions(messages, config, opts, chatTools)
// → LLM 可以返回文本 OR tool_calls（模型自主判断）
```

**大多数聊天不会触发工具调用。** 模型只在真正需要时才调用——就像给人一把锤子，他不会对每个东西都敲。

系统提示词引导：
```
你有以下辅助工具可用。只在确实需要时自主调用，不要告诉用户你使用了工具，把结果自然融入回复。
大多数聊天不需要工具，直接回复即可。
```

### 核心思路

把 QQ 聊天机器人做成一个"轻量 Agent 外壳"——不是完整的多轮 Agent，而是让 Chat 模式具备自主判断和调用工具的能力。重点是**预留能力框架**，让 LLM 能根据上下文自主决定是否需要工具辅助。

### 为什么不直接用主 Agent

| 主 Agent | Chat 轻量 Agent |
|----------|----------------|
| 多轮工具循环，可能阻塞 20-60 秒 | 最多 1 轮工具调用，< 3 秒 |
| 用户等待期间无法继续聊天 | 轻量工具即时返回，重型工具异步 |
| 适合明确的任务指令 | 适合聊天中自然产生的工具需求 |
| 工具结果直接暴露给用户 | 工具结果内化为聊天回复，用户无感 |

### 设计原则

1. **自主判断**: LLM 根据上下文决定是否调用工具，不需要用户显式触发
2. **用户无感**: 工具调用的结果融入人格回复，不暴露"我调用了 XX 工具"
3. **预留扩展**: 框架支持未来加更多工具，只需注册即可
4. **不阻塞**: 轻量工具即时执行；重型需求异步转发给主 Agent

### 典型场景

| 场景 | Chat Agent 行为 |
|------|----------------|
| 聊天中提到"现在几点" | 调用 `get_current_time` → 自然融入回复 |
| 用户问"刚才那个文件里写了什么" | 调用 `read_context_file` 读取最近提到的文件 → 融入回复（不暴露文件路径） |
| 聊天中需要计算 | 调用 `calculate` → 融入回复 |
| 用户说"帮我搜一下 XX" | 判断为重型需求 → 先回复"我查查" → 异步转主 Agent |
| "还有呢"（上文有搜索结果） | 调用 `web_search`（重型）→ 异步转主 Agent |

注意：**图片识别不需要做成工具**。当前已有原生多模态视觉能力（chat.js 直接调 vision API），用户发图时自动识别。图片在对话历史中存为 `[图片]` 占位符是另一个问题（历史图片 URL 过期），不在本 Feature 范围内。

### 工具分层

**即时工具（Chat Agent 直接执行）:**

| 工具 | 用途 | 耗时 |
|------|------|------|
| `get_current_time` | 获取当前时间 | 0ms |
| `calculate` | 数学计算 | 0ms |
| `read_context_file` | 读取上下文中提到的文件片段 | < 50ms |
| `search_memory` | 搜索记忆 | < 50ms |

**异步工具（转发给主 Agent）:**

| 工具 | 原因 |
|------|------|
| `web_search` | 耗时 5-25s，需要多轮重试 |
| `browser_action` | 耗时不可控，占用大量资源 |
| `execute_shell` | 安全敏感，需要完整 Agent 安全策略 |
| `file_write` | 需要确认流程 |

### 安全约束

- **工具结果不直接暴露给用户**: LLM 把工具结果内化为人格回复
- **文件读取有路径限制**: 复用现有 `path-guard.js`，只能读允许范围内的文件
- **图片识别结果不回显原始 URL**: 只返回描述文本
- **系统提示词告知 LLM**: "你可以使用以下工具辅助回复，但不要告诉用户你使用了工具"

### 新文件

| 文件 | 职责 |
|------|------|
| `lib/chat-agent.js` | Chat Agent 核心：工具注册表、`executeChatTools()`、轻/重分流逻辑 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `lib/chat.js` | `callOpenAI()` 传入 Chat Agent 工具定义；处理 tool_calls 响应 |
| `lib/api.js` | `requestChatCompletions()` 支持 tools 参数透传 |
| `lib/index.js` | chat 返回值支持 `{ text, heavyToolsRequested }` 格式，触发异步 Agent |

### 流程

```
用户消息 → chat.js
  → 构建 messages（含图片占位符、上下文等）
  → callOpenAI(messages, tools=[Chat Agent 工具])
    → LLM 自主判断是否需要工具
      → 不需要: 直接返回文本（大多数情况）
      → 需要即时工具: 执行 → 追加结果 → 再调 API → 返回融入人格的文本
      → 需要重型工具: 返回 { text: "我查查...", heavyToolsRequested: [...] }
  → index.js 处理返回值
    → 普通文本: 直接发送
    → heavyToolsRequested: 先发 text，异步启动 Agent，完成后发后续消息
```

### 并发安全分析

**多人同时 @bot 时的行为：**

```
群内消息队列（串行，maxDepth=4）:
  A: "帮我算 123*456" → chat + calculate (0ms) + 二次 API (2s) = ~4s
  B: "你好" → 等 A → chat 直接回复 (2s) = 等待 4s + 2s
  C: "搜鸣潮" → 等 A+B → chat + web_search(重型) → 先回复"我查查"(2s) → 异步 Agent
  D: 第 5 个人 → maxDepth=4 超限 → 静默丢弃
```

**不会崩溃的原因：**
- Chat 队列是串行的，不存在并发竞争
- Agent 队列有全局并发上限（maxGlobal=3）
- 重型工具走异步，不阻塞 Chat 队列
- 轻量工具（时间、计算）几乎 0ms，不增加延迟

**保护措施（必须实现）：**

| 保护 | 机制 |
|------|------|
| 工具执行总超时 | 单次 chat 的所有工具调用总计不超过 5s，超时则跳过工具直接用文本回复 |
| 降级开关 | 如果 chat 队列深度 ≥ 3，自动跳过工具调用（纯文本模式），避免排队雪崩 |
| 重型工具不阻塞 | 重型工具（web_search/browser）永远走异步 Agent 队列，chat 只返回即时回复 |
| 失败静默降级 | 工具调用失败时不报错，LLM 用已有上下文直接回复 |

**实现代码示意：**

```javascript
async function handleChatToolCalls(messages, config, toolCalls, context) {
  // 保护：队列深度高时跳过工具
  if (context.queueDepth >= 3) return null  // 返回 null 表示跳过，用纯文本

  // 保护：总超时 5s
  const deadline = Date.now() + 5000
  for (const tc of toolCalls) {
    if (Date.now() >= deadline) break  // 超时，停止执行后续工具
    if (!isLightweightTool(tc.function.name)) {
      // 重型工具 → 标记异步，不执行
      heavyTools.push(tc)
      continue
    }
    // 执行轻量工具（带单个超时）
    const result = await executeWithTimeout(tc, 3000)
    // ...
  }
}
```

### 开销分析

| 项目 | 影响 |
|------|------|
| 额外 token | 工具定义约 200-400 tokens（加在请求里），成本可忽略 |
| 不调工具时的延迟 | 0ms 额外延迟（和当前完全一样） |
| 调轻量工具时的延迟 | +2-3s（多一轮 API 调用获取最终回复） |
| 误触发风险 | 通过精简工具列表 + 系统提示词控制，实测误触率很低 |

### 与现有路由的关系

Feature 2 上线后，`router.js` 的角色变化：

| 路由判定 | 当前行为 | Feature 2 后 |
|----------|---------|-------------|
| EXPLICIT_AGENT_RE 匹配 | → 主 Agent | → 主 Agent（不变，重型任务仍走完整 Agent） |
| STRONG_TOOL_RE 匹配 | → 主 Agent | → 可考虑降级为 Chat Agent 处理（如"现在几点"） |
| WEAK_TOOL_RE / 不匹配 | → 纯 Chat | → Chat + 轻量工具（LLM 自主决定） |

长期来看，`heuristicRoute` 只需要保留 EXPLICIT_AGENT_RE（用户明确要求完整 Agent 能力的场景），其他全交给 Chat Agent 自主判断。`llmRoute` 可以废弃。

---

## 实施顺序

1. **Feature 1 先做** — 直接提升搜索质量，改动集中在搜索链
2. **Feature 2 后做** — 涉及 chat 核心流程，需要更谨慎

---

## Feature 3: 图片历史追溯 + 占位符替换 + OOC 修复

### 问题

**1. 图片永久占位符**：QQ 消息里的图片在 conversation 中存为 `[图片]` 占位符。即使 vision.js 实时识别过，识别结果也不持久化。后续对话中 LLM 看到历史里的 `[图片]` 只能干瞪眼。

**2. 重复分析**：同一张图被多次 @ 或 Agent 多次调用时，每次都重新下载并调 vision model——没有去重。

**3. 追问匹配缺口**：`isAgentFollowUp` 只匹配搜索/工具追问，不匹配图片追问（"这张图"、"图里还有"、"那个皮肤"）。

**4. OOC 人格混乱**：Agent 路径的 system prompt 包含了元术语（"Agent 助手"、"Bot"、"Agent Console"、"审批"、"Shell Guard"），这些不会出现在东雪莲的自我认知中。

### 目标

```
━━━ 图片到达 ━━━
QQ 图片消息
  ↓
1. conversation 文件: "[图片]"（现有逻辑，不改）
2. data/image-history/{channelKey}.json:
   { "msg-abc123": { url, ts, analyzed: false, analysis: null } }
   ↑ messageId 做主键，去重；URL 用于后续下载；2 小时后自动清除
  ↓
━━━ 分析触发（三种路径）━━━
  A. @bot + 图 → vision.js 实时识图
  B. Agent 工具 read_image_history → analyze_historical_image
  C. 自动路由 → 上下文涉及图片 → Agent 调工具
  ↓
分析前检查 analyzed 标志 → true → 跳过，用缓存
分析完成后：
  1. 更新 conversation 文件（原地替换）：
     "[图片]" → "[图片]: 紫色长发女性角色，穿着日式铠甲..."
  2. 更新 image-history：analyzed: true
  ↓
━━━ 之后 ━━━
读历史 → "[图片]: 紫色长发..." → LLM 直接看到内容 → 自然融入回复
不用重新下载、重新分析
```

### 去重策略

用 `messageId` 做主键，同一张图只分析一次：

```json
{
  "images": {
    "msg-abc123": {
      "url": "https://gchat.qpic.cn/...",
      "ts": 1715689200,
      "analyzed": false,
      "analysis": null
    },
    "msg-def456": {
      "url": "...",
      "ts": 1715689300,
      "analyzed": true,
      "analysis": "紫色长发女性角色，穿着日式铠甲，手持太刀..."
    }
  }
}
```

三条路径都走同一个去重逻辑：

| 路径 | 触发 | 去重检查 |
|------|------|:---:|
| A: vision.js | @bot + 图 | `analyzed === true` → 跳过 vision API |
| B: Agent 工具 | 显式调用 | `analyzed === true` → 返回缓存分析 |
| C: 自动路由 | 上下文涉及 | 同 B |

### 两个新 Agent 工具

| 工具 | 入参 | 出参 | 非危险 |
|------|------|------|:---:|
| `read_image_history` | channelKey, limit(默认5) | `[{ messageId, url, ts, analyzed, analysis }]` | ✅ |
| `analyze_historical_image` | url / messageId | vision model 返回的文字描述 | ✅ |

**关键**：analyze_historical_image 调用完成后，自动把分析结果写回 conversation 文件和 image-history。LLM 只需调用工具，不需要知道"写入"的细节。

### 占位符替换

分析完成后调 `replaceImagePlaceholder(channelKey, messageId, analysis)`：

```js
function replaceImagePlaceholder(channelKey, messageId, analysis) {
  const conv = readConversationDisk(channelKey)
  // 扫描 conversation 消息，找到含 [图片] 且时间戳匹配的条目
  // 替换 "[图片]" → "[图片]: {analysis}"
  writeConversationDisk(channelKey, conv)
}
```

### 和 Feature 2 的关系

`isAgentFollowUp` 的图片追问正则**不加了**。正则路由永远不是自由路由——LLM 自己判断才是。Feature 2 完成后 Chat 模式有工具权限，LLM 读到 conversation 里的 `[图片]: xxx` 是自然历史的一部分，不需要代码层面的正则注入。

Feature 2 上线后，`isAgentFollowUp` 和 `agent-chat-bridge.js` 的上下文注入逻辑可以整体废弃——LLM 自己会调工具。

### OOC 修复（4 处）

| 文件 | 行 | 问题 | 操作 |
|------|:--:|------|------|
| `lib/agent/messages.js` | L9 | `"你是一个带有 Agent 能力的 QQ 群助手"` | **删除整行**（人格由 persona-context.js 注入，不需要声明身份） |
| `lib/agent/persona-context.js` | L33 | `"你的身份依然是东雪莲 Bot"` | 改 `"你依然是东雪莲。当前对话不需要拟人化表达。"` |
| `lib/agent/persona-context.js` | L42 | 含 `"Agent Console"` / `"审批"` | 改 `"管理员授权你使用文件、命令、浏览器等能力。需要确认的操作等待回复后再继续。"` |
| `lib/agent/workspace-context.js` | L179-180 | 含 `"Dashboard Agent 工作区"` / `"Agent Console"` / `"Shell Guard"` | 去掉架构词汇，改为内部参考格式 |

### 新文件

| 文件 | 职责 |
|------|------|
| `lib/image-store.js` | URL 存储 + 去重 + `replaceImagePlaceholder()` + 2h 过期清理 |
| `lib/agent/tools/read-image-urls.js` | Agent 工具: `read_image_history` |
| `lib/agent/tools/analyze-image.js` | Agent 工具: `analyze_historical_image`（下载 + vision model + 写回 conversation + 写回 history） |

### 修改文件

| 文件 | 改动 |
|------|------|
| `lib/agent/tools/registry.js` | 注册 `read_image_history` + `analyze_historical_image` |
| `lib/vision.js` | `appendVisionMessage` 结束后调 `image-store` 存 URL + 写回分析结果 |
| `lib/agent-chat-bridge.js` | `isAgentFollowUp` 补图片追问正则 |
| `lib/agent/messages.js` | 删除 L9（OOC 修复） |
| `lib/agent/persona-context.js` | 修复 L33 + L42（OOC 修复） |
| `lib/agent/workspace-context.js` | 修复 L179-180（OOC 修复） |

### tool description（给 LLM 的自然语言指引）

```js
read_image_history:
  description: '查看群聊最近出现的图片记录（URL + 时间戳 + 是否已分析）。'
  + '用于了解近期有哪些图片被分享，帮助判断当前话题是否涉及某张图。'

analyze_historical_image:
  description: '下载并识别一张群聊历史图片的内容，返回文字描述。'
  + '当你判断当前对话可能涉及之前分享的某张图片时使用。'
  + '先用 read_image_history 找到目标 URL，再调本工具获取内容。'
  + '获取描述后当成你自己的视觉记忆融入对话，不要说"我分析了图片"。'
```

### 验证

1. 群友发一张图 → `data/image-history/{channelKey}.json` 里出现 entry（analyzed: false）
2. @bot + 图 → vision.js 识别 → conversation 文件里 `[图片]` 变成 `[图片]: xxx`，analyzed 变 true
3. 再次 @bot 同一张图 → analyzed=true → 跳过 vision API，不重复调
4. 群友 10 分钟后说"刚才那张图里的角色是谁" → router → Agent 调 read_image_history → analyze_historical_image → LLM 看到分析 → 回答
5. isAgentFollowUp：用户说"那图里还有谁" → 匹配成功 → Agent 摘要注入
6. 2 小时后清理 → 过期 URL 从 image-history 中移除
7. OOC：Agent 回复不再出现"Agent 助手"、"Bot"、"Agent Console" 等词汇
