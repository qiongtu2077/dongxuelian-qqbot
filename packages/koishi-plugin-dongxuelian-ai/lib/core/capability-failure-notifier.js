"use strict";
/**
 * MODULE: 能力优先级故障通知。
 * 职责: 每个业务失败独立通知全部超级管理员，附带脱敏原因和关联编号。
 * 边界: 通知失败只记录脱敏警告，不影响模型回退或用户请求。
 */
const { getAdminUserIds } = require('./runtime-config');
const { AI_CAPABILITIES, getProviderCatalogEntry } = require('./ai-capability-config');
const { sanitizeDiagnosticText, formatModelHttpStatus } = require('./request-diagnostics');
// 保留公开常量名；实际业务失败不再冷却去重。
const FAILURE_NOTIFICATION_COOLDOWN_MS = 0;
const CAPABILITY_LABELS = { text: '文字', vision: '识图', 'voice-asr': '语音识别', 'voice-tts': '语音合成' };
let failureSender = null;
// --- 发送器注册 ---
// 注册可测试的私聊发送器；传 null 可在插件卸载时清理上下文引用。
function setCapabilityFailureSender(sender) {
    failureSender = sender;
}
// 从 Koishi 上下文选择可用 Bot 并注册私聊发送器。
function registerCapabilityFailureContext(ctx) {
    setCapabilityFailureSender(async (adminId, message) => {
        const bot = (Array.isArray(ctx.bots) ? ctx.bots.find(item => !!item) : null) || ctx.bot;
        if (!bot)
            throw new Error('没有可用 Bot');
        if (typeof bot.sendPrivateMessage === 'function')
            return bot.sendPrivateMessage(adminId, message);
        if (bot.internal && typeof bot.internal.sendPrivateMsg === 'function') {
            return bot.internal.sendPrivateMsg(adminId, [{ type: 'text', data: { text: message } }]);
        }
        throw new Error('Bot 不支持私聊发送');
    });
}
// --- 逐次通知 ---
// 对当前失败步骤立即发送；发送卡住时有界退出，让备用链继续。
async function notifyCapabilityStepFailure(providerId, model, capability, details = {}) {
    const provider = getProviderCatalogEntry(providerId);
    const providerName = provider?.name || String(providerId || 'unknown');
    const modelName = String(model || 'unknown');
    const admins = [...getAdminUserIds(true)];
    const purposes = { chat: '聊天', vision: '识图', topic_switch: '话题判断', identity_judge: '身份判断', 'voice-asr': '语音识别', 'voice-tts': '语音合成' };
    const message = [
        `${CAPABILITY_LABELS[capability]}模型调用失败`,
        `用途：${purposes[details.purpose || ''] || details.purpose || CAPABILITY_LABELS[capability]}`,
        `供应商：${sanitizeDiagnosticText(providerName)}`, `模型：${sanitizeDiagnosticText(modelName)}`,
        `时间：${new Date().toISOString()}`, `原因：${sanitizeDiagnosticText(details.reason || '原因未明')}`,
        `状态：${formatModelHttpStatus(details.status || 0)}${details.code ? `｜${details.code}` : ''}`,
        ...(details.upstreamCode ? [`上游错误码：${sanitizeDiagnosticText(details.upstreamCode)}`] : []),
        `上游说明：${sanitizeDiagnosticText(details.summary || '未提供')}`,
        `请求编号：${details.requestId || '未提供'}`, `上游请求编号：${sanitizeDiagnosticText(details.upstreamRequestId || '未提供')}`,
    ].join('\n');
    if (!failureSender || !admins.length)
        return false;
    await Promise.all(admins.map(async (adminId) => {
        let timer;
        try {
            await Promise.race([failureSender?.(adminId, message), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('通知发送超时')), 1500); })]);
        }
        catch {
            console.warn(`[ai-capability] failure_notification_failed capability=${capability}`);
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }));
    return true;
}
// 供测试和插件卸载时释放发送器引用。
function resetCapabilityFailureNotifier() {
    failureSender = null;
}
module.exports = {
    FAILURE_NOTIFICATION_COOLDOWN_MS,
    setCapabilityFailureSender,
    registerCapabilityFailureContext,
    notifyCapabilityStepFailure,
    resetCapabilityFailureNotifier,
};
