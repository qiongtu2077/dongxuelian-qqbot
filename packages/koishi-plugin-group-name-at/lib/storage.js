"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StoreAccessError = exports.DATA_FILE = exports.USE_LEGACY_STORE = exports.SCOPE_DATA_DIR = exports.LEGACY_DATA_FILE = void 0;
exports.createStoreAccessError = createStoreAccessError;
exports.safeScopeFileName = safeScopeFileName;
exports.ensureStore = ensureStore;
exports.loadScopeStore = loadScopeStore;
exports.persistScopeStore = persistScopeStore;
/**
 * MODULE: group-name-at scoped persistence.
 * 职责: 管理按群分片存储、旧单文件懒迁移与同 scope 串行原子写入。
 * 边界: 不处理命令、权限、成员查询或消息发送。
 */
const fs = require('fs/promises');
const path = require('path');
// 解析插件运行时数据目录，保持与主插件数据目录约定一致。
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
exports.LEGACY_DATA_FILE = process.env.GROUP_NAME_AT_DATA_FILE || path.join(DEFAULT_DATA_DIR, 'nickname-collections.json');
exports.SCOPE_DATA_DIR = path.resolve(process.env.GROUP_NAME_AT_DATA_DIR || path.join(DEFAULT_DATA_DIR, 'nickname-collections'));
exports.USE_LEGACY_STORE = !!String(process.env.GROUP_NAME_AT_DATA_FILE || '').trim();
exports.DATA_FILE = exports.LEGACY_DATA_FILE;
const MAX_STORE_FILE_BYTES = 2 * 1024 * 1024;
const STORE_VERSION = 1;
const STORE_READ_FAILED = '昵称数据读取失败，请检查文件格式或权限。';
const STORE_SAVE_FAILED = '昵称数据保存失败，请检查文件权限。';
let legacyNicknameStore = { scopes: {} };
let legacyStoreLoaded = false;
let legacyStoreLoadError = null;
const scopeStoreCache = new Map();
let legacySaveChain = Promise.resolve();
const scopeSaveChains = new Map();
class StoreAccessError extends Error {
    // 保存用户提示与底层错误，供主插件统一记录和展示。
    constructor(userMessage, cause) {
        const source = cause;
        super(source && source.message ? source.message : String(cause || userMessage));
        this.name = 'StoreAccessError';
        this.code = 'GROUP_NAME_AT_STORE_ACCESS';
        this.userMessage = userMessage;
        this.cause = cause;
    }
}
exports.StoreAccessError = StoreAccessError;
// 将底层读写异常转换成稳定的插件存储错误。
function createStoreAccessError(userMessage, cause) {
    return new StoreAccessError(userMessage, cause);
}
// 将群号或频道号转换成安全文件名，避免运行时 ID 影响目录边界。
function safeScopeFileName(scopeId = '') {
    return encodeURIComponent(String(scopeId || 'global'))
        .replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}
