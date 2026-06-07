"use strict";
/**
 * MODULE: agent-auto-route-flow
 * 职责: 执行 QQ 消息的 Agent 自动路由桥接，并把 Agent 结果转成 chat 口吻文本。
 * 边界: 不发送消息、不注册 middleware、不拥有队列；Agent/队列/chat 由调用方注入。
 * 状态: 无模块级状态。
 */
const { heuristicRoute, buildExplicitSearchRunOptions } = require('../agent/router');
const { getAgentConfig } = require('../agent/config');
const { hasAdminPermission, isJailbreakAttempt, sanitizeUserInput } = require('../core/utils');
const { logDebug } = require('../core/logging-config');
const { submitAgentWorkerTask } = require('../agent/worker-submission');
const { createAgentRunWorkerPayload } = require('../resource-workers/agent-payload');
function getAutoRouteErrorMessage(error) {
    return error instanceof Error ? error.message : String(error?.message || error);
}
async function handleAgentAutoRoute({ ctx, liveSession, channelKey, currentUserId, userName, userText, randomTriggered, recentUserMessages, searchContext, resolveBot, chat, agentEngine, enqueueAgentTask, configureAgentQueue, retellAgentResult, }) {
    let route = heuristicRoute(userText, 'qq', { recentUserMessages, searchContext });
    if (isJailbreakAttempt(sanitizeUserInput(userText)))
        route = { useAgent: false, reason: 'jailbreak-chat-guard' };
    if (!route.useAgent)
        return { handled: false };
    logDebug(ctx, 'agent', `auto-route reason=${route.reason} channel=${channelKey}`);
    const searchRunOptions = buildExplicitSearchRunOptions(userText, { recentUserMessages, searchContext });
    const agentConfig = getAgentConfig();
    configureAgentQueue(agentConfig.queue || {});
    try {
        const agentRunInput = {
            userMessage: searchRunOptions.agentUserMessage || userText,
            userName,
            userId: currentUserId,
            channelKey,
            channel: 'qq',
            agentMode: true,
            isAdmin: hasAdminPermission(liveSession),
            ...searchRunOptions,
        };
        const submission = submitAgentWorkerTask({
            channel: 'qq',
            channelKey,
            userId: currentUserId,
            timeoutMs: agentConfig.queue?.timeoutMs,
            maxActivePerUser: agentConfig.queue?.maxPendingPerUser,
            payload: { entry: 'qq-auto-route', reason: route.reason || '', agentWorker: createAgentRunWorkerPayload('qq-auto-route', agentRunInput) },
        });
        return { handled: true, reply: submission.message };
    }
    catch (error) {
        const errorLike = error && typeof error === 'object' ? error : {};
        const code = errorLike.code ? String(errorLike.code) : '';
        if (code === 'AGENT_QUEUE_FULL' || code === 'AGENT_QUEUE_REJECTED') {
            return { handled: true, reply: getAutoRouteErrorMessage(error) };
        }
        ctx.logger('dongxuelian-ai').warn(`agent auto-route failed: ${getAutoRouteErrorMessage(error)}`);
        return { handled: true, reply: 'Agent 暂时不可用。' };
    }
}
module.exports = {
    handleAgentAutoRoute,
};
