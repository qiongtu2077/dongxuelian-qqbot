/**
 * MODULE: 正式日报有据链的专用配置、一次收集与可信存储接线。
 * 边界: 调用方持有S0和有效任务领取；本模块不投递、不建后台总账。
 * 启用: 专用开关默认关闭；前后台共用同一显式模型节点。
 */
import collector = require('./data-collector')
import { createReportEvidence } from './report-evidence'
import type { EvidenceMessage } from './report-evidence'
import { PagedReportStore } from './report-storage'
import { saveReportSnapshot } from './report-snapshots'
import type { ReportSnapshotContext } from './report-snapshots'
import { updateStoredReportBatchCatalog } from './report-batch-catalog'
import { ReportClassificationCache } from './report-classification-cache'
import { ReportStageCache } from './report-stage-cache'
import { createGroundedModelRequest } from './report-model'
import { runGroundedReport } from './report-runner'
import type { GroundedReportOptions } from './report-runner'
import { loadManagementModule } from 'koishi-plugin-dongxuelian-ai/lib/public/management-runtime'
const { readResourceSnapshot } = loadManagementModule('resource.snapshot')

type ReportPeriod = NonNullable<Parameters<typeof collector.collectReportData>[1]>
export interface GroundedReportConfiguration { provider: string; model: string }
export interface CollectedGroundedReport {
  data: ReturnType<typeof collector.collectReportData>; fullMessages: EvidenceMessage[]; cacheEligible: boolean
}
interface GroundedEntryOptions extends Omit<GroundedReportOptions, 'request' | 'classificationCatalog' | 'classificationCache' | 'stageCache' | 'concurrency'> {
  taskId: string; channelKey: string; configuration: GroundedReportConfiguration
  periodBackfilled?: boolean
  assertActive(): void; assertLease(): void
}

// --- 专用配置与一次来源收集 ---

// 开关默认关闭；启用时缺少显式节点准确失败，型号与能力由公共工厂核对。
export function readGroundedReportConfiguration(): GroundedReportConfiguration | null {
  if (process.env.DAILY_REPORT_GROUNDED_ENABLED !== '1') return null
  const provider = String(process.env.DAILY_REPORT_GROUNDED_PROVIDER || '').trim()
  const model = String(process.env.DAILY_REPORT_GROUNDED_MODEL || '').trim()
  if (!provider || !model) throw new Error('有据日报需要明确配置DAILY_REPORT_GROUNDED_PROVIDER和DAILY_REPORT_GROUNDED_MODEL')
  return Object.freeze({ provider, model })
}

// 完整窗口与最新入选记录只扫描一次；未知完整性与非永久身份不升级为可信缓存。
export function collectGroundedReportInput(channelKey: unknown, period: ReportPeriod, assertActive: () => void): CollectedGroundedReport {
  const fullMessages: EvidenceMessage[] = []
  let trustworthy = true
  const data = collector.collectReportData(channelKey, period, (message, record) => {
    assertActive()
    if (record.recordVersion !== 2 || record.bodyComplete !== true || record.realMessageId !== true) trustworthy = false
    fullMessages.push(message)
  })
  assertActive()
  if (data && fullMessages.length !== data.windowMessageCount) throw new Error('日报完整窗口收录数量不一致')
  return { data, fullMessages, cacheEligible: !!data && trustworthy && data.sourceCompleteness === 'complete' }
}

// --- 原任务存储与正式编排 ---

// 只连接已实现的目录、快照、缓存和编排；每次真实请求前后继续核对原领取及S0。
export async function analyzeGroundedReport(input: CollectedGroundedReport, full: boolean, options: GroundedEntryOptions) {
  if (!input.data) throw new Error('有据日报分析缺少当前原始输入')
  options.assertActive(); options.assertLease()
  const data = input.data, now = options.now || Date.now
  const store = new PagedReportStore({ taskId: options.taskId, channelKey: options.channelKey, deadlineMs: options.deadlineMs,
    now, assertActive: options.assertActive, assertLease: options.assertLease })
  const model = await createGroundedModelRequest({ configuredNode: options.configuration })
  options.assertActive(); options.assertLease()
  const snapshot = createReportEvidence(data.messages)
  // worker的periodBackfilled是执行标记；快照窗口只保存已知五个业务字段，保留原起止值供快照严格验证。
  const { reportPolicyVersion, reportDate, periodStartMs, periodEndMs, cutoffMs } = data.reportPeriod
  const context: ReportSnapshotContext = { period: { reportPolicyVersion, reportDate, periodStartMs, periodEndMs, cutoffMs }, sourceCompleteness: data.sourceCompleteness === 'complete' ? 'complete' : 'legacy_unknown',
    statistics: { totalMessages: data.totalMessages, activeMembers: data.activeMembers, emojiCount: data.emojiCount, totalChars: data.totalChars,
      hourlyActivity: data.hourlyActivity, peakHour: data.peakHour, topMembers: data.topMembers } }
  const snapshotCommit = saveReportSnapshot(store, snapshot, context)
  const entire = input.cacheEligible ? createReportEvidence(input.fullMessages) : null
  const catalog = entire?.hasStableMessageIds && snapshot.hasStableMessageIds
    ? updateStoredReportBatchCatalog(store, entire, { channelKey: options.channelKey, period: context.period,
      sourceCompleteness: 'complete', inputScope: 'full_business_window', nowMs: store.currentTimeMs() }) : null
  const caches = catalog ? {
    classificationCatalog: { channelKey: options.channelKey, value: catalog.value },
    classificationCache: new ReportClassificationCache({ store, snapshot, context, snapshotCommit, policy: model.classificationCachePolicy }),
    stageCache: new ReportStageCache({ store, snapshot, context, snapshotCommit, policies: model.stageCachePolicies }),
  } : {}
  const resources = readResourceSnapshot()
  const concurrency = resources.resourceState === 'green' && resources.memAvailableMb !== null && resources.memAvailableMb >= 600 && !resources.toolActive && !resources.renderActive ? 2 : 1
  const analysis = await runGroundedReport({ ...data, periodBackfilled: options.periodBackfilled }, full, {
    ...options, ...caches, concurrency,
    request: async (...args) => {
      options.assertActive(); options.assertLease()
      const text = await model.request(...args)
      options.assertActive(); options.assertLease()
      return text
    },
  })
  options.assertActive(); options.assertLease()
  return { analysis, storage: { snapshotCommit, catalogCommit: catalog?.id || null, crossTaskCacheEligible: catalog !== null,
    policyIdentity: model.policyIdentity, routing: model.routing } }
}
