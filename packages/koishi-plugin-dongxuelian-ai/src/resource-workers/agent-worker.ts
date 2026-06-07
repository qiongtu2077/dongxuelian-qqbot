/**
 * MODULE: S2 agent-worker executor.
 * Responsibility: execute standalone Agent tasks from serializable S2 payloads.
 * Boundary: no QQ/Dashboard sending; result delivery is handled by result-notifier or polling.
 */
const { getAgentWorkerPayloadStatus } = require('./agent-payload') as typeof import('./agent-payload')
const pendingStore = require('../agent/pending') as typeof import('../agent/pending') & { upsertPendingToolSnapshot?: (snapshot: unknown) => unknown }

interface WorkerTaskResult extends Record<string, unknown> {
  defer?: boolean
  reason?: string
  mode?: string
}

interface AgentWorkerTaskLike extends Record<string, unknown> {
  id?: string
  payload?: Record<string, unknown>
}

interface AgentWorkerResultLike {
  reply?: unknown
  message?: unknown
  error?: unknown
  ok?: unknown
  pendingId?: unknown
  toolCalls?: unknown
  toolResults?: unknown
}

function resultLike(value: unknown): AgentWorkerResultLike {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AgentWorkerResultLike : {}
}

// Convert an Agent result into the compact S2 result.json shape.
function buildAgentWorkerResult(task: AgentWorkerTaskLike, result: unknown, mode: string, warnings: string[] = []): WorkerTaskResult {
  const record = resultLike(result)
  return {
    mode,
    reply: String(record.reply || record.message || ''),
    message: String(record.message || ''),
    error: String(record.error || ''),
    ok: record.ok !== false,
    pendingId: record.pendingId || null,
    toolCalls: Number(record.toolCalls || 0),
    toolResults: Array.isArray(record.toolResults) ? record.toolResults.slice(0, 20) : [],
    warnings,
    reason: `agent worker completed task ${String(task?.id || '')}`,
  }
}

// Execute one standalone Agent task when its serialized payload is complete.
async function runAgentWorkerTask(task: AgentWorkerTaskLike): Promise<WorkerTaskResult> {
  const status = getAgentWorkerPayloadStatus(task)
  if (!status.executable || !status.payload) {
    return {
      defer: true,
      mode: 'agent_worker_payload_incomplete',
      reason: `${status.reason} for task ${String(task?.id || '')}`,
    }
  }

  const engine = require('../agent/engine') as typeof import('../agent/engine')
  const payload = status.payload
  const warnings = Array.isArray(payload.warnings) ? payload.warnings.map(String) : []

  if (payload.action === 'resume_pending') {
    if (payload.pendingSnapshot && typeof pendingStore.upsertPendingToolSnapshot === 'function') {
      pendingStore.upsertPendingToolSnapshot(payload.pendingSnapshot)
    }
    const result = await engine.resumePending({
      ...(payload.resumeInput || {}),
      bot: undefined,
      resourceTaskId: String(task?.id || ''),
    })
    return buildAgentWorkerResult(task, result, 'agent_resume_worker', warnings)
  }

  const result = await engine.run({
    ...(payload.engineInput || {}),
    bot: undefined,
    resourceTaskId: String(task?.id || ''),
  })
  return buildAgentWorkerResult(task, result, 'agent_worker', warnings)
}

export = {
  runAgentWorkerTask,
}
