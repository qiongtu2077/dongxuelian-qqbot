/**
 * MODULE: 复读检测。
 * 状态: channelRepeatState（按 channelKey 索引）。
 * 边界: 不调 AI API，不改 conversation，只存当前复读组指纹。
 */
const fs = require('fs')
const { REPEAT_ENABLED_FILE } = require('../core/constants') as typeof import('../core/constants')
const { atomicWriteJson } = require('../persona/persona') as typeof import('../persona/persona')
const { normalizeText, getSegmentData, getSessionMessageSegments } = require('../core/utils') as typeof import('../core/utils')

const REPEAT_MATCH_WINDOW_MS = 120000
const MAX_REPEAT_CONFIG_BYTES = 128 * 1024
const MAX_REPEAT_STATE_SIZE = 5000
interface SegmentLike {
  type?: string
  data?: Record<string, unknown>
  attrs?: Record<string, unknown>
  attributes?: Record<string, unknown>
}

interface RepeatSession {
  isDirect?: boolean
  content?: string
  event?: {
    message?: unknown[] | { elements?: unknown[]; content?: unknown[] }
  }
}

interface RepeatCandidate {
  key: string
  reply: string
  kind: string
  supported: boolean
  reason?: string
}

interface RepeatAnalysis {
  hasFile?: boolean
  hasEmbed?: boolean
  hasMessageRecordCue?: boolean
  hasVisual?: boolean
}

interface RepeatState {
  key: string
  reply: string
  kind: string
  userId: string
  ts: number
  fired: boolean
}

const channelRepeatState: Map<string, RepeatState> = new Map()
let repeatEnabledCache: Record<string, boolean> = {}

function loadRepeatConfig(): void {
  try {
    const stat = fs.statSync(REPEAT_ENABLED_FILE)
    if (!stat.isFile() || stat.size > MAX_REPEAT_CONFIG_BYTES) throw new Error('repeat config too large')
    repeatEnabledCache = JSON.parse(fs.readFileSync(REPEAT_ENABLED_FILE, 'utf8'))
  } catch { /* non-critical: missing repeat config disables repeat until configured */
    repeatEnabledCache = {}
  }
}

function getRepeatEnabledCache(): Record<string, boolean> {
  return repeatEnabledCache
}

function clearRepeatState(channelKey: string): void {
  const key = String(channelKey)
  channelRepeatState.delete(key)
}

function pruneRepeatState(now: number = Date.now()): void {
  for (const [key, state] of channelRepeatState) {
    if (!state || now - (state.ts || 0) > REPEAT_MATCH_WINDOW_MS) channelRepeatState.delete(key)
  }
  if (channelRepeatState.size <= MAX_REPEAT_STATE_SIZE) return
  const ordered = Array.from(channelRepeatState.entries())
    .sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0))
  const overflow = channelRepeatState.size - MAX_REPEAT_STATE_SIZE
  for (let i = 0; i < overflow; i++) channelRepeatState.delete(ordered[i][0])
}

function getRepeatStateSize(): number {
  return channelRepeatState.size
}

function setRepeatEnabled(channelKey: string, enabled: boolean): void {
  const key = String(channelKey)
  repeatEnabledCache[key] = enabled
  clearRepeatState(key)
  atomicWriteJson(REPEAT_ENABLED_FILE, repeatEnabledCache)
}

function extractStructuredFaceIds(session: RepeatSession): string[] | null {
  const segments = getSessionMessageSegments(session) as SegmentLike[]
  if (!segments.length) return null

  const ids = []
  for (const segment of segments) {
    const type = String(segment?.type || '').toLowerCase()
    const data = getSegmentData(segment)

    if (type === 'text') {
      const dataRecord = data as Record<string, unknown>
      const text = dataRecord.text ?? dataRecord.content ?? ''
      if (!normalizeText(String(text))) continue
      return null
    }

    // @ 段不属于复读内容。主流程已过滤 @bot 和提及他人的消息。
    if (type === 'at') continue

    if (type === 'face') {
      const dataRecord = data as Record<string, unknown>
      const id = String(dataRecord.id ?? dataRecord.qq ?? dataRecord.face_id ?? dataRecord.faceId ?? '').trim()
      if (!/^\d+$/.test(id)) return null
      ids.push(id)
      continue
    }

    return null
  }

  return ids.length ? ids : null
}

