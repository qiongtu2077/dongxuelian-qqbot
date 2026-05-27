"use strict";
/* ==========================================================================
 * MODULE: bot-resolver
 * 职责：解析当前 Koishi bot，并为异步队列中的 session 注入最新 bot 引用。
 * 边界：不注册 middleware、不发送消息、不读写配置或 conversation。
 * 状态：无模块级缓存；每次从 ctx/session 当前状态解析。
 * ========================================================================== */
const { patchEnsureSession } = require('./session-compat');
function asBotResolverObject(value) {
    return value && typeof value === 'object' ? value : null;
}
function asBotResolverBot(value) {
    return value && typeof value === 'object' ? value : null;
}
function asBotResolverContext(ctx) {
    return asBotResolverObject(ctx) || {};
}
function asBotResolverSession(session) {
    return asBotResolverObject(session) || {};
}
function resolveCurrentBot(ctx, fallbackBot = null, selfId = '') {
    const source = asBotResolverContext(ctx);
    const bots = [];
    if (Array.isArray(source.bots)) {
        for (const item of source.bots) {
            const bot = asBotResolverBot(item);
            if (bot)
                bots.push(bot);
        }
    }
    const targetSelfId = String(selfId || '');
    if (targetSelfId) {
        const matched = bots.find(bot => String(bot?.selfId || '') === targetSelfId);
        if (matched)
            return matched;
    }
    return bots[0] || asBotResolverBot(source.bot) || asBotResolverBot(fallbackBot) || null;
}
function createBotResolver(ctx, session = {}) {
    const source = asBotResolverSession(session);
    const fallbackBot = asBotResolverBot(source.bot);
    const selfId = String(source.selfId || fallbackBot?.selfId || source.event?.selfId || '');
    return () => resolveCurrentBot(ctx, fallbackBot, selfId);
}
function withCurrentBot(session, bot) {
    const resolvedBot = asBotResolverBot(bot);
    if (!session || !resolvedBot)
        return session;
    const source = asBotResolverSession(session);
    if (source.bot === resolvedBot)
        return session;
    const runtimeSession = Object.assign(Object.create(Object.getPrototypeOf(session) || Object.prototype), session);
    runtimeSession.bot = resolvedBot;
    return patchEnsureSession(runtimeSession);
}
module.exports = {
    resolveCurrentBot,
    createBotResolver,
    withCurrentBot,
};
