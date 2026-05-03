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
} = require('./api')
const { extractImageUrls } = require('./utils')

const VISION_SESSION_KEYS = ['_visionUrls', '_visionFile', '_isVisionRequest']

function markSessionForVision(session, urls = [], file = null) {
  const normalizedUrls = Array.isArray(urls) ? urls.map(String).filter(Boolean) : []
  const normalizedFile = file ? String(file) : null
  if (!session || (!normalizedUrls.length && !normalizedFile)) return false
  session._visionUrls = normalizedUrls
  session._visionFile = normalizedFile
  session._isVisionRequest = true
  return true
}

function getVisionPayload(session) {
  if (!session) return { urls: [], file: null }
  return {
    urls: Array.isArray(session._visionUrls) ? session._visionUrls.filter(Boolean) : [],
    file: session._visionFile || null,
  }
}

function isVisionSession(session) {
  if (!session || !session._isVisionRequest) return false
  const payload = getVisionPayload(session)
  return !!(payload.file || payload.urls.length > 0)
}

function clearVisionSession(session) {
  if (!session) return
  for (const key of VISION_SESSION_KEYS) delete session[key]
}

function getQuotedVisionPayload(session) {
  let qc = ''
  let quotedFile = null
  try {
    if (typeof session.quote.content === 'string') qc = session.quote.content
    else if (Array.isArray(session.quote.message)) {
      qc = session.quote.message.map(s => s.data?.url || s.data?.file || '').filter(Boolean).join(' ')
      const imgSeg = session.quote.message.find(s => s.type === 'image')
      if (imgSeg && imgSeg.data?.file) quotedFile = imgSeg.data.file
    }
  } catch {}
  if (!qc && !quotedFile) return { urls: [], file: null }
  return { urls: extractImageUrls(qc), file: quotedFile }
}

function prepareVisionRequest(session, analyzed = {}, context = {}) {
  const content = context.content === undefined ? session?.content || '' : context.content
  if (context.allowCurrentMessage) {
    const urls = extractImageUrls(content || '')
    const file = extractImageFileFromElements(session)
    if (markSessionForVision(session, urls, file)) return true
  }

  if (context.includeQuote !== false && !analyzed.hasVisual && !analyzed.hasFile && !analyzed.hasEmbed && session?.quote) {
    const quoted = getQuotedVisionPayload(session)
    if (markSessionForVision(session, quoted.urls, quoted.file)) return true
  }

  return isVisionSession(session)
}

async function appendVisionMessage(messages, session, config, ctx, options = {}) {
  const payload = getVisionPayload(session)
  const promptText = options.promptText || ''
  const readFailReply = options.readFailReply || '图片读取失败。'
  const inaccessibleReply = options.inaccessibleReply || '图片无法访问。'
  const identifyFailReply = options.identifyFailReply || '图片识别失败。'

  try {
    const vc2 = config
    let localPath = null
    if (payload.file) {
      const imgInfo = await callGetImage(payload.file)
      if (imgInfo && imgInfo.file) localPath = imgInfo.file
    }
    if (isVisionModel(vc2.provider, vc2.model) && localPath) {
      const imgBase64 = await readImageAsBase64(localPath)
      if (imgBase64) {
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: promptText },
            { type: 'image_url', image_url: { url: imgBase64 } },
          ],
        })
        return { ok: true }
      }
      return { ok: false, reply: readFailReply }
    }
    const visionUrl = payload.urls && payload.urls[0]
    if (visionUrl) {
      const imgBase64 = await downloadImageAsBase64(visionUrl, 10000)
      if (imgBase64 && isVisionModel(vc2.provider, vc2.model)) {
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: promptText },
            { type: 'image_url', image_url: { url: imgBase64 } },
          ],
        })
        return { ok: true }
      }
      return { ok: false, reply: inaccessibleReply }
    }
    return { ok: false, reply: inaccessibleReply }
  } catch (error) {
    ctx.logger('dongxuelian-ai').warn('Vision: ' + (error && error.message ? error.message : error))
    return { ok: false, reply: identifyFailReply }
  } finally {
    clearVisionSession(session)
  }
}

module.exports = {
  VISION_SESSION_KEYS,
  markSessionForVision,
  isVisionSession,
  getVisionPayload,
  clearVisionSession,
  prepareVisionRequest,
  appendVisionMessage,
}
