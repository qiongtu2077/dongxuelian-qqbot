# 莲莲Bot 总控执行计划：模块治理、上下文、人格、行动、MCP、部署与安全

日期：2026-05-25
状态：待审核，未实施，未部署

## 任务目标

把莲莲 Bot 的多条升级工作流整理成一个可挂机、可重载、可回退的总控执行计划。

其中 A 轨仍然是 `packages/koishi-plugin-dongxuelian-ai` 的模块治理 + TypeScript 类型护栏；但它只是整个计划中的一个工作流，不是全部。

这份总控要做到两件事：

1. 让 AI 能按工作流、按目录簇、按步骤、按固定验证流程自动推进，不靠临场发挥。
2. 让当前仓库的运行态、发布态和权限边界保持稳定，不因为某一条工作流把整个仓库带偏。

真正的运行时 `.ts` 迁移仍然不在这份总控里。A 轨先做类型护栏和 JS 治理，等边界稳定后再单独考虑运行时迁移。

## 任务全景图

这份文件现在是总控 runbook。下面的工作流可以并行，但每个工作流都必须有自己的 `goal`、自己的状态、自己的验证命令，不能混着跑。

| 轨道 | 工作流 | 主要目标 | 关键依赖 | 参考文档 | 状态 |
|------|------|------|------|------|------|
| A | 模块治理 + TypeScript | 先收敛 JS 结构，再给稳定边界加类型护栏 | `core`、`chat`、`agent`、`test` | [2026-05-25-模块治理与TypeScript渐进迁移待审核方案.md](./2026-05-25-模块治理与TypeScript渐进迁移待审核方案.md) | 待审核 |
| B | 群聊上下文窗口 | 当前消息、活跃现场、引用链、媒体锚点、旧背景分层 | `conversation.js`、`chat.js`、`group-scene-index.js`、`image-store.js` | [群聊上下文窗口架构计划](./群聊上下文窗口架构计划.md) | 待审核 |
| C | 人格架构升级 | persona schema、runtime plan、profile、lore/router、表达控制 | `persona.js`、`chat.js`、`conversation.js`、Dashboard | [《人格架构升级计划》](./《人格架构升级计划》.md) | 待审核 |
| D | Agent 行动路由 + 文件产物 + Cron | 自然语言动作路由、文件派生产物、一次性和周期任务 | `agent/router.js`、`agent/cron.js`、`file-analyzer.js` | [Agent行动路由文件发送与Cron提醒待审核方案](./2026-05-24-Agent行动路由文件发送与Cron提醒待审核方案.md)、[Agent定时任务体系优化待审核计划](./2026-05-24-Agent定时任务体系优化待审核计划.md) | 待审核 |
| E | MCP 工作台 | 本地 MCP server、诊断、读写边界、工具 broker | `agent/config.js`、`path-guard`、Dashboard Agent 窗口 | [2026-05-24-mcp计划.md](./2026-05-24-mcp计划.md) | 待审核 |
| F | Dashboard 安全与认证 | 密码哈希、迁移、重置路由修补 | `packages/koishi-plugin-dashboard/lib/auth.js` | [Dashboard密码bcrypt哈希升级计划](./2026-05-24-Dashboard密码bcrypt哈希升级计划.md) | 部分待修 |
| G | 部署主线与垃圾清理 | 收敛部署入口、去掉旧脚本、统一发布主线 | `scripts/*`、Dashboard deploy、`setup.sh` | [部署脚本与垃圾文件清理待审核方案](./部署脚本与垃圾文件清理待审核方案.md) | 待审核 |
| H | 表情包 / affect / 表达学习 | 表情学习影子链路、情绪路由、表达候选池 | `sticker-shadow.js`、`affect-router`、`expression/*` | [《表情包学习与发送方案》](./《表情包学习与发送方案》.md)、[affect-router情绪输出路由详细设计](./affect-router情绪输出路由详细设计.md)、[表达学习候选池详细设计](./表达学习候选池详细设计.md) | 部分落地 |
| I | 架构收敛 | 工具元数据、executor、timeout、search、file、index 拆分 | `chat-tools.js`、`agent/engine.js`、`tools/*` | [架构收敛方案](./架构收敛方案.md)、[架构债优化计划](./架构债优化计划.md) | 待审核 |

## 调研结论

1. 现在不是“一个大计划”，而是九条并行但互相依赖的工作流。
2. A 轨是结构治理和类型层，属于基础设施，不是全部改进目标。
3. B 轨和 C 轨是聊天体验的核心，必须优先保证上下文、人格和记忆不串。
4. D 轨是 Agent 的行动能力，决定 bot 能不能从“会说”变成“会做”。
5. E 轨是本地工具与外部工具的桥，不是聊天主链路替代品。
6. F 轨和 G 轨属于上线安全与发布安全，优先级不能低于功能开发。
7. H 轨已经有局部落地，后续只能继续收敛，不能倒退到硬编码或 prompt 直塞。
8. I 轨是长期债务处理层，核心是共享基础设施统一，不是单点炫技。

## 总体优先级

默认顺序不是按文档长度，而是按风险和共性：

1. F / G / E：安全、认证、部署主线、MCP、工具边界。
2. B / C / D：群聊上下文、人格、行动路由、定时任务。
3. A / I：模块治理、TypeScript、架构收敛。
4. H：表情包、情绪路由、表达学习的体验增强。

## 统一执行模板

后面每条工作流都必须按同一个模板写，不要再各写各的。

### 1. 工作流定义

每条工作流都要明确：

- `goal`：这条工作流的唯一目标。
- `scope`：改哪些目录 / 哪些文件 / 哪些页面。
- `non_goal`：明确不做什么。
- `owner`：默认责任模块。
- `depends_on`：依赖哪些别的工作流。
- `risk`：最大风险是什么。
- `stop_rule`：什么时候必须停。
- `verify`：必须跑哪些命令。

### 2. 工作流推进顺序

每个工作流内部都必须按这个顺序推进：

1. 读目标文档。
2. 读当前状态文件。
3. 检查依赖是否完成。
4. 只处理当前批次。
5. 写入中间状态。
6. 验证。
7. 记录结果。
8. 选择下一批或者停机。

### 3. 工作流的默认状态枚举

统一状态只允许这几种：

- `pending`
- `active`
- `blocked`
- `verified`
- `paused`
- `done`
- `failed`

### 4. 必须写入的状态字段

每条工作流都必须至少写这些字段到执行状态里：

- `workflowId`
- `workflowName`
- `workflowVersion`
- `workflowHash`
- `currentPhase`
- `currentBatch`
- `lastStep`
- `lastResult`
- `lastError`
- `lastVerifiedAt`
- `nextBatch`
- `blockedBy`

### 5. 状态文件规则

- 状态文件和计划文件分离。
- 状态文件只记执行结果，不记大段解释。
- 状态文件必须可恢复。
- 状态文件更新必须原子化。
- 任何一轮失败后，都必须把失败写进去，不允许只在脑子里记。

### 6. 统一验证规则

所有工作流默认都要遵守下面三层验证：

1. 语法或静态检查。
2. 快速测试。
3. 涉及真实链路时补场景测试。

如果某条工作流还有自己的专属验证，比如 Dashboard 浏览器点验、MCP 工具调用、文件读写边界测试，那要额外加，不可省。

## /goal 指令协议

这一节回答的是：怎么让模型每次都“强制重新看计划”，而不是靠上下文记忆。

### 1. 命令语义

`/goal` 不是一句普通提示词，而是当前执行器的显式目标控制接口。

建议至少支持这些子命令：

