/**
 * MODULE: 日报固定来源与完整模型材料。
 * 职责: 绑定真实来源、Unicode分片、局部人物、回复与核心/辅助分区。
 * 边界: 不请求模型、不猜讨论归属、不读写缓存、不改变入选范围。
 * 状态: 每次调用独立快照；无全局Map或持久化状态。
 */
import { createHash } from 'crypto'
import type { InputMessage } from './complete-input'

export interface EvidenceMessage extends InputMessage { messageId?: string; realMessageId?: boolean; replyToId?: string }
export interface EvidenceSource {
  readonly sourceId: number; readonly messageId: string | null; readonly realMessageId: boolean | null
  readonly userId: string; readonly name: string; readonly content: string; readonly ts: number | null
  readonly time: string; readonly replyToId: string | null; readonly identity: string
}
export interface EvidenceFragment {
  readonly id: string; readonly sourceId: number; readonly part: number; readonly partCount: number
  readonly text: string; readonly permanentKey: string | null
}
export interface ReportEvidence {
  readonly version: 1
  readonly sources: readonly EvidenceSource[]; readonly fragments: readonly EvidenceFragment[]
  readonly byMessageId: ReadonlyMap<string, EvidenceSource>; readonly byFragmentId: ReadonlyMap<string, EvidenceFragment>
  readonly identity: string; readonly hasStableMessageIds: boolean
}
interface EvidenceMember { userId: string; name: string }
interface EvidenceReply { state: 'available' | 'unavailable' | 'cycle' | 'unknown'; message?: EvidenceSource }
interface AuxiliaryExcerpt { text: string; truncated: boolean }
interface AuxiliaryEntry extends AuxiliaryExcerpt { ref: string; source: EvidenceSource }
interface EvidenceBatchReuse { replies: Map<number, EvidenceReply[]>; excerpts: Map<string, AuxiliaryExcerpt> }
export interface EvidenceBatch {
  fragments: readonly EvidenceFragment[]
  core: Map<string, EvidenceFragment & { author: string }>
  members: Map<string, EvidenceMember>
  auxiliary: Map<string, { sourceId: number; text: string; truncated: boolean }>
  input: string
  coreCharacters: number
  auxiliaryCharacters: number
  candidateContexts?: ReadonlyArray<{ contextRefs: string[]; contextBudgetOmitted: number }>
}
export interface EvidenceCandidateContextOptions { candidateFragments: readonly (readonly EvidenceFragment[])[] }

const FRAGMENT_CHARACTERS = 2400
const BATCH_MESSAGES = 64
const BATCH_CHARACTERS = 16000
const CORE_CHARACTERS = 12000
const AUXILIARY_CHARACTERS = 2000

// --- 固定来源与片段 ---

// 对已经确定的材料计算摘要，摘要不由模型生成，也不包含凭据。
function evidenceDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

// 保持本次入选顺序与真实元数据；无真实标识的历史来源只具备本任务身份。
export function createReportEvidence(messages: readonly EvidenceMessage[]): ReportEvidence {
  const byMessageId = new Map<string, EvidenceSource>()
  const sources = messages.map((message, index): EvidenceSource => {
    const sourceId = index + 1
    if (message.analysisId !== undefined && message.analysisId !== sourceId) throw new Error('日报入选来源序号必须连续且唯一')
    if (typeof message.content !== 'string' || !['string', 'number'].includes(typeof message.userId) || String(message.userId).length === 0
      || (typeof message.userId === 'number' && !Number.isFinite(message.userId))) {
      throw new Error(`日报来源${sourceId}缺少正文或成员标识`)
    }
    for (const value of [message.messageId, message.replyToId]) if (value !== undefined && (typeof value !== 'string' || !value)) {
      throw new Error(`日报来源${sourceId}的消息或回复标识无效`)
    }
    if (message.realMessageId !== undefined && typeof message.realMessageId !== 'boolean') throw new Error('日报真实消息标识标记无效')
    if (message.ts !== undefined && !Number.isFinite(message.ts)) throw new Error('日报来源时间戳无效')
    const material = { messageId: message.messageId ?? null, realMessageId: message.realMessageId ?? null,
      userId: String(message.userId), content: message.content, ts: message.ts ?? null, time: message.time || '', replyToId: message.replyToId ?? null }
    const source = Object.freeze({ ...material, sourceId, name: message.user || '群友', identity: evidenceDigest(material) })
    if (source.messageId) {
      if (byMessageId.has(source.messageId)) throw new Error('日报固定快照含重复消息标识，无法确定回复所有权')
      byMessageId.set(source.messageId, source)
    }
    return source
  })
  const fragments: EvidenceFragment[] = []
  for (const source of sources) {
    const characters = Array.from(source.content), texts: string[] = []
    for (let offset = 0; offset < characters.length; offset += FRAGMENT_CHARACTERS) texts.push(characters.slice(offset, offset + FRAGMENT_CHARACTERS).join(''))
    if (!texts.length) texts.push('')
    texts.forEach((text, index) => fragments.push(Object.freeze({ id: `${source.sourceId}:${index + 1}`, sourceId: source.sourceId,
      part: index + 1, partCount: texts.length, text,
      permanentKey: source.realMessageId === true && source.messageId ? evidenceDigest({ version: 1, sourceIdentity: source.identity, part: index + 1, text }) : null })))
  }
  return Object.freeze({ version: 1, sources: Object.freeze(sources), fragments: Object.freeze(fragments), byMessageId,
    byFragmentId: new Map(fragments.map(fragment => [fragment.id, fragment])),
    identity: evidenceDigest({ version: 1, sources: sources.map(source => source.identity) }), hasStableMessageIds: sources.length > 0 && sources.every(source => source.realMessageId === true && !!source.messageId) })
}

