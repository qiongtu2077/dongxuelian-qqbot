/**
 * MODULE: 日报单个封闭分类批次的后台协调器。
 * 职责: 精确跳过可信产物、原九十秒内分类/唯一恢复、先计额后提交与可信发布。
 * 边界: 不注册调度、不初始化总账、不投递；入口依赖调用方已有S0和有效任务。
 */
import { PagedReportStore } from './report-storage'
import { ReportClassificationCache } from './report-classification-cache'
import { ReportBackgroundLedger, ReportBackgroundLedgerError } from './report-background-ledger'
import type { ReportBackgroundReservation } from './report-background-ledger'
import { selectReportCatalogBatches } from './report-batch-catalog'
import type { ReportBatchCatalog } from './report-batch-catalog'
import type { ReportEvidence } from './report-evidence'
import type { ReportSnapshotContext } from './report-snapshots'
import { createClassificationRequestIdentity } from './report-bindings'
import { getReportClassificationInstructions, readReportClassification, createReportClassificationRepair } from './report-candidates'
import type { ClassificationRecord } from './report-candidates'
import { requestAnalysisUnit } from './complete-input'
import type { AnalysisRuntime, AnalysisUnitAttempt } from './complete-input'
import type { GroundedReportOptions } from './report-runner'
import { ReportRequestBoundaryError, ReportRequestPool } from './report-request-pool'
import type { ReportCacheModelPolicy } from './report-cache-provenance'
import { reportCacheDigest } from './report-cache-provenance'
const { loadManagementModule } = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime') as typeof import('koishi-plugin-dongxuelian-ai/lib/public/management-runtime')
const { createReportAnalysisDiagnostics, ReportAnalysisError } = loadManagementModule('daily.reportAnalysis')

interface BackgroundOptions {
  store: PagedReportStore; snapshot: ReportEvidence; snapshotCommit: string; context: ReportSnapshotContext; catalog: ReportBatchCatalog
  startedAtMs: number; policy: ReportCacheModelPolicy; request: GroundedReportOptions['request']; hasForegroundPending(): boolean; signal?: AbortSignal
  onDiagnostic?: (code: string, id: string, message: string) => void
  classifyQuotaFailure?: (error: ReportRequestBoundaryError) => 'none' | 'group' | 'global'
}
export interface ReportBackgroundResult {
  status: 'complete' | 'idle'; reason: 'classified' | 'no_unfinished_closed_batch'; catalogId: string | null; commitId: string | null
  requestCount: number; recoveryCount: number; skippedCached: number; processedMessageCount: number
}
type RequestStep = NonNullable<AnalysisUnitAttempt['upstreamAttempts']>[number]
type Execution = NonNullable<AnalysisUnitAttempt['execution']>

