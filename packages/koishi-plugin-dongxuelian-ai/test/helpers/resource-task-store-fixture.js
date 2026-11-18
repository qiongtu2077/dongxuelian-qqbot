const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const store = require('../../lib/resource-workers/task-store')
const { TASKS_ROOT, WORKERS_ROOT, getTaskFile, getWorkerEventFile } = require('../../lib/resource-workers/task-paths')

const CREATED_AT = '2026-01-02T00:00:00.000Z'

// --- 任务文件夹具 --- #

// 在隔离数据目录写入指定的真实任务副本。
function writeTask(id, status, fields = {}) {
  const task = {
    id, status, kind: 'dashboard_agent', source: 'fixture', channelKey: '', userId: '',
    priority: 50, createdAt: CREATED_AT, updatedAt: CREATED_AT, expiresAt: '', timeoutMs: 1000,
    payload: {}, notify: {}, ...fields,
  }
  const file = getTaskFile(status, task.kind, id)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(task))
  return file
}

// 记录操作真正读取的任务正文，并在离开夹具时恢复文件读取函数。
function observeTaskReads(run) {
  const original = fs.readFileSync
  const reads = []
  fs.readFileSync = function recordTaskRead(file, ...args) {
    if (typeof file === 'string' && file.startsWith(TASKS_ROOT + path.sep) && file.endsWith('.json')) reads.push(file)
    return original.call(fs, file, ...args)
  }
  try {
    return { result: run(), reads }
  } finally {
    fs.readFileSync = original
  }
}

// --- 按编号直查 --- #

// 用两千份完成记录量化点查命中、缺失和已知类型查询的读盘次数。
function measureTaskLookup() {
  for (let index = 0; index < 2000; index++) {
    writeTask(`history-${String(index).padStart(4, '0')}`, 'done')
  }
  const hit = observeTaskReads(() => store.getResourceTaskById('history-1000'))
  const miss = observeTaskReads(() => store.getResourceTaskById('history-missing'))
  const typed = observeTaskReads(() => store.getResourceTaskByIdForKind('history-1000', 'dashboard_agent'))
  assert.equal(hit.result?.id, 'history-1000')
  assert.equal(miss.result, null)
  assert.equal(typed.result?.id, 'history-1000')
  return { hitReads: hit.reads.length, missReads: miss.reads.length, typedReads: typed.reads.length }
}

