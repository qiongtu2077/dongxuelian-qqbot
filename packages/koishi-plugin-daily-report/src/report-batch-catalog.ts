/**
 * MODULE: 日报跨快照稳定的分类批次目录。
 * 职责: 真实入库顺序、固定封闭成员、局部修订和当前窗口相交。
 * 边界: 只接完整原始窗口建立/更新；不请求模型、不推断迟到来源归属。
 */
import { createHash } from 'crypto'
import { isDeepStrictEqual } from 'util'
import { buildReportEvidenceBatch } from './report-evidence'
import type { EvidenceBatch, EvidenceFragment, ReportEvidence } from './report-evidence'
import { getReportClassificationInstructions } from './report-candidates'
import type { PagedReportStore } from './report-storage'
const { loadManagementModule } = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime') as typeof import('koishi-plugin-dongxuelian-ai/lib/public/management-runtime')
const { createReportPeriod, isTimestampInReportPeriod } = loadManagementModule('daily.reportPeriod')

interface CatalogSource { messageId: string; identity: string; arrival: number; ts: number; parts: string[] }
interface CatalogBatch {
  id: string; sequence: number; revision: number; parts: string[]; firstTimestampMs: number
  sealed: boolean; sealedAtMs: number | null; sealReason: 'capacity' | 'age' | 'window_end' | null
}
export interface ReportBatchCatalog {
  version: 'report-batch-catalog-1'; ruleIdentity: string
  scope: { channelKey: string; reportDate: string; periodStartMs: number; periodEndMs: number }
  baselineIdentity: string | null; initialMessageId: string | null; nextSequence: number
  sources: CatalogSource[]; batches: CatalogBatch[]
}
export interface CatalogUpdateContext {
  channelKey: string; period: ReturnType<typeof createReportPeriod>; nowMs: number
  sourceCompleteness: 'complete'; inputScope: 'full_business_window'
}
export interface CatalogBatchView {
  catalogId: string; revision: number; ruleIdentity: string; identity: string; complete: boolean; sealed: boolean
  batch: EvidenceBatch | null; deterministic: EvidenceFragment[]; fragments: EvidenceFragment[]
}
interface CatalogLineage { version: 'catalog-lineage-1'; generation: number; previousCommit: string | null }
interface CatalogRecoveryAudit { version: 'catalog-range-recovery-1'; fromCommit: string; damagedPages: number[]; replacedSlots: number[]; preservedBatchCount: number; entireRange: boolean }
type CatalogMetadata = Omit<ReportBatchCatalog, 'sources' | 'batches'> & {
  sourceCount: number; batchCount: number; lineage?: CatalogLineage; recoveryVersion?: 'catalog-sections-1'; recovery?: CatalogRecoveryAudit
}
export interface LatestReportBatchCatalog { id: string; generation: number; value: ReportBatchCatalog }
const AGE_MS = 15 * 60 * 1000
const CATALOG_HASH = /^[a-f0-9]{64}$/
const CATALOG_RESERVE = 512

// --- 固定规则与源校验 ---

// 只对程序字段计算摘要，原话不做空白或大小写归一化。
function catalogDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

// 系统提示及固定封装上界进入分批版本；不使用任务编号、截止或全局来源序号。
function catalogRule(): string {
  return catalogDigest({ version: 'stable-classification-1', fragmentCharacters: 2400, coreFragments: 64, coreCharacters: 12000,
    requestCharacters: 16000, auxiliaryCharacters: 2000, replyDepth: 3, neighbors: 4, ageMs: AGE_MS,
    system: getReportClassificationInstructions(), recoveryReserve: CATALOG_RESERVE, inputVersion: 'evidence-batch-4' })
}

// 以最宽局部引用和最多回复计量完整封装；辅助成员数量从最短合法辅助记录推导。
function catalogFits(snapshot: ReportEvidence, parts: readonly EvidenceFragment[]): boolean {
  if (!parts.length || parts.length > 64) return false
  const items = parts.map(fragment => ({ ref: 'r160', role: 'core', author: 'p644',
    time: snapshot.sources[fragment.sourceId - 1].time, text: fragment.text }))
  if (Array.from(JSON.stringify(items)).length > 12000) return false
  const minimumAuxiliary = JSON.stringify({ role: 'auxiliary', ref: 'm1', author: 'p1', time: '', text: '', excerptOnly: true, truncated: true }).length
  const auxiliaryMembers = Math.floor(2000 / minimumAuxiliary)
  const maximum = { version: 'evidence-batch-4', members: Array.from({ length: parts.length + auxiliaryMembers }, () => ({ ref: 'p644' })),
    items: items.map((item, index) => ({ ...item, replies: Array.from({ length: snapshot.sources[parts[index].sourceId - 1].replyToId ? 3 : 1 },
      () => ({ state: 'budget_not_provided' })) })), context: [] }
  return Array.from(JSON.stringify(maximum) + getReportClassificationInstructions()).length + 2000 + CATALOG_RESERVE <= 16000
}

