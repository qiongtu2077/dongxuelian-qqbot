# LianBoard Windows 部署器

这个目录是打包 Windows 桌面软件的入口。部署器不是只做安装向导，它会在 Windows 本机启动完整 Dashboard 后端，并把 Web 前端作为桌面控制台打开，所以可以作为 Bot 部署和调试软件使用。

它会让同一个 Windows 程序完成这些事：

- Windows 本机部署：在当前项目目录下生成 `runtime/`、`data/`、`koishi.yml`、`start-local.bat`，不写入 C 盘系统目录。
- 远程 Linux 部署：打开 Dashboard 的部署页，填写 `root@服务器IP` 和远程目录后通过 SSH/SCP 推送更新。
- Bot 调试：启动/停止 Bot、查看日志、切换模型、编辑 API Keys、管理人格、黑白名单、安全设置和系统状态。

路径约定：

- 部署器源码：`local-deployer/`
- Electron Builder 中间产物：`local-deployer/dist/`
- 最终发布产物：`local-deployer/release/`

## 开发运行

```powershell
cd local-deployer
npm install
npm run start
```

启动后会打开 `http://127.0.0.1:5150/dashboard/`。访问密码和管理员密码仍由 Dashboard 环境变量或数据文件管理，不在代码里硬编码。部署器窗口默认使用 Dashboard 的浅色风格，并保留主题切换。

在源码目录里，普通用户可以直接双击根目录的 `启动本地部署器.bat`，不需要手动进入命令行。

## 打包 Windows EXE

```powershell
cd local-deployer
npm install
npm run build:win
```

输出为 `dist/` 下的 Windows portable EXE。打包会把根目录的 `packages/`、`scripts/`、`package.json`、`start.js`、`koishi.example.yml` 作为资源带入。

根目录的 `构建Windows部署器.bat` 会自动安装依赖、构建 Dashboard 前端并打包部署器。构建脚本会把最终可分发文件整理到 `local-deployer/release/`。若只有一个 EXE，就直接发布该 EXE；若产物包含多个文件，则发布 `local-deployer/release/lianlian-bot-windows-deployer.zip`。

如果要把部署器跟代码一起推送到 GitHub，需要将 `local-deployer/release/` 中的 EXE/ZIP 一并加入提交。注意 GitHub 单文件大小限制为 100 MiB，构建后需要确认产物大小未超限。

根目录的 `卸载本地部署器.bat` 用于清理本地部署器依赖、构建产物和可选运行时数据。默认保留 `data/` 与 `runtime/`，避免误删 Key、记忆和 NapCat 文件。

## 本地部署约束

- 下载包默认放到根目录 `runtime/downloads/`。
- NapCat 建议解压到 `runtime/napcat/`。
- 运行日志建议放到 `runtime/logs/`。
- OneBot WebSocket 使用 `ws://127.0.0.1:8080/onebot/v11/ws`。
- Dashboard 入口只需要访问密码；修改配置、部署、Key、密码等敏感操作仍需要管理员密码。SSH 登录服务器的系统密码不写入部署器代码。

## 从 0 到可用

Windows 本地部署页只认当前 Dashboard 后端所在机器。只有使用 Windows 部署器软件，后端才会运行在你的 Windows 本机并检测真实本机环境。看到 Windows 盘符、当前项目目录和本机 runtime 目录时，说明正在操作正确的机器。

如果页面显示 `linux/x64`、`/root/koishi-app` 或其他 Linux 路径，说明你正在访问远端 Linux Dashboard。此时不能执行 Windows 本地部署，也不能把远端服务器状态当成本机状态；请改用 Windows 部署器软件，或切换到“远程 Linux 部署”。

页面会按地铁站点图追踪完整流程：`环境检测 -> 安装 NapCat -> 生成配置 -> npm install -> 启动 NapCat -> 等待扫码 -> 启动 Koishi -> 健康检查`。

最少步骤：

