# standalone.js 拆分 — 完成状态

## 已完成模块

```
lib/ 共 17 文件, ~3200 行已提取代码
├── 基础模块 (Phase 1-2):
│   ├── utils.js       — 通用工具函数 (22 导出)
│   ├── paths.js       — 路径常量和路径函数 (40 导出)
│   ├── auth.js        — 认证和权限 (17 导出)
│   ├── tools.js       — Node/npm 检测 (16 导出)
│   ├── frontend.js    — 前端构建 (6 导出)
│   └── napcat.js      — NapCat 检测 (14 导出)
├── 基础设施 (Phase 3 补充):
│   ├── logging.js     — 日志缓存 + 过滤 (11 函数)
│   ├── napcat-proxy.js— NapCat WebUI 反向代理
│   └── deploy-state.js— 部署共享状态 (localTasks/rebuildStatus/spawnLocalTask)
├── 路由模块 (Phase 3):
│   ├── routes/gallery.js  — 图集 CRUD (5 + 1 prefix)
│   ├── routes/auth.js     — 登录验证 (4)
│   ├── routes/config.js   — AI 配置 (14)
│   ├── routes/agent.js    — Agent API (27 + 6 regex)
│   ├── routes/settings.js — 系统设置 (15 + 2 regex)
│   ├── routes/bot.js      — Bot/日志/NapCat (16)
│   └── routes/deploy.js   — 部署管理 (27 + 1 prefix) ← NEW
└── Deploy 辅助:
    └── deploy-helpers.js  — 部署核心函数 (~60 导出) ← NEW
```

## 总计

- **路由 endpoint**: 82 (前6模块) + 28 (deploy) = **110 endpoint** 已模块化
- **测试**: 全部通过 (0 failures)
- **standalone.js**: 仍保留原始代码（Phase 4 待删除），当前 ~5180 行

## Phase 4 待办（删除 standalone.js 冗余）

standalone.js 中与已提取模块对应的代码仍然存在。Phase 4 的工作是：
1. 在 standalone.js 的 HTTP handler 中用路由模块替换 if-else 分发
2. 删除 standalone.js 中已移入 lib/ 的函数定义
3. 预计可将 standalone.js 从 5180 行缩减到 ~2000 行
