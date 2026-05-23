/**
 * MODULE: Evidence-based persona profile blocks.
 * Responsibility: Normalize existing memory/profile sources into auditable read-only blocks.
 * Boundary: Does not extract new facts, does not write profile files, does not inject prompts.
 * State: None.
 */
const crypto = require('crypto')
const fsp = require('fs/promises')
const path = require('path')
const { USER_PROFILE_DIR } = require('./constants')

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

function hashPersonaProfileValue(value = '', length = 12) {
  const text = String(value || '').trim()
  if (!text) return ''
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, Math.max(6, Math.min(32, Number(length) || 12)))
}

function sanitizePersonaProfileKey(value = '') {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'unknown'
}

function normalizePersonaProfileText(value = '', maxLength = 500) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.max(20, Math.min(2000, Number(maxLength) || 500)))
}

function normalizePersonaProfileEnum(value, allowed, fallback) {
  const text = String(value || '').trim()
  return allowed.includes(text) ? text : fallback
}

function normalizePersonaProfileNumber(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function normalizePersonaProfileTs(value, fallback = Date.now()) {
  const parsed = Number(value)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  return fallback
}

function normalizePersonaProfileHash(value = '', maxLength = 64) {
  const text = String(value || '').trim().toLowerCase()
  if (!/^[a-f0-9]{6,64}$/.test(text)) return ''
  return text.slice(0, Math.max(6, Math.min(64, Number(maxLength) || 64)))
}

function personaProfileComparableText(value = '') {
  return normalizePersonaProfileText(value, 700).toLowerCase()
}

function buildPersonaProfileEvidence(input = {}) {
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

function buildPersonaProfileBlock(input = {}) {
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
  const result = {
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

function personaProfileEvidenceList(input = [], now = Date.now()) {
  return Array.isArray(input)
    ? input.map(item => buildPersonaProfileEvidence({ ...item, now })).filter(item => item.quoteHash || item.shortQuote)
    : []
}

function personaProfileQuoteHashSet(block = {}) {
  const out = new Set()
  for (const evidence of Array.isArray(block.evidence) ? block.evidence : []) {
    const hash = String(evidence && evidence.quoteHash || '').trim()
    if (hash) out.add(hash)
  }
  return out
}

function findPersonaProfileReinforceReason(existing = {}, incoming = {}) {
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

function mergePersonaProfileEvidence(existingEvidence = [], incomingEvidence = [], maxEvidence = PROFILE_REINFORCE_MAX_EVIDENCE) {
  const limit = Math.max(1, Math.min(20, Math.floor(Number(maxEvidence) || PROFILE_REINFORCE_MAX_EVIDENCE)))
  const merged = []
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

function reinforcePersonaProfileBlock(existing = {}, incoming = {}, options = {}) {
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

function buildPersonaProfileReinforcementShadow(blocks = [], options = {}) {
  const now = normalizePersonaProfileTs(options.now, Date.now())
  const merged = []
  const reasonCounts = { quote_hash: 0, normalized_text: 0 }
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
      if (!result.matched) continue
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

function formatPersonaProfileReinforcementShadowDiagnostic(shadow = {}) {
  const reasonCounts = shadow.reasonCounts || {}
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

function computePersonaProfileEffectiveConfidence(block = {}, options = {}) {
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

function selectPersonaProfileBlocksByEffectiveConfidence(blocks = [], options = {}) {
  const now = normalizePersonaProfileTs(options.now, Date.now())
  const rawLimit = Number(options.limit)
  const limit = Math.max(0, Math.min(50, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : PROFILE_EFFECTIVE_DEFAULT_LIMIT))
  const minEffectiveConfidence = normalizePersonaProfileNumber(options.minEffectiveConfidence, PROFILE_EFFECTIVE_MIN_CONFIDENCE, 0, 1)
  const allowedStatuses = Array.isArray(options.allowedStatuses) && options.allowedStatuses.length
    ? new Set(options.allowedStatuses.map(String))
    : new Set(['active'])
  const includeSensitive = !!options.includeSensitive
  const skipped = { status: 0, expired: 0, sensitive: 0, lowConfidence: 0 }
  const candidates = []
  for (const raw of Array.isArray(blocks) ? blocks : []) {
    const block = buildPersonaProfileBlock({ ...raw, now })
    if (!block) continue
    if (!allowedStatuses.has(block.status)) { skipped.status += 1; continue }
    const expiresAt = Number(block.expiresAt || 0)
    if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now) { skipped.expired += 1; continue }
    if (!includeSensitive && block.sensitivity === 'sensitive') { skipped.sensitive += 1; continue }
    const effectiveConfidence = computePersonaProfileEffectiveConfidence(block, { ...options, now })
    if (effectiveConfidence < minEffectiveConfidence) { skipped.lowConfidence += 1; continue }
    candidates.push({ ...block, effectiveConfidence })
  }
  candidates.sort((a, b) => {
    if (b.effectiveConfidence !== a.effectiveConfidence) return b.effectiveConfidence - a.effectiveConfidence
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

function buildPersonaProfileSelectionDiagnostic(profile = {}, options = {}) {
  const selection = options.selection || selectPersonaProfileBlocksByEffectiveConfidence(profile.blocks || [], options)
  return {
    version: PERSONA_PROFILE_VERSION,
    userHash: profile.user?.idHash || hashPersonaProfileValue(options.userId || '', 12),
    channelHash: profile.channel?.hash || hashPersonaProfileValue(options.channelKey || '', 12),
    total: Array.isArray(profile.blocks) ? profile.blocks.length : 0,
    considered: selection.considered || 0,
    selected: Array.isArray(selection.selected) ? selection.selected.length : 0,
    top: (selection.selected || []).slice(0, 5).map(item => ({
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

function formatPersonaProfileSelectionDiagnostic(diagnostic = {}) {
  const skipped = diagnostic.skipped || {}
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

function buildPersonaProfileReinforceDiagnostic(input = {}) {
  const before = input.before || {}
  const after = input.after || input.block || {}
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

function formatPersonaProfileReinforceDiagnostic(diagnostic = {}) {
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

function buildPersonaProfileBlocksFromLegacyData(data = {}, options = {}) {
  const userId = String(options.userId || data.userId || '')
  const channelKey = String(options.channelKey || '')
  const now = normalizePersonaProfileTs(options.now, Date.now())
  const diagnostics = []
  const blocks = []
  const memory = Array.isArray(data.memory) ? data.memory : []
  const messages = Array.isArray(data.messages) ? data.messages : []
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
      createdAt: item.ts || now,
      updatedAt: item.ts || now,
      now,
      evidence: [{ source: 'legacy_explicit_memory', text, ts: item.ts, channelKey }],
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
        createdAt: item.ts || now,
        updatedAt: item.ts || now,
        expiresAt: now + 7 * 24 * 60 * 60 * 1000,
        now,
        evidence: [{ source: 'recent_user_message', text, ts: item.ts, messageId: item.messageId, channelKey }],
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

function safePersonaProfileFile(userId, channelKey, rootDir = USER_PROFILE_DIR) {
  const safeChannel = sanitizePersonaProfileKey(channelKey)
  const safeUser = sanitizePersonaProfileKey(userId)
  return path.join(rootDir, safeChannel, `${safeUser}.json`)
}

async function readLegacyPersonaProfileData({ userId, channelKey, rootDir = USER_PROFILE_DIR } = {}) {
  try {
    const file = safePersonaProfileFile(userId, channelKey, rootDir)
    const stat = await fsp.stat(file)
    if (!stat.isFile() || stat.size > MAX_PROFILE_SOURCE_FILE_BYTES) return null
    const data = JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, ''))
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

async function buildPersonaProfileBlocks(options = {}) {
  const userId = String(options.userId || '')
  const channelKey = String(options.channelKey || '')
  const data = await readLegacyPersonaProfileData(options) || { userId, names: [], messages: [], memory: [] }
  const profile = buildPersonaProfileBlocksFromLegacyData(data, options)
  if (options.includeAgentMemory) {
    try {
      const items = typeof options.agentMemoryReader === 'function'
        ? await options.agentMemoryReader({ userId, limit: options.agentMemoryLimit || 10 })
        : await require('./agent/memory').listMemory({ userId, limit: options.agentMemoryLimit || 10 })
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
          createdAt: item.createdAt,
          updatedAt: item.updatedAt || item.createdAt,
          now: options.now,
          evidence: [{ source: 'agent_memory', text, ts: item.createdAt, channelKey: item.channelKey || channelKey }],
          maxTextLength: 700,
        })
        if (block) {
          profile.blocks.push(block)
          if (profile.sourceStats) profile.sourceStats.agentMemory += 1
        }
      }
    } catch {
      profile.diagnostics.push({ level: 'warning', code: 'agent_memory_read_failed', source: 'agent_memory' })
    }
  }
  profile.summary = summarizePersonaProfileBlocks(profile)
  return profile
}

function summarizePersonaProfileBlocks(profile = {}) {
  const counts = {}
  const statuses = {}
  for (const item of Array.isArray(profile.blocks) ? profile.blocks : []) {
    counts[item.block] = (counts[item.block] || 0) + 1
    statuses[item.status] = (statuses[item.status] || 0) + 1
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

function buildPersonaProfileSourceDiagnostic(profile = {}, options = {}) {
  const stats = profile.sourceStats || {}
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

function formatPersonaProfileSourceDiagnostic(diagnostic = {}) {
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

function formatPersonaProfileSummary(profile = {}) {
  const summary = profile.summary || summarizePersonaProfileBlocks(profile)
  const blockText = Object.entries(summary.byBlock || {}).map(([key, value]) => `${key}:${value}`).join(',')
  const statusText = Object.entries(summary.byStatus || {}).map(([key, value]) => `${key}:${value}`).join(',')
  return [
    `user=${summary.userHash || 'none'}`,
    `channel=${summary.channelHash || 'none'}`,
    `total=${summary.total || 0}`,
    `blocks=${blockText || 'none'}`,
    `statuses=${statusText || 'none'}`,
    `diagnostics=${summary.diagnostics?.length || 0}`,
  ].join(' ')
}

module.exports = {
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
  safePersonaProfileFile,
  readLegacyPersonaProfileData,
  buildPersonaProfileBlocks,
  summarizePersonaProfileBlocks,
  formatPersonaProfileSummary,
}
