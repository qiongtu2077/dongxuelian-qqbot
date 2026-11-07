'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')
const { PassThrough } = require('stream')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-deploy-progress-'))
const oldDataDir = process.env.DONGXUELIAN_AI_DATA_DIR
const oldLocalMode = process.env.GLOBAL_LOCAL_MODE
process.env.DONGXUELIAN_AI_DATA_DIR = dataDir
process.env.GLOBAL_LOCAL_MODE = '1'
const routePath = require.resolve('../lib/routes/deploy')
const remoteRelease = require('../lib/remote-release')
const originalValidate = remoteRelease.validateRemoteReleasePreview
const originalLoad = Module._load
const commands = []
let remoteResult = null
let remoteReads = 0
let deployRoutes
let passed = 0
const manifestHash = 'a'.repeat(64)
const contentHash = 'b'.repeat(64)

// --- SSH 与冻结发布物夹具 ---

// Capture only the route's external SSH execution while retaining its real task persistence and handlers.
Module._load = function load(request, parent, isMain) {
  const loaded = originalLoad.call(this, request, parent, isMain)
  if (request !== 'child_process' || parent.filename !== routePath) return loaded
  return {
    ...loaded,
    // Keep activation callbacks pending so progress polling can race with a late SSH completion.
    exec(command, options, callback) { commands.push({ command, options, callback }) },
    // Model the target's durable result or an interrupted SSH connection.
    execSync(command) {
      assert(command.includes('.remote.json'), 'unexpected route shell command')
      remoteReads += 1
      if (remoteResult instanceof Error) throw remoteResult
      return JSON.stringify(remoteResult)
    },
  }
}
try { deployRoutes = require(routePath) } finally { Module._load = originalLoad }

// Supply an already validated frozen release; preview security is covered by remote-release-test.js.
remoteRelease.validateRemoteReleasePreview = function validate(options) {
  assert.strictEqual(options.confirmed, true)
  return {
    previewId: 'fixture-preview',
    target: { server: 'root@example.invalid', requestedAppDir: '/srv/app', release: { manifestHash: 'c'.repeat(64) } },
    release: { releaseId: 'fixture-release', releaseDir: path.join(dataDir, 'frozen'), commit: 'd'.repeat(40), manifestHash, contentHash },
  }
}

// --- HTTP 与持久任务操作 ---

// Exercise the real authorized route and collect its JSON response through a fake HTTP stream.
function callRoute(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const handler = deployRoutes.routes[`${method} ${pathname}`] || deployRoutes.prefixRoutes.find(route => route.method === method && pathname.startsWith(route.prefix))?.handler
    assert(handler, `missing route ${method} ${pathname}`)
    const req = new PassThrough()
    req.method = method
    req.url = pathname
    req.headers = { host: '127.0.0.1:5150', origin: 'http://127.0.0.1:5150', 'content-type': 'application/json' }
    req.socket = { remoteAddress: '127.0.0.1' }
    req.connection = req.socket
    const res = {
      statusCode: 200,
      setHeader() {},
      writeHead(status) { this.statusCode = status },
      end(text) {
        try {
          assert.strictEqual(this.statusCode, 200, text)
          resolve(JSON.parse(text))
        } catch (error) { reject(error) }
      },
    }
    try {
      handler(req, res, pathname, new URL('http://127.0.0.1:5150' + pathname))
      req.end(body === undefined ? '' : JSON.stringify(body))
    } catch (error) { reject(error) }
  })
}

// Read the exact durable record used by the deployed progress endpoint.
function readTask(taskId) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'deploy-tasks', taskId + '.json'), 'utf8'))
}

// Seed legacy failure or deadline metadata without replacing the production state transition logic.
function updateTask(taskId, update) {
  const file = path.join(dataDir, 'deploy-tasks', taskId + '.json')
  fs.writeFileSync(file, JSON.stringify({ ...readTask(taskId), ...update }))
}

