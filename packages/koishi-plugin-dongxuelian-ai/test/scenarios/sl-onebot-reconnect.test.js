'use strict'

const path = require('node:path')
const { spawnSync } = require('node:child_process')

// 子进程隔离真实 Koishi，避免场景套件的 fake Koishi 与全局状态影响真实重连验证。
async function run(t) {
  t.section('scenario: SL OneBot real transport recovery')
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'sl-onebot-reconnect-test.js')], {
    encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024,
  })
  t.check('SL session rebuild recovers real transport and respects stop/dispose/protocol scope',
    result.status === 0 && result.stdout.includes('SL reconnect tests passed: 5; failed: 0'),
    result.error?.message || `${result.stdout}\n${result.stderr}`)
}

module.exports = { run }
