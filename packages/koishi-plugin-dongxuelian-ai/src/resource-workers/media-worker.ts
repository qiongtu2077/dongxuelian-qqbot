/**
 * MODULE: S2 media-worker 执行器。
 * 职责: 从 S6 背压队列领取媒体任务，并调用现有图片/文件分析器写缓存。
 * 边界: 不发送消息，不绕过 S1/S0。
 */
const { admitTask } = require('../resource-scheduler/admission') as typeof import('../resource-scheduler/admission')
const { normalizeTaskBudget } = require('../resource-scheduler/task-budget') as typeof import('../resource-scheduler/task-budget')
const {
  RESOURCE_TASK_KIND,
  isImageMediaTaskKind,
  isImageCacheTaskKind,
  isFileMediaTaskKind,
  isVoiceMediaTaskKind,
} = require('../resource-common/resource-task-kinds') as typeof import('../resource-common/resource-task-kinds')
const { decideBackgroundDirective } = require('../resource-scheduler/background-directive') as typeof import('../resource-scheduler/background-directive')
const { acquireResourceGate, isResourceGateStorageError } = require('../resource-gate/gate') as typeof import('../resource-gate/gate')
const { writeProcessCleanupEvent } = require('../resource-system/system-protection') as typeof import('../resource-system/system-protection')
const { analyzeImageNow } = require('../media/image/image-analyzer') as typeof import('../media/image/image-analyzer')
const { finishImageAnalysisStatus } = require('../media/image/image-store') as typeof import('../media/image/image-store')
const { hasActiveImageRequest } = require('../media/image/image-request') as typeof import('../media/image/image-request')
const { isRandomImageDemandValid } = require('../media/image/image-random-demand') as typeof import('../media/image/image-random-demand')
const { readImageSource } = require('../media/image/image-source') as typeof import('../media/image/image-source')
const { getImageEntry, markAnalysisUnavailable } = require('../media/image/image-store') as typeof import('../media/image/image-store')
const { analyzeFileNow } = require('../media/file/file-analyzer') as typeof import('../media/file/file-analyzer')
const { transcribeVoice } = require('../media/voice/voice') as typeof import('../media/voice/voice')
const { loadCapabilityConfig } = require('../core/runtime-config') as typeof import('../core/runtime-config')
const {
  markVoiceTranscribed,
  markVoiceTranscriptionUnavailable,
} = require('../media/voice/voice-store') as typeof import('../media/voice/voice-store')
const {
  claimNextMediaTask,
  requeueMediaTask,
  completeMediaTask,
  failMediaTask,
  getImageAnalysisDemand,
  writeMediaEvent,
  hasImageAnalysisDemand,
} = require('../media/backpressure/media-queue') as typeof import('../media/backpressure/media-queue')

interface MediaWorkerOptions {
  workerName?: string
  gateWaitMs?: number
  onTaskChange?: (task: { id: string; claimedAt: string } | null) => void
}

interface MediaTaskPayloadLike {
  imageDemand?: unknown
  userId?: unknown
  url?: unknown
  file?: unknown
}

interface MediaTaskLike {
  id: string
  kind: string
  channelKey: string
  messageId: string
  priority: number
  payload?: MediaTaskPayloadLike
  url?: string
  fileId?: string | null
}

const MEDIA_TASK_TIMEOUT_MS = Math.max(10000, Math.min(10 * 60 * 1000, Number(process.env.RESOURCE_MEDIA_TASK_TIMEOUT_MS || 180000)))

// 判断媒体任务类型是否为图片分析。
function isImageMediaTask(task: MediaTaskLike): boolean {
  return isImageMediaTaskKind(task?.kind)
}

// 纯缓存和未登记新需求的旧图片任务，都按缓存资源预算执行。
function isImageCacheTask(task: MediaTaskLike): boolean {
  return isImageCacheTaskKind(task.kind) || (isImageMediaTask(task) && !getImageAnalysisDemand(task.payload))
}

// 纯缓存及旧任务转换遵守缓存自身的运行预算，不能沿用模型分析的长超时。
function getMediaTaskTimeoutMs(task: MediaTaskLike): number {
  const kind = isImageCacheTask(task) ? RESOURCE_TASK_KIND.MEDIA_IMAGE_CACHE : task.kind
  return Math.min(MEDIA_TASK_TIMEOUT_MS, normalizeTaskBudget({ kind }).runTimeoutMs)
}

// 判断媒体任务类型是否为文件分析。
function isFileMediaTask(task: MediaTaskLike): boolean {
  return isFileMediaTaskKind(task?.kind)
}

