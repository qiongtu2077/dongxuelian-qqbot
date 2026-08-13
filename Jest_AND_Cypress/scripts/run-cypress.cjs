const { spawnSync } = require('node:child_process')
const path = require('node:path')

// 启动 Cypress，并隔离会让 Electron 错误进入 Node 模式的宿主环境变量。
function runCypress() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const cypressPackage = require.resolve('cypress/package.json')
  const cypressBin = path.join(path.dirname(cypressPackage), 'bin', 'cypress')
  const result = spawnSync(process.execPath, [cypressBin, 'run', '--config-file', 'cypress.config.cjs', '--browser', 'electron'], {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  process.exitCode = typeof result.status === 'number' ? result.status : 1
}

runCypress()
