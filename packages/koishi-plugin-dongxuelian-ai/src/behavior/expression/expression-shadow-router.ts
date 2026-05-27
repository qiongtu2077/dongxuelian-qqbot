/**
 * MODULE: 表达学习旁路路由 v2.3（shadow，仅日志）。
 * 职责: chat 准备回复前，按使用侧硬过滤挑 0–3 条候选骨架，返回诊断对象。
 *      调用方拿到诊断后只 logDebug('expression-pool', ...)，不写真 system message。
 * 边界: 不调模型、不发消息、不修改 messages 数组、不写回 lastUsedAt。
 *      所有原文（situation/style/userText）禁止出现在格式化诊断字符串中，只用 sha256 短哈希。
 * 状态: 无；每次调用读一次池文件。
 */
const crypto = require('crypto')
const { loadExpressionPool, EXPRESSION_POOL_MIN_USE_COUNT, EXPRESSION_POOL_STATUS } = require('./expression-pool-store') as typeof import('./expression-pool-store')
const { EXPRESSION_LEARNER_SENSITIVE_TOPIC_KEYWORDS, EXPRESSION_LEARNER_SENSITIVE_TOPIC_WINDOW_MS } = require('./expression-learner') as typeof import('./expression-learner')

interface ShadowEntry {
  id?: string
  situation?: string
  style?: string
  count?: number
  status?: string
  lastUsedAt?: number
  lastMergedAt?: number
  createdAt?: number
  contributors?: string[]
}

interface ExpressionShadowInput {
  channelKey?: string
  personaName?: string
  recentSpeakerIds?: Array<string | number>
  sensitiveTopicActive?: boolean
  now?: number
}

interface ExpressionShadowOptions {
  loadPool?: (channelKey: string) => { entries?: ShadowEntry[] }
}

interface ExpressionShadowDiagnostic {
  version: number
  decision: string
  channelHash: string
  personaHash: string
  injectionMode: string
  poolSize: number
  candidatesConsidered: number
  candidatesPicked: number
  pickedHashes: string[]
  skipped: Record<string, number>
  reasons: string[]
}

interface SensitiveTopicMessage {
  content?: string
  ts?: number
  timestamp?: number
}

const EXPRESSION_SHADOW_VERSION = 1
const EXPRESSION_SHADOW_COLD_START_MIN_POOL = 10
const EXPRESSION_SHADOW_PER_ENTRY_COOLDOWN_MS = 10 * 60 * 1000
const EXPRESSION_SHADOW_FRESH_CANDIDATE_MS = 24 * 60 * 60 * 1000
const EXPRESSION_SHADOW_RECENT_SPEAKER_WINDOW_MS = 5 * 60 * 1000
const EXPRESSION_SHADOW_MAX_PICKS = 3

const EXPRESSION_SHADOW_SKIP_REASONS = Object.freeze({
  injectionOff: 'injectionOff',
  poolEmpty: 'poolEmpty',
  coldStart: 'coldStart',
  lowCount: 'lowCount',
  cooldownPerEntry: 'cooldownPerEntry',
  contributorActive: 'contributorActive',
  freshCandidate: 'freshCandidate',
  sensitiveTopicWindow: 'sensitiveTopicWindow',
})

const EXPRESSION_SHADOW_PERSONA_DEFAULT_POLICY = Object.freeze({
  '东雪莲': 'on',
  '椿': 'on',
  '爱弥斯': 'abstract',
  '长离': 'off',
  '特蕾西娅': 'off',
})

function shadowText(value: unknown, maxLen: number = 80): string {
  return String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, Math.max(1, maxLen))
}

function shadowHash(value: unknown): string {
  const text = String(value == null ? '' : value).trim()
  if (!text) return ''
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 12)
}

function shadowEmptySkipped(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const reason of Object.values(EXPRESSION_SHADOW_SKIP_REASONS)) out[reason] = 0
  return out
}

function resolveExpressionInjectionMode(personaName: string): string {
  const cleaned = shadowText(personaName, 40)
  if (!cleaned) return 'on'
  if (Object.prototype.hasOwnProperty.call(EXPRESSION_SHADOW_PERSONA_DEFAULT_POLICY, cleaned)) {
    return EXPRESSION_SHADOW_PERSONA_DEFAULT_POLICY[cleaned]
  }
  return 'on'
}