// 验证点查保持状态优先级、待处理顺序以及编号和类型的精确匹配。
function verifyTaskLookupContracts() {
  writeTask('old.custom_ID-01', 'done')
  assert.equal(store.getResourceTaskById('old.custom_ID-01')?.status, 'done')
  assert.equal(store.getResourceTaskById('old.custom/ID-01'), null)
  assert.equal(store.getResourceTaskByIdForKind('old.custom/ID-01', 'dashboard_agent'), null)

  writeTask('duplicate', 'pending')
  writeTask('duplicate', 'done')
  writeTask('duplicate', 'cancelled')
  assert.equal(store.getResourceTaskById('duplicate')?.status, 'cancelled')
  assert.equal(store.getResourceTaskByIdForKind('duplicate', 'dashboard_agent', ['done'])?.status, 'done')
  assert.equal(store.getResourceTaskByIdForKind('duplicate', 'daily_report'), null)
  assert.equal(store.cancelTaskWithResult('duplicate').code, 'TASK_ID_CONFLICT')
  assert.equal(store.cancelTaskWithResult('old.custom_ID-01').code, 'TASK_NOT_CANCELLABLE')
  assert.equal(store.cancelTaskWithResult('absent').code, 'TASK_NOT_FOUND')

  writeTask('same-pending', 'pending', { kind: 'alpha', priority: 10 })
  writeTask('same-pending', 'pending', { kind: 'beta', priority: 10 })
  writeTask('same-pending', 'pending', { kind: 'earlier', priority: 10, createdAt: '2026-01-01T00:00:00.000Z' })
  writeTask('same-pending', 'pending', { kind: 'first', priority: 1 })
  writeTask('unrelated-pending', 'pending', { kind: 'alpha', priority: 1 })
  const pending = observeTaskReads(() => store.getResourceTaskById('same-pending'))
  assert.equal(pending.result?.kind, 'first')
  assert.equal(pending.reads.length, 4)
  assert(pending.reads.every(file => path.basename(file) === 'same-pending.json'))
  fs.unlinkSync(getTaskFile('pending', 'first', 'same-pending'))
  assert.equal(store.getResourceTaskById('same-pending')?.kind, 'earlier')
  fs.unlinkSync(getTaskFile('pending', 'earlier', 'same-pending'))
  assert.equal(store.getResourceTaskById('same-pending')?.kind, 'alpha')
  assert.deepEqual(store.cancelTaskWithResult('unrelated-pending'), { ok: true })
  assert.equal(store.getResourceTaskById('unrelated-pending')?.status, 'cancelled')

  fs.writeFileSync(writeTask('bad-json', 'done'), '{invalid')
  assert.equal(store.getResourceTaskById('bad-json'), null)
  writeTask('mismatched-name', 'done', { id: 'different-id' })
  assert.equal(store.getResourceTaskById('mismatched-name'), null)
  assert.equal(store.getResourceTaskById('different-id'), null)
  const dir = getTaskFile('done', 'dashboard_agent', 'not-a-file')
  fs.mkdirSync(dir)
  assert.deepEqual(observeTaskReads(() => store.getResourceTaskById('not-a-file')), { result: null, reads: [] })

  // 记录刚迁移时文件所在目录先变化，正文仍可能保留迁移前状态。
  writeTask('during-rename', 'claiming', { status: 'pending' })
  assert.equal(store.getResourceTaskByIdForKind('during-rename', 'dashboard_agent', ['claiming'])?.status, 'pending')
  const disappearing = writeTask('disappearing', 'done')
  const original = fs.readFileSync
  fs.readFileSync = function removeBeforeRead(file, ...args) {
    if (file === disappearing) fs.unlinkSync(disappearing)
    return original.call(fs, file, ...args)
  }
  try {
    assert.equal(store.getResourceTaskById('disappearing'), null)
  } finally {
    fs.readFileSync = original
  }
  return { pendingCandidateReads: pending.reads.length, contractsPassed: true }
}

// --- 原子领取与取消 --- #

// 汇总目标任务对外发布过的事件。
function readTaskEvents(id) {
  return fs.readFileSync(getWorkerEventFile(), 'utf8').trim().split(/\r?\n/)
    .map(line => JSON.parse(line)).filter(row => row.taskId === id)
}

// 观察同一个待处理文件后，双方在发布各自的互斥所有权前等待对方。
function runRaceParticipant() {
  const [action, taskId, barrier] = process.argv.slice(2)
  const kind = 'dashboard_agent'
  const lock = path.join(WORKERS_ROOT, 'task-transitions', `${taskId}.lock`)
  assert.equal(store.getResourceTaskByIdForKind(taskId, kind, ['pending'])?.status, 'pending')
  const original = fs.renameSync
  fs.renameSync = function awaitBothClaimants(source, target) {
    if (target === lock) {
      if (action === 'crash') {
        original.call(fs, source, target)
        process.exit(17)
      }
      process.send({ ready: true })
      const sleep = new Int32Array(new SharedArrayBuffer(4))
      const deadline = Date.now() + 5000
      while (!fs.existsSync(barrier)) {
        assert(Date.now() < deadline, 'both processes must reach the same task lock')
        Atomics.wait(sleep, 0, 0, 5)
      }
    }
    return original.call(fs, source, target)
  }
  const worker = `fixture-${process.pid}`
  const result = action === 'cancel'
    ? store.cancelTaskWithResult(taskId, worker)
    : store.claimTaskById(taskId, worker, kind)
  process.send({ result }, () => process.disconnect())
}

