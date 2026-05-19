# standalone.js 拆分进度

## 已完成

```
lib/ 共 15 文件
├── 基础模块: utils, paths, auth, tools, frontend, napcat = 115 导出
├── 路由模块: gallery, auth, config, agent, settings, bot = 82+ endpoint
├── 日志基础设施: logging.js ← NEW (normalizeLoggingConfig, readLoggingConfig, writeLoggingConfig, clampLogLimit, readLastLogItems, readLastLogLines, getFilteredLogEntries 等)
├── 反向代理: napcat-proxy.js ← NEW (napcatProxy)
└── 部署状态: deploy-state.js ← NEW (localTasks, rebuildStatus, npmDiagnosticsCache, spawnLocalTask, getTaskPublicStatus)
```

### 本轮完成事项

1. **lib/logging.js** — 提取日志基础设施（logEntryCache 缓存 + 11 个函数）
   - bot.js 中重复的 `normalizeLoggingConfig` / `readLoggingConfig` / `writeLoggingConfig` 已删除
   - bot.js 改为 `require('../logging')` 引入
   - `bot/activity` 路由已加入 bot.js

2. **lib/napcat-proxy.js** — 提取 NapCat WebUI 反向代理
   - `napcatProxy(req, res, targetPath, getStatusFn)` 第 4 参数可选传入状态诊断函数
   - 解耦了 `getLocalNapcatDeployStatus` 硬依赖

3. **lib/deploy-state.js** — 提取部署共享状态
   - `localTasks` 对象（npmInstall / napcat / koishi）
   - `rebuildStatus` getter/setter
   - `npmDiagnosticsCache` getter/setter
   - `appendLocalTaskLog` / `getTaskPublicStatus` / `spawnLocalTask` 核心函数

### 测试结果

全部测试通过（0 failures）。

---

## 待办（Phase 4 — 删除 standalone.js 冗余）

standalone.js 中仍保留着所有 deploy 路由处理器（~25 endpoint）。
这些路由依赖数十个 helper 函数互相调用，一次性拆出风险较高。

**推荐策略**：
1. 逐步让 standalone.js 中的 deploy 路由使用 `lib/deploy-state.js` 的导出（替换内部 localTasks / rebuildStatus）
2. 提取 deploy helper 函数（computeFingerprint, validateDeployTarget, buildLocalConfigPreview 等）到 deploy-state.js 或新建 deploy-helpers.js
3. 最终把 25 个路由处理器移入 `lib/routes/deploy.js`
4. 删除 standalone.js 中所有已迁移到 lib/ 的函数定义

**当前 standalone.js 行数**: ~5180 行（原始 4790 + 新 require 头部）
**已提取逻辑量**: ~500 行（logging + proxy + deploy-state）
**Phase 4 完成后预计**: standalone.js 可缩减至 ~3000 行以下
