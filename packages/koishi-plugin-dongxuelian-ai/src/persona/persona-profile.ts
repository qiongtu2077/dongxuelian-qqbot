/**
 * MODULE: Evidence-based persona profile blocks.
 * Responsibility: Normalize existing memory/profile sources into auditable read-only blocks.
 * Boundary: Does not extract new facts, does not write profile files, does not inject prompts.
 * State: None.
 */
const crypto = require('crypto')
const fsp = require('fs/promises')
const path = require('path')
const { DATA_DIR, USER_PROFILE_DIR } = require('../core/constants') as typeof import('../core/constants')

const PERSONA_PROFILE_VERSION = 1
const MAX_PROFILE_SOURCE_FILE_BYTES = 512 * 1024
const PROFILE_BLOCK_TYPES = Object.freeze(['core', 'human', 'channel', 'working', 'archival'])
const PROFILE_STATUSES = Object.freeze(['candidate', 'active', 'disputed', 'archived'])
const PROFILE_SENSITIVITY = Object.freeze(['public', 'private', 'sensitive'])
const PROFILE_CATEGORIES = Object.freeze(['preference', 'habit', 'identity', 'boundary', 'relationship', 'workflow', 'memory', 'style'])
const PROFILE_REINFORCE_DEFAULT_INCREMENT = 0.05
const PROFILE_REINFORCE_MAX_EVIDENCE = 5
const PROFILE_EFFECTIVE_DECAY_PER_DAY = 0.95
const PROFILE_EFFECTIVE_MIN_CONFIDENCE = 0.1
const PROFILE_EFFECTIVE_ADMIN_MIN_CONFIDENCE = 0.5
const PROFILE_EFFECTIVE_DEFAULT_LIMIT = 5
const PROFILE_SHADOW_PREVIEW_VERSION = 2
const PROFILE_SHADOW_LOG_DIR = path.join(DATA_DIR, 'persona-diagnostics')
const PROFILE_SHADOW_LOG_MAX_BYTES = 2 * 1024 * 1024
const PROFILE_SHADOW_TRAITS = Object.freeze([
  'short_bursty',
  'long_explainer',
  'direct_correction',
  'questioning',
  'technical_debug',
  'media_followup',
  'meme_casual',
  'coordination',
  'command_like',
])

type ProfileRecord = Record<string, unknown>
type ProfileCounts = Record<string, number>

interface PersonaProfileEvidence {
  source?: string
  ts?: number
  quoteHash?: string
  shortQuote?: string
  messageIdHash?: string
  channelHash?: string
  text?: string
  messageId?: string
  channelKey?: string
  createdAt?: number
  updatedAt?: number
}

interface PersonaProfileBlock extends ProfileRecord {
  id?: string
  block?: string
  category?: string
  text?: string
  sensitivity?: string
  confidence?: number
  evidence?: PersonaProfileEvidence[]
  source?: string
  status?: string
  createdAt?: number
  updatedAt?: number
  lastAccessedAt?: number
  reinforceCount?: number
  expiresAt?: number
  effectiveConfidence?: number
}

interface PersonaProfile {
  version?: number
  user?: { id?: string; idHash?: string; names?: string[] }
  channel?: { hash?: string }
  blocks?: PersonaProfileBlock[]
  diagnostics?: Array<ProfileRecord>
  sourceStats?: ProfileRecord
  summary?: ProfileRecord
}

interface PersonaProfileOptions extends ProfileRecord {
  now?: number
  userId?: string
  channelKey?: string
  rootDir?: string
  includeRecentMessages?: boolean
  includeAgentMemory?: boolean
  maxRecentMessages?: number
  agentMemoryLimit?: number
  agentMemoryReader?: (options: { userId: string; limit: number }) => Promise<Array<ProfileRecord>>
  selection?: ProfileRecord
  selectedRanks?: Map<string, number>
  minEffectiveConfidence?: number
  allowedStatuses?: string[]
  includeSensitive?: boolean
  decayPerDay?: number
  adminSources?: string[]
  adminMinConfidence?: number
  increment?: number
  maxEvidence?: number
  file?: string
}

interface ShadowAnalysis extends ProfileRecord {
  length: number
  textHash: string
  isMedia: boolean
  isMention: boolean
  isCommandLike: boolean
  isSensitive: boolean
  hasTechnical: boolean
  hasCorrection: boolean
  hasQuestion: boolean
  hasMeme: boolean
  hasCoordination: boolean
}

interface ShadowTraitsSummary {
  total: number
  avgLength: number
  counts: ProfileCounts
  traits: string[]
  blockers: string[]
  warnings: string[]
}

let personaProfileShadowLogChain: Promise<unknown> = Promise.resolve()

function hashPersonaProfileValue(value: unknown = '', length: number = 12): string {
  const text = String(value || '').trim()
  if (!text) return ''
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, Math.max(6, Math.min(32, Number(length) || 12)))
}

function sanitizePersonaProfileKey(value: unknown = ''): string {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'unknown'
}

function normalizePersonaProfileText(value: unknown = '', maxLength: number = 500): string {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.max(20, Math.min(2000, Number(maxLength) || 500)))
}

function normalizePersonaProfileEnum(value: unknown, allowed: readonly string[], fallback: string): string {
  const text = String(value || '').trim()
  return allowed.includes(text) ? text : fallback
}

function normalizePersonaProfileNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function normalizePersonaProfileTs(value: unknown, fallback: number = Date.now()): number {
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  return fallback
}

function normalizePersonaProfileHash(value: unknown = '', maxLength: number = 64): string {
  const text = String(value || '').trim().toLowerCase()
  if (!/^[a-f0-9]{6,64}$/.test(text)) return ''
  return text.slice(0, Math.max(6, Math.min(64, Number(maxLength) || 64)))
}

function personaProfileComparableText(value: unknown = ''): string {
  return normalizePersonaProfileText(value, 700).toLowerCase()
}

function formatPersonaProfileLogAtom(value: unknown = '', fallback: string = 'none'): string {
  const text = String(value || '').trim()
  if (!text) return fallback
  return text
    .replace(/[\r\n\t ]+/g, '_')
    .replace(/[|=,]+/g, '_')
    .replace(/[^\w.\-:+/;\u4e00-\u9fff]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 240) || fallback
}

function formatPersonaProfileLogList(values: unknown[] = [], fallback: string = 'none'): string {
  const list = Array.isArray(values)
    ? values.map(item => formatPersonaProfileLogAtom(item, '')).filter(Boolean)
    : []
  return list.length ? list.join(',') : fallback
}

function estimatePersonaProfilePromptTokens(text: unknown = ''): number {
  const value = String(text || '')
  let ascii = 0
  let nonAscii = 0
  for (const char of value) {
    if (char.charCodeAt(0) <= 0x7f) ascii += 1
    else nonAscii += 1
  }
  return Math.max(1, Math.ceil(ascii / 4 + nonAscii / 1.7))
}

function formatPersonaProfileShadowDate(ts: unknown = Date.now()): string {
  const date = new Date(normalizePersonaProfileTs(ts, Date.now()))
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10)
  return date.toISOString().slice(0, 10)
}

function getPersonaProfileShadowLogFile(ts: unknown = Date.now(), rootDir: string = PROFILE_SHADOW_LOG_DIR): string {
  const dir = rootDir || PROFILE_SHADOW_LOG_DIR
  return path.join(dir, `profile-shadow-${formatPersonaProfileShadowDate(ts)}.jsonl`)
}

function getPersonaProfileShadowLengthBucket(length: unknown = 0): string {
  const value = Math.max(0, Math.floor(Number(length) || 0))
  if (value <= 12) return 'short'
  if (value <= 80) return 'medium'
  return 'long'
}

