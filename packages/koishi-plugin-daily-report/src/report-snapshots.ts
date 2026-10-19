/**
 * MODULE: 日报第二版固定来源快照。
 * 职责: 完整原文分片保存、严格重建和当前真实输入比对。
 * 边界: 缓存不能代替本次索引读取；历史未知完整性不升级为完整。
 */
import { isDeepStrictEqual } from 'util'
import { createReportEvidence } from './report-evidence'
import type { EvidenceMessage, ReportEvidence } from './report-evidence'
import type { PagedReportStore } from './report-storage'
const { loadManagementModule } = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime') as typeof import('koishi-plugin-dongxuelian-ai/lib/public/management-runtime')
const { createReportPeriod, isTimestampInReportPeriod } = loadManagementModule('daily.reportPeriod')

export interface ReportSnapshotContext {
  period: ReturnType<typeof createReportPeriod>
  sourceCompleteness: 'complete' | 'legacy_unknown'
  statistics: Record<string, unknown>
}
interface SnapshotMetadata extends ReportSnapshotContext {
  contract: 'report-snapshot-2'; evidenceIdentity: string; sourceCount: number; fragmentCount: number
}
interface SourceHeader {
  type: 'source'; identity: string; messageId: string | null; realMessageId: boolean | null
  userId: string; name: string; ts: number | null; time: string; replyToId: string | null; partCount: number
}
interface SnapshotFragment { type: 'fragment'; sourceIdentity: string; part: number; text: string; permanentKey: string | null }

// --- 明确快照契约与重建 ---

// 快照沿用现有四点窗口和完整性契约，不推断缺失时间或升级历史输入。
function assertSnapshotContext(context: ReportSnapshotContext): void {
  if (!context || !context.period || !['complete', 'legacy_unknown'].includes(context.sourceCompleteness)
    || !context.statistics || Object.getPrototypeOf(context.statistics) !== Object.prototype) throw new Error('日报快照上下文无效')
  const expected = createReportPeriod(context.period.cutoffMs)
  if (!isDeepStrictEqual(context.period, expected)) throw new Error('日报快照提交窗口不一致')
}

// 完整原文分为既定2400字符片段；永久来源元数据不包含本次连续引用。
function snapshotRecords(evidence: ReportEvidence): (SourceHeader | SnapshotFragment)[] {
  const records: (SourceHeader | SnapshotFragment)[] = []
  const fragments = new Map<number, ReportEvidence['fragments'][number][]>()
  for (const fragment of evidence.fragments) {
    const current = fragments.get(fragment.sourceId) || []
    current.push(fragment); fragments.set(fragment.sourceId, current)
  }
  for (const source of evidence.sources) {
    const parts = fragments.get(source.sourceId)
    if (!parts?.length) throw new Error('日报快照缺少完整来源片段')
    records.push({ type: 'source', identity: source.identity, messageId: source.messageId, realMessageId: source.realMessageId,
      userId: source.userId, name: source.name, ts: source.ts, time: source.time, replyToId: source.replyToId, partCount: parts.length })
    for (const part of parts) records.push({ type: 'fragment', sourceIdentity: source.identity, part: part.part,
      text: part.text, permanentKey: part.permanentKey })
  }
  return records
}