- `/goal set <workflowId>`：选择一条工作流作为当前执行目标。
- `/goal lock`：锁定当前目标，后续每轮必须先读计划和状态文件。
- `/goal status`：查看当前目标、hash、phase、batch、最后验证时间。
- `/goal next`：推进到下一批，但前提是当前批已通过验证。
- `/goal pause`：暂停当前目标，不再自动推进。
- `/goal clear`：清除当前目标，停止注入。
- `/goal reload`：强制重新读取计划文件并刷新 hash。

### 2. 执行器规则

每次准备调用模型前，执行器必须按这个顺序做：

1. 读取总控计划文件。
2. 计算 `workflowHash`。
3. 读取状态文件。
4. 校验 `workflowId` 是否存在。
5. 校验 hash 是否和状态一致。
6. 读取当前工作流对应的章节。
7. 组装 core 护栏、工作流章节、当前批次、状态摘要。
8. 发送给模型。

如果其中任一步失败，就不能继续调用模型，必须停机并写状态。

### 3. 强制注入层级

每轮注入顺序固定为：

1. 不可变护栏。
2. 总控状态摘要。
3. 当前工作流章节。
4. 当前 phase。
5. 当前 batch。
6. 当前文件族。
7. 当前目标命令。

不要把旧对话历史放在这六层前面。

### 4. 状态文件建议结构

一个总控状态文件就够，内部按 workflow 分块即可。建议字段：

- `runbookVersion`
- `runbookHash`
- `activeWorkflowId`
- `activeWorkflowName`
- `workflows.<id>.status`
- `workflows.<id>.currentPhase`
- `workflows.<id>.currentBatch`
- `workflows.<id>.completedBatches`
- `workflows.<id>.lastStep`
- `workflows.<id>.lastResult`
- `workflows.<id>.lastError`
- `workflows.<id>.lastVerifiedAt`
- `workflows.<id>.nextBatch`
- `workflows.<id>.blockedBy`

### 5. fail closed

如果出现以下情况，必须直接停，不许靠猜继续：

- 目标工作流没设。
- 目标工作流 hash 不一致。
- 目标章节读不到。
- 当前 batch 和状态文件不一致。
- 上一轮验证失败。

### 6. 适合挂机的最小护栏句

每轮都应附带这句极短护栏：

> 先读计划文件和状态文件，再执行当前工作流；缺一项就停。

### 7. /goal 与上下文压缩

上下文压缩不会影响这套机制，因为每轮都重新从磁盘读取 runbook 和 state。
真正不能丢的是：

- 当前 workflowId
- 当前 batch
- 当前 hash
- 当前验证结果

只要这四样都落盘，模型忘掉上一轮也不影响执行。

## 工作流 A：模块治理 + TypeScript

### A1. 目标

把 AI 插件的 JS 结构收敛成更稳定的目录边界，再给核心契约加 TypeScript 类型护栏，但不改运行时。

### A2. 关键输入

- `packages/koishi-plugin-dongxuelian-ai/lib/index.js`
- `packages/koishi-plugin-dongxuelian-ai/lib/chat.js`
- `packages/koishi-plugin-dongxuelian-ai/lib/handler.js`
- `packages/koishi-plugin-dongxuelian-ai/lib/agent/*`
- `packages/koishi-plugin-dongxuelian-ai/lib/file/*`
- `packages/koishi-plugin-dongxuelian-ai/lib/image/*`
- `packages/koishi-plugin-dongxuelian-ai/lib/persona/*`

### A3. 关键输出

- 更清晰的 JS 目录结构。
- `tsconfig.json`
- `typecheck` 脚本
- `types/` 或 `contracts/` 目录
- 稳定契约的类型定义
- 保留 shim 的目录迁移

### A4. 依赖

- 依赖 B 轨的上下文分层，避免类型护栏加在错误语义上。
- 依赖 C 轨的人格契约，否则类型化的只是错结构。
- 依赖 I 轨的架构收敛，避免重复搬同一层逻辑。

### A5. 风险

- 高频入口被一次性改爆。
- 类型层过早覆盖不稳定契约。
- shim 太多导致维护噪音。

### A6. 停机条件

- 运行时行为变化。
- 需要 loader 才能继续。
- 目录簇之间耦合超出当前批次可控范围。

### A7. 验证

- `npm run check`
- `npm run test:quick`
- `npm run test:scenario`
- `npm run typecheck`

### A8. 当前建议

继续把这条工作流作为“底座整理”，但不要再让它冒充整个仓库的总目标。

### A9. 详细实施分段

#### A9-0 预扫描

先做一次只读盘点，不改任何文件：

1. 统计 `lib/` 当前目录结构。
2. 列出 `index.js`、`chat.js`、`handler.js`、`agent/engine.js` 的直接消费者。
3. 记录每个候选文件的依赖量。
4. 标出能单独搬运的小文件族。
5. 跑 `npm run check`、`npm run test:quick`，确认基线不是坏的。

#### A9-1 底座小批次

先做最独立的底座文件：

1. `onebot-endpoint.js`
2. `frontmatter.js`
3. `redactor.js`

动作模板：

- 新建目标目录。
- 复制原文件到新路径。
- 保留旧路径 shim。
- 修正新文件内部相对引用。
- 只更新直接消费者。
- `node -c`。
- `npm run test:quick`。

#### A9-2 诊断与配置批次

继续做只读、少副作用文件：

1. `logging-config.js`
2. `runtime-config.js`
3. `api.js`

要求：

- 不改调用顺序。
- 不改默认配置语义。
- 不改任何环境变量名字。

#### A9-3 底层工具批次

搬运最常被引用但逻辑稳定的工具：

1. `utils.js`
2. `constants.js`

要求：

- 先迁消费者，再迁底座。
- 确认所有 shim 都还在。
- 如果 consumers 太多，拆成更小批次。

#### A9-4 结构层批次

先处理这些簇：

1. `reply/`
2. `routing/`
3. `behavior/`
4. `persona/`

每个簇都先做小文件，再做组合文件。

#### A9-5 媒体层批次

依次处理：

1. `file/`
2. `image/`
3. `voice/`

原则：

- 先把安全判断和存储拆开。
- 再碰分析和发送。
- 不许把分析层的最终自然回复倒灌回索引缓存。

#### A9-6 Agent 纯子域批次

先做桥接、守卫、上下文，再做队列、配置、路由，最后再碰 tools / skills / plan。

#### A9-7 类型层批次

在 JS 结构稳定以后再做：

1. `types/common.d.ts`
2. `types/tool.d.ts`
3. `types/chat.d.ts`
4. `types/persona.d.ts`
5. `types/scene.d.ts`
6. `types/media.d.ts`
7. `types/agent.d.ts`

#### A9-8 清理批次

只在以下条件全满足时删 shim：

1. 所有直接消费者都改了。
2. `npm run test:quick` 过。
3. 相关场景测试过。
4. 没有新的 import 回流到旧路径。


## 工作流 B：群聊上下文窗口

### B1. 目标

让 bot 在群聊里优先看当前热窗口、引用链、媒体锚点，再把旧背景当背景，避免随机回复割裂、错接短句、乱翻旧账。

### B2. 关键输入

- `conversation.js`
- `chat.js`
- `group-scene-index.js`
- `image-store.js`
- `file-store.js`
- `forward.js`

### B3. 关键输出

- `ContextWindow` 分层。
- scene card / active scene 安全索引。
- `read_group_context` 的自由检索边界。
- 媒体/文件/引用锚点统一注入。

### B4. 风险

- 旧背景和当前现场权重倒挂。
- 随机回复把不该提的旧事提出来。
- 富媒体锚点丢失。

### B5. 停机条件

- 模型开始把旧背景当当前现场。
- 媒体、文件、引用链指代失败率升高。
- 随机回复需要用硬编码关键词硬拉。

### B6. 验证

- 短句追问场景测试
- 图片/文件/转发追问测试
- 随机回复现场一致性测试

### B7. 详细实施分段

#### B7-0 预扫描

