# standalone.js 模块拆分 — 完整进度

## Phase 1 + 2 全部完成 ✅（6 个模块，112 个导出）

```
packages/koishi-plugin-dashboard/lib/
├── utils.js      (20 导出) — 纯工具函数、文件操作
├── paths.js      (40 导出) — 路径常量和配置
├── auth.js       (16 导出) — 认证、Token、频率限制
├── tools.js      (16 导出) — Node/npm 检测、端口检查
├── napcat.js     (14 导出) — NapCat 检测/配置/Token
└── frontend.js   (6 导出)  — 前端构建管理
```

## Commits

| Commit | 内容 |
|--------|------|
| `846dd3b` | Phase 1-A: lib/utils.js |
| `5770d30` | Phase 1-B: lib/paths.js |
| `3a54fec` | Phase 1-C: lib/auth.js |
| `73413c0` | Phase 2-A: lib/tools.js |
| `eec976d` | Phase 2-C: lib/frontend.js |
| `7c493b0` | Phase 2-B: lib/napcat.js |

## Phase 3: 路由拆分 — 待做

需要：
1. 把 standalone.js 的 require 改为解构：`const { json, log, ... } = require('./lib/utils')`
2. 删除 standalone.js 中已在模块里定义的重复函数
3. 创建 `lib/routes/` 目录，按 API 前缀拆分路由处理器
4. standalone.js 只保留路由分发和服务器启动

**预估工作量**：2-3 个对话

## Phase 4: 删冗余 — 待做

standalone.js 当前 4800+ 行，Phase 3 完成后预计缩减到 200-500 行。

## 新对话提示

```
继续 standalone.js 模块拆分 Phase 3。
当前状态：lib/ 下 6 个模块已建立，standalone.js 已 require 它们但仍保留原始定义。
第一步：改 require 为解构，删除 standalone.js 中的重复函数定义。
从最简单的开始：utils.js 的 18 个函数。
```
