/**
 * MODULE: Agent 记忆整理（Dream）。
 * 职责: 合并 daily 文件到长期记忆，去重/压缩/淘汰过期条目。
 * 边界: 不影响实时对话、不删除未备份的长期文件、失败时保留原文件。
 * 状态: 无（由 auto-memory 完成后触发）。
 */
const fsp = require('fs/promises')
const path = require('path')
const { DATA_DIR } = require('../constants')
const { requestChatCompletions } = require('../api')
const { loadConfig } = require('../runtime-config')

const DASHBOARD_MEMORY_DIR = path.join(DATA_DIR, 'agent-memory-dashboard')
const DAILY_DIR = path.join(DASHBOARD_MEMORY_DIR, 'daily')
const DREAM_SIZE_THRESHOLD = 20 * 1024
const MAX_LONG_TERM_FILE_BYTES = 100 * 1024

const DREAM_PROMPT = `你是记忆整理助手。以下是用户的每日记忆文件和长期记忆文件内容。

请按以下原则整理：

1. 极简主义：只保留核心偏好、确认的事实、高价值经验
2. 状态覆盖：新信息覆盖旧信息（如"喜欢A"后来变成"喜欢B"，只保留B）
3. 归纳合并：相似条目合并为一条通用描述
4. 过期淘汰：超过 30 天且内容已过时的条目可删除

输出精简后的内容，使用自然文本格式，每行一条记忆。
不要使用 JSON 格式，直接写给人看的记忆描述。`

function safeUserId(userId = '') {
  return String(userId || 'unknown').replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 100) || 'unknown'
}

function getLongTermFile(userId) {
  return path.join(DASHBOARD_MEMORY_DIR, `${safeUserId(userId)}.md`)
}

function getBackupFile(userId) {
  return path.join(DASHBOARD_MEMORY_DIR, `${safeUserId(userId)}.md.bak`)
}

async function readLongTermFile(userId) {
  try {
    const file = getLongTermFile(userId)
    const stat = await fsp.stat(file)
    if (!stat.isFile() || stat.size > MAX_LONG_TERM_FILE_BYTES) return ''
    return await fsp.readFile(file, 'utf8')
  } catch {
    return ''
  }
}

async function listDailyFiles(userId) {
  try {
    const files = await fsp.readdir(DAILY_DIR)
    const prefix = safeUserId(userId) + '.'
    return files.filter(f => f.startsWith(prefix) && f.endsWith('.md')).sort()
  } catch {
    return []
  }
}

async function readAllDailyContent(userId) {
  const files = await listDailyFiles(userId)
  const parts = []
  for (const f of files) {
    try {
      const content = await fsp.readFile(path.join(DAILY_DIR, f), 'utf8')
      if (content.trim()) parts.push(`--- ${f} ---\n${content.trim()}`)
    } catch {}
  }
  return parts.join('\n\n')
}

async function getDailyTotalSize(userId) {
  const files = await listDailyFiles(userId)
  let total = 0
  for (const f of files) {
    try {
      const stat = await fsp.stat(path.join(DAILY_DIR, f))
      total += stat.size
    } catch {}
  }
  return total
}

async function runDream(userId) {
  const dailyContent = await readAllDailyContent(userId)
  if (!dailyContent.trim()) return { success: false, reason: 'no-daily-content' }

  const longTerm = await readLongTermFile(userId)
  const inputParts = []
  if (longTerm.trim()) inputParts.push(`【长期记忆】\n${longTerm.trim()}`)
  inputParts.push(`【每日记忆】\n${dailyContent}`)
  const input = inputParts.join('\n\n')

  if (input.length > 30000) {
    return { success: false, reason: 'input-too-large' }
  }

  const messages = [
    { role: 'system', content: DREAM_PROMPT },
    { role: 'user', content: input },
  ]

  const config = await loadConfig()
  let result
  try {
    result = await requestChatCompletions(messages, config, { max_tokens: 1500 })
  } catch {
    return { success: false, reason: 'llm-call-failed' }
  }

  if (!result || result.type !== 'text' || !result.content || result.content.trim().length < 5) {
    return { success: false, reason: 'empty-result' }
  }

  const consolidated = result.content.trim()

  await fsp.mkdir(DASHBOARD_MEMORY_DIR, { recursive: true })
  const longTermFile = getLongTermFile(userId)
  const backupFile = getBackupFile(userId)

  if (longTerm.trim()) {
    await fsp.writeFile(backupFile, longTerm, 'utf8')
  }

  await fsp.writeFile(longTermFile, consolidated, 'utf8')

  const dailyFiles = await listDailyFiles(userId)
  for (const f of dailyFiles) {
    try { await fsp.unlink(path.join(DAILY_DIR, f)) } catch {}
  }

  return { success: true, beforeSize: input.length, afterSize: consolidated.length, deletedFiles: dailyFiles.length }
}

async function runDreamIfNeeded(userId) {
  const totalSize = await getDailyTotalSize(userId)
  if (totalSize < DREAM_SIZE_THRESHOLD) return null
  return runDream(userId)
}

function getDreamStatus(userId) {
  return getDailyTotalSize(userId).then(size => ({
    userId: safeUserId(userId),
    dailyTotalSize: size,
    threshold: DREAM_SIZE_THRESHOLD,
    needsDream: size >= DREAM_SIZE_THRESHOLD,
  }))
}

module.exports = {
  DASHBOARD_MEMORY_DIR,
  DAILY_DIR,
  runDream,
  runDreamIfNeeded,
  getDreamStatus,
  getLongTermFile,
  readLongTermFile,
  safeUserId,
}
