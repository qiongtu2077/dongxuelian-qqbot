/** 真实来源的稳定目录、局部修订和滑动供料身份回归，不调用外部模型。 */
'use strict'
const assert = require('assert').strict
const fs = require('fs')
const path = require('path')
const management = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime')
const { createReportPeriod } = management.loadManagementModule('daily.reportPeriod')
const { createReportEvidence } = require('../lib/report-evidence')
const { getReportClassificationInstructions } = require('../lib/report-candidates')
const { createClassificationRequestIdentity } = require('../lib/report-bindings')
const { updateReportBatchCatalog, selectReportCatalogBatches, validateReportBatchCatalog, saveReportBatchCatalog, readReportBatchCatalog, readLatestReportBatchCatalog, updateStoredReportBatchCatalog } = require('../lib/report-batch-catalog')
const { reportCacheDigest: digest } = require('../lib/report-cache-provenance')
const { withPagedStoreFixture, listPagedStoreFiles } = require('./helpers/report-store-fixture')
const period = createReportPeriod(Date.parse('2026-10-06T18:00:00+08:00'))

// 按真实入库顺序提供全部业务日来源；本次选中窗口单独建立。
function catalogMessages(count, start = 0) {
  return Array.from({ length: count }, (_, offset) => { const index = start + offset; return {
    messageId: 'real-' + index, realMessageId: true, userId: 'user-' + index % 19, user: '同名群友',
    ts: period.periodStartMs + 1000 + index * 100, time: '04:00', content: index % 23 === 0 ? '[图片]' : '完整😀原文-' + index,
  } })
}

// 观察时钟与固定业务窗口明确给定，任务选中窗口不是目录原点。
function catalogContext(nowMs = period.periodStartMs + 10 * 60 * 1000) {
  return { channelKey: 'group-A', period, nowMs, sourceCompleteness: 'complete', inputScope: 'full_business_window' }
}

// 计算真正会提交的序列化请求身份，不能以缓存文件存在替代命中证明。
function catalogRequestMap(catalog, evidence) {
  return new Map(selectReportCatalogBatches(catalog, evidence).filter(view => view.batch).map(view => [view.catalogId,
    createClassificationRequestIdentity(evidence, view.batch, { channelKey: 'group-A', periodStartMs: period.periodStartMs,
      periodEndMs: period.periodEndMs, sourceCompleteness: 'complete', modelPolicyIdentity: 'fixed-two-node-models',
      batchRuleIdentity: view.ruleIdentity, system: getReportClassificationInstructions(), maxTokens: 4096 })]))
}

// 每个用例独立使用真实文件存储，保留当前生产边界。
async function catalogCase(check, name, run) {
  try { await withPagedStoreFixture(run); check(name, true) } catch (error) { check(name, false, error.stack || String(error)) }
}

// 只定位本次提交的已核验页；破坏真实页文件，不伪造读取返回。
function catalogRecoveryFixture(f, count = 4000) {
  const messages = catalogMessages(count), evidence = createReportEvidence(messages), context = catalogContext(period.cutoffMs)
  const originalStore = f.store('original'), original = updateStoredReportBatchCatalog(originalStore, evidence, context)
  const inspection = originalStore.inspectCatalogPages(original.id)
  const manifestFile = listPagedStoreFiles(f.root).find(file => file.endsWith(original.id + '.json'))
  const objectDir = path.join(path.dirname(path.dirname(manifestFile)), 'objects')
  return { messages, evidence, context, original, inspection, file: page => path.join(objectDir, page.id + '.json') }
}