function getPersonaProfileShadowTraitsForAnalysis(analysis: Partial<ShadowAnalysis> = {}): string[] {
  const traits: string[] = []
  const length = Math.max(0, Number(analysis.length) || 0)
  if (length > 0 && length <= 12) traits.push('short_bursty')
  if (length >= 80) traits.push('long_explainer')
  if (analysis.hasCorrection) traits.push('direct_correction')
  if (analysis.hasQuestion) traits.push('questioning')
  if (analysis.hasTechnical) traits.push('technical_debug')
  if (analysis.isMedia) traits.push('media_followup')
  if (analysis.hasMeme) traits.push('meme_casual')
  if (analysis.hasCoordination) traits.push('coordination')
  if (analysis.isCommandLike) traits.push('command_like')
  return traits
}

function analyzePersonaProfileShadowText(text: unknown = ''): ShadowAnalysis {
  const value = normalizePersonaProfileText(text, 700)
  const length = Array.from(value).length
  const lowered = value.toLowerCase()
  const isMedia = /(?:<img\b|<video\b|<audio\b|\[图片\]|\[语音\]|\[文件\]|file=|summary=|download\?appid=)/i.test(value)
  const isMention = /(?:<at\b|@全体|@everyone|@)/i.test(value)
  const isCommandLike = /^(?:\/|!|！|#)|(?:东雪莲|莲莲|bot|Bot|BOT).{0,12}(?:说句话|人格|语音|搜索|fetch|查|读|总结)|(?:^|\s)(?:test|debug)\s*$/i.test(value)
  const isSensitive = /(?:api[_-]?key|token|cookie|password|passwd|secret|authorization|bearer\s+|sk-[a-z0-9])/i.test(value)
  const hasTechnical = /(?:ai|bot|token|prompt|fetch|bug|api|http|ssh|json|node|npm|model|mldsa|shor|量子|算法|证明|计算|模型|部署|服务器|截图|转文字|识别|搜索|工具|代码|安全|加密|测试|修复)/i.test(value)
  const hasCorrection = /(?:认错|不对|不是|错|别|不能|没用|看不懂|求求|改|坏了|bug|失败|不行|不准|别想)/.test(value)
  const hasQuestion = /(?:[?？]|什么|怎么|如何|为啥|为什么|能不能|是不是|吗|呢)/.test(value)
  const hasMeme = /(?:笑|绷|乐|草|哈|蚌|典|哈基米|迪莫|神卡|抽卡|主播|高管|hhh|233)/i.test(value)
  const hasCoordination = /(?:上号|欢迎|集合|几点|九点|安排|来了|收到)/.test(value)
  return {
    length,
    textHash: hashPersonaProfileValue(value, 10),
    isMedia,
    isMention,
    isCommandLike,
    isSensitive,
    hasTechnical,
    hasCorrection,
    hasQuestion,
    hasMeme,
    hasCoordination,
  }
}

function summarizePersonaProfileShadowTraits(analyses: Array<Partial<ShadowAnalysis>> = []): ShadowTraitsSummary {
  const total = Array.isArray(analyses) ? analyses.length : 0
  const counts: ProfileCounts = {
    short: 0,
    long: 0,
    media: 0,
    mention: 0,
    command: 0,
    sensitive: 0,
    technical: 0,
    correction: 0,
    question: 0,
    meme: 0,
    coordination: 0,
  }
  let lengthTotal = 0
  for (const item of analyses) {
    if (!item || typeof item !== 'object') continue
    lengthTotal += Math.max(0, Number(item.length) || 0)
    if ((Number(item.length) || 0) <= 12) counts.short += 1
    if ((Number(item.length) || 0) >= 80) counts.long += 1
    if (item.isMedia) counts.media += 1
    if (item.isMention) counts.mention += 1
    if (item.isCommandLike) counts.command += 1
    if (item.isSensitive) counts.sensitive += 1
    if (item.hasTechnical) counts.technical += 1
    if (item.hasCorrection) counts.correction += 1
    if (item.hasQuestion) counts.question += 1
    if (item.hasMeme) counts.meme += 1
    if (item.hasCoordination) counts.coordination += 1
  }
  const ratio = (key: string) => total ? counts[key] / total : 0
  const traits: string[] = []
  if (total && ratio('short') >= 0.6) traits.push('short_bursty')
  if (total && ratio('long') >= 0.3) traits.push('long_explainer')
  if (total && ratio('correction') >= 0.25) traits.push('direct_correction')
  if (total && ratio('question') >= 0.25) traits.push('questioning')
  if (total && ratio('technical') >= 0.25) traits.push('technical_debug')
  if (total && ratio('media') >= 0.25) traits.push('media_followup')
  if (total && ratio('meme') >= 0.25) traits.push('meme_casual')
  if (total && ratio('coordination') >= 0.25) traits.push('coordination')
  if (total && ratio('command') >= 0.25) traits.push('command_like')
  const blockers: string[] = []
  if (total < 2) blockers.push('too_few_candidates')
  if (counts.sensitive > 0) blockers.push('sensitive_like_text')
  if (ratio('command') >= 0.4) blockers.push('command_like_noise')
  if (ratio('media') >= 0.6) blockers.push('media_markup_dominant')
  if (ratio('mention') >= 0.5) blockers.push('mention_or_broadcast_dominant')
  if (!traits.length) blockers.push('no_stable_trait')
  const warnings: string[] = []
  if (ratio('meme') >= 0.25) warnings.push('meme_may_ooc')
  if (ratio('correction') >= 0.25) warnings.push('do_not_copy_harshness')
  if (ratio('media') > 0) warnings.push('ignore_media_placeholders')
  if (ratio('command') > 0) warnings.push('ignore_commands_as_style')
  return {
    total,
    avgLength: total ? Math.round(lengthTotal / total) : 0,
    counts,
    traits,
    blockers,
    warnings,
  }
}

function buildPersonaProfileShadowPromptPreview(traits: string[] = [], warnings: string[] = []): string {
  const parts: string[] = []
  const has = (key: string) => traits.includes(key)
  if (has('short_bursty')) parts.push('短句直给')
  if (has('long_explainer')) parts.push('可承接较长解释')
  if (has('direct_correction')) parts.push('对纠错先认问题再回答')
  if (has('questioning')) parts.push('优先回答追问')
  if (has('technical_debug')) parts.push('技术/测试语境少寒暄')
  if (has('media_followup')) parts.push('图片文件追问先说明能否读到')
  if (has('meme_casual')) parts.push('可轻接梗但不复读口癖')
  if (has('coordination')) parts.push('群活动消息简短确认')
  if (has('command_like')) parts.push('命令内容只作意图不学语气')
  if (!parts.length) parts.push('暂无稳定风格')
  if (warnings.includes('do_not_copy_harshness')) parts.push('不模仿攻击性')
  parts.push('短期风格参考非长期记忆')
  parts.push('禁止引用原话')
  return parts.join(';')
}

function isPersonaProfileShadowStyleBlock(block: PersonaProfileBlock = {}): boolean {
  return String(block.source || '') === 'recent_user_message'
    || String(block.block || '') === 'working'
    || String(block.category || '') === 'style'
}

function getPersonaProfileShadowSelectionBlockers(block: PersonaProfileBlock = {}, options: PersonaProfileOptions = {}): { blockers: string[]; effectiveConfidence: number } {
  const now = normalizePersonaProfileTs(options.now, Date.now())
  const allowedStatuses = Array.isArray(options.allowedStatuses) && options.allowedStatuses.length
    ? new Set(options.allowedStatuses.map(String))
    : new Set(['active', 'candidate'])
  const minEffectiveConfidence = normalizePersonaProfileNumber(options.minEffectiveConfidence, PROFILE_EFFECTIVE_MIN_CONFIDENCE, 0, 1)
  const includeSensitive = !!options.includeSensitive
  const blockers: string[] = []
  if (!allowedStatuses.has(String(block.status || 'candidate'))) blockers.push('status')
  const expiresAt = Number(block.expiresAt || 0)
  if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now) blockers.push('expired')
  if (!includeSensitive && String(block.sensitivity || '') === 'sensitive') blockers.push('sensitive')
  const effectiveConfidence = computePersonaProfileEffectiveConfidence(block, { ...options, now })
  if (effectiveConfidence < minEffectiveConfidence) blockers.push('lowConfidence')
  return { blockers, effectiveConfidence }
}