// 判断媒体任务类型是否为语音转写。
function isVoiceMediaTask(task: MediaTaskLike): boolean {
  return isVoiceMediaTaskKind(task?.kind)
}

// 从语音任务 payload 中提取可用 URL。
function getVoiceTaskUrl(task: MediaTaskLike): string {
  return String(task?.payload?.url || task?.url || '')
}

// 从语音任务 payload 中提取 OneBot record file 标识。
function getVoiceTaskFile(task: MediaTaskLike): string {
  return String(task?.payload?.file || task?.fileId || '')
}

// 为 transcribeVoice 构造最小 session，避免 media-worker 依赖 Koishi 主进程上下文。
function buildVoiceTranscriptionSession(task: MediaTaskLike): Record<string, unknown> {
  const url = getVoiceTaskUrl(task)
  const file = getVoiceTaskFile(task)
  return {
    messageId: task?.messageId || task?.id || '',
    content: file ? `[CQ:record,file=${file}]` : '',
    event: {
      message: [
        {
          type: 'record',
          data: { url, file },
        },
      ],
    },
  }
}

// 执行语音 ASR 并写回 voice-store。
async function runVoiceTranscriptionTask(task: MediaTaskLike): Promise<Record<string, unknown>> {
  const channelKey = String(task?.channelKey || '')
  const messageId = String(task?.messageId || '')
  if (!channelKey || !messageId) throw new Error('voice transcription task missing channelKey or messageId')
  try {
    const cfg = await loadCapabilityConfig('voice-asr')
    const transcript = await transcribeVoice(buildVoiceTranscriptionSession(task), { ...cfg })
    if (transcript) {
      await markVoiceTranscribed(channelKey, messageId, transcript)
      return { mode: 'voice', transcript, ok: true }
    }
    await markVoiceTranscriptionUnavailable(channelKey, messageId, 'empty')
    return { mode: 'voice', transcript: '', ok: false }
  } catch (error) {
    await markVoiceTranscriptionUnavailable(channelKey, messageId, 'failed')
    throw error
  }
}

// 执行已领取的媒体任务，并返回分析结果摘要。
async function runClaimedMediaTask(task: MediaTaskLike): Promise<Record<string, unknown>> {
  if (isImageCacheTask(task)) {
    const legacy = isImageMediaTask(task)
    if (legacy) {
      const entry = await getImageEntry(task.channelKey, task.messageId)
      if (entry && !entry.analyzed && !hasImageAnalysisDemand(task.channelKey, task.messageId)) {
        await markAnalysisUnavailable(task.channelKey, task.messageId, 'recorded')
      }
    }
    const source = await readImageSource(String(task.channelKey || ''), String(task.messageId || ''))
    writeMediaEvent('image_cache_completed', { taskId: task.id, channelKey: task.channelKey, messageId: task.messageId, legacy, ok: !!source, reason: source ? 'cached' : 'source_unavailable_or_expired' })
    return { mode: 'image_cache', ok: !!source, legacy, reason: source ? 'cached' : 'source_unavailable_or_expired' }
  }
  if (isImageMediaTask(task)) {
    // 在实际执行前重验来源，已领取的旧任务也没有发出模型请求的权限。
    const demand = getImageAnalysisDemand(task.payload)
    if (!demand) throw new Error('image analysis demand is missing')
    let analysis: string | null = null
    try {
      analysis = await analyzeImageNow(String(task.channelKey || ''), String(task.messageId || ''), {
        source: demand.source, question: demand.question, force: demand.force, randomAuthorization: demand.randomAuthorization,
      })
      return { mode: 'image', source: demand.source, analysis: analysis || '', ok: !!analysis }
    } finally {
      const cancelled = demand.source === 'random-image' && !isRandomImageDemandValid(task.channelKey, task.messageId, demand.randomAuthorization)
      await finishImageAnalysisStatus(task.channelKey, task.messageId, analysis ? 'completed' : cancelled ? 'cancelled' : 'failed',
        () => !hasImageAnalysisDemand(task.channelKey, task.messageId, task.id) && !hasActiveImageRequest(task.channelKey, task.messageId))
    }
  }
  if (isFileMediaTask(task)) {
    const analysis = await analyzeFileNow(String(task.channelKey || ''), String(task.messageId || ''))
    return { mode: 'file', analysis: analysis || '', ok: !!analysis }
  }
  if (isVoiceMediaTask(task)) return runVoiceTranscriptionTask(task)
  throw new Error(`unsupported media task kind: ${String(task?.kind || '')}`)
}

