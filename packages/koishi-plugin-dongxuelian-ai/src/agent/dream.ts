/**
 * MODULE: Agent memory Dream trigger.
 * Responsibility: expose Dream status and enqueue S2 memory compaction tasks.
 * Boundary: does not call LLM and does not rewrite memory files in Koishi main process.
 */
const {
  DASHBOARD_MEMORY_DIR,
  DAILY_DIR,
  DREAM_SIZE_THRESHOLD,
  submitAgentMemoryCompactionTask,
  getDailyTotalSize,
  getDreamStatus: getMemoryDreamStatus,
  getLongTermFile,
  readLongTermFile,
  safeUserId,
} = require('../resource-workers/memory-worker') as typeof import('../resource-workers/memory-worker')

type DreamResult =
  | { success: false; reason: string; taskId?: string }
  | { success: true; queued: true; taskId: string; status: string }

const dreamLocks: Map<string, Promise<DreamResult>> = new Map()

// Submit a Dream compaction task once per user in the current process.
async function runDream(userId: unknown): Promise<DreamResult> {
  const lockKey = safeUserId(String(userId || ''))
  const existingTask = dreamLocks.get(lockKey)
  if (existingTask) return existingTask
  const task = Promise.resolve().then(() => {
    const submission = submitAgentMemoryCompactionTask(userId, 'agent-dream')
    if (!submission.accepted || !submission.taskId) {
      return { success: false, reason: submission.message || submission.status || 'dream-submit-failed', taskId: submission.taskId }
    }
    return { success: true, queued: true, taskId: submission.taskId, status: submission.status }
  }) as Promise<DreamResult>
  dreamLocks.set(lockKey, task)
  task.finally(() => dreamLocks.delete(lockKey))
  return task
}

// Submit Dream compaction only when daily memory size reaches the threshold.
async function runDreamIfNeeded(userId: unknown): Promise<DreamResult | null> {
  const totalSize = await getDailyTotalSize(userId)
  if (totalSize < DREAM_SIZE_THRESHOLD) return null
  return runDream(userId)
}

// Return Dream status without invoking LLM work.
function getDreamStatus(userId: unknown): Promise<Record<string, unknown>> {
  return getMemoryDreamStatus(userId)
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