// 启动两个独立执行进程，等待双方到达屏障后验证唯一状态副本。
async function raceTaskTransitions(taskId, actions) {
  writeTask(taskId, 'pending')
  const barrier = path.join(TASKS_ROOT, `${taskId}.barrier`)
  let ready = 0
  const results = await Promise.all(actions.map(action => new Promise((resolve, reject) => {
    const child = fork(__filename, [action, taskId, barrier])
    let result
    child.on('message', message => {
      if (message.ready) {
        ready++
        if (ready === actions.length) fs.writeFileSync(barrier, '')
      } else {
        result = message.result
      }
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code !== 0 || result === undefined) reject(new Error(`race child failed: code=${code} signal=${signal}`))
      else resolve(result)
    })
  })))
  assert.equal(ready, actions.length)
  const states = ['pending', 'claiming', 'running', 'done', 'failed', 'cancelled', 'deferred']
    .filter(status => fs.existsSync(getTaskFile(status, 'dashboard_agent', taskId)))
  assert.equal(states.length, 1)
  assert.notEqual(states[0], 'pending')
  return { results, events: readTaskEvents(taskId), status: states[0] }
}

// 检验双方都争夺同一互斥，任务文件和成功事件只有一个。
async function verifyTaskClaimRaces() {
  const claim = await raceTaskTransitions('race-claim', ['claim', 'claim'])
  assert.equal(claim.results.filter(Boolean).length, 1)
  assert.equal(claim.status, 'claiming')
  assert.equal(claim.events.filter(row => row.event === 'task_claimed').length, 1)
  assert.equal(claim.events[0].workerName, claim.results.find(Boolean).claimedBy)

  const cancel = await raceTaskTransitions('race-cancel', ['claim', 'cancel'])
  const [claimed, cancelled] = cancel.results
  assert.equal(Number(Boolean(claimed)) + Number(cancelled.ok), 1)
  assert.equal(cancel.status, claimed ? 'claiming' : 'cancelled')
  assert.equal(cancel.events.filter(row => row.event === 'task_claimed' || row.event === 'task_cancelled').length, 1)
  if (!cancelled.ok) assert(['TASK_TRANSITION_FAILED', 'TASK_ID_CONFLICT'].includes(cancelled.code))
  return { claimWinner: claim.status, claimEvents: claim.events.length, cancelWinner: cancel.status, cancelEvents: cancel.events.length }
}

// 用真实退出的持有者验证下一次领取能回收遗留互斥。
async function verifyTaskClaimRecovery() {
  const id = 'crashed-claim'
  const pending = writeTask(id, 'pending')
  const lock = path.join(WORKERS_ROOT, 'task-transitions', `${id}.lock`)
  await new Promise((resolve, reject) => {
    const child = fork(__filename, ['crash', id])
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 17) resolve()
      else reject(new Error(`lock owner did not exit at the planned point: ${code}`))
    })
  })
  assert(fs.existsSync(lock))
  assert(fs.existsSync(pending))
  assert.equal(store.claimTaskById(id, 'recovery-worker', 'dashboard_agent')?.status, 'claiming')
  assert.equal(fs.existsSync(lock), false)
  assert.equal(readTaskEvents(id).filter(row => row.event === 'task_claimed').length, 1)
  return { recovered: true }
}