只读检查以下对象是否已经存在或哪里还缺：

1. `channelSharedCache`
2. `getSharedContextNote()`
3. `group-scene-index.js`
4. `read_group_context`
5. 媒体锚点的索引结构

输出：

- 当前 active scene 来源。
- 旧背景来源。
- 富媒体锚点来源。
- 哪些对象被当作“旧背景”。

#### B7-1 L0 / L1 基线修正

先确保当前消息和当前活跃现场是主输入：

1. 当前消息必须保留原始短句。
2. 当前活跃现场必须能承接最近 1 到 3 分钟的公共消息。
3. 不能让旧背景压过当前现场。

#### B7-2 引用链与回复链

补引用回复和 reply 链：

1. 被引用消息要短暂提升权重。
2. 回复链只带必要上下文。
3. 不得把同时间段全部旧话题一起捞进来。

#### B7-3 富媒体锚点

把图片、文件、语音、转发都变成可检索的 scene anchor：

1. 记录 messageId。
2. 记录发送者。
3. 记录时间。
4. 记录锚点类型。
5. 保留安全索引，不保留敏感原文。

#### B7-4 旧背景层

把历史摘要和长期记忆明确标成“旧背景”：

1. 只能辅助理解身份和偏好。
2. 不能主动提起。
3. 不能压过当前现场。

#### B7-5 随机回复路由

随机回复时只允许在当前现场内自由选择：

1. 锚定回复。
2. 查旧上下文。
3. 非锚定水群。
4. 不发送。

不能让随机回复靠长文历史硬蹭话题。

#### B7-6 真实测试

至少要有这些场景：

1. 短句接当前现场。
2. 有引用时接引用。
3. 图片追问接最近图。
4. 文件追问接最近文件。
5. 旧话题不被主动翻出。

## 工作流 C：人格架构升级

### C1. 目标

把人格从“单一 prompt”升级为可编译、可调权、可回滚、可诊断的运行时结构。

### C2. 关键输入

- `persona.js`
- `persona-schema.js`
- `persona-profile.js`
- `persona-runtime-plan.js`
- `persona-lore-router.js`
- `chat.js`
- `conversation.js`
- Dashboard persona 页面

### C3. 关键输出

- PersonaRuntimePlan
- 证据化 profile
- prompt budget
- lore / modes / voice_style 统一边界
- 角色卡与长期表达资源的编译层

### C4. 风险

- 人格串台。
- 记忆有但用不上。
- Dashboard 保存和运行时解析语义不一致。

### C5. 停机条件

- 人格升级导致普通回复变硬。
- 人格注入覆盖安全边界。
- Agent 和 QQ 人格不一致。

### C6. 验证

- persona schema 测试
- prompt 构建测试
- persona 回归测试
- Dashboard 编辑回归测试

### C7. 详细实施分段

#### C7-0 现状盘点

先看现在的 persona 相关输入都分散在哪：

1. `persona.js`
2. `chat.js`
3. `conversation.js`
4. `agent/persona-context.js`
5. `tts.js`
6. Dashboard persona 编辑页

记录每个文件读的是哪类 persona 字段：

- 身份
- 语言风格
- lore
- voice style
- nsfw / safety
- profile

#### C7-1 schema 统一

先把人格字段统一成一份稳定 schema：

1. 定义必填字段。
2. 定义可选字段。
3. 定义前后兼容字段。
4. 定义未知字段保留规则。

#### C7-2 runtime plan

再让人格从 prompt 变成 runtime plan：

1. 角色身份。
2. 风格偏好。
3. lore 注入预算。
4. 回复节奏。
5. 语音风格。
6. 安全边界。

#### C7-3 profile 与记忆

把 profile / memory / long background 分开：

1. 证据化 profile 只能写可观察事实。
2. 旧记忆只能做背景。
3. 新关系不能由旧摘要自动升级。

#### C7-4 dashboard 编辑一致性

Dashboard 端保存人格时必须：

1. 用同一套 schema。
2. 保留未知字段。
3. 不改坏 frontmatter。
4. 不绕过安全边界。

#### C7-5 Agent 同步

Agent 侧和 QQ 聊天侧必须共享人格语义：

1. 相同身份。
2. 相同风格。
3. 相同安全边界。
4. 相同 lore 预算。

#### C7-6 验收测试

至少覆盖：

1. persona 文件解析。
2. profile 写入与读取。
3. Dashboard 编辑不丢字段。
4. Agent 与 QQ 风格一致。
5. prompt 不泄露内部结构。

## 工作流 D：Agent 行动路由 + 文件产物 + Cron

### D1. 目标

让 bot 能自然理解“看一下这个文件”“重命名后发我”“十分钟后提醒我”这类行动语义，而不是只靠字面命令。

### D2. 关键输入

- `agent/router.js`
- `agent/engine.js`
- `agent/cron.js`
- `file-analyzer.js`
- `file-store.js`
- `agent/tools/*`

### D3. 关键输出

- 通用行动路由层
- 安全文件产物
- 一次性提醒 / 周期任务统一模型
- 任务状态可查、可暂停、可恢复、可运行

### D4. 风险

- 错把旧文件当当前文件。
- 产物写错路径。
- cron 多用户互相覆盖。

### D5. 停机条件

- 行动路由绕过权限门。
- 文件产物写入非允许目录。
- 定时任务没有可恢复状态。

### D6. 验证

- 文件自由路由场景
- 文件派生产物场景
- 一次性提醒场景
- 周期任务场景

### D7. 详细实施分段

#### D7-0 盘点现有行动能力

先列出现在已经有的能力：

1. 文件分析。
2. 文件存储。
3. 工具调用。
4. cron 定时器。
5. 现有 reminder/list/cancel。

#### D7-1 通用行动路由

给模型一个统一的 action router：

1. 识别用户是不是在要做事。
2. 识别对象是文件、时间、产物还是普通聊天。
3. 判断是否需要确认。
4. 输出工具名和参数。

#### D7-2 文件锚点与安全产物

文件消息后建立安全锚点：

1. messageId。
2. fileId。
3. 发送者。
4. 频道。
5. 时间。

再允许有限派生：

1. 重命名。
2. 轻量改写。
3. 安全副本。

#### D7-3 任务路由到 cron

把自然语言时间动作接到现有 cron：

1. 一次性提醒。
2. 周期文本任务。
3. 周期 agent 任务。
4. 文件延迟分析任务。

#### D7-4 权限边界

明确哪些能自动做，哪些必须确认：

1. 安全读操作可自动。
2. 有副作用的写操作要看上下文和权限。
3. 跨用户、跨群、跨路径一定要停。

#### D7-5 定时任务状态模型

统一任务状态：

1. pending
2. running
3. done
4. failed
5. cancelled
6. paused

#### D7-6 验收

至少要验证：

1. 十分钟后提醒。
2. 每天早上说早安。
3. 晚上总结群聊。
4. 明天分析刚才文件。
5. 列表、暂停、恢复、删除。

## 工作流 E：MCP 工作台

### E1. 目标

把 MCP 变成本地 Agent 工作台和外部工具生态层，而不是替代聊天主链路。

### E2. 关键输入

- `agent/config.js`
- `mcp/local-server.js`
- `tools/registry.js`
- `path-guard`
- Dashboard Agent 窗口

### E3. 关键输出

- 本地 stdio MCP server
- 工具分级
- 只读 / 可写 / 本地命令 / 危险操作边界
- Dashboard MCP 开关

### E4. 风险

- 工具权限默认过宽。
- 本地检查泄露文件片段。
- 误把 MCP 当聊天主链路。

### E5. 停机条件

- 任何危险工具被默认暴露。
- 工作台开关失效。
- 读写边界不清。

### E6. 验证

- MCP 工具列表
- 只读诊断调用
- 写入/检查边界测试
- Dashboard 开关测试

