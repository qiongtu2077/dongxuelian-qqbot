/**
 * MODULE: 转发消息解析。
 * 职责: resolveForwardSummary — 提取合并转发中的消息摘要。
 * 边界: 纯函数 + 缓存操作，不调 AI API，不改 conversation 持久层。
 */
const { callGetForwardMsg } = require('../core/api') as typeof import('../core/api')
const { summarizeForwardNodes } = require('./message-reader') as typeof import('./message-reader')
const { getChannelKey, setLastForwardSummaryCache } = require('../conversation') as typeof import('../conversation')
const { logDebug } = require('../core/logging-config') as typeof import('../core/logging-config')

const FORWARD_ID_RE = /(?:\[CQ:forward,id=([^,\]]+)\])|<forward\s+id="([^"]+)"\/>/
const BLANK_NICK_CHARS_RE = /[\s\u200b-\u200f\u2028-\u202f\ufeff\u3164\uffa0\u115f\u1160-\u11ff]+/g
const DEFAULT_FORWARD_NICKNAME = '群友'
const NESTED_FORWARD_UNAVAILABLE = '这个转发链接太深啦，我看不到里面是什么'

interface ForwardLogger {
  info?: (message: string) => void
}

interface ForwardContext {
  logger?: (name: string) => ForwardLogger
}

interface ForwardSession {
  guildId?: string
  channelId?: string
  isDirect?: boolean
  userId?: string
  username?: string
  messageId?: string
  selfId?: string
  author?: { id?: string }
  bot?: { selfId?: string }
}

interface ForwardSegment {
  type?: string
  data?: Record<string, unknown>
  sender?: Record<string, unknown>
  raw_message?: string
  message?: unknown[]
}

interface ForwardNode {
  type: 'node'
  data: {
    nickname: string
    content: Array<{ type: 'text'; data: { text: string } }>
    [key: string]: unknown
  }
}

interface ResolveForwardOptions {
  callGetForwardMsg?: ForwardGetter
}

type ForwardGetter = (forwardId: string) => Promise<unknown[] | unknown | null>

function isForwardObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

function asForwardSegment(value: unknown): ForwardSegment {
  return isForwardObject(value) ? value as ForwardSegment : {}
}

function getLogger(ctx: ForwardContext | null | undefined): ForwardLogger | null {
  return ctx && typeof ctx.logger === 'function' ? ctx.logger('dongxuelian-ai') : null
}

function extractForwardId(content: unknown): string | null {
  const match = String(content || '').match(FORWARD_ID_RE)
  return match ? (match[1] || match[2]) : null
}

function normalizeForwardMessages(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data
  if (isForwardObject(data) && Array.isArray(data.messages)) return data.messages
  return null
}

function getForwardLength(data: unknown): number | string {
  if (Array.isArray(data)) return data.length
  if (isForwardObject(data) && Array.isArray(data.messages)) return data.messages.length
  return '?'
}

function normalizeNickname(sender: Record<string, unknown> = {}): string {
  return String(sender.card || sender.nickname || '').replace(BLANK_NICK_CHARS_RE, '').trim() || DEFAULT_FORWARD_NICKNAME
}

function messageSegmentToText(segment: ForwardSegment): string {
  if (segment.type === 'text') return segment.data && String(segment.data.text || '') || ''
  if (segment.type === 'face') return '【表情】'
  if (segment.type === 'at') return '@' + (segment.data && (segment.data.name || segment.data.qq || '') || '')
  if (segment.type === 'image') return '【图片】'
  return '【消息】'
}

function messageSegmentsToText(segments: unknown): string {
  if (!Array.isArray(segments)) return ''
  return segments.map(item => messageSegmentToText(asForwardSegment(item))).filter(Boolean).join('')
}

function findNestedForwardSegment(segments: unknown): ForwardSegment | null {
  if (!Array.isArray(segments)) return null
  const found = segments.find(segment => {
    const item = asForwardSegment(segment)
    return item.type === 'forward' || item.type === 'node'
  })
  return found ? asForwardSegment(found) : null
}

