# 莲莲Bot 安全审计报告（第三轮 · 2026-05-20 最终版）

> 初始审计：2026-05-19（第三轮验收 + 深度扫描）
> 复核：2026-05-20（合并 origin/YUN 后逐条核对）
> 修复执行：2026-05-20（Phase 1-4、延后项、语音克隆优化、handler 命令域拆分已归档；架构改进待后续确认）
> 分支：bot_ZZY


---

## 架构改进建议

### A1. Dashboard 前端组件迁移到 `<script setup>` 语法

**优先级**: 中（暂不执行）

将 PersonaPanel.vue、ConfigPanel.vue、DeployPanel.vue、MonitorPanel.vue、App.vue 迁移到 `<script setup>` 语法，消除 setup() return 遗漏导致白屏的风险。

---

## chat/index 拆分治理方案

### 背景

当前 `packages/koishi-plugin-dongxuelian-ai/lib/index.js`、`chat.js` 仍超过健康维护边界：

- `index.js` 当前约 1300 行，`exports.apply()` 约 600 行，除了 Koishi 生命周期和 middleware 编排，还持有随机回复、发送风控、事件抓取、runtime settings、用户/视频黑名单等状态。
- `chat.js` 当前约 1000 行，`chat()` 约 700 行，混合了 prompt 构建、反击值、记忆确认、话题切换、Agent 结果转述、识图、工具调用、回复重试和最终兜底。

这次拆分目标不是减少行数本身，而是恢复模块边界，让未来新增功能不会继续塞进入口文件。

### 拆分原则

必须遵守现有批注、`AI协作规则.md`、`教训总结.md`、`测试文件维护指南.md`：

1. 按职责边界拆，不按行数拆。只有独立状态、独立 IO、独立异步链路、独立模型调用、独立测试面才拆。
2. 补旧功能不拆，长出新功能器官才拆。几行命令匹配、无状态单点 helper、传参后反而更难读的逻辑不拆。
3. 新模块禁止 `require('./index')`，只能依赖 `constants.js`、`utils.js`、`api.js`、`conversation.js`、`persona.js`、`runtime-config.js` 等稳定层。
4. `chat()` 保留模型调用所有权。拆出的 chat 子模块只做构建、判断、状态管理；需要模型能力时用回调，不直接反向控制主流程。
5. 每新增生产模块，必须同步 `package.json` 的 `scripts.check` 和 `cascade-test.js` 的 `modPaths`、`expectedExports`、`syntaxFiles`、`duplicateScanFiles`。
6. 行为变更优先 scenario，不用源码字符串扫描替代真实消息链路。
7. 每个阶段都必须保持可运行、可回归，不做“一口气大搬家”。

### 不拆清单

以下内容即使看起来占行，也不建议单独拆：

1. 少量命令匹配和参数校验，例如简单开关、状态查看、固定文案回复。
2. 无状态、无 IO、单点调用的小 helper。
3. 拆出后需要传入十几个参数、比原地阅读更难理解的片段。
4. 只为了让 `index.js` 或 `chat.js` 行数变短的机械搬运。
5. 尚未有稳定行为测试覆盖、且行为非常敏感的随机回复核心链路。应先补/确认 scenario，再拆。

### 阶段 A：index.js 入口状态拆分

目标：让 `index.js` 只做 Koishi `apply()`、生命周期注册、中间件主流程编排，不再持有业务状态所有权。

建议新增模块：

| 模块 | 拆入内容 | 拆分理由 |
|------|----------|----------|
| `lib/runtime-settings.js` | 随机白名单、随机概率、fingerprint、`loadRuntimeSettings()`、`getRandomTriggerBaseRate()`、`getRandomWhitelistStatus()` | 独立文件缓存和运行时缓存所有权 |
| `lib/channel-queue.js` | `channelQueues`、`channelQueueDepth`、`enqueueForChannel()` | 独立并发控制状态，可纯行为测试 |
| `lib/event-dump.js` | `armedEventDumpCache`、抓取开启/查看/取消、`dumpSessionEvent()` | 独立调试功能 + 过期状态 + 落盘 IO |
| `lib/safe-send.js` | `sendFailState`、`safeSendReply()`、`safeSendRareVoice()`、发送失败管理员通知 | 独立发送生命周期，和 middleware 编排分离 |
| `lib/middleware-admin-commands.js` | 白名单、用户黑名单、视频黑名单、敏感处理者、敏感检测开关、解除上限白名单、AI抓事件、概率设置 | 这些命令当前绕过 `handler.js` 放在 index 中，应统一为 middleware 前置命令模块 |
| `lib/startup.js` | ready 初始化、今日缓存恢复、定时清理、agent cron 恢复、dispose 清理辅助函数 | 生命周期初始化边界独立 |

