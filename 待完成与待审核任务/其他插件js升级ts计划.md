# 其他插件 JS 升级 TypeScript 计划

日期：2026-05-26
状态：待审核
前置依赖：无（这些插件独立于 AI 核心的 Phase 1 目录拆分，可并行推进）

## 0. 总览

本方案覆盖 `packages/` 下除 `koishi-plugin-dongxuelian-ai` 以外的所有插件包的 .js → .ts 全量转换。

| 插件 | 文件数 | 行数 | 复杂度 | 批次 |
|------|--------|------|--------|------|
| dongxuelian-poke | 1 | 35 | 简单 | 第 1 批 |
| group-leave-notice | 1 | 33 | 简单 | 第 1 批 |
| defense | 1 | 255 | 简单 | 第 1 批 |
| dongxuelian-help | 1 | 371 | 简单 | 第 1 批 |
| pet-bridge | 2 | 298 | 中等 | 第 3 批（依赖 AI 核心类型） |
| local-video-sender | 1 | 627 | 中等 | 第 2 批 |
| group-name-at | 1 | 1,008 | 中等 | 第 2 批 |
| daily-report | 11 | 1,767 | 复杂 | 第 3 批（依赖 AI 核心类型） |
| dashboard 后端 | 21 | ~6,400 | 复杂 | 第 4 批 |
| dashboard 前端 | 24 Vue | ~7,000 | 复杂 | 第 5 批 |
| agent-console | 已是 TS | — | — | 不需要 |

**总工作量：约 17,800 行，AI 执行约 12-14 小时，用户审核约 1-2 小时。**

## 1. 前提条件

1. 根 workspace 已有 `typescript ^5.7.0`（由 agent-console 引入），无需额外安装。
2. 每个插件包需要新建自己的 `tsconfig.json`。
3. 根 `package.json` 需要新增 `typecheck:plugins` 聚合脚本。
4. `@types/node` 已在 workspace 中可用。
5. 对于第 3 批（pet-bridge、daily-report），需要 AI 核心至少提供 `.d.ts` 类型声明或已完成 TS 迁移。如果 AI 核心尚未提供类型，这两个插件的跨包引用暂时使用 `require()` + 手动类型断言。

## 2. 通用工具链配置

### 2.1 每个插件包的 tsconfig.json 模板

```jsonc
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["ES2020"],
    "strict": true,
    "noImplicitAny": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "lib",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "test", "lib"]
}
```

### 2.2 目录结构变更

每个插件从：
```
packages/koishi-plugin-xxx/
├── lib/
│   └── index.js
├── package.json
└── test/ (如有)
```

变为：
```
packages/koishi-plugin-xxx/
├── src/
│   └── index.ts
├── lib/           (编译产物，gitignore)
│   ├── index.js
│   ├── index.d.ts
│   └── index.js.map
├── tsconfig.json
├── package.json
└── test/ (保持 .js 不动)
```

### 2.3 package.json 变更模板

```jsonc
{
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.7.0"
  }
}
```

### 2.4 根 package.json 新增脚本

```jsonc
{
  "scripts": {
    "build:plugins": "npm run build --workspace=packages/koishi-plugin-dongxuelian-poke --workspace=packages/koishi-plugin-group-leave-notice --workspace=packages/koishi-plugin-defense --workspace=packages/koishi-plugin-dongxuelian-help --workspace=packages/koishi-plugin-local-video-sender --workspace=packages/koishi-plugin-group-name-at --workspace=packages/koishi-plugin-pet-bridge --workspace=packages/koishi-plugin-daily-report --workspace=packages/koishi-plugin-dashboard",
    "typecheck:plugins": "npm run typecheck --workspace=packages/koishi-plugin-dongxuelian-poke --workspace=packages/koishi-plugin-group-leave-notice --workspace=packages/koishi-plugin-defense --workspace=packages/koishi-plugin-dongxuelian-help --workspace=packages/koishi-plugin-local-video-sender --workspace=packages/koishi-plugin-group-name-at --workspace=packages/koishi-plugin-pet-bridge --workspace=packages/koishi-plugin-daily-report --workspace=packages/koishi-plugin-dashboard"
  }
}
```

