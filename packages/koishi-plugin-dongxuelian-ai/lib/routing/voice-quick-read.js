"use strict";
/* ==========================================================================
 * MODULE: voice-quick-read
 * 职责: 处理“转文字/听语音内容”这类显式语音快捷读取意图，返回可发送的低成本摘要文本。
 * 边界: 不发送消息、不注册 middleware、不调用 chat/Agent；只复用 voice-store 与 S6 队列。
 * 状态: 无模块级状态。
 * ========================================================================== */
const { getCachedTranscript, getVoiceEntry } = require('../media/voice/voice-store');
const { enqueueMediaTask } = require('../media/backpressure/media-queue');
const { shouldEnqueueMediaForAdmission } = require('../media/backpressure/media-requests');
const { admitTask } = require('../resource-scheduler/admission');
const { normalizeText } = require('../core/utils');
const VOICE_QUICK_READ_RE = /(?:转文字|转成文字|转写|听一下|听听|这段语音说了什么|这条语音说了什么|刚才那段语音说了什么|刚才那条语音说了什么|语音内容|语音里说了什么)/;
function isVoiceQuickReadIntent(text = '') {
    const value = normalizeText(text);
    if (!value)
        return false;
    return VOICE_QUICK_READ_RE.test(value);
}
function formatVoiceQueuedReply(admission) {
    const reason = admission?.decision === 'run_now'
        ? 'media-worker 空闲时会处理'
        : String(admission?.reason || admission?.decision || '已排队');
    if (!shouldEnqueueMediaForAdmission(admission)) {
        return `当前资源状态为 ${admission?.resourceState || 'unknown'}，暂时不能加入语音转写队列，原因：${reason}。请稍后再试。`;
    }
    return `这段语音已加入转写队列，当前资源状态为 ${admission?.resourceState || 'unknown'}，原因：${reason}。稍后再问我这段语音说了什么即可。`;
}
async function resolveVoiceQuickReadReply(channelKey, messageId) {
    const safeChannelKey = String(channelKey || '').trim();
    const safeMessageId = String(messageId || '').trim();
    if (!safeChannelKey || !safeMessageId)
        return '语音记录不完整，请重新发一次语音。';
    const cached = await getCachedTranscript(safeChannelKey, safeMessageId);
    if (cached)
        return `[语音转文字：${cached}]`;
    const entry = await getVoiceEntry(safeChannelKey, safeMessageId);
    if (!entry)
        return '没有找到最近可转写的语音，请重新发一次语音。';
    const admission = admitTask({
        kind: 'media_voice_transcription',
        source: 'voice-quick-read',
        channelKey: safeChannelKey,
        userId: String(entry.userId || ''),
        exclusive: false,
    });
    if (shouldEnqueueMediaForAdmission(admission)) {
        const queued = enqueueMediaTask({
            kind: 'media_voice_transcription',
            channelKey: safeChannelKey,
            messageId: safeMessageId,
            url: String(entry.url || entry.file || ''),
            fileId: entry.file || null,
            priority: 88,
            payload: {
                url: String(entry.url || ''),
                file: entry.file || null,
                userId: String(entry.userId || ''),
                entry: 'voice-quick-read',
            },
        });
        if ('reused' in queued && queued.reused === true) {
            return '这段语音的转写结果已经缓存好了，稍后再问我这段语音说了什么即可。';
        }
    }
    return formatVoiceQueuedReply(admission);
}
module.exports = {
    isVoiceQuickReadIntent,
    resolveVoiceQuickReadReply,
    formatVoiceQueuedReply,
};