function buildPersonaProfileShadowEvidenceMeta(evidence: PersonaProfileEvidence[] = [], now: number = Date.now()) {
  return (Array.isArray(evidence) ? evidence : []).slice(0, 3).map(item => ({
    source: formatPersonaProfileLogAtom(item && item.source || 'unknown'),
    quoteHash: normalizePersonaProfileHash(item && item.quoteHash || '', 12),
    messageIdHash: normalizePersonaProfileHash(item && item.messageIdHash || '', 10),
    channelHash: normalizePersonaProfileHash(item && item.channelHash || '', 10),
    ageHours: Math.max(0, Math.round((now - normalizePersonaProfileTs(item && item.ts, now)) / (60 * 60 * 1000))),
  }))
}

function buildPersonaProfileShadowCandidate(block: PersonaProfileBlock = {}, options: PersonaProfileOptions = {}) {
  const now = normalizePersonaProfileTs(options.now, Date.now())
  const normalized = buildPersonaProfileBlock({ ...block, now })
  if (!normalized) return null
  const analysis = analyzePersonaProfileShadowText(normalized.text || '')
  const selectedRanks = options.selectedRanks instanceof Map ? options.selectedRanks : new Map()
  const selectedRank = selectedRanks.get(String(normalized.id || '')) || 0
  const selectionState = getPersonaProfileShadowSelectionBlockers(normalized, options)
  const textTraits = getPersonaProfileShadowTraitsForAnalysis(analysis)
  const learningBlockers: string[] = []
  if (!selectedRank) learningBlockers.push('not_selected_topn')
  if (!isPersonaProfileShadowStyleBlock(normalized)) learningBlockers.push('not_style_source')
  for (const blocker of selectionState.blockers) learningBlockers.push(`selection_${blocker}`)
  if (analysis.isSensitive) learningBlockers.push('sensitive_like_text')
  if (analysis.isCommandLike) learningBlockers.push('command_like_noise')
  if (analysis.isMedia) learningBlockers.push('media_markup')
  if (analysis.isMention) learningBlockers.push('mention_or_broadcast')
  const createdAt = normalizePersonaProfileTs(normalized.createdAt, now)
  const updatedAt = normalizePersonaProfileTs(normalized.updatedAt, createdAt)
  const expiresAt = Number(normalized.expiresAt || 0)
  return {
    blockHash: hashPersonaProfileValue(normalized.id || '', 10),
    textHash: analysis.textHash,
    source: formatPersonaProfileLogAtom(normalized.source || 'unknown'),
    status: normalized.status,
    block: normalized.block,
    category: normalized.category,
    sensitivity: normalized.sensitivity,
    ageHours: Math.max(0, Math.round((now - createdAt) / (60 * 60 * 1000))),
    updatedAgeHours: Math.max(0, Math.round((now - updatedAt) / (60 * 60 * 1000))),
    expiresInHours: Number.isFinite(expiresAt) && expiresAt > 0 ? Math.round((expiresAt - now) / (60 * 60 * 1000)) : null,
    confidence: Number(normalized.confidence || 0),
    effectiveConfidence: selectionState.effectiveConfidence,
    reinforceCount: Math.max(0, Math.floor(Number(normalized.reinforceCount) || 0)),
    evidence: buildPersonaProfileShadowEvidenceMeta(normalized.evidence, now),
    text: {
      hash: analysis.textHash,
      length: Math.max(0, Math.floor(Number(analysis.length) || 0)),
      bucket: getPersonaProfileShadowLengthBucket(analysis.length),
      traits: textTraits,
      flags: {
        media: !!analysis.isMedia,
        mention: !!analysis.isMention,
        commandLike: !!analysis.isCommandLike,
        sensitiveLike: !!analysis.isSensitive,
        technical: !!analysis.hasTechnical,
        correction: !!analysis.hasCorrection,
        question: !!analysis.hasQuestion,
        meme: !!analysis.hasMeme,
        coordination: !!analysis.hasCoordination,
      },
    },
    selection: {
      selectedTopN: selectedRank > 0,
      rank: selectedRank || null,
      blockers: selectionState.blockers,
    },
    learning: {
      decision: learningBlockers.length ? 'skip_learning' : 'would_learn_style',
      blockers: Array.from(new Set(learningBlockers)),
    },
  }
}

function isBuiltPersonaProfileShadowCandidate(
  candidate: ReturnType<typeof buildPersonaProfileShadowCandidate>
): candidate is NonNullable<ReturnType<typeof buildPersonaProfileShadowCandidate>> {
  return candidate !== null
}

function buildPersonaProfileEvidence(input: PersonaProfileEvidence & ProfileRecord = {}): PersonaProfileEvidence {
  const now = normalizePersonaProfileTs(input.now, Date.now())
  const shortQuote = normalizePersonaProfileText(input.text || input.shortQuote || '', 120)
  const ts = normalizePersonaProfileTs(input.ts || input.createdAt || input.updatedAt, now)
  const quoteHash = normalizePersonaProfileHash(input.quoteHash) || hashPersonaProfileValue(shortQuote || input.text || '')
  return {
    source: normalizePersonaProfileText(input.source || 'unknown', 40) || 'unknown',
    ts,
    quoteHash,
    shortQuote,
    messageIdHash: normalizePersonaProfileHash(input.messageIdHash, 10) || hashPersonaProfileValue(input.messageId || '', 10),
    channelHash: normalizePersonaProfileHash(input.channelHash, 10) || hashPersonaProfileValue(input.channelKey || '', 10),
  }
}

function buildPersonaProfileBlock(input: PersonaProfileBlock & { maxTextLength?: number; now?: number } = {}): PersonaProfileBlock | null {
  const now = normalizePersonaProfileTs(input.now, Date.now())
  const text = normalizePersonaProfileText(input.text || '', input.maxTextLength || 500)
  if (!text) return null
  const evidence = Array.isArray(input.evidence)
    ? input.evidence.map(item => buildPersonaProfileEvidence({ ...item, now })).filter(item => item.quoteHash || item.shortQuote)
    : []
  const createdAt = normalizePersonaProfileTs(input.createdAt, evidence[0]?.ts || now)
  const updatedAt = normalizePersonaProfileTs(input.updatedAt, createdAt)
  const block = normalizePersonaProfileEnum(input.block, PROFILE_BLOCK_TYPES, 'human')
  const source = normalizePersonaProfileText(input.source || evidence[0]?.source || 'unknown', 60) || 'unknown'
  const category = normalizePersonaProfileEnum(input.category, PROFILE_CATEGORIES, 'memory')
  const status = normalizePersonaProfileEnum(input.status, PROFILE_STATUSES, 'candidate')
  const sensitivity = normalizePersonaProfileEnum(input.sensitivity, PROFILE_SENSITIVITY, 'private')
  const idSeed = [
    block,
    source,
    category,
    status,
    text,
    evidence.map(item => item.quoteHash).join(','),
  ].join('|')
  const result: PersonaProfileBlock = {
    id: input.id || `pf_${hashPersonaProfileValue(idSeed, 16)}`,
    block,
    category,
    text,
    sensitivity,
    confidence: Number(normalizePersonaProfileNumber(input.confidence, status === 'active' ? 0.7 : 0.2, 0, 1).toFixed(3)),
    evidence,
    source,
    status,
    createdAt,
    updatedAt,
    lastAccessedAt: normalizePersonaProfileTs(input.lastAccessedAt, updatedAt),
    reinforceCount: Math.max(0, Math.floor(normalizePersonaProfileNumber(input.reinforceCount, evidence.length, 0, 1000000))),
  }
  const expiresAt = Number(input.expiresAt || 0)
  if (Number.isFinite(expiresAt) && expiresAt > 0) result.expiresAt = expiresAt
  return result
}