### 2.5 .gitignore 追加

每个插件包的 `lib/` 目录变为编译产物，需要在根 `.gitignore` 或各包 `.gitignore` 中追加：

```gitignore
# TS 编译产物（非 AI 核心插件）
packages/koishi-plugin-dongxuelian-poke/lib/
packages/koishi-plugin-group-leave-notice/lib/
packages/koishi-plugin-defense/lib/
packages/koishi-plugin-dongxuelian-help/lib/
packages/koishi-plugin-local-video-sender/lib/
packages/koishi-plugin-group-name-at/lib/
packages/koishi-plugin-pet-bridge/lib/
packages/koishi-plugin-daily-report/lib/
packages/koishi-plugin-dashboard/lib/
```

注意：AI 核心插件（dongxuelian-ai）的 `lib/` 仍然是源码目录，不能 gitignore。

## 3. AI 自动执行流程

### 3.1 每个插件的执行步骤

对每个插件，AI 严格按以下顺序执行：

1. 读取该插件的 `package.json` 和所有 `.js` 源文件。
2. 创建 `src/` 目录。
3. 将 `lib/*.js` 复制到 `src/*.ts`，保留目录结构。
4. 逐文件转换：
   - 将 `require()` 改为 `import` 语法（保持 CommonJS 编译输出）。
   - 将 `module.exports` / `exports.xxx` 改为 `export` 语法。
   - 为所有函数参数添加类型注解。
   - 为所有函数返回值添加类型注解。
   - 为模块级变量添加类型注解。
   - 为 Koishi 的 `ctx` 参数使用 `import { Context } from 'koishi'`。
   - 为 Koishi 的 `session` 参数使用 `import { Session } from 'koishi'`。
   - 对无法确定的类型，标注 `// TODO-TYPE: 需用户确认` 并记录原因。
5. 创建 `tsconfig.json`（使用第 2.1 节模板）。
6. 更新 `package.json`（添加 scripts、types 字段、devDependencies）。
7. 运行 `tsc --noEmit` 确保零编译错误。
8. 运行 `tsc` 生成 `lib/` 编译产物。
9. 如果该插件有测试文件，运行测试确认行为不变。
10. 删除旧的 `lib/*.js` 源文件（已被 `src/*.ts` 替代，`lib/` 现在是编译产物）。

### 3.2 不确定类型的处理规则

- 如果从代码上下文能推断出类型（调用方、返回值使用方式、条件判断），直接标注具体类型。
- 如果参数来自外部 API 回调且无 .d.ts 可参考，使用 `unknown` 并在使用处做类型守卫。
- 如果是跨包引用 AI 核心的内部模块且无类型声明，使用 `any` 并标注 `// TODO-TYPE: 等待 AI 核心提供类型声明`。
- 绝不使用隐式 `any`（tsconfig 开启了 `noImplicitAny`）。
- 对于 Koishi 框架类型，直接使用 `koishi` 包导出的类型（Context, Session, Command 等）。

### 3.3 完成后输出

全部插件转换完成后，AI 输出一份待确认清单：

```
插件名 | 文件:行号 | 当前标注 | 不确定原因 | 建议选项
-------|-----------|----------|------------|--------
defense | src/index.ts:45 | patterns: RegExp[] | 可能需要更具体的 tuple type | 保持 RegExp[] 或改为 readonly [...]
...
```

### 3.4 用户审核要点

- 检查函数签名是否与实际调用匹配。
- 检查 `any` 是否合理（应尽量少）。
- 检查 `// TODO-TYPE` 标注是否需要补充业务约束。
- 运行 `npm run build:plugins` 确认全部编译通过。
- 运行 `npm run test:plugins` 确认行为不变。

## 4. 第 1 批：简单插件（4 个）

### 4.1 koishi-plugin-dongxuelian-poke

**源文件：** 1 个（`lib/index.js`，35 行）
**状态/定时器：** 无
**外部依赖：** 无
**跨包引用：** 无

**类型要点：**
- `exports.apply` → `export function apply(ctx: Context): void`
- `pokeBack(session, ctx)` → `async function pokeBack(session: Session, ctx: Context): Promise<void>`
- `session.bot.internal._request` 是 NapCat 私有 API，参数类型用 `string` + `Record<string, unknown>`

