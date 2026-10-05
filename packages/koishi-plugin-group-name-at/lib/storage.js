"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StoreAccessError = exports.DATA_FILE = exports.USE_LEGACY_STORE = exports.SCOPE_DATA_DIR = exports.LEGACY_DATA_FILE = exports.setAliasEntry = void 0;
exports.createStoreAccessError = createStoreAccessError;
exports.safeScopeFileName = safeScopeFileName;
exports.ensureStore = ensureStore;
exports.loadScopeStore = loadScopeStore;
exports.persistScopeStore = persistScopeStore;
/**
 * MODULE: group-name-at scoped persistence.
 * 职责: 管理双向群数据的分片存储、版本迁移与同 scope 串行原子写入。
 * 边界: 不处理命令、权限、成员查询或消息发送。
 */
const fs = require('fs/promises');
const path = require('path');
const { constants } = require('fs');
const scope_schema_1 = require("./scope-schema");
var scope_schema_2 = require("./scope-schema");
Object.defineProperty(exports, "setAliasEntry", { enumerable: true, get: function () { return scope_schema_2.setAliasEntry; } });
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
const STORE_READ_FAILED = '昵称数据读取失败，请检查文件格式或权限。';
const STORE_SAVE_FAILED = '昵称数据保存失败，请检查文件权限。';
let legacyNicknameStore = { scopes: {} };
let legacyStoreLoaded = false;
let legacyStoreLoadError = null;
let legacyStoreLoadTask = null;
let legacyStoreNeedsMigration = false;
const scopeStoreCache = new Map();
const scopeLoadTasks = new Map();
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
    // 不同群的首次请求也共享总表加载，不能在其他群已更新后再用旧文件重置总表。
    if (!legacyStoreLoadTask) {
        legacyStoreLoadTask = (async () => {
            try {
                const parsed = await readJsonFileIfSmall(exports.LEGACY_DATA_FILE, null);
                if (parsed && typeof parsed === 'object')
                    legacyNicknameStore = parsed;
                if (!legacyNicknameStore.scopes || typeof legacyNicknameStore.scopes !== 'object')
                    legacyNicknameStore = { scopes: {} };
                legacyStoreNeedsMigration = Object.values(legacyNicknameStore.scopes).some(scope => scope.version !== scope_schema_1.STORE_VERSION);
            }
            catch (error) {
                legacyStoreLoadError = error;
                throw createStoreAccessError(STORE_READ_FAILED, error);
            }
            finally {
                legacyStoreLoaded = true;
            }
        })();
    }
    await legacyStoreLoadTask;
}
// 从旧总表读取当前 scope，作为新目录模式的懒迁移来源。
async function readLegacyScopeStore(scopeId) {
    await ensureLegacyStore();
    const legacyScope = legacyNicknameStore.scopes[String(scopeId)];
    if (!legacyScope || typeof legacyScope !== 'object')
        return null;
    return legacyScope;
}
// 首次升级前保留旧文件，不覆盖已有备份或更改原始内容。
async function backupLegacyFile(filePath) {
    try {
        await fs.copyFile(filePath, `${filePath}.v1.bak`, constants.COPYFILE_EXCL);
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
    }
}
// 为旧版单文件模式排队写入，兼容显式 GROUP_NAME_AT_DATA_FILE 部署。
async function saveLegacyStore() {
    const task = legacySaveChain.catch(() => { }).then(async () => {
        await fs.mkdir(path.dirname(exports.LEGACY_DATA_FILE), { recursive: true });
        if (legacyStoreNeedsMigration)
            await backupLegacyFile(exports.LEGACY_DATA_FILE);
        const scopes = Object.fromEntries(Object.entries(legacyNicknameStore.scopes).map(([scopeId, scope]) => [
            scopeId, (0, scope_schema_1.serializeScopeStore)(scopeStoreCache.get(scopeId) || (0, scope_schema_1.normalizeScopeStore)(scopeId, scope)),
        ]));
        const tmp = `${exports.LEGACY_DATA_FILE}.tmp-${process.pid}-${Date.now()}`;
        await fs.writeFile(tmp, JSON.stringify({ scopes }, null, 2), 'utf8');
        await fs.rename(tmp, exports.LEGACY_DATA_FILE);
        legacyStoreNeedsMigration = false;
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
        scopeStore.updatedAt = new Date().toISOString();
        await fs.writeFile(tmp, JSON.stringify((0, scope_schema_1.serializeScopeStore)(scopeStore), null, 2), 'utf8');
        await fs.rename(tmp, file);
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
    if (scopeStoreCache.has(scopeId))
        return scopeStoreCache.get(scopeId);
    if (scopeLoadTasks.has(scopeId))
        return scopeLoadTasks.get(scopeId);
    // 并发首次访问共享同一份加载结果，避免各自创建独立对象后互相覆盖。
    const task = (async () => {
        try {
            if (exports.USE_LEGACY_STORE) {
                await ensureLegacyStore();
                const store = (0, scope_schema_1.normalizeScopeStore)(scopeId, legacyNicknameStore.scopes[scopeId]);
                legacyNicknameStore.scopes[scopeId] = store;
                scopeStoreCache.set(scopeId, store);
                if (legacyStoreNeedsMigration)
                    await saveLegacyStore();
                return store;
            }
            const filePath = getScopeFilePath(scopeId);
            const scoped = await readJsonFileIfSmall(filePath, null);
            const source = scoped || await readLegacyScopeStore(scopeId);
            const normalized = (0, scope_schema_1.normalizeScopeStore)(scopeId, source);
            if (source && (!scoped || source.version !== scope_schema_1.STORE_VERSION)) {
                if (scoped)
                    await backupLegacyFile(filePath);
                await writeScopeStore(scopeId, normalized);
            }
            scopeStoreCache.set(scopeId, normalized);
            return normalized;
        }
        catch (error) {
            scopeStoreCache.delete(scopeId);
            throw createStoreAccessError(STORE_READ_FAILED, error);
        }
    })();
    scopeLoadTasks.set(scopeId, task);
    try {
        return await task;
    }
    finally {
        scopeLoadTasks.delete(scopeId);
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