// 返回当前 scope 的新格式存储文件路径。
function getScopeFilePath(scopeId = '') {
    return path.join(exports.SCOPE_DATA_DIR, `${safeScopeFileName(scopeId)}.json`);
}
// 将读取到的 scope 数据规整成插件内部稳定结构。
function normalizeScopeStore(scopeId, data) {
    const source = (data && typeof data === 'object' ? data : {});
    const aliases = source.aliases && typeof source.aliases === 'object' ? source.aliases : {};
    return {
        version: Number(source.version || STORE_VERSION),
        scopeId: String(source.scopeId || scopeId || 'global'),
        aliases,
        updatedAt: source.updatedAt || '',
    };
}
// 按大小上限读取 JSON，避免异常大文件拖垮插件进程。
async function readJsonFileIfSmall(filePath, fallback) {
    try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile() || stat.size > MAX_STORE_FILE_BYTES)
            throw new Error('store file too large');
        return JSON.parse(await fs.readFile(filePath, 'utf8'));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return fallback;
        throw error;
    }
}
// 加载旧版单文件总表；显式配置旧变量时继续作为主存储使用。
async function ensureLegacyStore() {
    if (legacyStoreLoaded) {
        if (legacyStoreLoadError)
            throw createStoreAccessError(STORE_READ_FAILED, legacyStoreLoadError);
        return;
    }
    try {
        const parsed = await readJsonFileIfSmall(exports.LEGACY_DATA_FILE, null);
        if (parsed && typeof parsed === 'object')
            legacyNicknameStore = parsed;
    }
    catch (error) {
        legacyStoreLoadError = error;
        legacyStoreLoaded = true;
        throw createStoreAccessError(STORE_READ_FAILED, error);
    }
    if (!legacyNicknameStore.scopes || typeof legacyNicknameStore.scopes !== 'object')
        legacyNicknameStore = { scopes: {} };
    legacyStoreLoaded = true;
}
// 从旧总表读取当前 scope，作为新目录模式的懒迁移来源。
async function readLegacyScopeStore(scopeId) {
    await ensureLegacyStore();
    const legacyScope = legacyNicknameStore.scopes[String(scopeId)];
    if (!legacyScope || typeof legacyScope !== 'object')
        return null;
    return normalizeScopeStore(scopeId, legacyScope);
}
// 为旧版单文件模式排队写入，兼容显式 GROUP_NAME_AT_DATA_FILE 部署。
async function saveLegacyStore() {
    const task = legacySaveChain.catch(() => { }).then(async () => {
        await fs.mkdir(path.dirname(exports.LEGACY_DATA_FILE), { recursive: true });
        const tmp = `${exports.LEGACY_DATA_FILE}.tmp-${process.pid}-${Date.now()}`;
        await fs.writeFile(tmp, JSON.stringify(legacyNicknameStore, null, 2), 'utf8');
        await fs.rename(tmp, exports.LEGACY_DATA_FILE);
    });
    legacySaveChain = task.catch(() => { });
    try {
        await task;
    }
    catch (error) {
        throw createStoreAccessError(STORE_SAVE_FAILED, error);
    }
}
// 为单个 scope 排队写入，确保同群并发更新不会互相覆盖。
async function enqueueScopeSave(scopeId, taskFn) {
    const queueKey = safeScopeFileName(scopeId);
    const previous = scopeSaveChains.get(queueKey) || Promise.resolve();
    const task = previous.catch(() => { }).then(taskFn);
    const cleanup = task.catch(() => { });
    scopeSaveChains.set(queueKey, cleanup);
    try {
        return await task;
    }
    finally {
        if (scopeSaveChains.get(queueKey) === cleanup)
            scopeSaveChains.delete(queueKey);
    }
}
// 保存指定 scope 到新目录文件，使用临时文件加 rename 原子替换。
async function writeScopeStore(scopeId, scopeStore) {
    await enqueueScopeSave(scopeId, async () => {
        await fs.mkdir(exports.SCOPE_DATA_DIR, { recursive: true });
        const file = getScopeFilePath(scopeId);
        const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
        const data = normalizeScopeStore(scopeId, scopeStore);
        data.updatedAt = new Date().toISOString();
        await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
        await fs.rename(tmp, file);
        scopeStoreCache.set(String(scopeId), data);
    });
}
// 初始化当前存储模式；新目录模式只准备目录，不一次性加载所有群。
async function ensureStore() {
    if (exports.USE_LEGACY_STORE) {
        await ensureLegacyStore();
        return;
    }
    try {
        await fs.mkdir(exports.SCOPE_DATA_DIR, { recursive: true });
    }
    catch (error) {
        throw createStoreAccessError(STORE_READ_FAILED, error);
    }
}
// 按 scope 加载昵称集合；新目录缺失时从旧总表懒迁移。
async function loadScopeStore(scopeIdInput) {
    const scopeId = String(scopeIdInput || 'global');
    if (exports.USE_LEGACY_STORE) {
        await ensureLegacyStore();
        if (!legacyNicknameStore.scopes[scopeId])
            legacyNicknameStore.scopes[scopeId] = { aliases: {} };
        if (!legacyNicknameStore.scopes[scopeId].aliases)
            legacyNicknameStore.scopes[scopeId].aliases = {};
        return legacyNicknameStore.scopes[scopeId];
    }
    if (scopeStoreCache.has(scopeId))
        return scopeStoreCache.get(scopeId);
    try {
        let scopeStore = await readJsonFileIfSmall(getScopeFilePath(scopeId), null);
        if (!scopeStore) {
            scopeStore = await readLegacyScopeStore(scopeId);
            if (scopeStore)
                await writeScopeStore(scopeId, scopeStore);
        }
        const normalized = normalizeScopeStore(scopeId, scopeStore || { aliases: {} });
        scopeStoreCache.set(scopeId, normalized);
        return normalized;
    }
    catch (error) {
        throw createStoreAccessError(STORE_READ_FAILED, error);
    }
}
// 保存已加载的 scope；旧模式写总表，新模式只写当前群文件。
async function persistScopeStore(scopeIdInput) {
    if (exports.USE_LEGACY_STORE) {
        await saveLegacyStore();
        return;
    }
    const scopeId = String(scopeIdInput || 'global');
    await writeScopeStore(scopeId, await loadScopeStore(scopeId));
}