// 一次最多一个完整封闭批次；同一分类输入、永久来源与政策才能被前台精确采用。
export async function runReportBackgroundBatch(options: BackgroundOptions): Promise<ReportBackgroundResult> {
  const { store, snapshot, context } = options, { taskId, channelKey, deadlineMs } = store.taskIdentity
  if (deadlineMs !== options.startedAtMs + 90000 || !Number.isSafeInteger(options.startedAtMs)
    || context.sourceCompleteness !== 'complete' || !snapshot.hasStableMessageIds || options.catalog.scope.channelKey !== channelKey
    || context.period.periodStartMs !== options.catalog.scope.periodStartMs || context.period.periodEndMs !== options.catalog.scope.periodEndMs) {
    throw new ReportRequestBoundaryError('contract', '后台批次需要同群完整永久来源、相同业务范围及原九十秒任务')
  }
  const controller = new AbortController(), pool = new ReportRequestPool(1)
  // 检查同时覆盖内存信号、持久任务领取、S0和原时刻，缓存命中也不能绕过。
  const assertWork = (): number => {
    if (controller.signal.aborted || options.signal?.aborted) throw controller.signal.reason || options.signal?.reason || new Error('后台任务已取消')
    const now = store.currentTimeMs()
    if (now < options.startedAtMs) throw new ReportRequestBoundaryError('contract', '后台任务起点不能在未来')
    return now
  }
  const onAbort = (): void => controller.abort(options.signal?.reason || new Error('后台任务已取消'))
  options.signal?.addEventListener('abort', onAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const now = assertWork()
    timer = setTimeout(() => controller.abort(new Error('后台任务原九十秒截止')), deadlineMs - now)
    if (options.hasForegroundPending()) throw new ReportBackgroundLedgerError('foreground', '前台日报待运行，后台不启动分类')
    const cache = new ReportClassificationCache({ store, snapshot, snapshotCommit: options.snapshotCommit, context, policy: options.policy, onDiagnostic: options.onDiagnostic })
    if (!cache.enabled) throw new ReportRequestBoundaryError('contract', '后台分类必须具备可信缓存发布资格，不能仅生成不可复用结果')
    const views = selectReportCatalogBatches(options.catalog, snapshot)
    let skippedCached = 0
    for (const view of views) {
      assertWork()
      if (!view.complete || !view.sealed || !view.batch) continue
      if (options.hasForegroundPending()) throw new ReportBackgroundLedgerError('foreground', '前台日报已到达，后台不启动下一批')
      const batch = view.batch
      if (cache.read(snapshot, batch, view.ruleIdentity)) { skippedCached++; assertWork(); continue }
      const system = getReportClassificationInstructions()
      const identity = createClassificationRequestIdentity(snapshot, batch, { channelKey, periodStartMs: context.period.periodStartMs,
        periodEndMs: context.period.periodEndMs, sourceCompleteness: context.sourceCompleteness, modelPolicyIdentity: options.policy.identity,
        batchRuleIdentity: view.ruleIdentity, system, maxTokens: 4096 })
      if (!identity) throw new ReportRequestBoundaryError('contract', '后台分类缺少精确实际请求身份')
      const ledger = new ReportBackgroundLedger({ store, startedAtMs: options.startedAtMs, unitIdentity: identity,
        policy: options.policy, hasForegroundPending: options.hasForegroundPending })
      if (ledger.snapshot().unresolved) throw new ReportBackgroundLedgerError('unresolved', '当日存在结果未知的后台预留，停止该群新请求')
      const meta = createReportAnalysisDiagnostics({ reportPeriod: context.period, windowMessageCount: snapshot.sources.length,
        selectedMessageCount: batch.fragments.length, sourceCompleteness: 'complete' })
      meta.batchCount = 1; meta.analysisState = 'processing'
      let round = 0, responseReceived = false, commitId: string | null = null
      const runtime: AnalysisRuntime = {
        deadlineMs, workDeadlineMs: deadlineMs, signal: controller.signal, now: () => store.currentTimeMs(), maxRequestCount: 2,
        recoveryInstructions: '仅返回当前明确契约的一个完整JSON对象，completed必须为true，不使用旧JSONL或end记录。',
        shouldRecover: error => responseReceived && !(error instanceof ReportRequestBoundaryError),
        onUnitCompleted(_unit, attempts, value) {
          assertWork()
          commitId = cache.save(snapshot, batch, view.ruleIdentity, attempts, value as ClassificationRecord[])
          if (!commitId) throw new ReportRequestBoundaryError('contract', '后台分类实际来源不可验证，禁止标记完成')
          assertWork()
        },
        request: async (requestSystem, input, maxTokens, extra) => {
          assertWork(); responseReceived = false
          const attempt = ++round as 1 | 2
          if (round > 2 || Array.from(requestSystem + input).length > 16000) throw new ReportRequestBoundaryError('contract', '后台分类请求次数或完整材料超限')
          return pool.run(extra.signal as AbortSignal, async () => {
            let reservation: ReportBackgroundReservation | undefined, execution: Execution | undefined, submitted = false
            const onAttempt = extra._onRequestAttempt as (step?: RequestStep) => void
            const onExecution = extra._onRequestExecution as (value: Execution) => void
            try {
              const text = await options.request('classification', attempt, requestSystem, input, maxTokens, { ...extra,
                _onRequestAttempt(step?: RequestStep) {
                  assertWork()
                  if (submitted || !step) throw new ReportRequestBoundaryError('contract', '后台请求拒绝隐藏重试及未知执行节点')
                  reservation = ledger.reserve(attempt, reportCacheDigest({ system: requestSystem, input, maxTokens, identity, attempt }), step)
                  submitted = true; onAttempt(step)
                },
                _onRequestExecution(value: Execution) { execution = value; onExecution(value) },
              })
              if (!reservation) throw new ReportRequestBoundaryError('contract', '后台请求没有实际提交回调，不能核对计额')
              assertWork()
              // 已收到文本但结构无效同样计额；结构读取与唯一恢复在共用引擎内处理。
              try { ledger.settle(reservation, 'returned', execution?.usage || null) }
              catch (error) { throw new ReportRequestBoundaryError('contract', '后台请求结算持久化失败：' + (error instanceof Error ? error.message : String(error))) }
              responseReceived = true
              return text
            } catch (error) {
              if (reservation && !responseReceived) {
                // 无法确认仍有效时保留未知预留；失效任务不能借结算写回文件。
                assertWork()
                if (error instanceof ReportRequestBoundaryError && error.kind === 'contract') throw error
                const quota = error instanceof ReportRequestBoundaryError ? options.classifyQuotaFailure?.(error) || 'none' : 'none'
                try { ledger.settle(reservation, 'failed', execution?.usage || null, quota) }
                catch (failure) { throw new ReportRequestBoundaryError('contract', '后台失败结算持久化失败：' + (failure instanceof Error ? failure.message : String(failure))) }
              }
              throw error
            }
          })
        },
      }
      await requestAnalysisUnit(runtime, meta, { id: view.catalogId, stage: 'classification', sourceIds: [...new Set(batch.fragments.map(fragment => fragment.sourceId))],
        timestamps: batch.fragments.map(fragment => snapshot.sources[fragment.sourceId - 1].ts!).filter(Number.isFinite) },
      system, batch.input, 4096, 45000, text => readReportClassification(text, batch), error => createReportClassificationRepair(error, batch))
      assertWork()
      if (!commitId) throw new ReportAnalysisError('后台分类未发布可信清单', 'generation_failed', 'classification', meta)
      return { status: 'complete', reason: 'classified', catalogId: view.catalogId, commitId, requestCount: meta.requestCount,
        recoveryCount: meta.retryCount, skippedCached, processedMessageCount: new Set(batch.fragments.map(fragment => fragment.sourceId)).size }
    }
    return { status: 'idle', reason: 'no_unfinished_closed_batch', catalogId: null, commitId: null, requestCount: 0, recoveryCount: 0, skippedCached, processedMessageCount: 0 }
  } finally {
    if (timer) clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    controller.abort(new Error('后台分类已结束'))
    await pool.drain()
  }
}