### E7. 详细实施分段

#### E7-0 先定义边界

先把 MCP 明确成工作台，不是聊天主链路：

1. 只读优先。
2. 写入必须白名单。
3. 危险操作默认不暴露。
4. 默认不能触发部署、重启、push。

#### E7-1 工具分级

把工具分成四级：

1. read
2. write_workspace
3. run_local
4. dangerous

#### E7-2 本地 server

先做 stdio server 的最小可用：

1. get_bot_health
2. get_agent_config
3. get_agent_stats
4. list_files
5. find_files
6. grep_search
7. read_file
8. write_file
9. edit_file
10. run_local_check

#### E7-3 Dashboard 开关

在 Dashboard Agent 窗口做：

1. 启用/关闭 MCP。
2. 配置写权限。
3. 配置本地命令权限。
4. 显示当前状态。

#### E7-4 审计与脱敏

所有输出都要：

1. 脱敏。
2. 记日志。
3. 可追溯。
4. 不泄露真实路径和敏感值。

#### E7-5 客户端接入

后续再接 Codex、Claude、Cursor 等客户端时，必须：

1. 显式启用。
2. 显式选择权限级别。
3. 不默认连危险工具。

#### E7-6 验证

必须验证：

1. 关闭时拒绝工具调用。
2. 打开时能列工具。
3. 写文件受限。
4. 本地命令受限。
5. 日志脱敏。

## 工作流 F：Dashboard 安全与认证

### F1. 目标

把 Dashboard 密码、管理员验证和重置流程收敛成安全存储和安全迁移。

### F2. 关键输入

- `packages/koishi-plugin-dashboard/lib/auth.js`
- `packages/koishi-plugin-dashboard/lib/routes/auth.js`
- `packages/koishi-plugin-dashboard/package.json`

### F3. 关键输出

- bcrypt 哈希存储
- 无痛迁移
- reset token 正常工作

### F4. 风险

- 漏导入、漏迁移、旧明文残留。

### F5. 停机条件

- 正确密码不能登录。
- reset token 不能重置。
- 旧密码文件被错误删掉。

### F6. 验证

- 旧明文自动升级
- 哈希登录回归
- 重置流程回归

### F7. 详细实施分段

#### F7-0 盘点现状

确认现在有哪些凭据文件：

1. access password
2. admin password
3. legacy 兼容文件
4. reset token

#### F7-1 哈希迁移

先做密码哈希：

1. 安装 bcryptjs。
2. 改验证函数。
3. 保留旧明文兼容迁移。
4. 改密码时写 hash。

#### F7-2 reset 修补

重置路由要继续能工作：

1. token 正确可重置。
2. token 错误不误删。
3. 迁移后旧明文可清理。

#### F7-3 回归测试

至少覆盖：

1. 旧明文登录迁移。
2. hash 登录。
3. 改密。
4. 删除文件重启恢复。
5. reset 正例和反例。

## 工作流 G：部署主线与垃圾清理

### G1. 目标

收敛部署主线，减少旧入口和垃圾文件，避免只同步半套内容。

### G2. 关键输入

- Dashboard 远程部署接口
- `scripts/restart-bot.sh`
- `setup.sh`
- `local-deployer/`
- `scripts/deploy-package.sh`

### G3. 关键输出

- 统一部署主线
- 旧入口废弃或包装
- ignored 垃圾清理
- tracked 残留清理计划

### G4. 风险

- 只更新一部分文件。
- 误删生产数据。
- 部署脚本和 README 不一致。

### G5. 停机条件

- 需要用户再次确认但没确认就继续。
- 服务器状态不清楚。
- 部署脚本触到危险边界。

### G6. 验证

- 本地构建
- 远程包校验
- 重启后健康检查

### G7. 详细实施分段

#### G7-0 盘点入口

先列出现有部署入口：

1. Dashboard 远程部署接口。
2. `scripts/restart-bot.sh`
3. `setup.sh`
4. `local-deployer/`
5. 单插件脚本
6. 旧脚本 wrapper

#### G7-1 收敛主线

把日常更新固定到一条主线：

1. 构建。
2. 打包。
3. 上传。
4. 解包。
5. 校验。
6. 重启。
7. 健康检查。

#### G7-2 清理旧入口

标记废弃旧脚本，但先不直接删：

1. 先替换文档引用。
2. 再改 wrapper。
3. 最后才考虑删除 tracked 残留。

#### G7-3 忽略文件清理

清理前先分层：

1. 本地 ignored 大垃圾。
2. tracked 临时文件。
3. 文档和测试残留。

#### G7-4 部署安全

任何部署动作都要满足：

1. 用户明确同意。
2. 服务器无未保存修改。
3. 健康检查可回看。

#### G7-5 验证

至少验证：

1. 主线部署完整性。
2. 远端重启后健康。
3. 旧入口不再被新文档引用。

## 工作流 H：表情包 / affect / 表达学习

### H1. 目标

让表情、情绪、表达学习成为可审核、可旁路观测、可逐步接管的体系。

### H2. 关键输入

- `sticker-shadow.js`
- `affect-router`
- `expression-pool-store.js`
- `expression-abstractor.js`
- `expression-shadow-router.js`

### H3. 关键输出

- shadow 记录
- 审核池
- 发送侧检索
- 情绪输出路由

### H4. 风险

- OOC 文案外泄。
- 人格表达过度硬编码。
- 学习池直接进入生产 prompt。

### H5. 停机条件

- 影子记录开始影响生产链路。
- 候选池未经审核被直接读取。

### H6. 验证

- shadow 日志
- 审核页
- 发送侧回归

### H7. 详细实施分段

#### H7-0 shadow 先行

先保留旁路记录，不直接接管生产：

1. 学习侧记录。
2. 发送侧记录。
3. 不写入生产 prompt。

#### H7-1 候选池

把学习结果分成：

1. pending
2. approved
3. banned

#### H7-2 审核页

Dashboard 做可视化审核：

1. 看图。
2. 批量操作。
3. 纠错。
4. 查看来源和复读情况。

#### H7-3 affect/router

情绪输出路由只做旁路，不强行接管主聊天：

1. 文本。
2. 语音。
3. 表情。

#### H7-4 表达学习边界

只允许从群聊里吸收：

1. 风格。
2. 口癖。
3. 安全的表达资源。

不允许：

1. 直接改人格。
2. 直接进 prompt。
3. 直接生成 OOC 硬句。

## 工作流 I：架构收敛

### I1. 目标

把工具元数据、输出净化、执行器、超时、搜索和文件分析统一成共享基础设施。

### I2. 关键输入

- `chat-tools.js`
- `agent/engine.js`
- `agent/tools/*`
- `tools/registry.js`
- `path-guard.js`
- `queue.js`

### I3. 关键输出

- registry 元数据统一
- executor 统一
- timeout 统一
- search / file analyze 收敛
- index.js 负载下降

### I4. 风险

- 轻重工具路由被破坏。
- executor 反向干预调度。
- 统一后把原来的细边界抹平。

### I5. 停机条件

- route 逻辑被 HOW 层覆盖。
- 权限、超时、返回格式互相打架。

### I6. 验证

- registry 断言
- executor 单测
- 搜索一致性测试
- 文件分析一致性测试

### I7. 详细实施分段

#### I7-0 先统一元数据

工具元数据先统一：

1. safety
2. weight
3. timeout

#### I7-1 输出净化

把 sanitization 收拢到共享模块：

1. QQ 输出净化。
2. 工具输出截断。
3. 特殊字符处理。

#### I7-2 executor

统一工具执行器，但只统一 HOW，不改 WHEN：

1. 参数校验。
2. path-guard。
3. timeout。
4. 错误格式化。

#### I7-3 timeout

