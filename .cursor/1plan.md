# 当前任务：修复 P0 问题

## 要修的 P0

1. **后端死代码删除** — `startNpmInstallTask()` 和 `repairNpmProxyAndStartInstall()` 不再被任何 API 调用
   - 文件：`packages/koishi-plugin-dashboard/standalone.js`
   - 操作：删除这两个函数

2. **前端 dist 重建** — `frontend/dist` 是旧代码，npm 步骤会卡死
   - 文件：`packages/koishi-plugin-dashboard/frontend/`
   - 操作：进目录执行 npm run build

## 执行步骤

1. 定位并删除 standalone.js 中的 startNpmInstallTask 函数
2. 定位并删除 standalone.js 中的 repairNpmProxyAndStartInstall 函数
3. 重建 frontend/dist
4. npm test 全量测试
5. 提交推送

## 上下文

- 分支：YUN
- 最近 commit：fe52282 refactor(frontend)
- 测试：npm test
- 提交方式：commit-tree 脚本
