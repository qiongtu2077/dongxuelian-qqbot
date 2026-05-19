# P2 详细解释（Cursor 消息渲染有 bug，写到文件里给你看）

## 问题 1：start-local.bat 检测不完整

当前 bat 只检查 node_modules 文件夹是否存在。
如果文件夹在但缺 koishi 包，bat 不报错直接启动，Koishi 报错找不到模块。

修法：bat 里加一行检查 node_modules\koishi 是否存在。
检测到缺失时行为和现在一样——输出错误 + pause + exit：

```
if not exist node_modules\koishi (
  echo [ERROR] Dependencies incomplete. Please run "npm install" first.
  echo Project directory: %~dp0
  pause
  exit /b 1
)
```

## 问题 2：前端死分支

DeployPanel.vue 有段代码 `if (npmStatus?.running) setStepStatus('npm', 'running')`。
npm 不再由后端执行，running 永远不会变 true。
修法：删掉这 3 行死代码。

## 问题 3：frontend/dist 不在 git 里

前端 Vue 代码编译后产物在 frontend/dist/ 目录（浏览器实际加载的文件）。
根 .gitignore 有 dist/ 规则把它排除了。

影响：
- 远程服务器 git pull 后不会自动更新页面，需要手动重建或点"重建并部署到远端"
- 本地 Electron 打包时 electron-builder 从 extraResources 取文件，不取 frontend/dist

你们现有部署流程已经包含重建步骤，实际使用不受影响。

选项：
- A. 不改（推荐，现状够用）
- B. 把 dist 加入 git（.gitignore 加排除规则）

---

## 需要你决定

问题 1 和 2 要不要修？问题 3 改不改？