统一超时 / 取消 / 清理逻辑：

1. withTimeout。
2. cancellable。
3. 资源释放。

#### I7-4 search / file analyze

统一搜索和文件分析能力，避免多处重复实现。

#### I7-5 index 拆分

最后才拆 `index.js`：

1. router。
2. context-builder。
3. orchestrator。

#### I7-6 验证

每一步都要保证：

1. 轻工具仍内联。
2. 重工具仍走 agent。
3. 搜索结果一致。
4. 文件分析一致。
5. `index.js` 只剩入口胶水。

## 总结

这份文档现在的作用不再只是“某一个技术迁移方案”，而是整套莲莲 Bot 待审核工作的总控 runbook。

它的任务不是替代各个专题文档，而是：

1. 统一它们的执行格式。
2. 统一它们的状态字段。
3. 统一它们的注入方式。
4. 统一它们的停机条件。
5. 让模型每次都知道自己在执行哪条工作流。

## 硬边界

- 不改 `main: lib/index.js`。
- 不引入运行时编译/加载器。
- 不把 `lib/` 整体迁到 `.ts`。
- 不把 Dashboard、MCP、前端 Agent 窗口塞进本次范围。
- 不碰用户本地其他未提交改动，只处理本方案明确列出的文件和目录。
- 不做全盘机械重命名。
- 不用 `git reset --hard`、不回滚无关改动。

## AI 执行协议

### 0. 启动前固定检查

AI 每次开始前都要确认：

1. 当前仓库根目录正确。
2. 当前分支正确。
3. 工作树里有没有和本方案无关的脏改动。
4. 这次只处理当前方案范围，不扩战线。

### 1. 单位粒度

每次只处理一个目录簇，或者一个目录簇里的一个文件族。
不要同时改多个责任域。

### 2. 迁移顺序

先迁纯工具和纯结构，再迁高耦合入口。
先留 shim，再切消费者，最后才考虑删旧定义。

### 3. 每个文件族都必须走同一套五步

1. 先创建目标文件。
2. 完整复制原逻辑，先不改行为。
3. 在原位置加 shim。
4. 更新新文件内部 `require`。
5. 更新消费者并验证。

### 4. 验证顺序

每改完一个文件族，按这个顺序验：

1. `node -c` 检查语法。
2. `npm run test:quick`
3. 若触达消息主链路、Agent、命令层，再跑 `npm run test:scenario`
4. 若触达类型层，再跑 `npm run typecheck`

### 5. 停机条件

出现以下任一情况就停：

1. 语法不过。
2. 快速测试不过。
3. 场景测试不过。
4. 类型检查不过。
5. 发现需要改运行时 loader 才能继续。
6. 发现某个文件族暂时不能安全拆分。

停下后只输出：

- 改了哪些文件
- 哪个步骤失败
- 失败时的最小输入
- 现在卡在哪一层
- 下一步建议

不要硬往下推。

### 6. 回滚原则

如果一个文件族失败，只回退这个文件族，不碰别的目录簇。
不要因为一个点失败就清整个仓库。

### 7. 每轮执行输出格式

AI 每处理完一个动作包，都要输出同样的字段，方便继续挂机：

- `phase`：当前阶段名。
- `batch`：当前目录簇或文件族名。
- `files`：这次实际动到的文件。
- `shims`：保留了哪些旧路径 shim。
- `consumers`：更新了哪些直接消费者。
- `commands`：跑了哪些验证命令。
- `result`：通过、失败、部分通过。
- `blocker`：如果失败，卡在哪一步。
- `next`：下一步默认进入哪个目录簇。

输出时只写事实，不写长篇解释。

## 文档强制注入与抗压缩协议

这部分是为了回答一个更底层的问题：**不要指望模型“自己记住”这份计划，必须让程序每次重新注入。**

真正靠谱的做法不是把长文塞进对话历史里，而是把它变成程序每轮都会重载的外部执行规范。

### 1. 单一真源

这份 markdown 文件就是唯一真源。

要求：

- 不把它复制成多份长期散落在别的文档里。
- 不把“当前计划”只放在聊天历史里。
- 不依赖上一轮对话的残留内容当作规则来源。
- 不让模型靠“记忆”执行，只让程序靠文件执行。

### 2. 每轮强制重载

每次模型调用前，程序必须执行同一套装载步骤：

1. 读取这份计划文件。
2. 计算版本号或 hash。
3. 读取当前执行状态文件。
4. 拼装本轮 system prompt。
5. 先放不可变护栏，再放当前阶段和当前批次。
6. 发送给模型。

这里的“强制”不是让模型自己回忆，而是让应用层根本不允许跳过装载。

### 3. 三层注入结构

把这份计划拆成三层注入，不要每轮无脑塞整篇全文：

#### A. Always Inject Core

每轮都必须注入，且长度要短，包含：

- 当前文档版本
- 当前 hash
- 当前硬边界
- 当前停机条件
- 当前输出格式
- 当前禁止事项

#### B. Active Phase Block

只注入当前阶段和当前批次，包含：

- 当前 phase
- 当前 batch
- 这一批的文件列表
- 这一批的默认顺序
- 这一批的验证命令
- 这一批的回滚规则

#### C. On-demand Appendix

只有当当前批次真的会碰到某个目录簇时，才附加那个目录簇的详细说明。

这样做的原因很简单：

- 全量长文每轮都塞，很容易被压缩或截断。
- 核心规则必须永远在。
- 细节只在当前批次需要时加载。

### 4. 外置状态文件

除了计划文档本身，还要有一个独立的执行状态文件，内容至少包括：

- `runbookVersion`
- `runbookHash`
- `phase`
- `batch`
- `completedBatches`
- `pendingFiles`
- `lastResult`
- `lastBlocker`
- `lastValidatedAt`

这个状态文件不靠聊天历史保存，必须落盘。

作用：

- 上一轮被压缩了，下轮照样能恢复。
- 模型临时忘了上下文，程序还能按状态文件重建。
- AI 不需要“记着刚才干到哪”，只要读状态文件就行。

### 5. 失败闭环

如果某轮模型输出不符合要求，程序不能假装成功。

必须：

1. 校验输出格式。
2. 校验结果是否包含必需字段。
3. 校验是否越过当前批次边界。
4. 校验是否引用了错误的旧路径。
5. 不通过就用同一份 runbook 重新装载后重试一次。

如果重试仍失败，就停机，不继续往下跑。

### 6. 不依赖对话记忆

对话历史只作为辅助，不作为规则来源。

也就是说：

- 不能因为上一轮说过就默认本轮仍然生效。
- 不能因为模型“看起来懂了”就不再注入。
- 不能因为上下文还没满就偷懒不读文件。

每轮都要重新读取 runbook，这才叫真正的抗压缩。

### 7. 冻结规则

如果文档内容被更新，程序必须：

1. 重新计算 hash。
2. 重新生成注入块。
3. 重置任何缓存的派生 prompt。
4. 在下一轮调用前重新加载。

旧 hash 只能用于回放，不可用于新一轮执行。

### 8. 实际注入优先级

每轮注入顺序必须是：

1. 不可变护栏
2. 当前阶段
3. 当前批次
4. 当前文件族
5. 当前状态文件摘要
6. 当前操作指令

不要把历史对话排在这些前面。

### 9. 适合挂机的最小提示词

为了减少上下文被压缩的概率，程序每轮还应该额外注入一个短句护栏：

> 这是一份外部执行规范。先读文件，再执行；文件优先于聊天历史；缺文件就停，不猜。

这个短句必须永远保留，且长度足够短，不能被删成“可有可无”的说明。

### 10. 结论

**真正的“每次都强制注入”不是靠模型记忆，而是靠程序每轮从磁盘重载。**

所以这份计划如果要真能挂机，就必须配套：

