/* ==========================================================================
 * MODULE: 定位消息命令。
 * 职责：按「谁艾特我」编号快照解析目标消息，能引用时发原生引用，不能引用或无法核验时给缓存上下文卡片。
 * 边界：只读调用方传入的 today-cache，不读写缓存文件、不调 AI、不改 conversation、不发私聊。
 * 状态：无模块级状态；编号快照在 lifecycle/locate-snapshot。
 * ========================================================================== */
const { getLocateSnapshot } = require('../lifecycle/locate-snapshot') as typeof import('../lifecycle/locate-snapshot')
const { handled } = require('./command-result') as typeof import('./command-result')

const LOCATE_CONTEXT_WINDOW = 10
const LOCATE_CONTEXT_MAX_CHARS = 120
const LOCATE_READ_TIMEOUT_MS = 3000
const LOCATE_VERIFY_TIMEOUT_MS = 3000
const LOCATE_QUOTE_TEXT = '找到啦！'
const DEFAULT_NODE_UIN = '10000'

// 四句降级文案不得混用，便于从用户反馈直接定位失败类型。
const LOCATE_TEXT_PRECHECK_FAILED = '原消息暂时无法引用（可能超出可引用范围），以下是缓存上下文：'
const LOCATE_TEXT_SNAPSHOT_MISSING = '请先发『谁艾特我』再按编号定位'
const LOCATE_TEXT_VERIFY_TIMEOUT = '引用结果核验超时，未能确认是否引用成功，以下是上下文：'
const LOCATE_TEXT_VERIFY_MISSING = '未能查到该消息的引用结果，以下是上下文：'
const LOCATE_TEXT_CARD_FAILED = '兜底上下文发送失败'

interface LocateLogger {
  warn: (message: string) => void
  info?: (message: string) => void
}

interface LocateContext {
  logger: (name: string) => LocateLogger
}

interface LocateMessage {
  time?: string
  ts?: number
  user?: string
  content?: string
  userId?: string
  messageId?: string
  realSeq?: string
  groupId?: string
  botId?: string
  mentionUserIds?: string[]
}

interface LocateTodayCache {
  date?: string
  messages?: LocateMessage[]
}

interface LocateInternalLike {
  getMsg?: (messageId: string | number) => Promise<unknown> | unknown
  sendGroupMsg?: (groupId: string | number, message: unknown) => Promise<unknown> | unknown
  sendGroupForwardMsg?: (groupId: string | number, messages: unknown) => Promise<unknown> | unknown
}

interface LocateSessionLike {
  selfId?: string
  send: (content: unknown) => unknown | Promise<unknown>
  bot?: {
    selfId?: string
    internal?: LocateInternalLike
  }
}

interface LocateCommandInput {
  session: LocateSessionLike
  ctx: LocateContext
  channelKey: string
  currentUserId: string
  cache: LocateTodayCache
  index: number
}

interface LocateSnapshotEntry {
  ts: number
  messageId: string
}

interface LocateContextEntry {
  target: boolean
  user: string
  time: string
  content: string
  uin: string
}

interface LocateForwardNode {
  type: 'node'
  data: { name: string; uin: string; content: string }
}

type LocateCallOutcome<T> = { ok: true; value: T } | { ok: false; reason: 'timeout' | 'error' }

interface LocateQuoteTarget {
  id?: string
  seq?: number
}

