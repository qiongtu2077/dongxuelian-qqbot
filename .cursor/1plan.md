# standalone.js 模块化 — 完成状态 + 后续改进

## Phase 5 已完成 ✓

| 指标 | 数值 |
|------|------|
| standalone.js 原始行数 | 5182 行 |
| standalone.js 当前行数 | **159 行** |
| 精简率 | **97%** |
| 函数覆盖率 | 224 / 224 (100%) |
| API 路由覆盖 | 107 / 107 (100%) |
| 常量覆盖 | 完整 |
| 全量测试 | 零失败 |
| 提交 | `dc121a0` |

## 当前架构

```
standalone.js (159 行) — 薄入口
  ├── 全局异常兜底
  ├── MAX_STATIC_FILE_BYTES
  ├── HTTP server + CORS + OPTIONS
  ├── NapCat /webui/ 代理 (requireAdmin)
  ├── router.dispatch() → 所有 API 路由
  ├── 302 重定向 (/dashboard, /agent)
  ├── 静态文件服务 (serveStaticFile)
  ├── module.exports (isLoopbackAddress, isLocalAuthBypass, getRemoteAddress, KOISHI_PID_FILE)
  └── server.listen()

lib/ (20 文件, ~4500 行)
  ├── utils.js          — json/log/collectBody/readFileSyncSafe/writeFileSyncSafe/路径工具
  ├── paths.js          — 所有路径常量 + 环境配置
  ├── auth.js           — token/密码/rate-limit/requireAdmin
  ├── tools.js          — 端口检测/命令执行/Node路径
  ├── napcat.js         — NapCat 检测/配置/状态
  ├── napcat-proxy.js   — NapCat HTTP 反向代理
  ├── frontend.js       — 前端构建/dist 管理
  ├── logging.js        — 日志读取/过滤/缓存
  ├── deploy-state.js   — localTasks 状态/进程管理
  ├── deploy-helpers.js — 部署验证/远程命令/npm/下载/安装
  ├── deploy-uninstall.js — 卸载预览/清理/安全检查 (20 函数)
  ├── router.js         — 路由聚合 + authMiddleware + preAuth 分类
  └── routes/
       ├── auth.js      — 登录/验证/密码/重置 + authMiddleware
       ├── config.js    — AI 配置/Provider/Persona CRUD
       ├── settings.js  — 系统设置/Fallback/Debug/Features
       ├── bot.js       — Koishi 启停/维护/日志
       ├── agent.js     — Agent chat/files/env/sessions/confirm/plans
       ├── gallery.js   — 图集 CRUD/图片上传/样式
       └── deploy.js    — 本地/远程部署/npm/NapCat 启动
```

---

## 审计发现的改进点 (P1-P5)

### P1: deploy-uninstall.js 未接入路由（悬空模块）

**现状：** `lib/deploy-uninstall.js` 已创建 20 个卸载函数，但 `routes/deploy.js` 中的卸载端点仍是硬编码 stub：
```javascript
// routes/deploy.js 当前代码
function handleGetLocalUninstallPreview(req, res) {
  return json(res, { ok: true, message: '卸载预览暂不可用（请使用旧版 API）' })
}
function handlePostLocalUninstall(req, res) {
  return json(res, { ok: false, message: '卸载功能暂不可用（请使用旧版 API）' }, 400)
}
```

**修复方案：**
- `routes/deploy.js` 的两个 handler 改为 `require('../deploy-uninstall')` 调用真实逻辑
- `handleGetLocalUninstallPreview` → `buildLocalUninstallPreview()`
- `handlePostLocalUninstall` → `runLocalUninstall(body)`
- 需处理 async/error 和 requireAdmin

**风险：** 中。卸载是破坏性操作，需要测试覆盖。
**工作量：** ~30 行改动

---

### P2: NapCat 代理执行顺序变化

**现状：**
| | 旧代码 | 新代码 |
|--|--------|--------|
| NapCat `/webui/` | 在 router.dispatch 返回 false **之后** | 在 router.dispatch **之前** |

**影响分析：**
- 当前 router 无任何 `/webui/` 路由注册 → 行为等价
- NapCat 代理已有 `requireAdmin` 保护 → 安全性无变化
- 如果未来注册 `/webui/` 相关 API 路由 → 新代码会优先走 NapCat 代理

**修复方案（可选）：**
- 将 NapCat 代理逻辑移入 router.js 作为高优先级 prefix route
- 或在 standalone.js 中把 NapCat 代理移到 router.dispatch 之后
- 或保持现状（当前无冲突，记录此差异即可）

**风险：** 低。当前无实际影响。
**工作量：** ~15 行（如果修）

---

### P3: routes/agent.js 重复 getAgentEnvStatus

**现状：** `lib/routes/agent.js` 中有两份 `getAgentEnvStatus` 定义：
- 第一份在文件中部（被 route handler 调用）
- 第二份在文件末尾（Phase 5 补漏时追加，shadow 了第一个）

**修复方案：** 删除末尾的重复定义，保留中部的那份（是完整实现）

**风险：** 无。删除死代码。
**工作量：** ~20 行删除

---

### P4: resolveKoishiListenPort 重复实现

**现状：** 两份独立实现：
- `lib/routes/bot.js` — 本地定义，用于 bot 状态查询
- `lib/deploy-helpers.js` — 导出实现，用于部署/端口等待

两者逻辑相同（读 KOISHI_PORT 环境变量 → 读 koishi.yml → 默认 5140），但各自独立维护。

**修复方案：**
- 保留 `deploy-helpers.js` 中的实现（已有导出）
- `routes/bot.js` 改为 `const { resolveKoishiListenPort } = require('../deploy-helpers')`
- 删除 bot.js 中的本地实现

**风险：** 低。纯去重。
**工作量：** ~10 行

---

### P5: deploy-helpers ↔ deploy-state 循环依赖

**现状：**
```
deploy-helpers.js ──(eager)──→ deploy-state.js
deploy-state.js  ──(lazy)───→ deploy-helpers.js (inside waitKoishiPortFree)
```

Node.js 能正确处理（lazy require 在两个模块都加载完后才执行），但后续重构可能踩坑。

**修复方案：**
- 将 `resolveKoishiListenPort` 抽到独立模块 `lib/koishi-port.js`
- `deploy-state.waitKoishiPortFree` 从 `koishi-port.js` 导入（不再需要 deploy-helpers）
- `deploy-helpers.js` 也改从 `koishi-port.js` 导入
- 彻底消除循环

**风险：** 低。但改动影响面较大。
**工作量：** ~30 行

---

## 执行优先级

| 顺序 | 编号 | 内容 | 紧迫度 |
|------|------|------|--------|
| 1 | P3 | 删重复 getAgentEnvStatus | 最简单，立即可做 |
| 2 | P4 | 统一 resolveKoishiListenPort | 简单去重 |
| 3 | P1 | 接通 deploy-uninstall 到路由 | 功能补全 |
| 4 | P5 | 打破循环依赖 | 架构优化 |
| 5 | P2 | NapCat 代理顺序（决定是否修） | 可选 |

---

## 已完成里程碑

- [x] Phase 1-2: 基础 lib 模块创建 (utils/paths/auth/tools/frontend/napcat)
- [x] Phase 3: deploy-helpers + routes/deploy + logging + napcat-proxy + deploy-state
- [x] Phase 4: router.js 统一路由分发
- [x] Phase 5: standalone.js 瘦身 (5182→159 行) + deploy-uninstall.js + 补漏 + 测试通过