// 完整索引窗口与可靠消息身份是建目录前提；选中的最新4000条不能充当入库原点。
function assertCatalogInput(snapshot: ReportEvidence, context: CatalogUpdateContext): void {
  if (!context.channelKey || context.sourceCompleteness !== 'complete' || context.inputScope !== 'full_business_window'
    || !Number.isSafeInteger(context.nowMs) || !isDeepStrictEqual(context.period, createReportPeriod(context.period.cutoffMs))
    || (!snapshot.hasStableMessageIds && snapshot.sources.length)
    || snapshot.sources.some(source => source.ts === null || !isTimestampInReportPeriod(source.ts, context.period))) {
    throw new Error('稳定目录须由完整真实原始窗口及永久消息身份建立')
  }
}

// 持久化目录只能包含明确版本、固定原点和完整互不重复的永久片段账本。
export function validateReportBatchCatalog(catalog: ReportBatchCatalog): void {
  if (!catalog || catalog.version !== 'report-batch-catalog-1' || catalog.ruleIdentity !== catalogRule()
    || !catalog.scope?.channelKey || !Number.isSafeInteger(catalog.scope.periodStartMs) || !Number.isSafeInteger(catalog.scope.periodEndMs)
    || catalog.scope.periodStartMs >= catalog.scope.periodEndMs || !Number.isSafeInteger(catalog.nextSequence) || catalog.nextSequence < 1
    || !Array.isArray(catalog.sources) || !Array.isArray(catalog.batches)) throw new Error('稳定目录版本、范围或规则无效')
  const period = createReportPeriod(catalog.scope.periodStartMs)
  if (catalog.scope.reportDate !== period.reportDate || catalog.scope.periodStartMs !== period.periodStartMs
    || catalog.scope.periodEndMs !== period.periodEndMs) throw new Error('稳定目录业务日范围不一致')
  if (catalog.sources.length ? !CATALOG_HASH.test(catalog.baselineIdentity || '') || !catalog.initialMessageId
    : catalog.baselineIdentity !== null || catalog.initialMessageId !== null) throw new Error('稳定目录原点不可验证')
  if (catalog.sources.length && catalog.initialMessageId !== catalog.sources[0].messageId) throw new Error('稳定目录首次来源原点不一致')
  const ids = new Set<string>(), allParts = new Set<string>(), batchIds = new Set<string>(), used = new Set<string>()
  for (const [index, source] of catalog.sources.entries()) {
    if (!source || typeof source.messageId !== 'string' || !source.messageId || ids.has(source.messageId) || source.arrival !== index
      || !CATALOG_HASH.test(source.identity) || !Number.isSafeInteger(source.ts) || source.ts < catalog.scope.periodStartMs
      || source.ts >= catalog.scope.periodEndMs || !Array.isArray(source.parts) || !source.parts.length
      || new Set(source.parts).size !== source.parts.length
      || source.parts.some(part => typeof part !== 'string' || !CATALOG_HASH.test(part) || allParts.has(part))) throw new Error('稳定目录永久成员或来源重复/无效')
    ids.add(source.messageId); source.parts.forEach(part => allParts.add(part))
  }
  for (const [index, batch] of catalog.batches.entries()) {
    if (!batch || !Number.isSafeInteger(batch.sequence) || batch.sequence < 1 || batch.sequence >= catalog.nextSequence
      || batch.id !== catalogDigest({ baseline: catalog.baselineIdentity, sequence: batch.sequence }) || batchIds.has(batch.id)
      || !Number.isSafeInteger(batch.revision) || batch.revision < 1 || !Array.isArray(batch.parts) || !batch.parts.length || batch.parts.length > 160
      || !Number.isSafeInteger(batch.firstTimestampMs) || typeof batch.sealed !== 'boolean'
      || (batch.sealed ? !Number.isSafeInteger(batch.sealedAtMs) || !['capacity', 'age', 'window_end'].includes(batch.sealReason || '')
        : batch.sealedAtMs !== null || batch.sealReason !== null || index !== catalog.batches.length - 1)
      || new Set(batch.parts).size !== batch.parts.length
      || batch.parts.some(part => !allParts.has(part) || used.has(part))) throw new Error('稳定封闭批次来源或状态不可验证')
    batchIds.add(batch.id); batch.parts.forEach(part => used.add(part))
  }
  if (used.size !== allParts.size) throw new Error('稳定目录存在未处理永久来源片段')
  if (!isDeepStrictEqual(catalog.batches.flatMap(batch => batch.parts), catalog.sources.flatMap(source => source.parts))) {
    throw new Error('稳定目录批次没有保持原始入库片段顺序')
  }
}

// --- 更新与局部修订 ---

