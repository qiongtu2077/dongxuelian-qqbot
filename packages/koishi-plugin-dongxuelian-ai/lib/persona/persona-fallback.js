"use strict";
/**
 * MODULE: 人格化异常兜底。
 * 职责: 在回复守卫失败时，用当前人格 prompt 生成短纠偏回复。
 * 边界: 不读写文件、不保存 conversation；只调用传入的模型函数。
 * 状态: 无。
 */
const { sanitizeReply, stripMarkdownForQQ, trimReply } = require('../core/utils');
const { isUnsafeThinkingReply, hasInternalContextLeak, stripStickerMarkersForGuard, shouldRetryRepeatedReply } = require('../reply/reply-guard');
const { hasBannedOutput } = require('../core/utils');
function getPersonaFallbackErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function normalizeModelText(result) {
    if (typeof result === 'string')
        return result;
    if (result && typeof result === 'object') {
        const data = result;
        return String(data.content || data.message?.content || '');
    }
    return '';
}
function isUnsafeFallbackText(session, text = '') {
    const value = stripStickerMarkersForGuard(String(text || '').trim());
    return !value ||
        hasBannedOutput(value) ||
        isUnsafeThinkingReply(value) ||
        hasInternalContextLeak(value) ||
        shouldRetryRepeatedReply(session, value);
}
function cleanPersonaFallbackReply(session, text = '', userName = '用户', maxChars = 120) {
    const cleaned = trimReply(stripMarkdownForQQ(sanitizeReply(text, userName)), maxChars);
    return isUnsafeFallbackText(session, cleaned) ? '' : cleaned;
}
function buildPersonaFallbackMessages(systemPrompt, currentUserMessage, reason = '') {
    return [
        { role: 'system', content: systemPrompt },
        {
            role: 'system',
            content: [
                '你刚才的候选回复没有通过发送前守卫。',
                reason ? `原因：${reason}` : '',
                '不要复述失败回复，不要解释规则，不要提工具名/函数名/内部材料。',
                '直接按当前人格给用户一句到两句自然回复；短一点，像 QQ 聊天。',
            ].filter(Boolean).join('\n'),
        },
        { role: 'user', content: currentUserMessage },
    ];
}
async function generatePersonaFallbackReply({ session, systemPrompt, currentUserMessage, userName, reason, maxChars, callModel, isRandom, }) {
    if (typeof callModel !== 'function' || !systemPrompt || !currentUserMessage)
        return '';
    try {
        const result = await callModel(buildPersonaFallbackMessages(systemPrompt, currentUserMessage, reason), isRandom, { max_tokens: 80, _fallbackSet: 'lightweight' });
        return cleanPersonaFallbackReply(session, normalizeModelText(result), userName, maxChars);
    }
    catch (error) {
        console.warn(`[dongxuelian-ai] persona fallback generation failed: ${getPersonaFallbackErrorMessage(error)}`);
        return '';
    }
}
module.exports = {
    normalizeModelText,
    isUnsafeFallbackText,
    cleanPersonaFallbackReply,
    buildPersonaFallbackMessages,
    generatePersonaFallbackReply,
};
