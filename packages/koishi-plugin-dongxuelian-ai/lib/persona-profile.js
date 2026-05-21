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

function buildPersonaProfileEvidence(input = {}) {
  const now = normalizePersonaProfileTs(input.now, Date.now())
  const shortQuote = normalizePersonaProfileText(input.text || input.shortQuote || '', 120)
  const ts = normalizePersonaProfileTs(input.ts || input.createdAt || input.updatedAt, now)
  return {
    source: normalizePersonaProfileText(input.source || 'unknown', 40) || 'unknown',
    ts,
    quoteHash: hashPersonaProfileValue(shortQuote || input.text || ''),
    shortQuote,
    messageIdHash: hashPersonaProfileValue(input.messageId || '', 10),
    channelHash: hashPersonaProfileValue(input.channelKey || '', 10),
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
  }
  const expiresAt = Number(input.expiresAt || 0)
  if (Number.isFinite(expiresAt) && expiresAt > 0) result.expiresAt = expiresAt
  return result
}

function buildPersonaProfileBlocksFromLegacyData(data = {}, options = {}) {
  const userId = String(options.userId || data.userId || '')
  const channelKey = String(options.channelKey || '')
  const now = normalizePersonaProfileTs(options.now, Date.now())
  const diagnostics = []
  const blocks = []
  const memory = Array.isArray(data.memory) ? data.memory : []
  const messages = Array.isArray(data.messages) ? data.messages : []
  for (const item of memory) {
    const text = normalizePersonaProfileText(item && item.text || '', 500)
    if (!text) continue
    const confirmCount = Math.max(0, Number(item.confirmCount || 0))
    if (confirmCount <= 0) {
      diagnostics.push({ level: 'info', code: 'legacy_memory_unconfirmed', source: 'legacy_explicit_memory' })
      continue
    }
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
    for (const item of messages.slice(-maxRecent)) {
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
      if (block) blocks.push(block)
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
        if (block) profile.blocks.push(block)
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
  buildPersonaProfileBlocksFromLegacyData,
  safePersonaProfileFile,
  readLegacyPersonaProfileData,
  buildPersonaProfileBlocks,
  summarizePersonaProfileBlocks,
  formatPersonaProfileSummary,
}