/** 统一给传输调用加有界超时，区分「超时」与「调用报错」，两者文案不同。 */
async function callWithTimeout<T>(task: () => Promise<T> | T, timeoutMs: number): Promise<LocateCallOutcome<T>> {
  const holder: { timer: NodeJS.Timeout | null } = { timer: null }
  try {
    const timeout = new Promise<LocateCallOutcome<T>>((resolve) => {
      holder.timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), timeoutMs)
    })
    const run = Promise.resolve().then(task).then(
      (value): LocateCallOutcome<T> => ({ ok: true, value }),
      (): LocateCallOutcome<T> => ({ ok: false, reason: 'error' }),
    )
    return await Promise.race([run, timeout])
  } finally {
    if (holder.timer) clearTimeout(holder.timer)
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/**
 * 从 OneBot 发送结果里取消息 ID。
 * 适配器的 bot.internal.sendXxx 直接返回 message_id，会话 send 返回消息 ID 数组，两种形态都要认。
 */
function extractSentMessageId(result: unknown): string {
  if (typeof result === 'string' || typeof result === 'number') {
    const direct = String(result).trim()
    return direct && direct !== '[object Object]' ? direct : ''
  }
  if (Array.isArray(result)) {
    for (const item of result) {
      const id = extractSentMessageId(item)
      if (id) return id
    }
    return ''
  }
  const record = toRecord(result)
  if (!record) return ''
  const id = record.message_id ?? record.messageId
  return id === undefined || id === null ? '' : String(id).trim()
}

/** 从读回的消息里取出引用段指向的短 ID；段数组、CQ 字符串、单段对象三种形态都要认。 */
function extractReplyTargetId(message: unknown): string {
  if (typeof message === 'string') {
    const match = message.match(/\[CQ:reply,[^\]]*\bid=([^,\]]+)/)
    return match ? match[1].trim() : ''
  }
  if (Array.isArray(message)) {
    for (const segment of message) {
      const id = extractReplyTargetId(segment)
      if (id) return id
    }
    return ''
  }
  const record = toRecord(message)
  if (!record) return ''
  if (String(record.type || '') !== 'reply') return ''
  const data = toRecord(record.data) || {}
  const id = data.id ?? data.message_id
  return id === undefined || id === null ? '' : String(id).trim()
}

/** 真实序号必须是正整数；字符串与非数字一律视为不可用。 */
function normalizeRealSeq(value: unknown): number {
  const raw = String(value ?? '').trim()
  if (!/^\d+$/.test(raw)) return 0
  const seq = Number(raw)
  return Number.isSafeInteger(seq) && seq > 0 ? seq : 0
}

function formatLocateEntry(line: LocateMessage, target: boolean): LocateContextEntry {
  const content = String(line.content || '').replace(/\s+/g, ' ').trim().slice(0, LOCATE_CONTEXT_MAX_CHARS) || '(空)'
  return {
    target,
    user: String(line.user || '群友'),
    time: line.time ? String(line.time).slice(0, 5) : '',
    content,
    uin: String(line.userId || DEFAULT_NODE_UIN),
  }
}

/** 取目标消息在缓存中的前后各 10 条（最多 21 条），触边界时按实际条数给。 */
function collectLocateContextEntries(cache: LocateTodayCache, cacheIdx: number): LocateContextEntry[] {
  const messages = Array.isArray(cache.messages) ? cache.messages : []
  const start = Math.max(0, cacheIdx - LOCATE_CONTEXT_WINDOW)
  const end = Math.min(messages.length, cacheIdx + LOCATE_CONTEXT_WINDOW + 1)
  const entries: LocateContextEntry[] = []
  for (let i = start; i < end; i += 1) entries.push(formatLocateEntry(messages[i] || {}, i === cacheIdx))
  return entries
}

/** 合并转发卡片节点；目标那条以「→ 」前缀标出，内容保留【图片】等标记，避免纯媒体消息变成空白行。 */
function buildLocateContextNodes(cache: LocateTodayCache, cacheIdx: number, botId: string): LocateForwardNode[] {
  const entries = collectLocateContextEntries(cache, cacheIdx)
  const nodes: LocateForwardNode[] = [{
    type: 'node',
    data: { name: '东雪莲pro', uin: botId, content: `消息上下文（共${entries.length}条，→ 为目标消息）` },
  }]
  for (const entry of entries) {
    nodes.push({ type: 'node', data: { name: `${entry.target ? '→ ' : ''}${entry.user} ${entry.time}`, uin: entry.uin, content: entry.content } })
  }
  return nodes
}

/** 目标那一条消息的单条兜底文本（注明时间与发送者）。 */
function buildLocateTargetLine(cache: LocateTodayCache, cacheIdx: number): string {
  const messages = Array.isArray(cache.messages) ? cache.messages : []
  const entry = formatLocateEntry(messages[cacheIdx] || {}, true)
  return `→ ${entry.user} ${entry.time}：${entry.content}`
}