阶段完成后，`index.js` 仍负责：

- 安装 Satori/Koishi Session 兼容补丁。
- `exports.name` 和 `exports.apply`。
- middleware 主顺序：解析消息、维护模式、命令处理、敏感处理、上下文记录、随机/复读判断、chat/agent 分派、发送回复。

验收要求：

1. `index.js` 不新增 Map/Set/全局缓存；原有缓存迁移到对应模块。
2. `ctx.on('dispose')` 仍能清理 pending random timer、daily cleanup timer、sensitive timer 等资源。
3. `random.test.js`、`repeat.test.js`、`sensitive.test.js`、`send-guard.test.js`、`command.test.js` 必须继续通过。
4. 执行 `npm run check && npm run test:quick && npm run test:scenario`。

### 阶段 B：chat.js 聊天核心拆分

目标：保持 `chat()` 控制模型调用和对话保存，但把 prompt 构建、模式状态、话题切换和最终回复兜底拆成可维护模块。

建议新增模块：

| 模块 | 拆入内容 | 拆分理由 |
|------|----------|----------|
| `lib/chat/skill-cache.js` | `skillsCache`、`skillsContentCache`、技能文件扫描和内容缓存 | 独立文件 IO 和缓存所有权 |
| `lib/chat/retaliation-mode.js` | 反击值、`hostileLevelCache`、友善/阴阳/嘴臭模式选择 | 独立状态 Map，和 prompt 构建解耦 |
| `lib/chat/memory-flow.js` | “记住/记下”、AI 询问后确认记忆、口头纠正、记忆定时清空检查 | 独立 conversation/memory 读写链路 |
| `lib/chat/topic-switch.js` | `topicSwitchLocks`、话题切换检测、历史降级决策 | 独立并发锁和历史管理策略；模型判断通过回调传入 |
| `lib/chat/prompt-builder.js` | 系统提示词、人设、时间提示、lore、history、memory、shared context、正经问题/不确定问题提示 | 纯构建为主，禁止直接发请求 |
| `lib/chat/evaluation-context.js` | @人评价时读取用户画像、生成风格摘要、注入评价上下文 | 独立 profile IO + 轻量模型摘要；模型能力通过回调传入 |
| `lib/chat/agent-retell.js` | Agent 结果作为内部材料转述、转述防泄漏 guard | Agent → chat 桥接边界清晰 |
| `lib/chat/finalize-reply.js` | 禁词重试后的最终清洗、thinking leak 兜底、内部上下文泄漏兜底、罕见前缀、语义画像拦截 | 回复出口统一收口，避免 guard 分散 |

阶段完成后，`chat.js` 保留：

- `callOpenAI()`。
- `chatJailbreak()`，或在确认无循环依赖后拆成 `chat/jailbreak-reply.js`。
- `chat()` 主流程：准备上下文 → 调 builder → 调模型 → 处理工具调用 → 调 finalize → 保存 conversation。

验收要求：

1. 子模块不能直接 `require('./index')`。
2. 子模块默认不直接调用 `callOpenAI()`；确需模型判断时由 `chat()` 传入回调。
3. `persona-prompt.test.js`、`chat.test.js`、`vision.test.js`、`fallback.test.js` 必须继续通过。
4. 明确回答测试四问，不能只说 happy path 通过。
5. 执行 `npm run check && npm run test:quick && npm run test:scenario`。

### 阶段 C：兼容补丁和启动边界整理

目标：把入口顶部的兼容补丁和启动流程整理清楚，但不改变加载时机。

建议新增模块：

