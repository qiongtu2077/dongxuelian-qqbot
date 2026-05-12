const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const deployerDir = path.resolve(__dirname, '..')
const root = path.resolve(deployerDir, '..')
const distDir = path.join(deployerDir, 'dist')
const releaseDir = path.join(deployerDir, 'release')
const stagingDir = path.join(releaseDir, 'staging')

function run(command, cwd = root) {
  console.log('$ ' + command)
  execSync(command, { cwd, stdio: 'inherit' })
}

function listFiles(dir) {
  try { return fs.readdirSync(dir).filter(name => !name.startsWith('.')) } catch { return [] }
}

run('npm --prefix packages/koishi-plugin-dashboard/frontend run build')
run('npm run build:win', deployerDir)

fs.rmSync(releaseDir, { recursive: true, force: true })
fs.mkdirSync(releaseDir, { recursive: true })
fs.mkdirSync(stagingDir, { recursive: true })

const files = listFiles(distDir)
const distributableFiles = files.filter(name => (
  name.toLowerCase().endsWith('.exe') ||
  name.toLowerCase().endsWith('.msi') ||
  name.toLowerCase().endsWith('.zip')
))
const exeFiles = distributableFiles.filter(name => name.toLowerCase().endsWith('.exe'))
const notes = [
  '# LianBoard Windows 部署器',
  '',
  '- 双击 EXE 会启动本地 Dashboard 窗口，可用于 Windows 本地部署、远程 Linux 部署和 Bot 调试。',
  '- 部署器包含完整 Web 控制台：部署、终端控制、模型配置、API Keys、人格、黑白名单、日志和系统状态。',
  '- Windows 本地部署必须在本软件中执行；远端 Linux Dashboard 不能检测你的 Windows 本机环境。',
  '- 界面默认使用 Web 的浅色风格，并保留主题切换。',
  '- 访问密码和服务器密码不会写进 EXE。',
  '- 运行时文件默认放在当前目录的 runtime/ 和 data/。',
  '- 卸载源码版请运行根目录的 卸载本地部署器.bat。',
  '',
].join('\r\n')
fs.writeFileSync(path.join(stagingDir, 'README.txt'), notes, 'utf8')

if (distributableFiles.length === 1 && exeFiles.length === 1) {
  const source = path.join(distDir, exeFiles[0])
  const target = path.join(releaseDir, exeFiles[0])
  fs.copyFileSync(source, target)
  fs.copyFileSync(path.join(stagingDir, 'README.txt'), path.join(releaseDir, 'README.txt'))
  console.log('single exe copied: ' + target)
} else {
  for (const file of distributableFiles) {
    const source = path.join(distDir, file)
    const target = path.join(stagingDir, file)
    fs.cpSync(source, target, { recursive: true })
  }
  const zipName = 'lianlian-bot-windows-deployer.zip'
  const zipPath = path.join(releaseDir, zipName)
  const ps = `Compress-Archive -Path ${JSON.stringify(path.join(stagingDir, '*'))} -DestinationPath ${JSON.stringify(zipPath)} -Force`
  run('powershell -NoProfile -ExecutionPolicy Bypass -Command ' + JSON.stringify(ps), root)
  console.log('zip created: ' + zipPath)
}

fs.rmSync(stagingDir, { recursive: true, force: true })
