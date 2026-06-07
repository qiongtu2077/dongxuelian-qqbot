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
  getVoiceSegmentData,
} = require('./message-segment') as typeof import('./message-segment')
const { storeImageUrl } = require('../media/image/image-store') as typeof import('../media/image/image-store')
const { storeFile } = require('../media/file/file-store') as typeof import('../media/file/file-store')
const { checkFile, getExtension, sanitizeFileName } = require('../media/file/file-safety') as typeof import('../media/file/file-safety')
const { storeVoice, getCachedTranscript } = require('../media/voice/voice-store') as typeof import('../media/voice/voice-store')
const { enqueueMediaTask } = require('../media/backpressure/media-queue') as typeof import('../media/backpressure/media-queue')
const { admitTask } = require('../resource-scheduler/admission') as typeof import('../resource-scheduler/admission')
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
  queueMedia?: boolean
}

interface FileArtifactOptions {
  session: IncomingSession
  analyzed: IncomingAnalysis
  plain: string
  channelKey: string
  queueMedia?: boolean
}

interface AudioArtifactOptions {
  ctx?: IncomingContext | null
  session: IncomingSession
  analyzed: IncomingAnalysis
  plain: string
  channelKey: string
  directAt?: boolean
  queueMedia?: boolean
}

interface IncomingMessageArtifactOptions extends ImageArtifactOptions {
  directAt?: boolean
}

function getIncomingUserId(session: IncomingSession): string {
  return session.userId || session.author?.id || session.username || ''
}

function getIncomingMessageFlowErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function warnIncomingAudioFailure(ctx: IncomingContext | null | undefined, error: unknown): void {
  const message = `[incoming-message-flow] voice ingest failed: ${getIncomingMessageFlowErrorMessage(error)}`
  const logger = ctx && typeof ctx.logger === 'function' ? ctx.logger('dongxuelian-ai') : null
  if (logger && typeof logger.warn === 'function') {
    logger.warn(message)
    return
  }
  console.warn(message)
}

async function handleIncomingImage({ ctx, session, analyzed, plain, content, channelKey, queueMedia = true }: ImageArtifactOptions): Promise<string> {
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
  if (queueMedia) {
    enqueueMediaTask({
      kind: 'media_image_analysis',
      channelKey,
      messageId: session.messageId,
      url: String(storableUrl || storableFile || ''),
      payload: { conversationKey: imageMeta.conversationKey, userId: imageMeta.userId },
    })
    admitTask({ kind: 'media_image_analysis', source: 'koishi-worker', channelKey, userId: imageMeta.userId, exclusive: false })
  }
  return plain.includes('[图片]') ? plain : (plain ? plain + ' ' : '') + '[图片]'
}

async function handleIncomingFile({ session, analyzed, plain, channelKey, queueMedia = true }: FileArtifactOptions): Promise<string> {
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
    if (queueMedia) {
      enqueueMediaTask({
        kind: 'media_file_analysis',
        channelKey,
        messageId: session.messageId,
        url: fileUrl,
        fileId,
        payload: { fileName: safeName, fileSize, ext, userId: fileMeta.userId },
      })
      admitTask({ kind: 'media_file_analysis', source: 'koishi-worker', channelKey, userId: fileMeta.userId, exclusive: false })
    }
    return (plain ? plain + ' ' : '') + `[文件: ${safeName} (fileId:${session.messageId})]`
  }
  return (plain ? plain + ' ' : '') + `[文件: ${safeName} - 已跳过${safety.reason ? '(' + safety.reason + ')' : ''}]`
}

async function resolveIncomingAudioPlain({ ctx, session, analyzed, plain, channelKey, directAt, queueMedia = true }: AudioArtifactOptions): Promise<string> {
  if (!analyzed.hasAudio) return plain
  const shouldTranscribe = !!(session.isDirect || directAt)
  try {
    if (!channelKey || !session.messageId) return plain || '[语音消息]'
    const voiceData = getVoiceSegmentData(session) || {}
    const voiceUrl = String(voiceData.url || voiceData.src || '')
    const voiceFileValue = voiceData.file || voiceData.id || voiceData.fileId || voiceData.file_id || null
    const voiceFile = voiceFileValue === null || voiceFileValue === undefined || voiceFileValue === '' ? null : String(voiceFileValue)
    const userId = getIncomingUserId(session)
    await storeVoice(channelKey, session.messageId, {
      url: voiceUrl,
      file: voiceFile,
      conversationKey: getConversationKey(session),
      userId,
    })
    const cached = await getCachedTranscript(channelKey, session.messageId)
    if (cached && shouldTranscribe) return `[语音转文字：${cached}]`
    if (queueMedia && shouldTranscribe) {
      enqueueMediaTask({
        kind: 'media_voice_transcription',
        channelKey,
        messageId: session.messageId,
        url: String(voiceUrl || voiceFile || ''),
        fileId: voiceFile,
        priority: 88,
        payload: { url: voiceUrl, file: voiceFile, userId },
      })
      admitTask({ kind: 'media_voice_transcription', source: 'koishi-worker', channelKey, userId, exclusive: false })
    }
    if (!shouldTranscribe) return plain
    return plain.includes('[语音') ? plain : (plain ? plain + ' ' : '') + '[语音消息]'
  } catch (error) {
    warnIncomingAudioFailure(ctx, error)
    return '[语音消息]'
  }
}

async function handleIncomingMessageArtifacts({ ctx, session, analyzed, plain, content, channelKey, directAt, queueMedia = true }: IncomingMessageArtifactOptions): Promise<string> {
  let nextPlain = plain
  nextPlain = await handleIncomingImage({ ctx, session, analyzed, plain: nextPlain, content, channelKey, queueMedia })
  nextPlain = await handleIncomingFile({ session, analyzed, plain: nextPlain, channelKey, queueMedia })
  nextPlain = await resolveIncomingAudioPlain({ ctx, session, analyzed, plain: nextPlain, channelKey, directAt, queueMedia })
  return nextPlain
}

export = {
  handleIncomingMessageArtifacts,
}
