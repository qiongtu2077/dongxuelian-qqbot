/**
 * MODULE: Agent 自动记忆提取（仅 dashboard 渠道）。
 * 职责: 对话后异步提取关键信息写入 daily 记忆文件。
 * 边界: 不阻塞回复、不修改对话历史、不影响当前回复。
 * 状态: userMessageCounters (Map)。
 */
const fsp = require('fs/promises')
const path = require('path')
const { DATA_DIR } = require('../constants')
const { requestChatCompletions } = require('../api')
const { loadConfig } = require('../runtime-config')

const DASHBOARD_MEMORY_DIR = path.join(DATA_DIR, 'agent-memory-dashboard')
const DAILY_DIR = path.join(DASHBOARD_MEMORY_DIR, 'daily')
const AUTO_MEMORY_INTERVAL = 8
const AUTO_MEMORY_WINDOW = 8
const MAX_CHARS_PER_TURN = 500
const MAX_DAILY_FILE_BYTES = 50 * 1024

const userMessageCounters = new Map()

const EXTRACT_PROMPT = `从以下对话中提取值得长期记住的信息。只提取：
- 用户明确表达的偏好、身份、习惯
- 用户分享的重要事实（生日、职业、常用工具等）
- 对话中确认的决策或约定
- 工作流偏好（用户喜欢的操作方式、常用工具）

不要提取：临时话题、闲聊、已知常识、工具调用细节。
如果没有值得记住的，只输出一个空行。
每条记忆用一行描述，简洁明了。`

function safeAutoMemoryUserId(userId = '') {
  return String(userId || 'unknown').replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 100) || 'unknown'
}

function getDailyFile(userId) {
  const date = new Date().toISOString().slice(0, 10)
  return path.join(DAILY_DIR, `${safeAutoMemoryUserId(userId)}.${date}.md`)
}

function getCounterKey(userId) {
  return `dashboard:${safeAutoMemoryUserId(userId)}`
}

function incrementCounter(userId) {
  const key = getCounterKey(userId)
  const count = (userMessageCounters.get(key) || 0) + 1
  userMessageCounters.set(key, count)
  return count
}

function shouldTrigger(userId) {
  const count = incrementCounter(userId)
  return count % AUTO_MEMORY_INTERVAL === 0
}

function buildExtractMessages(recentMessages, existingDaily) {
  const trimmed = recentMessages.slice(-AUTO_MEMORY_WINDOW * 2).map(m => {
    const content = String(m.content || '').slice(0, MAX_CHARS_PER_TURN)
    return `[${m.role}] ${content}`
  }).join('\n')

  const messages = [{ role: 'system', content: EXTRACT_PROMPT }]
  if (existingDaily) {
    messages.push({ role: 'system', content: `已有记忆（避免重复）：\n${existingDaily.slice(0, 1000)}` })
  }
  messages.push({ role: 'user', content: trimmed })
  return messages
}

async function readDailyFile(userId) {
  try {
    const file = getDailyFile(userId)
    const stat = await fsp.stat(file)
    if (!stat.isFile() || stat.size > MAX_DAILY_FILE_BYTES) return ''
    return await fsp.readFile(file, 'utf8')
  } catch {
    return ''
  }
}

async function appendDailyFile(userId, content) {
  await fsp.mkdir(DAILY_DIR, { recursive: true })
  const file = getDailyFile(userId)
  const timestamp = new Date().toISOString().slice(11, 16)
  const entry = `[${timestamp}] ${content.trim()}\n`
  await fsp.appendFile(file, entry, 'utf8')
}

async function getDailyTotalSize(userId) {
  try {
    const files = await fsp.readdir(DAILY_DIR)
    const prefix = safeAutoMemoryUserId(userId) + '.'
    let total = 0
    for (const f of files) {
      if (!f.startsWith(prefix)) continue
      try {
        const stat = await fsp.stat(path.join(DAILY_DIR, f))
        total += stat.size
      } catch {}
    }
    return total
  } catch {
    return 0
  }
}

async function extractMemory(recentMessages, userId) {
  const existing = await readDailyFile(userId)
  const messages = buildExtractMessages(recentMessages, existing)
  const config = await loadConfig()
  const result = await requestChatCompletions(messages, config, { max_tokens: 500 })
  if (!result || result.type !== 'text') return null
  const content = String(result.content || '').trim()
  if (!content || content === '空' || content.length < 3) return null
  return content
}

async function onAgentReplyComplete({ userId, channel, messages }) {
  if (channel !== 'dashboard') return
  if (!shouldTrigger(userId)) return

  const recentMessages = (Array.isArray(messages) ? messages : [])
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-AUTO_MEMORY_WINDOW * 2)

  if (recentMessages.length < 2) return

  try {
    const content = await extractMemory(recentMessages, userId)
    if (!content) return
    await appendDailyFile(userId, content)
    const totalSize = await getDailyTotalSize(userId)
    if (totalSize > 20 * 1024) {
      try {
        const { runDreamIfNeeded } = require('./dream')
        await runDreamIfNeeded(userId)
      } catch {}
    }
  } catch {}
}

function resetAutoMemoryCounter(userId) {
  const key = getCounterKey(userId)
  userMessageCounters.delete(key)
}

function getAutoMemoryStats() {
  return {
    counters: Object.fromEntries(userMessageCounters),
    interval: AUTO_MEMORY_INTERVAL,
    memoryDir: DASHBOARD_MEMORY_DIR,
  }
}

module.exports = {
  DASHBOARD_MEMORY_DIR,
  DAILY_DIR,
  onAgentReplyComplete,
  resetAutoMemoryCounter,
  getAutoMemoryStats,
  shouldTrigger,
  getDailyTotalSize,
  safeUserId: safeAutoMemoryUserId,
}