// Create a real task and complete preparation, upload and verification while retaining activation's callback.
async function startTask() {
  assert.strictEqual(commands.length, 0, 'previous SSH callback leaked')
  remoteResult = new Error('SSH result unavailable')
  const started = await callRoute('POST', '/dashboard/api/deploy/run', { previewId: 'fixture-preview', confirmed: true })
  for (let index = 0; index < 3; index += 1) {
    const command = commands.shift()
    assert(command, 'preparation did not advance')
    command.callback(null, '', '')
  }
  const activation = commands.shift()
  assert(activation.command.includes('systemd-run'))
  assert(activation.command.includes('--no-block'), 'activation still waits for oneshot completion')
  assert.strictEqual(activation.options.timeout, 30000)
  return { taskId: started.taskId, activation }
}

// Build a target-side result matching this task's frozen release identity.
function result(state, fields = {}) {
  return { state, stage: state === 'success' ? 'complete' : 'stability_wait', releaseId: 'fixture-release', manifestHash, contentHash, rolledBack: false, rollbackState: 'not_needed', ...fields }
}

// Poll the actual progress handler once; no timers or network operations are replaced inside the handler.
function progress(taskId) {
  return callRoute('GET', '/dashboard/api/deploy/progress/' + taskId)
}

// --- 部署回执回归 ---

// Verify a slow activation remains running and later records exact remote success.
async function testSlowActivation() {
  const { taskId, activation } = await startTask()
  activation.callback(null, '', '')
  updateTask(taskId, { startedAt: Date.now() - 35000 })
  remoteResult = result('running')
  assert.strictEqual((await progress(taskId)).state, 'running')
  remoteResult = result('success')
  assert.strictEqual((await progress(taskId)).state, 'success')
  assert.strictEqual(readTask(taskId).remoteResultConfirmed, true)
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'deploy-config.json'), 'utf8')).releaseManifestHash, manifestHash)
  passed += 1
}

// Verify a timed-out or disconnected startup command waits for confirmation and is never retried.
async function testDisconnectedActivation() {
  const { taskId, activation } = await startTask()
  activation.callback(Object.assign(new Error('SSH startup timed out'), { killed: true, signal: 'SIGTERM' }), '', '')
  const waiting = await progress(taskId)
  assert.strictEqual(waiting.state, 'running')
  assert.strictEqual(waiting.stage, 'awaiting_remote_result')
  assert.strictEqual(waiting.error, '')
  assert(waiting.warnings.some(warning => warning.includes('activation_start_unconfirmed')))
  remoteResult = result('success')
  assert.strictEqual((await progress(taskId)).state, 'success')
  assert.strictEqual(commands.length, 0, 'startup was repeated after an uncertain SSH result')
  passed += 1
}

// Verify legacy false failures and local deadlines reconcile with authoritative remote results.
async function testLegacyAndDeadlineRecovery() {
  for (const expired of [false, true]) {
    const { taskId, activation } = await startTask()
    activation.callback(null, '', '')
    updateTask(taskId, { state: 'failed', stage: expired ? 'timeout' : 'start_detached_activation', error: 'Command failed: ssh systemd-run', finishedAt: Date.now() - 820, ...(expired ? { expiresAt: Date.now() - 1 } : {}) })
    remoteResult = result('success')
    const recovered = await progress(taskId)
    assert.strictEqual(recovered.state, 'success')
    assert.strictEqual(recovered.error, '')
    passed += 1
  }
  const { taskId, activation } = await startTask()
  activation.callback(null, '', '')
  updateTask(taskId, { expiresAt: Date.now() - 1 })
  assert.strictEqual((await progress(taskId)).stage, 'timeout')
  remoteResult = result('running')
  assert.strictEqual((await progress(taskId)).state, 'failed', 'running target result bypassed the overall deadline')
  remoteResult = result('success')
  assert.strictEqual((await progress(taskId)).state, 'success')
  passed += 1
}

