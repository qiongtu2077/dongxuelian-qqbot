/* ==========================================================================
 * MODULE: event-dump
 * 职责：管理一次性原始事件抓取状态，并将 session event 安全落盘。
 * 边界：不注册 middleware、不解析 admin 命令、不发送消息；只提供状态查询/变更与 dump 文件写入。
 * 状态：持有 armedEventDumpCache，按频道记录下一条事件抓取的发起人与过期时间。
 * ========================================================================== */
const fs = require('fs/promises')
const path = require('path')
const {
  EVENT_DUMP_DIR,
  EVENT_DUMP_ARM_EXPIRE_MS,
} = require('../core/constants') as typeof import('../core/constants')
const { getChannelKey } = require('../conversation') as typeof import('../conversation')
const {
  getSenderUserId,
  sanitizeFileToken,
  safeJsonStringify,
} = require('../core/utils') as typeof import('../core/utils')

interface EventDumpSession {
  platform?: string
  type?: string
  subtype?: string
  selfId?: string
  userId?: string
  channelId?: string
  guildId?: string
  messageId?: string
  content?: string
  author?: unknown
  quote?: unknown
  event?: unknown
}

interface ArmedEventDumpState {
  armedAt: number
  armedBy: string
}

type EventDumpChannelSession = Parameters<typeof getChannelKey>[0]
type EventDumpSenderSession = Parameters<typeof getSenderUserId>[0]

const armedEventDumpCache = new Map<string, ArmedEventDumpState>()

function getArmedEventDump(channelKey: string = ''): ArmedEventDumpState | null {
  const key = String(channelKey || '')
  const state = armedEventDumpCache.get(key)
  if (!state) return null
  if (Date.now() - state.armedAt > EVENT_DUMP_ARM_EXPIRE_MS) {
    armedEventDumpCache.delete(key)
    return null
  }
  return state
}

function armEventDump(session: EventDumpSession): ArmedEventDumpState {
  const channelKey = getChannelKey(session as EventDumpChannelSession)
  const state = {
    armedAt: Date.now(),
    armedBy: getSenderUserId(session as EventDumpSenderSession),
  }
  armedEventDumpCache.set(channelKey, state)
  return state
}

function clearArmedEventDump(channelKey: string = ''): void {
  armedEventDumpCache.delete(String(channelKey || ''))
}

async function dumpSessionEvent(session: EventDumpSession, analyzed: unknown, plain: unknown, memoryText: unknown): Promise<string> {
  const now = new Date()
  const dateStamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const timeStamp = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
  const channelToken = sanitizeFileToken(getChannelKey(session as EventDumpChannelSession))
  const messageToken = sanitizeFileToken(session.messageId || 'no-message-id')
  const fileName = `ai-event-${dateStamp}-${timeStamp}-${channelToken}-${messageToken}.json`
  const filePath = path.join(EVENT_DUMP_DIR, fileName)

  const payload = {
    capturedAt: now.toISOString(),
    analyzed,
    session: {
      platform: session.platform,
      type: session.type,
      subtype: session.subtype,
      selfId: session.selfId,
      userId: session.userId,
      channelId: session.channelId,
      guildId: session.guildId,
      messageId: session.messageId,
      content: session.content,
      plain,
      memoryText,
      author: session.author,
      quote: session.quote,
      event: session.event,
    },
  }

  await fs.mkdir(EVENT_DUMP_DIR, { recursive: true })
  await fs.writeFile(filePath, safeJsonStringify(payload), 'utf8')
  return filePath
}

export = {
  getArmedEventDump,
  armEventDump,
  clearArmedEventDump,
  dumpSessionEvent,
}
