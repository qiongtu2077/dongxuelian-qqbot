# 模块治理与 TypeScript 渐进迁移方案

日期：2026-05-25
现状适配：2026-05-26
状态：待审核，已按当前仓库结构重写，尚未开始实施

## 0. 当前结论

本方案现在只覆盖 `packages/koishi-plugin-dongxuelian-ai` 的模块治理与 TypeScript 类型护栏。它不再冒充整个仓库总控，也不替代上下文、人设、Agent、MCP、部署、安全等其他计划。

当前选择很明确：

1. **先做目录分化，再做 TypeScript 类型层。**
2. 先保持 JS 运行时不变，`main: lib/index.js` 不变。
3. 先把现有扁平 `lib/` 收敛成稳定目录边界，再把 TypeScript 类型定义挂到这些边界上。
4. 本方案不启动运行时 `.ts` 迁移，不引入 loader，不生成 `dist/`，不改发布链路。

原因也很直接：当前 `lib/` 顶层仍有大量扁平 JS 文件，虽然 `index.js` / `chat.js` 已经拆薄，但目录边界还没稳定。此时先上 TS，会把类型绑定在马上要移动的旧路径上，后面目录迁移会重复改类型引用，收益低、噪音高。

## 1. 开工前硬门槛

进入本方案实施前必须满足：

1. `架构债优化计划.md` 已完成、部署、六轮 Bug 扫描、修复、提交并推送。
2. 仓库本地分支是最新版本，`HEAD == origin/bot_ZZY`，且没有未归档的架构债变更。
3. 已备份前序成果，至少有一个可回退 commit。
4. 每轮实施前必须读取：
   - `AGENTS.md`
   - `AI协作规则.md`
   - `待完成与待审核任务/2026-05-25-模块治理与TypeScript渐进迁移待审核方案.md`
5. 进入本方案后，不再要求每轮必读 `架构债优化计划.md`，但遇到架构债回滚、部署、推送、线上问题时仍要回读。

如果上面任一条不满足，只允许继续修前置问题或更新本方案，不允许开始目录迁移或 TypeScript 接入。

## 2. 当前仓库结构盘点

本轮按当前工作区只读盘点得到：

- 工作目录：`E:\莲莲Bot`
- 分支：`bot_ZZY`
- 插件包：`packages/koishi-plugin-dongxuelian-ai`
- 插件入口：`packages/koishi-plugin-dongxuelian-ai/package.json` 中 `main: lib/index.js`
- 插件包当前没有自己的 `tsconfig.json`
- 插件包当前没有自己的 `typecheck` 脚本
- 根 `package-lock.json` 已有 `typescript` 和 `@types/node`，主要由 `packages/agent-console` 引入
- `packages/koishi-plugin-dongxuelian-ai/lib` 当前只有这些目录：
  - `agent/`
  - `commands/`
  - `mcp/`
  - `rulesets/`
- `lib/` 顶层 JS 文件约 88 个
- `lib/` 递归 JS 文件约 160 个

架构债拆分后的关键现状：

- `index.js` 已降到约 31 KB，仍是 Koishi 插件入口和消息编排层。
- `chat.js` 已降到约 43 KB，仍保留模型调用所有权和 chat 主循环。
- 已经存在的新拆分模块包括：
  - `session-compat.js`
  - `bot-resolver.js`
  - `channel-task-queue.js`
  - `event-dump.js`
  - `plugin-lifecycle.js`
  - `message-segment.js`
  - `incoming-file.js`
  - `incoming-message-flow.js`
  - `runtime-settings.js`
  - `user-blacklist.js`
  - `safe-send.js`
  - `random-state.js`
  - `chat-tool-flow.js`
  - `chat-final-output-flow.js`
  - `chat-jailbreak-flow.js`
  - `chat-topic-switch.js`
  - `chat-agent-retell-flow.js`
  - `chat-result-flow.js`
  - `agent-auto-route-flow.js`
  - `chat-send-flow.js`

这意味着本方案的 Phase 1 不是“从两个大文件拆模块”，而是“把已经拆出来的扁平模块按责任域搬进目录，并保留兼容 shim”。

## 3. 目标与非目标

### 3.1 目标

