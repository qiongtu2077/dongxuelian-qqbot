/**
 * MODULE: incoming-message-flow
 * 职责: 处理入站图片、文件、语音的落库/分析排队，并返回补全后的 plain 文本。
 * 边界: 不发送消息、不注册 middleware、不调用 chat/Agent；只做当前消息的入站材料处理。
 * 状态: 无模块级状态。
 */
const { getConversationKey } = require('../conversation') as typeof import('../conversation')
const {
  extractImageRefFromContent,
  getMessageSegments,
  normalizeSegmentData,
  getFileSegmentData,
} = require('./message-segment') as typeof import('./message-segment')
const { storeImageUrl } = require('../media/image/image-store') as typeof import('../media/image/image-store')
const { enqueueAnalysis } = require('../media/image/image-analyzer') as typeof import('../media/image/image-analyzer')
const { storeFile } = require('../media/file/file-store') as typeof import('../media/file/file-store')
const { checkFile, getExtension, sanitizeFileName } = require('../media/file/file-safety') as typeof import('../media/file/file-safety')
const { cacheSmallFileBackground } = require('../media/file/incoming-file') as typeof import('../media/file/incoming-file')
const { transcribeVoice } = require('../media/voice/voice') as typeof import('../media/voice/voice')
const { loadConfig } = require('../core/runtime-config') as typeof import('../core/runtime-config')
const { logStickerShadowIngestDiagnostic } = require('../diagnostics/diagnostics') as typeof import('../diagnostics/diagnostics')

interface IncomingSession {
  userId?: string
  author?: { id?: string }
  username?: string
  content?: string
  isDirect?: boolean
  messageId?: string
  guildId?: string
  channelId?: string
  event?: {
    message?: Array<{ type?: string; data?: { url?: unknown; file?: unknown; [key: string]: unknown }; [key: string]: unknown }>
  }
  elements?: unknown[]
}

interface IncomingAnalysis {
  hasVisual?: boolean
  hasFile?: boolean
  hasAudio?: boolean
  [key: string]: unknown
}

interface IncomingContext {
  [key: string]: unknown
  logger?: (name: string) => { warn?: (message: string) => void }
}

interface ImageArtifactOptions {
  ctx: IncomingContext | null | undefined
  session: IncomingSession
  analyzed: IncomingAnalysis
  plain: string
  content: string
  channelKey: string
}

interface FileArtifactOptions {
  session: IncomingSession
  analyzed: IncomingAnalysis
  plain: string
  channelKey: string
}

interface AudioArtifactOptions {
  ctx?: IncomingContext | null
  session: IncomingSession
  analyzed: IncomingAnalysis
  plain: string
  directAt?: boolean
}

interface IncomingMessageArtifactOptions extends ImageArtifactOptions {
  directAt?: boolean
}

type VoiceConfigInput = Parameters<typeof transcribeVoice>[1]

function getIncomingUserId(session: IncomingSession): string {
  return session.userId || session.author?.id || session.username || ''
}

function getIncomingMessageFlowErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function warnIncomingAudioFailure(ctx: IncomingContext | null | undefined, error: unknown): void {
  const message = `[incoming-message-flow] asr failed: ${getIncomingMessageFlowErrorMessage(error)}`
  const logger = ctx && typeof ctx.logger === 'function' ? ctx.logger('dongxuelian-ai') : null
  if (logger && typeof logger.warn === 'function') {
    logger.warn(message)
    return
  }
  console.warn(message)
}

