# 当前任务：日报图片生成失败排查

## 问题诊断

**症状**：群聊详细日报的图片总是生成失败
**错误日志**：
```
[E] daily-report 详细日报生成失败: available memory is too low for Chromium render (683MB < 900MB)
```

**根因**：服务器可用内存（MemAvailable 664MB）低于 Puppeteer/Chromium 渲染最低阈值（900MB）

**服务器情况**：
- 总内存：1608MB（1.6GB）
- 已用：764MB
- 可用（含 buffer/cache）：664MB
- Swap：0（完全没有 swap）

**阈值配置**：`html-renderer.js` 第 18 行
```javascript
const RENDER_MIN_AVAILABLE_MB = parsePositiveInt(process.env.DAILY_REPORT_MIN_MEM_MB, 900, 256, 8192)
```

---

## Swap 技术说明

### 是什么

Swap（交换空间）是用硬盘空间模拟内存的技术。当物理内存不够时，Linux 把不活跃的内存页写到硬盘上的 swap 分区/文件，腾出物理 RAM 给需要它的进程。

### 能做到什么

- 让 `MemAvailable` 值增大（因为可以随时把不活跃页交换出去）
- 让系统在内存紧张时不会直接 OOM-kill 进程
- 允许短时间的内存峰值超过物理内存

### 优劣

| 优势 | 劣势 |
|------|------|
| 不花钱、立即可做 | 硬盘比内存慢 100-1000 倍 |
| 系统稳定性增加，不容易 OOM | 如果频繁 swap-in/swap-out（thrashing）会卡顿 |
| 只需一条命令，不改代码 | SSD 频繁写入可能减少寿命（云服务器不在乎） |
| 可随时调整大小/删除 | 不能替代真正的物理内存 |

**云服务器场景下几乎全是优势**：阿里云磁盘 IO 性能不错，且对日报渲染这种"短时间峰值用一下"的场景非常合适。

---

## 所有可行方案

### 方案 A：加 Swap（推荐 ★★★★★）

创建 2GB swap 文件：
```bash
dd if=/dev/zero of=/swapfile bs=1M count=2048
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab  # 重启自动挂载
```

**效果**：MemAvailable 会从 664MB 增到 ~2600MB，远超 900MB 阈值
**代价**：硬盘多占 2GB 空间
**风险**：几乎无
**是否改代码**：不改

### 方案 B：降低内存阈值（★★★☆☆）

设置环境变量：
```bash
export DAILY_REPORT_MIN_MEM_MB=500
```
或者直接修改代码把默认值从 900 改为 500。

**效果**：允许在 500MB 可用时渲染。目前 664MB > 500MB，可以通过
**代价**：无
**风险**：如果某次渲染时可用内存恰好低于 500MB（比如其他进程突增），Chromium 可能被 OOM-kill，导致渲染异常
**是否改代码**：改 env 或代码

### 方案 C：强制跳过内存检查（★★☆☆☆）

```bash
export DAILY_REPORT_RENDER_FORCE=1
```

**效果**：无论剩多少内存都尝试渲染
**代价**：无
**风险**：高——如果真的 OOM，Linux 会杀掉占内存最多的进程（可能是 koishi worker 或 NapCat），整个 Bot 会挂
**是否改代码**：不改

### 方案 D：清理多余进程释放内存（★★★☆☆）

服务器有 3 个 Xvfb 实例（3 × 27MB ≈ 80MB），可能只需要 1 个：
```bash
kill <多余的 Xvfb PID>
```

**效果**：释放 ~60MB，不能从根本解决（664 + 60 = 724MB，仍 < 900）
**代价**：如果某个 Xvfb 正在被用会出问题
**风险**：中
**是否改代码**：不改

### 方案 E：升级服务器配置（★★★★☆ 但花钱）

阿里云 1.6GB → 2GB 或 4GB

**效果**：彻底解决
**代价**：每月多花 20-50 元
**风险**：无
**是否改代码**：不改

### 方案 F：优化渲染器，减少 Chromium 内存使用（★★☆☆☆）

在 Puppeteer 启动参数里加更多限制：
```javascript
args: ['--single-process', '--disable-extensions', '--js-flags=--max-old-space-size=128']
```