1. 将 `lib/` 顶层扁平文件逐步归入稳定目录：
   - `core/`
   - `reply/`
   - `routing/`
   - `behavior/`
   - `persona/`
   - `media/file/`
   - `media/image/`
   - `media/voice/`
   - `chat/`
   - `lifecycle/`
   - `diagnostics/`
2. 保留旧路径 shim，避免一次性重写大量 require。
3. 更新直接消费者到新路径，每批最多处理一个责任域。
4. 增加 `tsconfig.json`、`typecheck` 脚本和 `types/` 契约目录。
5. 只给稳定边界加 JSDoc / `@ts-check`，不全仓开启 `checkJs`。

### 3.2 非目标

1. 不把运行时代码从 `.js` 改成 `.ts`。
2. 不新增运行时 loader。
3. 不生成 `dist/`。
4. 不改插件 `main`。
5. 不改模型调用、随机回复、Agent 路由、文件/图片/语音行为。
6. 不借目录迁移顺手重构业务逻辑。
7. 不删除 shim，除非所有消费者已经迁走且测试通过。

## 4. 责任域映射

### 4.1 core/

稳定底座，后续目录只从这里取基础能力。

候选文件：

- `constants.js`
- `utils.js`
- `api.js`
- `runtime-config.js`
- `logging-config.js`
- `frontmatter.js`
- `redactor.js`
- `onebot-endpoint.js`

当前策略：

- 先搬低耦合文件：`onebot-endpoint.js`、`frontmatter.js`、`redactor.js`
- 再搬配置和日志：`logging-config.js`、`runtime-config.js`
- 再搬 API 和工具：`api.js`、`utils.js`
- 最后才碰 `constants.js`

`constants.js` 和 `utils.js` 是高消费者底座，不能作为第一批。

### 4.2 reply/

发送与回复守卫。

候选文件：

- `reply.js`
- `reply-guard.js`
- `reply-timing.js`
- `safe-send.js`
- `send-guard.js`

当前策略：

- 先搬纯守卫和诊断：`reply-guard.js`、`reply-timing.js`
- 再搬发送安全：`send-guard.js`、`safe-send.js`
- 最后搬组合发送：`reply.js`

### 4.3 routing/

输入路由、场景索引、行动路由。

候选文件：

- `external-tool-policy.js`
- `search-context.js`
- `group-scene-index.js`
- `file-quick-read.js`
- `reminder-route.js`
- `uploaded-file-action-route.js`

当前策略：

- `external-tool-policy.js` 和 `search-context.js` 可先搬。
- `group-scene-index.js` 当前体量较大且关系到 `read_group_context`，必须单独一批。
- `reminder-route.js`、`uploaded-file-action-route.js` 与 Agent 行动语义有关，放在 routing 后段。

### 4.4 behavior/

行为策略、随机、复读、敏感、反击、情绪旁路。

候选文件：

- `repeat.js`
- `retaliation.js`
- `sensitive.js`
- `random-reply-mode.js`
- `random-persona-risk.js`
- `random-state.js`
- `random-voice-rate.js`
- `rare-voice.js`
- `affect-router.js`
- `sticker-shadow.js`
- `emotion-renderer.js`

当前策略：

- 先搬独立小件：`rare-voice.js`、`random-voice-rate.js`、`random-persona-risk.js`
- 再搬随机状态：`random-state.js`、`random-reply-mode.js`
- 再搬敏感/反击/复读：`sensitive.js`、`retaliation.js`、`repeat.js`
- `affect-router.js`、`sticker-shadow.js`、`emotion-renderer.js` 放后面，保持 shadow 旁路语义不变。

### 4.5 persona/

人格解析、运行计划、profile、lore、诊断与兜底。

候选文件：

- `persona.js`
- `persona-schema.js`
- `persona-profile.js`
- `persona-lore-router.js`
- `persona-runtime-plan.js`
- `persona-diagnostics.js`
- `persona-fallback.js`

当前策略：

- 先搬 `persona-fallback.js`、`persona-diagnostics.js`
- 再搬 `persona-runtime-plan.js`、`persona-lore-router.js`
- 再搬 `persona-schema.js`
- `persona-profile.js` 体量大，单独一批
- `persona.js` 是组合入口，最后搬

### 4.6 media/file/

