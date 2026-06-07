"use strict";
/**
 * MODULE: Agent ReAct 引擎。
 * 职责: 构建 Agent 消息、调用 LLM + tools、循环推理-执行。
 * 边界: 不使用 chat.js 的 system prompt 构建逻辑；不写 conversation.js。
 * 状态: 无模块级状态（每次 run() 新建循环局部变量）。
 */
const { requestChatCompletions } = require('../core/api');
const { loadConfig } = require('../core/runtime-config');
const { getToolDefinitions, executeTool, toolRegistry } = require('./tools/registry');
const { estimateTokens, externalizeToolResult, compactWithLLM } = require('./context');
const { recordCall } = require('./stats');
const safety = require('./safety');
const pending = require('./pending');
const { isChannelEnabled, isToolEnabled, getEnabledSkills } = require('./config');
const { buildAgentSkillSummary } = require('./skills');
const { buildAgentMessages } = require('./messages');
const { buildAgentPersonaContext, mergeAgentSystemExtra } = require('./persona-context');
const { buildAgentWorkspaceContext } = require('./workspace-context');
const { getAgentPathAllowedRoots } = require('./path-guard');
const { recordAgentSession } = require('./sessions');
const { onAgentReplyComplete } = require('./auto-memory');
const { MAX_TOOL_ROUNDS } = require('../core/constants');
const { getRecentFilesCached } = require('../media/file/file-store');
const MAX_ROUNDS = MAX_TOOL_ROUNDS;
const MAX_TOOLS_PER_ROUND = 3;
const MAX_WEB_SEARCH_CALLS = 6;
const EXTERNAL_TOOL_NAMES = new Set(['web_search', 'web_fetch', 'browser_action']);
function isFallbackTool(value) {
    return !!value && typeof value === 'object' && typeof value.name === 'string';
}
function getAgentEngineErrorMessage(error) {
    return error instanceof Error ? error.message : String(error || '');
}
function asApiMessages(messages) {
    return messages;
}
function asToolDefinitions(tools) {
    return tools;
}
function normalizeToolDefinitions(tools) {
    return tools;
}
function requestAgentCompaction(messages, config, options) {
    return requestChatCompletions(messages, config, options);
}
function buildFileHintContext(channelKey) {
    if (!channelKey)
        return [];
    const files = getRecentFilesCached(channelKey, 10);
    if (!files.length)
        return [];
    const now = Date.now();
    const hints = files.filter(f => !f.skipped).map(f => {
        const age = now - (f.ts || 0);
        let timeLabel;
        if (age < 60000)
            timeLabel = '刚刚';
        else if (age < 3600000)
            timeLabel = `${Math.floor(age / 60000)}分钟前`;
        else
            timeLabel = `${Math.floor(age / 3600000)}小时前`;
        const status = f.analyzed ? '已分析' : '可分析';
        return `${f.fileName}(${timeLabel},${status})`;
    });
    if (!hints.length)
        return [];
    return [{ role: 'system', content: `[近期文件: ${hints.join(', ')}]` }];
}
function normalizeToolCall(toolName, args = {}) {
    return {
        id: `tool_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'function',
        function: { name: toolName, arguments: JSON.stringify(args || {}) },
    };
}
function parseAgentEngineToolArguments(raw) {
    try {
        return JSON.parse(raw || '{}');
    }
    catch { /* non-critical: invalid tool arguments fall back to empty object */
        return {};
    }
}
async function executeAgentToolCall({ tc, messages, allowedToolNames, channel, channelKey, userId, userName, userMessage, toolCount, bot, isAdmin = false, resourceTaskId = '' }) {
    const args = parseAgentEngineToolArguments(tc.function.arguments);
    const toolName = tc.function.name;
    if (!allowedToolNames.has(toolName)) {
        return {
            status: 'done',
            result: `工具 '${toolName}' 当前渠道未启用，拒绝执行。请在 Dashboard 的 Agent 工具开关里启用 ${toolName}。`,
            toolCount,
        };
    }
    const safeResult = safety.check(toolName);
    if (!safeResult.allowed) {
        if (safeResult.action === 'confirm' && userId && channelKey) {
            const resume = {
                messages: messages.slice(-24),
                toolCallId: tc.id,
                userMessage,
                userName,
                toolCount,
            };
            const pendingId = pending.setPendingTool(channelKey, userId, { toolName, args, channel, resume });
            const argsSummary = pending.summarizePendingArgs ? pending.summarizePendingArgs(toolName, args) : toolName;
            const replyText = `工具 '${toolName}' 需要确认（ID: ${pendingId}）。参数：${argsSummary}\n请回复“确认工具 ${pendingId}”来执行。`;
            return { status: 'pending', reply: replyText, pendingId, toolCount };
        }
        return { status: 'done', result: safeResult.error, toolCount };
    }
    try {
        const startedAt = Date.now();
        const execResult = await executeTool(toolName, args, { channel, channelKey, userId, userName, userMessage, bot, isAdmin, resourceTaskId, taskId: resourceTaskId });
        let nextToolCount = toolCount;
        recordCall(toolName, channel, { ok: execResult.ok, durationMs: Date.now() - startedAt, tokens: estimateTokens([{ role: 'tool', content: execResult.text }]) });
        if (execResult.ok)
            nextToolCount++;
        if (isFallbackTool(execResult.fallbackTool)) {
            return {
                status: 'fallback',
                result: execResult.text,
                fallbackCall: normalizeToolCall(execResult.fallbackTool.name, execResult.fallbackTool.args || {}),
                toolCount: nextToolCount,
            };
        }
        return { status: 'done', result: execResult.text, toolCount: nextToolCount };
    }
    catch (error) {
        return { status: 'done', result: `工具 '${toolName}' 执行失败: ${getAgentEngineErrorMessage(error)}`, toolCount };
    }
}
const COMPRESS_TOOL_RESULT_THRESHOLD = 1500;
function compressOldToolResults(messages, currentRound) {
    let toolMsgCount = 0;
    const totalToolMsgs = messages.filter(m => m.role === 'tool').length;
    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role !== 'tool')
            continue;
        toolMsgCount++;
        if (toolMsgCount >= totalToolMsgs - 1)
            break;
        const content = messages[i].content || '';
        if (content.length > COMPRESS_TOOL_RESULT_THRESHOLD) {
            messages[i] = { ...messages[i], content: content.slice(0, 400) + '\n...[已截断旧工具结果]...' };
        }
    }
}
function toAgentToolCalls(toolCalls) {
    return Array.isArray(toolCalls) ? toolCalls : [];
}
async function continueAgent({ messages, config, tools, allowedToolNames, channel, channelKey, userId, userName, userMessage, toolCount = 0, toolResults = [], onProgress, bot, enableThinking = false, isAdmin = false, resourceTaskId = '' }) {
    let reply = '';
    const rounds = [];
    for (let round = 0; round < MAX_ROUNDS; round++) {
        let response;
        try {
            response = await requestChatCompletions(asApiMessages(messages), config, { _thinkingEnabled: enableThinking }, asToolDefinitions(tools));
        }
        catch (error) {
            reply = `Agent 调用模型失败：${getAgentEngineErrorMessage(error)}`;
            break;
        }
        if (typeof response === 'string') {
            reply = response;
            break;
        }
        if (response.type === 'text') {
            reply = response.content || '';
            rounds.push({ round, reasoning: enableThinking ? (response.reasoning || '') : '', toolCalls: [], toolResults: [] });
            break;
        }
        const { tool_calls, message: assistantMsg } = response;
        const responseToolCalls = toAgentToolCalls(tool_calls);
        if (!responseToolCalls || responseToolCalls.length === 0) {
            reply = typeof assistantMsg?.content === 'string' ? assistantMsg.content : '';
            rounds.push({ round, reasoning: enableThinking ? (response.reasoning || '') : '', toolCalls: [], toolResults: [] });
            break;
        }
        const activeToolCalls = responseToolCalls.slice(0, MAX_TOOLS_PER_ROUND);
        messages.push({
            role: 'assistant',
            content: typeof assistantMsg?.content === 'string' ? assistantMsg.content : null,
            tool_calls: activeToolCalls.map(tc => ({
                id: tc.id, type: 'function',
                function: { name: tc.function.name, arguments: tc.function.arguments },
            })),
        });
        const roundToolCalls = activeToolCalls.map(tc => ({
            id: tc.id,
            name: tc.function.name,
            args: parseAgentEngineToolArguments(tc.function.arguments),
        }));
        const roundToolResults = [];
        for (const tc of activeToolCalls) {
            let currentCall = tc;
            let fallbackDepth = 0;
            // 多轮搜索限制：preExecuteTools + 循环中的 web_search 总次数超过上限时，阻止继续搜索
            if (tc.function.name === 'web_search') {
                const webSearchTotal = toolResults.filter(t => t.name === 'web_search').length + 1;
                if (webSearchTotal > MAX_WEB_SEARCH_CALLS) {
                    const blockMsg = `web_search 已调用 ${webSearchTotal - 1} 次。请基于现有搜索结果给出最佳回答，不要再调用搜索。`;
                    roundToolResults.push({ name: 'web_search', result: blockMsg, status: 'done' });
                    messages.push({ role: 'tool', tool_call_id: tc.id, content: await externalizeToolResult(blockMsg, 'web_search') });
                    continue;
                }
            }
            while (currentCall && fallbackDepth < 2) {
                const outcome = await executeAgentToolCall({ tc: currentCall, messages, allowedToolNames, channel, channelKey, userId, userName, userMessage, toolCount, bot, isAdmin, resourceTaskId });
                toolCount = outcome.toolCount;
                if (outcome.status === 'pending') {
                    rounds.push({ round, reasoning: response.reasoning || '', toolCalls: roundToolCalls, toolResults: roundToolResults });
                    recordAgentSession({ channel, channelKey, userId, userName, userMessage, reply: outcome.reply, toolCalls: toolCount, pendingId: outcome.pendingId });
                    return { reply: outcome.reply, toolCalls: toolCount, pendingId: outcome.pendingId, toolResults, rounds };
                }
                const resultText = String(outcome.result || '').slice(0, 8000);
                toolResults.push({ name: currentCall.function.name, result: resultText });
                roundToolResults.push({ name: currentCall.function.name, result: resultText, status: outcome.status });
                messages.push({ role: 'tool', tool_call_id: currentCall.id, content: await externalizeToolResult(outcome.result, currentCall.function.name) });
                if (outcome.status !== 'fallback' || !outcome.fallbackCall)
                    break;
                currentCall = outcome.fallbackCall;
                messages.push({
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                            id: currentCall.id,
                            type: currentCall.type,
                            function: { name: currentCall.function.name, arguments: currentCall.function.arguments },
                        }],
                });
                fallbackDepth++;
            }
        }
        rounds.push({ round, reasoning: response.reasoning || '', toolCalls: roundToolCalls, toolResults: roundToolResults });
        if (round >= 2)
            compressOldToolResults(messages, round);
        let estimated = estimateTokens(messages);
        if (estimated > 60000) {
            messages.splice(0, messages.length, ...await compactWithLLM(messages, config, requestAgentCompaction));
            estimated = estimateTokens(messages);
        }
        if (estimated > 80000) {
            reply = '(上下文过大，Agent 已中止)';
            break;
        }
        if (onProgress)
            onProgress({ type: 'round', round, toolCount, estimatedTokens: estimated }, round);
    }
    if (!reply)
        reply = '(Agent 未获取到有效回复)';
    recordAgentSession({ channel, channelKey, userId, userName, userMessage, reply, toolCalls: toolCount, pendingId: null });
    return { reply, toolCalls: toolCount, pendingId: null, toolResults, rounds };
}
/**
 * @param {object} opts
 * @param {string} opts.userMessage - 用户输入文本
 * @param {string} opts.userName - 用户名称
 * @param {string} opts.userId - 用户 ID（用于 pending 隔离）
 * @param {string} opts.channelKey - 频道 key（用于 pending 隔离）
 * @param {string} [opts.channel='qq'] - 渠道: 'qq' | 'dashboard'
 * @param {object} [opts.systemExtra=[]] - 额外 system 消息
 * @param {Array} [opts.history=[]] - 额外对话历史
 * @param {object} [opts.onProgress] - 每轮回调
 * @param {object} [opts.bot] - 可选 Koishi bot，用于计划完成/cron 等主动推送
 * @returns {{ reply: string, toolCalls: number, pendingId: string|null }}
 */
function ensureToolDefinition(tools, toolName) {
    if (!toolRegistry[toolName] || tools.some(item => item.function && item.function.name === toolName))
        return tools;
    return [...tools, { type: 'function', function: toolRegistry[toolName].definition }];
}
function getForceToolSet(forceTools, channel = 'qq') {
    return new Set((Array.isArray(forceTools) ? forceTools : []).map(name => String(name || '')).filter(name => toolRegistry[name] && isToolEnabled(channel, name)));
}
function normalizeContextPolicy(policy = {}) {
    if (!policy || typeof policy !== 'object' || Array.isArray(policy))
        return { allowExternalTools: true, allowedTools: [] };
    const record = policy;
    const allowedTools = Array.isArray(record.allowedTools)
        ? record.allowedTools.map(item => String(item || '').trim()).filter(Boolean)
        : [];
    return {
        allowExternalTools: record.allowExternalTools !== false,
        allowedTools,
    };
}
function applyContextPolicyToTools(tools = [], contextPolicy = {}) {
    const policy = normalizeContextPolicy(contextPolicy);
    let result = Array.isArray(tools) ? tools.slice() : [];
    if (policy.allowExternalTools === false) {
        result = result.filter(item => !EXTERNAL_TOOL_NAMES.has(item.function?.name));
    }
    if (policy.allowedTools.length) {
        const allow = new Set(policy.allowedTools);
        result = result.filter(item => allow.has(item.function?.name));
    }
    return result;
}
function getScheduledContextPolicy(scheduledTask) {
    return scheduledTask && typeof scheduledTask === 'object' && !Array.isArray(scheduledTask)
        ? scheduledTask.contextPolicy
        : undefined;
}
function normalizePreExecuteTools(value) {
    return Array.isArray(value) ? value : [];
}
async function runAgent({ userMessage, userName, userId, channelKey, channel = 'qq', systemExtra = [], history = [], forceTools = [], preExecuteTools = [], onProgress, bot, enableThinking = false, agentMode = false, scheduledTask = null, contextPolicy = null, isAdmin = false, resourceTaskId = '' }) {
    const safeChannel = String(channel || 'qq');
    const safeUserMessage = String(userMessage || '');
    const safeUserName = String(userName || '');
    const safeUserId = String(userId || '');
    const safeChannelKey = String(channelKey || '');
    const safeResourceTaskId = String(resourceTaskId || '');
    if (!isChannelEnabled(safeChannel))
        return { reply: '(Agent 已关闭)', toolCalls: 0, pendingId: null, toolResults: [] };
    const effectiveContextPolicy = normalizeContextPolicy(contextPolicy || getScheduledContextPolicy(scheduledTask) || {});
    let tools = applyContextPolicyToTools(normalizeToolDefinitions(getToolDefinitions(safeChannel)), effectiveContextPolicy);
    const forceToolSet = getForceToolSet(forceTools, safeChannel);
    for (const toolName of forceToolSet) {
        if (effectiveContextPolicy.allowExternalTools === false && EXTERNAL_TOOL_NAMES.has(toolName))
            continue;
        if (effectiveContextPolicy.allowedTools.length && !effectiveContextPolicy.allowedTools.includes(toolName))
            continue;
        tools = ensureToolDefinition(tools, toolName);
    }
    const allowedToolNames = new Set(tools.map(item => item.function && item.function.name).filter(Boolean));
    const config = await loadConfig();
    const roots = safeChannel === 'dashboard' ? await getAgentPathAllowedRoots() : [];
    const skillSummary = buildAgentSkillSummary(getEnabledSkills(), { query: safeUserMessage });
    const personaExtra = buildAgentPersonaContext({ channel: safeChannel, channelKey: safeChannelKey, userId: safeUserId, agentMode: !!agentMode });
    const workspaceExtra = await buildAgentWorkspaceContext({ userMessage: safeUserMessage, channel: safeChannel, roots });
    const allSystemExtra = mergeAgentSystemExtra(personaExtra, workspaceExtra, systemExtra, skillSummary ? [{ role: 'system', content: skillSummary }] : [], buildFileHintContext(safeChannelKey));
    const messages = buildAgentMessages({ userMessage: safeUserMessage, userName: safeUserName, tools, systemExtra: allSystemExtra, history, agentMode: !!agentMode });
    const toolResults = [];
    let toolCount = 0;
    for (const item of normalizePreExecuteTools(preExecuteTools)) {
        if (!item || !item.name)
            continue;
        if (!isToolEnabled(safeChannel, item.name) || !allowedToolNames.has(item.name)) {
            toolResults.push({
                name: item.name,
                result: !isToolEnabled(safeChannel, item.name)
                    ? `工具 '${item.name}' 当前渠道未启用，拒绝预执行。请在 Dashboard 的 Agent 工具开关里启用 ${item.name}。`
                    : `工具 '${item.name}' 被当前任务策略禁止，拒绝预执行。`,
            });
            continue;
        }
        if (forceToolSet.has(item.name))
            allowedToolNames.add(item.name);
        const call = normalizeToolCall(item.name, item.args || {});
        messages.push({
            role: 'assistant',
            content: null,
            tool_calls: [{ id: call.id, type: call.type, function: call.function }],
        });
        const outcome = await executeAgentToolCall({ tc: call, messages, allowedToolNames, channel: safeChannel, channelKey: safeChannelKey, userId: safeUserId, userName: safeUserName, userMessage: safeUserMessage, toolCount, bot, isAdmin: !!isAdmin, resourceTaskId: safeResourceTaskId });
        toolCount = outcome.toolCount;
        if (outcome.status === 'pending') {
            recordAgentSession({ channel: safeChannel, channelKey: safeChannelKey, userId: safeUserId, userName: safeUserName, userMessage: safeUserMessage, reply: outcome.reply, toolCalls: toolCount, pendingId: outcome.pendingId });
            return { reply: outcome.reply, toolCalls: toolCount, pendingId: outcome.pendingId, toolResults };
        }
        toolResults.push({ name: call.function.name, result: String(outcome.result || '').slice(0, 8000) });
        messages.push({ role: 'tool', tool_call_id: call.id, content: await externalizeToolResult(outcome.result, call.function.name) });
    }
    const agentResult = await continueAgent({ messages, config, tools, allowedToolNames, channel: safeChannel, channelKey: safeChannelKey, userId: safeUserId, userName: safeUserName, userMessage: safeUserMessage, toolCount, toolResults, onProgress, bot, enableThinking: !!enableThinking, isAdmin: !!isAdmin, resourceTaskId: safeResourceTaskId });
    onAgentReplyComplete({ userId: safeUserId, channel: safeChannel, messages }).catch(e => console.warn('[agent-engine] onAgentReplyComplete error:', getAgentEngineErrorMessage(e)));
    return agentResult;
}
function pendingResumeRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
async function resumePending({ channelKey, userId, channel = 'qq', expectedId = '', onProgress, bot, isAdmin = false, resourceTaskId = '' }) {
    const safeChannelKey = String(channelKey || '');
    const safeUserId = String(userId || '');
    const safeChannel = String(channel || 'qq');
    const safeResourceTaskId = String(resourceTaskId || '');
    const executed = await pending.executePendingTool(safeChannelKey, safeUserId, safeChannel, String(expectedId || ''), { bot, isAdmin: !!isAdmin, resourceTaskId: safeResourceTaskId });
    if (!executed.pending)
        return executed;
    const p = executed.pending;
    const config = await loadConfig();
    const tools = normalizeToolDefinitions(getToolDefinitions(safeChannel));
    const allowedToolNames = new Set(tools.map(item => item.function && item.function.name).filter(Boolean));
    const resume = pendingResumeRecord(p.resume);
    const messages = Array.isArray(resume.messages) ? resume.messages.slice() : [];
    messages.push({ role: 'tool', tool_call_id: String(resume.toolCallId || p.id), content: await externalizeToolResult(executed.result || executed.message || '', p.toolName) });
    if (executed.ok) {
        recordCall(p.toolName, safeChannel, { ok: true, tokens: estimateTokens([{ role: 'tool', content: executed.result || '' }]) });
    }
    return continueAgent({
        messages,
        config,
        tools,
        allowedToolNames,
        channel: safeChannel,
        channelKey: safeChannelKey,
        userId: safeUserId,
        userName: String(resume.userName || safeUserId),
        userMessage: String(resume.userMessage || ''),
        toolCount: (resume.toolCount || 0) + (executed.ok ? 1 : 0),
        toolResults: [{ name: p.toolName, result: String(executed.result || executed.message || '').slice(0, 8000) }],
        onProgress,
        bot,
        isAdmin: safeChannel === 'dashboard' || !!isAdmin,
        resourceTaskId: safeResourceTaskId,
    });
}
module.exports = { run: runAgent, resumePending, normalizeContextPolicy, applyContextPolicyToTools };