// 覆盖完整4000条后持续追加，而非只检查目录文件数量。
async function runReportBatchCatalogTests(check) {
  await catalogCase(check, '来源页损坏从独立入库顺序及当前全文恢复，旧封闭批次和实际请求身份不变', f => {
    const r = catalogRecoveryFixture(f), pages = r.inspection.pages.filter(page => page.records.some(row => row.type === 'source'))
    assert(pages.length > 1)
    const page = pages[Math.floor(pages.length / 2)]; fs.writeFileSync(r.file(page), '{bad source page')
    assert.throws(() => readLatestReportBatchCatalog(f.store('strict-reader'), r.original.value.scope), /损坏/)
    const recovered = updateStoredReportBatchCatalog(f.store('recover'), r.evidence, r.context)
    assert.deepEqual(recovered.recovery.damagedPages, [page.index]); assert.deepEqual(recovered.recovery.replacedSlots, [])
    assert.equal(recovered.recovery.preservedBatchCount, r.original.value.batches.length)
    assert.deepEqual(recovered.value, r.original.value)
    assert.deepEqual(catalogRequestMap(recovered.value, r.evidence), catalogRequestMap(r.original.value, r.evidence))
    assert.equal(readLatestReportBatchCatalog(f.store('after-recovery'), r.original.value.scope).id, recovered.id)
  })
  await catalogCase(check, '批次页损坏只替换该页槽位，新序号明确失效，其他批次请求身份逐项保持', f => {
    const r = catalogRecoveryFixture(f), pages = r.inspection.pages.filter(page => page.records.some(row => row.type === 'batch'))
    assert(pages.length > 1)
    const page = pages[Math.floor(pages.length / 2)], slots = page.records.map(row => row.index)
    fs.writeFileSync(r.file(page), '{}')
    const recovered = updateStoredReportBatchCatalog(f.store('recover'), r.evidence, r.context)
    assert.deepEqual(recovered.recovery.replacedSlots, slots)
    const oldRequests = catalogRequestMap(r.original.value, r.evidence), newRequests = catalogRequestMap(recovered.value, r.evidence)
    for (const [index, batch] of r.original.value.batches.entries()) {
      if (slots.includes(index)) assert(!recovered.value.batches.some(value => value.id === batch.id))
      else {
        assert.deepEqual(recovered.value.batches.find(value => value.id === batch.id), batch)
        assert.equal(newRequests.get(batch.id), oldRequests.get(batch.id))
      }
    }
    assert.equal(recovered.recovery.preservedBatchCount, r.original.value.batches.length - slots.length)
    assert(recovered.value.batches.filter(batch => !oldRequests.has(batch.id)).every(batch => batch.sequence >= r.original.value.nextSequence))
    assert.deepEqual(recovered.value.sources, r.original.value.sources)
    assert.equal(new Set(selectReportCatalogBatches(recovered.value, r.evidence).flatMap(view => view.fragments.map(fragment => fragment.permanentKey))).size, r.evidence.fragments.length)
  })
  await catalogCase(check, '独立顺序页损坏由已核验来源序号恢复，持续追加保留既有目录原点', f => {
    const r = catalogRecoveryFixture(f, 300), page = r.inspection.pages.find(page => page.records.some(row => row.type === 'arrival'))
    fs.unlinkSync(r.file(page))
    const snapshot = createReportEvidence([...r.messages, ...catalogMessages(10, 300)])
    const recovered = updateStoredReportBatchCatalog(f.store('recover-and-append'), snapshot, r.context)
    assert.equal(recovered.value.sources.length, 310)
    assert.equal(recovered.value.baselineIdentity, r.original.value.baselineIdentity)
    assert.deepEqual(recovered.value.batches.slice(0, r.original.value.batches.length), r.original.value.batches)
    assert.deepEqual(recovered.recovery.replacedSlots, [])
  })
  await catalogCase(check, '坏批次范围遇原文更正与长文增片仍按当前全文恢复，尾部不丢且其他批次保留', f => {
    const r = catalogRecoveryFixture(f), page = r.inspection.pages.filter(page => page.records.some(row => row.type === 'batch'))[0]
    const badSlots = new Set(page.records.map(row => row.index)), targetKey = page.records[1].value.parts[0]
    const target = r.evidence.fragments.find(fragment => fragment.permanentKey === targetKey)
    const changedId = r.evidence.sources[target.sourceId - 1].messageId
    const messages = r.messages.map(message => message.messageId === changedId ? { ...message, content: '当前更正😀'.repeat(4000) + '修订末尾哨兵' } : message)
    fs.writeFileSync(r.file(page), '{broken')
    const snapshot = createReportEvidence(messages), result = updateStoredReportBatchCatalog(f.store('corrected-recovery'), snapshot, r.context)
    for (const [index, batch] of r.original.value.batches.entries()) if (!badSlots.has(index)) {
      assert.deepEqual(result.value.batches.find(value => value.id === batch.id), batch)
    }
    const fragments = selectReportCatalogBatches(result.value, snapshot).flatMap(view => view.fragments)
    assert.equal(new Set(fragments.map(fragment => fragment.permanentKey)).size, snapshot.fragments.length)
    assert(fragments.some(fragment => fragment.text.endsWith('修订末尾哨兵')))
    assert.equal(result.value.sources.find(source => source.messageId === changedId).identity, snapshot.byMessageId.get(changedId).identity)
  })
  await catalogCase(check, '恢复时原始来源缺失或两份入库边界均丢失必须失败，不能当空目录重建', f => {
    const r = catalogRecoveryFixture(f, 300)
    const sourcePage = r.inspection.pages.find(page => page.records.some(row => row.type === 'source'))
    const sourceBytes = fs.readFileSync(r.file(sourcePage)); fs.unlinkSync(r.file(sourcePage))
    assert.throws(() => updateStoredReportBatchCatalog(f.store('missing-source'), createReportEvidence(r.messages.slice(1)), r.context), /缺少原始来源/)
    const arrival = r.inspection.pages.find(page => page.records.some(row => row.type === 'arrival')); fs.unlinkSync(r.file(arrival))
    assert.throws(() => updateStoredReportBatchCatalog(f.store('missing-order'), r.evidence, r.context), /入库边界不足/)
    fs.writeFileSync(r.file(sourcePage), sourceBytes)
    assert.equal(f.store('inspector').list('catalog').candidates.length, 1)
  })
  await catalogCase(check, '全部目录业务页损坏时显式整范围恢复，重建起点不同且旧分类身份全部失效', f => {
    const r = catalogRecoveryFixture(f, 50)
    for (const page of r.inspection.pages) fs.unlinkSync(r.file(page))
    const recovered = updateStoredReportBatchCatalog(f.store('all-ranges'), r.evidence, r.context)
    assert.equal(recovered.recovery.entireRange, true); assert.equal(recovered.recovery.preservedBatchCount, 0)
    assert.notEqual(recovered.value.baselineIdentity, r.original.value.baselineIdentity)
    assert.deepEqual(recovered.value.sources, r.original.value.sources)
    const oldIds = new Set(r.original.value.batches.map(batch => batch.id))
    assert(recovered.value.batches.every(batch => !oldIds.has(batch.id)))
    assert.equal(recovered.generation, 2)
    const document = f.store('audit-reader').inspect(recovered.id, 'catalog', () => {})
    assert.equal(document.metadata.recovery.fromCommit, r.original.id)
    assert.equal(document.metadata.recovery.entireRange, true)
  })
  await catalogCase(check, '同毫秒连续目录按提交代次读取，旧前驱或跨群发布准确拒绝', f => {
    const original = catalogMessages(50), context = catalogContext()
    const first = updateReportBatchCatalog(null, createReportEvidence(original), context), one = f.store('one')
    const firstId = saveReportBatchCatalog(one, first)
    const second = updateReportBatchCatalog(first, createReportEvidence([...original, ...catalogMessages(5, 50)]), context)
    const secondId = saveReportBatchCatalog(f.store('two'), second, firstId)
    const third = updateReportBatchCatalog(second, createReportEvidence([...original, ...catalogMessages(10, 50)]), context)
    const thirdId = saveReportBatchCatalog(f.store('three'), third, secondId)
    assert.equal(new Set(one.list('catalog').candidates.map(row => row.createdAtMs)).size, 1)
    const latest = readLatestReportBatchCatalog(f.store('reader'), third.scope)
    assert.equal(latest.id, thirdId); assert.equal(latest.generation, 3); assert.deepEqual(latest.value, third)
    assert.throws(() => saveReportBatchCatalog(f.store('stale'), second, firstId), /前驱已改变/)
    assert.throws(() => saveReportBatchCatalog(f.store('cross-group', 'group-B'), third), /跨群/)
    assert.equal(readLatestReportBatchCatalog(f.store('reader-next'), third.scope).id, thirdId)
  })
  await catalogCase(check, '目录完整根已发布而任务保护中断，新任务采用最高代且原目录不回退', f => {
    const source = catalogMessages(50), context = catalogContext()
    const first = updateReportBatchCatalog(null, createReportEvidence(source), context), firstId = saveReportBatchCatalog(f.store('first'), first)
    const next = updateReportBatchCatalog(first, createReportEvidence([...source, ...catalogMessages(1, 50)]), context)
    const rename = fs.renameSync
    fs.renameSync = (from, to) => { if (String(to).includes(path.sep + 'tasks' + path.sep)) throw new Error('pin interrupted'); return rename(from, to) }
    try { assert.throws(() => saveReportBatchCatalog(f.store('interrupted'), next, firstId), /pin interrupted/) }
    finally { fs.renameSync = rename }
    const latest = readLatestReportBatchCatalog(f.store('after-restart'), next.scope)
    assert.equal(latest.generation, 2); assert.deepEqual(latest.value, next)
    assert.notEqual(latest.id, firstId)
  })
  await catalogCase(check, '目录根发布失败只留孤立对象，不推进最新代次或覆盖既有目录', f => {
    const context = catalogContext(), source = catalogMessages(50)
    const first = updateReportBatchCatalog(null, createReportEvidence(source), context), id = saveReportBatchCatalog(f.store('first'), first)
    const next = updateReportBatchCatalog(first, createReportEvidence([...source, ...catalogMessages(1, 50)]), context)
    const rename = fs.renameSync
    fs.renameSync = (from, to) => { if (String(to).includes(path.sep + 'commits' + path.sep)) throw new Error('manifest interrupted'); return rename(from, to) }
    try { assert.throws(() => saveReportBatchCatalog(f.store('interrupted'), next, id), /manifest interrupted/) }
    finally { fs.renameSync = rename }
    const latest = readLatestReportBatchCatalog(f.store('after-restart'), first.scope)
    assert.equal(latest.id, id); assert.equal(latest.generation, 1); assert.deepEqual(latest.value, first)
  })
  await catalogCase(check, '摘要合法的同代分叉或错误前驱链不能靠时间/文件名择一继续', f => {
    const catalog = updateReportBatchCatalog(null, createReportEvidence(catalogMessages(50)), catalogContext())
    const store = f.store('first'), id = saveReportBatchCatalog(store, catalog)
    const directory = path.dirname(listPagedStoreFiles(f.root).find(file => file.endsWith(id + '.json')))
    const original = JSON.parse(fs.readFileSync(path.join(directory, id + '.json'), 'utf8'))
    const write = body => { const key = digest(body), file = path.join(directory, key + '.json'); fs.writeFileSync(file, JSON.stringify({ digest: key, body })); return file }
    const fork = write({ ...original.body, createdAtMs: original.body.createdAtMs + 1 })
    assert.throws(() => readLatestReportBatchCatalog(f.store('fork-reader'), catalog.scope), /同代分叉/)
    fs.unlinkSync(fork)
    const wrong = write({ ...original.body, metadata: { ...original.body.metadata,
      lineage: { version: 'catalog-lineage-1', generation: 2, previousCommit: digest('unknown') } } })
    assert.throws(() => readLatestReportBatchCatalog(f.store('chain-reader'), catalog.scope), /前驱链不一致/)
    fs.unlinkSync(wrong)
    const nextPeriod = createReportPeriod(period.periodEndMs)
    const foreignBody = { ...original.body, metadata: { ...original.body.metadata, scope: { ...catalog.scope,
      reportDate: nextPeriod.reportDate, periodStartMs: nextPeriod.periodStartMs, periodEndMs: nextPeriod.periodEndMs } } }
    const foreignFile = write(foreignBody)
    const crossed = write({ ...original.body, metadata: { ...original.body.metadata,
      lineage: { version: 'catalog-lineage-1', generation: 2, previousCommit: digest(foreignBody) } } })
    fs.unlinkSync(path.join(directory, id + '.json'))
    assert.throws(() => readLatestReportBatchCatalog(f.store('scope-reader'), catalog.scope), /业务窗口不连续/)
    fs.unlinkSync(foreignFile); fs.unlinkSync(crossed)
  })
  await catalogCase(check, '已知旧无序目录可按ID完整读取，自动最新定位不猜迁移顺序', f => {
    const catalog = updateReportBatchCatalog(null, createReportEvidence(catalogMessages(50)), catalogContext())
    const id = saveReportBatchCatalog(f.store('first'), catalog)
    const file = listPagedStoreFiles(f.root).find(file => file.endsWith(id + '.json')), envelope = JSON.parse(fs.readFileSync(file, 'utf8'))
    delete envelope.body.metadata.lineage
    const legacyId = digest(envelope.body), legacyFile = path.join(path.dirname(file), legacyId + '.json')
    fs.writeFileSync(legacyFile, JSON.stringify({ digest: legacyId, body: envelope.body })); fs.unlinkSync(file)
    assert.deepEqual(readReportBatchCatalog(f.store('legacy-reader'), legacyId), catalog)
    assert.throws(() => readLatestReportBatchCatalog(f.store('latest-reader'), catalog.scope), /旧无序稳定目录/)
  })
  await catalogCase(check, '4000条目录持续追加只影响首尾/真实上下文，完整中间批次的实际请求身份保持', () => {
    const messages = catalogMessages(4000), evidence = createReportEvidence(messages), context = catalogContext()
    const catalog = updateReportBatchCatalog(null, evidence, context), before = catalogRequestMap(catalog, evidence)
    const updatedMessages = [...messages, ...catalogMessages(10, 4000)]
    const updated = updateReportBatchCatalog(catalog, createReportEvidence(updatedMessages), context)
    const selected = createReportEvidence(updatedMessages.slice(-4000)), after = catalogRequestMap(updated, selected)
    const views = selectReportCatalogBatches(updated, selected)
    assert(views.length > 2 && views.length < 184)
    assert(views.some(view => !view.complete))
    assert.equal(new Set(views.flatMap(view => view.fragments.map(fragment => fragment.permanentKey))).size, 4000)
    const changed = [...before].filter(([id, request]) => after.get(id) !== request)
    assert(changed.length > 0 && changed.length <= 4, '首尾和边界邻居之外不得整体失效: ' + changed.length)
    const middle = catalog.batches.slice(2, -2)
    assert(middle.length > 10)
    assert(middle.every(batch => before.get(batch.id) === after.get(batch.id)))
    assert.deepEqual(updated.batches.slice(0, -1), catalog.batches.slice(0, -1))
  })
  await catalogCase(check, '十五分钟与业务日结束封闭，正常取快照不自行永久封闭尾部', () => {
    const messages = catalogMessages(4), evidence = createReportEvidence(messages)
    const first = updateReportBatchCatalog(null, evidence, catalogContext(period.periodStartMs + 5 * 60 * 1000))
    assert.equal(first.batches.length, 1); assert.equal(first.batches[0].sealed, false)
    selectReportCatalogBatches(first, evidence)
    assert.equal(first.batches[0].sealed, false)
    const aged = updateReportBatchCatalog(first, evidence, catalogContext(period.periodStartMs + 16 * 60 * 1000))
    assert.equal(aged.batches[0].sealReason, 'age')
    const ended = updateReportBatchCatalog(first, evidence, catalogContext(period.periodEndMs))
    assert.equal(ended.batches[0].sealReason, 'window_end')
  })
  await catalogCase(check, '历史首次重建按已见时间推进，不把4000条历史消息拆成4000个批次', () => {
    const evidence = createReportEvidence(catalogMessages(4000))
    const catalog = updateReportBatchCatalog(null, evidence, catalogContext(period.cutoffMs))
    assert(catalog.batches.length > 1 && catalog.batches.length < 184)
    assert(catalog.batches.every(batch => batch.sealed))
    assert.equal(catalog.batches.at(-1).sealReason, 'age')
  })
  await catalogCase(check, '迟到来源进入新尾部且同时间按首次入库次序展示，不插回封闭中间', () => {
    const original = catalogMessages(300), evidence = createReportEvidence(original)
    const catalog = updateReportBatchCatalog(null, evidence, catalogContext(period.cutoffMs))
    const late = catalogMessages(2, 300).map(message => ({ ...message, ts: original[1].ts, content: '迟到短句' }))
    const next = updateReportBatchCatalog(catalog, createReportEvidence([...original, ...late]), catalogContext(period.cutoffMs + 1000))
    assert.deepEqual(next.batches.slice(0, catalog.batches.length), catalog.batches)
    assert.equal(next.sources.at(-1).arrival, 301)
    const views = selectReportCatalogBatches(next, createReportEvidence([...original, ...late]))
    const last = views.at(-1)
    assert.deepEqual(last.fragments.map(fragment => next.sources.find(source => source.parts.includes(fragment.permanentKey)).messageId), ['real-300', 'real-301'])
  })
  await catalogCase(check, '原文更正只修订所属批次，长文新增片段完整保留且其他批次不重编号', () => {
    const original = catalogMessages(1000), evidence = createReportEvidence(original), context = catalogContext()
    const catalog = updateReportBatchCatalog(null, evidence, context)
    const owner = catalog.batches[Math.floor(catalog.batches.length / 2)], key = owner.parts[Math.floor(owner.parts.length / 2)]
    const source = catalog.sources.find(source => source.parts.includes(key)), index = original.findIndex(message => message.messageId === source.messageId)
    const changed = original.map((message, messageIndex) => messageIndex === index ? { ...message, content: '更正😀'.repeat(5000) + '长文最后哨兵' } : message)
    const current = createReportEvidence(changed), next = updateReportBatchCatalog(catalog, current, context)
    assert(next.batches.find(batch => batch.id === owner.id).revision > owner.revision)
    for (const batch of catalog.batches.filter(batch => batch.id !== owner.id)) assert.deepEqual(next.batches.find(value => value.id === batch.id), batch)
    const views = selectReportCatalogBatches(next, current)
    assert.equal(new Set(views.flatMap(view => view.fragments.map(fragment => fragment.permanentKey))).size, current.fragments.length)
    assert(views.flatMap(view => view.fragments).some(fragment => fragment.text.endsWith('长文最后哨兵')))
    const afterRename = updateReportBatchCatalog(next, createReportEvidence(changed.map(message => ({ ...message, user: '当前昵称' }))), context)
    assert.deepEqual(afterRename, next)
  })
  await catalogCase(check, '缺失原始来源、历史标识、错误业务范围和目录重复不能伪装合法复用', () => {
    const messages = catalogMessages(300), snapshot = createReportEvidence(messages), context = catalogContext()
    const catalog = updateReportBatchCatalog(null, snapshot, context)
    assert.throws(() => updateReportBatchCatalog(catalog, createReportEvidence(messages.slice(1)), context), /原始来源失效/)
    assert.throws(() => updateReportBatchCatalog(null, createReportEvidence(messages.map(message => ({ ...message, realMessageId: false }))), context), /永久消息身份/)
    assert.throws(() => updateReportBatchCatalog(catalog, snapshot, { ...context, channelKey: 'group-B' }), /不属于/)
    assert.throws(() => updateReportBatchCatalog(null, snapshot, { ...context, inputScope: 'selected_latest' }), /完整真实原始窗口/)
    const broken = JSON.parse(JSON.stringify(catalog)); broken.batches[0].parts.push(broken.batches[0].parts[0])
    assert.throws(() => validateReportBatchCatalog(broken), /不可验证/)
  })
  await catalogCase(check, '稳定目录分页落盘后新任务重建保持原点、修订及实际请求身份', ({ root, store }) => {
    const snapshot = createReportEvidence(catalogMessages(4000)), catalog = updateReportBatchCatalog(null, snapshot, catalogContext())
    const first = store(), id = saveReportBatchCatalog(first, catalog), restored = readReportBatchCatalog(store('new-task'), id)
    assert.deepEqual(restored, catalog)
    assert.deepEqual(catalogRequestMap(restored, snapshot), catalogRequestMap(catalog, snapshot))
    const objects = listPagedStoreFiles(root).filter(file => file.includes(path.sep + 'objects' + path.sep))
    assert(objects.length > 1 && objects.every(file => fs.statSync(file).size <= 256 * 1024))
  })
  await catalogCase(check, '空业务窗口可以追加首条永久来源，纯图片同样有完整目录账本', () => {
    const context = catalogContext(), empty = updateReportBatchCatalog(null, createReportEvidence([]), context)
    assert.equal(empty.baselineIdentity, null)
    const messages = catalogMessages(1), snapshot = createReportEvidence(messages), catalog = updateReportBatchCatalog(empty, snapshot, context)
    const view = selectReportCatalogBatches(catalog, snapshot)[0]
    assert.equal(view.batch, null); assert.equal(view.deterministic.length, 1); assert.equal(view.fragments.length, 1)
  })
}

module.exports = { runReportBatchCatalogTests }