- 文件级真源
- 每轮重载
- 状态外置
- 输出校验
- 失败重试一次
- 再失败就停机

只要缺一项，都会回到“看起来像自动化，其实靠运气”的状态。

## 最终交付物

完成后，应该留下这些东西：

1. 更清晰的 JS 模块目录结构。
2. 一批稳定契约的 TypeScript 类型层。
3. `package.json` 里的 `typecheck` 脚本。
4. `tsconfig.json`。
5. 一套可重复的验证命令。
6. 一份独立的、未来可继续推进 runtime `.ts` 的前置基础。

## Phase 0：基线盘点与依赖图

目标：先搞清楚“谁依赖谁”，再动任何代码。

### 0.1 要看哪些文件

先看这些入口和底座：

- `packages/koishi-plugin-dongxuelian-ai/lib/index.js`
- `packages/koishi-plugin-dongxuelian-ai/lib/chat.js`
- `packages/koishi-plugin-dongxuelian-ai/lib/handler.js`
- `packages/koishi-plugin-dongxuelian-ai/lib/conversation.js`
- `packages/koishi-plugin-dongxuelian-ai/lib/agent/engine.js`
- `packages/koishi-plugin-dongxuelian-ai/lib/agent/router.js`
- `packages/koishi-plugin-dongxuelian-ai/lib/agent/config.js`
- `packages/koishi-plugin-dongxuelian-ai/lib/constants.js`
- `packages/koishi-plugin-dongxuelian-ai/lib/utils.js`
- `packages/koishi-plugin-dongxuelian-ai/lib/api.js`
- `packages/koishi-plugin-dongxuelian-ai/lib/runtime-config.js`
- `packages/koishi-plugin-dongxuelian-ai/lib/logging-config.js`
- `packages/koishi-plugin-dongxuelian-ai/lib/frontmatter.js`
- `packages/koishi-plugin-dongxuelian-ai/lib/redactor.js`

### 0.2 要画出的责任域

至少分出这些域：

- 核心底座：`constants` / `utils` / `api` / `runtime-config` / `logging-config` / `frontmatter` / `redactor`
- 回复层：发送、守卫、时机诊断
- 路由层：搜索、文件追问、群场景、定时任务路由
- 行为层：复读、反击、敏感词、随机回复模式、语音风格边界
- 人格层：persona、schema、profile、fallback、runtime plan
- 媒体层：file、image、voice
- Agent 层：engine、router、tools、skills、queue、context、safety

### 0.3 这一步的输出

AI 在脑内或记录里要明确三件事：

1. 哪些文件是高耦合入口。
2. 哪些文件是稳定底座。
3. 哪些文件最适合先变成“纯契约、纯数据、纯诊断”。

### 0.4 这一步的验证

- `npm run check`
- `npm run test:quick`
- `npm run test:scenario`

如果这一步连现状都看不清，就不要进入后面的迁移。

## Phase 1：JS 模块治理

目标：只做结构治理，不改运行时技术栈。

### 1.0 本阶段总策略

Phase 1 不是一次性重构，而是“按目录簇分批搬运”。
每一批都必须满足：

1. 同一责任域。
2. 同一组消费者。
3. 同一套验证命令。
4. 能保留 shim。
5. 能独立回退。

推荐每批 3 到 7 个文件，最多不要超过 10 个，除非整个文件族本来就很小。

### 1.1 迁移顺序

按这个顺序推进：

1. `core/`
2. `reply/`
3. `routing/`
4. `behavior/`
5. `persona/`
6. `file/`
7. `image/`
8. `voice/`
9. `agent/` 的纯子域

### 1.2 各目录簇的目标

#### core/

要收进去的基础文件：

- `constants.js`
- `utils.js`
- `api.js`
- `runtime-config.js`
- `logging-config.js`
- `frontmatter.js`
- `redactor.js`
- `onebot-endpoint.js`

目标是让后续目录都只从这里取稳定底座。

默认执行顺序：

1. `onebot-endpoint.js`
2. `frontmatter.js`
3. `redactor.js`
4. `logging-config.js`
5. `runtime-config.js`
6. `api.js`
7. `utils.js`
8. `constants.js`

说明：

- 先搬低耦合、少消费者的文件。
- `constants.js` 和 `utils.js` 放最后，因为它们是最常见的底座依赖。
- 如果实际依赖图显示某个文件更独立，可以在同一目录簇内部微调，但不要跳到别的目录簇。

#### core/ 第 1 批建议

优先顺序建议：

1. `onebot-endpoint.js`
2. `frontmatter.js`
3. `redactor.js`

这一批的特点是相对独立，适合作为 Phase 1 的试水批次。

#### core/ 第 2 批建议

1. `logging-config.js`
2. `runtime-config.js`

这一批偏配置和诊断，迁移时要确保日志输出行为不变。

#### core/ 第 3 批建议

1. `api.js`
2. `utils.js`

这两份和很多后续模块都相关，先确认前两批稳定后再动。

#### core/ 第 4 批建议

1. `constants.js`

最后动它，因为它是最容易造成连锁改动的底座。

#### reply/

要收进去的文件：

- `reply.js`
- `reply-guard.js`
- `reply-timing.js`

目标是统一“怎么发、什么时候发、什么不能发”。

默认执行顺序：

1. `reply-guard.js`
2. `reply-timing.js`
3. `reply.js`

说明：

- 先把守卫和诊断拆出来，再整理发消息主函数。
- `reply.js` 最后动，因为它更像组合层。

#### reply/ 第 1 批建议

1. `reply-guard.js`
2. `reply-timing.js`

#### reply/ 第 2 批建议

1. `reply.js`

#### routing/

要收进去的文件：

- `search-context.js`
- `group-scene-index.js`
- `reminder-route.js`
- `uploaded-file-action-route.js`
- `external-tool-policy.js`

目标是统一“这个输入到底路由到哪里”。

默认执行顺序：

1. `external-tool-policy.js`
2. `search-context.js`
3. `group-scene-index.js`
4. `reminder-route.js`
5. `uploaded-file-action-route.js`

说明：

- 先做纯策略和纯查询，再做带任务语义的 route 文件。
- 这些文件很多会被 chat.js 和 agent/engine.js 共同消费，所以保留 shim 的时间要长一点。

#### routing/ 第 1 批建议

1. `external-tool-policy.js`
2. `search-context.js`

#### routing/ 第 2 批建议

1. `group-scene-index.js`

#### routing/ 第 3 批建议

1. `reminder-route.js`
2. `uploaded-file-action-route.js`

#### behavior/

要收进去的文件：

- `repeat.js`
- `retaliation.js`
- `sensitive.js`
- `send-guard.js`
- `random-reply-mode.js`
- `affect-router.js`
- `sticker-shadow.js`
- `rare-voice.js`
- `random-voice-rate.js`

目标是把行为性判断和旁路诊断集中起来，不散在入口里。

默认执行顺序：

1. `rare-voice.js`
2. `random-voice-rate.js`
3. `random-reply-mode.js`
4. `send-guard.js`
5. `sensitive.js`
6. `retaliation.js`
7. `repeat.js`
8. `affect-router.js`
9. `sticker-shadow.js`

说明：

- 先动独立工具，再动更靠近入口的判断层。
- 这些文件里有不少是诊断旁路，迁移时不允许顺手改策略。

#### behavior/ 第 1 批建议

1. `rare-voice.js`
2. `random-voice-rate.js`
3. `random-reply-mode.js`

#### behavior/ 第 2 批建议

1. `send-guard.js`
2. `sensitive.js`
3. `retaliation.js`

#### behavior/ 第 3 批建议

1. `repeat.js`
2. `affect-router.js`
3. `sticker-shadow.js`

#### persona/

要收进去的文件：

