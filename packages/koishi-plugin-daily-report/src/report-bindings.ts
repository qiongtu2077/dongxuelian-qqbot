/**
 * MODULE: 日报分类产物的永久来源绑定与请求身份。
 * 职责: 短引用转永久消息/片段/本人，当前快照严格重绑及精确供料摘要。
 * 边界: 不请求模型、不落盘；历史未知标识不取得跨任务缓存资格。
 */
import { createHash } from 'crypto'
import { isDeepStrictEqual } from 'util'
import type { ClassificationRecord } from './report-candidates'
import type { EvidenceBatch, ReportEvidence } from './report-evidence'
import { assertReportFields } from './report-exchange'

interface PermanentCore {
  key: string; messageId: string; sourceIdentity: string; part: number; partCount: number; memberId: string
}
type PermanentRecord = { kind: 'event' | 'interaction'; category: string; title: string; summary: ''; keys: string[] }
  | { kind: 'quote'; key: string; memberId: string; reason: string }
export interface PermanentClassification {
  version: 'permanent-classification-1' | 'permanent-classification-2'; core: PermanentCore[]; members: Array<{ alias: string; memberId: string }>; records: PermanentRecord[]
}
export interface ClassificationIdentityOptions {
  channelKey: string; periodStartMs: number; periodEndMs: number; sourceCompleteness: 'complete' | 'legacy_unknown' | 'incomplete'
  modelPolicyIdentity: string; batchRuleIdentity: string; system: string; maxTokens: number
}
const CLASSIFICATION_REASONS = new Set(['独特表达', '实用洞见', '情境幽默', '鲜明观点'])
const INTERACTION_CATEGORIES = new Set(['response', 'social', 'media', 'uncertain'])

// --- 当前输入与永久所有权 ---

// 只接受当前固定快照的完整片段及其真实本人，不从昵称或摘要反解析身份。
function permanentCore(snapshot: ReportEvidence, batch: EvidenceBatch): PermanentCore[] | null {
  if (!snapshot.hasStableMessageIds) return null
  const keys = new Set<string>(), records: PermanentCore[] = []
  if (!batch.core.size || batch.core.size !== batch.fragments.length) throw new Error('日报永久绑定核心范围无效')
  for (const [ref, fragment] of batch.core) {
    const current = snapshot.byFragmentId.get(fragment.id), source = snapshot.sources[fragment.sourceId - 1]
    if (!current || !batch.fragments.includes(current) || !isDeepStrictEqual(current, batch.fragments.find(item => item.id === fragment.id))
      || fragment.sourceId !== current.sourceId || fragment.permanentKey !== current.permanentKey || fragment.text !== current.text || fragment.part !== current.part
      || fragment.partCount !== current.partCount || !source || !source.messageId || source.realMessageId !== true
      || !current.permanentKey || batch.members.get(fragment.author)?.userId !== source.userId || !/^r[1-9]\d*$/.test(ref)) {
      throw new Error('日报永久来源或本人所有权不一致')
    }
    if (keys.has(current.permanentKey)) throw new Error('日报永久核心来源重复')
    keys.add(current.permanentKey)
    records.push({ key: current.permanentKey, messageId: source.messageId, sourceIdentity: source.identity,
      part: current.part, partCount: current.partCount, memberId: source.userId })
  }
  return records
}

// 读取器输出的归属必须完整、合法；标题仅保留前序范围提议，不添加模型未给出的事实。
function assertNormalizedClassification(records: readonly ClassificationRecord[], batch: EvidenceBatch, legacy = false): void {
  const covered = new Set<string>()
  let quotes = 0
  if (!Array.isArray(records) || records.length > batch.core.size * 4 + 3) throw new Error('日报分类产物数量无效')
  for (const record of records) {
    if (!record || typeof record !== 'object') throw new Error('日报分类产物记录无效')
    if (record.kind === 'quote') {
      assertReportFields(record, ['kind', 'ref', 'reason'], '已验证金句')
      if (typeof record.ref !== 'string' || typeof record.reason !== 'string' || !batch.core.has(record.ref)
        || !CLASSIFICATION_REASONS.has(record.reason) || ++quotes > 3) throw new Error('日报永久金句来源或理由无效')
      continue
    }
    assertReportFields(record, ['kind', 'category', 'title', 'summary', 'refs'], '已验证分类')
    if ((record.kind !== 'event' && record.kind !== 'interaction') || typeof record.title !== 'string' || Array.from(record.title).length > 32
      || (record.title !== '' && !record.title.trim()) || (legacy && record.title !== '') || record.summary !== ''
      || (record.kind === 'event' ? record.category !== '' : typeof record.category !== 'string' || !INTERACTION_CATEGORIES.has(record.category))
      || !Array.isArray(record.refs) || !record.refs.length || new Set(record.refs).size !== record.refs.length
      || record.refs.some((ref: string) => !batch.core.has(ref))) throw new Error('日报永久分类归属无效')
    record.refs.forEach((ref: string) => covered.add(ref))
  }
  if ([...batch.core.keys()].some(ref => !covered.has(ref))) throw new Error('日报永久分类产物未覆盖全部核心')
}