// 封闭状态只前进，正常日报取快照本身不会调用该规则修改成员。
function sealCatalogBatch(batch: CatalogBatch, reason: NonNullable<CatalogBatch['sealReason']>, nowMs: number): void {
  batch.sealed = true; batch.sealReason = reason; batch.sealedAtMs = nowMs
}

// 每个新批次获得永久序号；既有批次修订保留自身序号，不重编号其他批次。
function newCatalogBatch(catalog: ReportBatchCatalog, fragment: EvidenceFragment, snapshot: ReportEvidence): CatalogBatch {
  const sequence = catalog.nextSequence++
  return { id: catalogDigest({ baseline: catalog.baselineIdentity, sequence }), sequence, revision: 1,
    parts: [fragment.permanentKey!], firstTimestampMs: snapshot.sources[fragment.sourceId - 1].ts!, sealed: false, sealedAtMs: null, sealReason: null }
}

// 更正只重分实际受影响的相邻批次块，未触及中间批次保持完整身份。
function reviseCatalogSources(catalog: ReportBatchCatalog, snapshot: ReportEvidence, changed: Set<string>, previousOwners: Map<string, string>, nowMs: number): void {
  const currentParts = new Map(snapshot.fragments.map(fragment => [fragment.permanentKey!, fragment]))
  const byMessage = new Map<string, EvidenceFragment[]>()
  for (const fragment of snapshot.fragments) {
    const id = snapshot.sources[fragment.sourceId - 1].messageId!
    const rows = byMessage.get(id) || []; rows.push(fragment); byMessage.set(id, rows)
  }
  const revised: CatalogBatch[] = []
  for (let index = 0; index < catalog.batches.length;) {
    const affected = (batch: CatalogBatch): boolean => batch.parts.some(part => changed.has(previousOwners.get(part)!))
    if (!affected(catalog.batches[index])) { revised.push(catalog.batches[index++]); continue }
    const old: CatalogBatch[] = []
    while (index < catalog.batches.length && affected(catalog.batches[index])) old.push(catalog.batches[index++])
    const parts: EvidenceFragment[] = [], inserted = new Set<string>()
    for (const key of old.flatMap(batch => batch.parts)) {
      const owner = previousOwners.get(key)!
      if (changed.has(owner)) {
        if (!inserted.has(owner)) { parts.push(...byMessage.get(owner)!); inserted.add(owner) }
      } else {
        const fragment = currentParts.get(key)
        if (!fragment) throw new Error('稳定目录未更正来源已不可读取')
        parts.push(fragment)
      }
    }
    const groups: EvidenceFragment[][] = []
    let pending: EvidenceFragment[] = []
    for (const fragment of parts) {
      if (pending.length && !catalogFits(snapshot, [...pending, fragment])) { groups.push(pending); pending = [] }
      pending.push(fragment)
      if (!catalogFits(snapshot, pending)) throw new Error('更正后的完整来源片段无法容纳稳定预算')
    }
    if (pending.length) groups.push(pending)
    groups.forEach((group, groupIndex) => {
      const original = old[groupIndex], batch = original ? { ...original, revision: original.revision + 1 }
        : newCatalogBatch(catalog, group[0], snapshot)
      batch.parts = group.map(fragment => fragment.permanentKey!)
      batch.firstTimestampMs = snapshot.sources[group[0].sourceId - 1].ts!
      if (groupIndex < groups.length - 1 || old[old.length - 1].sealed) sealCatalogBatch(batch, 'capacity', nowMs)
      else { batch.sealed = false; batch.sealedAtMs = null; batch.sealReason = null }
      revised.push(batch)
    })
  }
  catalog.batches = revised
}