// 检验已知类型的读取量、两参数兼容和队列领取顺序。
function verifyTaskClaimContracts() {
  writeTask('typed', 'pending')
  for (let index = 0; index < 25; index++) writeTask(`other-${index}`, 'pending')
  assert.equal(store.claimTaskById('typed', 'wrong-worker', 'wrong_kind'), null)
  const typed = observeTaskReads(() => store.claimTaskById('typed', 'typed-worker', 'dashboard_agent'))
  assert.equal(typed.result?.id, 'typed')
  assert.deepEqual(typed.reads, [getTaskFile('pending', 'dashboard_agent', 'typed')])

  writeTask('legacy-claim', 'pending', { kind: 'queue_b', priority: 20 })
  writeTask('legacy-claim', 'pending', { kind: 'queue_a', priority: 10 })
  assert.equal(store.claimTaskById('legacy-claim', 'legacy-worker')?.kind, 'queue_a')
  assert.equal(store.claimTaskById('legacy-claim', 'conflicting-worker', 'queue_b'), null)
  writeTask('queue-slow', 'pending', { kind: 'queue_order', priority: 50 })
  writeTask('queue-later', 'pending', { kind: 'queue_order', priority: 20 })
  writeTask('queue-first', 'pending', { kind: 'queue_order', priority: 20, createdAt: '2026-01-01T00:00:00.000Z' })
  writeTask('queue-terminal', 'pending', { kind: 'queue_order', priority: 1 })
  writeTask('queue-terminal', 'done', { kind: 'queue_order' })
  assert.equal(store.claimNextTask('queue_order', 'queue-worker')?.id, 'queue-first')
  assert.equal(store.claimNextTask('queue_order', 'queue-worker')?.id, 'queue-later')
  assert.equal(store.claimTaskById('queue-terminal', 'terminal-worker', 'queue_order'), null)
  fs.writeFileSync(writeTask('bad-claim', 'pending'), '{}')
  assert.equal(store.claimTaskById('bad-claim', 'bad-worker', 'dashboard_agent'), null)
  const requeueing = writeTask('requeueing', 'pending', { status: 'deferred' })
  assert.equal(store.claimTaskById('requeueing', 'early-worker', 'dashboard_agent'), null)
  assert(fs.existsSync(requeueing))
  return { typedReads: typed.reads.length, contractsPassed: true }
}

// 模拟 Agent 的竞争者先领取同一已落盘任务，验证失败的一方不会进入运行或执行任务。
async function verifyAgentLosesClaim() {
  const admission = require('../../lib/resource-scheduler/admission')
  const originalAdmit = admission.admitTask
  const originalClaim = store.claimTaskById
  const originalMark = store.markTaskRunning
  let claimArgs
  let winner
  let touchedRunning = false
  admission.admitTask = () => ({ decision: 'run_now' })
  store.claimTaskById = (...args) => {
    claimArgs = args
    const [submitted] = store.listResourceTasks({ statuses: ['pending'], limit: 1 })
    winner = originalClaim(submitted.id, 'other-owner', submitted.kind)
    return originalClaim(...args)
  }
  store.markTaskRunning = function recordUnexpectedMark(...args) {
    touchedRunning = true
    return originalMark(...args)
  }
  try {
    const { runAgentWithResourceGate } = require('../../lib/agent/resource-execution')
    await assert.rejects(runAgentWithResourceGate({
      channel: 'dashboard', channelKey: 'fixture'.repeat(28), userId: 'inline-user',
      run() { assert.fail('Agent must not run after losing the claim') },
    }), /resource task did not enter running/)
    assert.equal(claimArgs[0], winner?.id)
    assert.equal(claimArgs[2], 'dashboard_agent')
    assert.equal(touchedRunning, false)
    assert.equal(store.getResourceTaskById(winner.id)?.claimedBy, 'other-owner')
    assert.equal(store.getResourceTaskById(winner.id)?.status, 'claiming')
    assert.equal(readTaskEvents(winner.id).filter(row => row.event === 'task_running').length, 0)
    return { untouchedWinner: true }
  } finally {
    admission.admitTask = originalAdmit
    store.claimTaskById = originalClaim
    store.markTaskRunning = originalMark
  }
}

if (require.main === module) runRaceParticipant()

module.exports = { measureTaskLookup, verifyTaskLookupContracts, verifyTaskClaimRaces, verifyTaskClaimRecovery, verifyTaskClaimContracts, verifyAgentLosesClaim }
