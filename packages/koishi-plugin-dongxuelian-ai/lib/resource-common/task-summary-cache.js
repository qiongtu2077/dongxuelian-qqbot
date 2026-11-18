"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.indexTaskFileAliases = indexTaskFileAliases;
exports.findDiagnosticTaskFiles = findDiagnosticTaskFiles;
exports.createTaskSummaryCache = createTaskSummaryCache;
/** 从有界任务目录异步读取必要字段，并在文件未变化时复用摘要。 */
const promises_1 = require("node:fs/promises");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const files = require("./files");
const { listJsonFiles, sanitizeId } = files;
const DIAGNOSTIC_DIRECTORY_LIMIT = 20000;
const READ_CONCURRENCY = 16;
// 按现有队列目录顺序收集普通任务文件，每个状态目录独立限制数量。
async function listTaskFiles(root) {
    const files = [];
    const rootStat = await (0, promises_1.lstat)(root.path).catch(() => null);
    if (!rootStat?.isDirectory())
        return files;
    // 只递归真实目录，保留持久任务的原始枚举顺序。
    const walk = async (directory) => {
        const entries = await (0, promises_1.readdir)(directory, { withFileTypes: true }).catch(() => []);
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            if (files.length >= DIAGNOSTIC_DIRECTORY_LIMIT)
                break;
            if (root.recursive && entry.isDirectory())
                await walk((0, node_path_1.join)(directory, entry.name));
            else if (entry.isFile() && entry.name.endsWith('.json'))
                files.push((0, node_path_1.join)(directory, entry.name));
        }
    };
    await walk(root.path);
    return files;
}
// 区分原地改写和同路径的原子替换，包含文件身份以及修改信息。
function fileFingerprint(stat) {
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}
// 保存旧任务中正文编号与文件名不同的已验证路径。
function indexTaskFileAliases(files) {
    const aliases = new Map();
    for (const { file, value } of files) {
        if ((0, node_path_1.basename)(file) === `${sanitizeId(value.id)}.json`)
            continue;
        const paths = aliases.get(value.id) ?? new Set();
        paths.add(file);
        aliases.set(value.id, paths);
    }
    return aliases;
}
// 限定详情为同编号候选，沿用列表的目录边界及枚举上限。
function findDiagnosticTaskFiles(root, target, aliases) {
    try {
        if (!(0, node_fs_1.lstatSync)(root.path, { throwIfNoEntry: false })?.isDirectory())
            return [];
        const hasAliases = aliases && [...aliases].some(file => file.startsWith(root.path + node_path_1.sep));
        if (!root.recursive && !hasAliases) {
            if (!(0, node_fs_1.lstatSync)(target, { throwIfNoEntry: false })?.isFile())
                return [];
            if ((0, node_fs_1.readdirSync)(root.path).length <= DIAGNOSTIC_DIRECTORY_LIMIT)
                return [target];
        }
        const name = (0, node_path_1.basename)(target);
        return listJsonFiles(root.path, { recursive: root.recursive, maxFiles: DIAGNOSTIC_DIRECTORY_LIMIT })
            .filter(file => (0, node_path_1.basename)(file) === name || aliases?.has(file));
    }
    catch {
        // 文件或状态目录可以在另一进程迁移期间消失。
        return [];
    }
}
// 创建共享刷新入口，完整刷新成功后才替换当前快照。
function createTaskSummaryCache(directories, maxBytes, summarize) {
    let cache = new Map();
    let summaries = [];
    let refreshing;
    // 读取变化文件并验证读取前后指纹，消失或替换中的文件下轮重查。
    async function inspect(file, directory) {
        const stat = await (0, promises_1.lstat)(file).catch(() => null);
        if (!stat?.isFile())
            return null;
        const fingerprint = fileFingerprint(stat);
        const previous = cache.get(file);
        if (previous?.fingerprint === fingerprint)
            return previous;
        if (stat.size > maxBytes)
            return { fingerprint, summary: null };
        const raw = await (0, promises_1.readFile)(file).catch(() => null);
        if (!raw || raw.length > maxBytes)
            return null;
        const after = await (0, promises_1.lstat)(file).catch(() => null);
        if (!after?.isFile() || fileFingerprint(after) !== fingerprint)
            return null;
        let record;
        try {
            record = JSON.parse(raw.toString('utf8'));
        }
        catch {
            return { fingerprint, summary: null };
        }
        const value = summarize(record);
        return { fingerprint, summary: value === null ? null : { file, directory, value } };
    }
    // 对文件属性和正文按固定并发度检查，结果仍保持目录枚举顺序。
    async function refresh() {
        const groups = await Promise.all(directories.map(async (directory) => (await listTaskFiles(directory)).map(file => ({ file, directory: directory.path }))));
        const files = groups.flat();
        const inspected = [];
        let cursor = 0;
        await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, files.length) }, async () => {
            while (cursor < files.length) {
                const index = cursor++;
                const { file, directory } = files[index];
                inspected[index] = await inspect(file, directory);
            }
        }));
        const nextCache = new Map();
        const next = [];
        for (let index = 0; index < files.length; index++) {
            const entry = inspected[index];
            if (!entry)
                continue;
            nextCache.set(files[index].file, entry);
            if (entry.summary)
                next.push(entry.summary);
        }
        cache = nextCache;
        if (summaries.length !== next.length || next.some((entry, index) => entry !== summaries[index]))
            summaries = next;
        return summaries;
    }
    // 并发请求合并为一次盘点，失败后允许下一次请求重试。
    return function readSummaries() {
        if (!refreshing)
            refreshing = refresh().finally(() => { refreshing = undefined; });
        return refreshing;
    };
}
