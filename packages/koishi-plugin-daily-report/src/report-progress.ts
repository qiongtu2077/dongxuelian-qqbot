/**
 * MODULE: 日报完整处理、深读与展示的独立计数。
 * 职责: 根据当前快照与实际核心片段集合生成公开数量。
 * 边界: 不判断语义/缓存资格、不读取正文以外的新消息、不改变旧coverage含义。
 * 状态: 无全局状态，不持久化临时引用。
 */
import type { ManagementModule } from 'koishi-plugin-dongxuelian-ai/lib/public/management-runtime'
import type { ReportEvidence } from './report-evidence'
import { assertReportFields } from './report-exchange'

type ReportEvidenceMetrics = NonNullable<ReturnType<ManagementModule<'daily.reportAnalysis'>['createReportAnalysisDiagnostics']>['evidence']>

export interface ReportProgressInput {
  submitted: readonly string[]; classified: readonly string[]; deterministic: readonly string[]; cached: readonly string[]
  selected: readonly string[]; deepRead: readonly string[]; displayed: readonly string[]
}

// 核心重复归属按唯一片段计数，未知/辅助引用拒绝；长消息全部片段成功才完整处理。
export function createReportEvidenceMetrics(snapshot: ReportEvidence, input: ReportProgressInput): ReportEvidenceMetrics {
  assertReportFields(input, ['submitted', 'classified', 'deterministic', 'cached', 'selected', 'deepRead', 'displayed'], '核心处理计数')
  const groups = Object.fromEntries(Object.entries(input).map(([key, values]) => {
    if (!Array.isArray(values) || values.some(id => !snapshot.byFragmentId.has(id))) throw new Error('日报证据计数只能使用当前实际核心片段')
    return [key, new Set<string>(values)]
  })) as Record<keyof ReportProgressInput, Set<string>>
  for (const [subset, parent] of [['deterministic', 'classified'], ['cached', 'classified'], ['selected', 'classified'], ['deepRead', 'selected'], ['displayed', 'deepRead']] as const) {
    if ([...groups[subset]].some(id => !groups[parent].has(id))) throw new Error('日报证据计数不能将未处理材料记成已深读或展示')
  }
  if ([...groups.deterministic].some(id => groups.cached.has(id) || groups.submitted.has(id))) throw new Error('确定规则与缓存或模型核心提交重复')
  // 提交/话题关联以任一真实片段计原消息；完整处理另检查该来源全部片段。
  const sourceCount = (ids: Set<string>): number => new Set([...ids].map(id => snapshot.byFragmentId.get(id)!.sourceId)).size
  const incomplete = new Set(snapshot.fragments.filter(fragment => !groups.classified.has(fragment.id)).map(fragment => fragment.sourceId))
  const processed = snapshot.sources.length - incomplete.size
  return { version: 1, selectedFragmentCount: snapshot.fragments.length,
    modelSubmittedMessageCount: sourceCount(groups.submitted), modelSubmittedFragmentCount: groups.submitted.size,
    processedMessageCount: processed, processedFragmentCount: groups.classified.size,
    deterministicMessageCount: sourceCount(groups.deterministic), deterministicFragmentCount: groups.deterministic.size,
    cacheHitMessageCount: sourceCount(groups.cached), cacheHitFragmentCount: groups.cached.size,
    selectedTopicMessageCount: sourceCount(groups.selected), selectedTopicFragmentCount: groups.selected.size,
    deepReadMessageCount: sourceCount(groups.deepRead), deepReadFragmentCount: groups.deepRead.size,
    displayedTopicMessageCount: sourceCount(groups.displayed), displayedTopicFragmentCount: groups.displayed.size,
    unprocessedMessageCount: incomplete.size, processingCoverageRate: snapshot.sources.length ? processed / snapshot.sources.length * 100 : null }
}
