/**
 * MODULE: 日报整理、选题及四类输出的可信交换缓存。
 * 职责: 永久绑定表、原生成快照、实际节点和原读取器共同校验/重放。
 * 边界: 当前上游必须重建相同实际供料；不猜字段、不请求模型或改写自由文字。
 */
import { isDeepStrictEqual } from 'util'
import { PagedReportStore, ReportStoredDataError, projectReportUnitLocator } from './report-storage'
import { decodeReportSnapshot } from './report-snapshots'
import type { ReportSnapshotContext } from './report-snapshots'
import type { ReportEvidence } from './report-evidence'
import type { AnalysisUnitAttempt, AnalysisUnitRecovery } from './complete-input'
import type { ReportStageBindings } from './report-stage-bindings'
import { verifyReportStageOrigin } from './report-stage-bindings'
import { reportCacheDigest, assertReportCachePolicy, assertReportCacheAttempts, verifyReportCacheAttempts } from './report-cache-provenance'
import type { ReportCacheModelPolicy, ReportCacheActualAttempt } from './report-cache-provenance'
import { assertReportFields } from './report-exchange'

export type ReportCachedStage = 'grouping' | 'selection' | 'overview' | 'quotes' | 'portraits' | 'review'
export type ReportStageCachePolicies = Record<ReportCachedStage, ReportCacheModelPolicy>
export interface ReportStageCacheRequest {
  stage: ReportCachedStage; mode: 'ordinary' | 'detailed'; system: string; input: string; maxTokens: number; bindings: ReportStageBindings
  requireNormalFinish?: boolean
}
interface StageCacheMetadata {
  version: 'stage-cache-1'; stage: ReportCachedStage; mode: ReportStageCacheRequest['mode']; requestIdentity: string; policyIdentity: string
  sourceSnapshotCommit: string; origin: { taskId: string; deadlineMs: number }; productIdentity: string; actualAttempts: ReportCacheActualAttempt[]
}
interface SavedStageExchange { recovery: 'none' | 'full' | 'targeted'; responses: string[] }
export interface ReportStageCacheHistory {
  stage: ReportCachedStage; commitId: string; sourceSnapshotCommit: string; origin: StageCacheMetadata['origin']; actualAttempts: ReportCacheActualAttempt[]
}
interface StageCacheOptions {
  store: PagedReportStore; snapshot: ReportEvidence; snapshotCommit: string; context: ReportSnapshotContext; policies: ReportStageCachePolicies
  onDiagnostic?: (code: string, id: string, message: string) => void
}
const STAGE_CACHE_HASH = /^[a-f0-9]{64}$/
const CACHED_STAGES: ReportCachedStage[] = ['grouping', 'selection', 'overview', 'quotes', 'portraits', 'review']

// --- 分页交换记录 ---

// 永久表逐完整记录分页，避免大概述将数千来源塞进单个元数据对象。
function stageCacheRecords(bindings: ReportStageBindings, exchange: SavedStageExchange): unknown[] {
  return [{ type: 'header', version: bindings.version, material: bindings.material },
    ...bindings.fragments.map(value => ({ type: 'fragment', value })), ...bindings.provenance.map(key => ({ type: 'provenance', key })),
    ...bindings.sources.map(value => ({ type: 'source', value })), ...bindings.candidates.map(value => ({ type: 'candidate', value })),
    ...bindings.members.map(value => ({ type: 'member', value })), ...bindings.targets.map(alias => ({ type: 'target', alias })),
    ...bindings.statistics.map(value => ({ type: 'statistic', value })), { type: 'exchange', value: exchange }]
}