// 同群同业务窗口以首次入库顺序追加，迟到来源进入新尾部，更正保持其他批次身份。
export function updateReportBatchCatalog(previous: ReportBatchCatalog | null, snapshot: ReportEvidence, context: CatalogUpdateContext): ReportBatchCatalog {
  assertCatalogInput(snapshot, context)
  const scope = { channelKey: context.channelKey, reportDate: context.period.reportDate,
    periodStartMs: context.period.periodStartMs, periodEndMs: context.period.periodEndMs }
  if (previous) { validateReportBatchCatalog(previous); if (!isDeepStrictEqual(previous.scope, scope)) throw new Error('稳定目录不属于本次群及业务窗口') }
  const catalog: ReportBatchCatalog = previous ? JSON.parse(JSON.stringify(previous)) : { version: 'report-batch-catalog-1', ruleIdentity: catalogRule(),
    scope, baselineIdentity: null, initialMessageId: null, nextSequence: 1, sources: [], batches: [] }
  if (!catalog.baselineIdentity && snapshot.sources.length) {
    catalog.baselineIdentity = catalogDigest({ scope, firstMessageId: snapshot.sources[0].messageId, sourceWindowIdentity: snapshot.identity })
    catalog.initialMessageId = snapshot.sources[0].messageId
  }
  const sources = new Map(catalog.sources.map(source => [source.messageId, source])), current = snapshot.byMessageId
  if (catalog.sources.some(source => !current.has(source.messageId))) throw new Error('稳定目录原始来源失效，不能用旧目录冒充完整输入')
  const previousOwners = new Map(catalog.sources.flatMap(source => source.parts.map(part => [part, source.messageId] as const)))
  const changed = new Set(catalog.sources.filter(source => source.identity !== current.get(source.messageId)!.identity).map(source => source.messageId))
  const partsBySource = new Map<number, EvidenceFragment[]>()
  for (const fragment of snapshot.fragments) {
    const rows = partsBySource.get(fragment.sourceId) || []; rows.push(fragment); partsBySource.set(fragment.sourceId, rows)
  }
  for (const source of catalog.sources) if (!changed.has(source.messageId)) {
    const ownParts = partsBySource.get(current.get(source.messageId)!.sourceId)!.map(part => part.permanentKey!)
    if (!isDeepStrictEqual(source.parts, ownParts)) throw new Error('稳定目录片段被绑定到其他原始来源')
  }
  for (const source of catalog.sources) if (changed.has(source.messageId)) {
    const value = current.get(source.messageId)!
    source.identity = value.identity; source.ts = value.ts!; source.parts = partsBySource.get(value.sourceId)!.map(part => part.permanentKey!)
  }
  if (changed.size) reviseCatalogSources(catalog, snapshot, changed, previousOwners, context.nowMs)
  const checkTail = (clock: number): void => {
    const tail = catalog.batches[catalog.batches.length - 1]
    if (!tail || tail.sealed) return
    if (clock >= scope.periodEndMs) sealCatalogBatch(tail, 'window_end', clock)
    else if (clock - tail.firstTimestampMs >= AGE_MS) sealCatalogBatch(tail, 'age', clock)
  }
  if (previous) checkTail(context.nowMs)
  let watermark = scope.periodStartMs
  const currentParts = new Map(snapshot.fragments.map(fragment => [fragment.permanentKey!, fragment]))
  for (const source of snapshot.sources) {
    if (sources.has(source.messageId!)) continue
    const parts = partsBySource.get(source.sourceId)!
    if (!previous) { watermark = Math.max(watermark, source.ts!); checkTail(Math.min(watermark, context.nowMs)) }
    const row: CatalogSource = { messageId: source.messageId!, identity: source.identity, arrival: catalog.sources.length, ts: source.ts!, parts: parts.map(part => part.permanentKey!) }
    catalog.sources.push(row); sources.set(row.messageId, row)
    for (const fragment of parts) {
      let tail = catalog.batches[catalog.batches.length - 1]
      if (tail && !tail.sealed && !catalogFits(snapshot, [...tail.parts.map(key => currentParts.get(key)!), fragment])) sealCatalogBatch(tail, 'capacity', context.nowMs)
      tail = catalog.batches[catalog.batches.length - 1]
      if (!tail || tail.sealed) {
        if (!catalogFits(snapshot, [fragment])) throw new Error('完整来源片段无法容纳稳定预算')
        catalog.batches.push(newCatalogBatch(catalog, fragment, snapshot))
      } else tail.parts.push(fragment.permanentKey!)
    }
  }
  checkTail(context.nowMs)
  validateReportBatchCatalog(catalog)
  return catalog
}

// --- 本次最新窗口相交 ---

// 完整中间批次保持身份；被裁切首部和当前尾部用实际核心形成独立请求材料。
export function selectReportCatalogBatches(catalog: ReportBatchCatalog, snapshot: ReportEvidence): CatalogBatchView[] {
  validateReportBatchCatalog(catalog)
  if (!snapshot.hasStableMessageIds && snapshot.sources.length) throw new Error('历史来源只能做任务内分批')
  const sources = new Map(catalog.sources.map(source => [source.messageId, source]))
  if (snapshot.sources.some(source => sources.get(source.messageId!)?.identity !== source.identity)) throw new Error('本次来源与稳定目录不一致')
  const sourceParts = new Map<number, string[]>()
  snapshot.fragments.forEach(fragment => {
    const keys = sourceParts.get(fragment.sourceId) || []; keys.push(fragment.permanentKey!); sourceParts.set(fragment.sourceId, keys)
  })
  if (snapshot.sources.some(source => !isDeepStrictEqual(sources.get(source.messageId!)!.parts, sourceParts.get(source.sourceId)))) {
    throw new Error('稳定目录成员片段所有权与当前原文不一致')
  }
  const parts = new Map(snapshot.fragments.map(fragment => [fragment.permanentKey!, fragment])), covered = new Set<string>()
  const result: CatalogBatchView[] = []
  for (const unit of catalog.batches) {
    const selected = unit.parts.filter(key => parts.has(key))
    if (!selected.length) continue
    const fragments = selected.map(key => parts.get(key)!).sort((a, b) => snapshot.sources[a.sourceId - 1].ts! - snapshot.sources[b.sourceId - 1].ts!
      || sources.get(snapshot.sources[a.sourceId - 1].messageId!)!.arrival - sources.get(snapshot.sources[b.sourceId - 1].messageId!)!.arrival || a.part - b.part)
    fragments.forEach(fragment => covered.add(fragment.permanentKey!))
    const deterministic = fragments.filter(fragment => snapshot.sources[fragment.sourceId - 1].content === '[图片]')
    const model = fragments.filter(fragment => snapshot.sources[fragment.sourceId - 1].content !== '[图片]')
    const batch = model.length ? buildReportEvidenceBatch(snapshot, model) : null
    if (batch && (batch.coreCharacters > 12000 || Array.from(batch.input + getReportClassificationInstructions()).length + CATALOG_RESERVE > 16000)) {
      throw new Error('稳定批次实际封装超限，须显式修订分批版本')
    }
    const ruleIdentity = catalogDigest({ rule: catalog.ruleIdentity, id: unit.id, revision: unit.revision })
    result.push({ catalogId: unit.id, revision: unit.revision, ruleIdentity,
      identity: catalogDigest({ ruleIdentity, core: fragments.map(fragment => fragment.permanentKey!) }),
      complete: selected.length === unit.parts.length, sealed: unit.sealed, batch, deterministic, fragments })
  }
  if (covered.size !== snapshot.fragments.length) throw new Error('稳定批次未覆盖本次完整来源')
  return result
}