async function handleIncomingImage({ ctx, session, analyzed, plain, content, channelKey }: ImageArtifactOptions): Promise<string> {
  if (!analyzed.hasVisual || !channelKey || !session.messageId) return plain
  const segments = getMessageSegments(session)
  const imgSeg = segments.find(s => ['image', 'img'].includes(String(s && typeof s === 'object' && 'type' in s ? s.type || '' : '')))
  const imgData = normalizeSegmentData(imgSeg)
  const imgFile = imgData.file || null
  const imgUrl = String(imgData.url || '')
  const imageMeta = {
    conversationKey: getConversationKey(session),
    userId: getIncomingUserId(session),
  }
  const contentImageRef = extractImageRefFromContent(content)
  const storableUrl = /^https?:\/\//i.test(imgUrl) ? imgUrl : contentImageRef.url
  const storableFile = imgFile || contentImageRef.file || ''
  await storeImageUrl(channelKey, session.messageId, storableUrl || '', storableFile || null, imageMeta)
  logStickerShadowIngestDiagnostic(ctx as Parameters<typeof logStickerShadowIngestDiagnostic>[0], {
    session,
    channelKey,
    userId: imageMeta.userId,
    messageId: session.messageId,
    content,
    analyzed,
    segments,
    imageMeta: {
      conversationKey: imageMeta.conversationKey,
      hasUserId: !!imageMeta.userId,
    },
  })
  await enqueueAnalysis(channelKey, session.messageId)
  return plain.includes('[图片]') ? plain : (plain ? plain + ' ' : '') + '[图片]'
}

async function handleIncomingFile({ session, analyzed, plain, channelKey }: FileArtifactOptions): Promise<string> {
  if (!analyzed.hasFile || !channelKey || !session.messageId) return plain
  const fileData = getFileSegmentData(session)
  if (!fileData) return plain
  const fileName = String(fileData.name || fileData.fileName || fileData.filename || fileData.file || 'unknown')
  const fileSize = Number(fileData.size) || 0
  const fileUrl = String(fileData.url || '')
  const fileIdValue = fileData.file || fileData.id || fileData.fileId || fileData.file_id || null
  const fileId = fileIdValue === null || fileIdValue === undefined || fileIdValue === '' ? null : String(fileIdValue)
  const ext = getExtension(fileName)
  const safety = checkFile(fileName, fileSize)
  const safeName = sanitizeFileName(fileName)
  const fileMeta = {
    fileName: safeName,
    fileSize,
    mimeType: String(fileData.mime || fileData.mimeType || ''),
    ext,
    url: fileUrl,
    fileId,
    conversationKey: getConversationKey(session),
    userId: getIncomingUserId(session),
    skipped: !safety.allowed,
    skipReason: safety.reason || null,
  }
  await storeFile(channelKey, session.messageId, fileMeta)
  if (plain.includes('[文件]')) return plain
  if (safety.allowed) {
    if (fileUrl && fileSize <= 1024 * 1024) cacheSmallFileBackground(channelKey, session.messageId, fileUrl, ext)
    return (plain ? plain + ' ' : '') + `[文件: ${safeName} (fileId:${session.messageId})]`
  }
  return (plain ? plain + ' ' : '') + `[文件: ${safeName} - 已跳过${safety.reason ? '(' + safety.reason + ')' : ''}]`
}

async function resolveIncomingAudioPlain({ ctx, session, analyzed, plain, directAt }: AudioArtifactOptions): Promise<string> {
  if (!analyzed.hasAudio || (!session.isDirect && !directAt)) return plain
  try {
    const cfg = await loadConfig()
    const voiceConfig: VoiceConfigInput = {
      apiKey: cfg.apiKey,
      model: cfg.model,
      provider: cfg.provider,
      baseURL: cfg.baseURL,
    }
    const transcribed = await Promise.race([
      transcribeVoice(session, voiceConfig),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('asr timeout')), 10000)),
    ])
    return transcribed ? `[语音转文字：${transcribed}]` : '[语音消息]'
  } catch (error) {
    warnIncomingAudioFailure(ctx, error)
    return '[语音消息]'
  }
}

async function handleIncomingMessageArtifacts({ ctx, session, analyzed, plain, content, channelKey, directAt }: IncomingMessageArtifactOptions): Promise<string> {
  let nextPlain = plain
  nextPlain = await handleIncomingImage({ ctx, session, analyzed, plain: nextPlain, content, channelKey })
  nextPlain = await handleIncomingFile({ session, analyzed, plain: nextPlain, channelKey })
  nextPlain = await resolveIncomingAudioPlain({ ctx, session, analyzed, plain: nextPlain, directAt })
  return nextPlain
}

export = {
  handleIncomingMessageArtifacts,
}