// 根结构只有一种版本与明确标签；未知记录不能作为空模块或旧缓存兼容读取。
function decodeStageCacheRecords(records: readonly unknown[]): { bindings: ReportStageBindings; exchange: SavedStageExchange } {
  const first = records[0] as { type: string; version: string; material: string }
  assertReportFields(first, ['type', 'version', 'material'], '阶段缓存头')
  if (first.type !== 'header' || first.version !== 'stage-bindings-1' || !['topic-raw', 'topic-summary', 'topic-comparison', 'output'].includes(first.material)) throw new Error('阶段缓存绑定版本或材料类型无效')
  const bindings: ReportStageBindings = { version: 'stage-bindings-1', material: first.material as ReportStageBindings['material'],
    fragments: [], provenance: [], sources: [], candidates: [], members: [], targets: [], statistics: [] }
  let exchange: SavedStageExchange | undefined
  for (const row of records.slice(1)) {
    const record = row as { type: string; value: unknown; key: string; alias: string }
    if (!record || typeof record.type !== 'string' || exchange) throw new Error('阶段缓存记录类型或顺序无效')
    if (record.type === 'provenance') {
      assertReportFields(record, ['type', 'key'], '阶段来源引用'); if (typeof record.key !== 'string') throw new Error('阶段来源引用无效')
      bindings.provenance.push(record.key); continue
    }
    if (record.type === 'target') {
      assertReportFields(record, ['type', 'alias'], '阶段成员目标'); if (typeof record.alias !== 'string') throw new Error('阶段成员目标无效')
      bindings.targets.push(record.alias); continue
    }
    assertReportFields(record, ['type', 'value'], '阶段交换记录')
    if (record.type === 'fragment') bindings.fragments.push(record.value as ReportStageBindings['fragments'][number])
    else if (record.type === 'source') bindings.sources.push(record.value as ReportStageBindings['sources'][number])
    else if (record.type === 'candidate') bindings.candidates.push(record.value as ReportStageBindings['candidates'][number])
    else if (record.type === 'member') bindings.members.push(record.value as ReportStageBindings['members'][number])
    else if (record.type === 'statistic') bindings.statistics.push(record.value as ReportStageBindings['statistics'][number])
    else if (record.type === 'exchange') exchange = record.value as SavedStageExchange
    else throw new Error('阶段缓存含未知记录')
  }
  if (!exchange) throw new Error('阶段缓存缺少完整交换结果')
  return { bindings, exchange }
}

// 重放相同读取器和唯一恢复，所有结构化成员/来源均由本次上下文恢复。
function replayStageExchange<T>(exchange: SavedStageExchange, count: number, validate: (text: string) => T, recover?: (error: unknown) => AnalysisUnitRecovery<T> | undefined): T {
  assertReportFields(exchange, ['recovery', 'responses'], '阶段恢复交换')
  if (!Array.isArray(exchange.responses) || exchange.responses.some(response => typeof response !== 'string')) throw new Error('阶段缓存交换正文无效')
  if (count === 1 && exchange.recovery === 'none' && exchange.responses.length === 1) return validate(exchange.responses[0])
  if (count === 2 && exchange.recovery === 'full' && exchange.responses.length === 1) return validate(exchange.responses[0])
  if (count === 2 && exchange.recovery === 'targeted' && exchange.responses.length === 2) {
    let error: unknown
    try { validate(exchange.responses[0]) } catch (failure) { error = failure }
    const repair = error !== undefined ? recover?.(error) : undefined
    if (!repair) throw new Error('阶段缓存定向恢复不能在当前契约重建')
    return repair.validate(exchange.responses[1])
  }
  throw new Error('阶段缓存实际次数与恢复交换不一致')
}

// 只保留恢复确实需要的合法首轮片段；完整恢复的非法原返回不重复保存。
function createStageExchange<T>(attempts: readonly AnalysisUnitAttempt[], value: T, validate: (text: string) => T, recover?: (error: unknown) => AnalysisUnitRecovery<T> | undefined, requireNormalFinish = false): SavedStageExchange {
  let exchange: SavedStageExchange = { recovery: 'none', responses: [attempts[0].response] }
  if (attempts.length === 2) {
    let failure: unknown
    if (attempts[0].execution?.finishReason !== 'length' && (!requireNormalFinish || (attempts[0].execution?.finishReasonReadable && attempts[0].execution.finishReason === 'stop'))) {
      try { validate(attempts[0].response) } catch (error) { failure = error }
      if (!failure) throw new Error('阶段缓存首轮已成功却出现额外恢复')
    }
    const targeted = failure !== undefined ? recover?.(failure) : undefined
    exchange = targeted ? { recovery: 'targeted', responses: attempts.map(attempt => attempt.response) }
      : { recovery: 'full', responses: [attempts[1].response] }
  }
  if (!isDeepStrictEqual(replayStageExchange(exchange, attempts.length, validate, recover), value)) throw new Error('阶段缓存重建结果与当前合法结果不一致')
  return exchange
}

// --- 可信缓存入口 ---

export class ReportStageCache {
  readonly taskIdentity: PagedReportStore['taskIdentity']
  readonly enabled: boolean
  private readonly policies: ReportStageCachePolicies
  private readonly candidates: Array<{ id: string; createdAtMs: number; metadata: unknown }> = []