**预期产出：**
```typescript
import { Context, Session } from 'koishi'

export const name = 'dongxuelian-poke'

async function pokeBack(session: Session, ctx: Context): Promise<void> {
  // ...
}

export function apply(ctx: Context): void {
  ctx.on('notice', async (session) => {
    // ...
  })
}
```

### 4.2 koishi-plugin-group-leave-notice

**源文件：** 1 个（`lib/index.js`，33 行）
**状态/定时器：** 无
**外部依赖：** 无
**跨包引用：** 无

**类型要点：**
- `getGuildId(session)` → `function getGuildId(session: Session): string | undefined`
- `getUserId(session)` → `function getUserId(session: Session): string | undefined`
- `sendLeaveNotice(session)` → `async function sendLeaveNotice(session: Session): Promise<void>`

### 4.3 koishi-plugin-defense

**源文件：** 1 个（`lib/index.js`，255 行）
**状态/定时器：** 无
**外部依赖：** 无
**跨包引用：** 无

**类型要点：**
- `AT_PATTERNS: RegExp[]`
- `RESERVED_PREFIXES: string[]`
- `attackPatterns: Array<{ name: string; patterns: RegExp[]; response: () => string }>`
- `exports.promptDefense: string` — 静态字符串
- `exports.promptDefenseAbusive: string` — 静态字符串
- middleware 的 `next` 参数：`import { Next } from 'koishi'`

**注意事项：**
- `attackPatterns` 数组中每个 `response()` 是从候选数组随机选取，返回 `string`。
- 需要定义 `interface AttackPattern { name: string; patterns: RegExp[]; response: () => string }`。

### 4.4 koishi-plugin-dongxuelian-help

**源文件：** 1 个（`lib/index.js`，371 行）
**状态/定时器：** 无
**外部依赖：** 无
**跨包引用：** 无

**类型要点：**
- `PROVIDERS` 对象需要定义接口：
  ```typescript
  interface ModelInfo { id: string; name: string }
  interface ProviderInfo { name: string; baseURL: string; models: ModelInfo[] }
  const PROVIDERS: Record<string, ProviderInfo>
  ```
- `normalizeText(text: string): string`
- `stripMentions(text: string): string`
- middleware 匹配逻辑全是字符串比较，类型简单。

## 5. 第 2 批：中等独立插件（2 个）

### 5.1 koishi-plugin-local-video-sender

**源文件：** 1 个（`lib/index.js`，627 行）
**状态/定时器：** `recentParseHistory: Map<string, number[]>`，`videoBlacklistCache`
**外部依赖：** `child_process`（execFile）、`fs`、`path`、`url`
**跨包引用：** 无

**类型要点：**
- 需要定义：
  ```typescript
  interface VideoBlacklistCache {
    fingerprint: string
    groups: Set<string>
    users: Set<string>
  }
  interface RuntimeConfig {
    workdir: string
    maxSize: number
    ytdlp: string
    cookies: string
  }
  ```
- `run(file, args, options)` → `function run(file: string, args: string[], options?: ExecFileOptions): Promise<{ stdout: string; stderr: string }>`
- `extractBiliUrl(text: string): string | null`
- `buildBiliKeys(url: string): { bvid: string; p: number }`
- `pickFormat(formats: unknown[]): unknown` — 需要从 yt-dlp JSON 输出推断 format 结构
- `downloadAndSend(session, url, config)` — session 是 Koishi Session
- `isRecentDuplicateParse(key: string): boolean`
- `rememberRecentParse(key: string): void`

**注意事项：**
- `execFile` 回调需要用 `child_process` 的类型。
- yt-dlp 的 JSON 输出结构没有现成 .d.ts，format 对象用 interface 手动定义。
- `recentParseHistory` 的 value 是时间戳数组。

### 5.2 koishi-plugin-group-name-at

**源文件：** 1 个（`lib/index.js`，1008 行）
**状态/定时器：** `pendingConfirms: Map`（60s 超时）、文件持久化
**外部依赖：** `fs/promises`、`path`
**跨包引用：** 无