// Verify late SSH callbacks cannot overwrite confirmed success or a genuine completed rollback.
async function testLateCallbacksAndRollback() {
  for (const state of ['success', 'failed']) {
    const { taskId, activation } = await startTask()
    remoteResult = result(state, state === 'failed' ? { stage: 'stability_check', error: 'release activation failed at stability_check (exit 1)', rolledBack: true, rollbackState: 'success' } : {})
    const before = await progress(taskId)
    assert.strictEqual(before.state, state)
    const raw = fs.readFileSync(path.join(dataDir, 'deploy-tasks', taskId + '.json'), 'utf8')
    activation.callback(state === 'success' ? new Error('late SSH timeout') : null, '', '')
    assert.strictEqual(fs.readFileSync(path.join(dataDir, 'deploy-tasks', taskId + '.json'), 'utf8'), raw)
    const reads = remoteReads
    const after = await progress(taskId)
    assert.strictEqual(after.state, state)
    assert.strictEqual(remoteReads, reads, 'confirmed terminal result was polled again')
    if (state === 'failed') {
      assert.strictEqual(after.rolledBack, true)
      assert.strictEqual(after.rollbackState, 'success')
      assert(after.error.includes('stability_check'))
    }
    passed += 1
  }
}

// Reject foreign, incomplete and malformed success receipts while preserving the expected release identity.
async function testReceiptIdentity() {
  for (const fields of [{ releaseId: 'other-release' }, { manifestHash: '0'.repeat(64) }, { contentHash: '0'.repeat(64) }, { manifestHash: '' }, { state: 'unknown' }]) {
    const { taskId, activation } = await startTask()
    activation.callback(null, '', '')
    remoteResult = result('success', fields)
    const rejected = await progress(taskId)
    assert.strictEqual(rejected.state, 'running')
    assert(rejected.warnings.some(warning => warning.includes('remote_result_identity_mismatch')))
    assert.strictEqual(readTask(taskId).releaseId, 'fixture-release')
    assert.strictEqual(readTask(taskId).manifestHash, manifestHash)
    remoteResult = result('success')
    assert.strictEqual((await progress(taskId)).state, 'success')
    passed += 1
  }
  const { taskId, activation } = await startTask()
  activation.callback(null, '', '')
  remoteResult = result('failed', { stage: 'lock', manifestHash: '', contentHash: '', error: 'another release owns deploy.lock' })
  const failed = await progress(taskId)
  assert.strictEqual(failed.state, 'failed')
  assert.strictEqual(failed.stage, 'lock')
  assert.strictEqual(readTask(taskId).remoteResultConfirmed, true)
  passed += 1
}

// Keep a confirmed successful deployment successful when recording secondary local config metadata fails.
async function testReleaseRecordFailure() {
  const { taskId, activation } = await startTask()
  activation.callback(null, '', '')
  const blockedFile = path.join(dataDir, 'deploy-config.json.tmp')
  fs.mkdirSync(blockedFile)
  try {
    remoteResult = result('success')
    const completed = await progress(taskId)
    assert.strictEqual(completed.state, 'success')
    assert(completed.warnings.some(warning => warning.includes('release_record_write_failed')))
    passed += 1
  } finally { fs.rmdirSync(blockedFile) }
}

// Run the real route regressions with isolated files and restore every replaced dependency and environment value.
async function main() {
  try {
    await testSlowActivation()
    await testDisconnectedActivation()
    await testLegacyAndDeadlineRecovery()
    await testLateCallbacksAndRollback()
    await testReceiptIdentity()
    await testReleaseRecordFailure()
    assert.strictEqual(commands.length, 0)
    console.log(`deployment progress route tests: ${passed} passed`)
  } finally {
    remoteRelease.validateRemoteReleasePreview = originalValidate
    if (oldDataDir === undefined) delete process.env.DONGXUELIAN_AI_DATA_DIR
    else process.env.DONGXUELIAN_AI_DATA_DIR = oldDataDir
    if (oldLocalMode === undefined) delete process.env.GLOBAL_LOCAL_MODE
    else process.env.GLOBAL_LOCAL_MODE = oldLocalMode
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
