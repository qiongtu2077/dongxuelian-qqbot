/**
 * MODULE: 图片会话标记。
 * 职责: 标记 session 是否含待处理图片、提取图片 payload、追加视觉消息到 messages。
 * 边界: 只操作 session 标记和 messages 数组尾部，不调 AI API，不改 conversation 持久层。
 */
const {
  callGetImage,
  readImageAsBase64,
  downloadImageAsBase64,
  extractImageFileFromElements,
  isVisionModel,
} = require('../../core/api') as typeof import('../../core/api')
const { extractImageUrls } = require('../../core/utils') as typeof import('../../core/utils')
const { getChannelKey } = require('../../conversation') as typeof import('../../conversation')
const { readCachedImage } = require('./image-store') as typeof import('./image-store')

const VISION_SESSION_KEYS: string[] = ['_visionUrls', '_visionFile', '_isVisionRequest']

interface SegmentLike {
  type?: string
  data?: {
    url?: unknown
    file?: unknown
  }
}

interface VisionSessionLike {
  content?: string
  quote?: {
    content?: unknown
    message?: SegmentLike[]
  }
  event?: {
    message?: SegmentLike[]
  }
  _visionUrls?: unknown
  _visionFile?: unknown
  _isVisionRequest?: unknown
  [key: string]: unknown
}

interface VisionPayload {
  urls: string[]
  file: string | null
}

interface AnalyzedMessageFlags {
  hasVisual?: boolean
  hasFile?: boolean
  hasEmbed?: boolean
}

interface PrepareVisionContext {
  content?: unknown
  allowCurrentMessage?: boolean
  includeQuote?: boolean
}

interface VisionConfig {
  provider?: string
  model?: string
}

interface VisionMessage {
  role: string
  content: string | Array<Record<string, unknown>>
}

interface AppendVisionOptions {
  promptText?: string
  readFailReply?: string
  inaccessibleReply?: string
  identifyFailReply?: string
}

interface VisionContext {
  provider?: string
  model?: string
  promptText: string
  injectedIndex: number
}

interface AppendVisionResult {
  ok: boolean
  reply?: string
  visionContext?: VisionContext
}

function getVisionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function markSessionForVision(session: VisionSessionLike | null | undefined, urls: unknown[] = [], file: unknown = null): boolean {
  const normalizedUrls = Array.isArray(urls) ? urls.map(String).filter(Boolean) : []
  const normalizedFile = file ? String(file) : null
  if (!session || (!normalizedUrls.length && !normalizedFile)) return false
  session._visionUrls = normalizedUrls
  session._visionFile = normalizedFile
  session._isVisionRequest = true
  return true
}

function getVisionPayload(session: VisionSessionLike | null | undefined): VisionPayload {
  if (!session) return { urls: [], file: null }
  return {
    urls: Array.isArray(session._visionUrls) ? session._visionUrls.filter(Boolean).map(String) : [],
    file: session._visionFile ? String(session._visionFile) : null,
  }
}

function getCurrentImageUrlsFromSegments(session: VisionSessionLike | null | undefined): string[] {
  const segments = Array.isArray(session?.event?.message) ? session.event.message : []
  return segments
    .filter(segment => segment && segment.type === 'image')
    .map(segment => segment.data && segment.data.url || '')
    .map(String)
    .filter(Boolean)
}

function isVisionSession(session: VisionSessionLike | null | undefined): boolean {
  if (!session || !session._isVisionRequest) return false
  const payload = getVisionPayload(session)
  return !!(payload.file || payload.urls.length > 0)
}

function clearVisionSession(session: VisionSessionLike | null | undefined): void {
  if (!session) return
  for (const key of VISION_SESSION_KEYS) delete session[key]
}

function getQuotedVisionPayload(session: VisionSessionLike): VisionPayload {
  let qc = ''
  let quotedFile: string | null = null
  try {
    if (typeof session.quote?.content === 'string') qc = session.quote.content
    else if (Array.isArray(session.quote?.message)) {
      qc = session.quote.message.map(s => s.data?.url || s.data?.file || '').filter(Boolean).join(' ')
      const imgSeg = session.quote.message.find(s => s.type === 'image')
      if (imgSeg && imgSeg.data?.file) quotedFile = String(imgSeg.data.file)
    }
  } catch { /* non-critical: quoted message may be absent or adapter-shaped */
  }
  if (!qc && !quotedFile) return { urls: [], file: null }
  return { urls: extractImageUrls(qc), file: quotedFile }
}

function prepareVisionRequest(session: VisionSessionLike, analyzed: AnalyzedMessageFlags = {}, context: PrepareVisionContext = {}): boolean {
  const content = context.content === undefined ? session?.content || '' : context.content
  if (context.allowCurrentMessage) {
    const urls = [...new Set(extractImageUrls(String(content || '')).concat(getCurrentImageUrlsFromSegments(session)))]
    const file = extractImageFileFromElements(session as unknown as Parameters<typeof extractImageFileFromElements>[0])
    if (markSessionForVision(session, urls, file)) return true
  }

  if (context.includeQuote !== false && !analyzed.hasVisual && !analyzed.hasFile && !analyzed.hasEmbed && session?.quote) {
    const quoted = getQuotedVisionPayload(session)
    if (markSessionForVision(session, quoted.urls, quoted.file)) return true
  }

  return isVisionSession(session)
}

