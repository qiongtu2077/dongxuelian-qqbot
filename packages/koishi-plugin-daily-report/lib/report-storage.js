"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PagedReportStore = exports.ReportStoredDataError = void 0;
exports.projectReportUnitLocator = projectReportUnitLocator;
/**
 * MODULE: 日报第二版分页对象与可信提交。
 * 职责: 同群内容去重、末尾提交清单、活动保护及有界容量清理。
 * 边界: 不请求模型、不领取任务；调用方须持有现有资源独占租约。
 * 状态: 文件位于既有数据根；首版产物统一写入与计量，仍不迁移为缓存。
 */
const fs = require("fs");
const path = require("path");
const crypto_1 = require("crypto");
const { loadManagementModule } = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime');
const { DATA_DIR } = loadManagementModule('core.constants');
const { writeJsonAtomic } = loadManagementModule('resource.files');
const { listActiveDailyReportTasks } = loadManagementModule('resource.taskStore');
class ReportStorageWorkError extends Error {
    // 可选索引写入失败不能吞掉有效领取、取消、租约或原截止错误。
    constructor(reason) {
        super(reason instanceof Error ? reason.message : String(reason));
        this.reason = reason;
        this.name = 'ReportStorageWorkError';
    }
}
class ReportStoredDataError extends Error {
    // 仅标记明确的数据损坏；任务/租约/截止及写入失败不能伪装为可选缓存未命中。
    constructor(message) { super(message); this.name = 'ReportStoredDataError'; }
}
exports.ReportStoredDataError = ReportStoredDataError;
const STORAGE_ROOT = path.join(DATA_DIR, 'daily-analysis');
const PAGE_BYTES = 256 * 1024;
const FILE_BYTES = 512 * 1024;
const GROUP_BYTES = 64 * 1024 * 1024;
const TOTAL_BYTES = 256 * 1024 * 1024;
const FILE_COUNT = 20000;
const RETENTION = 7 * 24 * 60 * 60 * 1000;
const HASH = /^[a-f0-9]{64}$/;
const DOCUMENT_KINDS = ['snapshot', 'unit', 'catalog', 'ledger'];
// 定位只保留已知产物的小投影；完整绑定及模型尝试仍须从真实提交重读校验。
function projectReportUnitLocator(metadata) {
    const value = metadata;
    if (!value || !['classification-cache-1', 'classification-cache-2', 'stage-cache-1'].includes(value.version || '')
        || !HASH.test(value.requestIdentity || '') || !HASH.test(value.policyIdentity || '') || !Array.isArray(value.actualAttempts))
        return null;
    const route = value.actualAttempts[value.actualAttempts.length - 1]?.execution?.routeIdentity;
    if (!route || !HASH.test(route))
        return null;
    return { version: value.version, requestIdentity: value.requestIdentity, policyIdentity: value.policyIdentity, lastRouteIdentity: route };
}
// --- 明确序列化、读取及分页 ---
// 只接受JSON值，固定对象键顺序；原文字符串和数组顺序逐字保持。
function storageCanonical(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return value;
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (Array.isArray(value))
        return value.map(storageCanonical);
    if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
        throw new Error('日报存储只接受明确JSON值');
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, storageCanonical(value[key])]));
}
// 摘要使用固定JSON对象顺序，不规范化正文或人物标识。
function storageHash(value) {
    return (0, crypto_1.createHash)('sha256').update(JSON.stringify(storageCanonical(value))).digest('hex');
}
// 使用既有原子工具的真实磁盘编码计算容量，而非模型字符数。
function storageBytes(value) {
    return Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8');
}
// 正文与描述页均属于末尾清单的不可变依赖，保护和清理必须采用同一集合。
function storageReferences(body) { return [...body.pages, ...(body.bodyObjects || [])]; }
// 控制文件名仅由明确类别和规范日期构造，不接受原始路径或模型输出。
function preanalysisControlName(key) {
    if (key.kind === 'anchor' && Object.keys(key).length === 1)
        return 'anchor.json';
    if (key.kind === 'day' && Object.keys(key).length === 2 && /^\d{4}-\d{2}-\d{2}$/.test(key.date))
        return 'day-' + key.date + '.json';
    throw new Error('后台总账控制键无效');
}
// 控制记录摘要同时约束文件职责与业务键；不把损坏记录当作未初始化。
function readPreanalysisControlFile(file, key) {
    const envelope = storageRead(file);
    if (envelope === null)
        return null;
    try {
        const body = envelope.body;
        if (!body || Object.keys(envelope).length !== 2 || Object.keys(body).length !== 6 || body.version !== 'preanalysis-control-1'
            || storageHash(body) !== envelope.digest || storageHash(body.key) !== storageHash(key)
            || !Number.isSafeInteger(body.createdAtMs) || !Number.isSafeInteger(body.updatedAtMs) || body.updatedAtMs < body.createdAtMs
            || (key.kind === 'anchor' ? body.retainUntilMs !== null : !Number.isSafeInteger(body.retainUntilMs) || body.retainUntilMs <= body.createdAtMs))
            throw new Error('无效控制记录');
        return { identity: envelope.digest, value: body.value, createdAtMs: body.createdAtMs, updatedAtMs: body.updatedAtMs, retainUntilMs: body.retainUntilMs };
    }
    catch {
        throw new ReportStoredDataError('后台总账控制记录损坏或职责不符');
    }
}
// 逻辑正文身份与页位置、人物、时间和任务编号分离，完整字符不归一化。
function snapshotTextIdentity(text) { return storageHash({ version: 1, type: 'snapshot-text', text }); }
// 核验整页及每条逻辑正文；页内额外正文可以共享，但不会自动加入本次来源。
function packedSnapshotTexts(page, id) {
    if (!page || Object.keys(page).length !== 3 || page.version !== 2 || page.type !== 'page' || !Array.isArray(page.records)
        || !page.records.length || storageBytes(page) > PAGE_BYTES || storageHash(page) !== id)
        throw new ReportStoredDataError('日报快照正文页缺失或损坏');
    const texts = new Map();
    for (const row of page.records) {
        const value = row;
        if (!value || Object.keys(value).length !== 3 || value.type !== 'snapshot-text' || typeof value.text !== 'string'
            || value.id !== snapshotTextIdentity(value.text) || texts.has(value.id))
            throw new ReportStoredDataError('日报快照页内正文身份无效');
        texts.set(value.id, value.text);
    }
    return texts;
}
// 仅文件不存在返回null；过大、非法JSON、软链接和读取错误准确失败。
function storageRead(file) {
    let stat;
    try {
        stat = fs.lstatSync(file);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > FILE_BYTES)
        throw new ReportStoredDataError('日报存储文件类型或大小无效');
    // 磁盘读取权限、设备或并发删除错误继续传播，只有已读正文的格式错误属于数据损坏。
    const content = fs.readFileSync(file, 'utf8');
    try {
        const value = JSON.parse(content);
        if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new Error('非法对象');
        return value;
    }
    catch {
        throw new ReportStoredDataError('日报存储文件损坏，不能作为合法空结果');
    }
}
// 对完整记录分页，单条超限直接失败，不截正文或暗中拆业务记录。
function storagePages(records) {
    const pages = [];
    let page = { version: 2, type: 'page', records: [] };
    const emptyBytes = storageBytes(page);
    let bytes = emptyBytes;
    for (const record of records) {
        const normalized = storageCanonical(record);
        const serialized = JSON.stringify(normalized, null, 2);
        // 记录在页内缩进四格；首条另有数组首尾换行，后续另有逗号和换行。
        // 逐条计量避免每加入一条就重新序列化整页，最终仍以真实写盘字节校验。
        const recordBytes = Buffer.byteLength(serialized, 'utf8') + serialized.split('\n').length * 4;
        const addition = recordBytes + (page.records.length ? 2 : 4);
        if (bytes + addition <= PAGE_BYTES) {
            page.records.push(normalized);
            bytes += addition;
            continue;
        }
        if (page.records.length)
            pages.push(page);
        page = { version: 2, type: 'page', records: [normalized] };
        bytes = emptyBytes + recordBytes + 4;
        if (bytes > PAGE_BYTES)
            throw new Error('日报完整记录超过分页上限，须先按来源片段契约组织');
    }
    if (page.records.length)
        pages.push(page);
    if (pages.some(value => storageBytes(value) > PAGE_BYTES))
        throw new Error('日报分页实际字节超过上限');
    return pages;
}
// 来源、批次和冗余顺序表不共页，单类坏页不会同时毁掉两份顺序证据。
function catalogSectionPages(records) {
    const sections = [[], [], []];
    let last = 0;
    for (const row of records) {
        const type = row?.type;
        const section = type === 'source' || type === 'part' ? 0 : type === 'batch' ? 1 : type === 'arrival' ? 2 : -1;
        if (section < last || section < 0)
            throw new Error('稳定目录分区记录类型或顺序无效');
        sections[section].push(row);
        last = section;
    }
    return sections.flatMap(storagePages);
}
// 完整逻辑记录先尝试整条落页，巨记录仅按规范JSON字符分块，不猜业务字段。
function encodeUnitRecordFragments(records) {
    const result = [];
    for (const [index, value] of records.entries()) {
        const whole = { type: 'whole-record', index, value };
        if (storageBytes({ version: 2, type: 'page', records: [whole] }) <= PAGE_BYTES) {
            result.push(whole);
            continue;
        }
        const text = Array.from(JSON.stringify(value)), parts = [];
        for (let offset = 0; offset < text.length; offset += 4096)
            parts.push(text.slice(offset, offset + 4096).join(''));
        result.push({ type: 'split-record', index, partCount: parts.length, digest: storageHash(value) });
        parts.forEach((text, part) => result.push({ type: 'record-part', recordIndex: index, part, text }));
    }
    return result;
}
// 全部连续片段与逻辑摘要核验后才交业务读取器，不能用半条巨记录做命中。
function decodeUnitRecordFragments(records) {
    const result = [];
    for (let cursor = 0; cursor < records.length;) {
        const row = records[cursor++];
        if (!row || row.index !== result.length)
            throw new ReportStoredDataError('缓存逻辑记录索引不连续');
        if (row.type === 'whole-record') {
            if (Object.keys(row).length !== 3 || !Object.prototype.hasOwnProperty.call(row, 'value'))
                throw new ReportStoredDataError('缓存完整记录字段无效');
            result.push(row.value);
            continue;
        }
        if (row.type !== 'split-record' || Object.keys(row).length !== 4 || !Number.isSafeInteger(row.partCount)
            || row.partCount < 1 || row.partCount > records.length - cursor || !HASH.test(row.digest))
            throw new ReportStoredDataError('缓存巨记录描述符无效');
        const texts = [];
        for (let part = 0; part < row.partCount; part++) {
            const fragment = records[cursor++];
            if (!fragment || Object.keys(fragment).length !== 4 || fragment.type !== 'record-part' || fragment.recordIndex !== row.index
                || fragment.part !== part || typeof fragment.text !== 'string' || !fragment.text || Array.from(fragment.text).length > 4096) {
                throw new ReportStoredDataError('缓存巨记录片段缺失、顺序或字段无效');
            }
            texts.push(fragment.text);
        }
        let value;
        try {
            value = JSON.parse(texts.join(''));
        }
        catch {
            throw new ReportStoredDataError('缓存巨记录JSON不完整');
        }
        if (storageHash(value) !== row.digest)
            throw new ReportStoredDataError('缓存巨记录逻辑摘要不一致');
        result.push(value);
    }
    return result;
}
// 扫描全部文件含临时文件；达到上限或无法完整读取时停止，不用截断列表估算容量。
function storageScan() {
    const files = [];
    if (!fs.existsSync(STORAGE_ROOT))
        return files;
    const visit = (dir) => {
        const stat = fs.lstatSync(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new Error('日报存储目录含非法链接');
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name);
            if (entry.isSymbolicLink())
                throw new Error('日报存储目录含非法链接');
            if (entry.isDirectory()) {
                visit(file);
                continue;
            }
            const value = fs.lstatSync(file);
            if (!value.isFile())
                throw new Error('日报存储存在无法计量的文件');
            const parts = path.relative(STORAGE_ROOT, file).split(path.sep);
            const group = ['v2', 'task-artifacts'].includes(parts[0]) && HASH.test(parts[1] || '') ? parts[1] : null;
            files.push({ file, group, bytes: value.size, modified: value.mtimeMs, parts });
            if (files.length >= FILE_COUNT)
                throw new Error('日报存储达到扫描保护上限，无法证明扫描完整');
        }
    };
    visit(STORAGE_ROOT);
    return files;
}
// 只把明确旧版路径/文件名作为可管理产物，未知目录仍计量且不猜生命周期。
function isTaskArtifactFile(entry) {
    return entry.parts[0] === 'task-artifacts' && entry.parts.length === 4 && HASH.test(entry.parts[1]) && HASH.test(entry.parts[2])
        && /^[a-f0-9]{64}\.(?:success|failure)\.json(?:\.\d+\.\d+\.tmp)?$/.test(entry.parts[3]);
}
// 已知旧版记录按首次创建到期；mtime或无法解析的旧文件不能伪装新的创建时刻。
function taskArtifactCreatedAt(entry) {
    if (!isTaskArtifactFile(entry) || !entry.file.endsWith('.json'))
        return null;
    let value;
    try {
        value = storageRead(entry.file);
    }
    catch (error) {
        if (!(error instanceof ReportStoredDataError))
            throw error;
        return null;
    }
    if (!value || value.version !== 1 || value.scope !== 'task' || value.crossTaskReusable !== false || typeof value.taskId !== 'string'
        || typeof value.channelKey !== 'string' || storageHash(value.channelKey) !== entry.parts[1] || storageHash(value.taskId) !== entry.parts[2]
        || typeof value.requestIdentity !== 'string' || !HASH.test(value.requestIdentity) || typeof value.success !== 'boolean'
        || path.basename(entry.file) !== value.requestIdentity + (value.success ? '.success.json' : '.failure.json')
        || !Number.isSafeInteger(value.createdAtMs) || value.createdAtMs < 0)
        return null;
    return value.createdAtMs;
}
// --- 不可变提交与任务保护 ---
class PagedReportStore {
    // 所有修改共用现有独占租约与原任务截止，不自行创建锁或续期任务。
    constructor(options) {
        this.options = options;
        if (!options.taskId || !options.channelKey || !Number.isFinite(options.deadlineMs))
            throw new Error('日报存储任务身份无效');
        this.options = Object.freeze({ ...options });
        this.taskIdentity = Object.freeze({ taskId: options.taskId, channelKey: options.channelKey, deadlineMs: options.deadlineMs });
        this.group = storageHash(options.channelKey);
        this.groupDir = path.join(STORAGE_ROOT, 'v2', this.group);
        this.pinFile = path.join(this.groupDir, 'tasks', storageHash(options.taskId) + '.json');
        this.now = options.now || Date.now;
    }
    // 在每次发布前检查有效领取、独占租约、原截止和取消。
    assertWritable() {
        try {
            this.options.assertLease();
            this.options.assertActive();
            if (this.now() >= this.options.deadlineMs)
                throw new Error('日报存储已超过原任务截止');
        }
        catch (error) {
            throw new ReportStorageWorkError(error);
        }
    }
    // 程序摘要构造对象位置；不接收原始路径或模型返回的文件名。
    objectFile(id) {
        if (!HASH.test(id))
            throw new Error('日报对象摘要无效');
        return path.join(this.groupDir, 'objects', id + '.json');
    }
    // 提交清单与正文对象隔离，只有末尾清单才证明整份对象已经发布。
    commitFile(id) {
        if (!HASH.test(id))
            throw new Error('日报提交摘要无效');
        return path.join(this.groupDir, 'commits', id + '.json');
    }
    // 读取并校验对应版本清单和摘要；缺失只表示未提交，损坏不会被当作命中。
    readCommit(id, groupDir = this.groupDir) {
        if (!HASH.test(id))
            throw new Error('日报提交摘要无效');
        const value = storageRead(path.join(groupDir, 'commits', id + '.json'));
        if (value === null)
            return null;
        const body = value.body;
        if (!body || body.version !== 2 || body.type !== 'commit' || value.digest !== id || storageHash(body) !== id
            || !DOCUMENT_KINDS.includes(body.kind) || body.group !== path.basename(groupDir) || !Number.isFinite(body.createdAtMs)
            || !Number.isSafeInteger(body.recordCount) || body.recordCount < 0 || !Array.isArray(body.pages)
            || !body.pages.every(page => typeof page === 'string' && HASH.test(page)))
            throw new ReportStoredDataError('日报提交清单校验失败');
        if (body.bodyEncoding === 'unit-record-fragments-1') {
            if (body.kind !== 'unit' || body.bodyObjects !== undefined)
                throw new ReportStoredDataError('缓存巨记录编码职责无效');
        }
        else if (body.bodyEncoding === 'catalog-sections-1') {
            if (body.kind !== 'catalog' || body.bodyObjects !== undefined
                || body.metadata?.recoveryVersion !== 'catalog-sections-1')
                throw new ReportStoredDataError('稳定目录分页编码无效');
        }
        else if ((body.bodyEncoding !== undefined || body.bodyObjects !== undefined) && (body.kind !== 'snapshot'
            || !['snapshot-fragment-text-1', 'snapshot-fragment-pages-1'].includes(body.bodyEncoding || '') || !Array.isArray(body.bodyObjects)
            || new Set(body.bodyObjects).size !== body.bodyObjects.length || !body.bodyObjects.every(id => typeof id === 'string' && HASH.test(id)))) {
            throw new ReportStoredDataError('日报正文依赖清单校验失败');
        }
        return value;
    }
    // 保护清单采用固定任务身份；完成标记不承担缓存真值，缺失时仍可从清单重新验证。
    nextPin(id) {
        const value = storageRead(this.pinFile);
        if (value && (value.version !== 2 || value.taskId !== this.options.taskId || value.deadlineMs !== this.options.deadlineMs
            || !Array.isArray(value.commits) || !value.commits.every(commit => typeof commit === 'string' && HASH.test(commit)))) {
            throw new Error('日报活动保护记录无效');
        }
        return { version: 2, taskId: this.options.taskId, deadlineMs: this.options.deadlineMs, commits: [...new Set([...(value?.commits || []), id])] };
    }
    // 发布已预留容量的文件；使用现有临时写入/同目录rename，不宣称断电事务。
    publish(file, value, assertGuard = () => this.assertWritable()) {
        assertGuard();
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        writeJsonAtomic(file, value);
        fs.chmodSync(file, 0o600);
    }
    // 只定位当前需要的正文；复用前验证保留快照及整页，不把全历史正文保存在内存。
    findSnapshotTextPages(wanted) {
        const found = new Map(), pages = new Set();
        if (!wanted.size)
            return found;
        for (const entry of storageScan()) {
            if (entry.parts[0] !== 'v2' || entry.group !== this.group || entry.parts[2] !== 'commits' || !entry.file.endsWith('.json'))
                continue;
            this.assertWritable();
            const id = path.basename(entry.file, '.json');
            if (!HASH.test(id))
                continue;
            try {
                const value = this.readCommit(id);
                if (value?.body.kind === 'snapshot' && value.body.bodyEncoding === 'snapshot-fragment-pages-1'
                    && this.now() - value.body.createdAtMs <= RETENTION)
                    value.body.bodyObjects.forEach(page => pages.add(page));
            }
            catch (error) {
                if (!(error instanceof ReportStoredDataError))
                    throw error;
            }
        }
        for (const id of [...pages].sort()) {
            this.assertWritable();
            let texts;
            try {
                texts = packedSnapshotTexts(storageRead(this.objectFile(id)), id);
            }
            catch (error) {
                if (!(error instanceof ReportStoredDataError))
                    throw error;
                continue;
            }
            for (const key of texts.keys())
                if (wanted.has(key) && !found.has(key))
                    found.set(key, id);
            if (found.size === wanted.size)
                break;
        }
        this.assertWritable();
        return found;
    }
    // 已验证来源描述只改变正文存储位置；旧格式独立正文，新格式复用既有页并仅分页新增正文。
    encodeSnapshotBodies(records, encoding) {
        const writes = new Map(), references = new Set();
        const wanted = new Map();
        if (encoding === 'snapshot-fragment-pages-1')
            for (const record of records) {
                const fragment = record;
                if (fragment.type === 'fragment') {
                    if (typeof fragment.text !== 'string')
                        throw new Error('日报正文片段缺少完整原文');
                    wanted.set(snapshotTextIdentity(fragment.text), fragment.text);
                }
            }
        const positions = this.findSnapshotTextPages(new Set(wanted.keys()));
        const missing = [...wanted].filter(([id]) => !positions.has(id)).sort(([a], [b]) => a.localeCompare(b)).map(([id, text]) => ({ type: 'snapshot-text', id, text }));
        for (const page of storagePages(missing)) {
            const id = storageHash(page);
            writes.set(id, page);
            for (const row of page.records)
                positions.set(row.id, id);
        }
        const encoded = records.map(record => {
            const value = record;
            if (value.type !== 'fragment')
                return record;
            if (typeof value.text !== 'string')
                throw new Error('日报正文片段缺少完整原文');
            const base = { type: value.type, sourceIdentity: value.sourceIdentity, part: value.part, permanentKey: value.permanentKey };
            if (encoding === 'snapshot-fragment-pages-1') {
                const bodyTextId = snapshotTextIdentity(value.text), bodyObjectId = positions.get(bodyTextId);
                references.add(bodyObjectId);
                return { ...base, bodyObjectId, bodyTextId };
            }
            const object = { version: 2, type: 'page', records: [{ type: 'snapshot-text', text: value.text }] };
            if (storageBytes(object) > PAGE_BYTES)
                throw new Error('日报完整正文片段超过对象上限');
            const bodyObjectId = storageHash(object);
            writes.set(bodyObjectId, object);
            references.add(bodyObjectId);
            return { ...base, bodyObjectId };
        });
        return { records: encoded, writes, references: [...references] };
    }
    // --- 容量预留与引用清理 ---
    // 扫描并保护活动任务与事务引用，先清清单再清孤立对象；旧版产物共同计量。
    reserve(writes, transactionFiles, assertGuard = () => this.assertWritable()) {
        assertGuard();
        const active = new Set([...listActiveDailyReportTasks().map(task => task.id), this.options.taskId]);
        const activeHashes = new Set([...active].map(task => storageHash(task)));
        let files = storageScan();
        const protectedFiles = new Set(transactionFiles);
        const commits = new Map();
        // 有活动保护而清单损坏时不能证明引用完整，停止清理与新增写入。
        for (const entry of files.filter(item => item.parts[0] === 'v2' && item.parts[2] === 'tasks' && item.file.endsWith('.json'))) {
            const taskHash = path.basename(entry.file, '.json');
            if (!activeHashes.has(taskHash))
                continue;
            const pin = storageRead(entry.file);
            if (!pin || pin.version !== 2 || storageHash(pin.taskId) !== taskHash || !Array.isArray(pin.commits))
                throw new Error('无法验证活动日报保护记录');
            protectedFiles.add(entry.file);
            const groupDir = path.dirname(path.dirname(entry.file));
            for (const id of pin.commits) {
                const manifest = this.readCommit(id, groupDir);
                if (!manifest)
                    throw new Error('活动日报提交清单缺失');
                protectedFiles.add(path.join(groupDir, 'commits', id + '.json'));
                storageReferences(manifest.body).forEach(page => protectedFiles.add(path.join(groupDir, 'objects', page + '.json')));
            }
        }
        for (const entry of files) {
            if (entry.parts[0] === 'task-artifacts' && activeHashes.has(entry.parts[2]))
                protectedFiles.add(entry.file);
            if (entry.parts[0] !== 'v2' || entry.parts[2] !== 'commits' || !entry.file.endsWith('.json'))
                continue;
            let value = null;
            try {
                value = this.readCommit(path.basename(entry.file, '.json'), path.dirname(path.dirname(entry.file)));
            }
            catch (error) {
                if (protectedFiles.has(entry.file) || !(error instanceof ReportStoredDataError))
                    throw error;
            }
            commits.set(entry.file, { entry, value });
        }
        // 临时峰值按完整新文件加一个最大临时文件预留，包含替换保护记录时的旧文件。
        const writeSizes = [...writes.values()].map(storageBytes);
        if (writeSizes.some(bytes => bytes > FILE_BYTES))
            throw new Error('日报提交文件超过单文件上限');
        const addition = writeSizes.reduce((sum, bytes) => sum + bytes, 0) + Math.max(0, ...writeSizes);
        const newCount = [...writes.keys()].filter(file => !fs.existsSync(file)).length + 1;
        let totalBytes = files.reduce((sum, entry) => sum + entry.bytes, 0);
        let groupBytes = files.filter(entry => entry.group === this.group).reduce((sum, entry) => sum + entry.bytes, 0);
        const fitsStorageReservation = () => files.length + newCount < FILE_COUNT
            && totalBytes + addition <= TOTAL_BYTES && groupBytes + addition <= GROUP_BYTES;
        const remove = (file) => {
            assertGuard();
            const entry = files.find(value => value.file === file);
            fs.unlinkSync(file);
            totalBytes -= entry.bytes;
            if (entry.group === this.group)
                groupBytes -= entry.bytes;
            files = files.filter(entry => entry.file !== file);
        };
        const sweepObjects = () => {
            const referenced = new Set(protectedFiles);
            for (const { entry, value } of commits.values())
                if (value) {
                    const groupDir = path.dirname(path.dirname(entry.file));
                    storageReferences(value.body).forEach(page => referenced.add(path.join(groupDir, 'objects', page + '.json')));
                }
            // 定位页只由校验过的索引根保留；可重建索引不承担活动产物真值。
            for (const entry of files.filter(item => item.parts[0] === 'v2' && item.parts[2] === 'locators' && path.basename(item.file) === 'unit-root.json')) {
                let locator = null;
                try {
                    locator = storageRead(entry.file);
                }
                catch (error) {
                    if (!(error instanceof ReportStoredDataError))
                        throw error;
                }
                if (!locator?.body || locator.body.version !== 'report-unit-locators-1' || locator.digest !== storageHash(locator.body)
                    || !Array.isArray(locator.body.pages) || !locator.body.pages.every(id => typeof id === 'string' && HASH.test(id))
                    || this.now() - locator.body.createdAtMs > RETENTION)
                    continue;
                referenced.add(entry.file);
                locator.body.pages.forEach(id => referenced.add(path.join(path.dirname(entry.file), id + '.json')));
            }
            for (const entry of [...files]) {
                if (referenced.has(entry.file) || entry.parts[0] !== 'v2')
                    continue;
                const commitTemporary = entry.parts[2] === 'commits' && /^[a-f0-9]{64}\.json\.\d+\.\d+\.tmp$/.test(path.basename(entry.file));
                const controlTemporary = entry.parts[1] === 'background-ledger' && entry.parts.length === 3
                    && /^(?:anchor|day-\d{4}-\d{2}-\d{2})\.json\.\d+\.\d+\.tmp$/.test(path.basename(entry.file));
                if (entry.parts[2] === 'objects' || entry.parts[2] === 'tasks' || entry.parts[2] === 'locators' || commitTemporary || controlTemporary)
                    remove(entry.file);
            }
        };
        const candidates = [...commits.values()].sort((a, b) => a.entry.modified - b.entry.modified);
        for (const candidate of candidates) {
            if (protectedFiles.has(candidate.entry.file))
                continue;
            if (candidate.value && this.now() - candidate.value.body.createdAtMs <= RETENTION)
                continue;
            remove(candidate.entry.file);
            commits.delete(candidate.entry.file);
        }
        for (const entry of [...files]) {
            if (isTaskArtifactFile(entry) && !protectedFiles.has(entry.file)) {
                const created = entry.file.endsWith('.json') ? taskArtifactCreatedAt(entry) : null;
                if (created !== null && this.now() - created > RETENTION || entry.file.endsWith('.tmp'))
                    remove(entry.file);
            }
            if (entry.parts[0] === 'v2' && entry.parts[1] === 'background-ledger' && entry.parts.length === 3
                && /^day-\d{4}-\d{2}-\d{2}\.json$/.test(path.basename(entry.file)) && !protectedFiles.has(entry.file)) {
                let control = null;
                try {
                    control = readPreanalysisControlFile(entry.file, { kind: 'day', date: path.basename(entry.file).slice(4, -5) });
                }
                catch (error) {
                    if (!(error instanceof ReportStoredDataError))
                        throw error;
                }
                // 损坏账本不猜创建时间或从零补建；只回收经过摘要验证且确已过期的日账。
                if (control?.retainUntilMs !== null && control?.retainUntilMs !== undefined && this.now() >= control.retainUntilMs)
                    remove(entry.file);
            }
        }
        sweepObjects();
        // 容量紧张时先丢可重建定位文件，不牺牲可信产物来保留加速索引。
        if (!fitsStorageReservation())
            for (const entry of [...files]) {
                if (entry.parts[0] === 'v2' && entry.parts[2] === 'locators' && !protectedFiles.has(entry.file))
                    remove(entry.file);
            }
        for (const candidate of candidates) {
            if (fitsStorageReservation())
                break;
            if (!commits.has(candidate.entry.file) || protectedFiles.has(candidate.entry.file))
                continue;
            remove(candidate.entry.file);
            commits.delete(candidate.entry.file);
            sweepObjects();
        }
        // 非活动旧版产物也可按最久未用回收；未知目录只计量，不能猜测其生命周期。
        for (const entry of [...files].sort((a, b) => a.modified - b.modified)) {
            if (fitsStorageReservation())
                break;
            if (isTaskArtifactFile(entry) && !protectedFiles.has(entry.file))
                remove(entry.file);
        }
        if (!fitsStorageReservation())
            throw new Error('日报存储容量不足，活动来源及提交过程不能清理');
    }
    // --- 对外可信文档接口 ---
    // 旧版产物也用统一预留；失败诊断仅放宽旧任务状态/时限，永不放宽原S0票据或成功标志。
    writeTaskArtifact(requestIdentity, success, value) {
        const assertArtifactGuard = () => {
            if (success)
                this.assertWritable();
            else {
                try {
                    this.options.assertLease();
                }
                catch (error) {
                    throw new ReportStorageWorkError(error);
                }
            }
        };
        assertArtifactGuard();
        if (!HASH.test(requestIdentity) || typeof success !== 'boolean' || value.version !== 1 || value.scope !== 'task'
            || value.taskId !== this.options.taskId || value.channelKey !== this.options.channelKey || value.deadlineMs !== this.options.deadlineMs
            || value.requestIdentity !== requestIdentity || value.success !== success || value.crossTaskReusable !== false
            || !Number.isSafeInteger(value.createdAtMs) || value.createdAtMs < 0 || value.createdAtMs > this.now() || !success && 'result' in value) {
            throw new Error('第一版产物必须保持原任务/截止与明确成功或诊断职责');
        }
        const file = path.join(STORAGE_ROOT, 'task-artifacts', this.group, storageHash(this.options.taskId), requestIdentity + (success ? '.success.json' : '.failure.json'));
        const previous = storageRead(file);
        if (previous && (previous.version !== 1 || previous.scope !== 'task' || previous.taskId !== value.taskId
            || previous.channelKey !== value.channelKey || previous.deadlineMs !== value.deadlineMs || previous.requestIdentity !== requestIdentity
            || previous.success !== success || previous.crossTaskReusable !== false || !Number.isSafeInteger(previous.createdAtMs)
            || previous.createdAtMs < 0 || previous.createdAtMs > this.now()))
            throw new Error('既有第一版产物身份或首次创建时刻不可验证');
        const artifact = { ...value, createdAtMs: previous?.createdAtMs ?? value.createdAtMs };
        const writes = new Map([[file, artifact]]);
        this.reserve(writes, new Set([file]), assertArtifactGuard);
        this.publish(file, artifact, assertArtifactGuard);
        assertArtifactGuard();
    }
    // 共享控制记录沿用当前任务时钟和原截止，不给后台另一套可延长的时间来源。
    currentTimeMs() { this.assertWritable(); return this.now(); }
    // 全局锚点与业务日账本不属于单群缓存，可读错误不能被当作未建账。
    readPreanalysisControl(key) {
        this.assertWritable();
        const value = readPreanalysisControlFile(path.join(STORAGE_ROOT, 'v2', 'background-ledger', preanalysisControlName(key)), key);
        this.assertWritable();
        return value?.retainUntilMs !== null && value?.retainUntilMs !== undefined && this.now() >= value.retainUntilMs ? null : value;
    }
    // 初次交付可检查是否已有已发布控制记录；运行时不能靠目录为空自动归零。
    listPreanalysisControlKeys() {
        this.assertWritable();
        const keys = [];
        for (const entry of storageScan()) {
            if (entry.parts[0] !== 'v2' || entry.parts[1] !== 'background-ledger' || !entry.file.endsWith('.json'))
                continue;
            const name = path.basename(entry.file);
            if (entry.parts.length !== 3)
                throw new ReportStoredDataError('后台总账目录职责不明');
            if (name === 'anchor.json')
                keys.push({ kind: 'anchor' });
            else if (/^day-\d{4}-\d{2}-\d{2}\.json$/.test(name))
                keys.push({ kind: 'day', date: name.slice(4, -5) });
            else
                throw new ReportStoredDataError('后台总账含未知已发布记录');
        }
        this.assertWritable();
        return keys;
    }
    // 独占租约下按旧身份核对后原子更新；文件与临时峰值共同计入现有容量。
    writePreanalysisControl(key, expectedIdentity, value) {
        this.assertWritable();
        if (expectedIdentity !== null && !HASH.test(expectedIdentity))
            throw new Error('后台总账旧身份无效');
        const previous = this.readPreanalysisControl(key), now = this.now();
        if ((previous?.identity || null) !== expectedIdentity)
            throw new Error('后台总账控制记录已改变，不能覆盖较新预留');
        if (previous && now < previous.updatedAtMs)
            throw new Error('后台总账时钟回拨，不能倒写控制记录');
        const retainUntilMs = key.kind === 'anchor' ? null : previous?.retainUntilMs ?? now + RETENTION;
        const body = { version: 'preanalysis-control-1', key: storageCanonical(key),
            value: storageCanonical(value), createdAtMs: previous?.createdAtMs ?? now, updatedAtMs: now, retainUntilMs };
        const file = path.join(STORAGE_ROOT, 'v2', 'background-ledger', preanalysisControlName(key)), identity = storageHash(body);
        const envelope = { digest: identity, body };
        this.reserve(new Map([[file, envelope]]), new Set([file]));
        this.publish(file, envelope);
        this.assertWritable();
        return { identity, value: body.value, createdAtMs: body.createdAtMs, updatedAtMs: now, retainUntilMs };
    }
    // 全部记录先校验，写齐不可变页后发布清单，再核对任务并写完成保护记录。
    commit(kind, metadata, records, validate, encoding) {
        this.assertWritable();
        if (!DOCUMENT_KINDS.includes(kind))
            throw new Error('日报存储文档类型无效');
        const normalized = storageCanonical(metadata), frozenRecords = records.map(storageCanonical);
        validate(normalized, frozenRecords);
        if (encoding === 'unit-record-fragments-1') {
            if (kind !== 'unit')
                throw new Error('巨记录编码仅用于明确缓存单元');
        }
        else if (encoding === 'catalog-sections-1') {
            if (kind !== 'catalog' || normalized.recoveryVersion !== encoding)
                throw new Error('目录编码仅用于明确分区目录契约');
        }
        else if (encoding !== undefined && (!['snapshot-fragment-text-1', 'snapshot-fragment-pages-1'].includes(encoding) || kind !== 'snapshot'
            || normalized.contract !== 'report-snapshot-2'))
            throw new Error('日报正文编码仅用于明确完整来源快照');
        const snapshotEncoding = encoding === 'snapshot-fragment-text-1' || encoding === 'snapshot-fragment-pages-1' ? encoding : undefined;
        const bodies = snapshotEncoding ? this.encodeSnapshotBodies(frozenRecords, snapshotEncoding) : { records: frozenRecords, writes: new Map(), references: [] };
        const encodedRecords = encoding === 'unit-record-fragments-1' ? encodeUnitRecordFragments(bodies.records) : bodies.records;
        const pages = encoding === 'catalog-sections-1' ? catalogSectionPages(encodedRecords) : storagePages(encodedRecords);
        const body = { version: 2, type: 'commit', kind, group: this.group, createdAtMs: this.now(),
            metadata: normalized, pages: pages.map(storageHash), recordCount: records.length,
            ...(encoding ? { bodyEncoding: encoding, ...(snapshotEncoding ? { bodyObjects: bodies.references } : {}) } : {}) };
        const id = storageHash(body), manifest = { digest: id, body };
        const writes = new Map();
        for (const page of [...bodies.writes.values(), ...pages]) {
            const pageId = storageHash(page), file = this.objectFile(pageId);
            let old;
            try {
                old = storageRead(file);
            }
            catch (error) {
                if (!(error instanceof ReportStoredDataError))
                    throw error;
                old = null;
            }
            // 只有当前已校验内容重新得到同一摘要，才允许原子修复损坏对象；不采信损坏正文。
            if (old === null || storageHash(old) !== pageId)
                writes.set(file, page);
        }
        writes.set(this.commitFile(id), manifest);
        writes.set(this.pinFile, this.nextPin(id));
        // 重用的页也须在清理期间保护，不能因当前还未写清单而当作孤立对象删除。
        const protectedFiles = new Set([this.commitFile(id), this.pinFile, ...storageReferences(body).map(page => this.objectFile(page))]);
        this.reserve(writes, protectedFiles);
        for (const [file, value] of writes)
            this.publish(file, value);
        this.assertWritable();
        return id;
    }
    // 有界扫描定位清单；索引只给候选，损坏ID明确返回，不能当作已验证产物。
    list(kind) {
        this.assertWritable();
        const candidates = [], invalidIds = [];
        for (const entry of storageScan()) {
            if (entry.parts[0] !== 'v2' || entry.group !== this.group || entry.parts[2] !== 'commits' || !entry.file.endsWith('.json'))
                continue;
            const id = path.basename(entry.file, '.json');
            if (!HASH.test(id)) {
                invalidIds.push(id);
                continue;
            }
            try {
                const value = this.readCommit(id);
                if (value && value.body.kind === kind && this.now() - value.body.createdAtMs <= RETENTION)
                    candidates.push({ id, createdAtMs: value.body.createdAtMs, metadata: value.body.metadata });
            }
            catch (error) {
                if (!(error instanceof ReportStoredDataError))
                    throw error;
                invalidIds.push(id);
            }
            this.assertWritable();
        }
        return { candidates, invalidIds };
    }
    // 版本化分页索引只加速候选定位；清单集合变化或索引损坏时从真实清单重建。
    listUnitLocators() {
        this.assertWritable();
        const inventory = storageScan().filter(entry => entry.parts[0] === 'v2' && entry.group === this.group
            && entry.parts[2] === 'commits' && entry.file.endsWith('.json')).sort((a, b) => a.file.localeCompare(b.file));
        // 清单不可变，索引不以命中更新的mtime作真值；采用时仍逐一核验完整清单与正文摘要。
        const generation = storageHash(inventory.map(entry => [path.basename(entry.file), entry.bytes]));
        const locatorDir = path.join(this.groupDir, 'locators'), rootFile = path.join(locatorDir, 'unit-root.json');
        let candidates = [], invalidIds = [];
        try {
            const locator = storageRead(rootFile);
            const body = locator?.body;
            if (body?.version === 'report-unit-locators-1' && locator.digest === storageHash(body) && body.generation === generation
                && Object.keys(locator).length === 2 && Object.keys(body).length === 5
                && Number.isFinite(body.createdAtMs) && this.now() - body.createdAtMs <= RETENTION
                && Number.isSafeInteger(body.recordCount) && body.recordCount >= 0 && body.recordCount < FILE_COUNT
                && Array.isArray(body.pages) && body.pages.length <= body.recordCount && new Set(body.pages).size === body.pages.length
                && body.pages.every(id => typeof id === 'string' && HASH.test(id))) {
                let count = 0;
                const seen = new Set();
                for (const id of body.pages) {
                    const page = storageRead(path.join(locatorDir, id + '.json'));
                    if (!page || Object.keys(page).length !== 3 || page.version !== 2 || page.type !== 'page' || !Array.isArray(page.records)
                        || !page.records.length || storageHash(page) !== id || storageBytes(page) > PAGE_BYTES) {
                        throw new ReportStoredDataError('日报定位页损坏');
                    }
                    for (const row of page.records) {
                        const record = row;
                        if (record?.type === 'invalid' && Object.keys(record).length === 2 && typeof record.id === 'string' && record.id.length <= 100)
                            invalidIds.push(record.id);
                        else if (record?.type === 'candidate' && Object.keys(record).length === 2 && record.value && Object.keys(record.value).length === 3
                            && HASH.test(record.value.id) && Number.isFinite(record.value.createdAtMs)
                            && record.value.metadata && ['classification-cache-1', 'classification-cache-2', 'stage-cache-1'].includes(record.value.metadata.version)
                            && [record.value.metadata.requestIdentity, record.value.metadata.policyIdentity, record.value.metadata.lastRouteIdentity].every(value => typeof value === 'string' && HASH.test(value))
                            && Object.keys(record.value.metadata).length === 4 && !seen.has(record.value.id)) {
                            seen.add(record.value.id);
                            if (this.now() - record.value.createdAtMs <= RETENTION)
                                candidates.push(record.value);
                        }
                        else
                            throw new ReportStoredDataError('日报定位记录损坏');
                        count++;
                    }
                    this.assertWritable();
                }
                if (count !== body.recordCount)
                    throw new ReportStoredDataError('日报定位记录数量不一致');
                this.assertWritable();
                return { candidates, invalidIds, publishable: true };
            }
        }
        catch (error) {
            if (!(error instanceof ReportStoredDataError))
                throw error;
        }
        candidates = [];
        invalidIds = [];
        for (const entry of inventory) {
            this.assertWritable();
            const id = path.basename(entry.file, '.json');
            if (!HASH.test(id)) {
                invalidIds.push(id.slice(0, 100));
                continue;
            }
            try {
                const value = this.readCommit(id);
                if (!value || value.body.kind !== 'unit' || this.now() - value.body.createdAtMs > RETENTION)
                    continue;
                const metadata = projectReportUnitLocator(value.body.metadata);
                if (metadata)
                    candidates.push({ id, createdAtMs: value.body.createdAtMs, metadata });
            }
            catch (error) {
                if (!(error instanceof ReportStoredDataError))
                    throw error;
                invalidIds.push(id);
            }
        }
        const rows = [...candidates.map(value => ({ type: 'candidate', value })), ...invalidIds.map(id => ({ type: 'invalid', id }))];
        const pages = storagePages(rows), body = { version: 'report-unit-locators-1', generation, createdAtMs: this.now(),
            pages: pages.map(storageHash), recordCount: rows.length };
        const writes = new Map(pages.map((page, index) => [path.join(locatorDir, body.pages[index] + '.json'), page]));
        writes.set(rootFile, { digest: storageHash(body), body });
        try {
            this.reserve(writes, new Set(writes.keys()));
            for (const [file, value] of writes)
                this.publish(file, value);
            this.assertWritable();
            return { candidates, invalidIds, publishable: true };
        }
        catch (error) {
            if (error instanceof ReportStorageWorkError)
                throw error;
            // 只有可重建索引的发布失败可降级；对应缓存随后禁止跨任务命中与发布。
            this.assertWritable();
            return { candidates, invalidIds, publishable: false };
        }
    }
    // 仅目录恢复可逐页读取：坏页明确为空标记，不能作为完整产物或模型缓存命中。
    inspectCatalogPages(id) {
        this.assertWritable();
        const manifest = this.readCommit(id);
        if (!manifest)
            return null;
        const body = manifest.body;
        if (body.kind !== 'catalog' || body.bodyEncoding !== undefined && body.bodyEncoding !== 'catalog-sections-1')
            throw new ReportStoredDataError('局部页读取只支持明确稳定目录');
        if (this.now() - body.createdAtMs > RETENTION)
            return null;
        const pages = [];
        for (const [index, pageId] of body.pages.entries()) {
            this.assertWritable();
            let records = null;
            try {
                const page = storageRead(this.objectFile(pageId));
                if (page && Object.keys(page).length === 3 && page.version === 2 && page.type === 'page' && Array.isArray(page.records)
                    && storageBytes(page) <= PAGE_BYTES && storageHash(page) === pageId)
                    records = page.records;
            }
            catch (error) {
                if (!(error instanceof ReportStoredDataError))
                    throw error;
            }
            pages.push({ id: pageId, index, records });
        }
        if (pages.every(page => page.records !== null) && pages.reduce((count, page) => count + page.records.length, 0) !== body.recordCount) {
            throw new ReportStoredDataError('稳定目录完整页记录数与提交头不一致');
        }
        this.assertWritable();
        return { id, createdAtMs: body.createdAtMs, metadata: body.metadata, recordCount: body.recordCount, pages };
    }
    // 无发布地验证候选；读取结果尚未受活动保护，采用前必须再调用read。
    inspect(id, kind, validate) {
        this.assertWritable();
        const manifest = this.readCommit(id);
        if (!manifest)
            return null;
        const body = manifest.body;
        if (body.kind !== kind)
            throw new ReportStoredDataError('日报提交契约类型不匹配');
        if (this.now() - body.createdAtMs > RETENTION)
            return null;
        let records = [];
        for (const pageId of body.pages) {
            const page = storageRead(this.objectFile(pageId));
            if (!page || page.version !== 2 || page.type !== 'page' || !Array.isArray(page.records)
                || storageBytes(page) > PAGE_BYTES || storageHash(page) !== pageId)
                throw new ReportStoredDataError('日报提交引用对象缺失或损坏');
            records.push(...page.records);
        }
        if (body.bodyEncoding === 'unit-record-fragments-1')
            records = decodeUnitRecordFragments(records);
        if (records.length !== body.recordCount)
            throw new ReportStoredDataError('日报提交记录计数不完整');
        if (body.bodyEncoding === 'snapshot-fragment-pages-1') {
            const allowed = new Set(body.bodyObjects), pages = new Map();
            for (let index = 0; index < records.length; index++) {
                const fragment = records[index];
                if (fragment?.type !== 'fragment')
                    continue;
                if (Object.keys(fragment).length !== 6 || !allowed.has(fragment.bodyObjectId) || !HASH.test(fragment.bodyTextId || '')) {
                    throw new ReportStoredDataError('日报快照正文引用不属于末尾依赖清单');
                }
                if (!pages.has(fragment.bodyObjectId)) {
                    pages.set(fragment.bodyObjectId, packedSnapshotTexts(storageRead(this.objectFile(fragment.bodyObjectId)), fragment.bodyObjectId));
                }
                const text = pages.get(fragment.bodyObjectId).get(fragment.bodyTextId);
                if (text === undefined)
                    throw new ReportStoredDataError('日报快照页内缺少引用正文');
                records[index] = { type: fragment.type, sourceIdentity: fragment.sourceIdentity, part: fragment.part,
                    permanentKey: fragment.permanentKey, text };
            }
            if (pages.size !== allowed.size)
                throw new ReportStoredDataError('日报快照正文依赖没有完整对应来源');
        }
        if (body.bodyEncoding === 'snapshot-fragment-text-1') {
            const allowed = new Set(body.bodyObjects), texts = new Map();
            for (let index = 0; index < records.length; index++) {
                const fragment = records[index];
                if (fragment?.type !== 'fragment')
                    continue;
                if (Object.keys(fragment).length !== 5 || !allowed.has(fragment.bodyObjectId))
                    throw new ReportStoredDataError('日报快照正文引用不属于末尾依赖清单');
                if (!texts.has(fragment.bodyObjectId)) {
                    const page = storageRead(this.objectFile(fragment.bodyObjectId));
                    const value = page?.records?.[0];
                    if (!page || page.version !== 2 || page.type !== 'page' || !Array.isArray(page.records) || page.records.length !== 1
                        || storageBytes(page) > PAGE_BYTES || storageHash(page) !== fragment.bodyObjectId
                        || !value || Object.keys(value).length !== 2 || value.type !== 'snapshot-text' || typeof value.text !== 'string') {
                        throw new ReportStoredDataError('日报快照正文对象缺失或损坏');
                    }
                    texts.set(fragment.bodyObjectId, value.text);
                }
                records[index] = { type: fragment.type, sourceIdentity: fragment.sourceIdentity, part: fragment.part,
                    permanentKey: fragment.permanentKey, text: texts.get(fragment.bodyObjectId) };
            }
            if (texts.size !== allowed.size)
                throw new ReportStoredDataError('日报快照正文依赖没有完整对应来源');
        }
        try {
            validate(body.metadata, records);
        }
        catch (error) {
            throw new ReportStoredDataError(error instanceof Error ? error.message : String(error));
        }
        this.assertWritable();
        return { id, kind: body.kind, createdAtMs: body.createdAtMs, metadata: body.metadata, records };
    }
    // 候选通过全部校验后，在同租约内再次读取并保护来源，失败不能降级为可选未命中。
    read(id, kind, validate) {
        const document = this.inspect(id, kind, validate);
        if (!document)
            return null;
        const body = this.readCommit(id).body;
        const pin = this.nextPin(id);
        this.reserve(new Map([[this.pinFile, pin]]), new Set([this.pinFile, this.commitFile(id), ...storageReferences(body).map(page => this.objectFile(page))]));
        this.publish(this.pinFile, pin);
        this.assertWritable();
        // 命中只更新清理顺序；七天有效期始终使用清单的首次创建时间。
        const touched = this.now() / 1000;
        fs.utimesSync(this.commitFile(id), touched, touched);
        return document;
    }
}
exports.PagedReportStore = PagedReportStore;
