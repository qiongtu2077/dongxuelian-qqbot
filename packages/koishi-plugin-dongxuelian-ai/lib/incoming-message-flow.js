/**
 * MODULE: incoming-message-flow
 * 职责: 处理入站图片、文件、语音的落库/分析排队，并返回补全后的 plain 文本。
 * 边界: 不发送消息、不注册 middleware、不调用 chat/Agent；只做当前消息的入站材料处理。
 * 状态: 无模块级状态。
 */
const { getConversationKey } = require('./conversation')
const {
  extractImageRefFromContent,
  getMessageSegments,
  normalizeSegmentData,
  getFileSegmentData,
} = require('./message-segment')
const { storeImageUrl } = require('./image-store')
const { enqueueAnalysis } = require('./image-analyzer')
const { storeFile } = require('./file-store')
const { checkFile, getExtension, sanitizeFileName } = require('./file-safety')
const { cacheSmallFileBackground } = require('./incoming-file')
const { transcribeVoice } = require('./voice')
const { loadConfig } = require('./runtime-config')
const { logStickerShadowIngestDiagnostic } = require('./diagnostics')

function getIncomingUserId(session) {
  return session.userId || session.author?.id || session.username || ''
}

async function handleIncomingImage({ ctx, session, analyzed, plain, content, channelKey }) {
  if (!analyzed.hasVisual || !channelKey || !session.messageId) return plain
  const segments = getMessageSegments(session)
  const imgSeg = segments.find(s => ['image', 'img'].includes(String(s?.type || '')))
  const imgData = normalizeSegmentData(imgSeg)
  const imgFile = imgData.file || null
  const imgUrl = imgData.url || ''
  const imageMeta = {
    conversationKey: getConversationKey(session),
    userId: getIncomingUserId(session),
  }
  const contentImageRef = extractImageRefFromContent(content)
  const storableUrl = /^https?:\/\//i.test(imgUrl) ? imgUrl : contentImageRef.url
  const storableFile = imgFile || contentImageRef.file || ''
  await storeImageUrl(channelKey, session.messageId, storableUrl || '', storableFile || null, imageMeta)
  logStickerShadowIngestDiagnostic(ctx, {
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

async function handleIncomingFile({ session, analyzed, plain, channelKey }) {
  if (!analyzed.hasFile || !channelKey || !session.messageId) return plain
  const fileData = getFileSegmentData(session)
  if (!fileData) return plain
  const fileName = fileData.name || fileData.fileName || fileData.filename || fileData.file || 'unknown'
  const fileSize = Number(fileData.size) || 0
  const fileUrl = fileData.url || ''
  const fileId = fileData.file || fileData.id || fileData.fileId || fileData.file_id || null
  const ext = getExtension(fileName)
  const safety = checkFile(fileName, fileSize)
  const safeName = sanitizeFileName(fileName)
  const fileMeta = {
    fileName: safeName,
    fileSize,
    mimeType: fileData.mime || fileData.mimeType || '',
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

async function resolveIncomingAudioPlain({ session, analyzed, plain, directAt }) {
  if (!analyzed.hasAudio || (!session.isDirect && !directAt)) return plain
  try {
    const cfg = await loadConfig()
    const transcribed = await Promise.race([
      transcribeVoice(session, cfg),
      new Promise((_, reject) => setTimeout(() => reject(new Error('asr timeout')), 10000)),
    ])
    return transcribed ? `[语音转文字：${transcribed}]` : '[语音消息]'
  } catch {
    return '[语音消息]'
  }
}

async function handleIncomingMessageArtifacts({ ctx, session, analyzed, plain, content, channelKey, directAt }) {
  let nextPlain = plain
  nextPlain = await handleIncomingImage({ ctx, session, analyzed, plain: nextPlain, content, channelKey })
  nextPlain = await handleIncomingFile({ session, analyzed, plain: nextPlain, channelKey })
  nextPlain = await resolveIncomingAudioPlain({ session, analyzed, plain: nextPlain, directAt })
  return nextPlain
}

module.exports = {
  handleIncomingMessageArtifacts,
}
