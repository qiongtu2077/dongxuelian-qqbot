/**
 * MODULE: 后台图片分析。
 * 职责: 异步下载图片 → 缓存本地 → 调视觉模型分析 → 写回 image-store + 替换占位符。
 * 边界: 全程静默，不发消息，不阻塞 chat/agent。
 * 状态: 内存并发队列。
 */
const { downloadImageAsBase64, callGetImage, readImageAsBase64, isVisionModel, requestChatCompletions } = require('./api')
const { loadConfig } = require('./runtime-config')
const { markAnalyzed, replaceImagePlaceholder, cacheImageFile, readCachedImage, getImageEntry } = require('./image-store')

const MAX_CONCURRENT = 2
const ANALYSIS_TIMEOUT_MS = 20000

let activeCount = 0
const queue = []

function enqueueAnalysis(channelKey, messageId) {
  if (!channelKey || !messageId) return
  const entry = getImageEntry(channelKey, messageId)
  if (!entry || entry.analyzed) return
  queue.push({ channelKey, messageId, url: entry.url, file: entry.file })
  drainQueue()
}

function drainQueue() {
  while (activeCount < MAX_CONCURRENT && queue.length > 0) {
    const task = queue.shift()
    activeCount++
    runAnalysis(task).finally(() => {
      activeCount--
      drainQueue()
    })
  }
}

async function runAnalysis({ channelKey, messageId, url, file }) {
  try {
    let base64 = readCachedImage(channelKey, messageId)

    if (!base64 && file) {
      try {
        const imgInfo = await callGetImage(file)
        if (imgInfo && imgInfo.file) {
          base64 = await readImageAsBase64(imgInfo.file)
          if (base64) {
            const buf = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64')
            cacheImageFile(channelKey, messageId, buf)
          }
        }
      } catch {}
    }

    if (!base64 && url) {
      base64 = await downloadImageAsBase64(url, 10000)
      if (base64) {
        const buf = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64')
        cacheImageFile(channelKey, messageId, buf)
      }
    }

    if (!base64) return

    const config = await loadConfig()
    if (!isVisionModel(config.provider, config.model)) return

    const messages = [
      { role: 'user', content: [
        { type: 'text', text: '简要描述这张图片的内容（50字以内）。' },
        { type: 'image_url', image_url: { url: base64 } },
      ] },
    ]

    const result = await requestChatCompletions(messages, config, { max_tokens: 200, _timeoutMs: ANALYSIS_TIMEOUT_MS })
    const analysis = typeof result === 'string' ? result : (result && result.content || '')
    if (!analysis) return

    markAnalyzed(channelKey, messageId, analysis)
    replaceImagePlaceholder(channelKey, messageId, analysis)
  } catch {}
}

module.exports = {
  enqueueAnalysis,
}
