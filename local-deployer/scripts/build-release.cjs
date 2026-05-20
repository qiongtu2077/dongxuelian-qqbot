const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const deployerDir = path.resolve(__dirname, '..')
const root = path.resolve(deployerDir, '..')
const deployerPkg = require(path.join(deployerDir, 'package.json'))
const distDir = path.join(deployerDir, 'dist')
const releaseDir = path.join(deployerDir, 'release')
const stagingDir = path.join(releaseDir, 'staging')
const portableDirName = 'LianLianBOT-Deployer-Portable'
const portableDir = path.join(stagingDir, portableDirName)

// --- Command helpers --- #

/** Runs a shell command and streams output to the current terminal. */
function run(command, cwd = root) {
  console.log('$ ' + command)
  execSync(command, { cwd, stdio: 'inherit' })
}

/** Lists visible files in a directory, returning an empty list if missing. */
function listFiles(dir) {
  try { return fs.readdirSync(dir).filter(name => !name.startsWith('.')) } catch { return [] }
}

/** Finds one expected artifact and fails if the build produced ambiguity. */
function findOneFile(files, predicate, label) {
  const matched = files.filter(predicate)
  if (matched.length !== 1) throw new Error(`expected exactly one ${label}, found ${matched.length}: ${matched.join(', ') || '(none)'}`)
  return matched[0]
}

/** Compresses a staged release folder with PowerShell Compress-Archive. */
function compressDirectory(sourceDir, zipPath) {
  const ps = `Compress-Archive -LiteralPath ${JSON.stringify(sourceDir)} -DestinationPath ${JSON.stringify(zipPath)} -Force`
  run('powershell -NoProfile -ExecutionPolicy Bypass -Command ' + JSON.stringify(ps), root)
}

/** Writes CRLF release text for Windows users. */
function writeText(file, lines) {
  fs.writeFileSync(file, lines.join('\r\n') + '\r\n', 'utf8')
}

// --- Release notes --- #

/** Writes the top-level release directory guidance. */
function writeReleaseReadme(setupName, portableZipName) {
  writeText(path.join(releaseDir, 'README.txt'), [
    '# 莲莲 Bot Windows 部署器 release 目录',
    '',
    `- 推荐新用户下载便携版：\`${portableZipName}\`。完整解压后运行里面的 \`莲莲Bot部署器.exe\`，不会安装系统快捷方式。`,
    `- 需要开始菜单或桌面快捷方式时下载安装版：\`${setupName}\`。安装器会显示安装路径，运行数据不放在安装目录。`,
    '- 便携版工作目录：EXE 同级的 `LianLianBOT/`。',
    '- 安装版工作目录：`%USERPROFILE%\\Documents\\LianLianBOT`，文档目录不可写时回退到 Electron 用户数据目录。',
    '- 程序资源源码目录位于应用自身的 `resources\\app`，这是只读资源；Node、NapCat、配置、日志和图集都在工作目录。',
    '- 启动失败时，部署器弹窗会显示日志路径；也可以在部署页查看“程序目录 / 资源目录 / 工作目录 / 日志目录”。',
    '- 不要把安装版 setup exe 重命名成普通运行 exe，也不要在压缩包预览窗口中直接双击便携版。',
    '- 构建脚本会清理并重建本目录；发布前请重新运行 `npm --prefix local-deployer run release:win`。',
  ])
}

