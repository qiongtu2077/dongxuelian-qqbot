"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GROUP_ID_PATTERN = exports.PARTICIPATION_POLICY_FILE = void 0;
exports.validateParticipationPolicy = validateParticipationPolicy;
exports.readParticipationPolicy = readParticipationPolicy;
exports.isGroupParticipationEnabled = isGroupParticipationEnabled;
exports.isSessionParticipationEnabled = isSessionParticipationEnabled;
exports.isOneBotActionAllowed = isOneBotActionAllowed;
/**
 * MODULE: 群聊与私聊参与策略。
 * 职责: 读取持久总开关，统一判断 QQ 会话和 OneBot 操作是否允许。
 * 边界: 不发送消息、不调用模型、不修改功能配置；缺失配置默认全部关闭。
 * 状态: 按文件指纹缓存经过校验的配置，外部原子更新在下一次检查生效。
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./constants');
exports.PARTICIPATION_POLICY_FILE = path.join(DATA_DIR, 'bot-participation.json');
exports.GROUP_ID_PATTERN = /^[1-9]\d{0,19}$/;
let cachedFingerprint = '';
let cachedPolicy = { version: 1, privateEnabled: false, groups: {} };
// --- 配置读取与校验 ---
// 校验本项目定义的配置格式，拒绝损坏数据和非布尔开关。
function validateParticipationPolicy(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('参与开关配置必须是对象');
    const policy = value;
    if (policy.version !== 1 || typeof policy.privateEnabled !== 'boolean' || !policy.groups || typeof policy.groups !== 'object' || Array.isArray(policy.groups)) {
        throw new Error('参与开关配置格式无效');
    }
    const groups = {};
    for (const [id, enabled] of Object.entries(policy.groups)) {
        if (!exports.GROUP_ID_PATTERN.test(id) || typeof enabled !== 'boolean')
            throw new Error('群号或群总开关无效');
        groups[id] = enabled;
    }
    return { version: 1, privateEnabled: policy.privateEnabled, groups };
}
// 返回独立配置副本；没有配置时默认关闭群聊和私聊。
function readParticipationPolicy() {
    let stat;
    try {
        stat = fs.statSync(exports.PARTICIPATION_POLICY_FILE);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        cachedFingerprint = '';
        return { version: 1, privateEnabled: false, groups: {} };
    }
    if (!stat.isFile() || stat.size > 256 * 1024)
        throw new Error('参与开关配置文件无效或过大');
    const fingerprint = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
    if (fingerprint !== cachedFingerprint) {
        cachedPolicy = validateParticipationPolicy(JSON.parse(fs.readFileSync(exports.PARTICIPATION_POLICY_FILE, 'utf8')));
        cachedFingerprint = fingerprint;
    }
    return { version: 1, privateEnabled: cachedPolicy.privateEnabled, groups: { ...cachedPolicy.groups } };
}
// --- 会话与发送判定 ---
// 只有明确开启的群可以参与；不依赖主动回复白名单。
function isGroupParticipationEnabled(groupId) {
    return readParticipationPolicy().groups[String(groupId)] === true;
}
// 临时私聊即使带有来源群号，也必须先受全局私聊开关控制。
function isSessionParticipationEnabled(session) {
    const policy = readParticipationPolicy();
    // Satori 的 isDirect getter 直接读取 event.channel.type，生命周期事件没有 channel。
    const canReadIsDirect = !session.event || Boolean(session.event.channel);
    if ((canReadIsDirect && session.isDirect) || session.subtype === 'private' || String(session.channelId || '').startsWith('private:'))
        return policy.privateEnabled;
    if (session.guildId)
        return policy.groups[String(session.guildId)] === true;
    return true;
}
// 在真实传输前检查目标，覆盖排队完成后的消息、文件和戳一戳。
function isOneBotActionAllowed(action, params) {
    const policy = readParticipationPolicy();
    // OneBot Internal 的 Async 方法会在相同操作名后追加 _async。
    const operation = action.endsWith('_async') ? action.slice(0, -6) : action;
    const privateAction = operation.startsWith('send_private_') || operation === 'friend_poke' || operation === 'send_like' || operation === 'upload_private_file' || (operation === 'send_msg' && (params.message_type === 'private' || !params.group_id));
    if (privateAction)
        return policy.privateEnabled;
    // 适配器在分发前需要读取群成员资料；只读查询不会产生群活动。
    if (action.startsWith('get_') || action.startsWith('_get_'))
        return true;
    if (params.group_id != null && String(params.group_id))
        return policy.groups[String(params.group_id)] === true;
    return true;
}