文件安全、存储、分析、追问边界。

候选文件：

- `file-followup-guard.js`
- `file-safety.js`
- `file-store.js`
- `file-analyzer.js`
- `incoming-file.js`

当前策略：

- 先搬 `file-followup-guard.js`、`file-safety.js`
- 再搬 `incoming-file.js`、`file-store.js`
- 最后搬 `file-analyzer.js`

### 4.7 media/image/

图片存储、分析和分析结果净化。

候选文件：

- `image-store.js`
- `image-analyzer.js`
- `image-analysis-sanitizer.js`
- `vision.js`

当前策略：

- 先搬 `image-analysis-sanitizer.js`
- 再搬 `image-store.js`
- 再搬 `image-analyzer.js`
- `vision.js` 与当前消息多模态请求相关，最后搬

### 4.8 media/voice/

语音识别、TTS、音色资产。

候选文件：

- `voice.js`
- `tts.js`
- `voice-assets.js`

当前策略：

- 先搬 `voice-assets.js`
- 再搬 `voice.js`
- 最后搬 `tts.js`

### 4.9 chat/

chat 主链路的子模块，不迁移 `chat.js` 主入口本体。

候选文件：

- `chat-memory.js`
- `chat-prompt-builder.js`
- `chat-tools.js`
- `chat-tool-flow.js`
- `chat-final-output-flow.js`
- `chat-jailbreak-flow.js`
- `chat-topic-switch.js`
- `chat-agent-retell-flow.js`
- `chat-result-flow.js`
- `chat-send-flow.js`

当前策略：

- 只搬已经拆出来的 chat 子模块。
- `chat.js` 继续留在 `lib/chat.js`，作为兼容入口和模型调用所有权所在。
- 等所有消费者稳定后，再讨论是否把 `chat.js` 变成 shim。

### 4.10 lifecycle/

插件生命周期、启动定时器、队列等运行期编排。

候选文件：

- `plugin-lifecycle.js`
- `startup-schedulers.js`
- `channel-task-queue.js`
- `event-dump.js`
- `session-compat.js`
- `bot-resolver.js`

当前策略：

- 先搬无业务语义的兼容层：`session-compat.js`、`bot-resolver.js`
- 再搬 `event-dump.js`
- 再搬 `channel-task-queue.js`
- 最后搬 `startup-schedulers.js`、`plugin-lifecycle.js`

### 4.11 diagnostics/

诊断、健康检查、旁路观察。

候选文件：

- `diagnostics.js`
- `health-check.js`
- `shared-record-text.js`
- `message-segment.js`
- `message-reader.js`

当前策略：

- `message-reader.js` 是消息解析核心，不先搬。
- 第一批只考虑 `diagnostics.js`、`health-check.js`、`shared-record-text.js`
- `message-segment.js` 和 `message-reader.js` 后续单独评估。

### 4.12 agent/

`agent/` 已经是目录，不做大搬迁。只做内部子域整理和类型护栏。

当前子域：

- `agent/tools/`
- `agent/skills/`
- `agent/plan/`
- 其余 agent 根文件

当前策略：

- 不把整个 `agent/` 再搬到别处。
- 先给 `agent/config.js`、`agent/queue.js`、`agent/safety.js`、`agent/context.js` 这类边界文件加类型契约。
- `agent/tools/*` 最后做，因为工具数量多、执行链深。

## 5. Phase 0：基线盘点

Phase 0 只读，不改文件。

必须输出：

1. 当前 `lib/` 顶层文件列表。
2. 当前 `lib/` 子目录列表。
3. 每个责任域的候选文件是否存在。
4. 每个候选文件的直接消费者数量。
5. 第一批目录分化候选。
6. 当前验证基线。

必须运行：

```bash
git rev-parse --show-toplevel
git branch --show-current
git status --short --branch
git rev-parse HEAD
git rev-parse origin/bot_ZZY
npm run check
npm run test:quick
```

如果 `test:quick` 或 `check` 不通过，不能进入 Phase 1。

## 6. Phase 1：JS 目录分化

Phase 1 只做目录分化，不改运行时技术栈。

每批必须满足：

1. 同一责任域。
2. 文件数量 1 到 3 个优先，最多不超过 5 个。
3. 新路径 + 旧路径 shim 同时存在。
4. 只更新直接消费者。
5. 不做业务逻辑重构。

