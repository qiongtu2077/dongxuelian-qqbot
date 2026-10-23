"use strict";
/**
 * MODULE: incoming-message-flow
 * 职责: 处理入站图片、文件、语音的落库/分析排队，并返回补全后的 plain 文本。
 * 边界: 不发送消息、不注册 middleware、不调用 chat/Agent；只做当前消息的入站材料处理。
 * 状态: 无模块级状态。
 */
const { getConversationKey } = require('../conversation');
const { extractImageRefFromContent, getMessageSegments, getCurrentImageSegments, hasAmbiguousImageMessage, normalizeSegmentData, getFileSegmentData, getVoiceSegmentData, } = require('./message-segment');
const { storeImageUrl, getImageEntry } = require('../media/image/image-store');
const { storeFile } = require('../media/file/file-store');
const { checkFile, getExtension, sanitizeFileName } = require('../media/file/file-safety');
const { storeVoice, getCachedTranscript } = require('../media/voice/voice-store');
const { enqueueMediaTask } = require('../media/backpressure/media-queue');
const { admitTask } = require('../resource-scheduler/admission');
const { logStickerShadowIngestDiagnostic } = require('../diagnostics/diagnostics');
// 从已知会话身份字段提取入站用户编号。
function getIncomingUserId(session) {
    return session.userId || session.author?.id || session.username || '';
}
// 将入站处理异常转换为可记录的错误文本。
function getIncomingMessageFlowErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
// 使用插件日志记录语音落库失败，缺少上下文时保留控制台诊断。
function warnIncomingAudioFailure(ctx, error) {
    const message = `[incoming-message-flow] voice ingest failed: ${getIncomingMessageFlowErrorMessage(error)}`;
    const logger = ctx && typeof ctx.logger === 'function' ? ctx.logger('dongxuelian-ai') : null;
    if (logger && typeof logger.warn === 'function') {
        logger.warn(message);
        return;
    }
    console.warn(message);
}
// 仅在资源准入允许排队或执行时提交媒体任务。
function shouldEnqueuePassiveMedia(admission) {
    const decision = String(admission?.decision || '');
    return decision === 'run_now' || decision === 'queue' || decision === 'downgrade';
}
// 入站只保存图片引用并安排原图缓存，不创建模型分析需求。
async function handleIncomingImage({ ctx, session, analyzed, plain, content, channelKey, cacheImages = true }) {
    if (!analyzed.hasVisual || !channelKey || !session.messageId)
        return plain;
    if (hasAmbiguousImageMessage(session, content)) {
        const { writeMediaEvent } = require('../media/backpressure/media-queue');
        writeMediaEvent('image_ingest_ambiguous', { channelKey, messageId: session.messageId, reason: 'multiple_images_in_message' });
        return plain.includes('[图片]') ? plain : (plain ? plain + ' ' : '') + '[图片]';
    }
    const segments = getMessageSegments(session);
    const imgSeg = getCurrentImageSegments(session)[0];
    const imgData = normalizeSegmentData(imgSeg);
    const imgFile = imgData.file || null;
    const imgUrl = String(imgData.url || '');
    const imageMeta = {
        conversationKey: getConversationKey(session),
        userId: getIncomingUserId(session),
    };
    const contentImageRef = extractImageRefFromContent(content);
    const storableUrl = /^https?:\/\//i.test(imgUrl) ? imgUrl : contentImageRef.url;
    const storableFile = imgFile || contentImageRef.file || '';
    await storeImageUrl(channelKey, session.messageId, storableUrl || '', storableFile || null, imageMeta);
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
    });
    if (cacheImages) {
        const entry = await getImageEntry(channelKey, session.messageId);
        if (!entry)
            return plain.includes('[图片]') ? plain : (plain ? plain + ' ' : '') + '[图片]';
        const admission = admitTask({ kind: 'media_image_cache', source: 'koishi-worker', channelKey, userId: imageMeta.userId, exclusive: false });
        if (shouldEnqueuePassiveMedia(admission)) {
            enqueueMediaTask({
                kind: 'media_image_cache',
                channelKey,
                messageId: session.messageId,
                url: String(storableUrl || storableFile || ''),
                priority: 95,
                expiresAt: new Date(entry.ts + 2 * 60 * 60 * 1000).toISOString(),
                payload: {},
            });
        }
    }
    return plain.includes('[图片]') ? plain : (plain ? plain + ' ' : '') + '[图片]';
}
// 文件沿用既有安全检查、记录和分析排队行为。
async function handleIncomingFile({ session, analyzed, plain, channelKey, queueMedia = true }) {
    if (!analyzed.hasFile || !channelKey || !session.messageId)
        return plain;
    const fileData = getFileSegmentData(session);
    if (!fileData)
        return plain;
    const fileName = String(fileData.name || fileData.fileName || fileData.filename || fileData.file || 'unknown');
    const fileSize = Number(fileData.size) || 0;
    const fileUrl = String(fileData.url || '');
    const fileIdValue = fileData.file || fileData.id || fileData.fileId || fileData.file_id || null;
    const fileId = fileIdValue === null || fileIdValue === undefined || fileIdValue === '' ? null : String(fileIdValue);
    const ext = getExtension(fileName);
    const safety = checkFile(fileName, fileSize);
    const safeName = sanitizeFileName(fileName);
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
    };
    await storeFile(channelKey, session.messageId, fileMeta);
    if (plain.includes('[文件]'))
        return plain;
    if (safety.allowed) {
        if (queueMedia) {
            const admission = admitTask({ kind: 'media_file_analysis', source: 'koishi-worker', channelKey, userId: fileMeta.userId, exclusive: false });
            if (shouldEnqueuePassiveMedia(admission)) {
                enqueueMediaTask({
                    kind: 'media_file_analysis',
                    channelKey,
                    messageId: session.messageId,
                    url: fileUrl,
                    fileId,
                    payload: { fileName: safeName, fileSize, ext, userId: fileMeta.userId },
                });
            }
        }
        return (plain ? plain + ' ' : '') + `[文件: ${safeName} (fileId:${session.messageId})]`;
    }
    return (plain ? plain + ' ' : '') + `[文件: ${safeName} - 已跳过${safety.reason ? '(' + safety.reason + ')' : ''}]`;
}
// 语音只在明确交互时安排转写，并复用已有转写结果。
async function resolveIncomingAudioPlain({ ctx, session, analyzed, plain, channelKey, directAt, queueMedia = true }) {
    if (!analyzed.hasAudio)
        return plain;
    const shouldTranscribe = !!(session.isDirect || directAt);
    try {
        if (!channelKey || !session.messageId)
            return plain || '[语音消息]';
        const voiceData = getVoiceSegmentData(session) || {};
        const voiceUrl = String(voiceData.url || voiceData.src || '');
        const voiceFileValue = voiceData.file || voiceData.id || voiceData.fileId || voiceData.file_id || null;
        const voiceFile = voiceFileValue === null || voiceFileValue === undefined || voiceFileValue === '' ? null : String(voiceFileValue);
        const userId = getIncomingUserId(session);
        await storeVoice(channelKey, session.messageId, {
            url: voiceUrl,
            file: voiceFile,
            conversationKey: getConversationKey(session),
            userId,
        });
        const cached = await getCachedTranscript(channelKey, session.messageId);
        if (cached && shouldTranscribe)
            return `[语音转文字：${cached}]`;
        if (queueMedia && shouldTranscribe) {
            const admission = admitTask({ kind: 'media_voice_transcription', source: 'koishi-worker', channelKey, userId, exclusive: false });
            if (shouldEnqueuePassiveMedia(admission)) {
                enqueueMediaTask({
                    kind: 'media_voice_transcription',
                    channelKey,
                    messageId: session.messageId,
                    url: String(voiceUrl || voiceFile || ''),
                    fileId: voiceFile,
                    priority: 88,
                    payload: { url: voiceUrl, file: voiceFile, userId },
                });
            }
        }
        if (!shouldTranscribe)
            return plain;
        return plain.includes('[语音') ? plain : (plain ? plain + ' ' : '') + '[语音消息]';
    }
    catch (error) {
        warnIncomingAudioFailure(ctx, error);
        return '[语音消息]';
    }
}
// 分别安排图片缓存与其它媒体分析，不让媒体分析开关丢弃图片保留任务。
async function handleIncomingMessageArtifacts({ ctx, session, analyzed, plain, content, channelKey, directAt, queueMedia = true, cacheImages = true }) {
    let nextPlain = plain;
    nextPlain = await handleIncomingImage({ ctx, session, analyzed, plain: nextPlain, content, channelKey, cacheImages });
    nextPlain = await handleIncomingFile({ session, analyzed, plain: nextPlain, channelKey, queueMedia });
    nextPlain = await resolveIncomingAudioPlain({ ctx, session, analyzed, plain: nextPlain, channelKey, directAt, queueMedia });
    return nextPlain;
}
module.exports = {
    handleIncomingMessageArtifacts,
};