- `persona.js`
- `persona-schema.js`
- `persona-profile.js`
- `persona-lore-router.js`
- `persona-runtime-plan.js`
- `persona-diagnostics.js`
- `persona-fallback.js`

目标是把人格解析、注入、诊断、降级分开。

默认执行顺序：

1. `persona-fallback.js`
2. `persona-diagnostics.js`
3. `persona-runtime-plan.js`
4. `persona-lore-router.js`
5. `persona-profile.js`
6. `persona-schema.js`
7. `persona.js`

说明：

- 先做兜底和诊断，再做解析和主入口。
- `persona.js` 是最终组合层，放最后。

#### persona/ 第 1 批建议

1. `persona-fallback.js`
2. `persona-diagnostics.js`

#### persona/ 第 2 批建议

1. `persona-runtime-plan.js`
2. `persona-lore-router.js`

#### persona/ 第 3 批建议

1. `persona-profile.js`
2. `persona-schema.js`

#### persona/ 第 4 批建议

1. `persona.js`

#### file/

要收进去的文件：

- `file-safety.js`
- `file-store.js`
- `file-analyzer.js`
- `file-followup-guard.js`

目标是把文件安全、存储、分析、追问边界拆开。

默认执行顺序：

1. `file-followup-guard.js`
2. `file-safety.js`
3. `file-store.js`
4. `file-analyzer.js`

说明：

- 先拆出“能不能问、能不能读”的边界，再动存储和分析。
- `file-analyzer.js` 之后再碰，因为它最靠近下载和解析路径。

#### file/ 第 1 批建议

1. `file-followup-guard.js`
2. `file-safety.js`

#### file/ 第 2 批建议

1. `file-store.js`

#### file/ 第 3 批建议

1. `file-analyzer.js`

#### image/

要收进去的文件：

- `image-store.js`
- `image-analyzer.js`
- `image-analysis-sanitizer.js`

#### voice/

要收进去的文件：

- `voice.js`
- `tts.js`
- `voice-assets.js`

#### agent/

这里只处理纯子域和纯 helper，不改运行时加载方式。

可先收敛这些文件：

- `agent-chat-bridge.js`
- `agent-retell-guard.js`
- `agent/context.js`
- `agent/queue.js`
- `agent/config.js`
- `agent/router.js`
- `agent/safety.js`
- `agent/search-query.js`
- `agent/search-results.js`
- `agent/pending.js`
- `agent/memory.js`
- `agent/http-search.js`
- `agent/fetch-reader.js`
- `agent/dream.js`
- `agent/cron.js`
- `agent/stats.js`
- `agent/skill-hub.js`
- `agent/workspace-context.js`
- `agent/tools/*`
- `agent/skills/*`
- `agent/plan/*`

默认执行顺序：

1. `agent-chat-bridge.js`
2. `agent-retell-guard.js`
3. `agent/context.js`
4. `agent/safety.js`
5. `agent/search-query.js`
6. `agent/search-results.js`
7. `agent/pending.js`
8. `agent/memory.js`
9. `agent/http-search.js`
10. `agent/fetch-reader.js`
11. `agent/dream.js`
12. `agent/stats.js`
13. `agent/queue.js`
14. `agent/config.js`
15. `agent/router.js`
16. `agent/cron.js`
17. `agent/skill-hub.js`
18. `agent/workspace-context.js`
19. `agent/tools/*`
20. `agent/skills/*`
21. `agent/plan/*`

说明：

- 先收敛最像纯 helper 的桥接、守卫和上下文。
- 再收敛队列、配置、路由和任务管理。
- `tools/`、`skills/`、`plan/` 是最后一组，因为它们和执行链最深。

#### agent/ 第 1 批建议

1. `agent-chat-bridge.js`
2. `agent-retell-guard.js`
3. `agent/context.js`

#### agent/ 第 2 批建议

1. `agent/safety.js`
2. `agent/search-query.js`
3. `agent/search-results.js`

#### agent/ 第 3 批建议

1. `agent/pending.js`
2. `agent/memory.js`
3. `agent/http-search.js`
4. `agent/fetch-reader.js`

#### agent/ 第 4 批建议

1. `agent/dream.js`
2. `agent/stats.js`
3. `agent/queue.js`
4. `agent/config.js`

#### agent/ 第 5 批建议

1. `agent/router.js`
2. `agent/cron.js`
3. `agent/skill-hub.js`
4. `agent/workspace-context.js`

#### agent/ 第 6 批建议

1. `agent/tools/*`
2. `agent/skills/*`
3. `agent/plan/*`

### 1.3 每个文件族的标准执行模板

对上面每个文件族，AI 必须按这个顺序执行：

1. 创建目标目录。
2. 创建目标文件，内容先和原文件一致。
3. 更新目标文件内部的相对 `require`。
4. 在旧位置放 shim，保留兼容。
5. 更新第一级消费者到新路径。
6. `node -c` 检查所有受影响 JS 文件。
7. `npm run test:quick`
8. 若触达消息/Agent/命令链路，再跑 `npm run test:scenario`
9. 只有在测试通过后，才考虑删旧定义。
10. 进入下一个文件族。

### 1.3.1 文件族执行模板（可直接照抄）

每个文件族都按下面模板执行，AI 不要自己改结构：

1. **确认范围**
   - 说明这批属于哪个目录簇。
   - 列出这一批的文件。
   - 说明这一批的目标是“新增目标路径 + shim + 更新消费者”，不是改行为。

2. **创建目标目录**
   - 只创建本批所需目录。
   - 不提前创建整棵树。

3. **复制文件内容**
   - 先完整复制原文件。
   - 先不改函数行为。
   - 先不拆逻辑。

4. **调整内部引用**
   - 只修新路径下的相对 `require`。
   - 只改必要路径，不做顺手清理。

5. **加 shim**
   - 旧路径保留最小 shim。
   - shim 只负责转发，不额外加逻辑。

6. **更新消费者**
   - 只更新这一批的直接消费者。
   - 不跨域重写所有引用。

7. **验证**
   - 先 `node -c`
   - 再 `npm run test:quick`
   - 如果触达消息/Agent/命令链路，再 `npm run test:scenario`

8. **记录**
   - 列出修改文件
   - 列出 shim
   - 列出消费者
   - 记下测试结果
   - 记下是否回退

9. **决定下一批**
   - 只有当前批通过，才能进入同目录簇下一批。
   - 不要跳批。

### 1.4 迁移时的具体要求

- 只做一层一层迁移，不做横跨整个目录树的大重构。
- 不要一次改太多 import 路径。
- 只要有旧路径还在被消费，就保留 shim。
- 基础模块先搬消费者，最后再搬底座。
- 先 leaf，后 root。
- 不要为了目录漂亮去改行为。
- 任何改动如果需要同时改 10 个以上消费者，先拆成多批，不允许一把梭。
- 每一批的目标文件数建议控制在 3 到 7 个，除非是同一个极小文件族。

### 1.5 对入口文件的约束

`index.js`、`chat.js`、`handler.js`、`agent/engine.js` 这些高耦合文件先不换后缀，只做边界收敛。

原则是：

- 不往入口里继续塞新状态。
- 不把协议定义散落在入口里。
- 不把纯函数留在入口层。

### 1.6 每个文件族结束时必须记录

AI 每处理完一个文件族，要输出：

- 新旧路径对应关系
- shim 是否保留
- 更新了哪些 consumer
- 跑了哪些测试
- 是否有回归

## Phase 2：TypeScript 类型层

目标：先让边界有类型，不改运行态。

### 2.1 这一步只做什么

- 加 `tsconfig.json`
- 加 `typecheck` 脚本
- 加 `types/` 或 `contracts/` 目录
- 给稳定边界加类型
- 给少数关键 JS 文件加 `@ts-check` 和 JSDoc

### 2.2 这一步不做什么