// --- 已验证分类的持久化形状与重绑 ---

// 所有短引用变为永久片段，结构化成员只保存永久本人；不保存本次全局编号。
export function bindReportClassification(snapshot: ReportEvidence, batch: EvidenceBatch, records: readonly ClassificationRecord[]): PermanentClassification | null {
  const core = permanentCore(snapshot, batch)
  if (!core) return null
  assertNormalizedClassification(records, batch)
  const bindings = new Map([...batch.core.keys()].map((ref, index) => [ref, core[index]]))
  return { version: 'permanent-classification-2', core, members: [...batch.members].map(([alias, member]) => ({ alias, memberId: member.userId })),
    records: records.map(record => record.kind === 'quote' ? { kind: 'quote', key: bindings.get(record.ref)!.key,
      memberId: bindings.get(record.ref)!.memberId, reason: record.reason } : { kind: record.kind, category: record.category,
      title: record.title, summary: '', keys: record.refs.map(ref => bindings.get(ref)!.key) }) }
}

// 当前核心、人物映射和永久所有权必须完全一致；仅昵称和全局序号变化可重绑。
export function restoreReportClassification(snapshot: ReportEvidence, batch: EvidenceBatch, value: PermanentClassification): ClassificationRecord[] {
  assertReportFields(value, ['version', 'core', 'members', 'records'], '永久分类')
  const core = permanentCore(snapshot, batch)
  if (!core || !value || !['permanent-classification-1', 'permanent-classification-2'].includes(value.version) || !isDeepStrictEqual(value.core, core)
    || !isDeepStrictEqual(value.members, [...batch.members].map(([alias, member]) => ({ alias, memberId: member.userId }))) || !Array.isArray(value.records)) {
    throw new Error('日报分类产物不能绑定到本次真实来源与成员')
  }
  const refs = new Map(core.map((item, index) => [item.key, [...batch.core.keys()][index]]))
  const owners = new Map(core.map(item => [item.key, item.memberId]))
  const records: ClassificationRecord[] = value.records.map(record => {
    if (!record || typeof record !== 'object') throw new Error('日报永久记录损坏')
    if (record.kind === 'quote') {
      assertReportFields(record, ['kind', 'key', 'memberId', 'reason'], '永久金句')
      const ref = refs.get(record.key)
      if (!ref || owners.get(record.key) !== record.memberId) throw new Error('日报金句永久来源被绑定到其他成员')
      return { kind: 'quote', ref, reason: record.reason }
    }
    assertReportFields(record, ['kind', 'category', 'title', 'summary', 'keys'], '永久分类组')
    if (!Array.isArray(record.keys) || record.keys.some(key => !refs.has(key))) throw new Error('日报永久分类含本次不存在的来源')
    return { kind: record.kind, category: record.category, title: record.title, summary: record.summary, refs: record.keys.map(key => refs.get(key)!) }
  })
  assertNormalizedClassification(records, batch, value.version === 'permanent-classification-1')
  return records
}

// --- 精确请求条件 ---

// 实际输入、角色、辅助状态、永久成员和冻结模型策略共同决定身份，任务编号与截止不参与。
export function createClassificationRequestIdentity(snapshot: ReportEvidence, batch: EvidenceBatch, options: ClassificationIdentityOptions): string | null {
  if (options.sourceCompleteness !== 'complete') return null
  const core = permanentCore(snapshot, batch)
  if (!core) return null
  if (!options.channelKey || !Number.isSafeInteger(options.periodStartMs) || !Number.isSafeInteger(options.periodEndMs)
    || options.periodStartMs >= options.periodEndMs || !options.modelPolicyIdentity || !options.batchRuleIdentity
    || !options.system || options.maxTokens !== 4096) throw new Error('日报分类请求身份条件无效')
  const auxiliary = [...batch.auxiliary].map(([ref, entry]) => {
    const source = snapshot.sources[entry.sourceId - 1]
    if (!source || !source.messageId || source.realMessageId !== true) throw new Error('日报辅助来源缺少可验证永久身份')
    return { ref, sourceIdentity: source.identity, memberId: source.userId, text: entry.text, truncated: entry.truncated }
  })
  const material = { version: 'classification-request-1', channelKey: options.channelKey,
    periodStartMs: options.periodStartMs, periodEndMs: options.periodEndMs,
    contract: 'raw-source-flat-7', inputVersion: JSON.parse(batch.input).version, batchRuleIdentity: options.batchRuleIdentity,
    core, auxiliary, members: [...batch.members].map(([alias, member]) => ({ alias, memberId: member.userId })),
    system: options.system, input: batch.input, modelPolicyIdentity: options.modelPolicyIdentity,
    parameters: { temperature: 0.2, thinking: false, maxTokens: options.maxTokens } }
  return createHash('sha256').update(JSON.stringify(material)).digest('hex')
}
