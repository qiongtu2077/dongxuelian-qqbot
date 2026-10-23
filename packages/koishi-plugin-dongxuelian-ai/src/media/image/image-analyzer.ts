/**
 * MODULE: 按需后台图片分析。
 * 职责: 校验获准的图片需求、共用原图和识别所有权，按问题识别并保存客观结果。
 * 边界: 不接受仅因入站产生的分析，不创建内存任务队列，不发送消息。
 */
const { isVisionModel, requestChatCompletions } = require('../../core/api') as typeof import('../../core/api')
const { loadCapabilityConfig } = require('../../core/runtime-config') as typeof import('../../core/runtime-config')
const { markAnalyzed, replaceImagePlaceholder, getImageEntry } = require('./image-store') as typeof import('./image-store')
const { readImageSource } = require('./image-source') as typeof import('./image-source')
const { acquireImageRequest } = require('./image-request') as typeof import('./image-request')
const { sanitizeImageAnalysis } = require('./image-analysis-sanitizer') as typeof import('./image-analysis-sanitizer')
const { isVisionBlindnessReply } = require('./vision') as typeof import('./vision')
const { isRandomImageDemandValid } = require('./image-random-demand') as typeof import('./image-random-demand')

const ANALYSIS_TIMEOUT_MS = 20000

interface ImageAnalysisOptions {
  source?: 'explicit-image' | 'random-image' | 'history-tool'
  question?: string
  force?: boolean
  randomAuthorization?: unknown
}

// 返回不改变分析状态的错误说明。
function getImageAnalyzerErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// 保留旧导出供内部迁移；没有明确来源的旧调用不会取得识图权限。
async function enqueueAnalysis(channelKey: string, messageId: string, options: ImageAnalysisOptions = {}): Promise<void> {
  if (options.source) await analyzeImageNow(channelKey, messageId, options)
}

// 执行获准的识别；细节问题独立缓存，不被旧短摘要吞掉。
async function analyzeImageNow(channelKey: string, messageId: string, options: ImageAnalysisOptions = {}): Promise<string | null> {
  if (!channelKey || !messageId || !options.source) return null
  if (options.source === 'random-image' && !isRandomImageDemandValid(channelKey, messageId, options.randomAuthorization)) return null
  const request = await acquireImageRequest(channelKey, messageId, { ...options, source: options.source })
  if (request.status === 'reused') return request.analysis
  if (request.status !== 'owned') return null
  try {
    const base64 = await readImageSource(channelKey, messageId)
    if (!base64 || !await getImageEntry(channelKey, messageId)) return null

    const config = await loadCapabilityConfig('vision')
    if (!isVisionModel(config.provider, config.model)) return null

    const question = String(options.question || '').trim().slice(0, 4000)
    const prompt = question
      ? `请根据这张图片客观回答以下问题，读取问题所需文字和细节。无法确认的内容明确说明，不能根据旧摘要补猜；不要角色扮演、称呼用户或追加聊天。问题：${question}`
      : '只描述图片中客观看到的内容，50字以内。不要称呼用户，不要续聊，不要评价好不好玩，不要角色扮演语气。'
    const messages = [
      { role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: base64 } },
      ] },
    ]

    // 下载及配置读取可能耗时，随机需求须在实际请求上游之前重新确认未被新消息撤销。
    if (options.source === 'random-image' && !isRandomImageDemandValid(channelKey, messageId, options.randomAuthorization)) return null
    const result = await requestChatCompletions(messages, config, {
      max_tokens: question ? 1800 : 200, _timeoutMs: ANALYSIS_TIMEOUT_MS, _imageRequest: request.diagnostic,
      // API 的每个备用节点提交前都会调用此钩子；失效不能在备用链继续消耗视觉请求。
      ...(options.source === 'random-image' ? { _onRequestAttempt: () => {
        if (!isRandomImageDemandValid(channelKey, messageId, options.randomAuthorization)) throw new Error('随机图片话题已过时，已取消后续视觉请求')
      } } : {}),
    })
    const rawAnalysis = result.type === 'text' ? result.content.trim() : ''
    // 细节结果不使用短摘要净化器截断全文，仍拒绝声称没有看到图片的回答。
    const analysis = question ? rawAnalysis.slice(0, 8000) : sanitizeImageAnalysis(rawAnalysis)
    if (!analysis) return null
    if (isVisionBlindnessReply(analysis)) {
      console.warn(`[image-analyzer] vision blindness, skipping write. provider=${config.provider} model=${config.model} reply=${analysis.slice(0, 60)}`)
      return null
    }

    if (!await getImageEntry(channelKey, messageId)) return null
    if (!options.force) {
      const summary = sanitizeImageAnalysis(analysis)
      if (summary) {
        await markAnalyzed(channelKey, messageId, summary)
        await replaceImagePlaceholder(channelKey, messageId, summary)
      }
    }
    await request.complete(analysis)
    return analysis
  } catch (e) {
    console.warn('[image-analyzer] analysis failed:', getImageAnalyzerErrorMessage(e))
    return null
  } finally { await request.release() }
}

export = {
  enqueueAnalysis,
  analyzeImageNow,
}
