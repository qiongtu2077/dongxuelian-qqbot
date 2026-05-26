# TypeScript 全面迁移方案（AI 挂机执行版）

日期：2026-05-27
状态：待启动
前置：Phase 1 目录分化已完成 ✓

---

## 0. 核心架构

```
迁移前：lib/*.js（源码 = 运行时，直接被 require）
迁移后：src/*.ts（源码）→ tsc 编译 → lib/*.js（产物，被 require）
```

**为什么这条路可行（已验证）：**

TypeScript 编译 `.ts` 文件时，如果源码使用 `const x = require('...')` + `module.exports = {...}` 语法（不用 ES module 的 import/export），编译产物与原始 JS **几乎完全一致**——只是去掉类型注解。这意味着：

- `main: lib/index.js` 不变
- 所有 `require('../../lib/xxx')` 不变（测试加载编译产物）
- 服务器 rsync `lib/` 不变
- cascade-test 的字符串断言仍然匹配（编译产物保留 `require()`、`module.exports`）
- 唯一差异：tsc 将函数体内缩进标准化为 4 空格

**关键决策：**

| 决策 | 选择 | 原因 |
|------|------|------|
| .ts 文件用什么模块语法 | `const x = require()` + `module.exports` | 编译产物与原 JS 一致，不引入 `__esModule` |
| lib/ 是否提交到 git | 是 | 部署不变，无需服务器构建 |
| 是否用 import/export 语法 | 否 | 会生成 `Object.defineProperty(exports, "__esModule"...)` 破坏兼容 |
| 是否引入 ts-node | 否 | 不改运行时 |
| 测试文件是否迁移 | 否 | test/ 保持 .js，require 编译产物 |

---

## 1. 硬约束

1. **不改变任何运行时行为** — 编译前后 `module.exports` 的键名、值、语义完全一致
2. **保持 CommonJS require/exports 语法** — .ts 文件内用 `const x = require()`，不用 `import x from`
3. **不引入新运行时依赖** — typescript 仅为 devDependency
4. **测试文件保持 .js** — test/ 目录不动
5. **不改 package.json 的 main 字段** — 入口始终是 `lib/index.js`
6. **lib/ 编译产物提交到 git** — 部署链路零改动
7. **遇到不确定的类型用 `// TODO-TYPE: <原因>` 标注，保持 `any`**
8. **每个批次完成后必须通过全部验证命令才能继续**
9. **不改变 require 路径** — src/ 内的相对路径与 lib/ 内完全一致

---

## 2. Phase 0：基础设施搭建

### 2.1 创建目录结构

```bash
cd packages/koishi-plugin-dongxuelian-ai
mkdir -p src
# 将 lib/ 的目录结构复制到 src/（不含文件）
for dir in core diagnostics lifecycle reply routing behavior behavior/expression \
           persona persona/skills media media/file media/image media/voice \
           message chat commands agent agent/tools agent/skills agent/plan \
           rulesets mcp; do
  mkdir -p "src/$dir"
done
```

### 2.2 创建 tsconfig.json

路径：`packages/koishi-plugin-dongxuelian-ai/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "moduleResolution": "node",
    "outDir": "lib",
    "rootDir": "src",
    "strict": false,
    "noEmit": false,
    "allowJs": false,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": false,
    "newLine": "lf",
    "types": ["node"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "test", "lib"]
}
```

**配置说明：**
- `outDir: "lib"` — 编译输出到 lib/，覆盖原文件
- `rootDir: "src"` — 源码根目录，保证输出路径结构一致
- `declaration: true` — 生成 .d.ts，供其他包获得类型提示
- `strict: false` — 初期不开严格模式，避免海量报错阻塞迁移
- `allowJs: false` — 强制所有 src/ 文件必须是 .ts（迁移完整性保证）

### 2.3 更新 package.json

