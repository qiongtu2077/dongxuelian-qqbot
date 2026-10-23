"use strict";
/**
 * MODULE: 图片聊天轮次准备。
 * 职责: 将获准的图片会话绑定到持久识图所有权及原图片身份。
 * 边界: 不调用模型、不发送消息、不保存聊天历史。
 * 状态: 所有权由 image-request 统一管理，无本地缓存。
 */
const { acquireImageRequest } = require('./image-request');
const { getVisionPayload, isVisionSession, clearVisionSession } = require('./vision');
const { getImageEntry } = require('./image-store');
// 获得原图识别权，或复用已完成事实；等待中的任务不能假装已有结果。
async function prepareImageTurn(session, options) {
    if (!isVisionSession(session))
        return { status: 'none', targetMessageId: '', targetChannelKey: '' };
    const payload = getVisionPayload(session);
    const targetMessageId = payload.targetMessageId || '';
    const targetChannelKey = payload.targetChannelKey || '';
    const quotedMessageId = String(session.quote?.messageId || '');
    // 当前图与有效引用图是两个不同候选时，由获准聊天本身选择，不能先识别当前图。
    if (!options.randomTriggered && quotedMessageId && quotedMessageId !== targetMessageId && await getImageEntry(targetChannelKey, quotedMessageId)) {
        clearVisionSession(session);
        return { status: 'selection', targetMessageId: '', targetChannelKey, candidateMessageIds: [targetMessageId, quotedMessageId] };
    }
    const result = await acquireImageRequest(targetChannelKey, targetMessageId, {
        source: options.randomTriggered ? 'random-image' : 'explicit-image',
        question: options.question,
        force: false,
    });
    if (result.status !== 'owned')
        clearVisionSession(session);
    return { ...result, targetMessageId, targetChannelKey };
}
// 根据实际消息内容判断本轮是否必须使用视觉能力链，包括工具续轮与恢复轮次。
function messagesContainImage(messages) {
    return messages.some(message => Array.isArray(message.content)
        && message.content.some(part => part && typeof part === 'object' && part.type === 'image_url'));
}
module.exports = { prepareImageTurn, messagesContainImage };
