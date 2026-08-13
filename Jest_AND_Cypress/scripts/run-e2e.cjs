const { spawn } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')

const rootDir = path.resolve(__dirname, '..')
const viteBin = path.join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js')
const cypressRunner = path.join(__dirname, 'run-cypress.cjs')

// 轮询 Vite 地址，直到服务可用或超过最长等待时间。
function waitForServer(url, timeoutMs = 30000) {
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    function probe() {
      const request = http.get(url, response => {
        response.resume()
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 500) return resolve()
        retry()
      })
      request.on('error', retry)
      request.setTimeout(1000, () => request.destroy())
    }
    function retry() {
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error(`等待测试服务器超时：${url}`))
      setTimeout(probe, 250)
    }
    probe()
  })
}

// 只停止本脚本创建的 Vite 子进程，并等待它完成退出。
function stopServer(server) {
  return new Promise(resolve => {
    if (!server || server.exitCode !== null) return resolve()
    server.once('exit', resolve)
    server.kill()
    setTimeout(() => {
      if (server.exitCode === null) server.kill('SIGKILL')
    }, 3000).unref()
  })
}

// 启动隔离的本地页面服务，执行 Cypress 后无条件清理。
async function runE2e() {
  const server = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', '41731', '--strictPort'], {
    cwd: rootDir,
    stdio: 'inherit',
  })
  let exitCode = 1
  try {
    await waitForServer('http://127.0.0.1:41731/dashboard/')
    const cypress = spawn(process.execPath, [cypressRunner], { cwd: rootDir, stdio: 'inherit' })
    exitCode = await new Promise((resolve, reject) => {
      cypress.once('error', reject)
      cypress.once('exit', code => resolve(typeof code === 'number' ? code : 1))
    })
  } finally {
    await stopServer(server)
  }
  process.exitCode = exitCode
}

runE2e().catch(error => {
  console.error(error)
  process.exitCode = 1
})