function personaProfileEvidenceList(input: PersonaProfileEvidence[] = [], now: number = Date.now()): PersonaProfileEvidence[] {
  return Array.isArray(input)
    ? input.map(item => buildPersonaProfileEvidence({ ...item, now })).filter(item => item.quoteHash || item.shortQuote)
    : []
}

function personaProfileQuoteHashSet(block: PersonaProfileBlock = {}): Set<string> {
  const out = new Set<string>()
  for (const evidence of Array.isArray(block.evidence) ? block.evidence : []) {
    const hash = String(evidence && evidence.quoteHash || '').trim()
    if (hash) out.add(hash)
  }
  return out
}

function findPersonaProfileReinforceReason(existing: PersonaProfileBlock = {}, incoming: PersonaProfileBlock = {}): string {
  const existingHashes = personaProfileQuoteHashSet(existing)
  const incomingHashes = personaProfileQuoteHashSet(incoming)
  for (const hash of incomingHashes) {
    if (existingHashes.has(hash)) return 'quote_hash'
  }
  const sameType = String(existing.block || '') === String(incoming.block || '')
    && String(existing.category || '') === String(incoming.category || '')
  if (sameType && personaProfileComparableText(existing.text) && personaProfileComparableText(existing.text) === personaProfileComparableText(incoming.text)) {
    return 'normalized_text'
  }
  return ''
}

function mergePersonaProfileEvidence(existingEvidence: PersonaProfileEvidence[] = [], incomingEvidence: PersonaProfileEvidence[] = [], maxEvidence: number = PROFILE_REINFORCE_MAX_EVIDENCE): PersonaProfileEvidence[] {
  const limit = Math.max(1, Math.min(20, Math.floor(Number(maxEvidence) || PROFILE_REINFORCE_MAX_EVIDENCE)))
  const merged: PersonaProfileEvidence[] = []
  const seen = new Set()
  for (const item of [...existingEvidence, ...incomingEvidence]) {
    if (!item || typeof item !== 'object') continue
    const key = String(item.quoteHash || item.messageIdHash || item.shortQuote || '')
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    merged.push(item)
  }
  return merged.slice(-limit)
}

function reinforcePersonaProfileBlock(existing: PersonaProfileBlock = {}, incoming: PersonaProfileBlock = {}, options: PersonaProfileOptions = {}) {
  const now = normalizePersonaProfileTs(options.now, Date.now())
  const existingBlock = buildPersonaProfileBlock({ ...existing, now }) || null
  const incomingBlock = buildPersonaProfileBlock({ ...incoming, now }) || null
  if (!existingBlock || !incomingBlock) {
    return { matched: false, reason: 'invalid_block', block: existingBlock || null }
  }
  if (existingBlock.status === 'disputed' || existingBlock.status === 'archived' || incomingBlock.status === 'disputed' || incomingBlock.status === 'archived') {
    return { matched: false, reason: 'status_blocked', block: existingBlock }
  }
  const reason = findPersonaProfileReinforceReason(existingBlock, incomingBlock)
  if (!reason) return { matched: false, reason: 'no_match', block: existingBlock }
  const increment = normalizePersonaProfileNumber(options.increment, PROFILE_REINFORCE_DEFAULT_INCREMENT, 0, 1)
  const nextConfidence = normalizePersonaProfileNumber(existingBlock.confidence, 0, 0, 1) + increment
  const next = {
    ...existingBlock,
    confidence: Number(Math.max(0, Math.min(1, nextConfidence)).toFixed(3)),
    reinforceCount: Math.max(0, Math.floor(Number(existingBlock.reinforceCount) || 0)) + 1,
    lastAccessedAt: now,
    updatedAt: Math.max(Number(existingBlock.updatedAt) || 0, now),
    evidence: mergePersonaProfileEvidence(existingBlock.evidence, incomingBlock.evidence, options.maxEvidence),
  }
  return { matched: true, reason, block: next }
}

function buildPersonaProfileReinforcementShadow(blocks: PersonaProfileBlock[] = [], options: PersonaProfileOptions = {}) {
  const now = normalizePersonaProfileTs(options.now, Date.now())
  const merged: PersonaProfileBlock[] = []
  const reasonCounts: ProfileCounts = { quote_hash: 0, normalized_text: 0 }
  let invalidCount = 0
  let reinforcedCount = 0
  for (const raw of Array.isArray(blocks) ? blocks : []) {
    const block = buildPersonaProfileBlock({ ...raw, now })
    if (!block) {
      invalidCount += 1
      continue
    }
    let mergedIntoExisting = false
    for (let i = 0; i < merged.length; i += 1) {
      const result = reinforcePersonaProfileBlock(merged[i], block, { ...options, now })
      if (!result.matched || !result.block) continue
      merged[i] = result.block
      reinforcedCount += 1
      reasonCounts[result.reason] = (reasonCounts[result.reason] || 0) + 1
      mergedIntoExisting = true
      break
    }
    if (!mergedIntoExisting) merged.push(block)
  }
  return {
    version: PERSONA_PROFILE_VERSION,
    now,
    originalCount: Array.isArray(blocks) ? blocks.length : 0,
    dedupedCount: merged.length,
    reinforcedCount,
    invalidCount,
    reasonCounts,
    blocks: merged,
  }
}

function formatPersonaProfileReinforcementShadowDiagnostic(shadow: ProfileRecord = {}): string {
  const reasonCounts = (shadow.reasonCounts || {}) as ProfileCounts
  const reasons = ['quote_hash', 'normalized_text']
    .map(key => `${key}:${Math.max(0, Math.floor(Number(reasonCounts[key]) || 0))}`)
    .join(',')
  return [
    'profile_reinforce_shadow',
    `total=${Math.max(0, Math.floor(Number(shadow.originalCount) || 0))}`,
    `deduped=${Math.max(0, Math.floor(Number(shadow.dedupedCount) || 0))}`,
    `reinforced=${Math.max(0, Math.floor(Number(shadow.reinforcedCount) || 0))}`,
    `invalid=${Math.max(0, Math.floor(Number(shadow.invalidCount) || 0))}`,
    `reasons=${reasons}`,
    'mode=shadow_only',
    'prompt=unchanged',
  ].join(' ')
}

function computePersonaProfileEffectiveConfidence(block: PersonaProfileBlock = {}, options: PersonaProfileOptions = {}): number {
  if (!block || typeof block !== 'object') return 0
  const status = String(block.status || 'candidate')
  if (status === 'disputed' || status === 'archived') return 0
  const now = normalizePersonaProfileTs(options.now, Date.now())
  const expiresAt = Number(block.expiresAt || 0)
  if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now) return 0
  const confidence = normalizePersonaProfileNumber(block.confidence, status === 'active' ? 0.7 : 0.2, 0, 1)
  const lastAccessedAt = normalizePersonaProfileTs(block.lastAccessedAt || block.updatedAt || block.createdAt, now)
  const ageDays = Math.max(0, (now - lastAccessedAt) / (24 * 60 * 60 * 1000))
  const decayPerDay = normalizePersonaProfileNumber(options.decayPerDay, PROFILE_EFFECTIVE_DECAY_PER_DAY, 0, 1)
  let effective = confidence * Math.pow(decayPerDay, ageDays)
  const adminSources = Array.isArray(options.adminSources) ? options.adminSources.map(String) : ['admin_edit']
  if (status === 'active' && adminSources.includes(String(block.source || ''))) {
    const adminMin = normalizePersonaProfileNumber(options.adminMinConfidence, PROFILE_EFFECTIVE_ADMIN_MIN_CONFIDENCE, 0, 1)
    effective = Math.max(effective, adminMin)
  }
  return Number(Math.max(0, Math.min(1, effective)).toFixed(3))
}