// --- 分页持久化 ---

// 大来源的片段目录逐条分页，避免单个长消息的键清单超过完整记录上限。
export function saveReportBatchCatalog(store: PagedReportStore, catalog: ReportBatchCatalog, previousCommit: string | null = null, recovery?: CatalogRecoveryAudit): string {
  validateReportBatchCatalog(catalog)
  if (catalog.scope.channelKey !== store.taskIdentity.channelKey) throw new Error('稳定目录不能跨群发布')
  const latest = locateLatestCatalog(store, catalog.scope)
  if ((latest?.id || null) !== previousCommit) throw new Error('稳定目录前驱已改变，不能发布旧内存目录')
  const { sources, batches, ...header } = catalog
  const records: unknown[] = []
  for (const { parts, ...source } of sources) {
    records.push({ type: 'source', value: source, partCount: parts.length })
    parts.forEach((key, index) => records.push({ type: 'part', messageId: source.messageId, part: index + 1, key }))
  }
  batches.forEach((value, index) => records.push({ type: 'batch', index, value }))
  sources.forEach(source => records.push({ type: 'arrival', index: source.arrival, messageId: source.messageId }))
  const lineage: CatalogLineage = { version: 'catalog-lineage-1', generation: (latest?.generation || 0) + 1, previousCommit }
  return store.commit('catalog', { ...header, sourceCount: sources.length, batchCount: batches.length, lineage,
    recoveryVersion: 'catalog-sections-1', ...(recovery ? { recovery } : {}) }, records, rebuildStoredCatalog, 'catalog-sections-1')
}

// 发布代次只由明确版本的元数据证明；旧格式可按ID读取，不能猜其全局先后。
function assertCatalogLineage(value: CatalogLineage): void {
  if (!value || Object.keys(value).length !== 3 || value.version !== 'catalog-lineage-1'
    || !Number.isSafeInteger(value.generation) || value.generation < 1
    || (value.generation === 1 ? value.previousCommit !== null : !CATALOG_HASH.test(value.previousCommit || ''))) {
    throw new Error('稳定目录提交代次或前驱无效')
  }
}

// 完整清单扫描后以唯一最高代定位；中断已发布根仍有效，时间戳不参与顺序。
function locateLatestCatalog(store: PagedReportStore, scope: ReportBatchCatalog['scope']): { id: string; generation: number } | null {
  if (scope.channelKey !== store.taskIdentity.channelKey) throw new Error('稳定目录定位群号不一致')
  const inventory = store.list('catalog')
  if (inventory.invalidIds.length) throw new Error('稳定目录定位清单损坏，需要可验证恢复')
  const candidates = inventory.candidates.filter(item => isDeepStrictEqual((item.metadata as CatalogMetadata)?.scope, scope))
  const generations = new Map<number, string>(), byId = new Map(inventory.candidates.map(item => [item.id, item]))
  for (const item of candidates) {
    const value = item.metadata as CatalogMetadata
    if (!value.lineage) throw new Error('旧无序稳定目录只能按明确ID读取，不能自动猜最新提交')
    assertCatalogLineage(value.lineage)
    if (generations.has(value.lineage.generation)) throw new Error('稳定目录存在同代分叉，最新提交不可验证')
    generations.set(value.lineage.generation, item.id)
  }
  for (const item of candidates) {
    const lineage = (item.metadata as CatalogMetadata).lineage!
    // 历史根可按七天/容量回收；仍保留的直接前驱必须与代次相符，不能跨支链。
    const previous = generations.get(lineage.generation - 1)
    if (previous && lineage.previousCommit !== previous) throw new Error('稳定目录前驱链不一致')
    const known = byId.get(lineage.previousCommit || '')
    if (known && (!isDeepStrictEqual((known.metadata as CatalogMetadata).scope, scope)
      || (known.metadata as CatalogMetadata).lineage?.generation !== lineage.generation - 1)) throw new Error('稳定目录前驱代次或业务窗口不连续')
  }
  if (!generations.size) return null
  const generation = Math.max(...generations.keys())
  return { id: generations.get(generation)!, generation }
}