| 模块 | 拆入内容 | 拆分理由 |
|------|----------|----------|
| `lib/satori-session-patch.js` | `stripped`、`parsed`、`resolve`、`send` 兼容补丁 | 独立兼容层，但必须随插件 require 自动执行 |
| `lib/startup.js` | 如果阶段 A 未完全拆完，则继续收口 ready/dispose 生命周期 | 生命周期逻辑集中，便于检查资源关闭 |

约束：

1. 不能改成 `NODE_OPTIONS` 或 `node -r` 预加载。
2. 不能引入全局 Koishi binary 依赖。
3. 继续保持 `@satorijs/core@3.7.0` 兼容补丁在插件加载时自然生效。

验收要求：

1. `cascade-test.js` 中 index require 仍通过。
2. `npm run check && npm run test:quick && npm run test:scenario`。
3. 如涉及真实启动验证，必须确认 `adapter connect to server`，但部署/重启前必须先得到用户明确同意。

### 每个阶段的固定执行步骤

每拆一个模块，都按拆文件 5 步法执行：

1. 只创建目标文件，完整复制函数和状态，跑 `node -c`。
2. 源文件加 `require`，跑 `node -c`。
3. 注释旧定义，不删除，跑 `npm run test:quick` 验证 import 生效。
4. 测试通过后删除旧代码，再跑 `npm run test:quick`。
5. 更新 `package.json` 和 `cascade-test.js`，再跑 `npm run check && npm run test:quick`。

阶段收尾固定执行：

```bash
npm run check
npm run test:quick
npm run test:scenario
git diff --check
```

全部阶段完成后执行：

```bash
npm test
```

如果改动涉及真实外部链路，例如 Agent 搜索、TTS、浏览器、部署、NapCat，则测试绿不等于真实可用；必须补真实输入 smoke test。但部署、重启、推送必须先经过用户明确确认。

### 测试补充策略

原则：已有 scenario 能覆盖同一行为时，不新增测试，只保持通过；行为变化或边界外移时才补测试。

| 改动 | 测试策略 |
|------|----------|
| `runtime-settings.js` | 维护 `random.test.js` 和 command 中白名单/概率断言 |
| `channel-queue.js` | 优先加纯模块测试或在 `concurrency.test.js` 中覆盖队列行为 |
| `safe-send.js` | 维护 `send-guard.test.js`，必要时补连续 rate-limit 冻结和 dispose 清理 |
| `prompt-builder.js` | 维护 `persona-prompt.test.js`，避免全文快照，断言关键 marker 和 no-leak |
| `topic-switch.js` | 保持 per-key Promise 锁；如行为变化，补 chat scenario，不使用全局 fake timers |

### 一遍过验收标准

拆分完成后必须满足：

1. `index.js` 只做插件加载、生命周期、中间件编排，不再持有新增业务状态。
2. `chat.js` 仍是聊天主控，但 prompt、模式、话题切换、最终回复出口都有清晰模块归属。
3. 无任何新模块反向 import `index.js`。
4. 无未经解释的新 Map/Set/全局缓存留在 `index.js`、`chat.js`。
5. 所有新增模块进入 `package.json check` 和 `cascade-test.js`。
6. 关键场景测试覆盖仍然存在，`COVERAGE_MAP` 不指向缺失文件或失效 needle。
7. `npm test` 最终 summary 必须为 `failed: 0`；若有环境 skip，必须说明原因和未覆盖范围。

---

## 统计

- 已归档关闭：Phase 1-4 Dashboard/Server、安全审计已修复内容、延后项第一批、延后项第二批、语音克隆资产优化、handler 命令域拆分。
- 暂不执行：架构改进建议 A1。
- 后续拆分计划：chat/index 拆分治理方案仅保留未完成阶段。
- 已归档关闭：补充审计遗留小修与图片链路隐藏 bug。
- 需用户确认后处理：服务器部署/重启，让运行态吃到本地 CSP/nosniff 等安全 header 修复。

---

## 2026-05-20 继续补充审计：本地全量扫描 + 服务器只读真实模拟

### 执行边界

