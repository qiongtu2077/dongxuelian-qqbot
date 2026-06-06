/**
 * MODULE: Agent 记忆整理（Dream）。
 * 职责: 合并 daily 文件到长期记忆，去重/压缩/淘汰过期条目。
 * 边界: 不影响实时对话、不删除未备份的长期文件、失败时保留原文件。
 * 状态: 无（由 auto-memory 完成后触发）。
 */
const fsp = require('fs/promises') as typeof import('fs/promises')
const path = require('path') as typeof import('path')
const { DATA_DIR } = require('../core/constants') as typeof import('../core/constants')
const { requestChatCompletions } = require('../core/api') as typeof import('../core/api')
const { loadConfig } = require('../core/runtime-config') as typeof import('../core/runtime-config')
const { safeUserId, legacySafeUserId } = require('../core/utils') as typeof import('../core/utils')

const DASHBOARD_MEMORY_DIR: string = path.join(DATA_DIR, 'agent-memory-dashboard')
const DAILY_DIR: string = path.join(DASHBOARD_MEMORY_DIR, 'daily')
const DREAM_SIZE_THRESHOLD = 20 * 1024
const MAX_LONG_TERM_FILE_BYTES = 100 * 1024
const dreamLocks: Map<string, Promise<DreamResult>> = new Map()

const DREAM_PROMPT = `你是记忆整理助手。以下是用户的每日记忆文件和长期记忆文件内容。

请按以下原则整理：

1. 极简主义：只保留核心偏好、确认的事实、高价值经验
2. 状态覆盖：新信息覆盖旧信息（如"喜欢A"后来变成"喜欢B"，只保留B）
3. 归纳合并：相似条目合并为一条通用描述
4. 过期淘汰：超过 30 天且内容已过时的条目可删除

输出精简后的内容，使用自然文本格式，每行一条记忆。
不要使用 JSON 格式，直接写给人看的记忆描述。`

type DreamResult =
  | { success: false; reason: string }
  | { success: true; beforeSize: number; afterSize: number; deletedFiles: number }

interface DreamStatus {
  userId: string
  dailyTotalSize: number
  threshold: number
  needsDream: boolean
}

interface ChatMessage {
  role: string
  content: string
}

function getLongTermFile(userId: unknown): string {
  return path.join(DASHBOARD_MEMORY_DIR, `${safeUserId(String(userId || ''))}.md`)
}

function getBackupFile(userId: unknown): string {
  return path.join(DASHBOARD_MEMORY_DIR, `${safeUserId(String(userId || ''))}.md.bak`)
}

async function readLongTermFile(userId: unknown): Promise<string> {
  for (const file of getLongTermFileCandidates(userId)) {
    try {
      const stat = await fsp.stat(file)
      if (!stat.isFile() || stat.size > MAX_LONG_TERM_FILE_BYTES) continue
      return await fsp.readFile(file, 'utf8')
    } catch { /* non-critical: missing or unreadable long-term memory candidate falls through */ }
  }
  return ''
}

function getLongTermFileCandidates(userId: unknown): string[] {
  const current = safeUserId(String(userId || ''))
  const legacy = legacySafeUserId(String(userId || ''))
  const files = [path.join(DASHBOARD_MEMORY_DIR, `${current}.md`)]
  if (legacy !== current) files.push(path.join(DASHBOARD_MEMORY_DIR, `${legacy}.md`))
  return files
}

async function listDailyFiles(userId: unknown): Promise<string[]> {
  try {
    const files = await fsp.readdir(DAILY_DIR)
    const value = String(userId || '')
    const prefixes = Array.from(new Set([safeUserId(value) + '.', legacySafeUserId(value) + '.']))
    return files.filter(f => prefixes.some(prefix => f.startsWith(prefix)) && f.endsWith('.md')).sort()
  } catch { /* non-critical: no daily memory directory means no dream work is needed */
    return []
  }
}

async function readAllDailyContent(userId: unknown): Promise<string> {
  const files = await listDailyFiles(userId)
  const parts: string[] = []
  for (const f of files) {
    try {
      const content = await fsp.readFile(path.join(DAILY_DIR, f), 'utf8')
      if (content.trim()) parts.push(`--- ${f} ---\n${content.trim()}`)
    } catch { /* non-critical: unreadable daily file is skipped so other candidates can still be consolidated */ }
  }
  return parts.join('\n\n')
}

async function getDailyTotalSize(userId: unknown): Promise<number> {
  const files = await listDailyFiles(userId)
  let total = 0
  for (const f of files) {
    try {
      const stat = await fsp.stat(path.join(DAILY_DIR, f))
      total += stat.size
    } catch { /* non-critical: vanished daily file is ignored during size scan */ }
  }
  return total
}

async function runDream(userId: unknown): Promise<DreamResult> {
  const lockKey = safeUserId(String(userId || ''))
  const existingTask = dreamLocks.get(lockKey)
  if (existingTask) return existingTask
  const task = _doRunDream(userId)
  dreamLocks.set(lockKey, task)
  task.finally(() => dreamLocks.delete(lockKey))
  return task
}

async function _doRunDream(userId: unknown): Promise<DreamResult> {
  const dailyContent = await readAllDailyContent(userId)
  if (!dailyContent.trim()) return { success: false, reason: 'no-daily-content' }

  const longTerm = await readLongTermFile(userId)
  const inputParts: string[] = []
  if (longTerm.trim()) inputParts.push(`【长期记忆】\n${longTerm.trim()}`)
  inputParts.push(`【每日记忆】\n${dailyContent}`)
  const input = inputParts.join('\n\n')

  if (input.length > 30000) {
    return { success: false, reason: 'input-too-large' }
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: DREAM_PROMPT },
    { role: 'user', content: input },
  ]

  const config = await loadConfig()
  let result
  try {
    result = await requestChatCompletions(messages, config, { max_tokens: 1500 })
  } catch { /* non-critical: dream consolidation can be retried on the next trigger */
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
    try { await fsp.unlink(path.join(DAILY_DIR, f)) } catch { /* non-critical: failed cleanup leaves daily file for a later retry */ }
  }

  return { success: true, beforeSize: input.length, afterSize: consolidated.length, deletedFiles: dailyFiles.length }
}

async function runDreamIfNeeded(userId: unknown): Promise<DreamResult | null> {
  const totalSize = await getDailyTotalSize(userId)
  if (totalSize < DREAM_SIZE_THRESHOLD) return null
  return runDream(userId)
}

function getDreamStatus(userId: unknown): Promise<DreamStatus> {
  return getDailyTotalSize(userId).then(size => ({
    userId: safeUserId(String(userId || '')),
    dailyTotalSize: size,
    threshold: DREAM_SIZE_THRESHOLD,
    needsDream: size >= DREAM_SIZE_THRESHOLD,
  }))
}

export = {
  DASHBOARD_MEMORY_DIR,
  DAILY_DIR,
  runDream,
  runDreamIfNeeded,
  getDreamStatus,
  getLongTermFile,
  readLongTermFile,
  safeUserId,
}
