/**
 * MODULE: 日报后台任务的真实原始输入与单批执行入口。
 * 边界: 调用方持有S0及有效S2领取；不启用开关、不建账、不投递。
 */
const { collectReportData } = require('./data-collector') as typeof import('./data-collector')
import { createReportEvidence } from './report-evidence'
import type { EvidenceMessage } from './report-evidence'
import { PagedReportStore } from './report-storage'
import { saveReportSnapshot } from './report-snapshots'
import { updateStoredReportBatchCatalog, selectReportCatalogBatches } from './report-batch-catalog'
import { createGroundedModelRequest } from './report-model'
import { runReportBackgroundBatch } from './report-background'
import { ReportBackgroundLedger } from './report-background-ledger'
import { ReportClassificationCache } from './report-classification-cache'
import { reportCacheDigest } from './report-cache-provenance'
import { loadManagementModule } from 'koishi-plugin-dongxuelian-ai/lib/public/management-runtime'
const { createReportPeriod } = loadManagementModule('daily.reportPeriod')

interface PreanalysisOptions {
  taskId: string; channelKey: string; period: ReturnType<typeof createReportPeriod>
  startedAtMs: number; deadlineMs: number; signal: AbortSignal
  assertActive(): void; assertLease(): void; hasForegroundPending(): boolean
}

// 规划与执行都限定在本次原始时限及既有独占租约内，不能借复验续期。
function preanalysisStore(options: PreanalysisOptions): PagedReportStore {
  if (options.deadlineMs !== options.startedAtMs + 90000) throw new Error('日报预分析必须沿用原九十秒截止')
  const assertActive = (): void => {
    if (options.signal.aborted) throw options.signal.reason || new Error('日报预分析已取消')
    options.assertActive()
    if (Date.now() >= options.deadlineMs) throw new Error('日报预分析已超过原九十秒截止')
  }
  return new PagedReportStore({ ...options, assertActive })
}

// 完整目录与最新分析材料共用一遍真实索引读取；规划结果不证明模型处理完成。
function preparePreanalysisInput(options: PreanalysisOptions, store: PagedReportStore) {
  store.currentTimeMs()
  const fullMessages: EvidenceMessage[] = []
  const data = collectReportData(options.channelKey, options.period, (message, record) => {
    store.currentTimeMs()
    // 目录采用完整窗口，窗口外或未入选的损失记录不能被入选完整性掩盖。
    if (record.bodyComplete === false || record.recordVersion !== 2 || record.realMessageId !== true) {
      throw new Error('日报预分析完整窗口缺少可信完整正文或永久身份')
    }
    fullMessages.push(message)
  })
  if (!data) return null
  if (data.sourceCompleteness !== 'complete' || fullMessages.length !== data.windowMessageCount) throw new Error('日报预分析完整窗口收录不一致')
  const full = createReportEvidence(fullMessages), snapshot = createReportEvidence(data.messages)
  const context = { period: options.period, sourceCompleteness: 'complete' as const,
    statistics: { totalMessages: data.totalMessages, activeMembers: data.activeMembers, emojiCount: data.emojiCount,
      totalChars: data.totalChars, hourlyActivity: data.hourlyActivity, peakHour: data.peakHour, topMembers: data.topMembers } }
  // 按可核验代次读取最新目录；同毫秒连续提交也不能依赖摘要字典序。
  const { value: catalog } = updateStoredReportBatchCatalog(store, full, { channelKey: options.channelKey, period: options.period,
    sourceCompleteness: 'complete', inputScope: 'full_business_window', nowMs: store.currentTimeMs() })
  const snapshotCommit = saveReportSnapshot(store, snapshot, context)
  return { snapshot, context, snapshotCommit, catalog }
}

// 排队前核对预算与真实未完成封闭批次；零模型请求，成功候选先记录持久化调度间隔。
export async function planReportPreanalysisTask(options: PreanalysisOptions): Promise<{ ready: boolean; reason: string; catalogId?: string }> {
  const store = preanalysisStore(options)
  store.currentTimeMs()
  if (options.hasForegroundPending()) return { ready: false, reason: 'foreground' }
  const model = await createGroundedModelRequest({ configuredNode: { provider: 'custom-1c571761199978de80368aba', model: 'deepseek-v4-flash' } })
  const ledger = new ReportBackgroundLedger({ store, startedAtMs: options.startedAtMs,
    unitIdentity: reportCacheDigest({ purpose: 'planning', taskId: options.taskId }),
    policy: model.classificationCachePolicy, hasForegroundPending: options.hasForegroundPending })
  const state = ledger.schedulingState()
  if (!state.allowed) return { ready: false, reason: state.reason }
  const input = preparePreanalysisInput(options, store)
  if (!input) return { ready: false, reason: 'no_records' }
  const cache = new ReportClassificationCache({ store, ...input, policy: model.classificationCachePolicy })
  if (!cache.enabled) throw new Error('后台规划缺少可信缓存核验资格')
  for (const view of selectReportCatalogBatches(input.catalog, input.snapshot)) {
    store.currentTimeMs()
    if (!view.complete || !view.sealed || !view.batch) continue
    if (cache.read(input.snapshot, view.batch, view.ruleIdentity)) continue
    ledger.recordSchedule()
    return { ready: true, reason: 'unfinished_closed_batch', catalogId: view.catalogId }
  }
  return { ready: false, reason: 'no_unfinished_closed_batch' }
}

// 工作器重新读取真实来源及当前可信产物，仍只执行一个分类单元。
export async function runReportPreanalysisTask(options: PreanalysisOptions): Promise<Record<string, unknown>> {
  const store = preanalysisStore(options)
  store.currentTimeMs()
  if (options.hasForegroundPending()) return { status: 'idle', reason: 'foreground_pending' }
  const input = preparePreanalysisInput(options, store)
  if (!input) return { status: 'idle', reason: 'no_records' }
  const model = await createGroundedModelRequest({ configuredNode: { provider: 'custom-1c571761199978de80368aba', model: 'deepseek-v4-flash' } })
  store.currentTimeMs()
  const result = await runReportBackgroundBatch({ store, ...input,
    startedAtMs: options.startedAtMs, signal: options.signal, hasForegroundPending: options.hasForegroundPending,
    policy: model.classificationCachePolicy, request: model.request })
  store.currentTimeMs()
  return { ...result, mode: 'daily_report_preanalysis' }
}