`packages/koishi-plugin-dongxuelian-ai/package.json`:
```json
{
  "name": "koishi-plugin-dongxuelian-ai",
  "version": "1.1.6",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "build:watch": "tsc -p tsconfig.json --watch",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

### 2.4 在根 package.json 添加脚本

```json
"build:ai": "npm run build --prefix packages/koishi-plugin-dongxuelian-ai",
"typecheck": "npm run typecheck --prefix packages/koishi-plugin-dongxuelian-ai"
```

### 2.5 更新 .gitignore

在 `.gitignore` 中**不要**忽略 `packages/koishi-plugin-dongxuelian-ai/lib/`（保持现状，编译产物提交）。

但添加：
```
packages/koishi-plugin-dongxuelian-ai/lib/**/*.d.ts
packages/koishi-plugin-dongxuelian-ai/lib/**/*.d.ts.map
```

等等——如果 .d.ts 不提交，其他包就没有类型提示。决策：**也提交 .d.ts**，不加 gitignore。

### 2.6 验证 Phase 0

此时 src/ 为空，tsconfig 存在但无文件可编译。验证：
```bash
npm run test:quick    # 2565 pass（lib/ 未动）
npm run test:scenario # 1004 pass
```

---

## 3. Phase 1：逐批迁移（核心流程）

### 3.0 单文件迁移标准操作（AI 对每个文件重复）

```
输入：lib/<domain>/<name>.js
输出：src/<domain>/<name>.ts + lib/<domain>/<name>.js（编译产物）

步骤：
1. 读取 lib/<domain>/<name>.js 全部内容
2. 复制内容到 src/<domain>/<name>.ts
3. 在 .ts 文件中添加类型注解：
   a. 给所有 exported 函数的参数添加类型
   b. 给所有 exported 函数添加返回值类型
   c. 给模块级常量添加类型（如果不明显）
   d. 内部 helper 函数：参数加类型，返回值可省略（让 tsc 推断）
   e. 保持 require() 和 module.exports 语法不变
   f. 在文件顶部（'use strict' 之后）添加必要的类型声明：
      declare const require: NodeRequire
      // 仅当 tsc 报 require 未定义时才需要，通常 types:["node"] 已覆盖
4. 删除 lib/<domain>/<name>.js（将由 tsc 重新生成）
5. 运行 tsc 编译：npm run build:ai
6. 对比编译产物 lib/<domain>/<name>.js 与原文件的差异：
   - 允许的差异：类型注解被去掉、缩进变为 4 空格
   - 不允许的差异：require 路径变化、exports 键名变化、逻辑变化
7. 运行测试验证
```

### 3.1 类型注解规则

**参数类型推断表：**

| 线索 | 推断类型 |
|------|---------|
| 默认值 `= ''` 或 `= ""` | `string` |
| 默认值 `= 0` 或 `= 1` | `number` |
| 默认值 `= false` / `= true` | `boolean` |
| 默认值 `= {}` | 对应 interface 或 `Record<string, any>` |
| 默认值 `= []` | `any[]` 或从上下文推断 |
| 默认值 `= null` | `类型 \| null`，从使用处推断类型 |
| 参数名含 `session` / `sess` | `any`（koishi Session 类型复杂，标 TODO-TYPE） |
| 参数名含 `ctx` | `any`（koishi Context） |
| 参数名含 `bot` | `any`（koishi Bot） |
| 参数名含 `msg` / `message` / `messages` | `any` 或 `Array<{role:string,content:string}>` |
| 参数名含 `options` / `opts` / `config` | `Record<string, any>` 或具体 interface |
| 参数名含 `path` / `file` / `dir` | `string` |
| 参数名含 `id` / `userId` / `channelId` | `string` |
| 参数名含 `count` / `num` / `index` / `limit` | `number` |
| 参数名含 `flag` / `is` / `enable` / `force` | `boolean` |
| 参数名含 `fn` / `callback` / `handler` | `(...args: any[]) => any` |
| 参数名含 `re` / `regex` / `pattern` | `RegExp` |
| 函数返回 Promise（有 await 或 return Promise） | `Promise<具体类型>` |
| 函数返回 void（无 return 或 return 无值） | `void` |
| 无法推断 | `any` + `// TODO-TYPE: <原因>` |

**require 声明方式：**

```typescript
// 外部模块 — 直接 require，tsc 通过 @types 或 declare module 识别
const fs = require('fs')
const path = require('path')

// 内部模块 — 保持相对路径 require
const { PROVIDERS, DATA_DIR } = require('./constants')
const { requestChatCompletions } = require('./api')

// 如果需要引用内部模块的类型但不想 import：
// 在文件顶部用 JSDoc 或在同目录写 types.ts
```