### 6.1 第一批

建议第一批：

1. `onebot-endpoint.js` -> `core/onebot-endpoint.js`
2. `frontmatter.js` -> `core/frontmatter.js`
3. `redactor.js` -> `core/redactor.js`

理由：

- 文件小。
- 依赖少。
- 适合验证 shim、consumer 更新和 cascade 维护流程。
- 不触达聊天主链路。

### 6.2 第二批

建议第二批：

1. `logging-config.js` -> `core/logging-config.js`
2. `runtime-config.js` -> `core/runtime-config.js`

理由：

- 属于配置和诊断底座。
- 消费者较多，但行为稳定。
- 迁移后能让后续目录统一从 `core/` 取配置。

### 6.3 第三批

建议第三批：

1. `session-compat.js` -> `lifecycle/session-compat.js`
2. `bot-resolver.js` -> `lifecycle/bot-resolver.js`

理由：

- 它们是已拆出的兼容层。
- 和 `index.js` 入口强相关，但业务策略少。
- 适合在 core 试水稳定后推进。

### 6.4 后续批次顺序

默认顺序：

1. `core/`
2. `lifecycle/`
3. `diagnostics/`
4. `reply/`
5. `routing/`
6. `behavior/`
7. `persona/`
8. `media/file/`
9. `media/image/`
10. `media/voice/`
11. `chat/`
12. `agent/` 类型护栏

`chat/` 放后面，是因为 chat 子模块虽然已经拆出，但仍与 `chat.js` 主循环、模型调用和工具流紧密相关。目录分化应先让底座和边界稳定。

## 7. 文件族执行模板

每批严格按这个顺序：

1. 读本方案和当前 git 状态。
2. 确认本批文件都存在。
3. 用 `rg` 查直接消费者。
4. 创建目标目录。
5. 复制原文件到目标路径。
6. 只修目标文件内部相对 `require`。
7. 旧路径改成最小 shim：
   ```js
   module.exports = require('./new/path')
   ```
8. 只更新本批直接消费者。
9. 更新 `cascade-test.js` 的模块路径、语法检查、重复函数扫描和必要的 cross-file guard。
10. 逐个运行 `node -c`。
11. 运行 `npm run test:quick`。
12. 若触达消息、命令、Agent、媒体链路，再运行 `npm run test:scenario`。
13. 在本文件的执行记录里写明改了什么、测了什么、是否保留 shim。

## 8. Phase 2：TypeScript 类型护栏

Phase 2 在至少完成 `core/`、`lifecycle/`、`reply/` 的目录分化并通过测试后再开始。

### 8.1 只做什么

1. 新增 `packages/koishi-plugin-dongxuelian-ai/tsconfig.json`
2. 在插件包增加 `typecheck` 脚本
3. 新增 `packages/koishi-plugin-dongxuelian-ai/types/`
4. 给稳定边界定义 `.d.ts`
5. 给少量边界 JS 加 `@ts-check` 和 JSDoc

### 8.2 不做什么

1. 不把 `.js` 改 `.ts`
2. 不启用运行时编译
3. 不改 `main`
4. 不生成 `dist`
5. 不全仓 `checkJs`

### 8.3 tsconfig 建议

文件：`packages/koishi-plugin-dongxuelian-ai/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["ES2020"],
    "strict": false,
    "noImplicitAny": false,
    "allowJs": true,
    "checkJs": false,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true
  },
  "include": ["lib/**/*", "types/**/*"],
  "exclude": ["node_modules", "test"]
}
```

说明：

- 第一版 `noImplicitAny` 先设为 `false`，避免一开始被历史 JS 噪音淹没。
- 后续只在已加 `@ts-check` 的边界文件上逐步收紧。

### 8.4 typecheck 脚本

插件包脚本建议：

