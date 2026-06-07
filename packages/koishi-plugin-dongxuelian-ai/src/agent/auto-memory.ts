/**
 * MODULE: Agent automatic memory trigger.
 * Responsibility: decide when dashboard Agent replies should enqueue background memory extraction.
 * Boundary: does not call LLM and does not write memory files; S2 memory-worker owns execution.
 */
const { getAgentConfig } = require('./config') as typeof import('./config')
const {
  DASHBOARD_MEMORY_DIR,
  DAILY_DIR,
  AUTO_MEMORY_INTERVAL,
  submitAgentMemoryTask,
  getDailyTotalSize,
  safeUserId,
} = require('../resource-workers/memory-worker') as typeof import('../resource-workers/memory-worker')

interface AutoMemoryMessage {
  role?: unknown
  content?: unknown
}

interface AgentReplyCompleteInput {
  userId?: unknown
  channel?: unknown
  messages?: unknown
}

interface AutoMemoryStats {
  counters: Record<string, number>
  interval: number
  memoryDir: string
}

const AUTO_MEMORY_WINDOW = 8
const userMessageCounters: Map<string, number> = new Map()

// Return true for message records that can be serialized into a memory task.
function isAutoMemoryMessage(value: unknown): value is AutoMemoryMessage {
  if (!value || typeof value !== 'object') return false
  const role = (value as { role?: unknown }).role
  return role === 'user' || role === 'assistant'
}

// Build a stable counter key for dashboard auto-memory triggers.
function getCounterKey(userId: unknown): string {
  return `dashboard:${safeUserId(String(userId || ''))}`
}

// Increment and cap the in-process trigger counter map.
function incrementCounter(userId: unknown): number {
  const key = getCounterKey(userId)
  const count = (userMessageCounters.get(key) || 0) + 1
  if (userMessageCounters.size > 5000) {
    const first = userMessageCounters.keys().next().value
    if (first !== undefined) userMessageCounters.delete(first)
  }
  userMessageCounters.set(key, count)
  return count
}

// Return true when this reply should enqueue a memory extraction task.
function shouldTrigger(userId: unknown): boolean {
  const count = incrementCounter(userId)
  return count % AUTO_MEMORY_INTERVAL === 0
}

// Enqueue background memory extraction after a dashboard Agent reply.
async function onAgentReplyComplete({ userId, channel, messages }: AgentReplyCompleteInput = {}): Promise<void> {
  if (channel !== 'dashboard') return
  if (getAgentConfig().memory?.enabled === false) return
  if (!shouldTrigger(userId)) return

  const recentMessages = (Array.isArray(messages) ? messages : [])
    .filter(isAutoMemoryMessage)
    .slice(-AUTO_MEMORY_WINDOW * 2)

  if (recentMessages.length < 2) return

  try {
    submitAgentMemoryTask({
      userId,
      recentMessages,
      source: 'agent-auto-memory',
    })
  } catch {
    // Automatic memory must never affect the user-visible Agent reply.
  }
}

// Reset one user's trigger counter.
function resetAutoMemoryCounter(userId: unknown): void {
  const key = getCounterKey(userId)
  userMessageCounters.delete(key)
}

// Return lightweight auto-memory stats for diagnostics.
function getAutoMemoryStats(): AutoMemoryStats {
  return {
    counters: Object.fromEntries(userMessageCounters),
    interval: AUTO_MEMORY_INTERVAL,
    memoryDir: DASHBOARD_MEMORY_DIR,
  }
}

export = {
  DASHBOARD_MEMORY_DIR,
  DAILY_DIR,
  onAgentReplyComplete,
  resetAutoMemoryCounter,
  getAutoMemoryStats,
  shouldTrigger,
  getDailyTotalSize,
  safeUserId,
}