**处理 lazy require（函数体内的 require）：**

```typescript
// 保持原样，不动。tsc 编译后 require() 原样保留
function someFunction(): any {
  const mod = require('./other-module')  // lazy require 保持不变
  return mod.doSomething()
}
```

### 3.2 处理缩进差异

tsc 输出使用 4 空格缩进。原代码使用 2 空格。这会导致 cascade-test 中检查缩进的断言失败。

**解决方案：** 在 tsconfig 同级创建 `.prettierrc` 或在编译后用 sed 统一缩进？不——更好的方案是：

**在 src/ 中就使用 4 空格缩进。** 这样 tsc 输出与源码缩进一致，cascade-test 断言不受影响（它们检查的是 `includes("require('...')")` 这类字符串，不依赖缩进）。

但如果有断言检查多行字符串含缩进... 实际检查发现 cascade-test 的 `.includes()` 断言都是单行字符串匹配，不含缩进。所以缩进变化不影响测试。

### 3.3 处理 cascade-test 源码读取

cascade-test 有 90 处 `read(path.join(LIB, ...))` 读取源码做字符串断言。迁移后：
- `lib/` 下是编译产物（require/module.exports 保留，只是去掉类型注解）
- 断言检查的是 `require('...')` 字符串 → 编译产物中仍然存在 ✓
- 断言检查的是函数名/变量名 → 编译产物中仍然存在 ✓

**结论：cascade-test 无需修改。** 它读取的 `lib/*.js` 现在是编译产物，但内容结构与原 JS 一致。

唯一例外：如果某个断言检查了类型注解相关的字符串（不太可能），需要单独处理。

### 3.4 tsconfig 的 allowJs 过渡策略

初始阶段 src/ 为空，所有文件仍在 lib/。随着迁移推进：
- 已迁移文件：src/<domain>/<name>.ts → 编译到 lib/<domain>/<name>.js
- 未迁移文件：仍在 lib/<domain>/<name>.js（手写源码）

**问题：** 已迁移的 .ts 文件 require 未迁移的文件时，路径 `require('./xxx')` 在 src/ 中找不到 ./xxx.ts。

**解决方案：** tsconfig 设置 `"paths"` 映射，或者更简单——**按目录整批迁移，同目录内所有文件一次性搬完。** 跨目录 require 用相对路径 `require('../other-domain/xxx')`，tsc 不检查 require 的目标是否存在（因为我们用的是 `const x = require()` 而非 `import x from`），所以不会报错。

**验证：** tsc 对 `const x = require('./xxx')` 不做路径解析（它把 require 当作普通函数调用），所以即使目标文件不在 src/ 中也不报错。类型会是 `any`，但这正是我们要的过渡行为。

---

## 4. 批次清单

### Batch 0: 基础设施（第 2 节）

### Batch 1: `rulesets/`（1 文件，最简单的热身）

| 文件 | 行数 | 说明 |
|------|------|------|
| jailbreak.js | ~80 | 纯正则常量导出，零依赖 |

**迁移后验证重点：** 确认 `JAILBREAK_INPUT_RE` 等正则导出类型正确。

### Batch 2: `core/`（9 文件，1882 行）

| 文件 | 行数 | 复杂度 | 说明 |
|------|------|--------|------|
| redactor.js | 26 | 低 | 1 个纯函数，零内部依赖 |
| onebot-endpoint.js | 30 | 低 | 端点解析 |
| user-blacklist.js | 31 | 低 | 读写文件 |
| frontmatter.js | 71 | 低 | 纯解析器 |
| logging-config.js | 97 | 中 | 配置加载 |
| runtime-config.js | 147 | 中 | 有缓存状态 + lazy require |
| constants.js | 173 | 中 | 大量常量，依赖 env + rulesets |
| utils.js | 643 | 中 | 纯函数为主，量大 |
| api.js | 664 | 高 | 网络请求，复杂参数签名 |

**迁移顺序：** 按上表从上到下（依赖关系：constants 依赖 rulesets/jailbreak，其余依赖 constants）。

**注意：** constants.js 有 `require('../rulesets/jailbreak')`，所以 Batch 1 必须先完成。

### Batch 3: `diagnostics/`（3 文件，270 行）