function selectPersonaProfileBlocksByEffectiveConfidence(blocks: PersonaProfileBlock[] = [], options: PersonaProfileOptions = {}) {
  const now = normalizePersonaProfileTs(options.now, Date.now())
  const rawLimit = Number(options.limit)
  const limit = Math.max(0, Math.min(50, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : PROFILE_EFFECTIVE_DEFAULT_LIMIT))
  const minEffectiveConfidence = normalizePersonaProfileNumber(options.minEffectiveConfidence, PROFILE_EFFECTIVE_MIN_CONFIDENCE, 0, 1)
  const allowedStatuses = Array.isArray(options.allowedStatuses) && options.allowedStatuses.length
    ? new Set(options.allowedStatuses.map(String))
    : new Set(['active'])
  const includeSensitive = !!options.includeSensitive
  const skipped: ProfileCounts = { status: 0, expired: 0, sensitive: 0, lowConfidence: 0 }
  const candidates: PersonaProfileBlock[] = []
  for (const raw of Array.isArray(blocks) ? blocks : []) {
    const block = buildPersonaProfileBlock({ ...raw, now })
    if (!block) continue
    const status = block.status
    if (!status || !allowedStatuses.has(status)) { skipped.status += 1; continue }
    const expiresAt = Number(block.expiresAt || 0)
    if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now) { skipped.expired += 1; continue }
    if (!includeSensitive && block.sensitivity === 'sensitive') { skipped.sensitive += 1; continue }
    const effectiveConfidence = computePersonaProfileEffectiveConfidence(block, { ...options, now })
    if (effectiveConfidence < minEffectiveConfidence) { skipped.lowConfidence += 1; continue }
    candidates.push({ ...block, effectiveConfidence })
  }
  candidates.sort((a, b) => {
    const aEffectiveConfidence = Number(a.effectiveConfidence || 0)
    const bEffectiveConfidence = Number(b.effectiveConfidence || 0)
    if (bEffectiveConfidence !== aEffectiveConfidence) return bEffectiveConfidence - aEffectiveConfidence
    if ((b.reinforceCount || 0) !== (a.reinforceCount || 0)) return (b.reinforceCount || 0) - (a.reinforceCount || 0)
    return (b.updatedAt || 0) - (a.updatedAt || 0)
  })
  return {
    version: PERSONA_PROFILE_VERSION,
    now,
    considered: Array.isArray(blocks) ? blocks.length : 0,
    selected: candidates.slice(0, limit),
    candidates,
    skipped,
    minEffectiveConfidence,
    limit,
  }
}

function buildPersonaProfileSelectionDiagnostic(profile: PersonaProfile = {}, options: PersonaProfileOptions = {}) {
  const selection = (options.selection || selectPersonaProfileBlocksByEffectiveConfidence(profile.blocks || [], options)) as {
    considered?: number
    selected?: PersonaProfileBlock[]
    skipped?: ProfileCounts
  }
  const selected = Array.isArray(selection.selected) ? selection.selected : []
  return {
    version: PERSONA_PROFILE_VERSION,
    userHash: profile.user?.idHash || hashPersonaProfileValue(options.userId || '', 12),
    channelHash: profile.channel?.hash || hashPersonaProfileValue(options.channelKey || '', 12),
    total: Array.isArray(profile.blocks) ? profile.blocks.length : 0,
    considered: selection.considered || 0,
    selected: selected.length,
    top: selected.slice(0, 5).map(item => ({
      idHash: hashPersonaProfileValue(item.id || '', 10),
      block: item.block || '',
      category: item.category || '',
      status: item.status || '',
      sensitivity: item.sensitivity || '',
      effectiveConfidence: Number(item.effectiveConfidence || 0),
      reinforceCount: Math.max(0, Math.floor(Number(item.reinforceCount) || 0)),
    })),
    skipped: selection.skipped || {},
    reasons: ['shadow_only', 'no_prompt_injection'],
  }
}

function formatPersonaProfileSelectionDiagnostic(diagnostic: ProfileRecord = {}): string {
  const skipped = (diagnostic.skipped || {}) as ProfileCounts
  const skippedText = ['status', 'expired', 'sensitive', 'lowConfidence']
    .map(key => `${key}:${Math.max(0, Math.floor(Number(skipped[key]) || 0))}`)
    .join(',')
  const top = Array.isArray(diagnostic.top) && diagnostic.top.length
    ? diagnostic.top.map(item => `${item.idHash}:${Number(item.effectiveConfidence || 0).toFixed(3)}:${item.status}:${item.block}/${item.category}`).join(',')
    : 'none'
  return [
    'profile_selection',
    `user=${diagnostic.userHash || 'none'}`,
    `channel=${diagnostic.channelHash || 'none'}`,
    `total=${Math.max(0, Math.floor(Number(diagnostic.total) || 0))}`,
    `considered=${Math.max(0, Math.floor(Number(diagnostic.considered) || 0))}`,
    `selected=${Math.max(0, Math.floor(Number(diagnostic.selected) || 0))}`,
    `top=${top}`,
    `skipped=${skippedText}`,
    `reasons=${Array.isArray(diagnostic.reasons) && diagnostic.reasons.length ? diagnostic.reasons.join(',') : 'none'}`,
  ].join(' ')
}

function buildPersonaProfileReinforceDiagnostic(input: ProfileRecord = {}) {
  const before = (input.before || {}) as PersonaProfileBlock
  const after = (input.after || input.block || {}) as PersonaProfileBlock
  const effectiveConfidence = computePersonaProfileEffectiveConfidence(after, input)
  return {
    version: PERSONA_PROFILE_VERSION,
    matched: !!input.matched,
    reason: normalizePersonaProfileText(input.reason || 'unknown', 40) || 'unknown',
    factHash: hashPersonaProfileValue(after.id || before.id || '', 10),
    oldConfidence: Number(normalizePersonaProfileNumber(before.confidence, 0, 0, 1).toFixed(3)),
    newConfidence: Number(normalizePersonaProfileNumber(after.confidence, 0, 0, 1).toFixed(3)),
    effectiveConfidence,
    reinforceCount: Math.max(0, Math.floor(Number(after.reinforceCount) || 0)),
    quoteHash: hashPersonaProfileValue(input.quoteHash || '', 10),
    selectedTopN: !!input.selectedTopN,
  }
}

function formatPersonaProfileReinforceDiagnostic(diagnostic: ProfileRecord = {}): string {
  return [
    'profile_reinforce',
    `matched=${diagnostic.matched === true}`,
    `reason=${normalizePersonaProfileText(diagnostic.reason || 'unknown', 40) || 'unknown'}`,
    `fact=${diagnostic.factHash || 'none'}`,
    `old=${Number(diagnostic.oldConfidence || 0).toFixed(3)}`,
    `new=${Number(diagnostic.newConfidence || 0).toFixed(3)}`,
    `effective=${Number(diagnostic.effectiveConfidence || 0).toFixed(3)}`,
    `reinforce=${Math.max(0, Math.floor(Number(diagnostic.reinforceCount) || 0))}`,
    `quote=${diagnostic.quoteHash || 'none'}`,
    `topN=${diagnostic.selectedTopN === true}`,
  ].join(' ')
}

