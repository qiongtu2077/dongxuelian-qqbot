'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
let passed = 0
let failed = 0

// 记录一条资源回归断言并累计统一结果。
function check(label, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`OK   ${label}`)
  } else {
    failed++
    console.log(`FAIL ${label}${detail ? ': ' + detail : ''}`)
  }
}

// 创建与生产数据目录隔离的临时场景目录。
function createTempDataDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// 从允许包含前置日志的子进程输出尾部解析场景 JSON。
function parseScenarioOutput(stdout) {
  const text = String(stdout || '').trim()
  if (!text) throw new Error('child produced no stdout')
  const start = text.lastIndexOf('\n{')
  const jsonText = start >= 0 ? text.slice(start + 1) : text
  return JSON.parse(jsonText)
}

// 在仓库根目录运行一个隔离场景并统一校验退出码和 JSON 输出。
function runScenario(label, script, env, timeoutMs = 30000) {
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: timeoutMs,
  })
  check(`${label} exits 0`, result.status === 0, `status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`)
  if (result.status !== 0) return null
  try {
    return parseScenarioOutput(result.stdout)
  } catch (error) {
    check(`${label} output is JSON`, false, error instanceof Error ? error.message : String(error))
    return null
  }
}

// 清空统一计数，保证入口被测试进程重复加载时结果隔离。
function resetSummary() {
  passed = 0
  failed = 0
}

// 返回当前资源回归统一计数。
function getSummary() {
  return { passed, failed }
}

module.exports = { check, createTempDataDir, parseScenarioOutput, runScenario, resetSummary, getSummary }