- 本轮没有部署、没有重启、没有 `git push`、没有 `git reset --hard`。
- 服务器只做 SSH 只读探测、短期 token 登录 Dashboard、GET/API smoke、无写入权限的 403 拦截验证，以及浏览器点击模拟。
- 本地只追加本报告；工作区已有未提交改动和构建产物变更均未回滚。

### 本地规则与批注扫描

- 已对照阅读 `AGENTS.md`、`AI协作规则.md`、`教训总结.md`、`测试文件维护指南.md` 的部署、测试四问、Dashboard、DATA_DIR、@satorijs/core 锁定、禁止未确认部署/推送等规则。
- `rg --files` 排除 `node_modules/dist/data/tmp` 后扫描到 288 个源码/文档文件；批注扫描重点覆盖 `TODO/FIXME/HACK/注意/警告/风险/必须/禁止/教训/批注`。
- 未发现新的生产模块反向 `require('./index')` 明显违例；`index.js` 顶部仍保留“禁止新增 Map/Set/全局缓存”的模块边界批注。
- 仍需维护的大文件风险：`cascade-test.js` 2004 行、AI `index.js` 1147 行、Dashboard `DeployPanel.vue` 1119 行、AI `handler.js` 976 行、AI `chat.js` 923 行、`agent-console/src/main.tsx` 917 行、`deploy-helpers.js` 808 行等。属于维护风险，不是本轮功能失败。
- 文档旧命令风险已修复并归档：`TESTING.md` / `部署教程.txt` 已收敛到 `/root/koishi-app/restart.sh` 或本地 `node_modules/koishi/bin.js` + 显式 `KOISHI_DIR` / `DONGXUELIAN_AI_DATA_DIR`。

### 本地验证结果

- `node -e "console.log(require('@satorijs/core/package.json').version)"`：本地为 `3.7.0`。
- `npm run check`：通过。当前 `package.json` 已用 `node --check --input-type=module < .../electron-deployer.js` 检查 ESM helper，避免了最初 `node -c` 检查 ESM `export` 的失败。
- `npm run test:quick`：`passed: 1487`，`failed: 0`，`skipped: 1`（Windows 缺少 bash/sh 的 setup simulation 路径）。
- `npm test`：通过，包含 quick + scenario + plugins。
- `npm run test:scenario` 在 `npm test` 中结果：`passed: 501`，`failed: 0`，`skipped: 2`（setup.sh simulation 需要 bash/sh）。
- 插件测试在 `npm test` 中通过：group-name-at 21/0、local-video-sender 28/0、daily-report 40/0、poke 8/0、group-leave-notice 9/0。
- `git diff --check`：退出码 0；仍提示 `App.vue`、`ConfigPanel.vue`、`KeyManager.vue`、`PersonaPanel.vue` 下次 Git 触碰时 LF 会转 CRLF。
- `npm test` 结束仍出现 `MaxListenersExceededWarning: 11 exit listeners added to [process]`，目前不影响通过，但建议后续定位是哪组测试/模块重复注册 exit listener。
- 前半段已跑过 `npm run build --prefix packages/koishi-plugin-dashboard/frontend` 与 `npm run build --prefix packages/agent-console`，均通过，仅有 Vite CJS deprecation warning；本次继续阶段未重复 build，避免继续扩大既有 `dist` 产物改动。

### 当前本地脏工作区观察

这些改动已存在于工作区，本轮只读取不回滚：

- Phase 4 Dashboard 安全相关改动已能在本地 dirty worktree 中看到：`auth.js` 使用安全比较、`standalone.js` 增加 CSP/nosniff、`napcat-proxy.js` 改用 header 传 token、`deploy-helpers.js` 增加 redirect/JSON/partial download 防线、`routes/deploy.js` 使用随机 task id、`query-logs.js` 对不安全正则降级为字面量、`cascade-test.js` 增加对应防线。
- 工作区仍有已有 `dist` 变更、`scripts/dashboard-click-smoke.js`、`tmp/dashboard-click-smoke-failure.png` 和若干未跟踪文档/计划文件；未在本轮清理，避免误删用户或其他 agent 的未提交内容。

### 服务器真实只读检查

服务器：`root@120.55.246.12`，目录 `/root/koishi-app`。