// 给媒体分析加 S8 超时兜底；超时后 media-worker 退出，由 supervisor 拉起新进程。
async function runClaimedMediaTaskWithTimeout(task: MediaTaskLike): Promise<Record<string, unknown>> {
  let timer: NodeJS.Timeout | null = null
  const timeoutMs = getMediaTaskTimeoutMs(task)
  try {
    return await Promise.race([
      runClaimedMediaTask(task),
      new Promise<Record<string, unknown>>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`media worker task timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        if (timer.unref) timer.unref()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// 记录媒体任务超时，并让当前 worker 自退，避免卡住的下载/解析继续污染进程。
function handleMediaTaskTimeout(workerName: string, task: MediaTaskLike, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error || '')
  if (!/media worker task timed out/i.test(message)) return
  writeProcessCleanupEvent({
    event: 'media_task_timed_out',
    workerName,
    taskId: task?.id || '',
    kind: task?.kind || '',
    timeoutMs: getMediaTaskTimeoutMs(task),
    error: message,
  })
  process.exitCode = process.exitCode || 76
}

// 领取并执行一个 S6 媒体任务；没有任务或本轮被资源拒绝时返回 false，让主循环走 pollMs 退避。
async function drainOneMediaTask(options: MediaWorkerOptions = {}): Promise<boolean> {
  const workerName = String(options.workerName || 'media-worker')
  const gate = decideBackgroundDirective({
    kind: RESOURCE_TASK_KIND.MEDIA_IMAGE_CACHE,
    source: workerName,
    channelKey: 'media',
    userId: '',
    priority: 60,
    exclusive: false,
    timeoutMs: MEDIA_TASK_TIMEOUT_MS,
    queueTimeoutMs: MEDIA_TASK_TIMEOUT_MS,
    runTimeoutMs: MEDIA_TASK_TIMEOUT_MS,
  })
  if (gate.directive.action === 'park') return false
  const task = claimNextMediaTask(workerName)
  if (!task) return false
  let gateHandle: { updateStep(step: string, memAvailableMb?: number | null): void; release(reason?: string): void } | null = null
  try {
    const effectiveKind = isImageCacheTask(task) ? RESOURCE_TASK_KIND.MEDIA_IMAGE_CACHE : task.kind
    const step = isImageCacheTask(task) ? 'caching_image' : 'analyzing_media'
    options.onTaskChange?.({ id: task.id, claimedAt: String(task.claimedAt || '') })
    const admission = admitTask({
      taskId: task.id,
      kind: effectiveKind,
      source: workerName,
      channelKey: task.channelKey,
      userId: String(task.payload?.userId || ''),
      exclusive: false,
    })
    if (admission.decision !== 'run_now') {
      // 资源不足时重排并返回 false，让主循环退避，避免领取和重排忙等。
      requeueMediaTask(task, String(admission.reason || admission.decision))
      return false
    }

    gateHandle = await acquireResourceGate({
      taskId: task.id,
      kind: effectiveKind,
      owner: workerName,
      channelKey: task.channelKey,
      userId: String(task.payload?.userId || ''),
      priority: task.priority,
      timeoutMs: getMediaTaskTimeoutMs(task),
      waitTimeoutMs: Number.isFinite(Number(options.gateWaitMs)) ? Number(options.gateWaitMs) : 15000,
      step,
    })
    gateHandle.updateStep(step)
    const result = await runClaimedMediaTaskWithTimeout(task)
    completeMediaTask(task, result)
    return true
  } catch (error) {
    if (!gateHandle) {
      if (isResourceGateStorageError(error)) {
        failMediaTask(task, error, 'resource_gate_storage_failed')
        throw error
      }
      // 锁等待失败也属于资源繁忙，requeue 后返回 false 退避，不立刻重抢。
      requeueMediaTask(task, error instanceof Error ? error.message : String(error || 'lock_wait_failed'))
      return false
    }
    failMediaTask(task, error, 'media_worker_failed')
    handleMediaTaskTimeout(workerName, task, error)
    return true
  } finally {
    try {
      if (gateHandle) gateHandle.release('media-worker-finally')
    } finally {
      options.onTaskChange?.(null)
    }
  }
}

export = {
  MEDIA_TASK_TIMEOUT_MS,
  drainOneMediaTask,
  runClaimedMediaTask,
  runClaimedMediaTaskWithTimeout,
  runVoiceTranscriptionTask,
}
