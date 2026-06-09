"use strict";
/**
 * MODULE: 发送安全层。
 * 职责: 统一安全发送、发送失败限流/禁言处理、复读发送、罕见固定语音发送。
 * 边界: 不决定随机触发，不写 conversation，由调用方负责随机/历史上下文。
 * 状态: sendFailState 为进程内风控状态，重启后重建。
 */
const { sendReply } = require('./reply');
const { readRareVoiceAudioBuffer } = require('../behavior/rare-voice');
const { classifySendError, sanitizeForRateLimit, sleepForRateLimitRetry, getCachedPlatformMuteStatus, markPlatformMute, clearPlatformMute, checkPlatformMuteStatus, } = require('./send-guard');
const { getAdminUserIds } = require('../core/runtime-config');
const { createBotResolver } = require('../lifecycle/bot-resolver');
const { hasAdminPermission, isDirectAtBot } = require('../core/utils');
const sendFailState = {
    streak: 0,
    lastFailAt: 0,
    lastNotifyAt: 0,
    restrictedUntil: 0,
    maxStreak: 2,
    cooldownMs: 5 * 60 * 1000,
    restrictDurationMs: 60 * 60 * 1000,
    notifyIntervalMs: 30 * 1000,
    notifyScheduled: false,
};
function getSafeSendErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function asSafeSendBasicSession(session) {
    return session;
}
function asReplySession(session) {
    return session;
}
function logStaleRandomSkip(ctx, stage, options = {}) {
    try {
        ctx.logger('dongxuelian-ai').info(`random reply stale skipped at ${stage}: channel=${options.randomFreshness?.channelKey || ''}`);
    }
    catch { /* non-critical: diagnostic logging only */ }
}
async function notifyAdminsSendFailure(ctx, bot) {
    const admins = getAdminUserIds(true);
    const msg = '⚠️ 连续发送失败，已进入消息受限状态';
    await Promise.allSettled([...admins].map(async (id) => {
        try {
            if (typeof bot?.sendPrivateMessage === 'function') {
                await bot.sendPrivateMessage(id, msg);
            }
            else if (bot?.internal?.sendPrivateMsg) {
                await bot.internal.sendPrivateMsg(id, msg);
            }
        }
        catch (error) {
            ctx.logger('dongxuelian-ai').warn('notify admin send failure: ' + getSafeSendErrorMessage(error));
        }
    }));
}
function resetSendFailState() {
    sendFailState.streak = 0;
    sendFailState.lastFailAt = 0;
    sendFailState.lastNotifyAt = 0;
    sendFailState.restrictedUntil = 0;
    sendFailState.notifyScheduled = false;
}
function logPlatformMute(ctx, status, prefix = 'safeSendReply') {
    const until = status?.until ? new Date(status.until).toISOString() : 'unknown';
    ctx.logger('dongxuelian-ai').warn(`${prefix}: platform muted, skipping reply (${status?.reason || '平台禁言'}, until=${until})`);
}
/** 更新发送失败窗口，并在冻结未结束时阻止非管理员群聊发送。 */
function refreshSafeSendRestrictionWindow(now = Date.now()) {
    if (now >= sendFailState.restrictedUntil && sendFailState.notifyScheduled) {
        sendFailState.notifyScheduled = false;
    }
    if (sendFailState.streak > 0 && now - sendFailState.lastFailAt > sendFailState.cooldownMs) {
        sendFailState.streak = 0;
    }
}
/** 更新发送失败窗口，并在冻结未结束时阻止非管理员普通群聊回复。 */
function isSafeSendRestricted(ctx, session, prefix = 'safeSendReply', now = Date.now(), allowRestrictedFallback = false) {
    refreshSafeSendRestrictionWindow(now);
    if (now < sendFailState.restrictedUntil && !hasAdminPermission(asSafeSendBasicSession(session)) && !isDirectAtBot(asSafeSendBasicSession(session)) && !allowRestrictedFallback) {
        ctx.logger('dongxuelian-ai').warn(`${prefix}: restricted, skipping reply`);
        return true;
    }
    return false;
}
/** 发送语音等非文本内容前复用同一套冻结保护。 */
function canSendDuringSafeSendWindow(ctx, session, prefix) {
    const now = Date.now();
    refreshSafeSendRestrictionWindow(now);
    if (now < sendFailState.restrictedUntil && !hasAdminPermission(asSafeSendBasicSession(session))) {
        ctx.logger('dongxuelian-ai').warn(`${prefix}: restricted, skipping non-text send`);
        return false;
    }
    return true;
}
async function handleRateLimitedSendFailure(ctx, session, error, now, resolveBot = null) {
    const getBot = typeof resolveBot === 'function' ? resolveBot : createBotResolver(ctx, session);
    sendFailState.streak++;
    sendFailState.lastFailAt = now;
    ctx.logger('dongxuelian-ai').error(`safeSendReply: rate limited (streak=${sendFailState.streak}): ${getSafeSendErrorMessage(error)}`);
    if (sendFailState.streak <= 2) {
        sendFailState.lastNotifyAt = now;
        notifyAdminsSendFailure(ctx, getBot()).catch((notifyError) => {
            ctx.logger('dongxuelian-ai').warn(`notify admin send failure task failed: ${getSafeSendErrorMessage(notifyError)}`);
        });
    }
    else if (now - sendFailState.lastNotifyAt > sendFailState.notifyIntervalMs) {
        sendFailState.lastNotifyAt = now;
        notifyAdminsSendFailure(ctx, getBot()).catch((notifyError) => {
            ctx.logger('dongxuelian-ai').warn(`notify admin send failure task failed: ${getSafeSendErrorMessage(notifyError)}`);
        });
    }
    if (sendFailState.streak >= sendFailState.maxStreak) {
        if (now >= sendFailState.restrictedUntil) {
            sendFailState.restrictedUntil = now + sendFailState.restrictDurationMs;
            ctx.logger('dongxuelian-ai').warn(`safeSendReply: restricted for 1 hour due to ${sendFailState.streak} consecutive rate-limit failures`);
        }
        if (!sendFailState.notifyScheduled) {
            sendFailState.notifyScheduled = true;
            setTimeout(function () {
                const bot = getBot();
                const admins = getAdminUserIds(true);
                const unlockMsg = '🔓 30 分钟已过，风控可能已解除。BOT 冻结期还剩约 30 分钟，届时自动恢复。急需使用可重启 BOT。';
                Promise.allSettled([...admins].map(function (id) {
                    try {
                        if (typeof bot?.sendPrivateMessage === 'function') {
                            return bot.sendPrivateMessage(id, unlockMsg);
                        }
                    }
                    catch (error) {
                        ctx.logger('dongxuelian-ai').warn(`notify admin unlock failed: ${getSafeSendErrorMessage(error)}`);
                    }
                }));
            }, 30 * 60 * 1000);
        }
    }
}
async function sendRepeatMface(ctx, session, payload) {
    const message = Array.isArray(payload?.message) ? payload.message : [];
    if (!message.length)
        return false;
    const replySession = asReplySession(session);
    try {
        if (replySession.isDirect) {
            const sendPrivateMsg = replySession.bot?.internal?.sendPrivateMsg;
            if (typeof sendPrivateMsg !== 'function' || !replySession.userId)
                throw new Error('missing private onebot internal send for mface repeat');
            await sendPrivateMsg(replySession.userId, message);
        }
        else {
            const sendGroupMsg = replySession.bot?.internal?.sendGroupMsg;
            const targetGroupId = replySession.guildId || replySession.channelId;
            if (typeof sendGroupMsg !== 'function' || !targetGroupId)
                throw new Error('missing group onebot internal send for mface repeat');
            await sendGroupMsg(targetGroupId, message);
        }
        return true;
    }
    catch (error) {
        const classified = classifySendError(error);
        if (classified.type === 'muted') {
            markPlatformMute(session, { reason: classified.reason });
            ctx.logger('dongxuelian-ai').warn(`repeat mface send muted: ${classified.message.slice(0, 120)}`);
            return false;
        }
        if (classified.type === 'rate-limit') {
            ctx.logger('dongxuelian-ai').warn(`repeat mface send rate-limited: ${classified.message.slice(0, 120)}`);
            return false;
        }
        ctx.logger('dongxuelian-ai').warn(`repeat mface send failed: ${classified.message.slice(0, 120)}`);
        return false;
    }
}
async function safeSendRepeat(ctx, session, candidate) {
    const repeatCandidate = typeof candidate === 'string' ? { reply: candidate, kind: 'text' } : (candidate || {});
    if (repeatCandidate.kind === 'mface') {
        return sendRepeatMface(ctx, session, repeatCandidate.payload || {});
    }
    const reply = String(repeatCandidate.reply || '');
    try {
        await session.send(reply);
        return true;
    }
    catch (error) {
        const classified = classifySendError(error);
        if (classified.type === 'muted') {
            markPlatformMute(session, { reason: classified.reason });
            ctx.logger('dongxuelian-ai').warn(`repeat send muted: ${classified.message.slice(0, 120)}`);
            return false;
        }
        if (classified.type === 'rate-limit') {
            ctx.logger('dongxuelian-ai').warn(`repeat send rate-limited: ${classified.message.slice(0, 120)}`);
            return false;
        }
        ctx.logger('dongxuelian-ai').warn(`repeat send failed: ${classified.message.slice(0, 120)}`);
        return false;
    }
}
async function safeSendReply(ctx, session, reply, isRandom = false, resolveBot = null, sendOptions = {}, freshnessChecker = null) {
    if (typeof freshnessChecker === 'function' && !freshnessChecker(isRandom, sendOptions)) {
        logStaleRandomSkip(ctx, isRandom ? 'text' : 'stale-text', sendOptions);
        return;
    }
    const now = Date.now();
    const allowRestrictedFallback = sendOptions.allowRestrictedFallback === true;
    if (isSafeSendRestricted(ctx, session, 'safeSendReply', now, allowRestrictedFallback))
        return;
    if (now < sendFailState.restrictedUntil && (allowRestrictedFallback || isDirectAtBot(asSafeSendBasicSession(session))) && !hasAdminPermission(asSafeSendBasicSession(session))) {
        try {
            await session.send('我被盯上了，有内鬼终止交易');
            return;
        }
        catch (error) {
            ctx.logger('dongxuelian-ai').error(`safeSendReply: restricted notice failed: ${getSafeSendErrorMessage(error)}`);
            return;
        }
    }
    const cachedMute = getCachedPlatformMuteStatus(session, now);
    if (cachedMute.muted) {
        logPlatformMute(ctx, cachedMute);
        return;
    }
    const activeMute = await checkPlatformMuteStatus(session);
    if (activeMute.muted) {
        const marked = markPlatformMute(session, activeMute);
        logPlatformMute(ctx, marked);
        return;
    }
    let currentReply = reply;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const sentCount = await sendReply(ctx, asReplySession(session), currentReply, isRandom, sendOptions);
            if (sentCount > 0) {
                resetSendFailState();
                clearPlatformMute(session);
            }
            return;
        }
        catch (error) {
            const classified = classifySendError(error);
            if (classified.type === 'muted') {
                const marked = markPlatformMute(session, { reason: classified.reason });
                logPlatformMute(ctx, marked, 'safeSendReply: send error');
                return;
            }
            if (classified.type !== 'rate-limit') {
                ctx.logger('dongxuelian-ai').warn(`safeSendReply: non-rate-limit error skipped: ${classified.message.slice(0, 120)}`);
                throw error;
            }
            if (attempt === 0 && Number(error?.sentParts || 0) === 0) {
                const cleaned = sanitizeForRateLimit(currentReply);
                currentReply = cleaned || currentReply;
                ctx.logger('dongxuelian-ai').warn('safeSendReply: rate limited, retrying once with sanitized content');
                await sleepForRateLimitRetry(ctx, attempt);
                continue;
            }
            await handleRateLimitedSendFailure(ctx, session, error, Date.now(), resolveBot);
            throw error;
        }
    }
}
/** 生成资源门控使用的频道 key，保持和聊天入口的粒度一致。 */
function getSafeSendChannelKey(session) {
    if (session.guildId || session.channelId)
        return String(session.guildId || session.channelId || '');
    if (session.isDirect || session.userId)
        return `private:${session.userId || ''}`;
    return '';
}
/** 尝试发送罕见固定语音；失败时返回 false 交给文字回复回退。 */
async function safeSendRareVoice(ctx, session, options = {}) {
    try {
        if (!canSendDuringSafeSendWindow(ctx, session, 'safeSendRareVoice')) {
            const allowRestrictedFallback = options.allowRestrictedFallback ?? isDirectAtBot(asSafeSendBasicSession(session));
            return !allowRestrictedFallback;
        }
        const { sendVoiceMessage } = require('../media/voice/tts');
        const { runVoiceTtsWithResourceGate } = require('../media/voice/tts-resource');
        const gated = await runVoiceTtsWithResourceGate({
            source: 'koishi-rare-voice',
            owner: 'koishi-rare-voice',
            channelKey: getSafeSendChannelKey(session),
            userId: String(session.userId || session.author?.id || session.event?.user?.id || ''),
            context: 'rare-voice',
            logger: ctx.logger('dongxuelian-ai'),
            run: () => readRareVoiceAudioBuffer(),
        });
        if (!gated.ok) {
            try {
                ctx.logger('dongxuelian-ai').warn(`safeSendRareVoice skipped by resource gate: ${gated.reason}`);
            }
            catch { /* non-critical: logging only */ }
            return false;
        }
        const audioBuf = gated.value;
        if (!audioBuf) {
            try {
                ctx.logger('dongxuelian-ai').warn('safeSendRareVoice skipped: rare voice audio unavailable');
            }
            catch { /* non-critical: logging only */ }
            return false;
        }
        const sent = await sendVoiceMessage(session, audioBuf);
        if (!sent) {
            try {
                ctx.logger('dongxuelian-ai').warn('safeSendRareVoice skipped: sendVoiceMessage returned false');
            }
            catch { /* non-critical: logging only */ }
        }
        return sent;
    }
    catch (error) {
        try {
            ctx.logger('dongxuelian-ai').warn(`safeSendRareVoice failed: ${getSafeSendErrorMessage(error)}`);
        }
        catch { /* non-critical: logging only */ }
        return false;
    }
}
module.exports = {
    logStaleRandomSkip,
    safeSendRepeat,
    safeSendReply,
    safeSendRareVoice,
    canSendDuringSafeSendWindow,
    resetSendFailState,
};