- 服务器工作区是 dirty 状态，存在 Dashboard 前后端、dist、data 迁移/软链、备份脚本等大量修改/未跟踪文件；因此当前不满足“部署前确认服务器没有未保存修改”的条件。
- 监听状态：Dashboard `0.0.0.0:5150`，Koishi `127.0.0.1:5140`，NapCat/QQ `*:6099`。
- 服务器 `@satorijs/core` 为 `3.7.0`。
- 服务器 data 软链确认：
  - `packages/koishi-plugin-dongxuelian-ai/data -> /root/koishi-app/data`
  - `packages/koishi-plugin-group-name-at/data -> /root/koishi-app/data`
  - `packages/koishi-plugin-local-video-sender/data -> /root/koishi-app/data`
- `/dashboard/` 返回 200 且 `Cache-Control: no-cache`，但真实运行中的服务器响应没有 `Content-Security-Policy` 和 `X-Content-Type-Options: nosniff`。这说明服务器运行态尚未体现本地 dirty worktree 中看到的安全 header 修复；本轮未部署，所以只记录差异。
- 未登录访问 `/dashboard/api/status` 和 `/dashboard/api/keys` 均返回 401 `AUTH_REQUIRED`，基础访问门禁生效。

### 服务器 API smoke

通过 SSH 隧道访问真实 Dashboard，并用服务器 `auth` 模块生成短期 token。未调用带管理员 token 的写接口。

- 普通 token GET 成功：`status`、`providers`、`config`、`personas`、`lore-list`、`modes`、`features`、`commands`、`bot/status`、`maintenance`、`throttle`、`logging`、`bot/activity?limit=5`、`gallery`、`deploy/config`、`deploy/npm-install-status`、`deploy/napcat-status`、`deploy/koishi-status`、`deploy/local-ready-check`、`env/check`、`frontend/rebuild-status`、`bot/local-status`、`keys/usage`、`tools`。
- 管理 token GET 成功：`keys`、`tools/pending`、`agent/config`、`agent/personas`、`agent/stats`、`agent/queue`、`agent/sessions`。
- 无管理员 token 的敏感写接口均被 403 拦截：`PUT /config`、`PUT /keys`、`POST /deploy/run`、`POST /bot/stop`、`POST /frontend/rebuild`。
- 前端封装不一致已修复并归档：`GET /dashboard/api/admin-ids` 需要管理员 token，`frontend/src/api.js` 里的 `fetchAdminIds()` 已改为 `get('/admin-ids', true)`。

### 服务器真实浏览器交互

使用 Puppeteer + Edge，经 SSH 隧道打开真实服务器 Dashboard 页面。

- 成功模拟 `我已部署，解锁`，解锁后侧栏显示完整功能。
- 成功打开主题面板并切到 `昼白`，页面 `data-theme` 变为 `light`。
- 逐个点击并验证 13 个入口均可进入/展示：`部署`、`终端控制`、`模型配置`、`API Keys`、`人格实验室`、`功能地图`、`指令速查`、`黑白名单`、`安全设置`、`Agent 控制台`、`日志中心`、`系统状态`、`莲莲图集`。
- `Agent 控制台` 点击后跳转 `/agent/`，符合当前 App 路由逻辑。
- 浏览器控制台无 error，页面运行时未捕获 `pageerror`，点击过程中未出现失败的 Dashboard API 响应。

### 测试四问

1. 复现了用户哪条真实失败输入？
   - 本地 scenario 覆盖了 `莲`、`你好`、自动路由时间问题、明确要求联网搜索、HTTP 正文抽取、工具调用后空回复、搜索失败回复、reasoning-only 回复等真实聊天输入/失败形态。
   - 服务器浏览器 smoke 覆盖了真实用户在 Dashboard 中登录后解锁、切主题、逐个进入所有侧栏功能页的点击路径。
2. 断言了哪个失败现象不会再出现？
   - 断言短输入不再返回 `(Agent 未获取到有效回复)`，reasoning 不泄露，普通聊天不误走 Agent，明确搜索时暴露并调用 `web_search`，搜索失败时不凭空编造，工具调用后空回复也有兜底。
   - 断言 Dashboard 页面基础导航、主题、日志、图集、Agent 跳转等入口不会白屏或前端报错；敏感写接口没有管理员 token 时被 403 拦截。
