"use strict";
/**
 * MODULE: 罕见语音诊断。
 * 职责: 关联消息身份，记录真实抽签及发送阶段结果，交由现有 Koishi 日志持久化。
 * 边界: 不改变判定、概率或发送行为，不记录消息正文、音频或媒体地址。
 * 状态: 无独立缓存、文件或定时器。
 */
const { shouldTriggerRareVoice, RARE_VOICE_RATE } = require('../behavior/rare-voice');
const { redactSensitiveText } = require('../core/redactor');
// 用群号和原消息 ID 串联抽签、跳过与发送结果；日志失败不改变原发送结果。
function logRareVoiceEvent(ctx, session, event) {
    const payload = { ...event, channelKey: session.guildId || session.channelId || '',
        messageId: String(session.messageId || ''), userId: String(session.userId || session.author?.id || ''),
        isDirect: Boolean(session.isDirect), createdAt: new Date().toISOString() };
    if (payload.error)
        payload.error = redactSensitiveText(payload.error).slice(0, 500);
    try {
        const logger = ctx.logger('dongxuelian-ai');
        const line = 'rare_voice ' + JSON.stringify(payload);
        if (event.stage === 'send_result' && event.sent === false)
            logger.warn(line);
        else
            logger.info(line);
    }
    catch {
        console.warn(`[rare-voice-diagnostic] log write failed: messageId=${payload.messageId} stage=${event.stage}`);
    }
}
// 观察原抽签函数实际使用的唯一随机数；未命中语义时不额外抽签。
function shouldTriggerRareVoiceWithDiagnostics(ctx, session, meta = {}, route = 'chat', random = Math.random) {
    let draw = null;
    const selected = shouldTriggerRareVoice(meta, () => { draw = random(); return draw; });
    logRareVoiceEvent(ctx, session, { stage: 'decision', route, rareConfirmed: meta.rareConfirmed ?? null,
        rate: RARE_VOICE_RATE, draw, selected,
        reason: meta.rareConfirmed === undefined ? 'missing_verdict' : !meta.rareConfirmed ? 'not_rare' : selected ? 'selected' : 'random_miss' });
    return selected;
}
module.exports = { logRareVoiceEvent, shouldTriggerRareVoiceWithDiagnostics };
