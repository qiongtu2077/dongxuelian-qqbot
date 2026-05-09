const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const root = path.resolve(__dirname, '..', '..')

function commandVersion(command) {
  try { return execSync(command, { encoding: 'utf8', timeout: 3000 }).trim() } catch { return '' }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function checkWrite(dir) {
  const file = path.join(dir, '中文路径写入测试.tmp')
  fs.writeFileSync(file, 'ok', 'utf8')
  const ok = fs.readFileSync(file, 'utf8') === 'ok'
  fs.unlinkSync(file)
  return ok
}

const runtime = ensureDir(path.join(root, 'runtime'))
ensureDir(path.join(runtime, 'downloads'))
ensureDir(path.join(runtime, 'logs'))
ensureDir(path.join(runtime, 'napcat'))

const report = {
  root,
  runtime,
  node: commandVersion('node --version') || 'not found',
  npm: commandVersion('npm --version') || 'not found',
  writable: checkWrite(path.join(runtime, 'logs')),
  onebotEndpoint: 'ws://127.0.0.1:8080/onebot/v11/ws',
}

console.log(JSON.stringify(report, null, 2))
