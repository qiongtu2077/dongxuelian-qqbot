# 当前任务：修 P1（4 个问题）

## P1 问题列表

### 1. npm-repair-and-install API 仍执行 repairNpmProxyConfig

**现状**：`/api/deploy/npm-repair-and-install` handler 调用 `prepareNpmInstallRun({ forceRepair: true })`，这内部会执行 `repairNpmProxyConfig()` 实际修改用户的 npm config（删代理设置）。与"只引导用户"的原则不一致。

**修法**：改为只收集诊断信息 `collectNpmInstallDiagnostics(true)` + 生成修复命令列表（不实际执行），返回给前端展示。

**文件**：`packages/koishi-plugin-dashboard/standalone.js` ~4984

---

### 2. 前端 skipped 路径缺 checkEnv()

**现状**：`runNpmInstallStep` 中，当后端返回 `skipped: true`（依赖已装）时，没有调用 `checkEnv()` 刷新 env 缓存。一键向导中如果 env 是旧的（dependencies.ready=false），会误判。

**修法**：skipped 分支加 `await checkEnv()`

**文件**：`DeployPanel.vue` runNpmInstallStep 函数

---

### 3. 前端按钮文案 "一键修复代理并重试" 过时

**现状**：模板中修复按钮还叫"一键修复代理并重试"，暗示会自动执行。

**修法**：改为"查看代理修复命令"

**文件**：`DeployPanel.vue` 模板 ~136

---

### 4. 后端 typo

**现状**：koishi-start handler 里写的 `'请先执行 npm install 站点'`

**修法**：改为 `'请先执行 npm install 步骤'`

**文件**：`standalone.js` ~5046

---

## 执行步骤

1. standalone.js: npm-repair-and-install 去掉 prepareNpmInstallRun 的实际修复
2. standalone.js: 修 typo
3. DeployPanel.vue: skipped 加 checkEnv
4. DeployPanel.vue: 修按钮文案
5. 语法检查 + npm test
6. 提交推送
