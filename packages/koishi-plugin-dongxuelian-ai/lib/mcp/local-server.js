#!/usr/bin/env node
'use strict';
/**
 * MODULE: 本地 MCP stdio server。
 * 职责: 给 Codex/Claude 等本地客户端暴露莲莲 Bot 的诊断、工作区读写和本地检查工具。
 * 边界: 不接入 QQ 聊天主链路；不部署、不重启、不 push。
 * 状态: 无长期驻留状态，配置从 agent/config.js 读取。
 */
const { spawn } = require('child_process');
const path = require('path');
const { redactSensitiveText } = require('../core/redactor');
const agentConfig = require('../agent/config');
const registry = require('../agent/tools/registry');
const sessions = require('../agent/sessions');
const stats = require('../agent/stats');
const queryLogsTool = require('../agent/tools/query-logs');
const readFileTool = require('../agent/tools/read-file');
const listFilesTool = require('../agent/tools/list-files');
const findFilesTool = require('../agent/tools/find-files');
const grepSearchTool = require('../agent/tools/grep-search');
const writeFileTool = require('../agent/tools/write-file');
const editFileTool = require('../agent/tools/edit-file');
const { getRecentFiles, getFileEntry } = require('../media/file/file-store');
const { buildFileFollowupState } = require('../media/file/file-followup-state');
const { getAgentPathAllowedRoots, getAgentPathDefaultRoots } = require('../agent/path-guard');
const { admitTask } = require('../resource-scheduler/admission');
const { acquireResourceGate } = require('../resource-gate/gate');
const { sanitizeId } = require('../resource-common/files');
const SERVER_NAME = 'dongxuelian-local-mcp';
const SERVER_VERSION = '0.1.0';
const MCP_LOCAL_CHECK_TASK_KIND = 'mcp_local_check';
const MAX_OUTPUT_CHARS = 40000;
const RUN_TIMEOUT_MS = 120000;
const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
function getStringArg(args, key) {
    return String(args?.[key] || '').trim();
}
function getNumberArg(args, key, fallback) {
    return parseInt(String(args?.[key] || ''), 10) || fallback;
}
function getMcpErrorMessage(error) {
    return error instanceof Error ? error.message : String(error?.message || error);
}
function toDiagnosticFile(file) {
    return file && typeof file === 'object' ? file : null;
}
function textContent(text) {
    return [{ type: 'text', text: redactSensitiveText(String(text || '')).slice(0, MAX_OUTPUT_CHARS) }];
}
function jsonText(value) {
    return textContent(JSON.stringify(value, null, 2));
}
function okText(text) {
    return { content: textContent(text) };
}
function okJson(value) {
    return { content: jsonText(value) };
}
function errorResult(message) {
    return { isError: true, content: textContent(message || '工具执行失败') };
}
function getMcpConfig() {
    return agentConfig.getAgentConfig(true).mcp || {};
}
function ensureEnabled() {
    if (!getMcpConfig().enabled)
        throw new Error('本地 MCP 工作台已关闭，请先在 Dashboard Agent 窗口启用 MCP。');
}
function ensureWriteAllowed() {
    ensureEnabled();
    if (!getMcpConfig().allowWriteWorkspace)
        throw new Error('MCP 工作区写入已关闭。');
}
function ensureRunAllowed() {
    ensureEnabled();
    if (!getMcpConfig().allowRunLocal)
        throw new Error('MCP 本地检查命令已关闭。');
}
function createTool(name, description, inputSchema, handler, options = {}) {
    return { name, description, inputSchema: inputSchema || { type: 'object', properties: {} }, handler, write: !!options.write, run: !!options.run };
}
function getMcpToolDefinitions() {
    return TOOLS.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
    }));
}
function buildHealth(config, roots) {
    const mcp = config.mcp || {};
    return {
        ok: true,
        server: { name: SERVER_NAME, version: SERVER_VERSION },
        workspaceRoot: WORKSPACE_ROOT,
        dataDir: require('../core/constants').DATA_DIR,
        mcp: {
            enabled: !!mcp.enabled,
            allowWriteWorkspace: !!mcp.allowWriteWorkspace,
            allowRunLocal: !!mcp.allowRunLocal,
            exposeDangerousActions: !!mcp.exposeDangerousActions,
        },
        agent: {
            qqEnabled: !!config.channels?.qq?.enabled,
            dashboardEnabled: !!config.channels?.dashboard?.enabled,
            dangerousPolicy: config.dangerousPolicy || 'confirm',
        },
        allowedRoots: roots,
        tools: Number(registry.getToolCount() || 0),
    };
}
function normalizeMcpChannelKey(args = {}) {
    const channelKey = getStringArg(args, 'channelKey');
    if (channelKey)
        return channelKey;
    const groupId = getStringArg(args, 'groupId') || getStringArg(args, 'guildId');
    if (groupId)
        return groupId;
    const userId = getStringArg(args, 'userId');
    if (userId)
        return `private:${userId}`;
    return '';
}
function parseLocalCheckCommand(command = '') {
    const value = String(command || '').trim();
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const named = {
        check: [npmBin, ['run', 'check']],
        quick: [npmBin, ['run', 'test:quick']],
        scenario: [npmBin, ['run', 'test:scenario']],
        test: [npmBin, ['test']],
    };
    if (named[value])
        return named[value];
    const nodeSyntax = value.match(/^node\s+-c\s+(.+)$/);
    if (nodeSyntax) {
        const target = nodeSyntax[1].trim().replace(/^["']|["']$/g, '');
        if (!target || /[;&|<>`]/.test(target))
            throw new Error('node -c 目标文件不合法');
        const resolved = path.resolve(WORKSPACE_ROOT, target);
        const roots = getAgentPathDefaultRoots();
        const inside = roots.some((root) => resolved.startsWith(root + path.sep) || resolved === root);
        if (!inside)
            throw new Error('node -c 目标文件必须位于允许根内，拒绝访问: ' + target);
        return ['node', ['-c', resolved]];
    }
    throw new Error('只允许 check、quick、scenario、test 或 node -c <file>');
}
// 为本地 MCP 检查生成可追踪 taskId，避免受控命令绕过资源事件。
function buildMcpLocalCheckTaskId(commandName, args = []) {
    const label = sanitizeId([commandName, ...args].join('-')).slice(0, 80) || 'command';
    return `${MCP_LOCAL_CHECK_TASK_KIND}-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
// 将资源忙结果转换成 run_local_check 的标准命令结果。
function buildMcpLocalCheckBusyResult(reason) {
    return {
        ok: false,
        exitCode: null,
        error: `RESOURCE_BUSY: ${String(reason || 'local MCP check rejected by resource scheduler')}`,
        stdout: '',
        stderr: '',
    };
}
function runCommand(commandName, args, timeoutMs = RUN_TIMEOUT_MS) {
    return new Promise((resolve) => {
        const taskId = buildMcpLocalCheckTaskId(commandName, args);
        const admission = admitTask({
            taskId,
            kind: MCP_LOCAL_CHECK_TASK_KIND,
            source: 'local-mcp',
            channelKey: 'local-mcp',
            userId: 'local-mcp',
            exclusive: true,
            priority: 35,
            deferable: false,
            queueTimeoutMs: 5000,
            runTimeoutMs: timeoutMs,
        });
        if (admission.decision !== 'run_now')
            return resolve(buildMcpLocalCheckBusyResult(admission.reason || admission.decision));
        let stdout = '';
        let stderr = '';
        let timer = null;
        let gateHandle = null;
        let settled = false;
        const finishMcpLocalCheck = (result, reason = 'mcp-local-check-finally') => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            timer = null;
            if (gateHandle)
                gateHandle.release(reason);
            gateHandle = null;
            resolve(result);
        };
        acquireResourceGate({
            taskId,
            kind: MCP_LOCAL_CHECK_TASK_KIND,
            owner: 'local-mcp',
            channelKey: 'local-mcp',
            userId: 'local-mcp',
            priority: 35,
            timeoutMs,
            waitTimeoutMs: 5000,
            pollMs: 500,
            memAvailableMb: admission.memAvailableMb,
            step: 'mcp_local_check_prepare',
        }).then((handle) => {
            gateHandle = handle;
            gateHandle.updateStep('mcp_local_check_running', admission.memAvailableMb);
            const child = spawn(commandName, args, {
                cwd: WORKSPACE_ROOT,
                shell: false,
                windowsHide: true,
                env: { ...process.env },
            });
            timer = setTimeout(() => {
                try {
                    child.kill('SIGTERM');
                }
                catch { /* non-critical: process may have already exited */ }
                finishMcpLocalCheck({ ok: false, exitCode: null, timedOut: true, stdout, stderr }, 'mcp-local-check-timeout');
            }, timeoutMs);
            child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
            child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
            child.on('error', (error) => {
                finishMcpLocalCheck({ ok: false, exitCode: null, error: error.message, stdout, stderr }, 'mcp-local-check-error');
            });
            child.on('close', (code) => {
                finishMcpLocalCheck({ ok: code === 0, exitCode: code, stdout, stderr }, 'mcp-local-check-close');
            });
        }).catch((error) => {
            finishMcpLocalCheck(buildMcpLocalCheckBusyResult(error.message || error), 'mcp-local-check-gate-failed');
        });
    });
}
const TOOLS = [
    createTool('get_bot_health', '查看本地 MCP、Agent 配置和允许根目录状态。', {
        type: 'object',
        properties: {},
    }, async () => {
        ensureEnabled();
        const config = agentConfig.getAgentConfig(true);
        const roots = await getAgentPathAllowedRoots();
        return okJson(buildHealth(config, roots));
    }),
    createTool('get_agent_config', '读取 Agent 配置摘要和 MCP 开关。', {
        type: 'object',
        properties: {},
    }, async () => {
        ensureEnabled();
        const config = agentConfig.getAgentConfig(true);
        return okJson({
            dangerousPolicy: config.dangerousPolicy,
            autoRoute: config.autoRoute,
            queue: config.queue,
            mcp: config.mcp,
            channels: Object.fromEntries(Object.entries(config.channels || {}).map(([channel, value]) => [
                channel,
                { enabled: !!value.enabled, enabledTools: Object.entries(value.tools || {}).filter(([, enabled]) => enabled).map(([name]) => name) },
            ])),
        });
    }),
    createTool('get_agent_stats', '读取最近 Agent 工具调用统计。', {
        type: 'object',
        properties: {},
    }, async () => {
        ensureEnabled();
        return okJson(stats.getStats());
    }),
    createTool('list_agent_sessions', '列出 Dashboard/QQ Agent 会话摘要。', {
        type: 'object',
        properties: {},
    }, async () => {
        ensureEnabled();
        return okJson({ sessions: sessions.listAgentSessions() });
    }),
    createTool('get_agent_session', '按 session id 查看 Agent 会话详情。', {
        type: 'object',
        properties: { id: { type: 'string', description: 'Agent session id' } },
        required: ['id'],
    }, async (args = {}) => {
        ensureEnabled();
        const session = sessions.getAgentSession(getStringArg(args, 'id'));
        if (!session)
            throw new Error('未找到 Agent session');
        return okJson(session);
    }),
    createTool('query_logs', queryLogsTool.definition.description, queryLogsTool.definition.parameters, async (args = {}) => {
        ensureEnabled();
        return okText(await queryLogsTool.execute(args));
    }),
    createTool('list_files', listFilesTool.definition.description, listFilesTool.definition.parameters, async (args = {}) => {
        ensureEnabled();
        return okText(await listFilesTool.execute(args));
    }),
    createTool('find_files', findFilesTool.definition.description, findFilesTool.definition.parameters, async (args = {}) => {
        ensureEnabled();
        return okText(await findFilesTool.execute(args));
    }),
    createTool('grep_search', grepSearchTool.definition.description, grepSearchTool.definition.parameters, async (args = {}) => {
        ensureEnabled();
        return okText(await grepSearchTool.execute(args));
    }),
    createTool('read_file', readFileTool.definition.description, readFileTool.definition.parameters, async (args = {}) => {
        ensureEnabled();
        return okText(await readFileTool.execute(args));
    }),
    createTool('diagnose_recent_files', '查看 QQ 会话最近文件锚点，确认文件是否入库、是否已分析、是否有本地副本。不会读取文件正文。', {
        type: 'object',
        properties: {
            channelKey: { type: 'string', description: '频道 key；私聊形如 private:<userId>。也可传 userId 自动推断私聊。' },
            userId: { type: 'string', description: '私聊用户 ID，未传 channelKey 时用于 private:<userId>。' },
            groupId: { type: 'string', description: '群号，未传 channelKey 时作为群 channelKey。' },
            limit: { type: 'number', description: '最多返回多少条，默认 5。' },
        },
        required: [],
    }, async (args = {}) => {
        ensureEnabled();
        const channelKey = normalizeMcpChannelKey(args);
        if (!channelKey)
            throw new Error('需要 channelKey、groupId 或 userId');
        const limit = Math.max(1, Math.min(getNumberArg(args, 'limit', 5), 20));
        const files = await getRecentFiles(channelKey, limit);
        return okJson({
            channelKey,
            count: files.length,
            files: files.map(file => ({
                messageId: String(file.messageId || ''),
                fileName: file.fileName || '',
                ext: file.ext || '',
                fileSize: Number(file.fileSize || 0),
                fileId: file.fileId || null,
                userId: file.userId || '',
                ts: file.ts || 0,
                skipped: !!file.skipped,
                skipReason: file.skipReason || null,
                analyzed: !!file.analyzed,
                hasAnalysis: !!file.analysis,
                hasLocalPath: !!file.localPath,
            })),
        });
    }),
    createTool('diagnose_analyze_file', '只读诊断 QQ chat 的文件分析状态：返回目标文件已有的分析结果与是否需要真实分析。不触发下载/解析/回写 file-history。', {
        type: 'object',
        properties: {
            channelKey: { type: 'string', description: '频道 key；私聊形如 private:<userId>。也可传 userId 自动推断私聊。' },
            userId: { type: 'string', description: '私聊用户 ID，未传 channelKey 时用于 private:<userId>。' },
            groupId: { type: 'string', description: '群号，未传 channelKey 时作为群 channelKey。' },
            messageId: { type: 'string', description: '可选文件消息 ID；不传则使用最近文件。' },
            keyword: { type: 'string', description: '可选文件名关键词，用于在最近文件中匹配目标。' },
        },
        required: [],
    }, async (args = {}) => {
        ensureEnabled();
        const channelKey = normalizeMcpChannelKey(args);
        if (!channelKey)
            throw new Error('需要 channelKey、groupId 或 userId');
        const messageId = getStringArg(args, 'messageId');
        const keyword = getStringArg(args, 'keyword');
        // 只读：先按 messageId 取，否则在最近文件里按关键词/最近一条挑，绝不触发真实文件分析（下载/解析/回写 file-history）
        let entry = messageId ? await getFileEntry(channelKey, messageId) : null;
        if (!entry) {
            const recent = await getRecentFiles(channelKey, 15);
            const matched = keyword
                ? recent.find(f => String(f.fileName || '').toLowerCase().includes(keyword.toLowerCase()))
                : recent[recent.length - 1];
            entry = matched ? await getFileEntry(channelKey, String(matched.messageId || '')) : null;
        }
        const diag = toDiagnosticFile(entry);
        const wouldCallAnalyze = !!diag && !diag.analyzed && !diag.skipped;
        return okJson({
            channelKey,
            messageId: messageId || (diag ? String(entry?.fileId || '') : ''),
            readOnly: true,
            wouldCallAnalyze,
            entry: diag ? {
                fileName: diag.fileName || '',
                ext: entry?.ext || '',
                skipped: !!diag.skipped,
                analyzed: !!diag.analyzed,
                hasAnalysis: !!diag.analysis,
                hasLocalPath: !!diag.localPath,
                analysisPreview: diag.analysis ? String(diag.analysis).slice(0, 4000) : '',
            } : null,
        });
    }),
    createTool('simulate_file_followup', '只读诊断 QQ chat 的文件追问守卫：给定追问文本，返回会选中的 active file 与是否已有证据。不触发分析或回写。', {
        type: 'object',
        properties: {
            channelKey: { type: 'string', description: '频道 key；私聊形如 private:<userId>。也可传 userId 自动推断私聊。' },
            userId: { type: 'string', description: '私聊用户 ID，未传 channelKey 时用于 private:<userId>。' },
            groupId: { type: 'string', description: '群号，未传 channelKey 时作为群 channelKey。' },
            text: { type: 'string', description: '用户追问，例如 文件说了什么。' },
        },
        required: ['text'],
    }, async (args = {}) => {
        ensureEnabled();
        const channelKey = normalizeMcpChannelKey(args);
        if (!channelKey)
            throw new Error('需要 channelKey、groupId 或 userId');
        const userId = getStringArg(args, 'userId');
        // 只读：buildFileFollowupState 仅读最近文件并选锚点；不走会触发文件分析写入的补证路径
        const state = await buildFileFollowupState(channelKey, String(args.text || ''), { userId });
        const targetFile = toDiagnosticFile(state.targetFile);
        const hasExistingEvidence = !!targetFile && (!!targetFile.analysis || !!targetFile.analyzed);
        return okJson({
            channelKey,
            readOnly: true,
            shouldVerify: !!state.shouldVerify,
            hasExistingEvidence,
            wouldCallAnalyze: !!targetFile && !targetFile.analyzed && !targetFile.skipped,
            targetFile: targetFile ? {
                messageId: targetFile.messageId,
                fileName: targetFile.fileName,
                analyzed: !!targetFile.analyzed,
                skipped: !!targetFile.skipped,
                hasAnalysis: !!targetFile.analysis,
                hasLocalPath: !!targetFile.localPath,
            } : null,
        });
    }),
    createTool('write_file', writeFileTool.definition.description, writeFileTool.definition.parameters, async (args = {}) => {
        ensureWriteAllowed();
        return okText(await writeFileTool.execute(args));
    }, { write: true }),
    createTool('edit_file', editFileTool.definition.description, editFileTool.definition.parameters, async (args = {}) => {
        ensureWriteAllowed();
        return okText(await editFileTool.execute(args));
    }, { write: true }),
    createTool('run_local_check', '运行受控本地检查命令。允许 check、quick、scenario、test 或 node -c <file>。', {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'check、quick、scenario、test 或 node -c <file>' },
        },
        required: ['command'],
    }, async (args = {}) => {
        ensureRunAllowed();
        const [commandName, commandArgs] = parseLocalCheckCommand(args.command);
        const result = await runCommand(commandName, commandArgs);
        const text = [
            `$ ${commandName} ${commandArgs.join(' ')}`,
            `exitCode: ${result.exitCode === null ? 'null' : result.exitCode}`,
            result.timedOut ? 'timedOut: true' : '',
            result.error ? `error: ${result.error}` : '',
            result.stdout ? `stdout:\n${result.stdout}` : '',
            result.stderr ? `stderr:\n${result.stderr}` : '',
        ].filter(Boolean).join('\n');
        return result.ok ? okText(text) : { isError: true, content: textContent(text) };
    }, { run: true }),
];
const toolsByName = new Map(TOOLS.map(tool => [tool.name, tool]));
function readJsonRpcMessages(onMessage) {
    let buffer = Buffer.alloc(0);
    process.stdin.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length) {
            const headerEnd = buffer.indexOf('\r\n\r\n');
            if (headerEnd === -1)
                break;
            const header = buffer.slice(0, headerEnd).toString('utf8');
            const match = header.match(/content-length:\s*(\d+)/i);
            if (!match) {
                buffer = buffer.slice(headerEnd + 4);
                continue;
            }
            const length = Number(match[1]);
            const bodyStart = headerEnd + 4;
            if (buffer.length < bodyStart + length)
                break;
            const body = buffer.slice(bodyStart, bodyStart + length).toString('utf8');
            buffer = buffer.slice(bodyStart + length);
            try {
                onMessage(JSON.parse(body));
            }
            catch {
                /* non-critical: malformed JSON-RPC frame is ignored until next frame */
            }
        }
    });
}
function writeJsonRpc(message) {
    const body = JSON.stringify(message);
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}
function sendResult(id, result) {
    if (id === undefined || id === null)
        return;
    writeJsonRpc({ jsonrpc: '2.0', id, result });
}
function sendError(id, code, message) {
    if (id === undefined || id === null)
        return;
    writeJsonRpc({ jsonrpc: '2.0', id, error: { code, message } });
}
async function handleRequest(message) {
    const { id, method, params } = message || {};
    try {
        if (method === 'initialize') {
            return sendResult(id, {
                protocolVersion: params?.protocolVersion || '2025-06-18',
                capabilities: { tools: {} },
                serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            });
        }
        if (method === 'ping') {
            return sendResult(id, {});
        }
        if (method === 'tools/list') {
            return sendResult(id, { tools: getMcpToolDefinitions() });
        }
        if (method === 'tools/call') {
            const name = String(params?.name || '');
            const tool = toolsByName.get(name);
            if (!tool)
                return sendError(id, -32602, '未知工具：' + name);
            try {
                return sendResult(id, await tool.handler(params?.arguments || {}));
            }
            catch (error) {
                return sendResult(id, errorResult(getMcpErrorMessage(error)));
            }
        }
        if (id !== undefined && id !== null)
            return sendError(id, -32601, '未知方法：' + method);
    }
    catch (error) {
        sendError(id, -32000, getMcpErrorMessage(error));
    }
}
function start() {
    readJsonRpcMessages(message => {
        if (!message || !message.method)
            return;
        handleRequest(message).catch(error => {
            sendError(message.id, -32000, getMcpErrorMessage(error));
        });
    });
}
if (require.main === module)
    start();
module.exports = {
    SERVER_NAME,
    SERVER_VERSION,
    getToolDefinitions: getMcpToolDefinitions,
    parseLocalCheckCommand,
    buildHealth,
};