| 文件 | 行数 | 说明 |
|------|------|------|
| shared-record-text.js | ~50 | 文本格式化 |
| health-check.js | ~80 | 健康检查 |
| diagnostics.js | ~140 | 诊断聚合 |

### Batch 4: `lifecycle/`（6 文件，551 行）

| 文件 | 行数 | 说明 |
|------|------|------|
| session-compat.js | ~30 | Session 兼容补丁 |
| bot-resolver.js | ~60 | Bot 解析 |
| event-dump.js | ~70 | 事件转储 |
| startup-schedulers.js | ~100 | 启动调度 |
| channel-task-queue.js | ~130 | 频道任务队列 |
| plugin-lifecycle.js | ~160 | 插件生命周期 |

### Batch 5: `reply/`（5 文件，1067 行）

| 文件 | 行数 | 说明 |
|------|------|------|
| send-guard.js | ~60 | 发送守卫 |
| safe-send.js | ~80 | 安全发送 |
| reply-guard.js | ~150 | 回复守卫 |
| reply-timing.js | ~200 | 回复时机 |
| reply.js | ~580 | 回复主逻辑 |

### Batch 6: `routing/`（7 文件，1131 行）

### Batch 7: `behavior/`（16 文件，1999 行）

含子目录 `expression/`（4 文件）。先做顶层 12 文件，再做 expression/。

### Batch 8: `persona/`（9 文件，2116 行）

含子目录 `skills/`（2 文件）。

### Batch 9: `media/`（12 文件，2467 行）

三个子目录：`file/`（5）、`image/`（4）、`voice/`（3）。按子目录分 3 个子批次。

### Batch 10: `message/`（4 文件，778 行）

### Batch 11: `chat/`（12 文件，2285 行）

### Batch 12: `commands/`（7 文件，1042 行）

### Batch 13: `mcp/`（1 文件）

### Batch 14: `agent/`（64 文件，10337 行）

拆为 4 个子批次：
- 14a: `agent/` 顶层（23 文件，~5000 行）
- 14b: `agent/tools/`（30 文件，~3500 行）
- 14c: `agent/skills/`（6 文件，~800 行）
- 14d: `agent/plan/`（5 文件，~1000 行）

### Batch 15: 顶层入口（4 文件）

`index.js`（711 行）、`chat.js`、`handler.js`、`conversation.js` — 最后迁移，因为它们 require 所有子模块。

---

## 5. 单批次完整执行流程（AI 严格遵循）

```
对于 Batch N（目录 <domain>/，含文件 [f1, f2, ..., fn]）：

━━━ 步骤 1：搬迁文件 ━━━

对每个文件 fi：
  a. 读取 lib/<domain>/fi.js 的完整内容
  b. 将内容写入 src/<domain>/fi.ts（保持原样，暂不加类型）
  c. 确认 src/<domain>/fi.ts 存在且内容正确

━━━ 步骤 2：添加类型注解 ━━━

对每个 src/<domain>/fi.ts：
  a. 给所有 exported 函数添加参数类型和返回值类型
  b. 给模块级常量添加显式类型（如果推断不明显）
  c. 内部函数：参数加类型，返回值让 tsc 推断
  d. 对无法确定的类型标注 // TODO-TYPE
  e. 不改 require() 路径
  f. 不改 module.exports 结构
  g. 不改任何逻辑

━━━ 步骤 3：编译验证 ━━━

  npm run build:ai

  如果报错：
  - 类型错误 → 修复类型注解（不改逻辑）
  - 路径错误 → 不可能（require 不被检查）
  - 语法错误 → 修复 .ts 语法
  最多 5 轮修复，仍失败则停机

━━━ 步骤 4：产物对比 ━━━

  对每个文件，对比 lib/<domain>/fi.js（编译产物）与原始 JS：
  - 确认 module.exports 的所有键名存在
  - 确认 require() 调用路径不变
  - 确认函数名不变

  如果产物有意外差异（如多了 __esModule），说明用了 import/export 语法，
  必须改回 require/module.exports。

━━━ 步骤 5：删除原始 JS ━━━

  确认编译产物正确后，原始 lib/<domain>/fi.js 已被 tsc 输出覆盖。
  此时 lib/ 中的文件是编译产物。

━━━ 步骤 6：运行测试 ━━━

  npm run test:quick      # cascade-test
  npm run test:scenario   # 场景测试

  如果失败：
  - 分析失败原因
  - 如果是编译产物与原 JS 的差异导致 → 调整 .ts 源码使产物匹配
  - 如果是类型注解引入了逻辑变化 → 回退该文件，重新迁移
  - 最多 3 轮修复，仍失败则停机

━━━ 步骤 7：记录 ━━━

  在本文档末尾追加执行记录（格式见第 8 节）

━━━ 步骤 8：继续下一批 ━━━
```

