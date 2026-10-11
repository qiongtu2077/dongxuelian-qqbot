"use strict";
/**
 * MODULE: 能力优先级故障通知。
 * 职责: 对能力/供应商/模型故障做 30 分钟冷却，并动态通知全部超级管理员。
 * 边界: 通知失败只记录脱敏警告，不影响模型回退或用户请求。
 */
const { getAdminUserIds } = require('./runtime-config');
const { AI_CAPABILITIES, getProviderCatalogEntry } = require('./ai-capability-config');
const FAILURE_NOTIFICATION_COOLDOWN_MS = 30 * 60 * 1000;
const CAPABILITY_LABELS = { text: '文字', vision: '识图', 'voice-asr': '语音识别', 'voice-tts': '语音合成' };
const failureCooldowns = new Map();
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
// --- 冷却与通知 ---
// 清理过期冷却项，防止长期运行进程无限增长。
function pruneFailureCooldowns(now) {
    for (const [key, expiresAt] of failureCooldowns) {
        if (expiresAt <= now)
            failureCooldowns.delete(key);
    }
}
// 对一个失败步骤通知全部动态管理员，同一能力/供应商/模型 30 分钟内只发送一次。
async function notifyCapabilityStepFailure(providerId, model, capability, now = Date.now()) {
    const provider = getProviderCatalogEntry(providerId);
    const providerName = provider?.name || String(providerId || 'unknown');
    const modelName = String(model || 'unknown');
    // 同一模型可同时承担文字和识图，冷却不能跨能力遮蔽故障。
    const cooldownKey = `${capability}\u0000${providerId}\u0000${modelName}`;
    pruneFailureCooldowns(now);
    if ((failureCooldowns.get(cooldownKey) || 0) > now)
        return false;
    failureCooldowns.set(cooldownKey, now + FAILURE_NOTIFICATION_COOLDOWN_MS);
    const admins = [...getAdminUserIds(true)];
    const message = `${CAPABILITY_LABELS[capability]}高优先级模型出错，请管理员去控制台查看\n供应商：${providerName}\n模型：${modelName}`;
    if (!failureSender || !admins.length)
        return false;
    await Promise.all(admins.map(async (adminId) => {
        try {
            await failureSender?.(adminId, message);
        }
        catch {
            console.warn(`[ai-capability] failure_notification_failed capability=${capability} provider=${providerId} model=${modelName}`);
        }
    }));
    return true;
}
// 清空冷却状态，供测试和插件卸载时释放内存。
function resetCapabilityFailureNotifier() {
    failureCooldowns.clear();
    failureSender = null;
}
module.exports = {
    FAILURE_NOTIFICATION_COOLDOWN_MS,
    setCapabilityFailureSender,
    registerCapabilityFailureContext,
    notifyCapabilityStepFailure,
    resetCapabilityFailureNotifier,
};