// --- 核心与有界辅助上下文 ---

// 与字符串迭代器一样计代码点，避免为序列化结果创建临时字符数组。
export function countReportCodePoints(text: string): number {
  let count = text.length
  for (let index = 0; index + 1 < text.length; index++) {
    const high = text.charCodeAt(index)
    if (high < 0xd800 || high > 0xdbff) continue
    const low = text.charCodeAt(index + 1)
    if (low >= 0xdc00 && low <= 0xdfff) { count--; index++ }
  }
  return count
}

// 沿快照内已知回复最多读取三层；缺失与循环明确记录，不拉取外部历史。
function evidenceReplies(source: EvidenceSource, snapshot: ReportEvidence): EvidenceReply[] {
  if (!source.replyToId) return [{ state: 'unknown' }]
  const replies: EvidenceReply[] = [], seen = new Set([source.messageId])
  let parentId: string | null = source.replyToId
  for (let depth = 0; parentId && depth < 3; depth++) {
    if (seen.has(parentId)) { replies.push({ state: 'cycle' }); break }
    seen.add(parentId)
    const parent = snapshot.byMessageId.get(parentId)
    if (!parent) { replies.push({ state: 'unavailable' }); break }
    replies.push({ state: 'available', message: parent }); parentId = parent.replyToId
  }
  return replies
}

// 同一来源的开头和结尾按各自长度缓存，不跨入选快照共享摘录。
function getAuxiliaryExcerpt(source: EvidenceSource, maximum: number, fromEnd: boolean, cache?: Map<string, AuxiliaryExcerpt>): AuxiliaryExcerpt {
  const key = `${source.sourceId}:${fromEnd ? -maximum : maximum}`
  const reused = cache?.get(key)
  if (reused) return reused
  const characters = Array.from(source.content)
  const value = { text: (fromEnd ? characters.slice(-maximum) : characters.slice(0, maximum)).join(''), truncated: characters.length > maximum }
  cache?.set(key, value)
  return value
}

// 实际辅助材料与预算估算使用相同字段和顺序，分别提供对应的人物别名。
function auxiliaryItem({ ref, source, text, truncated }: AuxiliaryEntry, author: string | undefined) {
  return { role: 'auxiliary', ref, author, time: source.time, text, excerptOnly: true, truncated }
}

// 局部人物以永久身份稳定排序；核心全文与辅助摘录共同计入实际序列化长度。
export function buildReportEvidenceBatch(snapshot: ReportEvidence, fragments: readonly EvidenceFragment[], options?: EvidenceCandidateContextOptions): EvidenceBatch {
  return buildEvidenceBatch(snapshot, fragments, options)
}

