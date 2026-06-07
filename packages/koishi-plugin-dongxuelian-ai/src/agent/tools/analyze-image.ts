/**
 * Agent 工具: analyze_historical_image — 分析图片历史中的某张图片。
 * 优先读已有分析缓存；未命中时写入 S6 媒体背压队列。
 */
const { getImageEntry, getCachedAnalysis, storeImageUrl } = require('../../media/image/image-store') as typeof import('../../media/image/image-store')
const { enqueueMediaTask } = require('../../media/backpressure/media-queue') as typeof import('../../media/backpressure/media-queue')
const { admitTask } = require('../../resource-scheduler/admission') as typeof import('../../resource-scheduler/admission')

interface AnalyzeImageParams {
  url?: unknown
  messageId?: unknown
  question?: unknown
}

interface AnalyzeImageContext {
  channelKey?: string
  userId?: string
}

// 为 URL 直传图片生成稳定的媒体任务 messageId，供 S6 去重和展示。
function createAgentImageMessageId(messageId: string, url: string): string {
  if (messageId) return messageId
  let hash = 0
  for (const char of String(url || '')) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0
  return `agent-url-${Math.abs(hash).toString(36) || Date.now().toString(36)}`
}

export = {
  definition: {
    name: 'analyze_historical_image',
    description: '读取图片历史中的已有分析结果；没有缓存时将图片加入媒体分析队列。适用于用户问"刚才那张图是什么"等场景。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '图片 URL（优先使用）' },
        messageId: { type: 'string', description: '图片消息 ID（从 read_image_history 获取）' },
        question: { type: 'string', description: '用户关于这张图的问题，如"这是什么"、"图里写了什么"' },
      },
      required: [] as string[],
    },
  },
  async execute(params: AnalyzeImageParams = {}, context: AnalyzeImageContext = {}): Promise<string> {
    const channelKey = context.channelKey || ''
    const userId = context.userId || ''
    let url = String(params.url || '').trim()
    const messageId = String(params.messageId || '').trim()
    let mediaMessageId = createAgentImageMessageId(messageId, url)
    let cachedFile = null

    if (!url && messageId && channelKey) {
      const entry = await getImageEntry(channelKey, messageId)
      if (entry) {
        url = entry.url
        cachedFile = entry.file || null
      }
    }
    if (messageId && channelKey) {
      const cachedAnalysis = await getCachedAnalysis(channelKey, messageId)
      if (cachedAnalysis) return `图片分析结果：${cachedAnalysis}`
    }
    if (!url) return '无法获取图片 URL。请先用 read_image_history 查看可用图片。'
    mediaMessageId = createAgentImageMessageId(messageId, url)
    if (channelKey) {
      await storeImageUrl(channelKey, mediaMessageId, url, cachedFile, { conversationKey: channelKey, userId })
    }
    enqueueMediaTask({
      kind: 'media_image_analysis',
      channelKey,
      messageId: mediaMessageId,
      url,
      payload: { entry: 'agent-tool-analyze-image', userId, originalMessageId: messageId },
    })
    const admission = admitTask({
      kind: 'media_image_analysis',
      source: 'agent-tool',
      channelKey,
      userId,
      exclusive: false,
    })
    const reason = admission.decision === 'run_now' ? 'media-worker 空闲时会处理' : admission.reason
    return `图片已加入媒体分析队列，当前资源状态为 ${admission.resourceState}，原因：${reason}。稍后可通过 read_image_history 查看结果。`
  },
  dangerous: false,
  defaultChannels: ['dashboard', 'qq'],
}