/** 编号快照按「时间戳 + 短 ID」定位缓存条目，避免按编号实时重算导致漂移。 */
function findCacheIndexOfSnapshotEntry(cache: LocateTodayCache, entry: LocateSnapshotEntry): number {
  const messages = Array.isArray(cache.messages) ? cache.messages : []
  if (entry.messageId) {
    const byId = messages.findIndex(m => String(m.messageId || '') === entry.messageId && (!entry.ts || m.ts === entry.ts))
    if (byId >= 0) return byId
  }
  if (entry.ts) return messages.findIndex(m => m.ts === entry.ts)
  return -1
}

/**
 * 传输层：预检读取、引用发送、核验读回、卡片发送都走 session.bot.internal。
 * 测试可直接用假 session.bot.internal 注入；没有 OneBot 内部通道时返回 null，由调用方降级。
 */
function createLocateTransport(session: LocateSessionLike) {
  const internal = session?.bot?.internal
  if (!internal) return null
  const { getMsg, sendGroupMsg, sendGroupForwardMsg } = internal
  if (typeof getMsg !== 'function' || typeof sendGroupMsg !== 'function') return null
  return {
    readMessage(messageId: string, timeoutMs: number): Promise<LocateCallOutcome<Record<string, unknown>>> {
      return callWithTimeout(async () => {
        const data = toRecord(await getMsg(messageId))
        if (!data) throw new Error('locate get_msg returned no data')
        return data
      }, timeoutMs)
    },
    sendQuote(groupId: string, target: LocateQuoteTarget, timeoutMs: number): Promise<LocateCallOutcome<Record<string, unknown>>> {
      return callWithTimeout(async () => {
        const segments = [{ type: 'reply', data: { ...target } }, { type: 'text', data: { text: LOCATE_QUOTE_TEXT } }]
        const result = await sendGroupMsg(groupId, segments)
        return { messageId: extractSentMessageId(result), raw: result }
      }, timeoutMs)
    },
    sendForwardCard(groupId: string, nodes: LocateForwardNode[], timeoutMs: number): Promise<LocateCallOutcome<string>> {
      if (typeof sendGroupForwardMsg !== 'function') return Promise.resolve({ ok: false, reason: 'error' })
      return callWithTimeout(async () => extractSentMessageId(await sendGroupForwardMsg(groupId, nodes)), timeoutMs)
    },
  }
}

function logLocate(check: LocateContext, level: 'info' | 'warn', message: string): void {
  try {
    const logger = check.logger('dongxuelian-ai')
    if (level === 'info' && typeof logger.info === 'function') logger.info(message)
    else logger.warn(message)
  } catch { /* non-critical: 诊断日志失败不影响命令结果 */ }
}