3. 哪些依赖被 mock 了？
   - 本地 scenario 使用 fake Koishi/session、mock HTTP/fetch/model 回复、临时 data 目录；插件测试也使用模拟上下文和临时文件。
   - 服务器 Dashboard smoke 没 mock 页面和后端 API，但用服务器 auth 模块生成短期 token，且没有输入真实密码。
4. 因为 mock，哪些真实链路仍未覆盖？
   - 未覆盖真实 QQ -> NapCat -> OneBot -> Koishi -> 群消息发送的生产传输链路。
   - 未覆盖真实生产模型、真实联网搜索结果质量、真实 TTS/ASR 外部服务扣费链路。
   - 未覆盖部署、重启、停止 Bot、重建前端、删除/卸载、保存配置/Key/白名单等会改变服务器状态的写操作。
   - Windows 本机部署器的真实本地安装路径仍只按“服务器 Linux 页面不可执行本地部署”处理；本轮将这类本地部署型 bug 按要求绕开。

### 结论

- 本地静态防线、场景测试、插件测试、服务器真实 Dashboard 只读 UI/API smoke 均通过。
- 当前阻止“直接部署/上线确认”的主要问题不是测试失败，而是服务器和本地工作区都存在大量未提交/未跟踪改动；按规则不能在未确认状态下部署、重启或覆盖。
- 建议后续优先处理服务器运行态对齐：让服务器吃到 CSP/nosniff 等本地安全修复；部署/重启前必须先确认服务器没有未保存修改并获得用户明确同意。

### 优化建议

- 把 Dashboard 运行态和本地 dirty worktree 的安全修复对齐一次，重点确认 CSP、`nosniff`、NapCat token 传输、redirect 限制这几项是否已真正进入服务器正在跑的版本。
- 针对 `npm test` 末尾的 `MaxListenersExceededWarning` 做一次定点排查，看看是不是测试桩、exit hook 或某个模块重复注册监听器，能尽早清掉就尽早清掉。
- 对超 350 行的大文件做维护级拆分规划，优先从 `DeployPanel.vue`、`cascade-test.js`、`handler.js`、`chat.js`、`deploy-helpers.js` 这几个最容易继续膨胀的点下手。
- 服务器和本地都已经确认 `@satorijs/core` 是 `3.7.0`，后续只要做依赖安装，就把版本校验和真实启动日志检查一起绑进流程，避免“装完能跑、重启就散”的回归。
- 如果后面要继续做真实 e2e，建议把“只读 smoke”和“会改状态的写入 smoke”分成两条链路跑，报告里也分开写，这样更容易判断是页面问题、鉴权问题，还是部署链路问题。

## 2026-05-20 追加隐藏 Bug 审计：Linux 服务器运行链路（已修复归档）

### 执行边界

- 本节两条 Linux 图片链路 bug 已本地修复并归档到 `PLANNNNNNNNNNN/2026-05-20-补充审计遗留与图片链路修复归档.md`。
- 本轮未部署、未重启、未推送。
- 用户已明确 Windows 本地部署问题暂不纳入，本节只记录 Linux 服务器运行会真实触发的问题。
- `npm run check` 与 `npm run test:quick` 只能说明当前测试入口可跑通；本节结论来自源码调用链和针对性复现，不把现有测试通过当作“无隐藏 bug”的证明。

### 已修复 Bug 1：图片缓存按前缀匹配会读错历史图片

位置：

- `packages/koishi-plugin-dongxuelian-ai/lib/image-store.js:199` 写入缓存文件名为 `${getSafeKey(messageId)}.${ext}`。
- `packages/koishi-plugin-dongxuelian-ai/lib/image-store.js:214` 到 `packages/koishi-plugin-dongxuelian-ai/lib/image-store.js:215` 读取时用 `startsWith(prefix)` 匹配。

确认依据：

