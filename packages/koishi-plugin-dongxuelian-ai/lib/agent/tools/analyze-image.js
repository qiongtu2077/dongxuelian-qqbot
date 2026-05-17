/**
 * Agent 工具: analyze_historical_image — 分析图片历史中的某张图片。
 * 优先读本地缓存 → NapCat 缓存 → URL 下载 → 调视觉模型 → 写回分析结果。
 */
const { downloadImageAsBase64, isVisionModel } = require('../../api')
const { requestChatCompletions } = require('../../api')
const { loadConfig } = require('../../runtime-config')
const { markAnalyzed, getImageEntry, replaceImagePlaceholder, readCachedImage } = require('../../image-store')

module.exports = {
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
      required: [],
    },
  },
  async execute(params = {}, context = {}) {
    const channelKey = context.channelKey || ''
    let url = String(params.url || '').trim()
    const messageId = String(params.messageId || '').trim()
    const question = String(params.question || '描述这张图片的内容').trim()
    let cachedFile = null

    if (!url && messageId && channelKey) {
      const entry = getImageEntry(channelKey, messageId)
      if (entry) {
        url = entry.url
        cachedFile = entry.file || null
      }
    }
    if (!url) return '无法获取图片 URL。请先用 read_image_history 查看可用图片。'

    const config = await loadConfig()
    if (!isVisionModel(config.provider, config.model)) {
      return '当前模型不支持视觉分析。'
    }

    let base64 = null
    if (messageId && channelKey) {
      base64 = readCachedImage(channelKey, messageId)
    }
    if (!base64 && cachedFile) {
      const { callGetImage, readImageAsBase64 } = require('../../api')
      try {
        const imgInfo = await callGetImage(cachedFile)
        if (imgInfo && imgInfo.file) base64 = await readImageAsBase64(imgInfo.file)
      } catch {}
    }
    if (!base64) base64 = await downloadImageAsBase64(url, 10000)
    if (!base64) return '图片下载失败或格式不支持。'

    const messages = [
      { role: 'user', content: [
        { type: 'text', text: question },
        { type: 'image_url', image_url: { url: base64 } },
      ] },
    ]

    try {
      const result = await requestChatCompletions(messages, config, { max_tokens: 500, _timeoutMs: 15000 })
      const analysis = typeof result === 'string' ? result : (result.content || '')
      if (!analysis) return '视觉模型未返回分析结果。'

      if (channelKey && messageId) {
        markAnalyzed(channelKey, messageId, analysis)
        replaceImagePlaceholder(channelKey, messageId, analysis)
      }

      return `图片分析结果：${analysis}`
    } catch (e) {
      return `图片分析失败：${e.message || '未知错误'}`
    }
  },
  dangerous: false,
  defaultChannels: ['dashboard', 'qq'],
}