function detectExpressionSensitiveTopicActive(messages: SensitiveTopicMessage[] = [], now: number = Date.now(), windowMs: number = EXPRESSION_LEARNER_SENSITIVE_TOPIC_WINDOW_MS): boolean {
  if (!Array.isArray(messages) || !messages.length) return false
  const since = Number(now) - Math.max(60000, Number(windowMs) || 0)
  for (const entry of messages) {
    if (!entry || typeof entry.content !== 'string') continue
    const ts = Number(entry.ts || entry.timestamp || 0)
    if (Number.isFinite(ts) && ts > 0 && ts < since) continue
    if (EXPRESSION_LEARNER_SENSITIVE_TOPIC_KEYWORDS.some((kw) => entry.content.includes(kw))) return true
  }
  return false
}

function shadowSelectPicks(candidates: ShadowEntry[], maxPicks: number): ShadowEntry[] {
  if (!candidates.length) return []
  const sorted = candidates.slice().sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count
    return (b.lastMergedAt || b.createdAt || 0) - (a.lastMergedAt || a.createdAt || 0)
  })
  return sorted.slice(0, Math.max(0, Math.min(maxPicks, sorted.length)))
}

function buildExpressionShadowPlan(input: ExpressionShadowInput = {}, options: ExpressionShadowOptions = {}): ExpressionShadowDiagnostic {
  const channelKey = String(input.channelKey || '').trim()
  const personaName = shadowText(input.personaName, 40)
  const injectionMode = resolveExpressionInjectionMode(personaName)
  const now = Number(input.now) || Date.now()
  const recentSpeakerSet: Set<string> = new Set(Array.isArray(input.recentSpeakerIds) ? input.recentSpeakerIds.map((id) => String(id || '').trim()).filter(Boolean) : [])
  const sensitiveTopicActive = !!input.sensitiveTopicActive
  const skipped = shadowEmptySkipped()
  const reasons = []
  const baseDiagnostic = {
    version: EXPRESSION_SHADOW_VERSION,
    decision: 'silent',
    channelHash: shadowHash(channelKey),
    personaHash: shadowHash(personaName),
    injectionMode,
    poolSize: 0,
    candidatesConsidered: 0,
    candidatesPicked: 0,
    pickedHashes: [],
    skipped,
    reasons,
  }

  if (injectionMode === 'off') {
    skipped[EXPRESSION_SHADOW_SKIP_REASONS.injectionOff] += 1
    reasons.push('persona_injection_off')
    return baseDiagnostic
  }
  if (sensitiveTopicActive) {
    skipped[EXPRESSION_SHADOW_SKIP_REASONS.sensitiveTopicWindow] += 1
    reasons.push('sensitive_topic_window_active')
    return baseDiagnostic
  }

  let pool
  try {
    const loader = options.loadPool || loadExpressionPool
    pool = loader(channelKey)
  } catch { /* non-critical: shadow diagnostics treat unreadable pool as empty */
    pool = { entries: [] }
  }
  const entries = pool && Array.isArray(pool.entries) ? pool.entries : []
  baseDiagnostic.poolSize = entries.length

  if (!entries.length) {
    skipped[EXPRESSION_SHADOW_SKIP_REASONS.poolEmpty] += 1
    reasons.push('pool_empty')
    return baseDiagnostic
  }
  if (entries.length < EXPRESSION_SHADOW_COLD_START_MIN_POOL) {
    skipped[EXPRESSION_SHADOW_SKIP_REASONS.coldStart] += 1
    reasons.push('cold_start_pool_below_min')
    return baseDiagnostic
  }

  const candidates: ShadowEntry[] = []
  for (const entry of entries) {
    if (!entry || entry.status === EXPRESSION_POOL_STATUS.archived) continue
    if (!Number.isFinite(entry.count) || entry.count < EXPRESSION_POOL_MIN_USE_COUNT) {
      skipped[EXPRESSION_SHADOW_SKIP_REASONS.lowCount] += 1
      continue
    }
    if (Number(entry.lastUsedAt || 0) > 0 && now - Number(entry.lastUsedAt) < EXPRESSION_SHADOW_PER_ENTRY_COOLDOWN_MS) {
      skipped[EXPRESSION_SHADOW_SKIP_REASONS.cooldownPerEntry] += 1
      continue
    }
    if (recentSpeakerSet.size > 0 && Array.isArray(entry.contributors)) {
      let activeContributor = false
      for (const id of entry.contributors) { if (recentSpeakerSet.has(String(id))) { activeContributor = true; break } }
      if (activeContributor) {
        skipped[EXPRESSION_SHADOW_SKIP_REASONS.contributorActive] += 1
        continue
      }
    }
    if (Number(entry.createdAt || 0) > 0 && now - Number(entry.createdAt) < EXPRESSION_SHADOW_FRESH_CANDIDATE_MS) {
      skipped[EXPRESSION_SHADOW_SKIP_REASONS.freshCandidate] += 1
      continue
    }
    candidates.push(entry)
  }
  baseDiagnostic.candidatesConsidered = candidates.length
  const picks = shadowSelectPicks(candidates, EXPRESSION_SHADOW_MAX_PICKS)
  baseDiagnostic.candidatesPicked = picks.length
  baseDiagnostic.pickedHashes = picks.map((entry) => shadowHash(entry.id || ((entry.situation || '') + '::' + (entry.style || ''))))
  baseDiagnostic.decision = picks.length > 0 ? 'shadow_inject' : 'silent'
  if (!picks.length && !reasons.length) reasons.push('all_candidates_filtered')
  if (picks.length) reasons.push('would_inject_when_v24')
  return baseDiagnostic
}