async function appendVisionMessage(messages: VisionMessage[], session: VisionSessionLike, config: VisionConfig, ctx: { logger: (name: string) => { warn: (message: string) => void } }, options: AppendVisionOptions = {}): Promise<AppendVisionResult> {
  const payload = getVisionPayload(session)
  const promptText = options.promptText || ''
  const readFailReply = options.readFailReply || '图片读取失败。'
  const inaccessibleReply = options.inaccessibleReply || '图片无法访问。'
  const identifyFailReply = options.identifyFailReply || '图片识别失败。'
  const visionContext: VisionContext = { provider: config && config.provider, model: config && config.model, promptText, injectedIndex: -1 }

  try {
    const vc2 = config
    const visionModelEnabled = isVisionModel(String(vc2.provider || ''), String(vc2.model || ''))
    const channelKey = getChannelKey(session as unknown as Parameters<typeof getChannelKey>[0])
    const messageId = session?.messageId ? String(session.messageId) : ''
    let localPath: string | null = null
    let cachedImageTried = false
    let localReadFailed = false
    const pushVisionImage = (imgBase64: string): AppendVisionResult => {
      visionContext.injectedIndex = messages.push({
        role: 'user',
        content: [
          { type: 'text', text: promptText },
          { type: 'image_url', image_url: { url: imgBase64 } },
        ],
      }) - 1
      return { ok: true, visionContext }
    }
    const tryReadCachedCurrentImage = async (): Promise<string | null> => {
      if (cachedImageTried || !visionModelEnabled || !channelKey || !messageId) return null
      cachedImageTried = true
      return readCachedImage(channelKey, messageId)
    }
    if (payload.file) {
      const imgInfo = await callGetImage(payload.file)
      if (imgInfo && imgInfo.file) localPath = String(imgInfo.file)
    }
    if (visionModelEnabled && localPath) {
      const imgBase64 = await readImageAsBase64(localPath)
      if (imgBase64) return pushVisionImage(imgBase64)
      localReadFailed = true
    }
    if (payload.file) {
      const cachedBase64 = await tryReadCachedCurrentImage()
      if (cachedBase64) return pushVisionImage(cachedBase64)
    }
    const visionUrl = payload.urls && payload.urls[0]
    if (visionUrl) {
      const imgBase64 = await downloadImageAsBase64(visionUrl, 10000)
      if (imgBase64 && visionModelEnabled) return pushVisionImage(imgBase64)
      const cachedBase64 = await tryReadCachedCurrentImage()
      if (cachedBase64) return pushVisionImage(cachedBase64)
      return { ok: false, reply: inaccessibleReply }
    }
    if (localReadFailed) return { ok: false, reply: readFailReply }
    return { ok: false, reply: inaccessibleReply }
  } catch (error) {
    ctx.logger('dongxuelian-ai').warn('Vision: ' + getVisionErrorMessage(error))
    return { ok: false, reply: identifyFailReply }
  } finally {
    clearVisionSession(session)
  }
}

// 模型实际没解析到 image_url 时的"我看不到"反驳。命中条件：短回复 + 否定词 + (求重发 / 不接茬意图)。
// 单独"图太糊看不清"这种正常吐槽不算（会带描述/形容词，长度也常 > 阈值）。
const VISION_BLINDNESS_NEGATIVE_RE: RegExp = /(?:看不(?:到|见)|没法看(?:到|见)?|没看(?:到|见)|无法(?:看|查看|识别)|看不出来是什么图|没收到图|没有图)/
const VISION_BLINDNESS_RESEND_RE: RegExp = /(?:再发一(?:次|遍|张)|重新发|换个图|发(?:一)?张图|发清楚点|描述一下)/

function isVisionBlindnessReply(reply: string = ''): boolean {
  const text = String(reply || '').trim()
  if (!text) return false
  if (text.length > 60) return false
  if (!VISION_BLINDNESS_NEGATIVE_RE.test(text)) return false
  return VISION_BLINDNESS_RESEND_RE.test(text) || text.length <= 20
}

// 把已 push 的多模态 user 消息降级为纯文本占位，让模型按文本上下文再答一次。
function downgradeVisionMessageToText(messages: VisionMessage[], visionContext: Partial<VisionContext> | null | undefined, fallbackText: string): boolean {
  if (!visionContext || !Array.isArray(messages)) return false
  const idx = Number(visionContext.injectedIndex)
  if (!Number.isInteger(idx) || idx < 0 || idx >= messages.length) return false
  const target = messages[idx]
  if (!target || target.role !== 'user' || !Array.isArray(target.content)) return false
  messages[idx] = { role: 'user', content: String(fallbackText || '[图片暂时取不到，请按当前文字上下文回复，不要假设你看到了什么图]') }
  return true
}

export = {
  VISION_SESSION_KEYS,
  markSessionForVision,
  isVisionSession,
  getVisionPayload,
  clearVisionSession,
  prepareVisionRequest,
  appendVisionMessage,
  isVisionBlindnessReply,
  downgradeVisionMessageToText,
}
