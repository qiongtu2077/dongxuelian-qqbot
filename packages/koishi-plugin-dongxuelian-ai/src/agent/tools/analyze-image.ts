/**
 * Agent 工具: analyze_historical_image — 分析图片历史中的某张图片。
 * 优先读本地缓存 → NapCat 缓存 → URL 下载 → 调视觉模型 → 写回分析结果。
 */
const { downloadImageAsBase64, isVisionModel, requestChatCompletions } = require('../../core/api') as typeof import('../../core/api')
const { loadConfig } = require('../../core/runtime-config') as typeof import('../../core/runtime-config')
const { markAnalyzed, getImageEntry, replaceImagePlaceholder, readCachedImage } = require('../../media/image/image-store') as typeof import('../../media/image/image-store')
const { analyzeImageNow } = require('../../media/image/image-analyzer') as typeof import('../../media/image/image-analyzer')
const { isVisionBlindnessReply } = require('../../media/image/vision') as typeof import('../../media/image/vision')

interface AnalyzeImageParams {
  url?: unknown
  messageId?: unknown
  question?: unknown
}

interface AnalyzeImageContext {
  channelKey?: string
}

interface ChatTextResult {
  content?: unknown
}

function getAnalyzeImageErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '未知错误')
}

export = {
  definition: {
    name: 'analyze_historical_image',
    description: '分析图片历史中的某张图片（通过 URL 或 messageId）。下载图片后调用视觉模型生成描述，并将结果写回对话历史。适用于用户问"刚才那张图是什么"等场景。',
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
    let url = String(params.url || '').trim()
    const messageId = String(params.messageId || '').trim()
    const question = String(params.question || '描述这张图片的内容').trim()
    let cachedFile = null

    if (!url && messageId && channelKey) {
      const entry = await getImageEntry(channelKey, messageId)
      if (entry) {
        url = entry.url
        cachedFile = entry.file || null
      }
    }
    if (messageId && channelKey) {
      const analysis = await analyzeImageNow(channelKey, messageId)
      if (analysis) return `图片分析结果：${analysis}`
    }
    if (!url) return '无法获取图片 URL。请先用 read_image_history 查看可用图片。'

    const config = await loadConfig()
    if (!isVisionModel(config.provider, config.model)) {
      return '当前模型不支持视觉分析。'
    }

    let base64 = null
    if (messageId && channelKey) {
      base64 = await readCachedImage(channelKey, messageId)
    }
    if (!base64 && cachedFile) {
      const { callGetImage, readImageAsBase64 } = require('../../core/api') as typeof import('../../core/api')
      try {
        const imgInfo = await callGetImage(cachedFile)
        if (imgInfo && typeof imgInfo.file === 'string') base64 = await readImageAsBase64(imgInfo.file)
      } catch {
        /* non-critical: cached NapCat file may be expired; fall back to URL download */
      }
    }
    if (!base64) base64 = await downloadImageAsBase64(url, 10000)
    if (!base64) return '图片下载失败或格式不支持。'

    const messages = [
      { role: 'user', content: [
        { type: 'text', text: question },
        { type: 'image_url', image_url: { url: base64 } },
      ] },
    ] as unknown as Parameters<typeof requestChatCompletions>[0]

    try {
      const result = await requestChatCompletions(messages, config, { max_tokens: 500, _timeoutMs: 15000 })
      const rawAnalysis = typeof result === 'string' ? result : String((result as ChatTextResult).content || '')
      const { sanitizeImageAnalysis } = require('../../media/image/image-analysis-sanitizer') as typeof import('../../media/image/image-analysis-sanitizer')
      const analysis = sanitizeImageAnalysis(rawAnalysis)
      if (!analysis) return '视觉模型未返回分析结果。'
      if (isVisionBlindnessReply(analysis)) {
        return `视觉模型未能解析图片（provider=${config.provider} model=${config.model}），请稍后再试或换一张图。`
      }

      if (channelKey && messageId) {
        await markAnalyzed(channelKey, messageId, analysis)
        await replaceImagePlaceholder(channelKey, messageId, analysis)
      }

      return `图片分析结果：${analysis}`
    } catch (e) {
      return `图片分析失败：${getAnalyzeImageErrorMessage(e)}`
    }
  },
  dangerous: false,
  defaultChannels: ['dashboard', 'qq'],
}
