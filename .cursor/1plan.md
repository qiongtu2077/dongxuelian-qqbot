# standalone.js 拆分 — Phase 5 详细计划

## 当前状态

- standalone.js: **5182 行**, 208 个函数定义
- lib/: **18 个文件**, ~3500 行
- router.js 已接入，所有 API 请求优先走 lib/routes/
- 测试: 9 passed, 0 failed

## 差距分析

对 208 个函数做归类后：
- **165 个** 已有 lib/ 副本（standalone.js 保留的是冗余 dead copy）
- **12 个** 是 lib 模块的内部函数（不导出但已存在于文件中）
- **31 个** 真正未提取到任何 lib 模块

## 31 个未提取函数明细

### A 组 — 卸载模块 (20 个函数, ~430 行)
目标文件: `lib/deploy-uninstall.js` (新建)

| 行号 | 函数 | 依赖 |
|------|------|------|
| 1540 | projectDisplayPath | isInsidePath, toProjectRel |
| 1545 | safeLstat | fs |
| 1549 | summarizePath | safeLstat |
| 1573 | uniqueTargets | path |
| 1584 | createUninstallItem | summarizePath, uniqueTargets, projectDisplayPath |
| 1607 | pushUninstallItem | — |
| 1611 | projectTarget | resolveProjectRel |
| 1615 | existingProjectTarget | projectTarget, fs |
| 1620 | listExistingDataChildren | isInsidePath, projectTarget, DATA_DIR |
| 1633 | listReleaseArtifacts | projectTarget, KOISHI_DIR |
| 1644 | listExistingProjectChildren | resolveProjectRel, projectTarget |
| 1655 | listPackagedWorkspaceResourceTargets | isPackagedLocalWorkspace, existingProjectTarget |
| 1804 | isBlockedDeletePath | KOISHI_DIR, runtimePath |
| 1817 | assertSafeProjectDeletePath | isInsidePath, isBlockedDeletePath |
| 1832 | assertSafeExternalNapcatDeletePath | isInsidePath |
| 1845 | assertSafeUninstallTarget | assertSafe... |
| 1850 | buildLocalUninstallPreview | 上述所有 + getPortableNodeDir, detectNapcatInstallation |
| 1940 | stopLocalDeployProcessesForUninstall | localTasks, stopKoishiProcesses |
| 1954 | removeTarget | assertSafeUninstallTarget, removePathWithRetry |
| 1962 | pruneEmptyProjectDirs | KOISHI_DIR |
| 1971 | runLocalUninstall | 上述所有 |

### B 组 — 补漏 (3 个函数)
目标文件: 追加到已有模块

| 函数 | 目标模块 | 原因 |
|------|----------|------|
| prepareNpmInstallRun (2426) | deploy-helpers.js | 漏提取的 npm install 准备函数 |
| waitKoishiPortFree (366) | deploy-state.js 或 tools.js | Bot 进程管理 |
| getAgentEnvStatus (218) | routes/agent.js | 仅 agent 路由使用 |

### C 组 — 文件 I/O 包装 (3 个函数)
需验证是否与 utils.js 中现有导出等价：

| standalone 函数 | utils.js 对应 | 差异 |
|------|------|------|
| readFileSync (280) | readFileSyncSafe | 需对比参数签名 |
| readUtf8 (288) | readFileContent | 需对比 |
| writeFileSync (296) | writeFileSyncSafe | 需对比 |

如果等价 → 无需提取，standalone 直接引用 utils 版本
如果不等价 → 统一为一个版本后放入 utils

### D 组 — 初始化 (1 个函数)
| 函数 | 处理方式 |
|------|----------|
| resolveRuntimeDataDir (87) | 保留在 standalone.js（仅启动时调用一次的初始化逻辑） |

### E 组 — Gallery 内部函数 (12 个)
这些已存在于 routes/gallery.js 内部，standalone.js 的副本是 dead code。
无需额外提取，Phase 4 时直接删除。

## Phase 5 执行步骤

```
Step 1: 创建 lib/deploy-uninstall.js (A 组 20 个函数)
Step 2: 补漏 B 组 3 个函数到已有模块
Step 3: 验证 C 组文件 I/O 函数等价性，统一接口
Step 4: 跑全量测试 — 确认新模块正确
Step 5: 重写 standalone.js 为薄入口 (~200 行)
        - 只保留: imports, HTTP server, CORS, router.dispatch, 静态文件, listen
        - 所有函数定义全部删除
Step 6: 全量测试 + 手动 curl 验证
Step 7: 提交
```

## 风险评估

| 风险 | 严重性 | 缓解措施 |
|------|--------|----------|
| C 组函数签名不一致 | 中 | Step 3 详细对比后统一 |
| 卸载模块循环依赖 | 低 | 单向依赖 deploy-helpers 和 utils |
| standalone.js 重写遗漏 | 高 | Step 5-6 之间做 diff 对比确认无遗漏 |
| 共享状态未同步 | 中 | loginFailMap 已在 auth.js; localTasks 已在 deploy-state.js |

## 工作量估算

| Step | 复杂度 | 预计代码量 |
|------|--------|-----------|
| 1 (uninstall 模块) | 中 | ~450 行新文件 |
| 2 (补漏) | 低 | ~60 行追加 |
| 3 (I/O 验证) | 低 | ~10 行改动 |
| 4 (测试) | — | 运行即可 |
| 5 (重写 standalone) | 高 | 删 ~5000 行，写 ~200 行 |
| 6 (验证) | — | curl + npm test |
| 7 (提交) | — | git commit |

## 最终目标结构

```
standalone.js (~200 行)
  - require lib modules
  - resolveRuntimeDataDir() (唯一保留的初始化函数)
  - http.createServer
  - CORS
  - NapCat proxy (pathname /webui/)
  - router.dispatch()
  - 静态文件服务
  - 302 重定向 (/dashboard, /agent)
  - server.listen()

lib/ (20 文件, ~4000 行)
  - 原有 18 个模块
  - + deploy-uninstall.js (新)
  - router.js 中注册所有路由
```