  // 当前完整来源先冻结并保护；历史未知来源保持禁用，不借缓存提升完整性。
  constructor(private readonly options: StageCacheOptions) {
    this.options = Object.freeze({ ...options, context: JSON.parse(JSON.stringify(options.context)) })
    this.taskIdentity = options.store.taskIdentity
    this.policies = JSON.parse(JSON.stringify(options.policies))
    CACHED_STAGES.forEach(stage => assertReportCachePolicy(this.policies[stage]))
    this.enabled = options.context.sourceCompleteness === 'complete' && options.snapshot.hasStableMessageIds
    if (!this.enabled) return
    const current = options.store.read(options.snapshotCommit, 'snapshot', (metadata, records) => {
      const decoded = decodeReportSnapshot(metadata, records)
      if (!isDeepStrictEqual(decoded.context, options.context) || !isDeepStrictEqual(decoded.evidence.sources, options.snapshot.sources)) throw new Error('阶段缓存缺少本次完整真实来源')
    })
    if (!current) throw new Error('阶段缓存必要来源快照缺失或过期')
    const index = options.store.listUnitLocators()
    if (!index.publishable) { this.enabled = false; this.diagnostic('locator_unavailable', '', '定位索引发布失败，禁用本次跨任务缓存'); return }
    this.candidates.push(...index.candidates)
    index.invalidIds.forEach(id => this.diagnostic('invalid_commit', id, '阶段定位清单损坏'))
  }

  // 可选审计不能覆盖实际任务或文件错误，不输出正文、凭据或未知文件名。
  private diagnostic(code: string, id: string, message: string): void {
    try { this.options.onDiagnostic?.(code, STAGE_CACHE_HASH.test(id) ? id : 'invalid-file', message.slice(0, 200)) } catch { /* 可选审计不改变任务结果。 */ }
  }

  // 实际请求、永久绑定、报告模式、规则及单节点政策共同决定身份，不含任务编号或截止。
  private identity(snapshot: ReportEvidence, request: ReportStageCacheRequest): string {
    if (!isDeepStrictEqual(snapshot.sources, this.options.snapshot.sources) || !isDeepStrictEqual(snapshot.fragments, this.options.snapshot.fragments)) throw new Error('阶段缓存不属于当前固定输入')
    if (!CACHED_STAGES.includes(request.stage) || !['ordinary', 'detailed'].includes(request.mode) || !request.system || !request.input
      || request.maxTokens !== (['grouping', 'selection'].includes(request.stage) ? 4096 : 2048)) throw new Error('阶段缓存实际请求条件无效')
    verifyReportStageOrigin(snapshot, request.bindings)
    return reportCacheDigest({ version: 'stage-request-1', analysisVersion: 'grounded-report-1', stage: request.stage, mode: request.mode,
      channelKey: this.taskIdentity.channelKey, periodStartMs: this.options.context.period.periodStartMs, periodEndMs: this.options.context.period.periodEndMs,
      system: request.system, input: request.input, bindings: request.bindings, policyIdentity: this.policies[request.stage].identity,
      parameters: { temperature: 0.2, thinking: false, maxTokens: request.maxTokens,
        ...(request.requireNormalFinish ? { requireNormalFinish: true } : {}) } })
  }

  // 输出摘要和永久表均须匹配当前实际材料，再重放原契约恢复本次来源/成员。
  private validate<T>(metadata: unknown, records: readonly unknown[], identity: string, request: ReportStageCacheRequest,
    validate: (text: string) => T, recover?: (error: unknown) => AnalysisUnitRecovery<T> | undefined): T {
    assertReportFields(metadata, ['version', 'stage', 'mode', 'requestIdentity', 'policyIdentity', 'sourceSnapshotCommit', 'origin', 'productIdentity', 'actualAttempts'], '阶段缓存清单')
    const value = metadata as unknown as StageCacheMetadata, policy = this.policies[request.stage]
    if (value.version !== 'stage-cache-1' || value.stage !== request.stage || value.mode !== request.mode || value.requestIdentity !== identity
      || value.policyIdentity !== policy.identity || !STAGE_CACHE_HASH.test(value.sourceSnapshotCommit) || !value.origin?.taskId
      || !Number.isFinite(value.origin.deadlineMs)) throw new Error('阶段缓存版本、实际条件或来源任务不一致')
    assertReportCacheAttempts(value.actualAttempts, policy)
    const lastExecution = value.actualAttempts[value.actualAttempts.length - 1].execution
    if (request.requireNormalFinish && (!lastExecution.finishReasonReadable || lastExecution.finishReason !== 'stop')) throw new Error('阶段缓存缺少可验证的正常结束')
    if (value.productIdentity !== reportCacheDigest({ requestIdentity: identity, policyIdentity: policy.identity, records, actualAttempts: value.actualAttempts })) throw new Error('阶段可信产物摘要不一致')
    const decoded = decodeStageCacheRecords(records)
    if (!isDeepStrictEqual(decoded.bindings, request.bindings)) throw new Error('阶段缓存永久来源或人物别名所有权变化')
    return replayStageExchange(decoded.exchange, value.actualAttempts.length, validate, recover)
  }

