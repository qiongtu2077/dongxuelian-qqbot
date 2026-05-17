/**
 * MODULE: 转发消息解析。
 * 职责: resolveForwardSummary — 提取合并转发中的消息摘要。
 * 边界: 纯函数 + 缓存操作，不调 AI API，不改 conversation 持久层。
 */
const { callGetForwardMsg } = require('./api')
const { summarizeForwardNodes } = require('./message-reader')
const { getChannelKey, lastForwardSummaryCache } = require('./conversation')
const { logDebug } = require('./logging-config')

const FORWARD_ID_RE = /(?:\[CQ:forward,id=([^,\]]+)\])|<forward\s+id="([^"]+)"\/>/
const BLANK_NICK_CHARS_RE = /[\s\u200b-\u200f\u2028-\u202f\ufeff\u3164\uffa0\u115f\u1160-\u11ff]+/g
const DEFAULT_FORWARD_NICKNAME = '群友'
const NESTED_FORWARD_UNAVAILABLE = '这个转发链接太深啦，我看不到里面是什么'

function getLogger(ctx) {
  return ctx && typeof ctx.logger === 'function' ? ctx.logger('dongxuelian-ai') : null
}

function extractForwardId(content) {
  const match = String(content || '').match(FORWARD_ID_RE)
  return match ? (match[1] || match[2]) : null
}

function normalizeForwardMessages(data) {
  if (Array.isArray(data)) return data
  if (data && Array.isArray(data.messages)) return data.messages
  return null
}

function getForwardLength(data) {
  if (Array.isArray(data)) return data.length
  if (data && Array.isArray(data.messages)) return data.messages.length
  return '?'
}

function normalizeNickname(sender = {}) {
  return (sender.card || sender.nickname || '').replace(BLANK_NICK_CHARS_RE, '').trim() || DEFAULT_FORWARD_NICKNAME
}

function messageSegmentToText(segment) {
  if (segment.type === 'text') return segment.data && segment.data.text || ''
  if (segment.type === 'face') return '【表情】'
  if (segment.type === 'at') return '@' + (segment.data && (segment.data.name || segment.data.qq || ''))
  if (segment.type === 'image') return '【图片】'
  return '【消息】'
}

function messageSegmentsToText(segments) {
  if (!Array.isArray(segments)) return ''
  return segments.map(messageSegmentToText).filter(Boolean).join('')
}

function findNestedForwardSegment(segments) {
  if (!Array.isArray(segments)) return null
  return segments.find(segment => segment.type === 'forward' || segment.type === 'node') || null
}

function getNestedForwardId(segment) {
  const data = segment && segment.data
  return data && (data.id || data['forward-id'] || data.res_id) || ''
}

function makeSummaryNode(nickname, text) {
  if (!text) return null
  return { type: 'node', data: { nickname, content: [{ type: 'text', data: { text } }] } }
}

function summarizeNodes(nodes) {
  return summarizeForwardNodes(nodes, 0, function(x) { return x })
}

async function normalizeForwardNodes(nodes, getForwardMsg, ctx) {
  const result = await Promise.all(nodes.map(function(node) {
    return normalizeForwardNode(node, getForwardMsg, ctx)
  }))
  return result.filter(Boolean)
}

async function summarizeNestedForward(nestedId, getForwardMsg, ctx, logLabel) {
  if (!nestedId) return ''
  const nestedData = await getForwardMsg(nestedId)
  const logger = getLogger(ctx)
  if (logLabel && logger) {
    logger.info(logLabel + ': id=' + nestedId + ' result=' + (nestedData ? 'ok' : 'null'))
  }
  const nestedArr = normalizeForwardMessages(nestedData)
  if (!nestedArr) return ''
  const nestedNodes = await normalizeForwardNodes(nestedArr, getForwardMsg, ctx)
  return summarizeNodes(nestedNodes)
}

async function resolveRawNestedForward(rawMessage, getForwardMsg, ctx) {
  const match = rawMessage.match(/\[CQ:forward,id=(\d+)/)
  if (!match) return null
  let text = await summarizeNestedForward(match[1], getForwardMsg, ctx, 'cq inner')
  if (!text || text.indexOf('[CQ:forward') >= 0) text = NESTED_FORWARD_UNAVAILABLE
  return text
}

async function resolveStructuredMessageText(segments, getForwardMsg, ctx) {
  const nestedSegment = findNestedForwardSegment(segments)
  if (!nestedSegment) return messageSegmentsToText(segments)

  const nestedId = getNestedForwardId(nestedSegment)
  let text = await summarizeNestedForward(nestedId, getForwardMsg, ctx)
  if (!text || text.indexOf('[CQ:forward') >= 0) text = NESTED_FORWARD_UNAVAILABLE
  return text
}

async function normalizeForwardNode(node, getForwardMsg, ctx) {
  if (node.type === 'node' && node.data) return node

  const nickname = normalizeNickname(node.sender || {})
  let messageText = node.raw_message || ''
  const rawNestedText = messageText ? await resolveRawNestedForward(messageText, getForwardMsg, ctx) : null

  if (rawNestedText !== null) {
    messageText = rawNestedText
  } else if (node.message && Array.isArray(node.message)) {
    messageText = await resolveStructuredMessageText(node.message, getForwardMsg, ctx)
  }

  return makeSummaryNode(nickname, messageText)
}

async function resolveForwardSummary(session, content, ctx, options = {}) {
  const getForwardMsg = options.callGetForwardMsg || callGetForwardMsg
  const forwardId = extractForwardId(content)
  if (!forwardId) return ''

  const forwardData = await getForwardMsg(forwardId)
  logDebug(ctx, 'forward', 'fetch result=' + (forwardData ? 'ok' : 'null') + ' len=' + getForwardLength(forwardData))
  const forwardMessages = normalizeForwardMessages(forwardData)
  if (!forwardMessages || forwardMessages.length === 0) return ''

  const nodes = await normalizeForwardNodes(forwardMessages, getForwardMsg, ctx)
  if (nodes.length === 0) return ''
  const forwardSummaryText = summarizeNodes(nodes)
  logDebug(ctx, 'forward', 'summary len=' + (forwardSummaryText ? forwardSummaryText.length : 0))
  if (forwardSummaryText) lastForwardSummaryCache.set(getChannelKey(session), forwardSummaryText)
  return forwardSummaryText
}

module.exports = {
  resolveForwardSummary,
}
