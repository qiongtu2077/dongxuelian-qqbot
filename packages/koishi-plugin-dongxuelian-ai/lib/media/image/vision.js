"use strict";
/**
 * MODULE: 图片会话标记。
 * 职责: 标记 session 是否含待处理图片、提取图片 payload、追加视觉消息到 messages。
 * 边界: 只操作 session 标记和 messages 数组尾部，不调 AI API，不改 conversation 持久层。
 */
const { isVisionModel, } = require('../../core/api');
const { extractImageUrls } = require('../../core/utils');
const { getChannelKey } = require('../../conversation');
const { readImageSource } = require('./image-source');
const { getCurrentImageSegments, hasAmbiguousImageMessage, normalizeSegmentData } = require('../../message/message-segment');
const VISION_SESSION_KEYS = ['_visionUrls', '_visionFile', '_isVisionRequest', '_visionTargetMessageId', '_visionTargetChannelKey'];
// 统一视觉读取失败的日志文本。
function getVisionErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
// 标记单个图片目标；调用方必须先完成回复准入。
function markSessionForVision(session, urls = [], file = null, targetMessageId = '') {
    const normalizedUrls = Array.isArray(urls) ? urls.map(String).filter(Boolean) : [];
    const normalizedFile = file ? String(file) : null;
    if (!session || (!normalizedUrls.length && !normalizedFile))
        return false;
    session._visionUrls = normalizedUrls;
    session._visionFile = normalizedFile;
    session._isVisionRequest = true;
    session._visionTargetMessageId = targetMessageId || String(session.messageId || '');
    session._visionTargetChannelKey = getChannelKey(session);
    return true;
}
// 返回图片来源及原图片身份，避免追问编号覆盖原图。
function getVisionPayload(session) {
    if (!session)
        return { urls: [], file: null };
    return {
        urls: Array.isArray(session._visionUrls) ? session._visionUrls.filter(Boolean).map(String) : [],
        file: session._visionFile ? String(session._visionFile) : null,
        targetMessageId: String(session._visionTargetMessageId || session.messageId || ''),
        targetChannelKey: String(session._visionTargetChannelKey || getChannelKey(session)),
    };
}
// 读取已核实的 OneBot 原始图片段及 Koishi img 元素来源。
function getCurrentImageUrlsFromSegments(session) {
    const segments = getCurrentImageSegments(session);
    return segments
        .filter(segment => segment && ['image', 'img'].includes(String(segment.type)))
        .map(segment => { const data = normalizeSegmentData(segment); return data.url || data.src || ''; })
        .map(String)
        .filter(Boolean);
}
// 判断会话是否已绑定允许识图的目标。
function isVisionSession(session) {
    if (!session || !session._isVisionRequest)
        return false;
    const payload = getVisionPayload(session);
    return !!(payload.file || payload.urls.length > 0);
}
// 清除本轮视觉标记。
function clearVisionSession(session) {
    if (!session)
        return;
    for (const key of VISION_SESSION_KEYS)
        delete session[key];
}
// 仅供明确选择引用图的调用者提取来源，普通聊天不能自动使用。
function getQuotedVisionPayload(session) {
    let qc = '';
    let quotedFile = null;
    try {
        if (typeof session.quote?.content === 'string')
            qc = session.quote.content;
        else if (Array.isArray(session.quote?.message)) {
            qc = session.quote.message.map(s => s.data?.url || s.data?.file || '').filter(Boolean).join(' ');
            const imgSeg = session.quote.message.find(s => s.type === 'image');
            if (imgSeg && imgSeg.data?.file)
                quotedFile = String(imgSeg.data.file);
        }
    }
    catch { /* non-critical: quoted message may be absent or adapter-shaped */
    }
    if (!qc && !quotedFile)
        return { urls: [], file: null };
    return { urls: extractImageUrls(qc), file: quotedFile };
}
// 为已经获准的当前图邀请绑定图片；引用图必须显式选择。
function prepareVisionRequest(session, analyzed = {}, context = {}) {
    const content = context.content === undefined ? session?.content || '' : context.content;
    if (context.allowCurrentMessage) {
        const imageSegments = getCurrentImageSegments(session);
        // 适配器同消息的多个 img 共用 messageId，当前存储无法唯一绑定其中一张。
        if (hasAmbiguousImageMessage(session, String(content || ''))) {
            session._visionAmbiguous = true;
            return false;
        }
        const urls = [...new Set(extractImageUrls(String(content || '')).concat(getCurrentImageUrlsFromSegments(session)))];
        const file = imageSegments.length ? normalizeSegmentData(imageSegments[0]).file : null;
        if (markSessionForVision(session, urls, file))
            return true;
    }
    if (context.includeQuote === true && !analyzed.hasVisual && !analyzed.hasFile && !analyzed.hasEmbed && session?.quote) {
        const quoted = getQuotedVisionPayload(session);
        if (markSessionForVision(session, quoted.urls, quoted.file, String(session.quote.messageId || '')))
            return true;
    }
    return isVisionSession(session);
}
// 通过共享读取层取得已绑定原图；读取成功才追加多模态消息。
async function appendVisionMessage(messages, session, config, ctx, options = {}) {
    const payload = getVisionPayload(session);
    const promptText = options.promptText || '';
    const inaccessibleReply = options.inaccessibleReply || '图片无法访问。';
    const identifyFailReply = options.identifyFailReply || '图片识别失败。';
    const visionContext = { provider: config && config.provider, model: config && config.model, promptText, injectedIndex: -1 };
    try {
        if (!isVisionModel(String(config.provider || ''), String(config.model || '')))
            return { ok: false, reply: identifyFailReply };
        const imgBase64 = await readImageSource(payload.targetChannelKey || '', payload.targetMessageId || '');
        if (!imgBase64)
            return { ok: false, reply: inaccessibleReply };
        visionContext.injectedIndex = messages.push({
            role: 'user',
            content: [
                { type: 'text', text: promptText },
                { type: 'image_url', image_url: { url: imgBase64 } },
            ],
        }) - 1;
        return { ok: true, visionContext };
    }
    catch (error) {
        ctx.logger('dongxuelian-ai').warn('Vision: ' + getVisionErrorMessage(error));
        return { ok: false, reply: identifyFailReply };
    }
    finally {
        clearVisionSession(session);
    }
}
// 模型实际没解析到 image_url 时的"我看不到"反驳。命中条件：短回复 + 否定词 + (求重发 / 不接茬意图)。
// 单独"图太糊看不清"这种正常吐槽不算（会带描述/形容词，长度也常 > 阈值）。
const VISION_BLINDNESS_NEGATIVE_RE = /(?:看不(?:到|见)|没法看(?:到|见)?|没看(?:到|见)|无法(?:看|查看|识别)|看不出来是什么图|没收到图|没有图)/;
const VISION_BLINDNESS_RESEND_RE = /(?:再发一(?:次|遍|张)|重新发|换个图|发(?:一)?张图|发清楚点|描述一下)/;
// 检测上游未能消费图片时的短拒识回复。
function isVisionBlindnessReply(reply = '') {
    const text = String(reply || '').trim();
    if (!text)
        return false;
    if (text.length > 60)
        return false;
    if (!VISION_BLINDNESS_NEGATIVE_RE.test(text))
        return false;
    return VISION_BLINDNESS_RESEND_RE.test(text) || text.length <= 20;
}
// 把已 push 的多模态 user 消息降级为纯文本占位，让模型按文本上下文再答一次。
function downgradeVisionMessageToText(messages, visionContext, fallbackText) {
    if (!visionContext || !Array.isArray(messages))
        return false;
    const idx = Number(visionContext.injectedIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= messages.length)
        return false;
    const target = messages[idx];
    if (!target || target.role !== 'user' || !Array.isArray(target.content))
        return false;
    messages[idx] = { role: 'user', content: String(fallbackText || '[图片暂时取不到，请按当前文字上下文回复，不要假设你看到了什么图]') };
    return true;
}
module.exports = {
    VISION_SESSION_KEYS,
    markSessionForVision,
    isVisionSession,
    getVisionPayload,
    clearVisionSession,
    prepareVisionRequest,
    appendVisionMessage,
    isVisionBlindnessReply,
    downgradeVisionMessageToText,
};
