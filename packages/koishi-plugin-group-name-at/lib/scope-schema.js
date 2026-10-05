"use strict";
/**
 * MODULE: group-name-at bidirectional scope schema.
 * 职责: 维护群内用户与昵称/集合的双向索引，转换旧数据和第二版存储格式。
 * 边界: 不访问文件、不查询 QQ 资料、不发送消息。
 * 状态: 所有索引属于传入的群数据，无模块级缓存。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.STORE_VERSION = void 0;
exports.setAliasEntry = setAliasEntry;
exports.normalizeScopeStore = normalizeScopeStore;
exports.serializeScopeStore = serializeScopeStore;
exports.STORE_VERSION = 2;
// --- 双向关系更新 --- #
// 替换或删除一个昵称/集合，同时更新所有相关用户的反向索引。
function setAliasEntry(store, alias, entry) {
    for (const member of store.aliases[alias]?.members || []) {
        const names = store.users[member.userId].filter(name => name !== alias);
        if (names.length)
            store.users[member.userId] = names;
        else
            delete store.users[member.userId];
    }
    if (!entry) {
        delete store.aliases[alias];
        return;
    }
    store.aliases[alias] = entry;
    for (const member of entry.members) {
        const names = store.users[member.userId] || (store.users[member.userId] = []);
        if (!names.includes(alias))
            names.push(alias);
    }
}
// --- 版本转换 --- #
// 加载旧群数据或双向格式；只在首次加载时建立并校验索引。
function normalizeScopeStore(scopeId, data) {
    const source = (data || {});
    if (source.version && source.version !== 1 && source.version !== exports.STORE_VERSION) {
        throw new Error(`unsupported nickname store version: ${source.version}`);
    }
    const store = {
        version: exports.STORE_VERSION,
        scopeId: String(source.scopeId || scopeId || 'global'),
        users: Object.create(null),
        aliases: Object.create(null),
        updatedAt: source.updatedAt || '',
    };
    for (const [alias, value] of Object.entries(source.aliases || {})) {
        let members;
        if (source.version === exports.STORE_VERSION) {
            if (!Array.isArray(value) || !value.every(userId => typeof userId === 'string')) {
                throw new Error(`invalid nickname user list: ${alias}`);
            }
            const details = source.memberDetails?.[alias] || {};
            members = value.map(userId => ({ ...details[userId], userId }));
        }
        else {
            members = Array.isArray(value.members) ? value.members : [];
        }
        setAliasEntry(store, alias, { members });
    }
    if (source.version === exports.STORE_VERSION) {
        const users = source.users;
        // 两个方向必须描述同一组关系，不能把损坏的反向表当作空查询结果。
        if (!users || Object.keys(users).length !== Object.keys(store.users).length) {
            throw new Error('nickname user index does not match aliases');
        }
        for (const [userId, names] of Object.entries(users)) {
            const expected = store.users[userId];
            if (!Array.isArray(names) || !expected || names.length !== expected.length ||
                new Set(names).size !== names.length || names.some(name => !expected.includes(name))) {
                throw new Error(`nickname user index does not match aliases: ${userId}`);
            }
            store.users[userId] = [...names];
        }
    }
    return store;
}
// 将两个方向及原有绑定元信息编码到同一份 JSON，供持久化原子写入。
function serializeScopeStore(store) {
    const aliases = Object.create(null);
    const memberDetails = Object.create(null);
    for (const [alias, entry] of Object.entries(store.aliases)) {
        aliases[alias] = entry.members.map(member => member.userId);
        memberDetails[alias] = Object.create(null);
        for (const { userId, ...details } of entry.members)
            memberDetails[alias][userId] = details;
    }
    return { version: exports.STORE_VERSION, scopeId: store.scopeId, users: store.users, aliases, memberDetails, updatedAt: store.updatedAt };
}