**类型要点：**
- 需要定义：
  ```typescript
  interface NicknameEntry {
    userId: string
    nicknames: string[]
    addedBy: string
    addedAt: number
  }
  interface PendingConfirm {
    action: string
    data: unknown
    timer: ReturnType<typeof setTimeout>
    createdAt: number
  }
  ```
- `CMD: Record<string, string>` — 命令名映射
- `TEXT: Record<string, string | ((...args: unknown[]) => string)>` — 消息模板，部分是函数
- `pendingConfirms: Map<string, PendingConfirm>`
- 文件读写函数需要标注 `Promise<void>` / `Promise<T>` 返回值。
- `_test` 导出用于测试，类型可以宽松。

**注意事项：**
- 这是最大的单文件插件，建议转换时拆成多个 .ts 文件（`commands.ts`、`storage.ts`、`types.ts`、`index.ts`）。
- 如果拆文件，旧的 `lib/index.js` 编译产物仍然是单入口（由 tsconfig 的 outDir 保证）。
- `TEXT` 对象中有些值是模板函数 `(name) => \`...\``，需要精确标注。

## 6. 第 3 批：跨包依赖插件（2 个）

### 6.1 koishi-plugin-pet-bridge

**源文件：** 2 个（`lib/index.js` 57 行 + `lib/protocol.js` 241 行）
**状态/定时器：** WebSocket 服务器实例、`closed` 标志
**外部依赖：** `ws`（WebSocket）
**跨包引用：** 大量引用 `koishi-plugin-dongxuelian-ai` 内部模块

**跨包引用清单：**
- `../../koishi-plugin-dongxuelian-ai/lib/core/runtime-config` → `loadConfig`, `resetConfigCache`, `getThinkingEnabled`, `setThinkingEnabled`
- `../../koishi-plugin-dongxuelian-ai/lib/api` → `requestChatCompletions`
- `../../koishi-plugin-dongxuelian-ai/lib/persona` → `getAvailablePersonals`, `loadPersonalSkill`, `setUserPersona`, `getUserPersona`
- `../../koishi-plugin-dongxuelian-ai/lib/conversation` → `getMemorySummary`
- `../../koishi-plugin-dongxuelian-ai/lib/core/onebot-endpoint` → `resolveOneBotWsUrl`
- `../../koishi-plugin-dongxuelian-ai/lib/constants` → 各种 `*_FILE` 常量

**类型要点：**
- 需要为 `ws` 添加 `@types/ws` 到 devDependencies。
- 跨包引用的类型处理策略：
  - 如果 AI 核心已有 .d.ts → 直接 import type
  - 如果 AI 核心尚无类型 → 在 `src/ai-plugin-types.d.ts` 中手动声明需要的接口，标注 `// TODO-TYPE: 等待 AI 核心提供正式类型`
- `callOneBot(action: string, params: Record<string, unknown>): Promise<unknown>`
- WebSocket 消息处理需要定义 protocol message 接口。

**建议拆分：**
```
src/
├── index.ts        (WS 服务器生命周期)
├── protocol.ts     (消息处理逻辑)
└── ai-plugin-types.d.ts  (AI 核心临时类型声明)
```

### 6.2 koishi-plugin-daily-report

**源文件：** 11 个（index + config + 4 核心模块 + 4 analyzers + analyzers/index）
**状态/定时器：** cooldown Map、failureBackoff Map、inFlightReports Map
**外部依赖：** `fs`、`path`、`child_process`（Chromium 截图）
**跨包引用：** `koishi-plugin-dongxuelian-ai/lib/conversation`、`koishi-plugin-dongxuelian-ai/lib/constants`

**跨包引用清单：**
- `../../koishi-plugin-dongxuelian-ai/lib/conversation` → `flushTodayCacheToDisk`
- `../../koishi-plugin-dongxuelian-ai/lib/constants` → `DATA_DIR`

**类型要点：**
- 已有多文件结构，直接对应转换即可。
- 需要定义：
  ```typescript
  interface ReportConfig {
    dataDir: string
    timeouts: { cooldown: number; backoff: number; generation: number }
    forceTemplate: string
  }
  interface ChatMessage {
    userId: string
    userName: string
    content: string
    timestamp: number
    guildId: string
  }
  interface AnalysisResult {
    title: string
    content: string
    highlights?: string[]
  }
  ```