function buildPersonaProfileBlocksFromLegacyData(data: ProfileRecord = {}, options: PersonaProfileOptions = {}): PersonaProfile {
  const userId = String(options.userId || data.userId || '')
  const channelKey = String(options.channelKey || '')
  const now = normalizePersonaProfileTs(options.now, Date.now())
  const diagnostics: ProfileRecord[] = []
  const blocks: PersonaProfileBlock[] = []
  const memory = Array.isArray(data.memory) ? data.memory as ProfileRecord[] : []
  const messages = Array.isArray(data.messages) ? data.messages as ProfileRecord[] : []
  const sourceStats = {
    memory: memory.length,
    confirmedMemory: 0,
    unconfirmedMemory: 0,
    messages: messages.length,
    recentMessageWindow: 0,
    recentMessageBlocks: 0,
    agentMemory: 0,
    includeRecentMessages: options.includeRecentMessages !== false,
    includeAgentMemory: !!options.includeAgentMemory,
  }
  for (const item of memory) {
    const text = normalizePersonaProfileText(item && item.text || '', 500)
    if (!text) continue
    const confirmCount = Math.max(0, Number(item.confirmCount || 0))
    if (confirmCount <= 0) {
      sourceStats.unconfirmedMemory += 1
      diagnostics.push({ level: 'info', code: 'legacy_memory_unconfirmed', source: 'legacy_explicit_memory' })
      continue
    }
    sourceStats.confirmedMemory += 1
    const block = buildPersonaProfileBlock({
      block: 'human',
      category: 'memory',
      text,
      sensitivity: 'private',
      confidence: Math.min(0.95, 0.65 + confirmCount * 0.08),
      source: 'legacy_explicit_memory',
      status: 'active',
      createdAt: Number(item.ts || now),
      updatedAt: Number(item.ts || now),
      now,
      evidence: [{ source: 'legacy_explicit_memory', text, ts: Number(item.ts || now), channelKey }],
    })
    if (block) blocks.push(block)
  }
  if (options.includeRecentMessages !== false) {
    const maxRecent = Math.max(0, Math.min(10, Number(options.maxRecentMessages) || 3))
    const recentMessages = messages.slice(-maxRecent)
    sourceStats.recentMessageWindow = recentMessages.length
    for (const item of recentMessages) {
      const text = normalizePersonaProfileText(item && item.content || '', 240)
      if (!text) continue
      const block = buildPersonaProfileBlock({
        block: 'working',
        category: 'style',
        text,
        sensitivity: 'private',
        confidence: 0.2,
        source: 'recent_user_message',
        status: 'candidate',
        createdAt: Number(item.ts || now),
        updatedAt: Number(item.ts || now),
        expiresAt: now + 7 * 24 * 60 * 60 * 1000,
        now,
        evidence: [{ source: 'recent_user_message', text, ts: Number(item.ts || now), messageId: String(item.messageId || ''), channelKey }],
        maxTextLength: 240,
      })
      if (block) {
        blocks.push(block)
        sourceStats.recentMessageBlocks += 1
      }
    }
  }
  return {
    version: PERSONA_PROFILE_VERSION,
    user: {
      id: userId,
      idHash: hashPersonaProfileValue(userId, 12),
      names: Array.isArray(data.names) ? data.names.map(name => normalizePersonaProfileText(name, 40)).filter(Boolean).slice(0, 8) : [],
    },
    channel: {
      hash: hashPersonaProfileValue(channelKey, 12),
    },
    blocks,
    diagnostics,
    sourceStats,
  }
}

function safePersonaProfileFile(userId: string, channelKey: string, rootDir: string = USER_PROFILE_DIR): string {
  const safeChannel = sanitizePersonaProfileKey(channelKey)
  const safeUser = sanitizePersonaProfileKey(userId)
  return path.join(rootDir, safeChannel, `${safeUser}.json`)
}

async function readLegacyPersonaProfileData({ userId, channelKey, rootDir = USER_PROFILE_DIR }: { userId?: string; channelKey?: string; rootDir?: string } = {}): Promise<ProfileRecord | null> {
  try {
    const normalizedUserId = String(userId || '')
    const normalizedChannelKey = String(channelKey || '')
    const file = safePersonaProfileFile(normalizedUserId, normalizedChannelKey, rootDir)
    const stat = await fsp.stat(file)
    if (!stat.isFile() || stat.size > MAX_PROFILE_SOURCE_FILE_BYTES) return null
    const data = JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, ''))
    return data && typeof data === 'object' ? data : null
  } catch { /* non-critical: missing/oversized/invalid legacy profile reads as no profile data */
    return null
  }
}

async function buildPersonaProfileBlocks(options: PersonaProfileOptions = {}): Promise<PersonaProfile> {
  const userId = String(options.userId || '')
  const channelKey = String(options.channelKey || '')
  const data = await readLegacyPersonaProfileData(options) || { userId, names: [], messages: [], memory: [] }
  const profile = buildPersonaProfileBlocksFromLegacyData(data, options)
  const blocks = Array.isArray(profile.blocks) ? profile.blocks : []
  const diagnostics = Array.isArray(profile.diagnostics) ? profile.diagnostics : []
  if (options.includeAgentMemory) {
    try {
      const items = typeof options.agentMemoryReader === 'function'
        ? await options.agentMemoryReader({ userId, limit: options.agentMemoryLimit || 10 })
        : await (require('../agent/memory') as typeof import('../agent/memory')).listMemory({ userId, limit: options.agentMemoryLimit || 10 })
      for (const item of items) {
        const text = normalizePersonaProfileText(item.text || '', 700)
        const block = buildPersonaProfileBlock({
          block: 'archival',
          category: 'memory',
          text,
          sensitivity: 'private',
          confidence: 0.7,
          source: 'agent_memory',
          status: 'active',
          createdAt: Number(item.createdAt || Date.now()),
          updatedAt: Number(item.updatedAt || item.createdAt || Date.now()),
          now: options.now,
          evidence: [{ source: 'agent_memory', text, ts: Number(item.createdAt || Date.now()), channelKey: String(item.channelKey || channelKey) }],
          maxTextLength: 700,
        })
        if (block) {
          blocks.push(block)
          if (profile.sourceStats) profile.sourceStats.agentMemory = Number(profile.sourceStats.agentMemory || 0) + 1
        }
      }
    } catch {
      diagnostics.push({ level: 'warning', code: 'agent_memory_read_failed', source: 'agent_memory' })
    }
  }
  profile.summary = summarizePersonaProfileBlocks(profile)
  return profile
}

function summarizePersonaProfileBlocks(profile: PersonaProfile = {}) {
  const counts: ProfileCounts = {}
  const statuses: ProfileCounts = {}
  for (const item of Array.isArray(profile.blocks) ? profile.blocks : []) {
    const blockKey = String(item.block || 'unknown')
    const statusKey = String(item.status || 'unknown')
    counts[blockKey] = (counts[blockKey] || 0) + 1
    statuses[statusKey] = (statuses[statusKey] || 0) + 1
  }
  return {
    version: PERSONA_PROFILE_VERSION,
    userHash: profile.user?.idHash || '',
    channelHash: profile.channel?.hash || '',
    total: Array.isArray(profile.blocks) ? profile.blocks.length : 0,
    byBlock: counts,
    byStatus: statuses,
    diagnostics: Array.isArray(profile.diagnostics) ? profile.diagnostics.map(item => ({
      level: item.level || 'info',
      code: item.code || 'unknown',
      source: item.source || '',
    })) : [],
  }
}

