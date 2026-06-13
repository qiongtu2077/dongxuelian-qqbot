/**
 * MODULE: S6 媒体分析请求辅助。
 * 职责: 将显式图片/文件分析请求写入 S6 队列并记录 S1 准入事件。
 * 边界: 不下载、不解析、不调用视觉或文件分析模型。
 */
const { admitTask } = require('../../resource-scheduler/admission') as typeof import('../../resource-scheduler/admission')
const { enqueueMediaTask } = require('./media-queue') as typeof import('./media-queue')

interface AdmissionDecisionLike {
  decision?: string
  reason?: string
  resourceState?: string
  botMode?: string
}

type QueuedMediaTaskLike = Record<string, unknown> | null

interface QueueFileAnalysisInput {
  channelKey: string
  messageId: string
  url?: string
  fileId?: string | null
  fileName?: string
  fileSize?: number
  ext?: string
  userId?: string
  source?: string
}

// 将文件分析请求写入 S6 队列，并返回 S1 准入状态。
function queueFileAnalysisRequest(input: QueueFileAnalysisInput): { admission: AdmissionDecisionLike; queued: QueuedMediaTaskLike } {
  const channelKey = String(input.channelKey || '')
  const messageId = String(input.messageId || '')
  const userId = String(input.userId || '')
  const source = String(input.source || 'media-request')
  const admission = admitTask({
    kind: 'media_file_analysis',
    source,
    channelKey,
    userId,
    exclusive: false,
  })
  const queued = shouldEnqueueMediaForAdmission(admission)
    ? enqueueMediaTask({
      kind: 'media_file_analysis',
      channelKey,
      messageId,
      url: String(input.url || ''),
      fileId: input.fileId || null,
      payload: {
        entry: source,
        fileName: String(input.fileName || ''),
        fileSize: Number(input.fileSize) || 0,
        ext: String(input.ext || ''),
        userId,
      },
    })
    : null
  return { admission, queued }
}

// 判断 admission 结果是否仍允许前门写入 S6 pending。
function shouldEnqueueMediaForAdmission(admission: AdmissionDecisionLike | null | undefined): boolean {
  const decision = String(admission?.decision || '')
  if (decision === 'run_now' || decision === 'queue' || decision === 'downgrade') return true
  if (decision !== 'defer') return false
  const botMode = String(admission?.botMode || '')
  const resourceState = String(admission?.resourceState || '')
  const reason = String(admission?.reason || '')
  if (resourceState === 'red' || resourceState === 'black') return false
  return botMode === 'report_silent' ||
    reason === 'media drain paused during daily report' ||
    (resourceState === 'yellow' && reason === 'media is throttled in yellow state') ||
    (resourceState === 'green' && /daily report/i.test(reason))
}

// 生成低成本文件排队提示，不调用 AI。
function formatFileQueuedReply(admission: AdmissionDecisionLike): string {
  const reason = admission?.decision === 'run_now' ? 'media-worker 空闲时会处理' : String(admission?.reason || admission?.decision || '已排队')
  if (!shouldEnqueueMediaForAdmission(admission)) {
    return `当前资源状态为 ${admission?.resourceState || 'unknown'}，暂时不能加入媒体分析队列，原因：${reason}。请稍后再试。`
  }
  return `这个文件已加入媒体分析队列，当前资源状态为 ${admission?.resourceState || 'unknown'}，原因：${reason}。稍后再读取即可。`
}

export = {
  queueFileAnalysisRequest,
  formatFileQueuedReply,
  shouldEnqueueMediaForAdmission,
}
