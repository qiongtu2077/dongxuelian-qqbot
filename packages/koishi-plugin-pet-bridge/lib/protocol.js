"use strict";
/**
 * MODULE: pet-bridge protocol handlers.
 * 职责: Dispatch and handle all pet bridge WebSocket message types (query/command/chat).
 * 边界: Reads config through runtime-config; calls AI through api.js.
 *        Does NOT modify core plugin logic, handle Koishi sessions, or send messages on its own.
 */
const { loadConfig, resetConfigCache, getThinkingEnabled, setThinkingEnabled } = require('koishi-plugin-dongxuelian-ai/lib/core/runtime-config');
const { requestChatCompletions } = require('koishi-plugin-dongxuelian-ai/lib/core/api');
const { admitTask } = require('koishi-plugin-dongxuelian-ai/lib/resource-scheduler/admission');
const { acquireResourceGate } = require('koishi-plugin-dongxuelian-ai/lib/resource-gate/gate');
const { getAvailablePersonals, loadPersonalSkill, setUserPersona, getUserPersona } = require('koishi-plugin-dongxuelian-ai/lib/persona/persona');
const { getMemorySummary } = require('koishi-plugin-dongxuelian-ai/lib/conversation');
const { resolveOneBotWsUrl } = require('koishi-plugin-dongxuelian-ai/lib/core/onebot-endpoint');
const { PROVIDER_FILE, MODEL_FILE, SEARCH_ENABLED_FILE, MAINTENANCE_FILE, THINKING_MODE_FILE, SUMMARY_WHITELIST_FILE, RANDOM_WHITELIST_FILE } = require('koishi-plugin-dongxuelian-ai/lib/core/constants');
const fs = require('fs');
const PET_BRIDGE_CHAT_KIND = 'pet_bridge_chat';
function asPayload(value) {
    return value && typeof value === 'object' ? value : {};
}
function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
// 生成桌宠桥接聊天的资源任务 ID，供 S0/S1 事件追踪。
function buildPetBridgeChatTaskId(payload) {
    const userId = String(payload.userId || 'desktop-user').replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 80) || 'desktop-user';
    return `${PET_BRIDGE_CHAT_KIND}-${userId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
// 资源忙时返回协议层可识别的低成本错误，不触发模型调用。
function buildPetBridgeBusyResponse(reason) {
    return { success: false, payload: { error: 'RESOURCE_BUSY', reason } };
}
// 为桌宠桥接聊天申请 S1 准入和 S0 独占锁。
async function acquirePetBridgeChatGate(payload) {
    const taskId = buildPetBridgeChatTaskId(payload);
    const channelKey = String(payload.channelKey || 'pet-bridge');
    const userId = String(payload.userId || 'desktop-user');
    const admission = admitTask({
        taskId,
        kind: PET_BRIDGE_CHAT_KIND,
        source: 'pet-bridge',
        channelKey,
        userId,
        exclusive: true,
        priority: 70,
        deferable: false,
        queueTimeoutMs: 5000,
        runTimeoutMs: 120000,
    });
    if (admission.decision !== 'run_now') {
        return { ok: false, response: buildPetBridgeBusyResponse(admission.reason || 'pet bridge chat rejected by resource scheduler') };
    }
    try {
        const handle = await acquireResourceGate({
            taskId,
            kind: PET_BRIDGE_CHAT_KIND,
            owner: 'pet-bridge',
            channelKey,
            userId,
            priority: 70,
            timeoutMs: 120000,
            waitTimeoutMs: 5000,
            pollMs: 500,
            memAvailableMb: admission.memAvailableMb,
            step: 'pet_bridge_prepare',
        });
        return { ok: true, handle };
    }
    catch (error) {
        return { ok: false, response: buildPetBridgeBusyResponse(getErrorMessage(error)) };
    }
}
function readJsonFileSync(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    catch {
        return fallback;
    }
}
function readStringListSync(filePath) {
    const value = readJsonFileSync(filePath, []);
    return Array.isArray(value) ? value.map(item => String(item)).filter(Boolean) : [];
}
function writeJsonFileSync(filePath, data) {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
}
function writeTextFileSync(filePath, content) {
    fs.writeFileSync(filePath, content, 'utf8');
}
function callOneBot(action, params) {
    return new Promise((resolve) => {
        let ws = null;
        let timer = null;
        let settled = false;
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            try {
                if (ws)
                    ws.close();
            }
            catch { /* non-critical: best-effort OneBot WS cleanup */
            }
            resolve(value);
        };
        try {
            ws = new (require('ws'))(resolveOneBotWsUrl());
            timer = setTimeout(() => finish(null), 5000);
            ws.on('open', () => {
                try {
                    ws?.send(JSON.stringify({ action, params, echo: 'pet-bridge' }));
                }
                catch {
                    finish(null);
                }
            });
            ws.on('message', (d) => {
                let msg = null;
                try {
                    msg = JSON.parse(d.toString());
                }
                catch {
                    return finish(null);
                }
                if (msg.status === 'ok')
                    finish(msg);
                else
                    finish(null);
            });
            ws.on('error', (e) => { console.error('[pet-bridge] callOneBot WS error:', e.message); finish(null); });
            ws.on('close', () => finish(null));
        }
        catch (e) {
            console.error('[pet-bridge] callOneBot connect error:', getErrorMessage(e));
            finish(null);
        }
    });
}
async function handleStatus() {
    const config = await loadConfig();
    return {
        success: true,
        payload: {
            provider: config.provider,
            model: config.model,
            baseURL: config.baseURL,
            online: true,
            searchEnabled: config.searchEnabled,
            thinkingEnabled: getThinkingEnabled(),
        },
    };
}
function handlePersonas() {
    const personas = getAvailablePersonals();
    return { success: true, payload: { personas } };
}
async function handleMemory(payload) {
    const { userId, channelKey } = payload;
    if (!userId)
        return { success: false, payload: { error: 'missing userId' } };
    const summary = await getMemorySummary(userId, channelKey || 'default');
    return { success: true, payload: { summary } };
}
function handleSummaries() {
    return { success: true, payload: { groups: readStringListSync(SUMMARY_WHITELIST_FILE) } };
}
async function handleSwitchModel(payload) {
    const { provider, model } = payload;
    if (provider)
        writeTextFileSync(PROVIDER_FILE, provider);
    if (model)
        writeTextFileSync(MODEL_FILE, model);
    resetConfigCache();
    const config = await loadConfig(true);
    return { success: true, payload: { provider: config.provider, model: config.model } };
}
function handleToggleSearch(payload) {
    const enabled = !!payload.enabled;
    writeTextFileSync(SEARCH_ENABLED_FILE, enabled ? '1' : '0');
    resetConfigCache();
    return { success: true, payload: { searchEnabled: enabled } };
}
function handleToggleThinking(payload) {
    const enabled = !!payload.enabled;
    setThinkingEnabled(enabled);
    writeTextFileSync(THINKING_MODE_FILE, enabled ? 'on' : 'off');
    return { success: true, payload: { thinkingEnabled: enabled } };
}
function handleToggleMaintenance(payload) {
    const enabled = !!payload.enabled;
    if (enabled) {
        writeTextFileSync(MAINTENANCE_FILE, '优化中，别急~');
    }
    else {
        try {
            fs.unlinkSync(MAINTENANCE_FILE);
        }
        catch { /* non-critical: maintenance file may already be absent */
        }
    }
    return { success: true, payload: { maintenanceEnabled: enabled } };
}
async function handleSendGroupMsg(payload) {
    const { groupId, text } = payload;
    if (!groupId || !text)
        return { success: false, payload: { error: 'missing groupId or text' } };
    if (!/^\d+$/.test(String(groupId)))
        return { success: false, payload: { error: 'groupId must be numeric' } };
    const result = await callOneBot('send_group_msg', { group_id: Number(groupId), message: text });
    return { success: !!result, payload: result || { error: 'send failed' } };
}
function handleManageWhitelist(payload) {
    const op = payload.whitelistAction || payload.action;
    const groupId = payload.groupId;
    let list = readStringListSync(RANDOM_WHITELIST_FILE);
    if (op === 'add') {
        const gid = String(groupId || '');
        if (!gid)
            return { success: false, payload: { error: 'missing groupId' } };
        if (!list.includes(gid))
            list.push(gid);
        writeJsonFileSync(RANDOM_WHITELIST_FILE, list);
        return { success: true, payload: { whitelist: list } };
    }
    if (op === 'remove') {
        const gid = String(groupId || '');
        if (!gid)
            return { success: false, payload: { error: 'missing groupId' } };
        list = list.filter(id => id !== gid);
        writeJsonFileSync(RANDOM_WHITELIST_FILE, list);
        return { success: true, payload: { whitelist: list } };
    }
    if (op === 'list') {
        return { success: true, payload: { whitelist: list } };
    }
    return { success: false, payload: { error: 'invalid action; use add/remove/list' } };
}
function handleSwitchPersona(payload) {
    const { name } = payload;
    if (!name)
        return { success: false, payload: { error: 'missing persona name' } };
    const skill = loadPersonalSkill(name);
    if (!skill)
        return { success: false, payload: { error: 'persona not found' } };
    setUserPersona('desktop-user', name);
    return { success: true, payload: { persona: name } };
}
function handleGetCurrentPersona() {
    const current = getUserPersona('desktop-user') || 'default';
    return { success: true, payload: { persona: current } };
}
async function handleChat(payload) {
    const { text, persona } = payload;
    if (!text)
        return { success: false, payload: { error: 'missing text' } };
    // 维护模式检查：与 bot index.js 逻辑一致
    if (require('fs').existsSync(MAINTENANCE_FILE)) {
        const mt = require('fs').readFileSync(MAINTENANCE_FILE, 'utf8').trim() || '优化中，别急~';
        return { success: true, payload: { reply: mt } };
    }
    const gateResult = await acquirePetBridgeChatGate(payload);
    if (!gateResult.ok)
        return gateResult.response || buildPetBridgeBusyResponse('pet bridge chat resource busy');
    const gateHandle = gateResult.handle;
    try {
        gateHandle?.updateStep('pet_bridge_config');
        const config = await loadConfig();
        const messages = [];
        const personaName = persona || getUserPersona('desktop-user') || null;
        if (personaName && personaName !== 'default') {
            const skillContent = loadPersonalSkill(personaName);
            if (skillContent) {
                const body = skillContent.replace(/^---[\s\S]*?---\n?/, '').trim();
                if (body)
                    messages.push({ role: 'system', content: body });
            }
        }
        if (!messages.length) {
            messages.push({ role: 'system', content: '你是一个AI助手。请用简洁、自然的中文回答。' });
        }
        messages.push({ role: 'user', content: text });
        const extraBody = {};
        if (config.searchEnabled)
            extraBody.enable_search = true;
        if (getThinkingEnabled())
            extraBody.enable_thinking = true;
        gateHandle?.updateStep('pet_bridge_model');
        const reply = await requestChatCompletions(messages, config, extraBody);
        return { success: true, payload: { reply } };
    }
    catch (err) {
        return { success: false, payload: { error: getErrorMessage(err) } };
    }
    finally {
        try {
            gateHandle?.release('pet-bridge-chat-finally');
        }
        catch { /* non-critical: stale lock recovery handles release failures */
        }
    }
}
async function handleMessage(input) {
    const msg = input && typeof input === 'object' ? input : {};
    const { id, type } = msg;
    const payload = asPayload(msg.payload);
    let result = null;
    try {
        if (type === 'query') {
            const qt = payload && payload.type;
            if (qt === 'status')
                result = await handleStatus();
            else if (qt === 'personas')
                result = handlePersonas();
            else if (qt === 'memory')
                result = await handleMemory(payload);
            else if (qt === 'summaries')
                result = handleSummaries();
            else if (qt === 'current_persona')
                result = handleGetCurrentPersona();
            else
                result = { success: false, payload: { error: 'unknown query type: ' + qt } };
        }
        else if (type === 'command') {
            const action = payload && payload.action;
            if (action === 'switch_model')
                result = await handleSwitchModel(payload);
            else if (action === 'toggle_search')
                result = handleToggleSearch(payload);
            else if (action === 'toggle_thinking')
                result = handleToggleThinking(payload);
            else if (action === 'toggle_maintenance')
                result = handleToggleMaintenance(payload);
            else if (action === 'send_group_msg')
                result = await handleSendGroupMsg(payload);
            else if (action === 'manage_whitelist')
                result = handleManageWhitelist(payload);
            else if (action === 'switch_persona')
                result = handleSwitchPersona(payload);
            else
                result = { success: false, payload: { error: 'unknown command: ' + action } };
        }
        else if (type === 'chat') {
            result = await handleChat(payload);
        }
        else {
            result = { success: false, payload: { error: 'unknown message type: ' + type } };
        }
    }
    catch (err) {
        result = { success: false, payload: { error: getErrorMessage(err) } };
    }
    return { type: 'response', id: id != null ? id : null, ...result };
}
module.exports = { handleMessage };