function extractContentFaceIds(content: string = ''): string[] | null {
  const value = String(content || '')
  if (!value.trim()) return null

  const ids = []
  const tokenRe = /(\[CQ:face,[^\]]*?\bid=(\d+)[^\]]*\])|(<face\b[^>]*?\bid="(\d+)"[^>]*\/?>)/gi
  const remainder = value.replace(tokenRe, (_token, cqToken, cqId, htmlToken, htmlId) => {
    ids.push(cqId || htmlId)
    return ''
  })

  return ids.length && !remainder.trim() ? ids : null
}

function buildFaceRepeatCandidate(faceIds: string[]): RepeatCandidate {
  const ids = faceIds.map(id => String(id))
  return {
    key: ids.map(id => `face:${id}`).join('|'),
    reply: ids.map(id => `<face id="${id}"/>`).join(''),
    kind: 'face',
    supported: true,
  }
}

function buildUnsupportedRepeatCandidate(reason: string): RepeatCandidate {
  return {
    key: '',
    reply: '',
    kind: 'unsupported',
    supported: false,
    reason,
  }
}

function buildRepeatCandidate(session: RepeatSession, plain: string, analyzed: RepeatAnalysis = {}): RepeatCandidate {
  const structuredFaceIds = extractStructuredFaceIds(session)
  if (structuredFaceIds) return buildFaceRepeatCandidate(structuredFaceIds)

  const contentFaceIds = extractContentFaceIds(session?.content || '')
  if (contentFaceIds) return buildFaceRepeatCandidate(contentFaceIds)

  if (analyzed.hasFile) return buildUnsupportedRepeatCandidate('file')
  if (analyzed.hasEmbed || analyzed.hasMessageRecordCue) return buildUnsupportedRepeatCandidate('embed')
  if (analyzed.hasVisual) return buildUnsupportedRepeatCandidate('visual')

  const text = normalizeText(String(plain || '')).trim()
  if (!text) return buildUnsupportedRepeatCandidate('empty')

  return {
    key: `text:${text}`,
    reply: text,
    kind: 'text',
    supported: true,
  }
}

function checkGroupRepeat(session: RepeatSession, candidate: RepeatCandidate | null | undefined, channelKey: string, currentUserId: string, now: number = Date.now()): RepeatCandidate | null {
  if (session.isDirect) return null
  if (!repeatEnabledCache[channelKey]) return null
  pruneRepeatState(now)
  if (!candidate || !candidate.supported || !candidate.key || !candidate.reply) {
    channelRepeatState.delete(channelKey)
    return null
  }

  const last = channelRepeatState.get(channelKey)
  const startsNewGroup = !last || last.key !== candidate.key || now - last.ts > REPEAT_MATCH_WINDOW_MS

  if (startsNewGroup) {
    channelRepeatState.set(channelKey, {
      key: candidate.key,
      reply: candidate.reply,
      kind: candidate.kind,
      userId: currentUserId,
      ts: now,
      fired: false,
    })
    return null
  }

  const nextState = {
    key: candidate.key,
    reply: candidate.reply,
    kind: candidate.kind,
    userId: currentUserId,
    ts: now,
    fired: !!last.fired,
  }

  if (
    !last.fired &&
    last.userId !== currentUserId &&
    now - last.ts <= REPEAT_MATCH_WINDOW_MS
  ) {
    nextState.fired = true
    channelRepeatState.set(channelKey, nextState)
    return candidate
  }

  channelRepeatState.set(channelKey, nextState)
  return null
}

export = {
  loadRepeatConfig,
  setRepeatEnabled,
  getRepeatEnabledCache,
  clearRepeatState,
  pruneRepeatState,
  getRepeatStateSize,
  buildRepeatCandidate,
  checkGroupRepeat,
}
