/** 后台总账真实文件、重启、预留上限与落盘中断；不调用外部模型。 */
'use strict'
const assert = require('assert').strict, fs = require('fs'), path = require('path'), { spawn, spawnSync } = require('child_process')
const { withPagedStoreFixture, listPagedStoreFiles } = require('./helpers/report-store-fixture')
const { reportCacheDigest: digest } = require('../lib/report-cache-provenance')
const ledgerPath = require.resolve('../lib/report-background-ledger')
const usage = { readable: true, promptTokens: 100, completionTokens: 20, totalTokens: 120 }

// 两个独立进程必须实际争取S0；输出只保留计数，不依赖内存互斥模拟。
function runLedgerGateProcess(root, mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'helpers/background-ledger-gate-fixture.js'), root, mode], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DONGXUELIAN_AI_DATA_DIR: root, RESOURCE_WORKER_SUPERVISOR_ENABLED: '0' } })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => child.kill(), 30000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', status => {
      clearTimeout(timer)
      try { assert.equal(status, 0, stderr || stdout); resolve(JSON.parse(stdout.trim().split(/\r?\n/).at(-1))) } catch (error) { reject(error) }
    })
  })
}

// 每轮测试使用独立存储根和当前公共节点契约，凭据只在隔离API子进程使用虚构值。
async function ledgerCase(check, name, run) {
  try {
    await withPagedStoreFixture(async fixture => {
      fixture.state.now = Date.parse('2026-10-06T12:00:00+08:00')
      const previous = require.cache[ledgerPath]
      delete require.cache[ledgerPath]
      const module = require(ledgerPath)
      const node = model => ({ routeIdentity: digest(model), routeRevision: digest('revision-' + model), provider: 'test', model, protocol: 'openai-chat' })
      const policy = { identity: digest('background-policy'), first: node('primary'), recovery: node('backup') }
      const step = attempt => ({ ...(attempt === 1 ? policy.first : policy.recovery), stepIndex: 0, priorityIndex: 0, configurationIdentity: digest('config-' + attempt) })
      const task = (id, channel = 'group-A', foreground = () => false) => {
        const store = fixture.store(id, channel, 90000)
        const ledger = new module.ReportBackgroundLedger({ store, startedAtMs: fixture.state.now, unitIdentity: digest('unit-' + id), policy, hasForegroundPending: foreground })
        return { store, ledger, first: () => ledger.reserve(1, digest('request-1'), step(1)), second: () => ledger.reserve(2, digest('request-2'), step(2)) }
      }
      try { await run({ ...fixture, ...module, policy, step, task, initialize: () => module.provisionReportBackgroundLedger(fixture.store('first-enable')) }) }
      finally { if (previous) require.cache[ledgerPath] = previous; else delete require.cache[ledgerPath] }
    })
    check(name, true)
  } catch (error) { check(name, false, error.stack || String(error)) }
}

