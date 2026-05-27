"use strict";
/**
 * MODULE: chat-final-output-flow
 * 职责: 处理 chat.js 模型文本输出的重试、最终清洗、随机 mode 和兜底回复。
 * 边界: 不发送消息、不保存 conversation、不拥有模型调用；模型调用由调用方注入。
 * 状态: 无。
 */
const { MAX_OUTPUT_CHARS_FRIENDLY, MAX_OUTPUT_CHARS_YINYANG, MAX_OUTPUT_CHARS_ABUSIVE, MAX_REPLY_RETRIES, ABUSIVE_INPUT_RE, BANNED_ACTION_OUTPUT_RE, THINKING_OUTPUT_RE, } = require('../core/constants');
const { estimateTokens } = require('../agent/context');
const { hasBannedOutput, trimReply, sanitizeReply, stripMarkdownForQQ, isSemanticProfile, } = require('../core/utils');
const { shouldRetryRepeatedReply, buildRepeatRetryPrompt, pickAbusiveFallbackReply, pickRepeatedFallbackReply, isUnsafeThinkingReply, stripStickerMarkersForGuard, hasInternalContextLeak, detectOldMediaTopicSticking, buildOldMediaStickingRetryPrompt, } = require('../reply/reply-guard');
const { getRecentAssistantReplies, channelSharedCache } = require('../conversation');
const { classifySceneItemsForActive } = require('../routing/group-scene-index');
const { parseRandomReplyDecision } = require('../behavior/random-reply-mode');
const { generatePersonaFallbackReply } = require('../persona/persona-fallback');
function getReplyMaxChars(retaliationLevel = 0) {
    return retaliationLevel === 2
        ? MAX_OUTPUT_CHARS_ABUSIVE
        : retaliationLevel === 1
            ? MAX_OUTPUT_CHARS_YINYANG
            : MAX_OUTPUT_CHARS_FRIENDLY;
}
async function retryUnsafeReply({ reply = '', messages = [], session, ctx, options = {}, cleanInput = '', currentUserId = '', channelKey = '', callModel, usedReminderActionTool = false, usedUploadedFileVariantTool = false, }) {
    for (let attempt = 0, oldMediaStickingRetryUsed = false; attempt < MAX_REPLY_RETRIES; attempt += 1) {
        const tokenEstimate = estimateTokens(messages);
        if (tokenEstimate > 12000)
            break;
        if (hasBannedOutput(reply)) {
            ctx.logger('dongxuelian-ai').warn(`banned word in reply, retrying. original: ${reply}`);
            messages.push({ role: 'assistant', content: reply });
            const bannedMatch = reply.match(BANNED_ACTION_OUTPUT_RE);
            const overusedMatch = reply.match(/^[啧哼]/);
            const specific = bannedMatch ? `"${bannedMatch[0]}"` : overusedMatch ? `"${overusedMatch[0]}"` : '';
            const instruction = specific
                ? `【系统提示：你刚才的回复包含了被禁止的${specific}，请重新回复，绝对不能出现${specific}，按你的风格直接回答。】`
                : '【系统提示：你刚才的回复包含了被明令禁止的封禁类词汇（拉黑/禁言/报警/黑名单等），请重新回复，绝对不能出现这些词，按自己的风格直接回答。】';
            messages.push({ role: 'user', content: instruction });
            reply = await callModel(messages, options.randomTriggered);
            continue;
        }
        if (isUnsafeThinkingReply(reply)) {
            ctx.logger('dongxuelian-ai').warn('thinking output in reply, retrying with sanitized prompt');
            const thinkingMatch = String(reply || '').match(THINKING_OUTPUT_RE) || String(reply || '').match(/(?:用户(?:现在)?(?:是在|在|可能|质疑)|我(?:需要|应该|会|可以先)|保持.{0,20}(?:人设|人格|语气)|(?:read_image_history|analyze_historical_image|web_search|web_fetch))/i);
            const specific = thinkingMatch ? '"' + thinkingMatch[0].slice(0, 80) + '"' : '';
            const instruction = specific
                ? '【系统提示：你刚才的回复包含了类似' + specific + '的分析式内容，请直接回答用户消息本身，不要把用户消息当成阅读理解题去分析。不要输出括号里的心理活动。按你的人设风格直接回答。】'
                : '【系统提示：刚才输出了内部草稿或工具计划。不要复述草稿，不要说函数名，不要解释回复策略。直接按当前人格给用户一句到两句自然回复。】';
            messages.push({ role: 'user', content: instruction });
            reply = await callModel(messages, options.randomTriggered);
            continue;
        }
        if (hasInternalContextLeak(reply)) {
            ctx.logger('dongxuelian-ai').warn('internal context leak in reply, retrying');
            messages.push({ role: 'user', content: '【系统提示：你刚才把内部参考资料或消息包装格式原样输出了。请重新回复当前用户，只说自然人话，绝对不要出现“这是你在本群的发言”“昵称：”“发言：”“<user>”“[群聊刷到]”。】' });
            reply = await callModel(messages, options.randomTriggered);
            continue;
        }
        if (usedReminderActionTool || usedUploadedFileVariantTool)
            break;
        const userName = session?.author?.nick || session?.author?.name || session?.username || '用户';
        const sanitizedReply = sanitizeReply(reply, userName);
        if (!shouldRetryRepeatedReply(session, stripStickerMarkersForGuard(sanitizedReply))) {
            if (!oldMediaStickingRetryUsed) {
                const layered = classifySceneItemsForActive(channelSharedCache.get(channelKey) || [], {
                    currentMessageId: String(session?.messageId || ''),
                    currentReplyToId: String(options.replyToId || session?.quote?.messageId || ''),
                    currentUserId,
                });
                const hasCurrentMediaCue = /(?:这张|这图|图里|图片|上面|刚才|刚刚|那个|这个|表情|文件|语音|转发)/.test(cleanInput);
                if (detectOldMediaTopicSticking({
                    reply: stripStickerMarkersForGuard(sanitizedReply),
                    currentTurn: layered.currentTurn,
                    hotContext: layered.hotContext,
                    oldBackground: layered.oldBackground,
                    hasCurrentMediaCue,
                })) {
                    oldMediaStickingRetryUsed = true;
                    ctx.logger('dongxuelian-ai').warn(`reply sticks to old background media, retrying once. original: ${sanitizedReply}`);
                    messages.push({ role: 'assistant', content: reply });
                    messages.push({ role: 'user', content: buildOldMediaStickingRetryPrompt() });
                    reply = await callModel(messages, options.randomTriggered);
                    continue;
                }
            }
            break;
        }
        const recentReplies = getRecentAssistantReplies(session);
        ctx.logger('dongxuelian-ai').warn(`reply is repetitive, retrying. original: ${sanitizedReply}`);
        messages.push({ role: 'assistant', content: reply });
        messages.push({ role: 'user', content: buildRepeatRetryPrompt(cleanInput, recentReplies) });
        reply = await callModel(messages, options.randomTriggered);
    }
    return reply;
}
async function finalizeChatReply({ reply = '', messages = [], session, ctx, options = {}, cleanInput = '', currentUserId = '', channelKey = '', systemPrompt = '', currentUserMessage = '', userName = '用户', retaliationLevel = 0, rareConfirmed = false, usedReminderActionTool = false, usedUploadedFileVariantTool = false, callModel, }) {
    reply = await retryUnsafeReply({
        reply,
        messages,
        session,
        ctx,
        options,
        cleanInput,
        currentUserId,
        channelKey,
        callModel,
        usedReminderActionTool,
        usedUploadedFileVariantTool,
    });
    let finalReply = trimReply(stripMarkdownForQQ(sanitizeReply(reply, userName)), getReplyMaxChars(retaliationLevel));
    if (options.randomTriggered) {
        const randomReplyDecision = parseRandomReplyDecision(finalReply);
        if (options.meta && typeof options.meta === 'object')
            options.meta.randomReplyMode = randomReplyDecision.mode;
        if (!randomReplyDecision.shouldSend)
            return { finalReply: '', shouldSend: false };
        finalReply = trimReply(stripMarkdownForQQ(sanitizeReply(randomReplyDecision.reply, userName)), getReplyMaxChars(retaliationLevel));
    }
    if (isUnsafeThinkingReply(finalReply)) {
        const personaFallback = await generatePersonaFallbackReply({
            session,
            systemPrompt,
            currentUserMessage,
            userName,
            reason: '最终回复仍包含内部草稿或工具计划',
            maxChars: getReplyMaxChars(retaliationLevel),
            callModel,
            isRandom: options.randomTriggered,
        });
        finalReply = personaFallback || (retaliationLevel >= 1 ? '这句先别绕了，换个说法。' : '这句我先重组织一下。');
    }
    if (hasInternalContextLeak(finalReply)) {
        ctx.logger('dongxuelian-ai').warn('internal context leak persisted, forcing fallback');
        const personaFallback = await generatePersonaFallbackReply({
            session,
            systemPrompt,
            currentUserMessage,
            userName,
            reason: '最终回复仍泄漏内部上下文',
            maxChars: getReplyMaxChars(retaliationLevel),
            callModel,
            isRandom: options.randomTriggered,
        });
        finalReply = personaFallback || (retaliationLevel >= 1 ? '这句先别绕了，换个说法。' : '这句我重组织一下。');
    }
    if (rareConfirmed && !/骂谁罕见/.test(finalReply)) {
        finalReply = trimReply(`骂谁罕见，${finalReply}`, getReplyMaxChars(retaliationLevel));
    }
    if (hasBannedOutput(finalReply)) {
        ctx.logger('dongxuelian-ai').warn(`banned word persists after retry, forcing fallback. reply: ${finalReply}`);
        if (options.randomTriggered)
            return { finalReply: '', shouldSend: false };
        if (retaliationLevel >= 2)
            finalReply = ABUSIVE_INPUT_RE.test(cleanInput) ? pickAbusiveFallbackReply(session) : (pickRepeatedFallbackReply(session) || '不接这句了。');
        else if (retaliationLevel === 1)
            finalReply = pickRepeatedFallbackReply(session) || '不接这句了。';
        else {
            const personaFallback = await generatePersonaFallbackReply({
                session,
                systemPrompt,
                currentUserMessage,
                userName,
                reason: '最终回复仍包含禁用表达',
                maxChars: MAX_OUTPUT_CHARS_FRIENDLY,
                callModel,
                isRandom: options.randomTriggered,
            });
            finalReply = personaFallback || '这句我接不了，换个说法吧。';
        }
    }
    else if (!usedReminderActionTool && !usedUploadedFileVariantTool && shouldRetryRepeatedReply(session, stripStickerMarkersForGuard(finalReply))) {
        ctx.logger('dongxuelian-ai').warn(`reply is still repetitive after retry, forcing fallback. reply: ${finalReply}`);
        if (options.randomTriggered)
            return { finalReply: '', shouldSend: false };
        if (retaliationLevel >= 2)
            finalReply = ABUSIVE_INPUT_RE.test(cleanInput) ? pickAbusiveFallbackReply(session) : (pickRepeatedFallbackReply(session) || '不接这句了。');
        else if (retaliationLevel === 1)
            finalReply = pickRepeatedFallbackReply(session) || '不接这句了。';
        else {
            const personaFallback = await generatePersonaFallbackReply({
                session,
                systemPrompt,
                currentUserMessage,
                userName,
                reason: '最终回复仍和近期回复过于相似',
                maxChars: MAX_OUTPUT_CHARS_FRIENDLY,
                callModel,
                isRandom: options.randomTriggered,
            });
            finalReply = personaFallback || '换个说法吧，别一直绕同一句。';
        }
    }
    if (retaliationLevel >= 1) {
        finalReply = finalReply.replace(/\[图:[^\[\]]+\]/g, '').trim();
    }
    if (isSemanticProfile(finalReply)) {
        ctx.logger('dongxuelian-ai').warn(`semantic profile detected, blocked. reply: ${finalReply.slice(0, 60)}`);
        finalReply = '别问了，这个我不聊。';
    }
    return { finalReply, shouldSend: true };
}
module.exports = {
    getReplyMaxChars,
    retryUnsafeReply,
    finalizeChatReply,
};
