"use strict";
/**
 * MODULE: pet-bridge public runtime adapter.
 * 职责: 为桌宠桥接插件提供稳定的 AI 插件领域操作边界。
 * 边界: 不处理 pet-bridge WebSocket 协议，不反向依赖 pet-bridge。
 */
const { loadConfig, resetConfigCache, getThinkingEnabled, setThinkingEnabled, } = require('../core/runtime-config');
const { requestChatCompletions } = require('../core/api');
const { admitTask } = require('../resource-scheduler/admission');
const { acquireResourceGate } = require('../resource-gate/gate');
const { RESOURCE_TASK_KIND } = require('../resource-common/resource-task-kinds');
const { getAvailablePersonals, loadPersonalSkill, setUserPersona, getUserPersona, } = require('../persona/persona');
const { getMemorySummary } = require('../conversation');
const { resolveOneBotWsUrl } = require('../core/onebot-endpoint');
const { PROVIDER_FILE, MODEL_FILE, SEARCH_ENABLED_FILE, MAINTENANCE_FILE, THINKING_MODE_FILE, SUMMARY_WHITELIST_FILE, RANDOM_WHITELIST_FILE, } = require('../core/constants');
const fs = require('fs');
const PET_BRIDGE_CHAT_KIND = RESOURCE_TASK_KIND.PET_BRIDGE_CHAT;
function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function readJsonFileSync(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    catch { /* non-critical: pet bridge treats missing or malformed optional JSON as empty config */
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
                catch { /* non-critical: caller handles OneBot send failure as unavailable */
                    finish(null);
                }
            });
            ws.on('message', (d) => {
                let msg = null;
                try {
                    msg = JSON.parse(d.toString());
                }
                catch { /* non-critical: malformed OneBot frame is treated as no response */
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
function buildPetBridgeChatTaskId(input) {
    const userId = String(input.userId || 'desktop-user').replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 80) || 'desktop-user';
    return `${PET_BRIDGE_CHAT_KIND}-${userId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
async function acquirePetBridgeChatGate(input) {
    const taskId = buildPetBridgeChatTaskId(input);
    const channelKey = String(input.channelKey || 'pet-bridge');
    const userId = String(input.userId || 'desktop-user');
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
        return { ok: false, reason: admission.reason || 'pet bridge chat rejected by resource scheduler' };
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
        return { ok: false, reason: getErrorMessage(error) };
    }
}
async function getPetBridgeStatus() {
    const config = await loadConfig();
    return {
        provider: config.provider,
        model: config.model,
        baseURL: config.baseURL,
        online: true,
        searchEnabled: config.searchEnabled,
        thinkingEnabled: getThinkingEnabled(),
    };
}
function listPetBridgePersonas() {
    return getAvailablePersonals();
}
async function getPetBridgeMemorySummary(userId, channelKey = 'default') {
    return getMemorySummary(userId, channelKey);
}
function listPetBridgeSummaryGroups() {
    return readStringListSync(SUMMARY_WHITELIST_FILE);
}
async function switchPetBridgeModel(provider, model) {
    if (provider)
        writeTextFileSync(PROVIDER_FILE, provider);
    if (model)
        writeTextFileSync(MODEL_FILE, model);
    resetConfigCache();
    const config = await loadConfig(true);
    return { provider: config.provider, model: config.model };
}
function setPetBridgeSearchEnabled(enabled) {
    writeTextFileSync(SEARCH_ENABLED_FILE, enabled ? '1' : '0');
    resetConfigCache();
    return { searchEnabled: enabled };
}
function setPetBridgeThinkingEnabled(enabled) {
    setThinkingEnabled(enabled);
    writeTextFileSync(THINKING_MODE_FILE, enabled ? 'on' : 'off');
    return { thinkingEnabled: enabled };
}
function setPetBridgeMaintenanceEnabled(enabled) {
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
    return { maintenanceEnabled: enabled };
}
function getPetBridgeMaintenanceMessage() {
    try {
        if (!fs.existsSync(MAINTENANCE_FILE))
            return null;
        return fs.readFileSync(MAINTENANCE_FILE, 'utf8').trim() || '优化中，别急~';
    }
    catch { /* non-critical: maintenance status falls back to disabled if the flag cannot be read */
        return null;
    }
}
async function sendPetBridgeGroupMessage(groupId, text) {
    return callOneBot('send_group_msg', { group_id: Number(groupId), message: text });
}
function managePetBridgeRandomWhitelist(action = '', groupId) {
    let list = readStringListSync(RANDOM_WHITELIST_FILE);
    if (action === 'add') {
        const gid = String(groupId || '');
        if (!gid)
            return { ok: false, error: 'missing groupId' };
        if (!list.includes(gid))
            list.push(gid);
        writeJsonFileSync(RANDOM_WHITELIST_FILE, list);
        return { ok: true, whitelist: list };
    }
    if (action === 'remove') {
        const gid = String(groupId || '');
        if (!gid)
            return { ok: false, error: 'missing groupId' };
        list = list.filter(id => id !== gid);
        writeJsonFileSync(RANDOM_WHITELIST_FILE, list);
        return { ok: true, whitelist: list };
    }
    if (action === 'list') {
        return { ok: true, whitelist: list };
    }
    return { ok: false, error: 'invalid action; use add/remove/list' };
}
function switchPetBridgePersona(name) {
    if (!name)
        return { ok: false, error: 'missing persona name' };
    const skill = loadPersonalSkill(name);
    if (!skill)
        return { ok: false, error: 'persona not found' };
    setUserPersona('desktop-user', name);
    return { ok: true };
}
function getCurrentPetBridgePersona() {
    return getUserPersona('desktop-user') || 'default';
}
async function generatePetBridgeChatReply(input) {
    const maintenanceMessage = getPetBridgeMaintenanceMessage();
    if (maintenanceMessage)
        return { ok: true, reply: maintenanceMessage };
    const gateResult = await acquirePetBridgeChatGate(input);
    if (!gateResult.ok)
        return { ok: false, error: 'RESOURCE_BUSY', reason: gateResult.reason || 'pet bridge chat resource busy' };
    const gateHandle = gateResult.handle;
    try {
        gateHandle?.updateStep('pet_bridge_config');
        const config = await loadConfig();
        const messages = [];
        const personaName = input.persona || getUserPersona('desktop-user') || null;
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
        messages.push({ role: 'user', content: input.text });
        const extraBody = {};
        if (config.searchEnabled)
            extraBody.enable_search = true;
        if (getThinkingEnabled())
            extraBody.enable_thinking = true;
        gateHandle?.updateStep('pet_bridge_model');
        const reply = await requestChatCompletions(messages, config, extraBody);
        return { ok: true, reply };
    }
    catch (error) {
        return { ok: false, error: getErrorMessage(error) };
    }
    finally {
        try {
            gateHandle?.release('pet-bridge-chat-finally');
        }
        catch { /* non-critical: stale lock recovery handles release failures */
        }
    }
}
module.exports = {
    getPetBridgeStatus,
    listPetBridgePersonas,
    getPetBridgeMemorySummary,
    listPetBridgeSummaryGroups,
    switchPetBridgeModel,
    setPetBridgeSearchEnabled,
    setPetBridgeThinkingEnabled,
    setPetBridgeMaintenanceEnabled,
    getPetBridgeMaintenanceMessage,
    sendPetBridgeGroupMessage,
    managePetBridgeRandomWhitelist,
    switchPetBridgePersona,
    getCurrentPetBridgePersona,
    generatePetBridgeChatReply,
};
