/**
 * MODULE: 聊天记忆旁支处理。
 * 职责: 处理 chat() 进入模型前的记忆写入、确认、纠正和群记忆定时清理。
 * 边界: 不构造模型消息，不调用 LLM，不保存对话历史。
 */
const path = require('path')
const { DATA_DIR } = require('../core/constants')
const {
  getConversationHistory,
  writeMemory,
  deleteMemory,
  clearGroupMemory,
  checkMemoryTimerExpired,
  readMemoryTimer,
} = require('../conversation')
const { writeJsonFile } = require('../core/utils')

const lastMemoryPromptTs = new Map()
let lastCleanupTs = 0

function trimChatMemoryRuntime(now = Date.now()) {
  if (now - lastCleanupTs < 300000) return
  lastCleanupTs = now
  for (const [key, ts] of lastMemoryPromptTs.entries()) {
    if (now - ts > 300000) lastMemoryPromptTs.delete(key)
  }
}

function getMemoryTimerFile(channelKey) {
  const safeKey = String(channelKey).replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(DATA_DIR, 'memory-timers', safeKey + '.json')
}

async function clearGroupMemoryIfExpired(session, channelKey) {
  if (!session?.guildId || !checkMemoryTimerExpired(channelKey)) return false
  await clearGroupMemory(channelKey)
  const timer = readMemoryTimer(channelKey)
  if (!timer) return true
  timer.lastClearTs = Date.now()
  await writeJsonFile(getMemoryTimerFile(channelKey), timer)
  return true
}

async function handleDirectMemoryWrite({ cleanInput, currentUserId, channelKey, inGuild }) {
  if (!currentUserId || !inGuild || !/^(?:记住|记下)\s+/.test(cleanInput)) return null
  const text = cleanInput.replace(/^(?:记住|记下)\s+/, '').trim()
  if (!text) return null
  await writeMemory(currentUserId, '', channelKey, text)
  return '嗯，我记住了'
}

async function handleMemoryConfirmation({ session, cleanInput, currentUserId, channelKey, inGuild }) {
  if (!currentUserId || !inGuild) return
  const chatHistory = getConversationHistory(session)
  const lastReply = chatHistory.length > 0 ? chatHistory[chatHistory.length - 1].content : ''

  if (/^(?:嗯|好|可以|是|记住|记下|行|对)/.test(cleanInput) && /需要.{0,10}记住/.test(lastReply)) {
    const promptKey = currentUserId + ':' + channelKey
    const promptTs = lastMemoryPromptTs.get(promptKey) || 0
    if (Date.now() - promptTs < 60000) {
      const matchResult = lastReply.match(/需要.{0,10}记住\s*(.+?)[？?。！!，,]?\s*$/)
      if (matchResult) await writeMemory(currentUserId, '', channelKey, matchResult[1].trim())
    }
  }

  if (/^(?:不是|记错了|没说过|记错|不对)/.test(cleanInput)) {
    const recentMemory = chatHistory.filter(m => m.role === 'system' && m.content.startsWith('记住的：'))
    if (recentMemory.length > 0) {
      const memoryItems = recentMemory[recentMemory.length - 1].content.replace('记住的：', '').split('、')
      for (const item of memoryItems) await deleteMemory(currentUserId, channelKey, item.trim())
    }
  }
}

function rememberMemoryPrompt(currentUserId, channelKey, reply) {
  if (!/需要.{0,10}记住/.test(String(reply || ''))) return
  lastMemoryPromptTs.set(currentUserId + ':' + channelKey, Date.now())
}

module.exports = {
  trimChatMemoryRuntime,
  clearGroupMemoryIfExpired,
  handleDirectMemoryWrite,
  handleMemoryConfirmation,
  rememberMemoryPrompt,
}