function getNestedForwardId(segment: ForwardSegment | null): string {
  const data = segment && segment.data
  return data && String(data.id || data['forward-id'] || data.res_id || '') || ''
}

function makeSummaryNode(nickname: string, text: string): ForwardNode | null {
  if (!text) return null
  return { type: 'node', data: { nickname, content: [{ type: 'text', data: { text } }] } }
}

function summarizeNodes(nodes: unknown[]): string {
  return summarizeForwardNodes(nodes, 0, function(x: string): string { return x })
}

async function normalizeForwardNodes(nodes: unknown[], getForwardMsg: ForwardGetter, ctx: ForwardContext | null | undefined): Promise<ForwardNode[]> {
  const result = await Promise.all(nodes.map(function(node) {
    return normalizeForwardNode(node, getForwardMsg, ctx)
  }))
  const filtered: ForwardNode[] = []
  for (const item of result) {
    if (item) filtered.push(item)
  }
  return filtered
}

async function summarizeNestedForward(nestedId: string, getForwardMsg: ForwardGetter, ctx: ForwardContext | null | undefined, logLabel?: string): Promise<string> {
  if (!nestedId) return ''
  const nestedData = await getForwardMsg(nestedId)
  const logger = getLogger(ctx)
  if (logLabel && logger) {
    logger.info?.(logLabel + ': id=' + nestedId + ' result=' + (nestedData ? 'ok' : 'null'))
  }
  const nestedArr = normalizeForwardMessages(nestedData)
  if (!nestedArr) return ''
  const nestedNodes = await normalizeForwardNodes(nestedArr, getForwardMsg, ctx)
  return summarizeNodes(nestedNodes)
}

async function resolveRawNestedForward(rawMessage: string, getForwardMsg: ForwardGetter, ctx: ForwardContext | null | undefined): Promise<string | null> {
  const match = rawMessage.match(/\[CQ:forward,id=(\d+)/)
  if (!match) return null
  let text = await summarizeNestedForward(match[1], getForwardMsg, ctx, 'cq inner')
  if (!text || text.indexOf('[CQ:forward') >= 0) text = NESTED_FORWARD_UNAVAILABLE
  return text
}

async function resolveStructuredMessageText(segments: unknown, getForwardMsg: ForwardGetter, ctx: ForwardContext | null | undefined): Promise<string> {
  const nestedSegment = findNestedForwardSegment(segments)
  if (!nestedSegment) return messageSegmentsToText(segments)

  const nestedId = getNestedForwardId(nestedSegment)
  let text = await summarizeNestedForward(nestedId, getForwardMsg, ctx)
  if (!text || text.indexOf('[CQ:forward') >= 0) text = NESTED_FORWARD_UNAVAILABLE
  return text
}

async function normalizeForwardNode(node: unknown, getForwardMsg: ForwardGetter, ctx: ForwardContext | null | undefined): Promise<ForwardNode | null> {
  const item = asForwardSegment(node)
  if (item.type === 'node' && item.data) return item as ForwardNode

  const nickname = normalizeNickname(item.sender || {})
  let messageText = item.raw_message || ''
  const rawNestedText = messageText ? await resolveRawNestedForward(messageText, getForwardMsg, ctx) : null

  if (rawNestedText !== null) {
    messageText = rawNestedText
  } else if (Array.isArray(item.message)) {
    messageText = await resolveStructuredMessageText(item.message, getForwardMsg, ctx)
  }

  return makeSummaryNode(nickname, messageText)
}

async function resolveForwardSummary(session: ForwardSession, content: unknown, ctx: ForwardContext | null | undefined, options: ResolveForwardOptions = {}): Promise<string> {
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
  if (forwardSummaryText) setLastForwardSummaryCache(getChannelKey(session), forwardSummaryText)
  return forwardSummaryText
}

export = {
  resolveForwardSummary,
}