- 不生成运行时 `dist/`
- 不改 `main`
- 不要求 `.ts` 文件被 Node 直接执行
- 不全仓 `checkJs`
- 不把业务逻辑直接搬进类型目录

### 2.3 `tsconfig.json` 的建议配置

放在 `packages/koishi-plugin-dongxuelian-ai/tsconfig.json`，建议如下：

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["ES2020"],
    "strict": false,
    "noImplicitAny": true,
    "allowJs": true,
    "checkJs": false,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true
  },
  "include": ["lib/**/*", "types/**/*", "contracts/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

### 2.4 `package.json` 要加什么

在 `packages/koishi-plugin-dongxuelian-ai/package.json` 增加脚本：

- `typecheck: tsc --noEmit`

如果后续确实需要，也可以再加：

- `typecheck:watch`

但当前计划里只要求最小必需项。

建议同时在仓库根部确认 `typescript` 和 `@types/node` 的安装位置，优先让同一套依赖服务整个 workspace，不要在多个 package 里重复装不同版本。

### 2.5 类型文件应该怎么分

优先用独立类型文件，而不是把类型揉进业务代码里。

建议拆成：

- `types/chat.d.ts`
- `types/agent.d.ts`
- `types/media.d.ts`
- `types/persona.d.ts`
- `types/scene.d.ts`
- `types/tool.d.ts`
- `types/common.d.ts`

### 2.5.1 契约包落地顺序

类型层也要按顺序推进，不要一口气全开：

1. `types/common.d.ts`
2. `types/tool.d.ts`
3. `types/chat.d.ts`
4. `types/persona.d.ts`
5. `types/scene.d.ts`
6. `types/media.d.ts`
7. `types/agent.d.ts`

说明：

- `common` 和 `tool` 先行，因为后面一堆类型会复用它们。
- `chat` 和 `persona` 是最先能产生实际收益的边界。
- `agent` 放后面，因为它依赖最多，最容易连带出错。

### 2.6 先定义哪些契约

优先定义这些稳定对象：

- `ChatInput`
- `ChatResult`
- `ChatToolCall`
- `AgentTaskInput`
- `AgentTaskResult`
- `AgentToolPolicy`
- `FileAnchor`
- `ImageAnchor`
- `VoiceTask`
- `PersonaBinding`
- `PersonaResolution`
- `SceneCard`
- `SceneAnchor`
- `ToolDefinition`
- `ToolExecutionResult`

### 2.7 类型层的约束

- 类型只描述稳定契约，不描述临时实现。
- 复杂对象先类型化，再考虑实现调整。
- 任何地方都不要因为图省事回退到模糊类型。
- 如果必须表达未知值，优先 `unknown`，不要随手扩散“宽松类型”。
- 只有稳定边界才加 `@ts-check`。

### 2.8 JSDoc 接入规则

对少量边界 JS 文件，允许这样做：

- `/** @typedef {import('../types/chat').ChatInput} ChatInput */`
- `/** @type {ChatInput} */`

但要遵守两条：

1. 只给边界文件加，不要全仓扫。
2. 一次只给一批稳定字段加，不要大面积硬改。

### 2.8.1 首批适合加 `@ts-check` 的文件

默认先从这些相对稳定的边界文件开始：

- `packages/koishi-plugin-dongxuelian-ai/lib/agent/config.js`
- `packages/koishi-plugin-dongxuelian-ai/lib/chat-tools.js`
- `packages/koishi-plugin-dongxuelian-ai/lib/conversation.js`
- `packages/koishi-plugin-dongxuelian-ai/lib/file-store.js`
- `packages/koishi-plugin-dongxuelian-ai/lib/file-safety.js`
- `packages/koishi-plugin-dongxuelian-ai/lib/persona.js`
- `packages/koishi-plugin-dongxuelian-ai/lib/utils.js`

说明：

- 这些文件大多是边界承载层，类型收益比纯入口层更高。
- 入口层和高频编排层先不要全加 `@ts-check`，容易把噪音放大。

### 2.9 类型层验证

每次新增或修改类型后都跑：

- `npm run typecheck`
- `npm run test:quick`

如果类型层影响到消息路由、Agent、命令或媒体链路，再补：

- `npm run test:scenario`

### 2.10 类型层推进模板

TypeScript 类型层也必须按批执行，不能一口气铺开：

1. 选一个契约包。
2. 写类型定义。
3. 把少量边界文件接上 `@ts-check` 或 JSDoc。
4. 跑 `typecheck`。
5. 跑 `test:quick`。
6. 只要涉及行为，再跑 `test:scenario`。
7. 记录哪些字段已经有类型，哪些还是宽松类型。
8. 再进入下一个契约包。

### 2.11 类型层首批推进顺序

建议 AI 按这个顺序推进：

1. `types/common.d.ts`
2. `types/tool.d.ts`
3. `types/chat.d.ts`
4. `types/persona.d.ts`
5. `types/scene.d.ts`
6. `types/media.d.ts`
7. `types/agent.d.ts`

说明：

- 先 common 和 tool，因为它们会被后续很多类型复用。
- `chat` 和 `persona` 是最容易看到实际收益的边界。
- `agent` 放最后，避免一开始就把复杂执行链弄乱。

## Phase 3：阶段复盘和升级决策

目标：确认前面做的事情到底有没有实际收益。

### 3.1 复盘问题

重点看三个问题：

1. 入口文件有没有继续膨胀。
2. 改一个功能时，是否更容易定位到正确目录。
3. 工具调用、Agent 任务、媒体边界是不是更少出现字段漂移。

### 3.2 复盘输出

必须输出这些结果：

- 已完成的目录簇
- 还没动的目录簇
- 保留的 shim
- 通过的测试
- 未覆盖的风险
- 是否值得启动下一份“运行时 `.ts` 迁移方案”

### 3.2.1 复盘输出模板

AI 每轮复盘就按这个格式输出：

- `done`：本轮完成的目录簇/文件族。
- `blocked`：本轮卡住的地方。
- `evidence`：对应的测试结果或语法检查结果。
- `risk`：仍然存在的风险。
- `next_batch`：下一批默认进入哪里。
- `decision`：继续 / 暂停 / 回退 / 改方案。

### 3.3 下一份方案才可以讨论的事

只有到了下一份独立方案，才讨论：

- 是否需要 build step
- 是否需要 `dist/`
- 是否修改 `main`
- 是否要变更发布/回滚流程

当前方案不碰这些。

## 验收标准

1. 现有 JS 运行时不变，`main: lib/index.js` 不变。
2. 核心模块边界更清楚，入口不再继续往外长新职责。
3. 至少一批稳定契约已经有 TypeScript 类型层。
4. 没有引入新的运行时 loader 或编译副作用。
5. `npm run check`、`npm run test:quick`、`npm run test:scenario` 仍能过。
6. 如果后续真的要做 `.ts` runtime 迁移，已经具备单独拆案的基础。

## 失败处理

### 1. 单文件族失败

只回退这个文件族，保留其他文件族的成果。

### 2. 类型层失败

先修类型，不急着改业务实现。

### 3. 运行时语义失败

先停，不要继续往下迁移。

### 4. 发现必须引入运行时 loader

本方案立即停止，改为准备下一份独立方案。

## AI 最终输出模板

每完成一个阶段，AI 都应输出这几项：

- 本阶段完成了什么
- 改了哪些文件
- 哪些旧路径还保留 shim
- 跑了哪些测试
- 哪些测试没覆盖到
- 还有什么风险
- 下一步要进哪个目录簇

## 总结

这份方案的核心不是“尽快把 JS 全换成 TS”，而是“先把长期能维持的边界做出来”。
JS 继续跑，TS 先做护栏。
护栏真的证明有用之后，再决定要不要把某些纯模块继续往 `.ts` 推。