function buildPersonaProfileSourceDiagnostic(profile: PersonaProfile = {}, options: PersonaProfileOptions = {}) {
  const stats = (profile.sourceStats || {}) as ProfileRecord
  return {
    version: PERSONA_PROFILE_VERSION,
    userHash: profile.user?.idHash || hashPersonaProfileValue(options.userId || '', 12),
    channelHash: profile.channel?.hash || hashPersonaProfileValue(options.channelKey || '', 12),
    memory: Math.max(0, Math.floor(Number(stats.memory) || 0)),
    confirmedMemory: Math.max(0, Math.floor(Number(stats.confirmedMemory) || 0)),
    unconfirmedMemory: Math.max(0, Math.floor(Number(stats.unconfirmedMemory) || 0)),
    messages: Math.max(0, Math.floor(Number(stats.messages) || 0)),
    recentMessageWindow: Math.max(0, Math.floor(Number(stats.recentMessageWindow) || 0)),
    recentMessageBlocks: Math.max(0, Math.floor(Number(stats.recentMessageBlocks) || 0)),
    agentMemory: Math.max(0, Math.floor(Number(stats.agentMemory) || 0)),
    includeRecentMessages: stats.includeRecentMessages !== false,
    includeAgentMemory: stats.includeAgentMemory === true,
    totalBlocks: Array.isArray(profile.blocks) ? profile.blocks.length : 0,
    reasons: ['shadow_only', 'no_prompt_injection'],
  }
}

function formatPersonaProfileSourceDiagnostic(diagnostic: ProfileRecord = {}): string {
  return [
    'profile_source',
    `user=${diagnostic.userHash || 'none'}`,
    `channel=${diagnostic.channelHash || 'none'}`,
    `memory=${Math.max(0, Math.floor(Number(diagnostic.memory) || 0))}`,
    `confirmed=${Math.max(0, Math.floor(Number(diagnostic.confirmedMemory) || 0))}`,
    `unconfirmed=${Math.max(0, Math.floor(Number(diagnostic.unconfirmedMemory) || 0))}`,
    `messages=${Math.max(0, Math.floor(Number(diagnostic.messages) || 0))}`,
    `recentWindow=${Math.max(0, Math.floor(Number(diagnostic.recentMessageWindow) || 0))}`,
    `recentBlocks=${Math.max(0, Math.floor(Number(diagnostic.recentMessageBlocks) || 0))}`,
    `agentMemory=${Math.max(0, Math.floor(Number(diagnostic.agentMemory) || 0))}`,
    `includeRecent=${diagnostic.includeRecentMessages === true}`,
    `includeAgent=${diagnostic.includeAgentMemory === true}`,
    `totalBlocks=${Math.max(0, Math.floor(Number(diagnostic.totalBlocks) || 0))}`,
    `reasons=${Array.isArray(diagnostic.reasons) && diagnostic.reasons.length ? diagnostic.reasons.join(',') : 'none'}`,
  ].join(' ')
}

function buildPersonaProfileShadowPreview(profile: PersonaProfile = {}, options: PersonaProfileOptions = {}): ProfileRecord {
  const selection = (options.selection || selectPersonaProfileBlocksByEffectiveConfidence(profile.blocks || [], {
    now: options.now,
    limit: 5,
    minEffectiveConfidence: 0.1,
    allowedStatuses: ['active', 'candidate'],
  })) as ProfileRecord
  const now = normalizePersonaProfileTs(options.now, Date.now())
  const selectedRanks = new Map<string, number>()
  ;(Array.isArray(selection.selected) ? selection.selected as PersonaProfileBlock[] : []).forEach((block, index) => {
    if (block && block.id) selectedRanks.set(String(block.id), index + 1)
  })
  const selected = (Array.isArray(selection.selected) ? selection.selected as PersonaProfileBlock[] : [])
    .filter(block => isPersonaProfileShadowStyleBlock(block))
    .slice(0, 5)
  const analyses = selected.map(block => ({
    ...analyzePersonaProfileShadowText(block.text || ''),
    idHash: hashPersonaProfileValue(block.id || '', 10),
    source: String(block.source || 'unknown'),
    status: String(block.status || 'candidate'),
    block: String(block.block || 'working'),
    category: String(block.category || 'style'),
    confidence: Number(block.effectiveConfidence || block.confidence || 0),
    reinforceCount: Math.max(0, Math.floor(Number(block.reinforceCount) || 0)),
  }))
  const summary = summarizePersonaProfileShadowTraits(analyses)
  const traits = summary.traits.filter(item => PROFILE_SHADOW_TRAITS.includes(item))
  const blockers = Array.from(new Set(summary.blockers))
  const warnings = Array.from(new Set(summary.warnings))
  const wouldInject = selected.length > 0 && blockers.length === 0
  const promptPreview = buildPersonaProfileShadowPromptPreview(traits, warnings)
  const evidenceHashes = analyses.map(item => item.textHash).filter(Boolean)
  const candidates = (Array.isArray(profile.blocks) ? profile.blocks : [])
    .map(block => buildPersonaProfileShadowCandidate(block, {
      ...options,
      now,
      selectedRanks,
      minEffectiveConfidence: Number(selection.minEffectiveConfidence || options.minEffectiveConfidence || PROFILE_EFFECTIVE_MIN_CONFIDENCE),
      allowedStatuses: ['active', 'candidate'],
    }))
    .filter(isBuiltPersonaProfileShadowCandidate)
  const selectedCandidateHashes = new Set(selected.map(block => hashPersonaProfileValue(block.id || '', 10)))
  const selectedCandidates = candidates.filter(item => selectedCandidateHashes.has(item.blockHash))
  const skippedLearning: ProfileCounts = {}
  for (const candidate of candidates) {
    const blockersForCandidate = candidate.learning?.blockers || []
    if (!blockersForCandidate.length) continue
    for (const reason of blockersForCandidate) skippedLearning[reason] = (skippedLearning[reason] || 0) + 1
  }
  return {
    version: PROFILE_SHADOW_PREVIEW_VERSION,
    mode: 'shadow_only',
    prompt: 'unchanged',
    ts: now,
    userHash: profile.user?.idHash || hashPersonaProfileValue(options.userId || '', 12),
    channelHash: profile.channel?.hash || hashPersonaProfileValue(options.channelKey || '', 12),
    selectedCount: selected.length,
    consideredCount: Math.max(0, Math.floor(Number(selection.considered) || 0)),
    totalBlocks: Array.isArray(profile.blocks) ? profile.blocks.length : 0,
    sourceCounts: profile.sourceStats || {},
    avgLength: summary.avgLength,
    counts: summary.counts,
    traits,
    blockers,
    warnings,
    wouldInject,
    confidence: Number(Math.max(0, Math.min(1, traits.length * 0.12 + selected.length * 0.04 + (summary.counts?.short ? 0.05 : 0) - blockers.length * 0.2)).toFixed(3)),
    evidenceHashes: evidenceHashes.slice(0, 5),
    candidates,
    selectedCandidates,
    skippedLearning,
    top: analyses.slice(0, 5).map(item => ({
      idHash: item.idHash,
      textHash: item.textHash,
      confidence: Number(item.confidence || 0),
      reinforceCount: item.reinforceCount,
      status: item.status,
      type: `${item.block}/${item.category}`,
    })),
    promptPreview,
    promptPreviewHash: hashPersonaProfileValue(promptPreview, 10),
    tokenEstimate: estimatePersonaProfilePromptTokens(promptPreview),
    reasons: ['shadow_only', 'no_prompt_injection', wouldInject ? 'would_inject_if_enabled' : 'blocked_if_enabled'],
  }
}