// 试探批次可以复用快照材料，局部归属和预算仍按本批重新计算。
function buildEvidenceBatch(snapshot: ReportEvidence, fragments: readonly EvidenceFragment[], options?: EvidenceCandidateContextOptions, reuse?: EvidenceBatchReuse): EvidenceBatch {
  if (!fragments.length || fragments.some(fragment => snapshot.byFragmentId.get(fragment.id) !== fragment)) throw new Error('日报批次必须绑定当前快照的非空完整片段')
  if (new Set(fragments.map(fragment => fragment.id)).size !== fragments.length) throw new Error('日报批次不能重复核心片段')
  const partitions = options?.candidateFragments
  if (partitions) {
    const coreIds = new Set(fragments.map(fragment => fragment.id)), union = new Set<string>()
    if (!partitions.length || partitions.some(group => !group.length || new Set(group.map(fragment => fragment.id)).size !== group.length)) {
      throw new Error('候选上下文分区必须非空且自身片段唯一')
    }
    for (const group of partitions) for (const fragment of group) {
      if (snapshot.byFragmentId.get(fragment.id) !== fragment || !coreIds.has(fragment.id)) throw new Error('候选上下文分区必须绑定当前核心')
      union.add(fragment.id)
    }
    if (union.size !== coreIds.size) throw new Error('候选上下文分区没有覆盖本批核心')
  }
  const sourceIds = new Set(fragments.map(fragment => fragment.sourceId)), replies = new Map<number, EvidenceReply[]>()
  const maximumMemberAlias = 'p' + (partitions ? snapshot.sources.length : sourceIds.size * 4 + 4)
  const auxiliary = new Map<number, AuxiliaryEntry>()
  const associations = partitions?.map(() => new Set<number>()), omitted = partitions?.map(() => 0)
  let ordinaryAuxiliaryCharacters = 2 // 空数组的方括号。
  // 先父消息再首尾邻居，以最长人物别名预留包装；未供料父消息保留明确原因。
  const addAuxiliary = (source: EvidenceSource, maximum: number, fromEnd = false, candidateIndex?: number): void => {
    const existing = auxiliary.get(source.sourceId)
    if (existing && (candidateIndex === undefined || associations![candidateIndex].has(source.sourceId))) return
    const entry = existing ?? { ref: 'm' + (auxiliary.size + 1), source, ...getAuxiliaryExcerpt(source, maximum, fromEnd, reuse?.excerpts) }
    if (!associations) {
      // 普通分批只增加一个 JSON 对象及一个可选逗号，拒绝项不改变累计长度。
      const length = ordinaryAuxiliaryCharacters + Number(auxiliary.size > 0)
        + countReportCodePoints(JSON.stringify(auxiliaryItem(entry, maximumMemberAlias)))
      if (length <= AUXILIARY_CHARACTERS) {
        auxiliary.set(source.sourceId, entry)
        ordinaryAuxiliaryCharacters = length
      }
      return
    }
    const proposed = new Map(auxiliary).set(source.sourceId, entry)
    const serialized = [...proposed.values()].map(value => auxiliaryItem(value, maximumMemberAlias))
    // 候选关联也计入2000字符；省略数量按全快照位数预留，写回真实数量不会撑破预算。
    const packaging = { context: serialized, candidateContexts: associations.map((refs, index) => ({
      contextRefs: [...refs, ...(index === candidateIndex ? [source.sourceId] : [])].map(id => proposed.get(id)!.ref),
      contextBudgetOmitted: snapshot.sources.length })) }
    if (countReportCodePoints(JSON.stringify(packaging)) <= AUXILIARY_CHARACTERS) {
      auxiliary.set(source.sourceId, entry)
      if (candidateIndex !== undefined) associations[candidateIndex].add(source.sourceId)
    } else if (candidateIndex !== undefined) omitted![candidateIndex]++
  }
  for (const sourceId of sourceIds) {
    let chain = reuse?.replies.get(sourceId)
    if (!chain) {
      chain = evidenceReplies(snapshot.sources[sourceId - 1], snapshot)
      reuse?.replies.set(sourceId, chain)
    }
    replies.set(sourceId, chain)
    if (!partitions) for (const reply of chain) if (reply.message) addAuxiliary(reply.message, 400)
  }
  if (partitions) {
    const queues = partitions.map(group => {
      const own = [...new Set(group.map(fragment => fragment.sourceId))].sort((a, b) => a - b)
      const parents = new Map<number, EvidenceSource>(), neighbors = new Map<number, { source: EvidenceSource; fromEnd: boolean }>()
      for (const id of own) for (const reply of replies.get(id)!) if (reply.message) parents.set(reply.message.sourceId, reply.message)
      for (const id of own) for (const offset of [-2, -1, 1, 2]) {
        const source = snapshot.sources[id + offset - 1]
        if (source && !own.includes(source.sourceId) && !parents.has(source.sourceId) && !neighbors.has(source.sourceId)) {
          neighbors.set(source.sourceId, { source, fromEnd: offset < 0 })
        }
      }
      return { parents: [...parents.values()], neighbors: [...neighbors.values()] }
    })
    // 父消息全部先行；每轮每候选至多一个条目，避免最早候选占满共享辅助预算。
    const parentRounds = Math.max(...queues.map(queue => queue.parents.length))
    for (let round = 0; round < parentRounds; round++) queues.forEach((queue, index) => {
      if (queue.parents[round]) addAuxiliary(queue.parents[round], 400, false, index)
    })
    const neighborRounds = Math.max(...queues.map(queue => queue.neighbors.length))
    for (let round = 0; round < neighborRounds; round++) queues.forEach((queue, index) => {
      const neighbor = queue.neighbors[round]
      if (neighbor) addAuxiliary(neighbor.source, 200, neighbor.fromEnd, index)
    })
  } else {
    const first = Math.min(...sourceIds), last = Math.max(...sourceIds)
    for (const sourceId of [first - 2, first - 1, last + 1, last + 2]) {
      const neighbor = snapshot.sources[sourceId - 1]
      if (neighbor && !sourceIds.has(sourceId)) addAuxiliary(neighbor, 200, sourceId < first)
    }
  }
  const people = new Map([...sourceIds].map(sourceId => [snapshot.sources[sourceId - 1].userId, snapshot.sources[sourceId - 1]]))
  auxiliary.forEach(({ source }) => people.set(source.userId, source))
  const members = new Map([...people].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([userId, source], index) => ['p' + (index + 1), { userId, name: source.name }] as const))
  const aliases = new Map([...members].map(([ref, member]) => [member.userId, ref]))
  const core = new Map(fragments.map((fragment, index) => ['r' + (index + 1), { ...fragment, author: aliases.get(snapshot.sources[fragment.sourceId - 1].userId)! }]))
  const items = [...core].map(([ref, fragment]) => ({ ref, role: 'core', author: fragment.author,
    time: snapshot.sources[fragment.sourceId - 1].time, text: fragment.text,
    replies: replies.get(fragment.sourceId)!.map(reply => {
      if (!reply.message) return { state: reply.state }
      const provided = auxiliary.get(reply.message.sourceId)
      return provided ? { state: 'available', ref: provided.ref } : { state: 'budget_not_provided' }
    }) }))
  const context = [...auxiliary.values()].map(entry => auxiliaryItem(entry, aliases.get(entry.source.userId)))
  const candidateContexts = associations?.map((refs, index) => ({ contextRefs: [...refs].map(id => auxiliary.get(id)!.ref), contextBudgetOmitted: omitted![index] }))
  const input = JSON.stringify({ version: 'evidence-batch-4', members: [...members.keys()].map(ref => ({ ref })), items, context })
  return { fragments, core, members, input, auxiliary: new Map([...auxiliary.values()].map(entry => [entry.ref,
    { sourceId: entry.source.sourceId, text: entry.text, truncated: entry.truncated }])),
    coreCharacters: countReportCodePoints(JSON.stringify(items.map(({ replies: _replies, ...item }) => item))),
    auxiliaryCharacters: countReportCodePoints(JSON.stringify(candidateContexts ? { context, candidateContexts } : context)),
    ...(candidateContexts ? { candidateContexts } : {}) }
}

