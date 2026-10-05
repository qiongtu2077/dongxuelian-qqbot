"use strict";
const { h, segment } = require('koishi');
const fs = require('fs/promises');
const path = require('path');
const nicknameStorage = require('./storage');
const name = 'group-name-at';
const PLUGIN_VERSION = '0.4.7';
function resolveRuntimeDataDir() {
    const configured = String(process.env.DONGXUELIAN_AI_DATA_DIR || '').trim();
    if (configured)
        return path.resolve(configured);
    const koishiDir = String(process.env.KOISHI_DIR || process.env.KOISHI_APP_DIR || '').trim();
    if (koishiDir)
        return path.resolve(koishiDir, 'data');
    return path.resolve(process.cwd(), 'data');
}
const DEFAULT_DATA_DIR = resolveRuntimeDataDir();
const { DATA_FILE, LEGACY_DATA_FILE, SCOPE_DATA_DIR, USE_LEGACY_STORE } = nicknameStorage;
const DISABLED_GROUPS_FILE = process.env.GROUP_NAME_AT_DISABLED_GROUPS_FILE || path.join(DEFAULT_DATA_DIR, 'group-name-at-disabled-groups.json');
const ADMIN_IDS_FILE = process.env.GROUP_NAME_AT_ADMIN_IDS_FILE || path.join(DEFAULT_DATA_DIR, 'ai-admin-ids.json');
const CONFIRM_TIMEOUT = 60 * 1000;
const MAX_DISABLED_GROUPS_BYTES = 128 * 1024;
const MAX_ADMIN_IDS_BYTES = 128 * 1024;
const MAX_PENDING_CONFIRMS = 500;
const MAX_ALIAS_NAME_BYTES = 512;
const NICKNAME_RECORD_PAGE_SIZE = 100;
const CMD = {
    alias: '昵称',
    deleteAlias: '删除昵称',
    viewAlias: '查看昵称',
    viewCollection: '查看集合',
    viewAllAliases: '查看全部昵称',
    viewAllCollections: '查看全部集合',
    collectionList: '集合列表',
    whoIs: '谁是',
    createCollection: '创建集合',
    addCollection: '集合添加',
    removeCollection: '集合删除',
    clearCollection: '清空集合',
    confirmClearCollection: '确认清空集合',
    deleteCollection: '删除集合',
    confirmDeleteCollection: '确认删除集合',
    renameCollection: '重命名集合',
    renameAlias: '重命名昵称',
    copyCollection: '复制集合',
    mergeCollection: '合并集合',
    intersectCollection: '集合交集',
    unionCollection: '集合并集',
    diffCollection: '集合差集',
    viewMember: '查看成员',
    nicknameBlacklistView: '群聊昵称黑名单查看',
    nicknameBlacklistAdd: '群聊昵称黑名单添加',
    nicknameBlacklistDelete: '群聊昵称黑名单删除',
};
const TEXT = {
    aliasEmpty: '名称不能为空。',
    aliasTooLong: '昵称超限，最大512字符',
    mentionRequired: '请至少 @ 一个成员。',
    memberRequired: '请指定成员名或 @ 一个成员。',
    aliasNotFound: (alias) => `没有找到「${alias}」。`,
    aliasAdded: (alias) => `昵称“${alias}”成功绑定到用户！`,
    aliasExists: (alias) => `昵称“${alias}”已经绑定过该用户。`,
    aliasRemoveMissing: (alias) => `「${alias}」下没有绑定该成员。`,
    aliasRemovedLast: (alias) => `已删除昵称「${alias}」。`,
    aliasRemoved: (alias, count) => `已从「${alias}」中移除该成员，当前剩余 ${count} 人。`,
    aliasListTitle: '本群昵称：',
    aliasListEmpty: '本群还没有昵称。',
    collectionListTitle: '本群集合：',
    collectionListEmpty: '本群还没有集合。',
    collectionTitle: (alias) => `集合：${alias}`,
    aliasTitle: (alias) => `昵称：${alias}`,
    collectionCount: (count) => `人数：${count}`,
    collectionCreated: (alias, count) => `已创建集合「${alias}」，当前共 ${count} 人。`,
    collectionAdded: (alias, added, count) => `已向集合「${alias}」添加 ${added} 人，当前共 ${count} 人。`,
    collectionRemoved: (alias, removed, count) => `已从集合「${alias}」移除 ${removed} 人，当前剩余 ${count} 人。`,
    collectionDeleted: (alias) => `已删除集合「${alias}」。`,
    collectionCleared: (alias) => `已清空集合「${alias}」。`,
    confirmDelete: (alias) => `危险操作：再次发送「确认删除集合 ${alias}」即可删除整个集合，60 秒内有效。`,
    confirmClear: (alias) => `危险操作：再次发送「确认清空集合 ${alias}」即可清空成员，60 秒内有效。`,
    renameDone: (from, to) => `已将「${from}」重命名为「${to}」。`,
    targetExists: (to) => `「${to}」已存在，不能覆盖。`,
    copied: (from, to, count) => `已复制集合「${from}」为「${to}」，共 ${count} 人。`,
    merged: (target, source, added, count) => `已将集合「${source}」合并到「${target}」，新增 ${added} 人，当前共 ${count} 人。`,
    memberNoAlias: (label) => `${label} 暂时没有昵称，也不在任何集合里。`,
    memberTitle: (label) => `${label} 的昵称 / 集合：`,
    setTitle: (type, left, right) => `${type}：${left} / ${right}`,
    storeReadFailed: '昵称数据读取失败，请检查文件格式或权限。',
    storeSaveFailed: '昵称数据保存失败，请检查文件权限。',
    blacklistEmpty: '群聊昵称黑名单为空。',
    blacklistTitle: '群聊昵称黑名单：',
    blacklistAdded: (groupId) => `已添加群聊昵称黑名单：${groupId}`,
    blacklistDeleted: (groupId) => `已移出群聊昵称黑名单：${groupId}`,
    blacklistGroupRequired: '请指定群号。',
    blacklistInvalidGroup: '群号必须是数字。',
    blacklistPermissionDenied: '只有群主、群管理员或bot管理员才能操作。',
    blacklistCrossGroupDenied: '群管理员只能操作当前群。',
    blacklistSaveFailed: '群聊昵称黑名单保存失败，请检查文件权限。',
};
const pendingConfirms = new Map();
let disabledGroupsCache = { fingerprint: '', groups: new Set() };
function handleStoreAccessError(ctx, error) {
    if (error && error.code === 'GROUP_NAME_AT_STORE_ACCESS') {
        ctx.logger('group-name-at').warn(error.message);
        return error.userMessage;
    }
    throw error;
}
async function safeSendText(ctx, session, text) {
    const value = String(text || '').trim();
    if (!value)
        return false;
    try {
        await session.send(value);
        return true;
    }
    catch (error) {
        ctx.logger('group-name-at').warn(`send failed: ${error?.message || error}`);
        return false;
    }
}
function getScopeId(session) {
    return String(session.guildId || session.channelId || 'global');
}
function getGroupBlacklistCandidates(session) {
    const ids = [];
    if (session.guildId)
        ids.push(String(session.guildId));
    if (!session.isDirect && session.channelId)
        ids.push(String(session.channelId));
    return [...new Set(ids.filter(Boolean))];
}
function isBlacklistedGroup(session) {
    const disabled = loadDisabledGroups();
    return getGroupBlacklistCandidates(session).some(groupId => disabled.groups.has(groupId));
}
function getSenderUserId(session) {
    return String(session.userId || session.author?.id || session.event?.user?.id || '');
}
function getGroupRole(session) {
    return String(session.event?.sender?.role || session.event?.member?.role || '');
}
function isGroupAdmin(session) {
    const role = getGroupRole(session);
    return role === 'owner' || role === 'admin';
}
function getFileFingerprint(filePath) {
    try {
        const stat = require('fs').statSync(filePath);
        return `${stat.mtimeMs}:${stat.size}`;
    }
    catch {
        return 'missing';
    }
}
function uniqueStrings(values = []) {
    return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))];
}
function readAdminUserIds() {
    try {
        const fsSync = require('fs');
        const stat = fsSync.statSync(ADMIN_IDS_FILE);
        if (!stat.isFile() || stat.size > MAX_ADMIN_IDS_BYTES)
            return new Set();
        const parsed = JSON.parse(fsSync.readFileSync(ADMIN_IDS_FILE, 'utf8'));
        const ids = Array.isArray(parsed) ? parsed : [];
        return new Set(uniqueStrings(ids.map(value => String(value || '').trim())));
    }
    catch {
        const fallback = String(process.env.DONGXUELIAN_DEFAULT_ADMIN_IDS || '')
            .split(',')
            .map(value => value.trim())
            .filter(Boolean);
        return new Set(uniqueStrings(fallback));
    }
}
function hasBotAdminPermission(session) {
    return readAdminUserIds().has(getSenderUserId(session));
}
function loadDisabledGroups(force = false) {
    const fingerprint = getFileFingerprint(DISABLED_GROUPS_FILE);
    if (!force && disabledGroupsCache.fingerprint === fingerprint)
        return disabledGroupsCache;
    let groups = [];
    if (fingerprint !== 'missing') {
        try {
            const fsSync = require('fs');
            const stat = fsSync.statSync(DISABLED_GROUPS_FILE);
            if (!stat.isFile() || stat.size > MAX_DISABLED_GROUPS_BYTES)
                throw new Error('disabled group file too large');
            const raw = JSON.parse(fsSync.readFileSync(DISABLED_GROUPS_FILE, 'utf8'));
            groups = Array.isArray(raw) ? raw.map(String) : raw && typeof raw === 'object' && Array.isArray(raw.groups) ? raw.groups.map(String) : [];
        }
        catch {
            groups = [];
        }
    }
    disabledGroupsCache = { fingerprint, groups: new Set(uniqueStrings(groups)) };
    return disabledGroupsCache;
}
async function saveDisabledGroups(groups) {
    const list = uniqueStrings([...groups]).sort((a, b) => a.localeCompare(b, 'zh-CN'));
    try {
        await fs.mkdir(path.dirname(DISABLED_GROUPS_FILE), { recursive: true });
        const tmp = `${DISABLED_GROUPS_FILE}.tmp-${process.pid}-${Date.now()}`;
        await fs.writeFile(tmp, JSON.stringify({ groups: list }, null, 2), 'utf8');
        await fs.rename(tmp, DISABLED_GROUPS_FILE);
        disabledGroupsCache = {
            fingerprint: getFileFingerprint(DISABLED_GROUPS_FILE),
            groups: new Set(list),
        };
    }
    catch (error) {
        throw nicknameStorage.createStoreAccessError(TEXT.blacklistSaveFailed, error);
    }
}
function normalizeName(name = '') {
    return String(name).replace(/\s+/g, ' ').trim();
}
// 判断归一化后的昵称或集合名是否超过 UTF-8 字节上限。
function isAliasNameTooLong(name) {
    return Buffer.byteLength(name, 'utf8') > MAX_ALIAS_NAME_BYTES;
}
// 返回昵称或集合名的用户可见校验错误。
function validateAliasName(name) {
    if (!name)
        return TEXT.aliasEmpty;
    if (isAliasNameTooLong(name))
        return TEXT.aliasTooLong;
    return null;
}
function splitWords(text = '') {
    return normalizeName(text).split(' ').filter(Boolean);
}
function afterCommand(input, command) {
    if (input === command)
        return '';
    if (input.startsWith(command + ' '))
        return normalizeName(input.slice(command.length));
    return null;
}
// 群管理命令跟随主插件习惯，允许“命令”和纯数字群号之间不加空格。
function afterNumericAdminCommand(input, command) {
    const value = afterCommand(input, command);
    if (value !== null)
        return value;
    if (input.startsWith(command))
        return normalizeName(input.slice(command.length));
    return null;
}
function parseCommandPair(plain, command) {
    const value = afterCommand(plain, command);
    if (!value)
        return null;
    const args = splitWords(value);
    return args.length >= 2 ? [args[0], args[1]] : null;
}
function parseNicknameBlacklistCommand(content = '') {
    const plain = stripMentions(content);
    if (plain === CMD.nicknameBlacklistView)
        return { action: 'view' };
    for (const [command, action] of [
        [CMD.nicknameBlacklistAdd, 'add'],
        [CMD.nicknameBlacklistDelete, 'delete'],
    ]) {
        const value = afterNumericAdminCommand(plain, command);
        if (value === null)
            continue;
        const groupId = splitWords(value)[0] || '';
        return { action, groupId };
    }
    return null;
}
function canManageNicknameBlacklist(session, targetGroupId) {
    if (hasBotAdminPermission(session))
        return { ok: true };
    if (!isGroupAdmin(session))
        return { ok: false, message: TEXT.blacklistPermissionDenied };
    const currentGroups = getGroupBlacklistCandidates(session);
    if (!currentGroups.includes(String(targetGroupId))) {
        return { ok: false, message: TEXT.blacklistCrossGroupDenied };
    }
    return { ok: true };
}
async function handleNicknameBlacklistCommand(session, command) {
    const disabled = loadDisabledGroups();
    if (command.action === 'view') {
        const permission = hasBotAdminPermission(session) || isGroupAdmin(session);
        if (!permission)
            return TEXT.blacklistPermissionDenied;
        const list = [...disabled.groups].sort((a, b) => a.localeCompare(b, 'zh-CN'));
        return list.length ? [TEXT.blacklistTitle, ...list].join('\n') : TEXT.blacklistEmpty;
    }
    const groupId = String(command.groupId || '').trim();
    if (!groupId)
        return TEXT.blacklistGroupRequired;
    if (!/^\d+$/.test(groupId))
        return TEXT.blacklistInvalidGroup;
    const permission = canManageNicknameBlacklist(session, groupId);
    if (!permission.ok)
        return permission.message;
    const groups = new Set(disabled.groups);
    if (command.action === 'add')
        groups.add(groupId);
    else
        groups.delete(groupId);
    await saveDisabledGroups(groups);
    return command.action === 'add' ? TEXT.blacklistAdded(groupId) : TEXT.blacklistDeleted(groupId);
}
// 初始化分片存储或显式旧版存储。
async function ensureStore() {
    await nicknameStorage.ensureStore();
}
// 按当前会话 scope 加载昵称集合，存储模块负责缓存和旧数据懒迁移。
async function getScopeStore(session) {
    return nicknameStorage.loadScopeStore(getScopeId(session));
}
// 保存当前会话 scope，存储模块负责按 scope 串行原子写入。
async function saveStore(session) {
    await nicknameStorage.persistScopeStore(getScopeId(session));
}
// 获取名称条目，创建时同时初始化双向关系。
function ensureAliasEntry(scopeStore, alias) {
    if (!scopeStore.aliases[alias])
        nicknameStorage.setAliasEntry(scopeStore, alias, { members: [] });
    if (!Array.isArray(scopeStore.aliases[alias].members))
        scopeStore.aliases[alias].members = [];
    return scopeStore.aliases[alias];
}
function getEntry(scopeStore, alias) {
    const entry = scopeStore.aliases[alias];
    if (!entry)
        return null;
    if (!Array.isArray(entry.members))
        entry.members = [];
    return entry;
}
function extractMentionIds(content = '') {
    const ids = [];
    const text = String(content);
    const patterns = [
        /<at(?:\s+[^>]*?)?id="(\d+)"[^>]*\/?>/gi,
        /\[CQ:at,[^\]]*?(?:qq|id)=(\d+)[^\]]*\]/gi,
    ];
    for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text))) {
            const userId = String(match[1]);
            if (!ids.includes(userId))
                ids.push(userId);
        }
    }
    return ids;
}
function stripMentions(content = '') {
    return String(content)
        .replace(/<at(?:\s+[^>]*?)?id="\d+"[^>]*\/?>/gi, ' ')
        .replace(/\[CQ:at,[^\]]*?(?:qq|id)=\d+[^\]]*\]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