// 结构文件只是目录定位材料；重建仍需完整计数和永久成员覆盖校验。
function rebuildStoredCatalog(metadata: unknown, records: readonly unknown[]): ReportBatchCatalog {
  const value = metadata as CatalogMetadata
  if (!value || !Number.isSafeInteger(value.sourceCount) || value.sourceCount < 0
    || !Number.isSafeInteger(value.batchCount) || value.batchCount < 0) throw new Error('稳定目录提交头无效')
  const { sourceCount, batchCount, lineage, recoveryVersion, recovery, ...header } = value
  if (lineage !== undefined) assertCatalogLineage(lineage)
  if (recoveryVersion !== undefined && recoveryVersion !== 'catalog-sections-1') throw new Error('稳定目录恢复编码未知')
  if (recovery !== undefined && (!recoveryVersion || recovery.version !== 'catalog-range-recovery-1' || !CATALOG_HASH.test(recovery.fromCommit)
    || !Array.isArray(recovery.damagedPages) || !recovery.damagedPages.length || !Array.isArray(recovery.replacedSlots)
    || recovery.damagedPages.some(index => !Number.isSafeInteger(index) || index < 0)
    || recovery.replacedSlots.some(index => !Number.isSafeInteger(index) || index < 0)
    || !Number.isSafeInteger(recovery.preservedBatchCount) || recovery.preservedBatchCount < 0 || typeof recovery.entireRange !== 'boolean')) {
    throw new Error('稳定目录恢复审计无效')
  }
  const catalog: ReportBatchCatalog = { ...header, sources: [], batches: [] }
  let cursor = 0
  for (let index = 0; index < sourceCount; index++) {
    const entry = records[cursor++] as { type: string; value: Omit<CatalogSource, 'parts'>; partCount: number }
    if (!entry || entry.type !== 'source' || !entry.value || !Number.isSafeInteger(entry.partCount) || entry.partCount < 1) throw new Error('稳定目录来源页无效')
    const parts: string[] = []
    for (let part = 1; part <= entry.partCount; part++) {
      const row = records[cursor++] as { type: string; messageId: string; part: number; key: string }
      if (!row || row.type !== 'part' || row.messageId !== entry.value.messageId || row.part !== part || typeof row.key !== 'string') throw new Error('稳定目录永久片段页不完整')
      parts.push(row.key)
    }
    catalog.sources.push({ ...entry.value, parts })
  }
  for (let index = 0; index < batchCount; index++) {
    const entry = records[cursor++] as { type: string; index?: number; value: CatalogBatch }
    if (!entry || entry.type !== 'batch' || recoveryVersion && entry.index !== index) throw new Error('稳定目录批次页不完整')
    catalog.batches.push(entry.value)
  }
  if (recoveryVersion) for (let index = 0; index < sourceCount; index++) {
    const entry = records[cursor++] as { type: string; index: number; messageId: string }
    if (!entry || entry.type !== 'arrival' || entry.index !== index || entry.messageId !== catalog.sources[index].messageId) throw new Error('稳定目录独立顺序表不完整')
  }
  if (cursor !== records.length) throw new Error('稳定目录含未登记的额外记录')
  validateReportBatchCatalog(catalog)
  return catalog
}

// 从完整提交清单重建目录，不依赖任务完成标记或外部可重建索引。
export function readReportBatchCatalog(store: PagedReportStore, id: string): ReportBatchCatalog | null {
  let catalog: ReportBatchCatalog | undefined
  const document = store.read(id, 'catalog', (metadata, records) => {
    catalog = rebuildStoredCatalog(metadata, records)
    if (catalog.scope.channelKey !== store.taskIdentity.channelKey) throw new Error('稳定目录存储群号与业务范围不一致')
  })
  return document && catalog ? catalog : null
}

// 最新定位不等于读取成功；全部对象及完整业务目录通过后才交付调用方。
export function readLatestReportBatchCatalog(store: PagedReportStore, scope: ReportBatchCatalog['scope']): LatestReportBatchCatalog | null {
  const latest = locateLatestCatalog(store, scope)
  if (!latest) return null
  const value = readReportBatchCatalog(store, latest.id)
  if (!value || !isDeepStrictEqual(value.scope, scope)) throw new Error('最新稳定目录缺失、过期或业务范围不一致')
  return { ...latest, value }
}