// --- 处理分区与长度分批 ---

// 只识别完整正文精确为[图片]的既有占位；其他文本与所有混合媒体均交模型。
export function partitionReportEvidence(snapshot: ReportEvidence): { deterministic: EvidenceFragment[]; model: EvidenceFragment[] } {
  const deterministic: EvidenceFragment[] = [], model: EvidenceFragment[] = []
  for (const fragment of snapshot.fragments) (snapshot.sources[fragment.sourceId - 1].content === '[图片]' ? deterministic : model).push(fragment)
  return { deterministic, model }
}

// 片段数、稳定核心及完整封装同时受限，系统提示预算由请求入口再核验。
function evidenceBatchFits(batch: EvidenceBatch, overheadCharacters: number): boolean {
  return batch.fragments.length <= BATCH_MESSAGES && batch.coreCharacters <= CORE_CHARACTERS
    && batch.auxiliaryCharacters <= AUXILIARY_CHARACTERS && countReportCodePoints(batch.input) + overheadCharacters <= BATCH_CHARACTERS
}

// 使用方案固定的64片段/12k核心/16k实际材料上限，不裁正文来容纳辅助。
export function packReportEvidenceBatches(snapshot: ReportEvidence, overheadCharacters = 0): EvidenceBatch[] {
  if (!Number.isSafeInteger(overheadCharacters) || overheadCharacters < 0 || overheadCharacters >= BATCH_CHARACTERS) throw new Error('日报系统及恢复预留预算无效')
  const batches: EvidenceBatch[] = [], fragments = partitionReportEvidence(snapshot).model
  const reuse: EvidenceBatchReuse = { replies: new Map(), excerpts: new Map() }
  let pending: EvidenceBatch | undefined
  for (const fragment of fragments) {
    const next = buildEvidenceBatch(snapshot, [...(pending?.fragments ?? []), fragment], undefined, reuse)
    if (evidenceBatchFits(next, overheadCharacters)) { pending = next; continue }
    if (pending) {
      batches.push(pending)
      pending = buildEvidenceBatch(snapshot, [fragment], undefined, reuse)
      if (evidenceBatchFits(pending, overheadCharacters)) continue
    }
    throw new Error('日报完整片段及上下文超过模型材料预算')
  }
  if (pending) batches.push(pending)
  return batches
}