function buildPersonaProfileShadowLogEvent(preview: ProfileRecord = {}, options: PersonaProfileOptions = {}): ProfileRecord {
  const now = normalizePersonaProfileTs(preview.ts || options.now, Date.now())
  const selectedCandidates = (Array.isArray(preview.selectedCandidates) ? preview.selectedCandidates : []).slice(0, 5)
  const candidates = (Array.isArray(preview.candidates) ? preview.candidates : []).slice(0, 12)
  return {
    type: 'profile_shadow_v2',
    version: Math.max(0, Math.floor(Number(preview.version) || PROFILE_SHADOW_PREVIEW_VERSION)),
    ts: now,
    isoTime: new Date(now).toISOString(),
    mode: 'shadow_only',
    prompt: 'unchanged',
    userHash: preview.userHash || '',
    channelHash: preview.channelHash || '',
    totals: {
      blocks: Math.max(0, Math.floor(Number(preview.totalBlocks) || 0)),
      considered: Math.max(0, Math.floor(Number(preview.consideredCount) || 0)),
      selectedStyle: Math.max(0, Math.floor(Number(preview.selectedCount) || 0)),
      candidates: Array.isArray(preview.candidates) ? preview.candidates.length : 0,
    },
    sourceCounts: preview.sourceCounts || {},
    aggregate: {
      traits: Array.isArray(preview.traits) ? preview.traits : [],
      blockers: Array.isArray(preview.blockers) ? preview.blockers : [],
      warnings: Array.isArray(preview.warnings) ? preview.warnings : [],
      counts: preview.counts || {},
      avgLength: Math.max(0, Math.floor(Number(preview.avgLength) || 0)),
      confidence: Number(preview.confidence || 0),
      skippedLearning: preview.skippedLearning || {},
    },
    candidates,
    selectedCandidates,
    promptPreview: {
      wouldInject: preview.wouldInject === true,
      hash: preview.promptPreviewHash || hashPersonaProfileValue(preview.promptPreview || '', 10),
      tokensEstimated: Math.max(0, Math.floor(Number(preview.tokenEstimate) || 0)),
      text: String(preview.promptPreview || ''),
      reasons: Array.isArray(preview.reasons) ? preview.reasons : ['shadow_only', 'no_prompt_injection'],
    },
    safety: {
      redacted: true,
      rawText: false,
      rawUserId: false,
      rawChannelId: false,
      promptInjection: false,
      profileWrite: false,
    },
  }
}

function formatPersonaProfileShadowLearningDiagnostic(preview: ProfileRecord = {}): string {
  const counts = (preview.counts || {}) as ProfileCounts
  return [
    'profile_shadow_learning',
    `v=${Math.max(0, Math.floor(Number(preview.version) || 0))}`,
    `user=${preview.userHash || 'none'}`,
    `channel=${preview.channelHash || 'none'}`,
    `selected=${Math.max(0, Math.floor(Number(preview.selectedCount) || 0))}`,
    `traits=${formatPersonaProfileLogList(Array.isArray(preview.traits) ? preview.traits : [])}`,
    `blockers=${formatPersonaProfileLogList(Array.isArray(preview.blockers) ? preview.blockers : [])}`,
    `warnings=${formatPersonaProfileLogList(Array.isArray(preview.warnings) ? preview.warnings : [])}`,
    `counts=short:${Math.max(0, Math.floor(Number(counts.short) || 0))},long:${Math.max(0, Math.floor(Number(counts.long) || 0))},media:${Math.max(0, Math.floor(Number(counts.media) || 0))},command:${Math.max(0, Math.floor(Number(counts.command) || 0))},correction:${Math.max(0, Math.floor(Number(counts.correction) || 0))},question:${Math.max(0, Math.floor(Number(counts.question) || 0))},technical:${Math.max(0, Math.floor(Number(counts.technical) || 0))},meme:${Math.max(0, Math.floor(Number(counts.meme) || 0))}`,
    `avgLen=${Math.max(0, Math.floor(Number(preview.avgLength) || 0))}`,
    `evidence=${formatPersonaProfileLogList(Array.isArray(preview.evidenceHashes) ? preview.evidenceHashes : [])}`,
    `confidence=${Number(preview.confidence || 0).toFixed(3)}`,
    `wouldInject=${preview.wouldInject === true}`,
    'mode=shadow_only',
    'prompt=unchanged',
  ].join(' ')
}

function formatPersonaProfileShadowPromptPreviewDiagnostic(preview: ProfileRecord = {}): string {
  return [
    'profile_shadow_prompt_preview',
    `user=${preview.userHash || 'none'}`,
    `channel=${preview.channelHash || 'none'}`,
    `wouldInject=${preview.wouldInject === true}`,
    `tokensEstimated=${Math.max(0, Math.floor(Number(preview.tokenEstimate) || 0))}`,
    `previewHash=${preview.promptPreviewHash || 'none'}`,
    `preview=${formatPersonaProfileLogAtom(preview.promptPreview || '')}`,
    `blockers=${formatPersonaProfileLogList(Array.isArray(preview.blockers) ? preview.blockers : [])}`,
    `reasons=${Array.isArray(preview.reasons) && preview.reasons.length ? preview.reasons.join(',') : 'none'}`,
  ].join(' ')
}

function ignorePersonaProfileRotationFailure(error: unknown): void {
  void error
}

async function appendPersonaProfileShadowLog(preview: ProfileRecord = {}, options: PersonaProfileOptions = {}) {
  const event = buildPersonaProfileShadowLogEvent(preview, options)
  const file = options.file || getPersonaProfileShadowLogFile(event.ts, options.rootDir)
  const entry = JSON.stringify(event) + '\n'
  const writeTask = async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true })
    try {
      const stat = await fsp.stat(file)
      if (stat.isFile() && stat.size > PROFILE_SHADOW_LOG_MAX_BYTES) {
        const rotated = `${file}.${Date.now()}.old`
        await fsp.rename(file, rotated).catch(ignorePersonaProfileRotationFailure)
      }
    } catch { /* non-critical: stat/rotation failure should not block appending current shadow log */
    }
    await fsp.appendFile(file, entry, 'utf8')
    return { file, event }
  }
  personaProfileShadowLogChain = personaProfileShadowLogChain.then(writeTask, writeTask)
  return personaProfileShadowLogChain
}

function formatPersonaProfileSummary(profile: PersonaProfile = {}): string {
  const summary = profile.summary || summarizePersonaProfileBlocks(profile)
  const blockText = Object.entries(summary.byBlock || {}).map(([key, value]) => `${key}:${value}`).join(',')
  const statusText = Object.entries(summary.byStatus || {}).map(([key, value]) => `${key}:${value}`).join(',')
  return [
    `user=${summary.userHash || 'none'}`,
    `channel=${summary.channelHash || 'none'}`,
    `total=${summary.total || 0}`,
    `blocks=${blockText || 'none'}`,
    `statuses=${statusText || 'none'}`,
    `diagnostics=${Array.isArray(summary.diagnostics) ? summary.diagnostics.length : 0}`,
  ].join(' ')
}

export = {
  PERSONA_PROFILE_VERSION,
  PROFILE_BLOCK_TYPES,
  PROFILE_STATUSES,
  PROFILE_SENSITIVITY,
  PROFILE_CATEGORIES,
  hashPersonaProfileValue,
  sanitizePersonaProfileKey,
  normalizePersonaProfileText,
  buildPersonaProfileEvidence,
  buildPersonaProfileBlock,
  reinforcePersonaProfileBlock,
  buildPersonaProfileReinforcementShadow,
  formatPersonaProfileReinforcementShadowDiagnostic,
  computePersonaProfileEffectiveConfidence,
  selectPersonaProfileBlocksByEffectiveConfidence,
  buildPersonaProfileSelectionDiagnostic,
  formatPersonaProfileSelectionDiagnostic,
  buildPersonaProfileReinforceDiagnostic,
  formatPersonaProfileReinforceDiagnostic,
  buildPersonaProfileBlocksFromLegacyData,
  buildPersonaProfileSourceDiagnostic,
  formatPersonaProfileSourceDiagnostic,
  getPersonaProfileShadowLogFile,
  buildPersonaProfileShadowPreview,
  buildPersonaProfileShadowLogEvent,
  appendPersonaProfileShadowLog,
  formatPersonaProfileShadowLearningDiagnostic,
  formatPersonaProfileShadowPromptPreviewDiagnostic,
  safePersonaProfileFile,
  readLegacyPersonaProfileData,
  buildPersonaProfileBlocks,
  summarizePersonaProfileBlocks,
  formatPersonaProfileSummary,
}