// --- 当前完整来源驱动的局部恢复 ---

// 健康批次必须与当前完整原文的连续永久片段逐项一致，不能仅凭旧ID保留缓存。
function readableRecoveryBatch(batch: CatalogBatch, header: CatalogMetadata, keys: readonly string[], positions: ReadonlyMap<string, number>): boolean {
  if (!batch || !Number.isSafeInteger(batch.sequence) || batch.sequence < 1 || batch.sequence >= header.nextSequence
    || batch.id !== catalogDigest({ baseline: header.baselineIdentity, sequence: batch.sequence })
    || !Number.isSafeInteger(batch.revision) || batch.revision < 1 || !Array.isArray(batch.parts) || !batch.parts.length || batch.parts.length > 160
    || !Number.isSafeInteger(batch.firstTimestampMs) || typeof batch.sealed !== 'boolean'
    || (batch.sealed ? !Number.isSafeInteger(batch.sealedAtMs) || !['capacity', 'age', 'window_end'].includes(batch.sealReason || '')
      : batch.sealedAtMs !== null || batch.sealReason !== null)) return false
  const first = positions.get(batch.parts[0])
  return first !== undefined && batch.parts.every((key, index) => keys[first + index] === key)
}

// 只替换不可验证的连续槽位，分配新的永久序号；可读中间批次保持逐字身份。
function recoverCatalogRanges(metadata: CatalogMetadata, pages: Array<{ index: number; records: unknown[] | null }>, snapshot: ReportEvidence,
  context: CatalogUpdateContext, fromCommit: string): { value: ReportBatchCatalog; audit: CatalogRecoveryAudit } {
  if (metadata.recoveryVersion !== 'catalog-sections-1' || !metadata.lineage) throw new Error('未分区稳定目录不能猜测局部恢复')
  assertCatalogLineage(metadata.lineage)
  const { sourceCount, batchCount, lineage, recoveryVersion, recovery, ...header } = metadata
  if (!Number.isSafeInteger(sourceCount) || sourceCount < 0 || !Number.isSafeInteger(batchCount) || batchCount < 0
    || !isDeepStrictEqual(header.scope, { channelKey: context.channelKey, reportDate: context.period.reportDate,
      periodStartMs: context.period.periodStartMs, periodEndMs: context.period.periodEndMs })) throw new Error('稳定目录恢复范围或计数无效')
  validateReportBatchCatalog({ ...header, baselineIdentity: null, initialMessageId: null, sources: [], batches: [] })
  if (sourceCount && (!CATALOG_HASH.test(header.baselineIdentity || '') || !header.initialMessageId)) throw new Error('稳定目录恢复原点无效')
  const damagedPages = pages.filter(page => page.records === null).map(page => page.index)
  const records = pages.flatMap(page => page.records || [])
  if (!records.length) {
    if (snapshot.sources.length < sourceCount) throw new Error('整范围恢复缺少原始来源，不能缩减覆盖')
    const value = updateReportBatchCatalog(null, snapshot, context)
    if (value.sources.length) {
      value.baselineIdentity = catalogDigest({ recoveryFrom: fromCommit, sourceWindowIdentity: snapshot.identity, scope: value.scope })
      value.batches.forEach(batch => { batch.id = catalogDigest({ baseline: value.baselineIdentity, sequence: batch.sequence }) })
    }
    validateReportBatchCatalog(value)
    return { value, audit: { version: 'catalog-range-recovery-1', fromCommit, damagedPages,
      replacedSlots: Array.from({ length: batchCount }, (_, index) => index), preservedBatchCount: 0, entireRange: true } }
  }
  const arrivals = new Map<number, string>(), slots = new Map<number, CatalogBatch>()
  for (const input of records) {
    const row = input as { type: string; index: number; messageId: string; value: CatalogSource | CatalogBatch }
    if (row.type === 'source' || row.type === 'arrival') {
      const source = row.value as CatalogSource, index = row.type === 'source' ? source?.arrival : row.index
      const id = row.type === 'source' ? source?.messageId : row.messageId
      if (!Number.isSafeInteger(index) || index < 0 || index >= sourceCount || typeof id !== 'string' || !id
        || arrivals.has(index) && arrivals.get(index) !== id) throw new Error('稳定目录恢复顺序冲突')
      arrivals.set(index, id)
    } else if (row.type === 'batch') {
      if (!Number.isSafeInteger(row.index) || row.index < 0 || row.index >= batchCount || slots.has(row.index)) throw new Error('稳定目录恢复槽位冲突')
      slots.set(row.index, row.value as CatalogBatch)
    } else if (row.type !== 'part') throw new Error('稳定目录恢复含未知记录')
  }
  if (arrivals.size !== sourceCount || new Set(arrivals.values()).size !== sourceCount || arrivals.get(0) !== header.initialMessageId) {
    throw new Error('稳定目录入库边界不足以证明局部恢复')
  }
  const partsBySource = new Map<number, EvidenceFragment[]>()
  for (const fragment of snapshot.fragments) {
    const parts = partsBySource.get(fragment.sourceId) || []; parts.push(fragment); partsBySource.set(fragment.sourceId, parts)
  }
  const value: ReportBatchCatalog = { ...header, sources: [], batches: [] }, ordered: EvidenceFragment[] = []
  for (let arrival = 0; arrival < sourceCount; arrival++) {
    const source = snapshot.byMessageId.get(arrivals.get(arrival)!)
    if (!source) throw new Error('稳定目录恢复缺少原始来源，不能用旧键补齐')
    const parts = partsBySource.get(source.sourceId)!
    value.sources.push({ messageId: source.messageId!, identity: source.identity, arrival, ts: source.ts!, parts: parts.map(part => part.permanentKey!) })
    ordered.push(...parts)
  }
  const keys = ordered.map(part => part.permanentKey!), positions = new Map(keys.map((key, index) => [key, index]))
  const healthy = [...slots].filter(([, batch]) => readableRecoveryBatch(batch, metadata, keys, positions)).sort(([left], [right]) => left - right)
  const healthySlots = new Set(healthy.map(([slot]) => slot))
  const replacedSlots = Array.from({ length: batchCount }, (_, index) => index).filter(index => !healthySlots.has(index))
  let cursor = 0, previousSlot = -1
  // 区间边界只来自已经核验的邻接批次；新的区间按同一固定容量规则分批。
  const replaceRange = (end: number, nextSlot: number): void => {
    if (end < cursor || (end > cursor) !== (nextSlot > previousSlot + 1)) throw new Error('稳定目录恢复区间与槽位边界不一致')
    let pending: EvidenceFragment[] = []
    // 当前恢复分组采用全新序号，封闭状态仅由已证明边界和固定容量确定。
    const flushRecoveryRangeBatch = (capacity = false): void => {
      if (!pending.length) return
      const batch = newCatalogBatch(value, pending[0], snapshot)
      batch.parts = pending.map(fragment => fragment.permanentKey!)
      if (capacity || nextSlot < batchCount || context.nowMs - batch.firstTimestampMs >= AGE_MS) sealCatalogBatch(batch, 'capacity', context.nowMs)
      value.batches.push(batch); pending = []
    }
    for (; cursor < end; cursor++) {
      const fragment = ordered[cursor]
      if (pending.length && !catalogFits(snapshot, [...pending, fragment])) flushRecoveryRangeBatch(true)
      pending.push(fragment)
      if (!catalogFits(snapshot, pending)) throw new Error('恢复来源无法容纳固定批次预算')
    }
    flushRecoveryRangeBatch()
  }
  for (const [slot, batch] of healthy) {
    replaceRange(positions.get(batch.parts[0])!, slot)
    value.batches.push(batch); cursor += batch.parts.length; previousSlot = slot
  }
  replaceRange(ordered.length, batchCount)
  validateReportBatchCatalog(value)
  return { value: updateReportBatchCatalog(value, snapshot, context), audit: {
    version: 'catalog-range-recovery-1', fromCommit, damagedPages, replacedSlots, preservedBatchCount: healthy.length, entireRange: healthy.length === 0,
  } }
}