- `cooldown: Map<string, number>`
- `failureBackoff: Map<string, number>`
- `inFlightReports: Map<string, Promise<void>>`
- AI analyzer 调用返回 `Promise<string>`。
- HTML renderer 返回 `Promise<Buffer>`（PNG 图片）。

**建议目录结构：**
```
src/
├── index.ts
├── config.ts
├── data-collector.ts
├── html-renderer.ts
├── ai-analyzer.ts
├── models.ts
├── types.ts              (共享类型定义)
├── ai-plugin-types.d.ts  (AI 核心临时类型声明)
└── analyzers/
    ├── index.ts
    ├── chat-quality-analyzer.ts
    ├── golden-quote-analyzer.ts
    ├── topic-analyzer.ts
    └── user-title-analyzer.ts
```

## 7. 第 4 批：Dashboard 后端

### 7.1 koishi-plugin-dashboard（后端）

**源文件：** 21 个（index.js + standalone.js + 12 lib 文件 + 7 routes 文件）
**状态/定时器：** 部署任务状态、PID 文件、auth token 缓存
**外部依赖：** `bcryptjs`、`http`、`https`、`crypto`、`child_process`、`fs`、`path`、`ws`
**跨包引用：** 无

**架构特殊性：**
- Koishi 插件入口（`index.js`）只是一个 stub，实际功能在 `standalone.js` 独立进程中运行。
- 需要决策：是否统一为单一 Koishi 插件架构，还是保持 stub + standalone 分离。
- **建议：保持现有架构不变**，只做语言转换，不改运行模式。

**类型要点：**
- 需要 `@types/bcryptjs`、`@types/ws` 到 devDependencies。
- HTTP 路由需要定义 request/response 接口。
- auth 模块需要定义：
  ```typescript
  interface AuthConfig {
    passwordHash: string
    tokenSecret: string
    tokenExpiry: number
  }
  interface AuthToken {
    userId: string
    issuedAt: number
    expiresAt: number
  }
  ```
- deploy 模块需要定义：
  ```typescript
  interface DeployTask {
    id: string
    status: 'pending' | 'running' | 'success' | 'failed'
    startedAt: number
    completedAt?: number
    logs: string[]
  }
  ```
- NapCat proxy 需要定义 WebSocket 消息类型。
- 路由文件统一使用 `(req: IncomingMessage, res: ServerResponse) => void` 或自定义 router 类型。

**建议目录结构：**
```
src/
├── index.ts           (Koishi 插件 stub)
├── standalone.ts      (独立进程入口)
├── types.ts           (共享类型)
├── lib/
│   ├── auth.ts
│   ├── deploy-helpers.ts
│   ├── deploy-state.ts
│   ├── deploy-uninstall.ts
│   ├── frontend.ts
│   ├── logging.ts
│   ├── napcat-proxy.ts
│   ├── napcat.ts
│   ├── paths.ts
│   ├── router.ts
│   ├── tools.ts
│   └── utils.ts
└── routes/
    ├── agent.ts
    ├── auth.ts
    ├── bot.ts
    ├── config.ts
    ├── deploy.ts
    ├── gallery.ts
    └── settings.ts
```

**注意事项：**
- `standalone.js` 是独立进程，不经过 Koishi 加载，需要单独的入口点配置。
- `tsconfig.json` 的 `outDir` 需要保证 `standalone.js` 编译后仍在正确位置。
- 部署脚本中如果有 `node standalone.js` 的引用，需要改为 `node lib/standalone.js` 或保持路径兼容。

## 8. 第 5 批：Dashboard 前端（Vue）

### 8.1 koishi-plugin-dashboard/frontend

**源文件：** 24 个（21 Vue 组件 + 3 JS 工具文件 + vite.config.js）
**框架：** Vue 3 + Vite
**外部依赖：** `vue`、`@vitejs/plugin-vue`、`vite`