**效果**：可能降低 Chromium 峰值内存 50-100MB
**代价**：可能影响渲染稳定性
**风险**：中（single-process 模式有已知问题）
**是否改代码**：改

---

## 推荐执行顺序

| 顺序 | 方案 | 操作 | 紧迫度 |
|------|------|------|--------|
| 1 | A（加 Swap） | SSH 执行 4 条命令 | **立即做，根本解决** |
| 2 | D（清 Xvfb） | kill 多余的 2 个 | 顺手做 |
| 3 | B（降阈值） | 改 env 为 600 | 做了 A 后不需要 |

方案 A 做完后，问题就彻底解决了。

---

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

## Phase 6（待定）: GET 端点鉴权加固

### 背景

Dashboard 双层认证：
- **Access token**（访问密码登录后颁发）— 所有 `/dashboard/api/*` GET 默认只需此 token
- **Admin token**（管理员密码验证后颁发）— POST/PUT/DELETE 等写操作要求

设计意图是"登录就能看，改东西才要管理员"。但以下 8 个 GET 端点返回敏感数据，
仅 Access token 保护不足。

### 风险等级说明

- **单人使用场景**（只有你自己知道访问密码）：基本无风险
- **多人共享场景**（多人知道访问密码，部分人不应看到运维信息）：存在信息泄露风险

### 待加固端点

| # | 端点 | 返回内容 | 风险 |
|---|------|----------|------|
| 1 | `GET /api/qq/ssh-info` | SSH host / user / port | 服务器连接信息泄露 |
| 2 | `GET /api/keys` | key 前 8 字符指纹 | API 密钥类型推断 |
| 3 | `GET /api/whitelist` | 群白/黑名单完整列表 | 安全策略泄露 |
| 4 | `GET /api/admin-ids` | 管理员 QQ 号列表 | 管理员身份暴露 |
| 5 | `GET /api/providers/custom` | 自定义供应商 URL | 代理/中转地址泄露 |
| 6 | `GET /api/deploy/config` | 远程服务器 IP + 应用目录 | 基础设施信息泄露 |
| 7 | `GET /api/env/check` | 本机 hostname / 项目路径 / 端口 | 环境全貌泄露 |
| 8 | `GET /api/napcat/status` | 进程命令行 / QQ 路径 | 可执行文件路径暴露 |

### 修改方案

每个 handler 函数开头加一行：
```javascript
if (!requireAdmin(req, res)) return
```

涉及文件：
- `lib/routes/bot.js`：#1 `handleGetSshInfo`, #8 `handleGetNapcatStatus`
- `lib/routes/settings.js`：#2 `handleGetKeys`, #3 `handleGetWhitelist`, #4 `handleGetAdminIds`, #5 `handleGetCustomProviders`
- `lib/routes/deploy.js`：#6 `handleGetDeployConfig`, #7 `handleGetEnvCheck`

### 前端适配

修改后，前端调用这些接口需要在 header 带 `X-Admin-Token`：
- 如果前端**已有** admin token（用户之前输过管理员密码）→ 无感
- 如果前端**没有** admin token → 这些面板会显示"需要管理员密码"提示

需检查的前端页面：
- Dashboard 设置页（keys / whitelist / admin-ids / providers）
- 部署页（deploy/config / env/check）
- Bot 状态页（ssh-info / napcat/status）

### 决策点

此改动属于安全加固而非功能修复。是否执行取决于使用场景：
- 如果只有你一个人用 → **可不改**，不影响功能
- 如果有多人共享访问密码 → **建议改**，最小权限原则

---

## 已完成里程碑

- [x] Phase 1-2: 基础 lib 模块创建 (utils/paths/auth/tools/frontend/napcat)
- [x] Phase 3: deploy-helpers + routes/deploy + logging + napcat-proxy + deploy-state
- [x] Phase 4: router.js 统一路由分发
- [x] Phase 5: standalone.js 瘦身 (5182→159 行) + deploy-uninstall.js + 补漏 + 测试通过
- [x] P1-P5 模块化改进（消除重复、接通卸载、打破循环依赖）
