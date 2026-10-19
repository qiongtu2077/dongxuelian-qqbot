/** 测试真实原子落盘与受控失败文件；仅替换数据根和活动任务读取边界。 */
'use strict'
const assert = require('assert').strict
const fs = require('fs')
const os = require('os')
const path = require('path')
const management = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime')
const artifactPath = require.resolve('../lib/analysis-artifacts')
const storagePath = require.resolve('../lib/report-storage')

// 枚举真实保存文件，临时文件不会计入已经完成的JSON产物。
function jsonFiles(dir) {
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...jsonFiles(file))
    else if (entry.name.endsWith('.json')) files.push(file)
  }
  return files
}

// 把文件边界固定到独立临时目录，所有模块补丁在finally恢复。
async function withStore(run) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-artifact-test-'))
  const originalLoad = management.loadManagementModule
  const originalModule = require.cache[artifactPath]
  const originalStorage = require.cache[storagePath]
  const constants = originalLoad('core.constants')
  const taskStore = originalLoad('resource.taskStore')
  management.loadManagementModule = id => id === 'core.constants' ? { ...constants, DATA_DIR: dataDir }
    : id === 'resource.taskStore' ? { ...taskStore, listActiveDailyReportTasks: () => [] } : originalLoad(id)
  delete require.cache[artifactPath]
  delete require.cache[storagePath]
  try { await run(require(artifactPath), dataDir) } finally {
    management.loadManagementModule = originalLoad
    if (originalModule) require.cache[artifactPath] = originalModule; else delete require.cache[artifactPath]
    if (originalStorage) require.cache[storagePath] = originalStorage; else delete require.cache[storagePath]
    assert(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

// 独立输出每项验收，错误场景不污染后续用例。
async function verify(check, label, run) {
  try { await withStore(run); check(label, true) } catch (error) { check(label, false, error.stack || String(error)) }
}

// 执行任务产物的权限、容量、原子写入和诊断脱敏回归。
async function runAnalysisArtifactTests(check) {
  const unit = { id: 'B1', stage: 'compression', sourceIds: [1, 2], timestamps: [1000, 2000] }
  const attempts = [{ attempt: 1, system: '明确契约', input: '完整输入', maxTokens: 3000, response: '合法返回', error: '',
    allowedRefs: [], missingRefs: [], elapsedMs: 10 }]
  await verify(check, '真实成功产物原子落盘，保存固定任务和原截止且禁止跨任务复用', async (artifacts, dataDir) => {
    let guards = 0
    const store = artifacts.createTaskArtifactStore({ taskId: 'fixed-task', channelKey: 'group-A', deadlineMs: 600000, now: () => 1000, assertLease() {}, assertActive() { guards++ } })
    store.onUnitCompleted(unit, attempts, { topics: [{ sourceIds: [1, 2], summary: '已验证事实' }] })
    const files = jsonFiles(dataDir)
    assert.equal(files.length, 1)
    assert(files[0].endsWith('.success.json'))
    const value = JSON.parse(fs.readFileSync(files[0], 'utf8'))
    assert.equal(value.taskId, 'fixed-task'); assert.equal(value.deadlineMs, 600000)
    assert.equal(value.success, true); assert.equal(value.crossTaskReusable, false)
    assert.deepEqual(value.unit.sourceIds, [1, 2]); assert.deepEqual(value.attempts, attempts)
    assert.equal(value.result.topics[0].summary, '已验证事实')
    assert(guards >= 3)
  })
  await verify(check, '失败材料与成功文件分开，凭据脱敏且受控截断明确标记', async (artifacts, dataDir) => {
    const store = artifacts.createTaskArtifactStore({ taskId: 'failed-task', channelKey: 'group-A', deadlineMs: 600000, now: () => 700000, assertLease() {}, assertActive() { throw new Error('旧任务已失败') } })
    store.onUnitFailed(unit, [{ ...attempts[0], input: 'apiKey=sk-private-secret', response: 'token=private ' + '原始坏返回'.repeat(12000) }])
    const files = jsonFiles(dataDir)
    assert.equal(files.length, 1); assert(files[0].endsWith('.failure.json'))
    const text = fs.readFileSync(files[0], 'utf8')
    assert(!text.includes('sk-private-secret')); assert(!text.includes('token=private'))
    const value = JSON.parse(text)
    assert.equal(value.attempts[0].diagnosticTextTruncated, true)
    assert(!('result' in value)); assert.equal(value.success, false)
  })
  await verify(check, '原截止或取消在保存前拒绝，超大成功产物不落盘', async (artifacts, dataDir) => {
    const cancelled = artifacts.createTaskArtifactStore({ taskId: 'cancelled', channelKey: 'group-A', deadlineMs: 600000, now: () => 1000, assertLease() {}, assertActive() { throw new Error('任务已取消') } })
    assert.throws(() => cancelled.onUnitCompleted(unit, attempts, {}), /任务已取消/)
    const large = artifacts.createTaskArtifactStore({ taskId: 'large', channelKey: 'group-A', deadlineMs: 600000, now: () => 1000, assertLease() {}, assertActive() {} })
    assert.throws(() => large.onUnitCompleted(unit, attempts, { text: '长'.repeat(200000) }), /单文件上限/)
    assert.equal(jsonFiles(dataDir).length, 0)
  })
  await verify(check, '原子rename失败只留下临时文件，不生成成功产物或完成记录', async (artifacts, dataDir) => {
    const store = artifacts.createTaskArtifactStore({ taskId: 'rename-failure', channelKey: 'group-A', deadlineMs: 600000, now: () => 1000, assertLease() {}, assertActive() {} })
    const rename = fs.renameSync
    fs.renameSync = () => { throw new Error('模拟原子rename失败') }
    try { assert.throws(() => store.onUnitCompleted(unit, attempts, {}), /原子rename失败/) } finally { fs.renameSync = rename }
    assert.equal(jsonFiles(dataDir).length, 0)
  })
}

module.exports = { runAnalysisArtifactTests }