async function readMemberByInternal(bot, guildId, userId) {
    const internal = bot?.internal;
    const readers = [
        () => internal?.getGroupMemberInfo?.(guildId, userId, false),
        () => internal?.get_group_member_info?.({ group_id: guildId, user_id: userId, no_cache: false }),
    ];
    for (const read of readers) {
        try {
            const data = await read();
            if (data)
                return data;
        }
        catch { /* non-critical: try the next member lookup API */
        }
    }
    return null;
}
async function getDisplayName(session, userId) {
    const selfCandidate = session.event?.member?.nick || session.event?.member?.name || session.author?.nick || session.author?.name || session.username;
    if (String(session.userId || '') === String(userId) && selfCandidate)
        return String(selfCandidate);
    const bot = session.bot;
    const guildId = session.guildId;
    const readers = [
        async () => bot?.getGuildMember?.(guildId, userId),
        async () => bot?.getGroupMember?.(guildId, userId),
        async () => readMemberByInternal(bot, guildId, userId),
        async () => bot?.getUser?.(userId),
    ];
    for (const read of readers) {
        try {
            const data = await read();
            const candidate = data?.card || data?.nick || data?.nickname || data?.name || data?.username || data?.user?.name;
            if (candidate)
                return String(candidate);
        }
        catch { /* non-critical: try the next display name source */
        }
    }
    return '';
}
// 优先使用成员显示名称，缺少名称时返回可发送的 @ 消息文本。
function formatMemberLabel(member) {
    const displayName = String(member.displayName || '').trim();
    if (displayName && displayName !== member.userId && displayName !== `QQ${member.userId}`)
        return displayName;
    return segment.at(member.userId).toString();
}
async function refreshMemberDisplayNames(session, members) {
    let changed = false;
    for (const member of members) {
        const displayName = await getDisplayName(session, member.userId);
        if (!displayName || displayName === member.userId || displayName === `QQ${member.userId}`)
            continue;
        if (member.displayName !== displayName) {
            member.displayName = displayName;
            changed = true;
        }
    }
    return changed;
}
function buildAtMessage(members, tail) {
    const atPart = members.map((member) => segment.at(member.userId)).join('');
    return tail ? atPart + ' ' + tail : atPart;
}
async function createMember(session, userId) {
    return {
        userId: String(userId),
        displayName: await getDisplayName(session, userId),
        createdBy: String(session.userId || ''),
        createdAt: new Date().toISOString(),
    };
}
// 添加未绑定的成员，并一次更新名称条目及用户索引。
async function addMembers(session, alias, userIds) {
    const scopeStore = await getScopeStore(session);
    const initial = ensureAliasEntry(scopeStore, alias);
    const additions = [];
    for (const userId of userIds) {
        if ([...initial.members, ...additions].some(member => member.userId === String(userId)))
            continue;
        additions.push(await createMember(session, userId));
    }
    // 资料查询期间其他请求可完成绑定；提交时基于最新条目合并，避免丢人或重复。
    const current = ensureAliasEntry(scopeStore, alias);
    const existing = new Set(current.members.map(member => member.userId));
    const addedMembers = additions.filter(member => !existing.has(member.userId));
    const entry = { members: [...current.members, ...addedMembers] };
    nicknameStorage.setAliasEntry(scopeStore, alias, entry);
    return { entry, added: addedMembers.length };
}
// 将用户绑定到昵称，并同步用户到名称的反向索引。
async function bindAlias(session, alias, targetUserId) {
    await ensureStore();
    alias = normalizeName(alias);
    const invalidAlias = validateAliasName(alias);
    if (invalidAlias)
        return invalidAlias;
    const scopeStore = await getScopeStore(session);
    const entry = ensureAliasEntry(scopeStore, alias);
    const existing = entry.members.find((member) => member.userId === String(targetUserId));
    if (existing)
        return TEXT.aliasExists(alias);
    const member = await createMember(session, targetUserId);
    // 再检查一次最新关系，收住并发首次绑定和重复绑定。
    const current = ensureAliasEntry(scopeStore, alias);
    if (current.members.some(item => item.userId === member.userId))
        return TEXT.aliasExists(alias);
    const members = [...current.members, member];
    nicknameStorage.setAliasEntry(scopeStore, alias, { members });
    await saveStore(session);
    if (members.length === 1)
        return TEXT.aliasAdded(alias);
    return TEXT.collectionAdded(alias, 1, members.length);
}
// 移除昵称中的目标用户；最后一人移除时同时删除名称及索引。
async function removeAliasBinding(session, alias, targetUserId) {
    await ensureStore();
    alias = normalizeName(alias);
    if (!alias)
        return TEXT.aliasEmpty;
    const scopeStore = await getScopeStore(session);
    const entry = getEntry(scopeStore, alias);
    if (!entry || !entry.members.length)
        return TEXT.aliasNotFound(alias);
    const before = entry.members.length;
    const members = entry.members.filter((member) => member.userId !== String(targetUserId));
    if (members.length === before)
        return TEXT.aliasRemoveMissing(alias);
    if (!members.length) {
        nicknameStorage.setAliasEntry(scopeStore, alias, null);
        await saveStore(session);
        return TEXT.aliasRemovedLast(alias);
    }
    nicknameStorage.setAliasEntry(scopeStore, alias, { members });
    await saveStore(session);
    return TEXT.aliasRemoved(alias, members.length);
}
async function viewAlias(session, alias) {
    await ensureStore();
    alias = normalizeName(alias);
    if (!alias)
        return TEXT.aliasEmpty;
    const scopeStore = await getScopeStore(session);
    const entry = getEntry(scopeStore, alias);
    if (!entry)
        return TEXT.aliasNotFound(alias);
    const changed = await refreshMemberDisplayNames(session, entry.members);
    if (changed)
        await saveStore(session);
    const title = entry.members.length > 1 ? TEXT.collectionTitle(alias) : TEXT.aliasTitle(alias);
    const lines = entry.members.map((member, index) => `${index + 1}. ${formatMemberLabel(member)}`);
    return [title, TEXT.collectionCount(entry.members.length), ...lines].join('\n');
}
async function sendAliasMention(session, alias, tail) {
    await ensureStore();
    alias = normalizeName(alias);
    if (!alias)
        return null;
    const scopeStore = await getScopeStore(session);
    const entry = getEntry(scopeStore, alias);
    if (!entry || !entry.members.length)
        return null;
    const changed = await refreshMemberDisplayNames(session, entry.members);
    if (changed)
        await saveStore(session);
    return buildAtMessage(entry.members, tail);
}
// --- 昵称列表展示 --- #
// 将查询结果放入同一份消息记录，每条记录最多包含 100 个昵称。
function renderNicknameRecord(title, lines) {
    const pages = [];
    const pageCount = Math.max(1, Math.ceil(lines.length / NICKNAME_RECORD_PAGE_SIZE));
    // 空结果也保留一条提示；标题不占用昵称名额，最后一页保留不足 100 个的余项。
    for (let offset = 0; offset < Math.max(lines.length, 1); offset += NICKNAME_RECORD_PAGE_SIZE) {
        const pageTitle = pageCount > 1 ? `${title}（第 ${offset / NICKNAME_RECORD_PAGE_SIZE + 1}/${pageCount} 页）` : title;
        const content = [pageTitle, ...lines.slice(offset, offset + NICKNAME_RECORD_PAGE_SIZE)].join('\n');
        // 将昵称作为纯文本传入，避免名称中的消息标签被解析为 @ 或嵌套消息记录。
        pages.push(h('message', {}, h.text(content)));
    }
    return h('message', { forward: true }, pages).toString();
}
// 列出当前群的昵称或集合，昵称查询通过分页消息记录展示。
async function listEntries(session, mode) {
    await ensureStore();
    const scopeStore = await getScopeStore(session);
    const entries = Object.entries(scopeStore.aliases)
        .map(([alias, entry]) => [alias, Array.isArray(entry.members) ? entry.members : []])
        .filter(([, members]) => mode === 'alias' ? members.length === 1 : members.length > 1)
        .sort((left, right) => left[0].localeCompare(right[0], 'zh-CN'));
    if (!entries.length)
        return mode === 'alias' ? renderNicknameRecord(TEXT.aliasListEmpty, []) : TEXT.collectionListEmpty;
    const lines = entries.map(([alias, members]) => `${alias} (${members.length})`);
    const title = mode === 'alias' ? TEXT.aliasListTitle : TEXT.collectionListTitle;
    return mode === 'alias' ? renderNicknameRecord(title, lines) : [title, ...lines].join('\n');
}
// --- 集合管理 --- #
async function createCollection(session, alias, userIds) {
    await ensureStore();
    alias = normalizeName(alias);
    const invalidAlias = validateAliasName(alias);
    if (invalidAlias)
        return invalidAlias;
    if (!userIds.length)
        return TEXT.mentionRequired;
    const scopeStore = await getScopeStore(session);
    if (scopeStore.aliases[alias])
        return TEXT.targetExists(alias);
    const { entry } = await addMembers(session, alias, userIds);
    await saveStore(session);
    return TEXT.collectionCreated(alias, entry.members.length);
}
// 向已有集合添加成员，并保存两个方向的关系。
async function collectionAdd(session, alias, userIds) {
    await ensureStore();
    alias = normalizeName(alias);
    const invalidAlias = validateAliasName(alias);
    if (invalidAlias)
        return invalidAlias;
    if (!userIds.length)
        return TEXT.mentionRequired;
    const scopeStore = await getScopeStore(session);
    const entry = getEntry(scopeStore, alias);
    if (!entry)
        return TEXT.aliasNotFound(alias);
    const { entry: updated, added } = await addMembers(session, alias, userIds);
    await saveStore(session);
    return TEXT.collectionAdded(alias, added, updated.members.length);
}
// 从集合移除指定成员，保留空集合并清理对应用户索引。
async function collectionRemove(session, alias, userIds) {
    await ensureStore();
    alias = normalizeName(alias);
    if (!alias)
        return TEXT.aliasEmpty;
    if (!userIds.length)
        return TEXT.mentionRequired;
    const scopeStore = await getScopeStore(session);
    const entry = getEntry(scopeStore, alias);
    if (!entry)
        return TEXT.aliasNotFound(alias);
    const removeSet = new Set(userIds.map(String));
    const before = entry.members.length;
    const members = entry.members.filter((member) => !removeSet.has(member.userId));
    const removed = before - members.length;
    nicknameStorage.setAliasEntry(scopeStore, alias, { members });
    await saveStore(session);
    return TEXT.collectionRemoved(alias, removed, members.length);
}
// --- 危险操作确认 --- #
// 将确认记录绑定到真实发送者、当前群聊、操作和集合。
function confirmKey(session, action, alias) {
    const userId = getSenderUserId(session);
    return userId ? `${getScopeId(session)}:${userId}:${action}:${alias}` : null;
}
// 为身份明确的发起者登记 60 秒内有效的确认记录。
function askConfirm(session, action, alias) {
    trimPendingConfirms();
    const key = confirmKey(session, action, alias);
    if (!key)
        return false;
    pendingConfirms.set(key, Date.now() + CONFIRM_TIMEOUT);
    return false;
}
// 仅消费当前发送者的有效确认，其他发送者不会影响原记录。
function takeConfirm(session, action, alias) {
    trimPendingConfirms();
    const key = confirmKey(session, action, alias);
    if (!key)
        return false;
    const expiresAt = pendingConfirms.get(key);
    if (!expiresAt || expiresAt <= Date.now()) {
        pendingConfirms.delete(key);
        return false;
    }
    pendingConfirms.delete(key);
    return true;
}
function trimPendingConfirms(now = Date.now()) {
    for (const [key, expiresAt] of pendingConfirms) {
        if (Number(expiresAt || 0) <= now)
            pendingConfirms.delete(key);
    }
    if (pendingConfirms.size <= MAX_PENDING_CONFIRMS)
        return;
    const ordered = Array.from(pendingConfirms.entries()).sort((a, b) => Number(a[1] || 0) - Number(b[1] || 0));
    for (const [key] of ordered.slice(0, pendingConfirms.size - MAX_PENDING_CONFIRMS))
        pendingConfirms.delete(key);
}
// --- 集合变更 --- #
// 发起集合删除或执行本人确认，无效确认返回空字符串以静默结束。
async function deleteCollection(session, alias, confirmed) {
    alias = normalizeName(alias);
    if (!alias)
        return TEXT.aliasEmpty;
    // 在访问集合前校验归属和时限，让他人、超时和重复确认都直接忽略。
    if (confirmed && !takeConfirm(session, 'delete', alias))
        return '';
    await ensureStore();
    const scopeStore = await getScopeStore(session);
    if (!scopeStore.aliases[alias])
        return TEXT.aliasNotFound(alias);
    if (!confirmed && !askConfirm(session, 'delete', alias))
        return TEXT.confirmDelete(alias);
    nicknameStorage.setAliasEntry(scopeStore, alias, null);
    await saveStore(session);
    return TEXT.collectionDeleted(alias);
}
// 经本人确认后清空集合成员，同时移除反向索引中的集合关系。
async function clearCollection(session, alias, confirmed) {
    await ensureStore();
    alias = normalizeName(alias);
    if (!alias)
        return TEXT.aliasEmpty;
    const scopeStore = await getScopeStore(session);
    const entry = getEntry(scopeStore, alias);
    if (!entry)
        return TEXT.aliasNotFound(alias);
    if (confirmed && !takeConfirm(session, 'clear', alias))
        return TEXT.confirmClear(alias);
    if (!confirmed && !askConfirm(session, 'clear', alias))
        return TEXT.confirmClear(alias);
    nicknameStorage.setAliasEntry(scopeStore, alias, { members: [] });
    await saveStore(session);
    return TEXT.collectionCleared(alias);
}
// 重命名昵称或集合，并替换所有关联用户索引中的名称。
async function renameEntry(session, from, to) {
    await ensureStore();
    from = normalizeName(from);
    to = normalizeName(to);
    if (!from || !to)
        return TEXT.aliasEmpty;
    const invalidTarget = validateAliasName(to);
    if (invalidTarget)
        return invalidTarget;
    const scopeStore = await getScopeStore(session);
    if (!scopeStore.aliases[from])
        return TEXT.aliasNotFound(from);
    if (scopeStore.aliases[to])
        return TEXT.targetExists(to);
    const entry = scopeStore.aliases[from];
    nicknameStorage.setAliasEntry(scopeStore, from, null);
    nicknameStorage.setAliasEntry(scopeStore, to, entry);
    await saveStore(session);
    return TEXT.renameDone(from, to);
}
// 复制集合及成员元信息，同时登记用户与新集合的关系。
async function copyCollection(session, from, to) {
    await ensureStore();
    from = normalizeName(from);
    to = normalizeName(to);
    if (!from || !to)
        return TEXT.aliasEmpty;
    const invalidTarget = validateAliasName(to);
    if (invalidTarget)
        return invalidTarget;
    const scopeStore = await getScopeStore(session);
    const entry = getEntry(scopeStore, from);
    if (!entry)
        return TEXT.aliasNotFound(from);
    if (scopeStore.aliases[to])
        return TEXT.targetExists(to);
    nicknameStorage.setAliasEntry(scopeStore, to, { members: entry.members.map((member) => ({ ...member })) });
    await saveStore(session);
    return TEXT.copied(from, to, entry.members.length);
}
// 合并集合中的不同成员，源集合及其索引关系保持有效。
async function mergeCollection(session, targetAlias, sourceAlias) {
    await ensureStore();
    targetAlias = normalizeName(targetAlias);
    sourceAlias = normalizeName(sourceAlias);
    if (!targetAlias || !sourceAlias)
        return TEXT.aliasEmpty;
    const invalidTarget = validateAliasName(targetAlias);
    if (invalidTarget)
        return invalidTarget;
    const scopeStore = await getScopeStore(session);
    const target = getEntry(scopeStore, targetAlias);
    const source = getEntry(scopeStore, sourceAlias);
    if (!target)
        return TEXT.aliasNotFound(targetAlias);
    if (!source)
        return TEXT.aliasNotFound(sourceAlias);
    let added = 0;
    const members = [...target.members];
    for (const member of source.members) {
        if (members.some((item) => item.userId === member.userId))
            continue;
        members.push({ ...member });
        added += 1;
    }
    nicknameStorage.setAliasEntry(scopeStore, targetAlias, { members });
    await saveStore(session);
    return TEXT.merged(targetAlias, sourceAlias, added, members.length);
}
// --- 成员查询与集合运算 --- #
// 使用已保存的用户标识或显示名称进行本地匹配。
function memberMatches(member, keyword) {
    return member.userId === keyword || normalizeName(member.displayName).includes(keyword);
}
// 按群和用户索引读取昵称/集合；查询不刷新成员资料、不写入数据。
async function viewMember(session, keyword, mentionId) {
    await ensureStore();
    const scopeStore = await getScopeStore(session);
    const matched = new Set();
    const target = mentionId ? String(mentionId) : normalizeName(keyword);
    if (!target)
        return TEXT.memberRequired;
    let label = target;
    // @ 或 QQ 号只访问该用户的名称列表；按显示名称模糊查找时才读取其他用户。
    const exactUser = !!mentionId || /^\d+$/.test(target);
    const userIds = exactUser ? [target] : Object.keys(scopeStore.users);
    for (const userId of userIds) {
        for (const alias of scopeStore.users[userId] || []) {
            const entry = scopeStore.aliases[alias];
            const member = entry.members.find(item => item.userId === userId);
            if (!exactUser && !memberMatches(member, target))
                continue;
            label = String(member.displayName || '').trim() || member.userId;
            matched.add(`${alias} (${entry.members.length})`);
        }
    }
    if (!matched.size)
        return renderNicknameRecord(TEXT.memberNoAlias(label), []);
    return renderNicknameRecord(TEXT.memberTitle(label), [...matched].sort((a, b) => a.localeCompare(b, 'zh-CN')));
}
// 判断带 @ 的“查看昵称”是否应反查成员绑定的昵称和集合。
function isMentionNicknameLookup(plain, mentionIds) {
    return mentionIds.length > 0 && plain === CMD.viewAlias;
}
async function collectionSet(session, left, right, type) {
    await ensureStore();
    left = normalizeName(left);
    right = normalizeName(right);
    const scopeStore = await getScopeStore(session);
    const leftEntry = getEntry(scopeStore, left);
    const rightEntry = getEntry(scopeStore, right);
    if (!leftEntry)
        return TEXT.aliasNotFound(left);
    if (!rightEntry)
        return TEXT.aliasNotFound(right);
    await refreshMemberDisplayNames(session, leftEntry.members);
    await refreshMemberDisplayNames(session, rightEntry.members);
    await saveStore(session);
    const rightIds = new Set(rightEntry.members.map((member) => member.userId));
    let members = [];
    if (type === '交集') {
        members = leftEntry.members.filter((member) => rightIds.has(member.userId));
    }
    else if (type === '并集') {
        const byId = new Map();
        for (const member of [...leftEntry.members, ...rightEntry.members])
            byId.set(member.userId, member);
        members = [...byId.values()];
    }
    else {
        members = leftEntry.members.filter((member) => !rightIds.has(member.userId));
    }
    const lines = members.map((member, index) => `${index + 1}. ${formatMemberLabel(member)}`);
    return [TEXT.setTitle(type, left, right), TEXT.collectionCount(members.length), ...lines].join('\n');
}
function parseAliasBind(content) {
    const mentionIds = extractMentionIds(content);
    if (!mentionIds.length)
        return null;
    const plain = stripMentions(content);
    if (plain === CMD.alias)
        return null;
    if (plain.startsWith(CMD.alias + ' ')) {
        const alias = normalizeName(plain.slice(CMD.alias.length));
        return alias ? { targetUserId: mentionIds[0], alias } : null;
    }
    if (plain.startsWith(CMD.alias)) {
        const alias = normalizeName(plain.slice(CMD.alias.length));
        return alias ? { targetUserId: mentionIds[0], alias } : null;
    }
    return null;
}
function parseAliasDelete(content, session) {
    const mentionIds = extractMentionIds(content);
    const plain = stripMentions(content);
    const alias = afterCommand(plain, CMD.deleteAlias);
    if (alias === null)
        return null;
    return {
        alias,
        targetUserId: mentionIds[0] || String(session.userId || ''),
    };
}
// 返回 at 后的原始文本（包含昵称+消息），由调用方再拆分
function parseAtAlias(content) {
    const plain = stripMentions(content);
    const match = plain.match(/^at\s*(.+)$/i);
    if (!match)
        return null;
    return normalizeName(match[1]);
}
// 从已有昵称中贪心匹配最长前缀，返回 { alias, tail } 或 null
async function resolveAtAlias(session, text) {
    await ensureStore();
    const scopeStore = await getScopeStore(session);
    const aliases = Object.keys(scopeStore.aliases);
    // 按昵称长度从长到短排序，优先匹配最长的
    aliases.sort((a, b) => b.length - a.length);
    const normalized = normalizeName(text);
    for (const alias of aliases) {
        if (normalized.startsWith(alias)) {
            const tail = normalized.slice(alias.length).trim();
            return { alias, tail };
        }
    }
    return null;
}
// 返回命令回复；空字符串表示静默处理，null 表示未匹配命令。
async function handlePlainCommand(session, content) {
    const plain = stripMentions(content);
    const mentionIds = extractMentionIds(content);
    if (!plain)
        return null;
    if (mentionIds.length && plain === CMD.alias) {
        return viewMember(session, '', mentionIds[0]);
    }
    if (isMentionNicknameLookup(plain, mentionIds)) {
        return viewMember(session, '', mentionIds[0]);
    }
    if (plain === CMD.viewAllAliases || /^nicklist$/i.test(plain)) {
        return listEntries(session, 'alias');
    }
    if (plain === CMD.viewAllCollections || plain === CMD.collectionList) {
        return listEntries(session, 'collection');
    }
    let value = afterCommand(plain, CMD.viewAlias);
    if (value !== null)
        return viewAlias(session, value);
    value = afterCommand(plain, CMD.viewCollection);
    if (value !== null)
        return viewAlias(session, value);
    value = afterCommand(plain, CMD.whoIs);
    if (value !== null)
        return viewAlias(session, value);
    value = afterCommand(plain, CMD.viewMember);
    if (value !== null) {
        return viewMember(session, value, mentionIds[0]);
    }
    value = afterCommand(plain, CMD.createCollection);
    if (value !== null)
        return createCollection(session, value, mentionIds);
    value = afterCommand(plain, CMD.addCollection);
    if (value !== null)
        return collectionAdd(session, value, mentionIds);
    value = afterCommand(plain, CMD.removeCollection);
    if (value !== null)
        return collectionRemove(session, value, mentionIds);
    value = afterCommand(plain, CMD.confirmDeleteCollection);
    if (value !== null)
        return deleteCollection(session, value, true);
    value = afterCommand(plain, CMD.deleteCollection);
    if (value !== null)
        return deleteCollection(session, value, false);
    value = afterCommand(plain, CMD.confirmClearCollection);
    if (value !== null)
        return clearCollection(session, value, true);
    value = afterCommand(plain, CMD.clearCollection);
    if (value !== null)
        return clearCollection(session, value, false);
    for (const command of [CMD.renameCollection, CMD.renameAlias]) {
        const args = parseCommandPair(plain, command);
        if (args)
            return renameEntry(session, args[0], args[1]);
    }
    const copyArgs = parseCommandPair(plain, CMD.copyCollection);
    if (copyArgs)
        return copyCollection(session, copyArgs[0], copyArgs[1]);
    const mergeArgs = parseCommandPair(plain, CMD.mergeCollection);
    if (mergeArgs)
        return mergeCollection(session, mergeArgs[0], mergeArgs[1]);
    const setCommands = [
        [CMD.intersectCollection, '交集'],
        [CMD.unionCollection, '并集'],
        [CMD.diffCollection, '差集'],
    ];
    for (const [command, type] of setCommands) {
        const args = parseCommandPair(plain, command);
        if (args)
            return collectionSet(session, args[0], args[1], type);
    }
    return null;
}
// 注册昵称与集合命令，并拦截已处理的消息。
function apply(ctx) {
    ctx.on('ready', async () => {
        try {
            await ensureStore();
            loadDisabledGroups(true);
            const storePath = USE_LEGACY_STORE ? LEGACY_DATA_FILE : SCOPE_DATA_DIR;
            ctx.logger('group-name-at').info(`group-name-at ${PLUGIN_VERSION} loaded: ${storePath}`);
        }
        catch (error) {
            ctx.logger('group-name-at').warn(error.message);
        }
    });
    ctx.command('nicklist', 'list aliases in current group').action(async ({ session }) => {
        if (isBlacklistedGroup(session))
            return;
        try {
            await safeSendText(ctx, session, await listEntries(session, 'alias'));
            return;
        }
        catch (error) {
            await safeSendText(ctx, session, handleStoreAccessError(ctx, error));
            return;
        }
    });
    ctx.middleware(async (session, next) => {
        try {
            const content = session.content || '';
            const nicknameBlacklistCommand = parseNicknameBlacklistCommand(content);
            if (nicknameBlacklistCommand) {
                await safeSendText(ctx, session, await handleNicknameBlacklistCommand(session, nicknameBlacklistCommand));
                return;
            }
            if (isBlacklistedGroup(session))
                return next();
            const bindAction = parseAliasBind(content);
            if (bindAction) {
                await safeSendText(ctx, session, await bindAlias(session, bindAction.alias, bindAction.targetUserId));
                return;
            }
            const deleteAction = parseAliasDelete(content, session);
            if (deleteAction) {
                await safeSendText(ctx, session, await removeAliasBinding(session, deleteAction.alias, deleteAction.targetUserId));
                return;
            }
            const commandResult = await handlePlainCommand(session, content);
            // 空回复仍表示命令已处理，不能转交后续中间件触发 AI 回复。
            if (commandResult !== null) {
                await safeSendText(ctx, session, commandResult);
                return;
            }
            const atRaw = parseAtAlias(content);
            if (atRaw) {
                const resolved = await resolveAtAlias(session, atRaw);
                if (resolved) {
                    const atMessage = await sendAliasMention(session, resolved.alias, resolved.tail);
                    if (atMessage) {
                        await safeSendText(ctx, session, atMessage);
                        return;
                    }
                }
                await safeSendText(ctx, session, TEXT.aliasNotFound(atRaw));
                return;
            }
            return next();
        }
        catch (error) {
            await safeSendText(ctx, session, handleStoreAccessError(ctx, error));
            return;
        }
    });
}
const _test = {
    DATA_FILE,
    LEGACY_DATA_FILE,
    SCOPE_DATA_DIR,
    USE_LEGACY_STORE,
    DISABLED_GROUPS_FILE,
    ADMIN_IDS_FILE,
    pendingConfirms,
    trimPendingConfirms,
    loadDisabledGroups,
    parseNicknameBlacklistCommand,
    handleNicknameBlacklistCommand,
    safeSendText,
};
module.exports = { name, apply, _test };