```json
{
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

根目录是否增加聚合脚本，等插件包本地 typecheck 稳定后再决定。

### 8.5 类型目录

首批类型文件：

- `types/common.d.ts`
- `types/tool.d.ts`
- `types/chat.d.ts`
- `types/scene.d.ts`
- `types/media.d.ts`
- `types/persona.d.ts`
- `types/agent.d.ts`

推进顺序：

1. `common.d.ts`
2. `tool.d.ts`
3. `scene.d.ts`
4. `media.d.ts`
5. `chat.d.ts`
6. `persona.d.ts`
7. `agent.d.ts`

`agent.d.ts` 最后做，因为 Agent 执行链最深，字段来源最多。

### 8.6 首批适合接 `@ts-check` 的文件

等对应目录分化完成后，优先考虑：

- `core/runtime-config.js`
- `core/logging-config.js`
- `routing/group-scene-index.js`
- `media/file/file-safety.js`
- `media/file/file-store.js`
- `persona/persona-schema.js`
- `agent/config.js`
- `agent/queue.js`

不首批接入：

- `index.js`
- `chat.js`
- `handler.js`
- `agent/engine.js`
- `chat-tools.js`

这些文件是高频编排或复杂执行链，先不要把类型噪音放大。

## 9. Phase 3：局部 `.ts` 试点

只有 Phase 1 和 Phase 2 都稳定后，才允许讨论局部 `.ts` 试点。

试点条件：

1. 目标文件是纯函数或纯数据契约。
2. 不需要运行时 loader。
3. 不改变发布入口。
4. 不影响 Koishi 插件加载。
5. 有完整 shim 或编译产物策略。

当前不建议在本方案内做 `.ts` 运行时迁移。如果一定要做，必须另开独立方案。

## 10. 验证矩阵

每批默认：

```bash
node -c <changed-js-files>
npm run test:quick
```

触达入口、消息、命令、Agent、媒体、发送链路时追加：

```bash
npm run test:scenario
```

TypeScript 类型层追加：

```bash
npm run typecheck --prefix packages/koishi-plugin-dongxuelian-ai
```

阶段收尾：

```bash
npm run check
npm run test:quick
npm run test:scenario
git diff --check
```

## 11. 停机条件

出现以下情况必须暂停：

1. 目录迁移导致运行时行为变化。
2. shim 路径无法稳定兼容旧消费者。
3. 单批消费者超过 10 个且无法再拆小。
4. `npm run test:quick` 失败且原因不是测试自身缺陷。
5. `npm run test:scenario` 暴露用户可见回归。
6. typecheck 需要大面积改业务实现才能通过。
7. 需要引入 runtime loader 才能继续。
8. 工作区出现与本批无关的用户改动并影响同一文件。

## 12. 执行记录模板

每完成一批，在本文件末尾追加记录：

```md
## 执行记录：YYYY-MM-DD 批次名

- 范围：
- 新路径：
- shim：
- 更新消费者：
- cascade 更新：
- 验证：
- 测试四问：
  1. 复现了哪条真实失败输入：
  2. 断言了哪个失败现象：
  3. 哪些依赖被 mock：
  4. 仍未覆盖哪些真实链路：
- 风险：
- 下一批：
```

结构等价迁移如果没有真实失败输入，第一问要写明“本批是结构等价迁移，不针对单一失败输入”，并列出覆盖的链路场景。

## 13. 最终验收标准

1. `lib/` 顶层扁平文件显著减少。
2. `core/`、`reply/`、`routing/`、`behavior/`、`persona/`、`media/*`、`chat/`、`lifecycle/`、`diagnostics/` 边界清楚。
3. 旧路径 shim 清单可查，且没有循环依赖。
4. `index.js`、`chat.js`、`handler.js`、`agent/engine.js` 没有继续膨胀。
5. 至少一批稳定契约已有 TypeScript 类型护栏。
6. 没有引入 runtime loader、dist、main 变更。
7. `npm run check`、`npm run test:quick`、`npm run test:scenario`、`typecheck` 均通过。

## 14. 当前决策

先做目录分化，不先做 TS 升级。

具体先做：

1. Phase 0 基线盘点。
2. Phase 1 第一批 `core/onebot-endpoint.js`、`core/frontmatter.js`、`core/redactor.js`。
3. 第一批稳定后再进入 `core/logging-config.js`、`core/runtime-config.js`。
4. 至少 `core/` 与 `lifecycle/` 稳定后，再开始 Phase 2 TypeScript 类型护栏。

这条路线最符合当前仓库状态：先把真实目录边界立起来，再让类型系统服务这些边界。