**类型要点：**
- Vue 组件从 `.vue` 改为 `<script setup lang="ts">`，文件本身保持 `.vue` 后缀。
- JS 工具文件改为 `.ts`。
- `vite.config.js` → `vite.config.ts`。
- 需要在 frontend 的 `tsconfig.json` 中配置 Vue 支持：
  ```jsonc
  {
    "compilerOptions": {
      "target": "ESNext",
      "module": "ESNext",
      "moduleResolution": "bundler",
      "jsx": "preserve",
      "strict": true,
      "noImplicitAny": true,
      "esModuleInterop": true,
      "skipLibCheck": true,
      "types": ["vite/client"]
    },
    "include": ["src/**/*", "src/**/*.vue"],
    "exclude": ["node_modules"]
  }
  ```
- 需要添加 `vue-tsc` 到 devDependencies 用于类型检查。
- 组件 props 使用 `defineProps<{ ... }>()` 语法。
- 组件 emits 使用 `defineEmits<{ ... }>()` 语法。
- API 调用的响应类型需要定义接口。

**建议 frontend/package.json 变更：**
```jsonc
{
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc --noEmit && vite build",
    "typecheck": "vue-tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vue-tsc": "^2.0.0"
  }
}
```

**注意事项：**
- Vue 组件的 TS 迁移不需要改文件后缀，只需要在 `<script>` 标签加 `lang="ts"`。
- 前端和后端是独立的编译单元，各有自己的 tsconfig。
- 前端构建产物（dist/）已经被 gitignore，不受影响。

## 9. 验证矩阵

### 9.1 每批完成后

```bash
# 编译检查
npm run build:plugins

# 类型检查
npm run typecheck:plugins

# 行为测试
npm run test:plugins

# 如果改了 dashboard
node packages/koishi-plugin-dashboard/lib/standalone.js --help
```

### 9.2 全部完成后

```bash
# 全量编译
npm run build:plugins

# 全量类型检查
npm run typecheck:plugins

# 全量测试
npm run test:plugins

# AI 核心测试不受影响
npm run test:quick
npm run test:scenario

# 语法检查（需要更新 check 脚本以支持 .ts）
npm run check
```

## 10. 停机条件

出现以下情况必须暂停并报告：

1. `tsc` 编译错误无法通过添加类型解决（需要改业务逻辑）。
2. 测试失败且原因不是类型转换引入的（说明发现了既有 bug）。
3. 跨包引用的 AI 核心模块接口不稳定（正在被 Phase 1 搬迁）。
4. 需要安装新的 npm 包但不确定是否合适。
5. 单个文件的 `// TODO-TYPE` 标注超过 10 处（说明该文件可能需要重新设计接口）。

## 11. 不允许

- 借 TS 迁移改变任何运行时行为。
- 引入新的运行时依赖（`@types/*` 等 devDependencies 除外）。
- 改动测试文件的语言或框架（测试保持 .js）。
- 改变插件的对外接口（exports 的函数名、参数个数）。
- 删除 `_test` 导出（测试需要）。
- 对 AI 核心插件做任何改动。
- 改变 dashboard 的 standalone 架构模式。
- 对标注为 `// TODO-TYPE` 的地方自行猜测并使用具体类型，必须保持 `any` 或 `unknown` 等待用户确认。

## 12. 执行顺序与依赖关系

```
第 1 批（无依赖，可立即开始）
├── dongxuelian-poke
├── group-leave-notice
├── defense
└── dongxuelian-help

第 2 批（无依赖，第 1 批完成后开始）
├── local-video-sender
└── group-name-at

第 3 批（依赖 AI 核心类型声明）
├── pet-bridge
└── daily-report

第 4 批（独立，可与第 2-3 批并行）
└── dashboard 后端

第 5 批（依赖第 4 批的后端类型）
└── dashboard 前端
```

**并行策略：** 第 1 批的 4 个插件可以完全并行转换。第 4 批（dashboard 后端）与第 2-3 批无依赖，可以并行。

## 13. 执行记录模板

每完成一个插件，追加记录：

```md
### 执行记录：YYYY-MM-DD 插件名

- 源文件数：
- 新增类型定义数：
- TODO-TYPE 标注数：
- tsc --noEmit：通过/失败
- 测试：通过/失败/无测试
- 特殊处理：
- 下一个：
```