- `messageId=m1` 的读取前缀是 `m1`，会匹配同目录下的 `m10.png`、`m100.jpg` 等文件。
- 已用临时 `DONGXUELIAN_AI_DATA_DIR` 复现：只缓存 `m10`，随后读取 `m1`，输出 `BUG_REPRO: m1 read m10 cache`。

Linux 服务器影响：

- 用户问“刚才那张图是什么”或 Agent 调 `analyze_historical_image` 时，可能拿到另一条消息的图片缓存。
- 后台图片分析也先走 `readCachedImage(channelKey, messageId)`，因此可能把错误图片的视觉分析写入 `image-history`，表现为模型对图片内容“认真但完全说错”。
- 这个问题与 Windows 文件名无关，Linux 服务器同样会触发；消息 ID 只要存在前缀关系即可。

修复记录：

- 读取缓存时已改为精确匹配 basename，只接受 `path.parse(file).name === getSafeKey(messageId)`。
- 已新增 cascade 回归：只保留 `m10` 缓存时，读取 `m1` 必须返回 `null`。

### 已修复 Bug 2：后台图片分析写回会话历史使用了错误 key

位置：

- `packages/koishi-plugin-dongxuelian-ai/lib/conversation.js:133` 普通聊天历史 key 是 `${guild/channel}::${user}`。
- `packages/koishi-plugin-dongxuelian-ai/lib/conversation.js:187` 到 `packages/koishi-plugin-dongxuelian-ai/lib/conversation.js:188` 保存聊天轮次时按 `getConversationKey(session)` 写入用户级会话。
- `packages/koishi-plugin-dongxuelian-ai/lib/image-store.js:270` 到 `packages/koishi-plugin-dongxuelian-ai/lib/image-store.js:275` 的 `replaceImagePlaceholder(channelKey, messageId, analysis)` 直接把 `convKey` 设成 `channelKey`。
- `packages/koishi-plugin-dongxuelian-ai/lib/image-analyzer.js:81` 和 `packages/koishi-plugin-dongxuelian-ai/lib/agent/tools/analyze-image.js:73` 都只传 `channelKey, messageId` 调用替换函数。

确认依据：

- 正常群聊图片消息进入时，`index.js` 用 `storeImageUrl(channelKey, session.messageId, ...)` 记录图片历史，并在文本里追加 `[图片]`。
- 最终聊天落盘由 `saveConversationTurn(session, currentUserMessage, finalReply)` 完成，写入的是用户级 `conversationKey`。
- 图片分析完成后，`replaceImagePlaceholder()` 却去读 `conversations/<channelKey>.json`，不是 `conversations/<channelKey>::<userId>.json`。
- 已用调用链小脚本确认：同一 session 的 `channelKey` 为 `linuxGuild`、`conversationKey` 为 `linuxGuild::linuxUser`，替换函数实际读取 key 只有 `linuxGuild`，结果为 `false`。

Linux 服务器影响：

- 后台视觉分析即使成功调用模型并 `markAnalyzed()`，也大概率无法把用户会话里的 `[图片]` 替换为 `[图片]: 分析结果`。
- 后续用户追问“刚才那张图”“图里写的什么”时，普通聊天历史仍只有裸 `[图片]`，模型拿不到已经分析出的图片摘要。
- 如果恰好存在 `conversations/<channelKey>.json` 这类旧文件，还可能把分析结果写到错误会话，造成跨用户/跨历史污染。
- 这不是 Windows 冒号文件名问题；在 Linux 上 `guild::user` 文件可以正常存在，但当前代码压根没有用这个 key。

修复记录：

- 图片历史记录中已保存 `conversationKey` / `userId`。
- `saveConversationTurn()` 已把用户消息 `messageId` 写入 conversation。
- `replaceImagePlaceholder()` 已按图片记录的 `conversationKey` 读取真实用户会话，并按 `messageId` 精确替换对应 `[图片]`。
- 已新增 cascade 回归：同一会话连续两条 `[图片]` 时，只替换目标 messageId 的占位符，不替换旧图片。

### 本轮排除项

- Windows 本地部署下 `guild::user` 会话文件名含冒号导致落盘失败：已在前序扫描中复现，但用户已明确“Windows 本地部署的 bug 先不管”，故本节不计入 Linux 服务器运行 bug。