  // 原始见证必须完整且同业务范围；摘要还必须由当前已成功上游重建相同请求才能命中。
  private validateSource(metadata: unknown, records: readonly unknown[], bindings: ReportStageBindings): void {
    const original = decodeReportSnapshot(metadata, records)
    if (original.context.sourceCompleteness !== 'complete' || original.context.period.periodStartMs !== this.options.context.period.periodStartMs
      || original.context.period.periodEndMs !== this.options.context.period.periodEndMs) throw new Error('阶段缓存原始来源完整性或业务窗口变化')
    verifyReportStageOrigin(original.evidence, bindings)
  }

  // 只读预检可明确失效损坏缓存；采用时再次保护与校验，必要发布失败必须传播。
  read<T>(snapshot: ReportEvidence, request: ReportStageCacheRequest, validate: (text: string) => T,
    recover?: (error: unknown) => AnalysisUnitRecovery<T> | undefined): { value: T; history: ReportStageCacheHistory } | null {
    if (!this.enabled) return null
    const identity = this.identity(snapshot, request), policy = this.policies[request.stage]
    const candidates = this.candidates.filter(candidate => {
      const value = candidate.metadata as Partial<StageCacheMetadata> | null
      return value?.version === 'stage-cache-1' && value.requestIdentity === identity && value.policyIdentity === policy.identity
    }).sort((a, b) => {
      const rank = (metadata: unknown): number => (metadata as { lastRouteIdentity: string }).lastRouteIdentity === policy.first.routeIdentity ? 0 : 1
      return rank(a.metadata) - rank(b.metadata) || a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id)
    })
    for (const candidate of candidates) {
      let value: StageCacheMetadata
      try {
        const unit = this.options.store.inspect(candidate.id, 'unit', (metadata, records) => this.validate(metadata, records, identity, request, validate, recover))
        if (!unit) continue
        value = unit.metadata as StageCacheMetadata
        if (!this.options.store.inspect(value.sourceSnapshotCommit, 'snapshot', (metadata, records) => this.validateSource(metadata, records, request.bindings))) {
          this.diagnostic('source_unavailable', candidate.id, '阶段原始来源快照已缺失或过期'); continue
        }
      } catch (error) {
        if (!(error instanceof ReportStoredDataError)) throw error
        this.diagnostic('invalid_cache_data', candidate.id, error.message); continue
      }
      if (!this.options.store.read(value.sourceSnapshotCommit, 'snapshot', (metadata, records) => this.validateSource(metadata, records, request.bindings))) throw new Error('阶段缓存采用前原来源失效')
      let restored: T | undefined
      const unit = this.options.store.read(candidate.id, 'unit', (metadata, records) => { restored = this.validate(metadata, records, identity, request, validate, recover) })
      if (!unit) throw new Error('阶段缓存采用前提交失效')
      return { value: restored as T, history: { stage: request.stage, commitId: candidate.id, sourceSnapshotCommit: value.sourceSnapshotCommit,
        origin: value.origin, actualAttempts: value.actualAttempts } }
    }
    return null
  }

  // 校验实际节点与可重建交换后保存，成功返回前必须完成末尾清单及任务保护发布。
  save<T>(snapshot: ReportEvidence, request: ReportStageCacheRequest, attempts: readonly AnalysisUnitAttempt[], result: T,
    validate: (text: string) => T, recover?: (error: unknown) => AnalysisUnitRecovery<T> | undefined): string | null {
    if (!this.enabled) return null
    const identity = this.identity(snapshot, request), policy = this.policies[request.stage]
    let actualAttempts: ReportCacheActualAttempt[]
    try { actualAttempts = verifyReportCacheAttempts(attempts, policy, request.system, request.input, request.maxTokens) } catch (error) {
      this.diagnostic('actual_model_unverified', identity, error instanceof Error ? error.message : String(error)); return null
    }
    const exchange = createStageExchange(attempts, result, validate, recover, request.requireNormalFinish), records = stageCacheRecords(request.bindings, exchange)
    const metadata: StageCacheMetadata = { version: 'stage-cache-1', stage: request.stage, mode: request.mode, requestIdentity: identity,
      policyIdentity: policy.identity, sourceSnapshotCommit: this.options.snapshotCommit,
      origin: { taskId: this.taskIdentity.taskId, deadlineMs: this.taskIdentity.deadlineMs }, actualAttempts,
      productIdentity: reportCacheDigest({ requestIdentity: identity, policyIdentity: policy.identity, records, actualAttempts }) }
    const id = this.options.store.commit('unit', metadata, records, (value, rows) => this.validate(value, rows, identity, request, validate, recover), 'unit-record-fragments-1')
    const committed = this.options.store.inspect(id, 'unit', (value, rows) => this.validate(value, rows, identity, request, validate, recover))!
    const locator = projectReportUnitLocator(metadata)
    if (locator) this.candidates.push({ id, metadata: locator, createdAtMs: committed.createdAtMs })
    return id
  }
}