---

## 6. 验证命令

```bash
# 编译（每个文件改动后）
npm run build:ai

# 类型检查（不输出，只检查）
npm run typecheck

# 运行时回归（每批必跑）
npm run test:quick       # cascade-test，期望 ≥2565 pass / 0 fail
npm run test:scenario    # 场景测试，期望 ≥1004 pass / 0 fail

# 跨包回归（每 3 个 batch 跑一次）
npm run test:plugins

# 全量验证（最终完成时）
npm test
```

---

## 7. 停机条件

以下任一情况出现时，停止执行并报告：

1. 单批次内 tsc 错误超过 30 个且 5 轮内无法收敛
2. 编译产物与原 JS 存在非缩进差异（说明语法选择错误）
3. 运行时测试出现非类型相关的失败
4. `// TODO-TYPE` 标注累计超过 50 处
5. 遇到 `module.exports = require('./xxx')` 透传模式无法类型化
6. 遇到动态 `module.exports[key] = value` 模式

---

## 8. 执行记录模板

```markdown
## 执行记录：YYYY-MM-DD Batch N — <domain>/

- 文件数：X（已迁移 / 本批总数）
- tsc 编译：0 errors
- TODO-TYPE 标注：X 处
- test:quick: XXXX pass / 0 fail
- test:scenario: XXXX pass / 0 fail
- 产物对比：通过（无非缩进差异）
- 备注：（如有特殊处理）
```

---

## 9. 回滚策略

```bash
# 单文件回滚（恢复手写 JS）
git checkout HEAD -- lib/<domain>/<name>.js
rm src/<domain>/<name>.ts

# 整批回滚
git checkout HEAD -- lib/<domain>/
rm -rf src/<domain>/

# 全量回滚（回到纯 JS 状态）
rm -rf src/
rm packages/koishi-plugin-dongxuelian-ai/tsconfig.json
git checkout HEAD -- lib/
git checkout HEAD -- packages/koishi-plugin-dongxuelian-ai/package.json
```

---

## 10. AI 挂机执行指令

当用户说「开始 TS 迁移」或「继续 TS 迁移」时：

1. 读取本文档，找到最后一条执行记录确定当前进度
2. 如果无执行记录 → 执行第 2 节（Phase 0 基础设施）
3. 确定下一个待执行 batch
4. 按第 5 节流程执行该 batch
5. 通过验证后追加执行记录
6. 继续下一个 batch，直到会话结束或遇到停机条件

**单次会话目标：** 尽可能多地完成 batch。小 batch（<5 文件）可以连续完成多个。大 batch（agent/ 64 文件）按子批次推进。

**跨会话恢复：** 读取执行记录最后一条 → 从下一个 batch 继续。无需额外上下文。

**编译产物提交：** 每完成一个 batch，将 src/ 新增文件和 lib/ 编译产物一起暂存。用户决定何时 commit。

---

## 11. 预期最终状态

```
packages/koishi-plugin-dongxuelian-ai/
├── package.json          # main: lib/index.js, types: lib/index.d.ts
├── tsconfig.json         # rootDir: src, outDir: lib
├── src/                  # 160 个 .ts 源文件（带类型注解）
│   ├── core/
│   ├── agent/
│   ├── ...
│   └── index.ts
├── lib/                  # 160 个 .js 编译产物 + .d.ts 声明
│   ├── core/
│   ├── agent/
│   ├── ...
│   └── index.js
└── test/                 # 保持 .js 不动
    ├── cascade-test.js
    └── scenarios/
```

**收益：**
- IDE 全量类型提示和跳转
- 编译期捕获参数类型错误
- .d.ts 供其他包（dashboard、daily-report、pet-bridge）获得类型安全
- 重构时 tsc 自动检测断裂引用
- 渐进开启 `strict: true` 的基础

---