// 正式读写入口：正常页完整读取，损坏页从当前完整原始窗口局部恢复后发布新一代。
export function updateStoredReportBatchCatalog(store: PagedReportStore, snapshot: ReportEvidence, context: CatalogUpdateContext): LatestReportBatchCatalog & { recovery: CatalogRecoveryAudit | null } {
  assertCatalogInput(snapshot, context)
  const scope = { channelKey: context.channelKey, reportDate: context.period.reportDate, periodStartMs: context.period.periodStartMs, periodEndMs: context.period.periodEndMs }
  const latest = locateLatestCatalog(store, scope)
  let value: ReportBatchCatalog, recovery: CatalogRecoveryAudit | null = null
  if (!latest) value = updateReportBatchCatalog(null, snapshot, context)
  else {
    const inspection = store.inspectCatalogPages(latest.id)
    if (!inspection) throw new Error('最新稳定目录无法验证，不能当空目录')
    if (inspection.pages.some(page => page.records === null)) {
      const result = recoverCatalogRanges(inspection.metadata as CatalogMetadata, inspection.pages, snapshot, context, latest.id)
      value = result.value; recovery = result.audit
    } else {
      const previous = readReportBatchCatalog(store, latest.id)
      if (!previous) throw new Error('最新稳定目录无法读取')
      value = updateReportBatchCatalog(previous, snapshot, context)
    }
  }
  const id = saveReportBatchCatalog(store, value, latest?.id || null, recovery || undefined)
  return { id, generation: (latest?.generation || 0) + 1, value, recovery }
}
