const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const deployerDir = path.resolve(__dirname, '..')
const root = path.resolve(deployerDir, '..')
const deployerPkg = require(path.join(deployerDir, 'package.json'))
const distDir = path.join(deployerDir, 'dist')
const releaseDir = path.join(deployerDir, 'release')
const stagingDir = path.join(releaseDir, 'staging')
const packageDirName = 'LianLianBOT-Deployer'
const packageDir = path.join(stagingDir, packageDirName)

function run(command, cwd = root) {
  console.log('$ ' + command)
  execSync(command, { cwd, stdio: 'inherit' })
}

function listFiles(dir) {
  try { return fs.readdirSync(dir).filter(name => !name.startsWith('.')) } catch { return [] }
}

run('npm --prefix packages/koishi-plugin-dashboard/frontend run build')
fs.rmSync(distDir, { recursive: true, force: true })
run('npm run build:win', deployerDir)

fs.rmSync(releaseDir, { recursive: true, force: true })
fs.mkdirSync(releaseDir, { recursive: true })
fs.mkdirSync(packageDir, { recursive: true })
const releaseReadme = [
  '# 莲莲 Bot Windows 部署器 release 目录',
  '',
  '- 正式发布附件只上传 `LianLianBOT-Deployer-v版本号.zip`，不要单独上传裸 EXE。',
  '- zip 内包含 `LianLianBOT-Deployer/` 顶层目录、`莲莲Bot部署器.exe` 和用户 README。',
  '- 用户需要先完整解压 zip，再运行解压目录里的 EXE；不要在压缩包预览窗口中直接运行。',
  '- 打包版只会在用户点击安装、生成配置或一键部署等写入动作时创建 `LianLianBOT/` 工作目录；单纯启动 EXE 不会生成密码重置令牌。',
  '- `LianLianBOT/` 会集中保存环境、依赖、配置、下载包、NapCat、图集和日志。',
  '- v1.1.5 起，远程部署按钮会说明本地文件来源；莲莲图集详情的关闭按钮和闪卡样式选择固定在最右侧，不再压住预览图。',
  '- 构建脚本会清理并重建本目录；发布前请重新运行 `npm --prefix local-deployer run release:win`。',
  '',
].join('\r\n')
fs.writeFileSync(path.join(releaseDir, 'README.txt'), releaseReadme, 'utf8')

const files = listFiles(distDir)
const distributableFiles = files.filter(name => (
  name.toLowerCase().endsWith('.exe') ||
  name.toLowerCase().endsWith('.msi') ||
  name.toLowerCase().endsWith('.zip')
))
const exeFiles = distributableFiles.filter(name => name.toLowerCase().endsWith('.exe'))
if (!exeFiles.length) throw new Error('electron-builder did not produce a Windows EXE')
const notes = [
  '# 莲莲 Bot Windows 部署器',
  '',
  '给第一次使用的用户：请先把整个 zip 解压出来，再运行里面的 EXE。不要在压缩包预览窗口里直接双击。',
  '',
  '部署流程：',
  '',
  '1. 双击 `莲莲Bot部署器.exe`。',
  '2. 在部署页填写“机器人 QQ”。这是 Bot 要挂载登录的 QQ 号，必须填写。',
  '3. 点击“一键配置环境并启动”。如果没有填写 QQ，会弹窗提示“请先填入bot挂载的qq号”，本次点击无效，部署器不会创建工作目录。',
  '4. 部署器会按顺序准备工作目录、安装并使用便携 Node/npm、安装 NapCat、生成 Koishi 配置、执行 npm install、启动 NapCat。',
  '5. 到“等待扫码”时，用机器人 QQ 扫码登录 NapCat。部署器会自动检测登录成功，并继续启动 Koishi 和健康检查。',
  '6. AI Key 可以先留空；基础部署可用后，再到 API Keys 页补充。',
  '',
  '工作目录说明：',
  '',
  '- `LianLianBOT/` 不会在 EXE 刚启动时创建；只有点击安装、生成配置或一键部署等写入动作时才会创建。',
  '- 本地部署器模式不会生成或显示 Dashboard 密码重置令牌。',
  '- `LianLianBOT/runtime/` 保存便携 Node/npm、NapCat、下载包和日志。',
  '- `LianLianBOT/node_modules/` 是项目依赖，由 npm install 生成。',
  '- `LianLianBOT/data/` 保存 API Key、用户资料、会话、图集、白名单/黑名单和部署清单。',
  '- Node.js 官方 Windows zip 自带 `node.exe`、`npm.cmd`、`npx.cmd`，所以“安装便携 Node/npm”是同一个安装动作。',
  '- “npm 状态”只表示 npm 命令可用；“项目依赖”表示本 Bot 需要的 node_modules 是否已安装完整。',
  '',
  '失败和日志：',
  '',
  '- npm install 日志在 `LianLianBOT/runtime/logs/npm-install.log`。',
  '- NapCat 日志在 `LianLianBOT/runtime/logs/napcat.log`。',
  '- Koishi 日志在 `LianLianBOT/runtime/logs/koishi-local.log`。',
  '- 部署失败时，界面会停在失败站点并显示日志路径和最后几行日志。',
  '- Node/npm 与 NapCat 自动安装会清理旧暂存目录和半成品目录；如果仍被占用，会显示具体路径方便关闭进程后重试。',
  '',
  '卸载和重装：',
  '',
  '- 在部署器“危险区”点击“一键卸载本地部署环境”，会先显示删除预览和确认弹窗，不需要密码。',
  '- 环境文件默认删除：Node/npm、NapCat、QQ.exe、下载缓存、node_modules、Koishi 配置、安装暂存目录和部署器同步出来的 packages/scripts。',
  '- 用户数据默认保留：API Key、管理员 ID、用户资料、会话/记忆、莲莲图集、运行日志、cookies、白名单/黑名单等。',
  '- 如果你在确认窗口里选择删除全部用户数据，卸载完成后会尽量清到只剩 `莲莲Bot部署器.exe` 和这个 `README.txt`。',
  '- 想整体迁移时，复制整个 `LianLianBOT-Deployer/` 文件夹即可。',
  '- 莲莲图集上传不需要管理员密码；图片显示接口允许浏览器直接读取，上传后会校验真实图片格式。图片详情的关闭按钮和 A-G 闪卡样式固定在最右侧，不会压住预览图。',
  '- 远程 Linux 部署里的“开始远程操作”和“重建前端”都会在页面注明文件来源：它们读取当前 Dashboard 后端所在机器的本地文件，不会从 GitHub 拉取。',
  '',
].join('\r\n')
fs.writeFileSync(path.join(packageDir, 'README.txt'), notes, 'utf8')

const sourceExe = path.join(distDir, exeFiles[0])
const targetExe = path.join(packageDir, '莲莲Bot部署器.exe')
fs.copyFileSync(sourceExe, targetExe)

const zipName = `LianLianBOT-Deployer-v${deployerPkg.version}.zip`
const zipPath = path.join(releaseDir, zipName)
const ps = `Compress-Archive -LiteralPath ${JSON.stringify(packageDir)} -DestinationPath ${JSON.stringify(zipPath)} -Force`
run('powershell -NoProfile -ExecutionPolicy Bypass -Command ' + JSON.stringify(ps), root)
console.log('zip created: ' + zipPath)

fs.rmSync(stagingDir, { recursive: true, force: true })
