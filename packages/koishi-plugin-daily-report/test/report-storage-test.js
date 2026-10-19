/** 真实文件分页、提交中断、共享对象及活动容量保护；不调用模型。 */
'use strict'
const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const management = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime')
const { withPagedStoreFixture: storageFixture, listPagedStoreFiles: storedFiles } = require('./helpers/report-store-fixture')
const { createReportEvidence } = require('../lib/report-evidence')
const { saveReportSnapshot, readReportSnapshot } = require('../lib/report-snapshots')
const { createReportPeriod } = management.loadManagementModule('daily.reportPeriod')

// 为固定记录提供真实业务校验；存储层不得把结构损坏降级成空数组。
function validateStoredRecords(metadata, records) {
  assert.equal(metadata.contract, 'storage-fixture-1')
  assert(records.every(record => typeof record.id === 'string' && typeof record.text === 'string'))
}

// 独立验收项在finally恢复文件故障，不污染后续生产入口测试。
async function storageCheck(check, name, run) {
  try { await storageFixture(run); check(name, true) } catch (error) { check(name, false, error.stack || String(error)) }
}

// 第一版只承载原任务内成功/诊断，使用与生产相同身份字段供统一写入器校验。
function artifactForStorage(store, createdAtMs, success = true) {
  const requestIdentity = crypto.createHash('sha256').update('legacy-capacity-request').digest('hex')
  return { version: 1, scope: 'task', taskId: store.taskIdentity.taskId, channelKey: store.taskIdentity.channelKey,
    deadlineMs: store.taskIdentity.deadlineMs, createdAtMs, requestIdentity, success, crossTaskReusable: false,
    actualModelSources: [null], unit: { id: 'B1', stage: 'compression', sourceIds: [1], timestamps: [createdAtMs] },
    attempts: [], ...(success ? { result: { sourceIds: [1], text: '已验证原文' } } : {}) }
}