1. 双击根目录 `启动本地部署器.bat`，打开 Dashboard 部署页。
2. 点击 `检测环境`，确认 Node.js 18+、npm、端口和项目目录状态。
3. 填写机器人 QQ。`API Key` 可以留空，留空不会阻塞部署；部署完成后再到 API Keys 页补充即可。
4. 点击 `一键准备并启动`，向导会自动安装 NapCat、生成 Koishi 配置、执行 `npm install` 并启动 NapCat。
5. 到 `等待扫码` 站点时，用机器人 QQ 扫码登录 NapCat，然后点击 `我已扫码，继续`。
6. 向导启动 Koishi 并执行健康检查。若 AI Key 仍为空，结果会显示“基础可用”：QQ 登录、OneBot 和 Koishi 可用，但 AI 回复暂不可用。

端口要求：Dashboard `5150`，Koishi `5140`，NapCat WebUI `6099`，OneBot WebSocket `8080`。如果端口被占用，环境检测会在对应站点显示原因。

## Windows 本地部署页按钮说明

- `一键准备并启动` 会按站点图顺序执行：环境检测、安装 NapCat、生成配置、`npm install`、启动 NapCat，然后暂停等待扫码。
- `检测环境` 只读取当前状态，不创建 NapCat 安装目录，也不会把残留目录当作已安装。NapCat 必须检测到可信启动文件或配置标记才显示为已安装。
- `一键安装 NapCat（Windows，官方包）` 是主流程按钮，只在 Windows 环境可用。部署器窗口中可用系统目录选择框，普通浏览器中需要手填 Dashboard 所在机器上的安装路径，默认建议 `runtime/napcat/`。
- `执行 npm install` 会在项目根目录安装依赖，并把日志写入 `runtime/logs/npm-install.log`。
- `启动 NapCat` 会启动本机 NapCat，日志写入 `runtime/logs/napcat.log`。扫码登录必须由用户手动完成。
- `启动 Koishi` 会启动本机 Koishi，日志写入 `runtime/logs/koishi-local.log`。
- `健康检查` 会汇总 Node/npm、项目依赖、NapCat、OneBot、Koishi 和 AI Key 状态。AI Key 未配置时不算部署失败，只会提示 AI 回复暂不可用。
- `下载直链包` 位于高级设置，只把用户粘贴的下载地址保存到 `runtime/downloads/`，不等同于安装 NapCat。
- `打开 NapCat 发布页` 是手动下载入口，用于查看版本或自行下载安装包。
- `生成 Koishi 本地配置` 会写入 `koishi.yml`、`start-local.bat` 和必要的 `data/ai-*.txt` 配置，并记录 `data/dashboard-local-deploy-manifest.json`，方便后续预览和安全删除。
- `删除 Koishi 配置` 会先展示删除预览，只删除本工具生成且未被手动修改的 Koishi 启动配置；默认保留 NapCat、下载包、API Key、用户资料、日志和插件源码。
- `一键卸载本地部署环境` 位于危险区。点击后会先要求管理员密码，通过后再弹出主题化确认窗口，列出环境文件和用户数据。
  - 环境文件默认删除：项目 `node_modules/`、Dashboard 前端依赖、本地部署器依赖和构建产物、`runtime/napcat/`、`runtime/downloads/`、`koishi.yml`、`start-local.bat`、本地部署清单和备份。
  - 用户数据默认保留：API Key、管理员 ID、用户资料、会话/记忆、运行日志、cookies、白名单/黑名单和其他 `data/` 运行数据。用户在确认窗口里取消保留后才会删除。
  - 系统全局 Node.js/npm 只检测和报告，不自动卸载。只有项目目录内或本工具清单记录的 Node/npm 依赖、便携 Node、npm 产物会被删除。
  - 自定义 NapCat 目录只有在被本工具记录、能验证为 NapCat 目录且不属于系统/用户根目录时才会自动删除；否则会提示用户手动处理。