// 原子预留属于必要计额，未知结果保留占额，不能借重建对象重复首轮。
async function runReportBackgroundLedgerTests(check) {
  await ledgerCase(check, '后台调度先持久化且不占请求额度，同群重启和失败提交保留五分钟间隔', f => {
    f.initialize()
    const first = f.task('scheduled'), state = first.ledger.schedulingState()
    assert.deepEqual(state, { allowed: true, reason: '', lastScheduledAtMs: null })
    first.ledger.recordSchedule()
    assert.equal(first.ledger.snapshot().globalUsed, 0)
    assert.equal(f.task('after-restart').ledger.schedulingState().reason, 'cooldown')
    assert.throws(() => f.task('after-restart').first(), error => error.code === 'cooldown')
    assert.doesNotThrow(first.first)
    assert.equal(first.ledger.snapshot().globalUsed, 1)
    f.state.now += 300000
    assert.equal(f.task('unknown-stop').ledger.schedulingState().reason, 'unresolved')
    assert.equal(f.task('other', 'group-B').ledger.schedulingState().allowed, true)
  })
  await ledgerCase(check, '调度跨四点仍保留未发请求间隔，五分钟后可再调度且总账不归零', f => {
    f.state.now = Date.parse('2026-10-07T03:59:00+08:00'); f.initialize()
    f.task('before-boundary').ledger.recordSchedule()
    f.state.now += 120000
    assert.equal(f.task('after-boundary').ledger.schedulingState().reason, 'cooldown')
    f.state.now += 180000
    const next = f.task('after-interval')
    assert.equal(next.ledger.schedulingState().allowed, true)
    next.ledger.recordSchedule()
    assert.equal(next.ledger.snapshot().globalUsed, 0)
    assert.doesNotThrow(next.first)
  })
  await ledgerCase(check, '后台调度落盘失败不授权提交，旧日账及伪造调度时刻不会被归零', f => {
    f.initialize(); const job = f.task('schedule-failure'), rename = fs.renameSync
    fs.renameSync = (from, to) => { if (String(to).endsWith('day-2026-10-06.json')) throw new Error('schedule disk failure'); return rename(from, to) }
    try { assert.throws(() => job.ledger.recordSchedule(), /schedule disk failure/) } finally { fs.renameSync = rename }
    assert.equal(job.ledger.schedulingState().allowed, true)
    const key = { kind: 'day', date: '2026-10-06' }, control = job.store.readPreanalysisControl(key)
    job.store.writePreanalysisControl(key, control.identity, { ...control.value, version: 'background-ledger-day-1' })
    assert.throws(() => job.ledger.schedulingState(), error => error.code === 'untrusted')
  })
  await ledgerCase(check, '后台运行不自动建零账，显式首次建账且禁止再次清零', fixture => {
    assert.throws(() => fixture.task('not-ready').first(), error => error.code === 'not_initialized')
    assert.equal(listPagedStoreFiles(fixture.root).length, 0)
    fixture.initialize()
    assert.throws(fixture.initialize, error => error.code === 'already_initialized')
    const job = fixture.task('first-job'), reservation = job.first()
    assert.equal(job.ledger.snapshot().groupUsed, 1); assert.equal(job.ledger.snapshot().unresolved, 1)
    const restarted = new fixture.ReportBackgroundLedger({ store: job.store, startedAtMs: fixture.state.now,
      unitIdentity: digest('unit-first-job'), policy: fixture.policy, hasForegroundPending: () => false })
    assert.throws(() => restarted.reserve(1, digest('request-1'), fixture.step(1)), error => error.code === 'task_limit')
    const before = job.store.readPreanalysisControl({ kind: 'day', date: reservation.date })
    assert.equal(before.retainUntilMs, before.createdAtMs + 7 * 86400000)
    fixture.state.now++
    job.ledger.settle(reservation, 'returned', usage)
    const after = job.store.readPreanalysisControl({ kind: 'day', date: reservation.date })
    assert.equal(after.createdAtMs, before.createdAtMs); assert.equal(after.retainUntilMs, before.retainUntilMs)
    job.ledger.settle(reservation, 'returned', usage)
    assert.equal(job.ledger.snapshot().groupUsed, 1); assert.equal(job.ledger.snapshot().unresolved, 0)
    assert.throws(() => job.ledger.settle(reservation, 'failed', null), /不能改写历史结果/)
    const second = job.second(); job.ledger.settle(second, 'failed', null)
    assert.equal(job.ledger.snapshot().groupUsed, 2)
    assert.throws(job.second, error => error.code === 'task_limit')
  })
  await ledgerCase(check, '后台单群二十次及全局八十次硬上限跨实例/失败/未知均计额', fixture => {
    fixture.initialize()
    for (let group = 0; group < 4; group++) {
      for (let index = 0; index < 10; index++) {
        const job = fixture.task('budget-' + group + '-' + index, 'group-' + group), first = job.first()
        job.ledger.settle(first, index % 2 ? 'failed' : 'returned', index % 2 ? null : usage)
        const second = job.second()
        if (index % 2) job.ledger.settle(second, 'cancelled', null)
        fixture.state.now += 300000
      }
      const capped = fixture.task('capped-' + group, 'group-' + group)
      assert.equal(capped.ledger.snapshot().groupUsed, 20)
      assert.throws(capped.first, error => error.code === (group === 3 ? 'global_limit' : 'group_limit'))
    }
    const nextGroup = fixture.task('global-capped', 'new-group')
    assert.equal(nextGroup.ledger.snapshot().globalUsed, 80)
    assert.throws(nextGroup.first, error => error.code === 'global_limit')
    assert(listPagedStoreFiles(fixture.root).every(file => fs.statSync(file).size <= 256 * 1024))
  })
  await ledgerCase(check, '前台到达前后两次检查都禁止后台预留，五分钟间隔只约束新任务', fixture => {
    fixture.initialize()
    assert.throws(fixture.task('foreground', 'group-A', () => true).first, error => error.code === 'foreground')
    let checks = 0
    assert.throws(fixture.task('foreground-race', 'group-A', () => ++checks > 1).first, error => error.code === 'foreground')
    assert.equal(fixture.task('inspect').ledger.snapshot().globalUsed, 0)
    const first = fixture.task('cooldown-A'); const reservation = first.first(); first.ledger.settle(reservation, 'returned', usage); first.second()
    fixture.state.now += 299999
    assert.throws(fixture.task('cooldown-B').first, error => error.code === 'cooldown')
    fixture.state.now++
    fixture.task('cooldown-C').first()
  })
  await ledgerCase(check, '四点跨日仍保持同任务两请求与五分钟间隔，按实际预留业务日计额', fixture => {
    fixture.state.now = Date.parse('2026-10-07T03:59:50+08:00'); fixture.initialize()
    const job = fixture.task('cross-day'), first = job.first(); job.ledger.settle(first, 'returned', usage)
    fixture.state.now += 20000
    const second = job.second(); job.ledger.settle(second, 'returned', usage)
    assert.notEqual(first.date, second.date); assert.equal(job.ledger.snapshot().globalUsed, 1)
    assert.throws(fixture.task('next-day-too-soon').first, error => error.code === 'cooldown')
    fixture.state.now += 280000
    assert.equal(fixture.task('next-day-ok').ledger.snapshot().globalUsed, 1)
    fixture.task('next-day-ok').first()
  })
  await ledgerCase(check, '锚点已声明的日账丢失或损坏停后台，缺锚点非空账禁止重建', fixture => {
    fixture.initialize(); const job = fixture.task('preserved'); job.first()
    const dayFile = listPagedStoreFiles(fixture.root).find(file => /day-2026-10-06\.json$/.test(file)), dayBytes = fs.readFileSync(dayFile)
    fs.unlinkSync(dayFile)
    assert.throws(() => fixture.task('missing-day').ledger.snapshot(), error => error.code === 'missing_day')
    fs.writeFileSync(dayFile, '{bad')
    assert.throws(() => fixture.task('bad-day').ledger.snapshot(), /总账|存储文件损坏/)
    fs.writeFileSync(dayFile, dayBytes)
    const anchor = listPagedStoreFiles(fixture.root).find(file => file.endsWith('anchor.json'))
    fs.unlinkSync(anchor)
    assert.throws(fixture.initialize, error => error.code === 'untrusted')
    assert.throws(fixture.task('missing-anchor').first, error => error.code === 'not_initialized')
  })
  await ledgerCase(check, '首次建账日文件成功而锚点中断，只显式恢复可信空账且不自动运行', fixture => {
    const rename = fs.renameSync
    fs.renameSync = (from, to) => { if (String(to).endsWith('anchor.json')) throw new Error('模拟锚点写入中断'); return rename(from, to) }
    try { assert.throws(fixture.initialize, /锚点写入中断/) } finally { fs.renameSync = rename }
    assert.throws(fixture.task('interrupted-boot').first, error => error.code === 'not_initialized')
    fixture.initialize()
    assert.equal(fixture.task('after-boot').ledger.snapshot().globalUsed, 0)
  })
  await ledgerCase(check, '租约/取消/原九十秒拒绝预留与结算，未知预留重启不退款', fixture => {
    fixture.initialize(); const job = fixture.task('original-clock'), reservation = job.first()
    fixture.state.leased = false; assert.throws(job.second, /租约已失效/)
    fixture.state.leased = true; fixture.state.alive = false; assert.throws(job.second, /任务已取消/)
    fixture.state.alive = true; fixture.state.now += 90000
    assert.throws(() => job.ledger.settle(reservation, 'cancelled', null), /原任务截止/)
    assert.throws(job.second, /原任务截止/)
    fixture.state.now += 210000
    const restarted = fixture.task('after-crash')
    assert.equal(restarted.ledger.snapshot().groupUsed, 1); assert.equal(restarted.ledger.snapshot().unresolved, 1)
    restarted.first(); assert.equal(restarted.ledger.snapshot().groupUsed, 2)
  })
  await ledgerCase(check, '明确额度失败暂停单群或全局业务日，不改其他群计额', fixture => {
    fixture.initialize(); const job = fixture.task('quota-group'), reservation = job.first()
    job.ledger.settle(reservation, 'failed', null, 'group')
    fixture.state.now += 300000
    assert.throws(fixture.task('group-paused').first, error => error.code === 'paused')
    const other = fixture.task('other-group', 'group-B'), second = other.first()
    other.ledger.settle(second, 'failed', null, 'global')
    assert.throws(fixture.task('global-paused', 'group-C').first, error => error.code === 'paused')
    assert.equal(other.ledger.snapshot().globalUsed, 2)
  })
  await ledgerCase(check, '任务/单元/人物群及节点伪绑不能消费总账，旧身份比较防覆盖', fixture => {
    fixture.initialize(); const job = fixture.task('identity'), altered = { ...fixture.step(1), model: 'not-configured' }
    assert.throws(() => job.ledger.reserve(1, digest('r'), altered), error => error.code === 'contract')
    assert.equal(job.ledger.snapshot().globalUsed, 0)
    const first = job.first()
    const anotherGroup = fixture.task('identity', 'group-B')
    assert.throws(anotherGroup.second, error => error.code === 'task_limit')
    assert.throws(() => anotherGroup.ledger.settle(first, 'returned', usage), error => error.code === 'contract')
    const old = job.store.readPreanalysisControl({ kind: 'day', date: first.date })
    job.ledger.settle(first, 'returned', usage)
    job.second()
    assert.throws(() => job.store.writePreanalysisControl({ kind: 'day', date: first.date }, old.identity, old.value), /不能覆盖较新预留/)
    assert.equal(job.ledger.snapshot().globalUsed, 2)
  })
  await ledgerCase(check, '后台日账七天到期可回收而锚点保留，损坏后台账不污染前台文件写入', fixture => {
    fixture.initialize(); fixture.task('retention').first()
    const anchor = listPagedStoreFiles(fixture.root).find(file => file.endsWith('anchor.json'))
    const day = listPagedStoreFiles(fixture.root).find(file => file.endsWith('day-2026-10-06.json'))
    fixture.state.now += 7 * 86400000 + 1
    fixture.store('foreground-cleanup').commit('unit', { fixture: true }, [], () => {})
    assert(fs.existsSync(anchor)); assert(!fs.existsSync(day))
    const next = fixture.task('fresh-week'); assert.equal(next.ledger.snapshot().globalUsed, 0)
    const current = listPagedStoreFiles(fixture.root).find(file => /day-\d{4}-\d{2}-\d{2}\.json$/.test(file))
    fs.writeFileSync(current, '{bad')
    fixture.store('foreground-unaffected').commit('unit', { fixture: true }, [], () => {})
    assert.throws(next.first, /总账|存储文件损坏/)
  })
  await ledgerCase(check, '真实公共请求边界先落盘后fetch，预留rename失败零新增fetch', fixture => {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'helpers/background-ledger-api-fixture.js'), fixture.root], {
      encoding: 'utf8', timeout: 30000, windowsHide: true, env: { ...process.env, DONGXUELIAN_AI_DATA_DIR: fixture.root, RESOURCE_WORKER_SUPERVISOR_ENABLED: '0' } })
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message)
    const evidence = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1))
    assert.equal(evidence.fetchCalls, 1); assert.equal(evidence.reservedBeforeFetch, true); assert.equal(evidence.persistedRequests, 1)
  })
  await ledgerCase(check, '上一请求未结算不允许后台并发恢复，返回后唯一恢复仍可预留', fixture => {
    fixture.initialize(); const job = fixture.task('in-flight'), reservation = job.first()
    assert.throws(job.second, error => error.code === 'in_flight')
    assert.equal(job.ledger.snapshot().globalUsed, 1)
    job.ledger.settle(reservation, 'returned', usage)
    job.second(); assert.equal(job.ledger.snapshot().globalUsed, 2)
  })
  await ledgerCase(check, '业务日滚动锚点中断不产生请求，重读只能采用既有可信空新日', fixture => {
    fixture.initialize(); const day = fixture.task('before-rollover'), first = day.first(); day.ledger.settle(first, 'returned', usage)
    fixture.state.now = Date.parse('2026-10-07T04:01:00+08:00')
    const next = fixture.task('after-rollover'), rename = fs.renameSync
    fs.renameSync = (from, to) => { if (String(to).endsWith('anchor.json')) throw new Error('模拟滚动锚点中断'); return rename(from, to) }
    try { assert.throws(next.first, /滚动锚点中断/) } finally { fs.renameSync = rename }
    assert.equal(next.ledger.snapshot().globalUsed, 0)
    next.first(); assert.equal(next.ledger.snapshot().globalUsed, 1)
    fixture.state.now = Date.parse('2026-10-06T12:10:00+08:00')
    assert.throws(fixture.task('clock-back').first, error => error.code === 'clock_rewind')
  })
  await ledgerCase(check, '摘要合法但内部超额或重复轮次的账本仍拒绝，不能借结构重建归零', fixture => {
    fixture.initialize(); const job = fixture.task('tampered'), reservation = job.first()
    const key = { kind: 'day', date: reservation.date }, control = job.store.readPreanalysisControl(key)
    const value = JSON.parse(JSON.stringify(control.value)); value.entries.push({ ...value.entries[0] })
    job.store.writePreanalysisControl(key, control.identity, value)
    assert.throws(() => fixture.task('bad-counter').ledger.snapshot(), error => error.code === 'untrusted')
    const current = job.store.readPreanalysisControl(key), differentOwnerScope = JSON.parse(JSON.stringify(control.value))
    const row = { ...differentOwnerScope.entries[0], attempt: 2, channel: digest('another-channel'), routeIdentity: fixture.policy.recovery.routeIdentity }
    row.id = digest({ date: reservation.date, owner: row.owner, unit: row.unit, attempt: row.attempt, requestIdentity: row.requestIdentity, routeIdentity: row.routeIdentity })
    differentOwnerScope.entries.push(row)
    job.store.writePreanalysisControl(key, current.identity, differentOwnerScope)
    assert.throws(() => fixture.task('bad-owner-scope').ledger.snapshot(), error => error.code === 'untrusted')
  })
  await ledgerCase(check, '真实S0多进程争取同一资源，两个群的原子预留串行且无计额丢失', async fixture => {
    await runLedgerGateProcess(fixture.root, 'initialize')
    const writers = await Promise.all([runLedgerGateProcess(fixture.root, 'worker-A'), runLedgerGateProcess(fixture.root, 'worker-B')])
    assert.deepEqual(writers.map(writer => writer.usedGlobal).sort(), [1, 2])
    const final = await runLedgerGateProcess(fixture.root, 'inspect')
    assert.equal(final.usedGlobal, 2); assert.equal(final.usedGroup, 1)
  })
}
module.exports = { runReportBackgroundLedgerTests }