// 执行分页对象、末尾提交、重读重建与固定容量行为回归。
async function runReportStorageTests(check) {
  const metadata = { contract: 'storage-fixture-1', cutoffMs: 1000 }
  const records = Array.from({ length: 36 }, (_, index) => ({ id: 'source-' + index, text: ('完整😀原文' + index).repeat(1800) }))
  await storageCheck(check, '单条超过512KiB的缓存记录完整字符分页，逻辑记录数不随物理片段增长', ({ root, store }) => {
    const instance = store(), values = [{ id: 'giant', text: '😀引号"反斜杠\\换行\n'.repeat(40000) }, { id: 'tail', text: '最后完整哨兵' }]
    assert(Buffer.byteLength(JSON.stringify(values[0])) > 512 * 1024)
    assert.throws(() => instance.commit('unit', metadata, values, validateStoredRecords), /分页|单条|上限/)
    const id = instance.commit('unit', metadata, values, validateStoredRecords, 'unit-record-fragments-1')
    const manifest = JSON.parse(fs.readFileSync(storedFiles(root).find(file => file.endsWith(id + '.json'))))
    assert.equal(manifest.body.recordCount, 2); assert.equal(manifest.body.bodyEncoding, 'unit-record-fragments-1')
    assert(manifest.body.pages.length > 2)
    const restored = instance.inspect(id, 'unit', validateStoredRecords)
    assert.deepEqual(restored.records, values)
    assert(storedFiles(root).every(file => fs.statSync(file).size <= (file.includes(path.sep + 'objects' + path.sep) ? 256 : 512) * 1024))
    assert.throws(() => instance.commit('catalog', metadata, values, validateStoredRecords, 'unit-record-fragments-1'), /仅用于/)
    assert.throws(() => instance.commit('unit', metadata, values, validateStoredRecords, 'unknown-unit-codec'), /编码/)
  })
  await storageCheck(check, '巨记录即使重签物理页也拒绝错序、缺片、错误逻辑摘要和多余字段', ({ root, store }) => {
    const { reportCacheDigest: digest } = require('../lib/report-cache-provenance')
    const instance = store(), values = [{ id: 'large', text: '完整😀正文'.repeat(50000) }]
    const id = instance.commit('unit', metadata, values, validateStoredRecords, 'unit-record-fragments-1')
    const file = storedFiles(root).find(file => file.endsWith(id + '.json')), original = JSON.parse(fs.readFileSync(file))
    const objectDir = path.join(path.dirname(path.dirname(file)), 'objects')
    const mutations = [
      rows => { rows[1].part = 1 }, rows => { rows.splice(1, 1) },
      rows => { rows[0].digest = digest('other-logical-record') }, rows => { rows[0].ignored = true },
    ]
    for (const mutate of mutations) {
      const page = JSON.parse(fs.readFileSync(path.join(objectDir, original.body.pages[0] + '.json')))
      mutate(page.records)
      const pageId = digest(page), body = { ...original.body, pages: [pageId, ...original.body.pages.slice(1)] }, forged = digest(body)
      fs.writeFileSync(path.join(objectDir, pageId + '.json'), JSON.stringify(page))
      fs.writeFileSync(path.join(path.dirname(file), forged + '.json'), JSON.stringify({ digest: forged, body }))
      assert.throws(() => instance.inspect(forged, 'unit', validateStoredRecords), /巨记录/)
    }
    fs.unlinkSync(path.join(objectDir, original.body.pages.at(-1) + '.json'))
    assert.throws(() => instance.inspect(id, 'unit', validateStoredRecords), /对象缺失或损坏/)
  })
  await storageCheck(check, '第一版写入计入活动第二版共享对象，单群容量不足不删除活动来源，释放后可回收', ({ root, store, active, state }) => {
    const old = store('v2-active'), id = old.commit('unit', metadata, [{ id: 'raw', text: '原始对象' }], validateStoredRecords)
    const object = storedFiles(root).find(file => file.includes(path.sep + 'objects' + path.sep))
    const manifest = storedFiles(root).find(file => file.endsWith(id + '.json')), manifestBytes = fs.readFileSync(manifest)
    fs.truncateSync(object, 64 * 1024 * 1024)
    active.push({ id: 'v2-active' })
    const writer = store('v1-writer'), value = artifactForStorage(writer, state.now)
    assert.throws(() => writer.writeTaskArtifact(value.requestIdentity, true, value), /容量不足/)
    assert.equal(fs.statSync(object).size, 64 * 1024 * 1024); assert.deepEqual(fs.readFileSync(manifest), manifestBytes)
    active.length = 0
    writer.writeTaskArtifact(value.requestIdentity, true, value)
    assert(!fs.existsSync(object)); assert(!fs.existsSync(manifest))
    assert.equal(storedFiles(root).filter(file => file.endsWith('.success.json')).length, 1)
  })
  await storageCheck(check, '第一版写入同样计入其他群和未知文件的256MiB总额，不能绕开新版目录', ({ root, store, state }) => {
    const files = []
    for (let index = 0; index < 4; index++) {
      const group = crypto.createHash('sha256').update(JSON.stringify('other-' + index)).digest('hex')
      const file = path.join(root, 'daily-analysis', 'v2', group, 'unknown', 'preserve.bin')
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ''); fs.truncateSync(file, 64 * 1024 * 1024); files.push(file)
    }
    const writer = store('v1-global'), value = artifactForStorage(writer, state.now)
    assert.throws(() => writer.writeTaskArtifact(value.requestIdentity, true, value), /容量不足/)
    assert(files.every(file => fs.statSync(file).size === 64 * 1024 * 1024))
    assert(!storedFiles(root).some(file => file.endsWith('.success.json')))
  })
  await storageCheck(check, '第一版最终文件虽可容纳但临时峰值超64MiB仍拒绝，已有临时文件也计量', ({ root, store, state }) => {
    const writer = store('v1-peak'), value = artifactForStorage(writer, state.now)
    const group = crypto.createHash('sha256').update(JSON.stringify('group-A')).digest('hex')
    const file = path.join(root, 'daily-analysis', 'v2', group, 'unknown', 'retained.tmp')
    const bytes = Buffer.byteLength(JSON.stringify(value, null, 2))
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ''); fs.truncateSync(file, 64 * 1024 * 1024 - bytes)
    // 未知目录的临时文件不能被猜作当前事务的孤立对象而清掉。
    assert.throws(() => writer.writeTaskArtifact(value.requestIdentity, true, value), /容量不足/)
    assert.equal(fs.statSync(file).size, 64 * 1024 * 1024 - bytes)
    assert(!storedFiles(root).some(file => file.endsWith('.success.json')))
  })
  await storageCheck(check, '第一版与第二版共同达到两万文件时停止新增，不使用截断列表低估容量', ({ root, store, state }) => {
    const directory = path.join(root, 'daily-analysis', 'unmanaged-counted')
    fs.mkdirSync(directory, { recursive: true })
    for (let index = 0; index < 20000; index++) fs.writeFileSync(path.join(directory, index + '.tmp'), '')
    const writer = store('file-limit'), value = artifactForStorage(writer, state.now)
    assert.throws(() => writer.writeTaskArtifact(value.requestIdentity, true, value), /扫描保护上限/)
    assert.equal(fs.readdirSync(directory).length, 20000)
  })
  await storageCheck(check, '失败诊断可在原任务失败/过期后保留但原截止不变，失去S0则成功和诊断均拒绝', ({ root, store, state }) => {
    const writer = store('failed-diagnostic'), deadline = writer.taskIdentity.deadlineMs
    state.alive = false; state.now = deadline + 1
    const failure = artifactForStorage(writer, state.now, false)
    assert.throws(() => writer.writeTaskArtifact(failure.requestIdentity, false, { ...failure, result: {} }), /明确成功或诊断职责/)
    assert.throws(() => writer.writeTaskArtifact(failure.requestIdentity, false, { ...failure, deadlineMs: deadline + 600000 }), /原任务/)
    writer.writeTaskArtifact(failure.requestIdentity, false, failure)
    const file = storedFiles(root).find(file => file.endsWith('.failure.json')), body = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(body.deadlineMs, deadline); assert.equal(body.success, false); assert.equal(body.crossTaskReusable, false); assert(!('result' in body))
    const success = artifactForStorage(writer, state.now, true)
    assert.throws(() => writer.writeTaskArtifact(success.requestIdentity, true, success), /任务已取消/)
    state.leased = false
    assert.throws(() => writer.writeTaskArtifact(failure.requestIdentity, false, failure), /租约已失效/)
    assert.throws(() => writer.writeTaskArtifact(success.requestIdentity, true, success), /租约已失效/)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), body)
  })
  await storageCheck(check, '第一版重复保存及触碰mtime不延长七天保留，清理按首次createdAtMs', ({ root, store, state }) => {
    const writer = store('same-artifact'), value = artifactForStorage(writer, state.now)
    writer.writeTaskArtifact(value.requestIdentity, true, value)
    const file = storedFiles(root).find(file => file.endsWith('.success.json')), created = value.createdAtMs
    state.now += 1000
    writer.writeTaskArtifact(value.requestIdentity, true, { ...value, createdAtMs: state.now })
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).createdAtMs, created)
    const original = fs.readFileSync(file)
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(original), createdAtMs: -1 }))
    assert.throws(() => writer.writeTaskArtifact(value.requestIdentity, true, { ...value, createdAtMs: state.now }), /首次创建时刻不可验证/)
    fs.writeFileSync(file, original)
    state.now = created + 7 * 86400000 + 1
    fs.utimesSync(file, new Date(state.now), new Date(state.now))
    store('cleanup-next').commit('unit', metadata, [], validateStoredRecords)
    assert(!fs.existsSync(file))
  })
  await storageCheck(check, '目录局部检查只交付摘要已验证页，丢失/篡改页明确标记且完整读取仍失败', ({ root, store }) => {
    const instance = store(), id = instance.commit('catalog', metadata, records, validateStoredRecords)
    const before = instance.inspectCatalogPages(id)
    assert(before.pages.length > 1); assert.deepEqual(before.pages.flatMap(page => page.records), records)
    const objects = path.join(path.dirname(path.dirname(storedFiles(root).find(file => file.includes(path.sep + 'commits' + path.sep)))), 'objects')
    const target = before.pages[1], file = path.join(objects, target.id + '.json'), bytes = fs.readFileSync(file)
    for (const corrupt of ['{broken', JSON.stringify({ version: 2, type: 'page', records: [] }), null]) {
      if (corrupt === null) fs.unlinkSync(file); else fs.writeFileSync(file, corrupt)
      const partial = instance.inspectCatalogPages(id)
      assert.equal(partial.pages[1].records, null)
      for (const page of partial.pages.filter(page => page.index !== 1)) assert.deepEqual(page.records, before.pages[page.index].records)
      assert.throws(() => instance.read(id, 'catalog', validateStoredRecords), /损坏|缺失/)
      fs.writeFileSync(file, bytes)
    }
  })
  await storageCheck(check, '局部页检查不吞掉磁盘权限/取消/租约/截止，禁止用于模型单元缓存', ({ root, store, state }) => {
    const instance = store(), id = instance.commit('catalog', metadata, records, validateStoredRecords)
    const unit = instance.commit('unit', metadata, records, validateStoredRecords)
    assert.throws(() => instance.inspectCatalogPages(unit), /只支持明确稳定目录/)
    const read = fs.readFileSync
    fs.readFileSync = (file, ...args) => { if (String(file).includes(path.sep + 'objects' + path.sep)) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' }); return read(file, ...args) }
    try { assert.throws(() => instance.inspectCatalogPages(id), error => error.code === 'EACCES') } finally { fs.readFileSync = read }
    state.leased = false; assert.throws(() => instance.inspectCatalogPages(id), /租约已失效/)
    state.leased = true; state.alive = false; assert.throws(() => instance.inspectCatalogPages(id), /任务已取消/)
    state.alive = true; state.now = instance.taskIdentity.deadlineMs
    assert.throws(() => instance.inspectCatalogPages(id), /原任务截止/)
  })
  await storageCheck(check, '第二版完整Unicode记录分页，所有页不超过256KiB，重新读取逐字一致', ({ root, store }) => {
    const instance = store(), id = instance.commit('snapshot', metadata, records, validateStoredRecords)
    const result = instance.read(id, 'snapshot', validateStoredRecords)
    assert.deepEqual(result.records, records)
    assert.deepEqual(result.metadata, metadata)
    const objects = storedFiles(root).filter(file => file.includes(path.sep + 'objects' + path.sep))
    assert(objects.length > 1)
    assert(objects.every(file => fs.statSync(file).size <= 256 * 1024))
    assert(storedFiles(root).every(file => fs.statSync(file).size <= 512 * 1024))
    assert(!storedFiles(root).some(file => file.endsWith('.tmp')))
  })
  await storageCheck(check, '同群相同正文页跨任务去重，人物/原文改动产生独立页且不覆盖旧内容', ({ root, store, state }) => {
    const first = store(), id = first.commit('unit', metadata, records, validateStoredRecords)
    const objectsBefore = storedFiles(root).filter(file => file.includes(path.sep + 'objects' + path.sep)).length
    state.now++
    store('task-B').commit('unit', { ...metadata, cutoffMs: 2000 }, records, validateStoredRecords)
    assert.equal(storedFiles(root).filter(file => file.includes(path.sep + 'objects' + path.sep)).length, objectsBefore)
    store('task-C').commit('unit', metadata, [{ id: 'another-author', text: '另一人真实原文' }], validateStoredRecords)
    assert.equal(first.read(id, 'unit', validateStoredRecords).records[0].text, records[0].text)
    assert.equal(storedFiles(root).filter(file => file.includes(path.sep + 'objects' + path.sep)).length, objectsBefore + 1)
  })
  await storageCheck(check, '半写入对象没有提交清单，rename中断不能被视为成功', ({ root, store }) => {
    const rename = fs.renameSync
    fs.renameSync = (from, to) => {
      if (to.includes(path.sep + 'commits' + path.sep)) throw new Error('模拟清单提交中断')
      return rename(from, to)
    }
    try { assert.throws(() => store().commit('unit', metadata, records, validateStoredRecords), /提交中断/) } finally { fs.renameSync = rename }
    const files = storedFiles(root)
    assert(files.some(file => file.includes(path.sep + 'objects' + path.sep)))
    assert(!files.some(file => file.includes(path.sep + 'commits' + path.sep) && file.endsWith('.json')))
    assert(!files.some(file => file.includes(path.sep + 'tasks' + path.sep)))
    const rebuilt = store('new-task'), id = rebuilt.commit('unit', metadata, records, validateStoredRecords)
    assert.deepEqual(rebuilt.read(id, 'unit', validateStoredRecords).records, records)
  })
  await storageCheck(check, '清单成功而任务完成记录中断，新任务校验后复用，旧任务不复活', ({ root, state, store }) => {
    const rename = fs.renameSync
    fs.renameSync = (from, to) => {
      if (to.includes(path.sep + 'tasks' + path.sep)) { state.alive = false; throw new Error('模拟完成记录中断') }
      return rename(from, to)
    }
    const old = store()
    try { assert.throws(() => old.commit('unit', metadata, records, validateStoredRecords), /完成记录中断/) } finally { fs.renameSync = rename }
    const file = storedFiles(root).find(value => value.includes(path.sep + 'commits' + path.sep) && value.endsWith('.json'))
    const id = path.basename(file, '.json')
    assert.throws(() => old.read(id, 'unit', validateStoredRecords), /任务已取消/)
    state.alive = true
    assert.deepEqual(store('new-task').read(id, 'unit', validateStoredRecords).records, records)
  })
  await storageCheck(check, '共享正文摘要损坏和来源对象缺失准确失败，不返回合法空结果', ({ root, store }) => {
    const instance = store(), id = instance.commit('unit', metadata, [{ id: 'a', text: '真实来源' }], validateStoredRecords)
    const object = storedFiles(root).find(file => file.includes(path.sep + 'objects' + path.sep))
    const original = fs.readFileSync(object)
    const value = JSON.parse(original); value.records[0].text = '错误替换'
    fs.writeFileSync(object, JSON.stringify(value))
    assert.throws(() => instance.read(id, 'unit', validateStoredRecords), /缺失或损坏/)
    fs.writeFileSync(object, original); fs.unlinkSync(object)
    assert.throws(() => instance.read(id, 'unit', validateStoredRecords), /缺失或损坏/)
  })
  await storageCheck(check, '非法JSON、null清单、错误契约和大文件均不能伪装缓存未命中', ({ root, store }) => {
    const instance = store(), id = instance.commit('unit', metadata, [], validateStoredRecords)
    const manifest = storedFiles(root).find(file => file.includes(path.sep + 'commits' + path.sep))
    const original = fs.readFileSync(manifest)
    for (const content of ['{', 'null', '{}']) {
      fs.writeFileSync(manifest, content)
      assert.throws(() => instance.read(id, 'unit', validateStoredRecords), /损坏|校验失败/)
    }
    fs.writeFileSync(manifest, original)
    assert.throws(() => instance.read(id, 'snapshot', validateStoredRecords), /类型不匹配/)
    fs.truncateSync(manifest, 512 * 1024 + 1)
    assert.throws(() => instance.read(id, 'unit', validateStoredRecords), /大小无效/)
  })
  await storageCheck(check, '七天按创建时间过期，命中不会续期；空文档仍需完整合法提交', ({ state, store }) => {
    const old = store(), id = old.commit('unit', metadata, [], validateStoredRecords)
    state.now += 6 * 24 * 3600 * 1000
    assert.deepEqual(store('day-6').read(id, 'unit', validateStoredRecords).records, [])
    state.now += 2 * 24 * 3600 * 1000
    assert.equal(store('day-8').read(id, 'unit', validateStoredRecords), null)
    assert.equal(store('absent').read('a'.repeat(64), 'unit', validateStoredRecords), null)
  })
  await storageCheck(check, '租约丢失、原截止及取消均拒绝发布，业务校验失败零落盘', ({ root, store, state }) => {
    const old = store()
    state.leased = false
    assert.throws(() => old.commit('unit', metadata, [], validateStoredRecords), /租约已失效/)
    state.leased = true; state.now += 600000
    assert.throws(() => old.commit('unit', metadata, [], validateStoredRecords), /原任务截止/)
    assert.throws(() => store('new').commit('unit', {}, [], validateStoredRecords))
    assert.equal(storedFiles(root).length, 0)
  })
  await storageCheck(check, '活动第一版产物计入同群64MiB，容量不足禁止删除活动材料', ({ root, store, active }) => {
    const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const legacy = path.join(root, 'daily-analysis', 'task-artifacts', digest('group-A'), digest('legacy-active'), digest('large-request') + '.success.json')
    fs.mkdirSync(path.dirname(legacy), { recursive: true }); fs.writeFileSync(legacy, '{}'); fs.truncateSync(legacy, 64 * 1024 * 1024)
    active.push({ id: 'legacy-active' })
    assert.throws(() => store().commit('unit', metadata, [], validateStoredRecords), /容量不足/)
    assert(fs.existsSync(legacy))
    active.length = 0
    const instance = store(), id = instance.commit('unit', metadata, [], validateStoredRecords)
    assert(!fs.existsSync(legacy)); assert(instance.read(id, 'unit', validateStoredRecords))
  })
  await storageCheck(check, '活动第二版清单及共享对象不因超过七天而被清理', ({ root, store, state, active }) => {
    const instance = store(), id = instance.commit('snapshot', metadata, records, validateStoredRecords)
    active.push({ id: 'task-A' })
    const original = storedFiles(root).filter(file => !file.includes(path.sep + 'tasks' + path.sep))
    state.now += 8 * 24 * 3600 * 1000
    store('new-task').commit('unit', metadata, [{ id: 'b', text: '新材料' }], validateStoredRecords)
    assert(original.every(file => fs.existsSync(file)))
    active.length = 0
    store('cleanup-task').commit('unit', metadata, [], validateStoredRecords)
    assert(!storedFiles(root).some(file => path.basename(file) === id + '.json'))
  })
  await storageCheck(check, '共享页无新清单时在本次预留中保护，不被孤立清理误删', ({ root, store }) => {
    const instance = store(), id = instance.commit('unit', metadata, records, validateStoredRecords)
    const manifest = storedFiles(root).find(file => file.includes(path.sep + 'commits' + path.sep))
    fs.unlinkSync(manifest)
    // 模拟旧进程退出后只有完整对象留下，不依赖残留任务保护记录。
    storedFiles(root).filter(file => file.includes(path.sep + 'tasks' + path.sep)).forEach(file => fs.unlinkSync(file))
    const next = store('new-task'), rebuilt = next.commit('unit', metadata, records, validateStoredRecords)
    assert.equal(rebuilt, id); assert.deepEqual(next.read(rebuilt, 'unit', validateStoredRecords).records, records)
  })
  await storageCheck(check, '超大单条完整记录拒绝，正文不裁切且没有部分成功', ({ root, store }) => {
    assert.throws(() => store().commit('unit', metadata, [{ id: 'large', text: '😀'.repeat(70000) }], validateStoredRecords), /超过分页上限/)
    assert.equal(storedFiles(root).length, 0)
  })
  await storageCheck(check, '固定4000条快照及跨页超长原文完整重建，任务截止变化不重复保存正文页', ({ root, store, state }) => {
    const period = createReportPeriod(Date.parse('2026-10-06T18:00:00+08:00'))
    const messages = Array.from({ length: 4000 }, (_, index) => ({ messageId: 'real-' + index, realMessageId: true,
      userId: 'member-' + index % 50, user: '同名成员', ts: period.periodStartMs + index, time: '04:00',
      ...(index ? { replyToId: 'real-' + (index - 1) } : {}), content: index === 3999 ? '完整😀长文'.repeat(50000) + '最后哨兵' : '短发言😀' + index }))
    const evidence = createReportEvidence(messages)
    const context = { period, sourceCompleteness: 'complete', statistics: { totalMessages: 4000, totalMembers: 50 } }
    const first = store(), id = saveReportSnapshot(first, evidence, context)
    const restored = readReportSnapshot(first, id, createReportEvidence(messages), context)
    assert.deepEqual(restored.sources, evidence.sources); assert.deepEqual(restored.fragments, evidence.fragments)
    assert(restored.sources[3999].content.endsWith('最后哨兵'))
    assert(restored.hasStableMessageIds)
    const objectCount = storedFiles(root).filter(file => file.includes(path.sep + 'objects' + path.sep)).length
    state.now++
    saveReportSnapshot(store('next-task'), evidence, { ...context, period: createReportPeriod(period.cutoffMs + 1000) })
    assert.equal(storedFiles(root).filter(file => file.includes(path.sep + 'objects' + path.sep)).length, objectCount)
  })
  await storageCheck(check, '当前原文、作者、回复、昵称、统计或提交窗口变化不能冒用旧快照', ({ store }) => {
    const period = createReportPeriod(Date.parse('2026-10-06T18:00:00+08:00'))
    const messages = [{ messageId: 'real-a', realMessageId: true, userId: 'member-A', user: '当时昵称',
      ts: period.periodStartMs, time: '04:00', content: '真实原话' }]
    const current = createReportEvidence(messages), context = { period, sourceCompleteness: 'complete', statistics: { totalMessages: 1 } }
    const instance = store(), id = saveReportSnapshot(instance, current, context)
    for (const change of [{ content: '更正原话' }, { userId: '另一个成员' }, { replyToId: 'other-parent' }, { user: '当前昵称' }]) {
      assert.equal(readReportSnapshot(instance, id, createReportEvidence([{ ...messages[0], ...change }]), context), null)
    }
    assert.equal(readReportSnapshot(instance, id, current, { ...context, statistics: { totalMessages: 2 } }), null)
    assert.equal(readReportSnapshot(instance, id, current, { ...context, period: createReportPeriod(period.cutoffMs + 1000) }), null)
  })
  await storageCheck(check, '历史未知来源可做任务快照，保持未知和禁止永久缓存资格；不完整来源拒绝', ({ root, store }) => {
    const period = createReportPeriod(Date.parse('2026-10-06T18:00:00+08:00'))
    const legacy = createReportEvidence([{ userId: 'member-A', content: '历史原话', time: '18:00' }])
    const context = { period, sourceCompleteness: 'legacy_unknown', statistics: { totalMessages: 1 } }
    const instance = store(), id = saveReportSnapshot(instance, legacy, context)
    assert.equal(readReportSnapshot(instance, id, legacy, context).hasStableMessageIds, false)
    const manifest = JSON.parse(fs.readFileSync(storedFiles(root).find(file => file.includes(path.sep + 'commits' + path.sep))))
    assert.equal(manifest.body.metadata.sourceCompleteness, 'legacy_unknown')
    assert.throws(() => saveReportSnapshot(instance, legacy, { ...context, sourceCompleteness: 'incomplete' }), /上下文无效/)
    assert.throws(() => saveReportSnapshot(instance, legacy, { ...context, sourceCompleteness: 'complete' }), /不在固定窗口/)
  })
  await storageCheck(check, '可解析且摘要合法的错误来源片段也须通过业务重建，不能伪造永久绑定', ({ store }) => {
    const period = createReportPeriod(Date.parse('2026-10-06T18:00:00+08:00'))
    const evidence = createReportEvidence([{ messageId: 'a', realMessageId: true, userId: 'u', content: '真实来源', ts: period.periodStartMs }])
    const context = { period, sourceCompleteness: 'complete', statistics: {} }, instance = store()
    const id = saveReportSnapshot(instance, evidence, context)
    const original = instance.read(id, 'snapshot', () => {})
    const damaged = JSON.parse(JSON.stringify(original.records))
    damaged[1].permanentKey = 'a'.repeat(64)
    const counterfeit = instance.commit('snapshot', original.metadata, damaged, () => {})
    assert.throws(() => readReportSnapshot(instance, counterfeit, evidence, context), /永久来源摘要不一致/)
  })
  await storageCheck(check, '持久定位索引分页且仅保存小投影，新任务命中不解析全部原始清单', ({ root, state, store }) => {
    const { reportCacheDigest: digest } = require('../lib/report-cache-provenance')
    const instance = store(), baseId = instance.commit('unit', metadata, [], validateStoredRecords)
    const baseFile = storedFiles(root).find(file => file.endsWith(baseId + '.json'))
    const base = JSON.parse(fs.readFileSync(baseFile)), commitDir = path.dirname(baseFile)
    for (let index = 0; index < 750; index++) {
      const body = { ...base.body, metadata: { version: 'classification-cache-1', requestIdentity: digest('request-' + index), policyIdentity: digest('policy'),
        actualAttempts: [{ execution: { routeIdentity: digest('primary') } }], bindings: { neverInLocator: index < 8 ? '大绑定'.repeat(18000) : '' } } }
      const id = digest(body)
      fs.writeFileSync(path.join(commitDir, id + '.json'), JSON.stringify({ digest: id, body }, null, 2))
    }
    const first = instance.listUnitLocators()
    assert(first.publishable); assert.equal(first.candidates.length, 750)
    assert(first.candidates.every(value => Object.keys(value.metadata).length === 4 && !('bindings' in value.metadata) && !('actualAttempts' in value.metadata)))
    const indexRoot = storedFiles(root).find(file => file.endsWith('unit-root.json')), body = JSON.parse(fs.readFileSync(indexRoot)).body
    assert(body.pages.length > 1)
    assert(storedFiles(root).filter(file => file.includes(path.sep + 'locators' + path.sep)).every(file => fs.statSync(file).size <= 256 * 1024))
    const read = fs.readFileSync
    let fullCommitReads = 0
    fs.readFileSync = (file, ...args) => { if (String(file).includes(path.sep + 'commits' + path.sep)) fullCommitReads++; return read(file, ...args) }
    try { state.now++; assert.deepEqual(store('new-index-reader').listUnitLocators().candidates, first.candidates) } finally { fs.readFileSync = read }
    assert.equal(fullCommitReads, 0)
  })
  await storageCheck(check, '定位根及页损坏可重建，新增/删除清单使索引失效且不伪造成功', ({ root, state, store }) => {
    const { reportCacheDigest: digest } = require('../lib/report-cache-provenance')
    const instance = store(), unitMetadata = { version: 'stage-cache-1', requestIdentity: digest('r'), policyIdentity: digest('p'),
      actualAttempts: [{ execution: { routeIdentity: digest('route') } }] }
    const id = instance.commit('unit', unitMetadata, [], () => {})
    assert.equal(instance.listUnitLocators().candidates.length, 1)
    const indexRoot = storedFiles(root).find(file => file.endsWith('unit-root.json'))
    fs.writeFileSync(indexRoot, '{broken')
    assert.equal(instance.listUnitLocators().candidates[0].id, id)
    const pageId = JSON.parse(fs.readFileSync(indexRoot)).body.pages[0]
    fs.writeFileSync(path.join(path.dirname(indexRoot), pageId + '.json'), '{}')
    assert.equal(instance.listUnitLocators().candidates[0].id, id)
    state.now++
    const secondId = instance.commit('unit', { ...unitMetadata, requestIdentity: digest('r2') }, [], () => {})
    assert.equal(instance.listUnitLocators().candidates.length, 2)
    // 模拟非活动旧清单被回收；清空旧任务保护后由新任务建立索引，不恢复旧任务。
    const secondFile = storedFiles(root).find(file => file.endsWith(secondId + '.json'))
    for (const file of storedFiles(root).filter(file => file.includes(path.sep + 'tasks' + path.sep))) fs.unlinkSync(file)
    fs.unlinkSync(secondFile)
    assert.deepEqual(store('fresh-index-reader').listUnitLocators().candidates.map(value => value.id), [id])
  })
  await storageCheck(check, '可重建定位发布失败返回禁用信号，可信提交仍可读取', ({ root, store }) => {
    const instance = store(), id = instance.commit('unit', metadata, [], validateStoredRecords), rename = fs.renameSync
    fs.renameSync = (from, to) => { if (String(to).endsWith('unit-root.json')) throw new Error('模拟索引发布失败'); return rename(from, to) }
    try { assert.equal(instance.listUnitLocators().publishable, false) } finally { fs.renameSync = rename }
    assert.equal(instance.read(id, 'unit', validateStoredRecords).id, id)
    assert(storedFiles(root).some(file => file.includes(path.sep + 'commits' + path.sep)))
  })
  await storageCheck(check, '索引命中同样检查租约/取消/原截止，过期定位不能延长产物保留', ({ state, store }) => {
    const instance = store()
    instance.listUnitLocators()
    state.leased = false
    assert.throws(() => instance.listUnitLocators(), /租约已失效/)
    state.leased = true; state.alive = false
    assert.throws(() => instance.listUnitLocators(), /任务已取消/)
    state.alive = true; state.now += 7 * 24 * 60 * 60 * 1000 + 1
    assert.throws(() => instance.listUnitLocators(), /原任务截止/)
    assert.deepEqual(store('after-retention').listUnitLocators().candidates, [])
  })
  await storageCheck(check, '实际4000窗口滑动只分页新增10条正文且复用原页，昵称变化不复制正文', ({ root, state, store }) => {
    const period = createReportPeriod(Date.parse('2026-10-06T18:00:00+08:00'))
    const messages = Array.from({ length: 4010 }, (_, index) => ({ messageId: 'sliding-' + index, realMessageId: true, userId: 'member-' + index % 17,
      user: '旧昵称', time: '04:00', ts: period.periodStartMs + index * 10, content: '完整独立正文😀-' + index }))
    const context = { period, sourceCompleteness: 'complete', statistics: { selected: 4000 } }
    const first = store('sliding-A'), id = saveReportSnapshot(first, createReportEvidence(messages.slice(0, 4000)), context)
    // 依据真正提交根核对正文集合；描述页允许随选中窗口改变。
    const findBody = commit => JSON.parse(fs.readFileSync(storedFiles(root).find(file => file.includes(path.sep + 'commits' + path.sep) && file.endsWith(commit + '.json')))).body
    const original = new Set(findBody(id).bodyObjects)
    assert(original.size > 1 && original.size < 10)
    state.now++
    const second = store('sliding-B'), current = createReportEvidence(messages.slice(10)), nextId = saveReportSnapshot(second, current, context)
    const currentIds = findBody(nextId).bodyObjects
    const newPages = currentIds.filter(value => !original.has(value))
    assert.equal(newPages.length, 1)
    const newBodyRows = newPages.flatMap(pageId => JSON.parse(fs.readFileSync(storedFiles(root).find(file => file.includes(path.sep + 'objects' + path.sep) && file.endsWith(pageId + '.json')))).records)
    assert.equal(newBodyRows.length, 10)
    assert.deepEqual(newBodyRows.map(row => row.text).sort(), messages.slice(4000).map(message => message.content).sort())
    assert.deepEqual(readReportSnapshot(second, nextId, current, context).sources, current.sources)
    state.now++
    const renamed = createReportEvidence(messages.slice(10).map(message => ({ ...message, user: '当前昵称' })))
    const renameId = saveReportSnapshot(store('sliding-C'), renamed, context)
    assert.deepEqual(findBody(renameId).bodyObjects, currentIds)
    assert(storedFiles(root).every(file => fs.statSync(file).size <= 512 * 1024))
  })
  await storageCheck(check, '相同原文跨消息/作者共用正文，来源所有权独立且活动正文不被清理', ({ root, active, state, store }) => {
    const period = createReportPeriod(Date.parse('2026-10-06T18:00:00+08:00')), context = { period, sourceCompleteness: 'complete', statistics: {} }
    const messages = [{ messageId: 'same-a', realMessageId: true, userId: 'author-A', ts: period.periodStartMs, content: '同一句完整原话😀' },
      { messageId: 'same-b', realMessageId: true, userId: 'author-B', ts: period.periodStartMs + 1000, content: '同一句完整原话😀' }]
    const snapshot = createReportEvidence(messages), instance = store('active-body'), id = saveReportSnapshot(instance, snapshot, context)
    const body = JSON.parse(fs.readFileSync(storedFiles(root).find(file => file.includes(path.sep + 'commits' + path.sep) && file.endsWith(id + '.json')))).body
    assert.equal(body.bodyObjects.length, 1); active.push({ id: 'active-body' })
    state.now++; store('other-task').commit('unit', metadata, [], validateStoredRecords)
    const restored = readReportSnapshot(instance, id, snapshot, context)
    assert.equal(restored.sources[0].userId, 'author-A'); assert.equal(restored.sources[1].userId, 'author-B')
    const bodyFile = storedFiles(root).find(file => file.includes(path.sep + 'objects' + path.sep) && file.endsWith(body.bodyObjects[0] + '.json'))
    fs.writeFileSync(bodyFile, '{}')
    assert.throws(() => readReportSnapshot(instance, id, snapshot, context), /正文页缺失或损坏/)
    state.now++
    const repairedId = saveReportSnapshot(store('repair-from-fresh-source'), createReportEvidence(messages), context)
    assert.equal(readReportSnapshot(store('read-repaired'), repairedId, snapshot, context).sources[1].content, messages[1].content)
  })
  await storageCheck(check, '正文与描述写齐但清单中断不产生快照，后续写入清理孤立正文', ({ root, store }) => {
    const period = createReportPeriod(Date.parse('2026-10-06T18:00:00+08:00'))
    const snapshot = createReportEvidence([{ messageId: 'interrupted-body', realMessageId: true, userId: 'u', ts: period.periodStartMs, content: '写齐但未提交的完整原话' }])
    const rename = fs.renameSync
    fs.renameSync = (from, to) => { if (String(to).includes(path.sep + 'commits' + path.sep)) throw new Error('模拟正文提交中断'); return rename(from, to) }
    try { assert.throws(() => saveReportSnapshot(store(), snapshot, { period, sourceCompleteness: 'complete', statistics: {} }), /正文提交中断/) }
    finally { fs.renameSync = rename }
    const orphaned = storedFiles(root).filter(file => file.includes(path.sep + 'objects' + path.sep))
    assert.equal(orphaned.length, 2)
    store('new-task').commit('unit', metadata, [], validateStoredRecords)
    assert(orphaned.every(file => !fs.existsSync(file)))
  })
  await storageCheck(check, '两个已知第二版旧正文格式均明确读取，不猜迁移或提升完整性', ({ store }) => {
    const { decodeReportSnapshot } = require('../lib/report-snapshots')
    const period = createReportPeriod(Date.parse('2026-10-06T18:00:00+08:00')), context = { period, sourceCompleteness: 'complete', statistics: {} }
    const snapshot = createReportEvidence([{ messageId: 'old-format', realMessageId: true, userId: 'u', ts: period.periodStartMs, content: '旧明确格式的完整😀原话' }])
    const instance = store(), currentId = saveReportSnapshot(instance, snapshot, context), document = instance.read(currentId, 'snapshot', decodeReportSnapshot)
    for (const encoding of [undefined, 'snapshot-fragment-text-1']) {
      const id = instance.commit('snapshot', document.metadata, document.records, decodeReportSnapshot, encoding)
      assert.deepEqual(readReportSnapshot(instance, id, snapshot, context).sources, snapshot.sources)
    }
  })
  await storageCheck(check, '整页摘要合法但页内逻辑正文身份被篡改仍拒绝，不只检查文件摘要', ({ root, store }) => {
    const { reportCacheDigest: digest } = require('../lib/report-cache-provenance')
    const period = createReportPeriod(Date.parse('2026-10-06T18:00:00+08:00')), context = { period, sourceCompleteness: 'complete', statistics: {} }
    const snapshot = createReportEvidence([{ messageId: 'forged-body', realMessageId: true, userId: 'u', ts: period.periodStartMs, content: '逻辑正文必须与摘要一致' }])
    const instance = store(), id = saveReportSnapshot(instance, snapshot, context)
    const commitFile = storedFiles(root).find(file => file.includes(path.sep + 'commits' + path.sep) && file.endsWith(id + '.json'))
    const original = JSON.parse(fs.readFileSync(commitFile)), objectDir = path.join(path.dirname(path.dirname(commitFile)), 'objects')
    const page = JSON.parse(fs.readFileSync(path.join(objectDir, original.body.bodyObjects[0] + '.json')))
    page.records[0].id = 'f'.repeat(64)
    const forgedPageId = digest(page)
    fs.writeFileSync(path.join(objectDir, forgedPageId + '.json'), JSON.stringify(page, null, 2))
    const pages = original.body.pages.map(pageId => {
      const descriptor = JSON.parse(fs.readFileSync(path.join(objectDir, pageId + '.json')))
      for (const row of descriptor.records) if (row.type === 'fragment') row.bodyObjectId = forgedPageId
      const nextId = digest(descriptor)
      fs.writeFileSync(path.join(objectDir, nextId + '.json'), JSON.stringify(descriptor, null, 2))
      return nextId
    })
    const body = { ...original.body, pages, bodyObjects: [forgedPageId] }, counterfeit = digest(body)
    fs.writeFileSync(path.join(path.dirname(commitFile), counterfeit + '.json'), JSON.stringify({ digest: counterfeit, body }, null, 2))
    assert.throws(() => instance.inspect(counterfeit, 'snapshot', () => {}), /页内正文身份无效/)
  })
  await storageCheck(check, '损坏共享页不能复用，当前部分来源可重建新页且不伪装修复旧完整快照', ({ root, state, store }) => {
    const period = createReportPeriod(Date.parse('2026-10-06T18:00:00+08:00')), context = { period, sourceCompleteness: 'complete', statistics: {} }
    const messages = ['已滑出窗口', '仍在窗口内'].map((content, index) => ({ messageId: 'shared-' + index, realMessageId: true, userId: 'u', ts: period.periodStartMs + index, content }))
    const initial = createReportEvidence(messages), instance = store(), id = saveReportSnapshot(instance, initial, context)
    const rootFile = storedFiles(root).find(file => file.includes(path.sep + 'commits' + path.sep) && file.endsWith(id + '.json'))
    const original = JSON.parse(fs.readFileSync(rootFile)), originalPage = original.body.bodyObjects[0]
    const bodyFile = storedFiles(root).find(file => file.includes(path.sep + 'objects' + path.sep) && file.endsWith(originalPage + '.json'))
    fs.writeFileSync(bodyFile, '{}'); state.now++
    const next = store('partial-fresh-source'), current = createReportEvidence(messages.slice(1)), nextId = saveReportSnapshot(next, current, context)
    assert.deepEqual(readReportSnapshot(next, nextId, current, context).sources, current.sources)
    assert.equal(fs.readFileSync(bodyFile, 'utf8'), '{}')
    assert.throws(() => readReportSnapshot(instance, id, initial, context), /正文页缺失或损坏/)
  })
}

module.exports = { runReportStorageTests }
