"use strict";
/**
 * MODULE: pet-bridge protocol handlers.
 * 职责: Dispatch and handle all pet bridge WebSocket message types (query/command/chat).
 * 边界: Reads AI state only through the AI public pet-bridge runtime adapter.
 *        Does NOT modify core plugin logic, handle Koishi sessions, or send messages on its own.
 */
const { getPetBridgeStatus, listPetBridgePersonas, getPetBridgeMemorySummary, listPetBridgeSummaryGroups, switchPetBridgeModel, setPetBridgeSearchEnabled, setPetBridgeThinkingEnabled, setPetBridgeMaintenanceEnabled, sendPetBridgeGroupMessage, managePetBridgeRandomWhitelist, switchPetBridgePersona, getCurrentPetBridgePersona, generatePetBridgeChatReply, } = require('koishi-plugin-dongxuelian-ai/lib/public/pet-bridge-runtime');
function asPayload(value) {
    return value && typeof value === 'object' ? value : {};
}
// 资源忙时返回协议层可识别的低成本错误，不触发模型调用。
function buildPetBridgeBusyResponse(reason) {
    return { success: false, payload: { error: 'RESOURCE_BUSY', reason } };
}
function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
async function handleStatus() {
    return { success: true, payload: await getPetBridgeStatus() };
}
function handlePersonas() {
    return { success: true, payload: { personas: listPetBridgePersonas() } };
}
async function handleMemory(payload) {
    const { userId, channelKey } = payload;
    if (!userId)
        return { success: false, payload: { error: 'missing userId' } };
    const summary = await getPetBridgeMemorySummary(userId, channelKey || 'default');
    return { success: true, payload: { summary } };
}
function handleSummaries() {
    return { success: true, payload: { groups: listPetBridgeSummaryGroups() } };
}
async function handleSwitchModel(payload) {
    const { provider, model } = payload;
    return { success: true, payload: await switchPetBridgeModel(provider, model) };
}
function handleToggleSearch(payload) {
    const enabled = !!payload.enabled;
    return { success: true, payload: setPetBridgeSearchEnabled(enabled) };
}
function handleToggleThinking(payload) {
    const enabled = !!payload.enabled;
    return { success: true, payload: setPetBridgeThinkingEnabled(enabled) };
}
function handleToggleMaintenance(payload) {
    return { success: true, payload: setPetBridgeMaintenanceEnabled(!!payload.enabled) };
}
async function handleSendGroupMsg(payload) {
    const { groupId, text } = payload;
    if (!groupId || !text)
        return { success: false, payload: { error: 'missing groupId or text' } };
    if (!/^\d+$/.test(String(groupId)))
        return { success: false, payload: { error: 'groupId must be numeric' } };
    const result = await sendPetBridgeGroupMessage(groupId, text);
    return { success: !!result, payload: result || { error: 'send failed' } };
}
function handleManageWhitelist(payload) {
    const op = payload.whitelistAction || payload.action;
    const result = managePetBridgeRandomWhitelist(op || '', payload.groupId);
    if (!result.ok)
        return { success: false, payload: { error: result.error || 'invalid action; use add/remove/list' } };
    return { success: true, payload: { whitelist: result.whitelist || [] } };
}
function handleSwitchPersona(payload) {
    const { name } = payload;
    const result = switchPetBridgePersona(name || '');
    if (!result.ok)
        return { success: false, payload: { error: result.error || 'persona not found' } };
    return { success: true, payload: { persona: name } };
}
function handleGetCurrentPersona() {
    return { success: true, payload: { persona: getCurrentPetBridgePersona() } };
}
async function handleChat(payload) {
    const { text, persona } = payload;
    if (!text)
        return { success: false, payload: { error: 'missing text' } };
    const result = await generatePetBridgeChatReply({ text, persona, userId: payload.userId, channelKey: payload.channelKey });
    if (!result.ok) {
        if (result.error === 'RESOURCE_BUSY')
            return buildPetBridgeBusyResponse(result.reason || 'pet bridge chat resource busy');
        return { success: false, payload: { error: result.error || 'chat failed' } };
    }
    return { success: true, payload: { reply: result.reply } };
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
