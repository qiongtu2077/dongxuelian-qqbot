"use strict";
/**
 * MODULE: Agent 工具注册器。
 * 职责: 聚合工具定义、按渠道过滤、executeTool 分发。
 * 边界: 不调 AI API、不读配置、不存用户状态。
 * 状态: toolRegistry (module-level const)。
 */
const getTimeTool = require('./get-time');
const calculatorTool = require('./calculator');
const webSearchTool = require('./web-search');
const webFetchTool = require('./web-fetch');
const readAgentSkillTool = require('./read-agent-skill');
const readFileTool = require('./read-file');
const listFilesTool = require('./list-files');
const findFilesTool = require('./find-files');
const writeFileTool = require('./write-file');
const editFileTool = require('./edit-file');
const shellTool = require('./shell');
const browserActionTool = require('./browser-action');
const appendFileTool = require('./append-file');
const grepSearchTool = require('./grep-search');
const executeJavascriptTool = require('./execute-javascript');
const sendFileToUserTool = require('./send-file-to-user');
const createUploadedFileVariantTool = require('./create-uploaded-file-variant');
const getTokenUsageTool = require('./get-token-usage');
const setUserTimezoneTool = require('./set-user-timezone');
const queryLogsTool = require('./query-logs');
const reminderTools = require('./reminder-tools');
const scheduledTaskTools = require('./scheduled-task-tools');
const readImageUrlsTool = require('./read-image-urls');
const analyzeImageTool = require('./analyze-image');
const analyzeFileTool = require('./analyze-file');
const planTools = require('../plan/plan-tools');
const memoryTools = require('./memory-tools');
const { getAgentConfig } = require('../config');
const tools = [getTimeTool, calculatorTool, webSearchTool, webFetchTool, readAgentSkillTool, readFileTool, listFilesTool, findFilesTool, writeFileTool, editFileTool, shellTool, browserActionTool, appendFileTool, grepSearchTool, executeJavascriptTool, sendFileToUserTool, createUploadedFileVariantTool, getTokenUsageTool, setUserTimezoneTool, queryLogsTool, ...reminderTools.tools, ...scheduledTaskTools.tools, readImageUrlsTool, analyzeImageTool, analyzeFileTool, ...planTools.tools, ...memoryTools.tools];
const TOOL_TIMEOUT_MS = 90000;
/** 记忆相关工具：当 memory.enabled=false 时整体从工具定义中隐藏 */
const MEMORY_TOOL_NAMES = new Set(['remember_memory', 'search_memory', 'forget_memory', 'list_memory']);
const toolRegistry = {};
for (const tool of tools) {
    toolRegistry[tool.definition.name] = tool;
}
/** 按渠道过滤，返回 OpenAI 标准格式的工具定义 */
function getToolDefinitions(channel = 'qq') {
    const config = getAgentConfig();
    const channelConfig = config.channels[channel];
    if (!channelConfig || !channelConfig.enabled)
        return [];
    const memoryDisabled = config.memory?.enabled === false;
    return tools
        .filter(t => {
        const name = t.definition.name;
        if (memoryDisabled && MEMORY_TOOL_NAMES.has(name))
            return false;
        const channels = t.defaultChannels || ['dashboard', 'qq'];
        return channels.includes(channel) && !!channelConfig.tools[name];
    })
        .map(t => ({ type: 'function', function: t.definition }));
}
/** 安全执行工具：超时 + 错误包裹 */
function getRegistryErrorMessage(error) {
    return error instanceof Error ? error.message : String(error || '');
}
async function executeTool(toolName, params = {}, context = {}) {
    const tool = toolRegistry[toolName];
    if (!tool)
        return { ok: false, text: `未知工具：${toolName}`, error: `未知工具：${toolName}` };
    let timeoutId = null;
    const abortController = new AbortController();
    try {
        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
                abortController.abort();
                reject(new Error('执行超时'));
            }, TOOL_TIMEOUT_MS);
        });
        const enrichedContext = { ...context, signal: abortController.signal };
        const result = await Promise.race([tool.execute(params, enrichedContext), timeoutPromise]);
        if (result && typeof result === 'object' && !Array.isArray(result)) {
            const objectResult = result;
            const text = typeof objectResult.text === 'string' ? objectResult.text : JSON.stringify(objectResult, null, 2);
            return { ok: objectResult.ok !== false, text, error: String(objectResult.error || ''), fallbackTool: objectResult.fallbackTool || null };
        }
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return { ok: true, text };
    }
    catch (err) {
        const errorMessage = getRegistryErrorMessage(err);
        const message = `工具 '${toolName}' 执行失败: ${errorMessage}`;
        return { ok: false, text: message, error: errorMessage };
    }
    finally {
        if (timeoutId)
            clearTimeout(timeoutId);
        abortController.abort();
    }
}
function getToolCount() { return tools.length; }
function getToolSummaries(channel = '') {
    const config = getAgentConfig();
    return tools.map(tool => {
        const name = tool.definition.name;
        const defaultChannels = tool.defaultChannels || ['dashboard', 'qq'];
        const channels = {};
        for (const key of Object.keys(config.channels || {}))
            channels[key] = !!config.channels[key]?.tools?.[name];
        const dangerous = !!tool.dangerous;
        const external = name === 'web_search' || name === 'web_fetch' || name === 'browser_action';
        const write = dangerous || /write|edit|append|shell|javascript|remember|forget|create_plan|create_reminder|cancel_reminder|create_scheduled_task|create_uploaded_file_variant|send_file_to_user|update_task_status|finish_plan|abandon_plan/i.test(name);
        return {
            name,
            description: tool.definition.description || '',
            dangerous,
            readOnly: !dangerous && !write && !external,
            write,
            external,
            defaultChannels,
            channels,
            enabled: channel ? !!config.channels?.[channel]?.tools?.[name] : undefined,
        };
    });
}
module.exports = { getToolDefinitions, executeTool, toolRegistry, getToolCount, getToolSummaries };
