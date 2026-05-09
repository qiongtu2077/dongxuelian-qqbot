/**
 * MODULE: 复读检测。
 * 状态: channelRepeatState（按 channelKey 索引）。
 * 边界: 不调 AI API，不改 conversation，只存当前复读组指纹。
 */
const fs = require('fs')
const { REPEAT_ENABLED_FILE } = require('./constants')
const { atomicWriteJson } = require('./persona')
const { normalizeText } = require('./message-reader')
const { getSegmentData, getSessionMessageSegments } = require('./utils')

const REPEAT_MATCH_WINDOW_MS = 120000
const channelRepeatState = new Map()
let repeatEnabledCache = {}

function loadRepeatConfig() {
  try {
    repeatEnabledCache = JSON.parse(fs.readFileSync(REPEAT_ENABLED_FILE, 'utf8'))
  } catch {
    repeatEnabledCache = {}
  }
}

function getRepeatEnabledCache() {
  return repeatEnabledCache
}

function clearRepeatState(channelKey) {
  const key = String(channelKey)
  channelRepeatState.delete(key)
}

function setRepeatEnabled(channelKey, enabled) {
  const key = String(channelKey)
  repeatEnabledCache[key] = enabled
  clearRepeatState(key)
  atomicWriteJson(REPEAT_ENABLED_FILE, repeatEnabledCache)
}

function extractStructuredFaceIds(session) {
  const segments = getSessionMessageSegments(session)
  if (!segments.length) return null

  const ids = []
  for (const segment of segments) {
    const type = String(segment?.type || '').toLowerCase()
    const data = getSegmentData(segment)

    if (type === 'text') {
      const text = data.text ?? data.content ?? ''
      if (!normalizeText(String(text))) continue
      return null
    }

    // @ 段不属于复读内容。主流程已过滤 @bot 和提及他人的消息。
    if (type === 'at') continue

    if (type === 'face') {
      const id = String(data.id ?? data.qq ?? data.face_id ?? data.faceId ?? '').trim()
      if (!/^\d+$/.test(id)) return null
      ids.push(id)
      continue
    }

    return null
  }

  return ids.length ? ids : null
}

function extractContentFaceIds(content = '') {
  const value = String(content || '')
  if (!value.trim()) return null

  const ids = []
  const tokenRe = /(\[CQ:face,[^\]]*?\bid=(\d+)[^\]]*\])|(<face\b[^>]*?\bid="(\d+)"[^>]*\/?>)/gi
  const remainder = value.replace(tokenRe, (_, cqToken, cqId, htmlToken, htmlId) => {
    ids.push(cqId || htmlId)
    return ''
  })

  return ids.length && !remainder.trim() ? ids : null
}

function buildFaceRepeatCandidate(faceIds) {
  const ids = faceIds.map(id => String(id))
  return {
    key: ids.map(id => `face:${id}`).join('|'),
    reply: ids.map(id => `<face id="${id}"/>`).join(''),
    kind: 'face',
    supported: true,
  }
}

function buildUnsupportedRepeatCandidate(reason) {
  return {
    key: '',
    reply: '',
    kind: 'unsupported',
    supported: false,
    reason,
  }
}

function buildRepeatCandidate(session, plain, analyzed = {}) {
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

function checkGroupRepeat(session, candidate, channelKey, currentUserId, now = Date.now()) {
  if (session.isDirect) return null
  if (!repeatEnabledCache[channelKey]) return null
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

module.exports = {
  loadRepeatConfig,
  setRepeatEnabled,
  getRepeatEnabledCache,
  buildRepeatCandidate,
  checkGroupRepeat,
}