function formatExpressionShadowDiagnostic(diagnostic: Partial<ExpressionShadowDiagnostic> = {}): string {
  const skipped = diagnostic.skipped || {}
  const reasons = Array.isArray(diagnostic.reasons) && diagnostic.reasons.length ? diagnostic.reasons.join(',') : 'none'
  const skippedParts = Object.values(EXPRESSION_SHADOW_SKIP_REASONS).map((reason) => `${reason}:${Math.max(0, Math.floor(Number(skipped[reason]) || 0))}`).join(',')
  const pickedHashes = Array.isArray(diagnostic.pickedHashes) && diagnostic.pickedHashes.length ? diagnostic.pickedHashes.join(',') : 'none'
  return [
    `decision=${shadowText(diagnostic.decision || 'silent', 30)}`,
    `channel=${shadowText(diagnostic.channelHash || 'none', 16) || 'none'}`,
    `persona=${shadowText(diagnostic.personaHash || 'none', 16) || 'none'}`,
    `mode=${shadowText(diagnostic.injectionMode || 'on', 12)}`,
    `pool=${Math.max(0, Math.floor(Number(diagnostic.poolSize) || 0))}`,
    `considered=${Math.max(0, Math.floor(Number(diagnostic.candidatesConsidered) || 0))}`,
    `picked=${Math.max(0, Math.floor(Number(diagnostic.candidatesPicked) || 0))}`,
    `picked_hashes=${pickedHashes}`,
    `skipped=${skippedParts}`,
    `reasons=${reasons}`,
  ].join(' ')
}

export = {
  EXPRESSION_SHADOW_VERSION,
  EXPRESSION_SHADOW_SKIP_REASONS,
  EXPRESSION_SHADOW_COLD_START_MIN_POOL,
  EXPRESSION_SHADOW_PER_ENTRY_COOLDOWN_MS,
  EXPRESSION_SHADOW_FRESH_CANDIDATE_MS,
  EXPRESSION_SHADOW_RECENT_SPEAKER_WINDOW_MS,
  EXPRESSION_SHADOW_MAX_PICKS,
  EXPRESSION_SHADOW_PERSONA_DEFAULT_POLICY,
  resolveExpressionInjectionMode,
  detectExpressionSensitiveTopicActive,
  buildExpressionShadowPlan,
  formatExpressionShadowDiagnostic,
}
