/** Waits for standalone Agent worker results; owns only polling timers, never backend task cancellation. */
import type { AgentChatResponse, AgentTaskResponse, ApiResult } from './types'

type ReadTask = (taskId: string, signal: AbortSignal) => Promise<ApiResult<AgentTaskResponse>>
interface TaskWaitOptions {
  signal?: AbortSignal
  timeoutMs?: number
  pollIntervalMs?: number
}

// --- Poll scheduling ---

/** Waits between status reads and releases its timer/listener immediately on cancellation. */
function waitForPoll(signal: AbortSignal, intervalMs: number): Promise<void> {
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, intervalMs)
    if (signal.aborted) finish()
    else signal.addEventListener('abort', finish, { once: true })
  })
}

// --- Task completion ---

/** Resolves accepted submissions to their final worker result with bounded, cancellable polling. */
export async function followAgentTask(submission: ApiResult<AgentChatResponse>, readTask: ReadTask, options: TaskWaitOptions = {}): Promise<ApiResult<AgentChatResponse>> {
  const taskId = submission.data?.taskId
  if (!submission.ok || !submission.data?.async || !taskId) return submission
  const controller = new AbortController()
  const cancel = () => controller.abort()
  if (options.signal?.aborted) cancel()
  else options.signal?.addEventListener('abort', cancel, { once: true })
  // Covers the worker's ten-minute execution limit and maximum five-minute deferral grace.
  const timeout = setTimeout(cancel, options.timeoutMs ?? 15 * 60 * 1000)
  try {
    while (!controller.signal.aborted) {
      const response = await readTask(taskId, controller.signal)
      if (controller.signal.aborted) break
      if (!response.ok) return { ok: false, data: null, code: response.code, message: response.message || '读取任务状态失败' }
      const task = response.data?.task
      if (!task) return { ok: false, data: null, message: '任务状态响应缺少任务信息' }
      if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') {
        const ok = task.status === 'done' && task.result.ok !== false
        const reply = task.result.reply || task.result.message || task.result.error || task.error || (ok ? 'Agent 任务已完成。' : 'Agent 任务执行失败。')
        return { ok, data: { ok, async: false, taskId, status: task.status, reply, pendingId: task.result.pendingId || undefined }, message: ok ? undefined : reply }
      }
      await waitForPoll(controller.signal, options.pollIntervalMs ?? 1000)
    }
    return { ok: false, data: null, code: options.signal?.aborted ? 'ABORTED' : 'TASK_TIMEOUT', message: options.signal?.aborted ? '请求已取消' : '等待后台任务结果超时' }
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', cancel)
  }
}
