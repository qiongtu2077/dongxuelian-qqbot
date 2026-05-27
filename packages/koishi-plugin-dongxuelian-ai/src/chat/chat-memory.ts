/**
 * MODULE: 聊天记忆旁支处理。
 * 职责: 处理 chat() 进入模型前的记忆写入、确认、纠正和群记忆定时清理。
 * 边界: 不构造模型消息，不调用 LLM，不保存对话历史。
 */
const path = require('path')
const { DATA_DIR } = require('../core/constants') as typeof import('../core/constants')
const {
  getConversationHistory,
  writeMemory,
  deleteMemory,
  clearGroupMemory,
  checkMemoryTimerExpired,
  readMemoryTimer,
} = require('../conversation') as typeof import('../conversation')
const { writeJsonFile, safeChannelKey } = require('../core/utils') as typeof import('../core/utils')

interface MemorySessionLike {
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

interface MemoryTimerData {
  lastClearTs?: number
  [key: string]: unknown
}

interface DirectMemoryWriteOptions {
  cleanInput: string
  currentUserId?: string
  channelKey: string
  inGuild?: boolean
}

interface MemoryConfirmationOptions extends DirectMemoryWriteOptions {
  session: MemorySessionLike
}

const lastMemoryPromptTs: Map<string, number> = new Map()
let lastCleanupTs: number = 0

function trimChatMemoryRuntime(now: number = Date.now()): void {
  if (now - lastCleanupTs < 300000) return
  lastCleanupTs = now
  for (const [key, ts] of lastMemoryPromptTs.entries()) {
    if (now - ts > 300000) lastMemoryPromptTs.delete(key)
  }
}

function getMemoryTimerFile(channelKey: string): string {
  const safeKey = safeChannelKey(channelKey)
  return path.join(DATA_DIR, 'memory-timers', safeKey + '.json')
}

async function clearGroupMemoryIfExpired(session: MemorySessionLike, channelKey: string): Promise<boolean> {
  if (!session?.guildId || !checkMemoryTimerExpired(channelKey)) return false
  await clearGroupMemory(channelKey)
  const timer = readMemoryTimer(channelKey) as MemoryTimerData | null
  if (!timer) return true
  timer.lastClearTs = Date.now()
  await writeJsonFile(getMemoryTimerFile(channelKey), timer)
  return true
}

async function handleDirectMemoryWrite({ cleanInput, currentUserId, channelKey, inGuild }: DirectMemoryWriteOptions): Promise<string | null> {
  if (!currentUserId || !inGuild || !/^(?:记住|记下)\s+/.test(cleanInput)) return null
  const text = cleanInput.replace(/^(?:记住|记下)\s+/, '').trim()
  if (!text) return null
  await writeMemory(currentUserId, '', channelKey, text)
  return '嗯，我记住了'
}

async function handleMemoryConfirmation({ session, cleanInput, currentUserId, channelKey, inGuild }: MemoryConfirmationOptions): Promise<void> {
  if (!currentUserId || !inGuild) return
  const chatHistory = getConversationHistory(session)
  const lastReply = chatHistory.length > 0 ? chatHistory[chatHistory.length - 1].content || '' : ''

  if (/^(?:嗯|好|可以|是|记住|记下|行|对)/.test(cleanInput) && /需要.{0,10}记住/.test(lastReply)) {
    const promptKey = currentUserId + ':' + channelKey
    const promptTs = lastMemoryPromptTs.get(promptKey) || 0
    if (Date.now() - promptTs < 60000) {
      const matchResult = lastReply.match(/需要.{0,10}记住\s*(.+?)[？?。！!，,]?\s*$/)
      if (matchResult) await writeMemory(currentUserId, '', channelKey, matchResult[1].trim())
    }
  }

  if (/^(?:不是|记错了|没说过|记错|不对)/.test(cleanInput)) {
    const recentMemory = chatHistory.filter(m => m.role === 'system' && (m.content || '').startsWith('记住的：'))
    if (recentMemory.length > 0) {
      const memoryItems = (recentMemory[recentMemory.length - 1].content || '').replace('记住的：', '').split('、')
      for (const item of memoryItems) await deleteMemory(currentUserId, channelKey, item.trim())
    }
  }
}

function rememberMemoryPrompt(currentUserId: string, channelKey: string, reply: string): void {
  if (!/需要.{0,10}记住/.test(String(reply || ''))) return
  lastMemoryPromptTs.set(currentUserId + ':' + channelKey, Date.now())
}

export = {
  trimChatMemoryRuntime,
  clearGroupMemoryIfExpired,
  handleDirectMemoryWrite,
  handleMemoryConfirmation,
  rememberMemoryPrompt,
}