async function handleLocateCommand(input: LocateCommandInput): Promise<ReturnType<typeof handled>> {
  const { session, ctx, channelKey, currentUserId, cache, index } = input
  const messages = Array.isArray(cache.messages) ? cache.messages : []
  const botId = String(session.selfId || session.bot?.selfId || '') || DEFAULT_NODE_UIN
  const context = `group=${channelKey} user=${currentUserId} index=${index}`

  interface DegradeTarget { cacheIdx: number; reasonText: string; reason: string }
  const finishWithContext = async ({ cacheIdx, reasonText, reason }: DegradeTarget): Promise<ReturnType<typeof handled>> => {
    logLocate(ctx, 'warn', `locate degraded: ${context} targetCacheIdx=${cacheIdx} reason=${reason}`)
    try { await session.send(reasonText) } catch { /* non-critical: 文案发送失败仍继续尝试卡片 */ }
    const transport = createLocateTransport(session)
    let cardOk = false
    if (transport && String(channelKey || '')) {
      const card = await transport.sendForwardCard(String(channelKey), buildLocateContextNodes(cache, cacheIdx, botId), 10000)
      cardOk = card.ok && !!card.value
    }
    if (cardOk) return handled()
    logLocate(ctx, 'warn', `locate context card failed: ${context} targetCacheIdx=${cacheIdx}`)
    try { await session.send(LOCATE_TEXT_CARD_FAILED) } catch { /* non-critical: 兜底文案发送失败不再重试 */ }
    try { await session.send(buildLocateTargetLine(cache, cacheIdx)) } catch { /* non-critical: 单条兜底发送失败不再重试 */ }
    return handled()
  }

  const snapshot = getLocateSnapshot(channelKey, currentUserId)
  if (!snapshot) {
    logLocate(ctx, 'warn', `locate rejected: snapshot missing ${context}`)
    return handled(LOCATE_TEXT_SNAPSHOT_MISSING)
  }
  const targetIdx = index - 1
  if (targetIdx < 0 || targetIdx >= snapshot.length) return handled('编号超出范围。')
  const cacheIdx = findCacheIndexOfSnapshotEntry(cache, snapshot[targetIdx])
  if (cacheIdx < 0) return handled('未找到该消息。')

  const target = messages[cacheIdx]
  const shortId = String(target.messageId || '').trim()
  const realSeq = normalizeRealSeq(target.realSeq)
  const groupId = String(channelKey || target.groupId || '')
  const targetInfo = `targetId=${shortId || '-'} realSeq=${realSeq || '-'} group=${groupId}`

  const transport = createLocateTransport(session)
  if (!transport || !groupId) {
    return finishWithContext({ cacheIdx, reasonText: LOCATE_TEXT_PRECHECK_FAILED, reason: transport ? 'no-group-id' : 'no-transport' })
  }

  // 预检分支：有 real_seq 直接走 seq，避免用已失效的短 ID 误杀；老记录才按短 ID 预检。
  let quoteTarget: LocateQuoteTarget | null = null
  let precheckState = 'skipped-seq'
  if (realSeq) {
    quoteTarget = { seq: realSeq }
  } else if (shortId) {
    const precheck = await transport.readMessage(shortId, LOCATE_READ_TIMEOUT_MS)
    if (!precheck.ok) {
      return finishWithContext({ cacheIdx, reasonText: LOCATE_TEXT_PRECHECK_FAILED, reason: `precheck-${precheck.reason}` })
    }
    const precheckGroup = String(precheck.value.group_id ?? '')
    if (precheckGroup && precheckGroup !== groupId) {
      return finishWithContext({ cacheIdx, reasonText: LOCATE_TEXT_PRECHECK_FAILED, reason: 'precheck-group-mismatch' })
    }
    precheckState = 'passed'
    quoteTarget = { id: shortId }
  }
  if (!quoteTarget) {
    return finishWithContext({ cacheIdx, reasonText: LOCATE_TEXT_PRECHECK_FAILED, reason: 'no-quote-id' })
  }

  const sent = await transport.sendQuote(groupId, quoteTarget, LOCATE_READ_TIMEOUT_MS)
  if (!sent.ok || !sent.value.messageId) {
    return finishWithContext({ cacheIdx, reasonText: LOCATE_TEXT_PRECHECK_FAILED, reason: sent.ok ? 'no-message-id' : `send-${sent.reason}` })
  }
  const sentMessageId = String(sent.value.messageId)

  const verify = await transport.readMessage(sentMessageId, LOCATE_VERIFY_TIMEOUT_MS)
  if (!verify.ok) {
    logLocate(ctx, 'warn', `locate verify unreadable: ${context} ${targetInfo} precheck=${precheckState} sent=${sentMessageId} reason=verify-${verify.reason}`)
    return finishWithContext({
      cacheIdx,
      reasonText: verify.reason === 'timeout' ? LOCATE_TEXT_VERIFY_TIMEOUT : LOCATE_TEXT_VERIFY_MISSING,
      reason: `verify-${verify.reason}`,
    })
  }
  const replyTarget = extractReplyTargetId(verify.value.message)
  if (!shortId || replyTarget !== shortId) {
    logLocate(ctx, 'warn', `locate verify mismatch: ${context} ${targetInfo} precheck=${precheckState} sent=${sentMessageId} replyId=${replyTarget || '-'}`)
    return finishWithContext({ cacheIdx, reasonText: LOCATE_TEXT_VERIFY_MISSING, reason: 'reply-mismatch' })
  }
  logLocate(ctx, 'info', `locate quoted: ${context} ${targetInfo} precheck=${precheckState} sent=${sentMessageId}`)
  return handled()
}

export = {
  LOCATE_TEXT_PRECHECK_FAILED,
  LOCATE_TEXT_SNAPSHOT_MISSING,
  LOCATE_TEXT_VERIFY_TIMEOUT,
  LOCATE_TEXT_VERIFY_MISSING,
  buildLocateContextNodes,
  handleLocateCommand,
}
