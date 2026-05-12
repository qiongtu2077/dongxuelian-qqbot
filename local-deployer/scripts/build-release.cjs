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
  '- 用户需要先完整解压 zip，再运行解压目录里的 EXE；打包版会在 EXE 同级创建 `LianLianBOT/` 工作目录。',
  '- `LianLianBOT/` 会集中保存环境、依赖、配置、下载包、NapCat 和日志。',
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
  '使用方式：',
  '',
  '1. 请先完整解压本 zip。不要在压缩包预览窗口里直接双击 EXE。',
  '2. 双击本目录里的 莲莲Bot部署器.exe。',
  '3. 首次运行会在 EXE 同级目录自动创建 LianLianBOT/ 工作目录。',
  '',
  '- 双击 EXE 会启动本地 Dashboard 窗口，可用于 Windows 本地部署、远程 Linux 部署和 Bot 调试。',
  '- 部署器包含完整 Web 控制台：部署、终端控制、模型配置、API Keys、人格、黑白名单、日志和系统状态。',
  '- Windows 本地部署必须在本软件中执行；远端 Linux Dashboard 不能检测你的 Windows 本机环境。',
  '- 界面默认使用 Web 的浅色风格，并保留主题切换。',
  '- 访问密码和服务器密码不会写进 EXE。',
  '- 打包版运行时文件默认放在 EXE 同级的 LianLianBOT/：Node/npm、NapCat、node_modules、配置、下载包和日志都会集中放在那里。',
  '- 想迁移或备份时，复制整个 LianLianBOT-Deployer/ 文件夹即可。想手动卸载时，可先在部署器危险区执行卸载，再删除本文件夹。',
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
