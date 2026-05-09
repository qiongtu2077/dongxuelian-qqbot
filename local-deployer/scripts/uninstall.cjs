const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const root = path.resolve(__dirname, '..', '..')
const cleanData = String(process.argv[2] || '').trim() === 'YES'

function remove(target) {
  const fullPath = path.join(root, target)
  try {
    fs.rmSync(fullPath, { recursive: true, force: true })
    console.log('removed: ' + target)
  } catch (error) {
    console.log('skip: ' + target + ' (' + error.message + ')')
  }
}

function stopProcesses() {
  if (process.platform !== 'win32') return
  const escapedRoot = root.replace(/'/g, "''")
  const script = `Get-CimInstance Win32_Process | Where-Object { ($_.Name -match 'node|electron|莲莲') -and ($_.CommandLine -like '*${escapedRoot}*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`
  try { execSync('powershell -NoProfile -ExecutionPolicy Bypass -Command ' + JSON.stringify(script), { stdio: 'ignore', timeout: 10000 }) } catch {}
}

stopProcesses()
remove('local-deployer/node_modules')
remove('local-deployer/dist')
remove('local-deployer/release')
remove('packages/koishi-plugin-dashboard/frontend/node_modules')

if (cleanData) {
  remove('runtime')
  remove('data')
  remove('koishi.yml')
  remove('start-local.bat')
} else {
  console.log('kept: data')
  console.log('kept: runtime')
  console.log('kept: koishi.yml')
  console.log('kept: start-local.bat')
}