/** Writes the README bundled with the portable zip. */
function writePortableReadme() {
  writeText(path.join(portableDir, 'README.txt'), [
    '# 莲莲 Bot Windows 部署器（便携版，推荐）',
    '',
    '给第一次使用的用户：请先把整个 zip 解压出来，再运行里面的 `莲莲Bot部署器.exe`。不要在压缩包预览窗口里直接双击。',
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
    '路径说明：',
    '',
    '- 便携版工作目录固定在 EXE 同级 `LianLianBOT/`。',
    '- `LianLianBOT/` 不会在 EXE 刚启动时创建；只有点击安装、生成配置或一键部署等写入动作时才会创建。',
    '- `LianLianBOT/runtime/` 保存便携 Node/npm、NapCat、下载包和日志。',
    '- `LianLianBOT/node_modules/` 是项目依赖，由 npm install 生成。',
    '- `LianLianBOT/data/` 保存 API Key、用户资料、会话、图集、白名单/黑名单和部署清单。',
    '- 程序资源源码目录位于运行时展开的应用资源目录，不要手动修改；部署器会把需要写入的运行资源同步到工作目录。',
    '',
    '失败和日志：',
    '',
    '- Electron 启动日志在 `LianLianBOT/runtime/logs/dashboard-electron.log`。',
    '- npm install 日志在 `LianLianBOT/runtime/logs/npm-install.log`。',
    '- NapCat 日志在 `LianLianBOT/runtime/logs/napcat.log`。',
    '- Koishi 日志在 `LianLianBOT/runtime/logs/koishi-local.log`。',
    '- 部署失败时，界面会停在失败站点并显示日志路径和最后几行日志。',
    '- 如果端口 5150 被占用，关闭占用程序后重新打开部署器，或设置 `DASHBOARD_PORT` 后启动。',
    '',
    '卸载和重装：',
    '',
    '- 在部署器“危险区”点击“一键卸载本地部署环境”，会先显示删除预览和确认弹窗，不需要密码。',
    '- 环境文件默认删除：Node/npm、NapCat、QQ.exe、下载缓存、node_modules、Koishi 配置、安装暂存目录和部署器同步出来的 packages/scripts。',
    '- 用户数据默认保留：API Key、管理员 ID、用户资料、会话/记忆、莲莲图集、运行日志、cookies、白名单/黑名单等。',
    '- 如果你在确认窗口里选择删除全部用户数据，卸载完成后会尽量清到只剩 `莲莲Bot部署器.exe` 和这个 `README.txt`。',
    '- 想整体迁移时，复制整个 `LianLianBOT-Deployer-Portable/` 文件夹即可。',
  ])
}

/** Writes installer-specific guidance next to the setup EXE. */
function writeInstallerReadme(setupName) {
  writeText(path.join(releaseDir, 'README-安装版.txt'), [
    '# 莲莲 Bot Windows 部署器（安装版）',
    '',
    `安装版文件：\`${setupName}\`。`,
    '',
    '- 安装器会显示安装路径，并创建桌面快捷方式和开始菜单快捷方式。',
    '- 程序安装目录只存放应用本体；不要在安装目录里找 Node、NapCat、配置或日志。',
    '- 安装版工作目录固定在 `%USERPROFILE%\\Documents\\LianLianBOT`；如果文档目录不可写，会回退到 Electron 用户数据目录。',
    '- 快捷方式打不开时，右键快捷方式选择“打开文件所在的位置”，确认目标是否仍存在。',
    '- 启动失败时查看 `%USERPROFILE%\\Documents\\LianLianBOT\\runtime\\logs\\dashboard-electron.log`。',
    '- 端口 5150 被占用会阻止 Dashboard 启动；关闭占用程序后重新打开部署器即可。',
    '',
    '如果不需要系统安装和快捷方式，优先使用便携版 zip。',
  ])
}

// --- Build and package --- #

run('npm --prefix packages/koishi-plugin-dashboard/frontend run build')
fs.rmSync(distDir, { recursive: true, force: true })
run('npm run build:win', deployerDir)

fs.rmSync(releaseDir, { recursive: true, force: true })
fs.mkdirSync(releaseDir, { recursive: true })
fs.mkdirSync(portableDir, { recursive: true })

const files = listFiles(distDir)
const portableExeName = findOneFile(
  files,
  name => /^LianLianBOT-Deployer-Portable-v.+\.exe$/i.test(name),
  'portable EXE',
)
const setupExeName = findOneFile(
  files,
  name => /^LianLianBOT-Deployer-Setup-v.+\.exe$/i.test(name),
  'setup EXE',
)

fs.copyFileSync(path.join(distDir, portableExeName), path.join(portableDir, '莲莲Bot部署器.exe'))
writePortableReadme()

const portableZipName = `LianLianBOT-Deployer-Portable-v${deployerPkg.version}.zip`
const portableZipPath = path.join(releaseDir, portableZipName)
compressDirectory(portableDir, portableZipPath)

fs.copyFileSync(path.join(distDir, setupExeName), path.join(releaseDir, setupExeName))
writeInstallerReadme(setupExeName)
writeReleaseReadme(setupExeName, portableZipName)

fs.rmSync(stagingDir, { recursive: true, force: true })
console.log('portable zip created: ' + portableZipPath)
console.log('setup exe copied: ' + path.join(releaseDir, setupExeName))