// 严格按完整记录顺序重建真实正文，再重新计算所有来源及永久片段摘要。
export function decodeReportSnapshot(metadata: unknown, records: readonly unknown[]): { evidence: ReportEvidence; context: ReportSnapshotContext } {
  const value = metadata as SnapshotMetadata
  if (!value || value.contract !== 'report-snapshot-2' || !Number.isSafeInteger(value.sourceCount) || value.sourceCount < 0
    || !Number.isSafeInteger(value.fragmentCount) || value.fragmentCount < 0 || typeof value.evidenceIdentity !== 'string') {
    throw new Error('日报快照元数据契约无效')
  }
  assertSnapshotContext(value)
  const messages: EvidenceMessage[] = [], headers: SourceHeader[] = [], allParts: SnapshotFragment[] = []
  for (let index = 0; index < records.length;) {
    const header = records[index++] as SourceHeader
    if (!header || header.type !== 'source' || !Number.isSafeInteger(header.partCount) || header.partCount < 1
      || typeof header.identity !== 'string' || typeof header.name !== 'string' || typeof header.time !== 'string'
      || typeof header.userId !== 'string' || !header.userId
      || !(header.messageId === null || typeof header.messageId === 'string')
      || !(header.replyToId === null || typeof header.replyToId === 'string')
      || !(header.realMessageId === null || typeof header.realMessageId === 'boolean')
      || !(header.ts === null || Number.isSafeInteger(header.ts))) throw new Error('日报快照来源记录无效')
    if (value.sourceCompleteness === 'complete' && (header.ts === null || !isTimestampInReportPeriod(header.ts, value.period))) {
      throw new Error('日报完整快照来源不在固定窗口内')
    }
    const texts: string[] = []
    for (let part = 1; part <= header.partCount; part++) {
      const fragment = records[index++] as SnapshotFragment
      if (!fragment || fragment.type !== 'fragment' || fragment.sourceIdentity !== header.identity || fragment.part !== part
        || typeof fragment.text !== 'string' || Array.from(fragment.text).length > 2400
        || !(fragment.permanentKey === null || typeof fragment.permanentKey === 'string')) throw new Error('日报快照来源片段不完整或错误绑定')
      texts.push(fragment.text); allParts.push(fragment)
    }
    messages.push({ content: texts.join(''), userId: header.userId, user: header.name, time: header.time,
      ...(header.messageId === null ? {} : { messageId: header.messageId }),
      ...(header.replyToId === null ? {} : { replyToId: header.replyToId }),
      ...(header.realMessageId === null ? {} : { realMessageId: header.realMessageId }),
      ...(header.ts === null ? {} : { ts: header.ts }) })
    headers.push(header)
  }
  const evidence = createReportEvidence(messages)
  if (evidence.sources.length !== value.sourceCount || evidence.fragments.length !== value.fragmentCount
    || evidence.identity !== value.evidenceIdentity || evidence.sources.some((source, index) => source.identity !== headers[index].identity)
    || evidence.fragments.some((fragment, index) => fragment.text !== allParts[index].text || fragment.part !== allParts[index].part
      || fragment.permanentKey !== allParts[index].permanentKey)) throw new Error('日报快照原文或永久来源摘要不一致')
  return { evidence, context: { period: value.period, sourceCompleteness: value.sourceCompleteness, statistics: value.statistics } }
}

// --- 固定快照发布及当前来源比对 ---

// 保存完整快照；统计和截止进入清单，正文页与请求协议或任务ID分离。
export function saveReportSnapshot(store: PagedReportStore, evidence: ReportEvidence, context: ReportSnapshotContext): string {
  assertSnapshotContext(context)
  const metadata: SnapshotMetadata = { ...context, contract: 'report-snapshot-2', evidenceIdentity: evidence.identity,
    sourceCount: evidence.sources.length, fragmentCount: evidence.fragments.length }
  return store.commit('snapshot', metadata, snapshotRecords(evidence), decodeReportSnapshot, 'snapshot-fragment-pages-1')
}

// 必须提供本次真实读取后的来源与统计，严格匹配后才允许复用固定快照。
export function readReportSnapshot(store: PagedReportStore, id: string, current: ReportEvidence, context: ReportSnapshotContext): ReportEvidence | null {
  assertSnapshotContext(context)
  let evidence: ReportEvidence | undefined
  const document = store.read(id, 'snapshot', (metadata, records) => { evidence = decodeReportSnapshot(metadata, records).evidence })
  if (!document || !evidence) return null
  const value = document.metadata as SnapshotMetadata
  if (!isDeepStrictEqual(value.period, context.period) || value.sourceCompleteness !== context.sourceCompleteness
    || !isDeepStrictEqual(value.statistics, context.statistics) || !isDeepStrictEqual(evidence.sources, current.sources)
    || !isDeepStrictEqual(evidence.fragments, current.fragments)) return null
  return evidence
}
