'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.routes = void 0;
const fs = require('fs');
const path = require('path');
const { json, collectBody, getErrorMessage } = require('../utils');
const { requireAdmin } = require('../auth');
const { DATA_DIR } = require('../paths');
const { executeConfigTransaction } = require('../config-transaction');
const { readGroupNames } = require('../group-directory');
const { loadManagementModule } = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime');
const policy = loadManagementModule('core.participationPolicy');
const GROUP_NAMES_FILE = 'dashboard-group-names.json';
const MAX_GROUP_NAME_LENGTH = 128;
let groupNameImportQueue = Promise.resolve();
// --- 群名导入与手动备注 ---
// 只读取本地保存的群名；空字符串也表示已经导入，刷新时不再查询 QQ。
function readSavedGroupNames() {
    const value = readFeatureFile(GROUP_NAMES_FILE, {});
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('已保存群名格式无效');
    for (const [id, name] of Object.entries(value)) {
        if (!policy.GROUP_ID_PATTERN.test(id) || typeof name !== 'string' || name.length > MAX_GROUP_NAME_LENGTH)
            throw new Error('已保存群号或群名无效');
    }
    return value;
}
// 在配置事务内保存群名并回读校验，失败时保留原有备注。
function saveGroupNames(groups) {
    executeConfigTransaction({
        dataDir: DATA_DIR,
        targets: [target(GROUP_NAMES_FILE, groups)],
        refresh: () => { readSavedGroupNames(); },
        verify: () => {
            if (JSON.stringify(readSavedGroupNames()) !== JSON.stringify(groups))
                throw new Error('群名写入校验失败');
        },
    });
}
// 串行导入缺失群名，异步读取后重新合并，避免覆盖同时提交的手动名称。
function importGroupNames(ids) {
    const operation = groupNameImportQueue.then(async () => {
        const saved = readSavedGroupNames();
        const missing = ids.filter(id => !Object.prototype.hasOwnProperty.call(saved, id));
        if (!missing.length)
            return { groups: saved };
        let directory = {};
        let message;
        try {
            directory = await readGroupNames();
        }
        catch {
            message = '群名读取失败，已保留群号，请手动填写名称。';
        }
        const groups = readSavedGroupNames();
        const current = policy.readParticipationPolicy();
        for (const id of missing) {
            if (!(id in current.groups || id in current.abusiveGroups))
                continue;
            if (!Object.prototype.hasOwnProperty.call(groups, id))
                groups[id] = (directory[id] || '').slice(0, MAX_GROUP_NAME_LENGTH);
        }
        saveGroupNames(groups);
        return { groups, message };
    });
    groupNameImportQueue = operation.then(() => { }, () => { });
    return operation;
}
// --- 功能默认值与原子保存 ---
// 读取已有功能文件，缺失文件沿用该功能明确的默认数据。
function readFeatureFile(name, fallback) {
    const filePath = path.join(DATA_DIR, name);
    if (!fs.existsSync(filePath))
        return fallback;
    if (fs.statSync(filePath).size > 256 * 1024)
        throw new Error(`${name} 文件过大`);
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}
// 将一个 JSON 配置加入现有跨文件事务，数据仍留在共享 data 目录。
function target(name, value) {
    return { name, filePath: path.join(DATA_DIR, name), content: Buffer.from(JSON.stringify(value, null, 2) + '\n') };
}
// 首次启用只补齐未配置的复读默认值，保留旧群已有的各项功能设置。
function initialGroupTargets(groupId) {
    const repeat = readFeatureFile('ai-repeat-enabled.json', {});
    if (!repeat || typeof repeat !== 'object' || Array.isArray(repeat))
        throw new Error('已有复读配置格式无效');
    // 总开关未记录该群，不代表功能配置不存在；显式关闭的复读也必须保留。
    if (Object.prototype.hasOwnProperty.call(repeat, groupId))
        return [];
    return [target('ai-repeat-enabled.json', { ...repeat, [groupId]: true })];
}
// 保存总开关；首次启用默认配置和总开关一起提交，失败时一起恢复。
function saveParticipationUpdate(body) {
    const next = policy.readParticipationPolicy();
    const targets = [];
    if (body.kind === 'private')
        next.privateEnabled = body.enabled;
    else if (body.kind === 'group-abusive')
        next.abusiveGroups[body.groupId] = body.enabled;
    else {
        const id = body.groupId;
        const configured = Object.prototype.hasOwnProperty.call(next.groups, id);
        if (!configured && body.enabled)
            targets.push(...initialGroupTargets(id));
        // 未曾启用的群本来就是关闭状态，不将其误记为已应用默认配置。
        if (configured || body.enabled)
            next.groups[id] = body.enabled;
    }
    targets.push({ name: 'bot-participation.json', filePath: policy.PARTICIPATION_POLICY_FILE, content: Buffer.from(JSON.stringify(next, null, 2) + '\n') });
    executeConfigTransaction({
        dataDir: DATA_DIR,
        targets,
        refresh: () => { policy.readParticipationPolicy(); },
        verify: () => {
            if (JSON.stringify(policy.readParticipationPolicy()) !== JSON.stringify(next))
                throw new Error('参与开关写入校验失败');
        },
    });
    return next;
}
// --- 单群详情配置 ---
// 按项目现有映射文件读取配置，损坏的数据必须先修复，不能用空值覆盖。
function readMap(name) {
    const value = readFeatureFile(name, {});
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`${name} 配置格式无效`);
    return value;
}
// 兼容项目已存在的数字 ID 数组和 groups/users 桶，不修改用户桶及其他群。
function readGroupList(name) {
    const value = readFeatureFile(name, []);
    if (Array.isArray(value))
        return { value, groups: value };
    if (value && typeof value === 'object' && Array.isArray(value.groups)) {
        return { value: value, groups: value.groups };
    }
    throw new Error(`${name} 配置格式无效`);
}
// 获取单群真实值；空概率表示沿用系统默认值。
function readGroupSettings(groupId) {
    const current = policy.readParticipationPolicy();
    const contains = (name) => readGroupList(name).groups.some(id => String(id) === groupId);
    const binding = readMap('ai-persona-groups.json')[groupId];
    return {
        groupId, name: readSavedGroupNames()[groupId] || '', enabled: current.groups[groupId] === true,
        abusiveEnabled: current.abusiveGroups[groupId] === true,
        randomEnabled: contains('ai-random-whitelist.json'), repeatEnabled: readMap('ai-repeat-enabled.json')[groupId] === true,
        videoEnabled: !contains('video-blacklist.json'), collectionEnabled: !contains('group-name-at-disabled-groups.json'),
        summaryUnlimited: contains('summary-whitelist.json'), politicalEnabled: contains('political-detect-enabled.json'),
        persona: binding?.persona || '', randomRate: readMap('ai-random-rate.json')[groupId] ?? null,
        voiceRate: readMap('ai-random-voice-rate.json')[groupId] ?? null,
    };
}
// 为单群列表成员变化生成写入目标，保留既有文件结构。
function groupListTarget(name, groupId, included) {
    const { value, groups } = readGroupList(name);
    const next = groups.filter(id => String(id) !== groupId);
    if (included)
        next.push(groupId);
    return target(name, Array.isArray(value) ? next : { ...value, groups: next });
}
// 详情配置、名称和总开关原子保存，失败时整体回滚并恢复人格缓存。
function saveGroupSettings(settings) {
    const id = settings.groupId;
    const next = policy.readParticipationPolicy();
    next.groups[id] = settings.enabled;
    next.abusiveGroups[id] = settings.abusiveEnabled;
    const repeat = readMap('ai-repeat-enabled.json');
    const personas = readMap('ai-persona-groups.json');
    if (settings.persona)
        personas[id] = { ...(personas[id] || {}), persona: settings.persona };
    else
        delete personas[id];
    const targets = [
        target('bot-participation.json', next), target(GROUP_NAMES_FILE, { ...readSavedGroupNames(), [id]: settings.name.trim() }),
        target('ai-repeat-enabled.json', { ...repeat, [id]: settings.repeatEnabled }), target('ai-persona-groups.json', personas),
        groupListTarget('ai-random-whitelist.json', id, settings.randomEnabled),
        groupListTarget('video-blacklist.json', id, !settings.videoEnabled),
        groupListTarget('group-name-at-disabled-groups.json', id, !settings.collectionEnabled),
        groupListTarget('summary-whitelist.json', id, settings.summaryUnlimited),
        groupListTarget('political-detect-enabled.json', id, settings.politicalEnabled),
    ];
    for (const [file, rate] of [['ai-random-rate.json', settings.randomRate], ['ai-random-voice-rate.json', settings.voiceRate]]) {
        const values = readMap(file);
        if (rate === null)
            delete values[id];
        else
            values[id] = rate;
        targets.push(target(file, values));
    }
    executeConfigTransaction({
        dataDir: DATA_DIR, targets,
        refresh: () => { policy.readParticipationPolicy(); loadManagementModule('media.persona').loadPersonaGroups(); },
        verify: () => {
            if (JSON.stringify(readGroupSettings(id)) !== JSON.stringify({ ...settings, name: settings.name.trim() }))
                throw new Error('群详情写入校验失败');
        },
    });
}
// 新增和移除只操作管理名单；移除后默认禁止该群参与，原有功能配置可供重新添加使用。
function updateManagedGroup(groupId, remove) {
    const next = policy.readParticipationPolicy();
    const names = readSavedGroupNames();
    const targets = [];
    if (remove) {
        delete next.groups[groupId];
        delete next.abusiveGroups[groupId];
        delete names[groupId];
        targets.push(target(GROUP_NAMES_FILE, names));
    }
    else if (!(groupId in next.groups || groupId in next.abusiveGroups)) {
        targets.push(...initialGroupTargets(groupId));
        next.groups[groupId] = false;
    }
    targets.push(target('bot-participation.json', next));
    executeConfigTransaction({
        dataDir: DATA_DIR, targets, refresh: () => { policy.readParticipationPolicy(); },
        verify: () => {
            if (JSON.stringify(policy.readParticipationPolicy()) !== JSON.stringify(next))
                throw new Error('群列表写入校验失败');
            if (remove && groupId in readSavedGroupNames())
                throw new Error('群名移除校验失败');
        },
    });
}
// --- 管理员 HTTP 路由 ---
// 新增或删除群，始终校验群号和管理员权限。
function handleManageGroup(req, res) {
    if (!requireAdmin(req, res))
        return;
    collectBody(req, res, text => {
        let body;
        try {
            body = JSON.parse(text);
        }
        catch {
            return json(res, { ok: false, message: '请求必须是有效 JSON' }, 400);
        }
        if (!body || typeof body.groupId !== 'string' || !policy.GROUP_ID_PATTERN.test(body.groupId))
            return json(res, { ok: false, message: '请提供有效群号' }, 400);
        try {
            const remove = req.method === 'DELETE';
            updateManagedGroup(body.groupId, remove);
            json(res, { ok: true, policy: policy.readParticipationPolicy(), groups: readSavedGroupNames(), message: remove ? '群已从列表删除' : '群已添加' });
        }
        catch (error) {
            json(res, { ok: false, message: getErrorMessage(error) }, 500);
        }
    });
}
// 返回当前群详情、可选人格及系统默认概率。
function handleGetGroupSettings(req, res) {
    if (!requireAdmin(req, res))
        return;
    const id = new URL(req.url, 'http://localhost').searchParams.get('groupId') || '';
    if (!policy.GROUP_ID_PATTERN.test(id))
        return json(res, { ok: false, message: '请提供有效群号' }, 400);
    try {
        const current = policy.readParticipationPolicy();
        if (!(id in current.groups || id in current.abusiveGroups))
            return json(res, { ok: false, message: '该群不在管理列表中' }, 404);
        const personas = loadManagementModule('media.persona').getAvailablePersonals().filter(item => item.type !== 'core').map(item => String(item.name));
        json(res, { ok: true, settings: readGroupSettings(id), personas, defaults: { randomRate: loadManagementModule('core.constants').RANDOM_TRIGGER_RATE_BASE, voiceRate: 0.1 } });
    }
    catch (error) {
        json(res, { ok: false, message: getErrorMessage(error) }, 500);
    }
}
// 仅接收详情菜单公开的布尔、概率和人格字段，拒绝无效值。
function handlePutGroupSettings(req, res) {
    if (!requireAdmin(req, res))
        return;
    collectBody(req, res, text => {
        let value;
        try {
            value = JSON.parse(text);
        }
        catch {
            return json(res, { ok: false, message: '请求必须是有效 JSON' }, 400);
        }
        const body = value;
        const switches = ['enabled', 'abusiveEnabled', 'randomEnabled', 'repeatEnabled', 'videoEnabled', 'collectionEnabled', 'summaryUnlimited', 'politicalEnabled'];
        if (!body || typeof body.groupId !== 'string' || !policy.GROUP_ID_PATTERN.test(body.groupId) || typeof body.name !== 'string' || body.name.trim().length > MAX_GROUP_NAME_LENGTH || typeof body.persona !== 'string' || switches.some(key => typeof body[key] !== 'boolean') || [body.randomRate, body.voiceRate].some(rate => rate !== null && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1))) {
            return json(res, { ok: false, message: '群详情格式无效，概率须在 0 到 100% 之间' }, 400);
        }
        try {
            const current = policy.readParticipationPolicy();
            if (!(body.groupId in current.groups || body.groupId in current.abusiveGroups))
                return json(res, { ok: false, message: '该群不在管理列表中' }, 404);
            if (body.persona && !loadManagementModule('media.persona').getAvailablePersonals().some(item => item.type !== 'core' && item.name === body.persona))
                return json(res, { ok: false, message: '所选人格不存在' }, 400);
            // 明确选择已验证字段，避免请求附加字段写入配置或影响回读比较。
            const settings = { groupId: body.groupId, name: body.name, enabled: body.enabled, abusiveEnabled: body.abusiveEnabled, randomEnabled: body.randomEnabled, repeatEnabled: body.repeatEnabled, videoEnabled: body.videoEnabled, collectionEnabled: body.collectionEnabled, summaryUnlimited: body.summaryUnlimited, politicalEnabled: body.politicalEnabled, persona: body.persona, randomRate: body.randomRate, voiceRate: body.voiceRate };
            saveGroupSettings(settings);
            json(res, { ok: true, settings: readGroupSettings(body.groupId), policy: policy.readParticipationPolicy(), groups: readSavedGroupNames(), message: '群详情已保存' });
        }
        catch (error) {
            json(res, { ok: false, message: getErrorMessage(error) }, 500);
        }
    });
}
// 返回当前配置，未配置的群和私聊均显示为关闭。
function handleGetParticipation(req, res) {
    if (!requireAdmin(req, res))
        return;
    try {
        json(res, { ok: true, policy: policy.readParticipationPolicy() });
    }
    catch (error) {
        json(res, { ok: false, message: getErrorMessage(error) }, 500);
    }
}
// 读取持久群名，不查询 QQ，也不会覆盖管理员修改的名称。
function handleGetGroupNames(req, res) {
    if (!requireAdmin(req, res))
        return;
    try {
        json(res, { ok: true, groups: readSavedGroupNames() });
    }
    catch (error) {
        json(res, { ok: false, message: getErrorMessage(error) }, 500);
    }
}
// 仅为已加入总开关列表且尚未保存名称的群读取一次 QQ 群名。
function handleImportGroupNames(req, res) {
    if (!requireAdmin(req, res))
        return;
    collectBody(req, res, async (text) => {
        let body;
        try {
            body = JSON.parse(text);
        }
        catch {
            return json(res, { ok: false, message: '请求必须是有效 JSON' }, 400);
        }
        try {
            const current = policy.readParticipationPolicy();
            if (!body || !Array.isArray(body.groupIds) || body.groupIds.length > 1000 || body.groupIds.some(id => typeof id !== 'string' || !policy.GROUP_ID_PATTERN.test(id) || !(id in current.groups || id in current.abusiveGroups))) {
                return json(res, { ok: false, message: '请提供已加入列表的有效群号' }, 400);
            }
            json(res, { ok: true, ...await importGroupNames([...new Set(body.groupIds)]) });
        }
        catch (error) {
            json(res, { ok: false, message: getErrorMessage(error) }, 500);
        }
    });
}
// 编辑控制台名称，只更新本地备注，不调用 QQ 改名接口。
function handlePutGroupName(req, res) {
    if (!requireAdmin(req, res))
        return;
    collectBody(req, res, text => {
        let body;
        try {
            body = JSON.parse(text);
        }
        catch {
            return json(res, { ok: false, message: '请求必须是有效 JSON' }, 400);
        }
        if (!body || typeof body.groupId !== 'string' || !policy.GROUP_ID_PATTERN.test(body.groupId) || typeof body.name !== 'string' || body.name.trim().length > MAX_GROUP_NAME_LENGTH) {
            return json(res, { ok: false, message: '请提供有效群号和不超过 128 字的群名' }, 400);
        }
        try {
            const current = policy.readParticipationPolicy();
            if (!(body.groupId in current.groups || body.groupId in current.abusiveGroups))
                return json(res, { ok: false, message: '请先将群加入总开关列表' }, 400);
            const groups = { ...readSavedGroupNames(), [body.groupId]: body.name.trim() };
            saveGroupNames(groups);
            json(res, { ok: true, groups, message: '群名已保存' });
        }
        catch (error) {
            json(res, { ok: false, message: getErrorMessage(error) }, 500);
        }
    });
}
// 只允许管理员提交明确的布尔开关和有效数字群号。
function handlePutParticipation(req, res) {
    if (!requireAdmin(req, res))
        return;
    collectBody(req, res, text => {
        let value;
        try {
            value = JSON.parse(text);
        }
        catch {
            return json(res, { ok: false, message: '请求必须是有效 JSON' }, 400);
        }
        const body = value;
        if (!body || (body.kind !== 'private' && body.kind !== 'group' && body.kind !== 'group-abusive') || typeof body.enabled !== 'boolean' || (body.kind !== 'private' && (typeof body.groupId !== 'string' || !policy.GROUP_ID_PATTERN.test(body.groupId)))) {
            return json(res, { ok: false, message: '请提供正确的开关类型、布尔状态和群号' }, 400);
        }
        try {
            const saved = saveParticipationUpdate(body);
            const label = body.kind === 'group-abusive' ? '嘴臭开关' : '总开关';
            json(res, { ok: true, policy: saved, message: body.kind === 'private' ? `全局私聊已${body.enabled ? '开启' : '关闭'}` : `群 ${body.groupId} ${label}已${body.enabled ? '开启' : '关闭'}` });
        }
        catch (error) {
            json(res, { ok: false, message: getErrorMessage(error) }, 500);
        }
    });
}
exports.routes = {
    'GET /dashboard/api/groups': handleGetGroupNames,
    'POST /dashboard/api/groups': handleManageGroup,
    'DELETE /dashboard/api/groups': handleManageGroup,
    'GET /dashboard/api/groups/detail': handleGetGroupSettings,
    'PUT /dashboard/api/groups/detail': handlePutGroupSettings,
    'POST /dashboard/api/groups/import': handleImportGroupNames,
    'PUT /dashboard/api/groups': handlePutGroupName,
    'GET /dashboard/api/participation': handleGetParticipation,
    'PUT /dashboard/api/participation': handlePutParticipation,
};
