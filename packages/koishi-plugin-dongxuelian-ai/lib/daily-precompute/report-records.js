"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.REPORT_INDEX_ROOT = void 0;
exports.getReportIndexFile = getReportIndexFile;
exports.appendReportRecord = appendReportRecord;
exports.scanReportIndex = scanReportIndex;
exports.readReportRecords = readReportRecords;
exports.cleanupReportRecords = cleanupReportRecords;
/** 日报原始记录：完整正文保存、大小保护、有界扫描与最新消息选择。 */
const fs = require("fs");
const path = require("path");
const crypto_1 = require("crypto");
const string_decoder_1 = require("string_decoder");
const constants = require("../core/constants");
const files = require("../resource-common/files");
const report_period_1 = require("./report-period");
const taskStore = require("../resource-workers/task-store");
const { DATA_DIR } = constants;
const { appendJsonlEvent, sanitizeId, writeJsonAtomic } = files;
const { listActiveDailyReportTasks } = taskStore;
exports.REPORT_INDEX_ROOT = path.join(DATA_DIR, 'daily-precompute', 'index');
// 读取有界工程参数，非法数值保持明确默认值。
function readByteLimit(name, defaultValue, max) {
    const value = Number(process.env[name] ?? defaultValue);
    return Number.isSafeInteger(value) && value >= 128 && value <= max ? value : defaultValue;
}
const MAX_BODY_BYTES = readByteLimit('DAILY_REPORT_MAX_SOURCE_BODY_BYTES', 64 * 1024, 1024 * 1024);
const MAX_INDEX_BYTES = readByteLimit('DAILY_REPORT_MAX_SOURCE_FILE_BYTES', 64 * 1024 * 1024, 1024 * 1024 * 1024);
const MAX_LOSS_BYTES = readByteLimit('DAILY_REPORT_MAX_SOURCE_LOSS_BYTES', 8 * 1024 * 1024, 64 * 1024 * 1024);
const MAX_LINE_BYTES = 2 * MAX_BODY_BYTES + 64 * 1024;
// --- 保存与完整性 ---
// 按既有安全标识规则定位自然日单群索引。
function getReportIndexFile(date, channelKey) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !channelKey)
        throw new Error('日报索引日期或群号无效');
    return path.join(exports.REPORT_INDEX_ROOT, date, `${sanitizeId(channelKey)}.jsonl`);
}
// 文件不存在时大小为零，其他磁盘错误必须向上报告。
function fileSize(file) {
    try {
        return fs.statSync(file).size;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return 0;
        throw error;
    }
}
// 旁路也满时记录确定的缺失范围，不保存正文、不假称收录成功。
function recordIntegrityLoss(file, timestamp) {
    const marker = `${file}.integrity.json`;
    let ranges = [];
    if (fs.existsSync(marker)) {
        const value = JSON.parse(fs.readFileSync(marker, 'utf8'));
        ranges = parseIntegrityRanges(value);
    }
    const current = ranges[0];
    const range = current
        ? { firstTimestamp: Math.min(current.firstTimestamp, timestamp), lastTimestamp: Math.max(current.lastTimestamp, timestamp), count: current.count + 1 }
        : { firstTimestamp: timestamp, lastTimestamp: timestamp, count: 1 };
    writeJsonAtomic(marker, [range]);
}
// 保存完整可用正文，超限时保存明确不完整记录供选入后判失败。
function appendReportRecord(date, channelKey, input) {
    if (!Number.isSafeInteger(input.timestamp) || input.timestamp <= 0)
        throw new Error('日报源记录时间戳无效');
    const text = String(input.text || '');
    const media = input.media || [];
    const bodyComplete = Buffer.byteLength(text, 'utf8') <= MAX_BODY_BYTES;
    const record = {
        recordVersion: 2,
        messageId: input.messageId || `generated-${(0, crypto_1.randomUUID)()}`,
        realMessageId: Boolean(input.messageId),
        timestamp: input.timestamp,
        userId: input.userId || '',
        userName: input.userName || '',
        text: bodyComplete ? text : '',
        media,
        bodyComplete,
        ...(bodyComplete ? {} : { incompleteReason: 'source_body_limit' }),
    };
    const file = getReportIndexFile(date, channelKey);
    // createdAt 前缀也占文件空间；同一主进程内检查与同步追加不能被清理插入。
    const lineBytes = Buffer.byteLength(JSON.stringify({ createdAt: new Date().toISOString(), ...record }) + '\n', 'utf8');
    if (lineBytes <= MAX_LINE_BYTES && fileSize(file) + lineBytes <= MAX_INDEX_BYTES) {
        appendJsonlEvent(file, record);
        return record;
    }
    const loss = { ...record, text: '', media: [], bodyComplete: false, incompleteReason: 'source_file_limit' };
    const lossFile = `${file}.losses.jsonl`;
    const lossBytes = Buffer.byteLength(JSON.stringify({ createdAt: new Date().toISOString(), ...loss }) + '\n', 'utf8');
    if (fileSize(lossFile) + lossBytes <= MAX_LOSS_BYTES)
        appendJsonlEvent(lossFile, loss);
    else
        recordIntegrityLoss(file, input.timestamp);
    return loss;
}
// --- 扫描与选择 ---
// 分块扫描固定文件快照，避免一次读入整个自然日文件或截取尾部行数。
function scanReportIndex(file, consume) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        throw error;
    }
    const decoder = new string_decoder_1.StringDecoder('utf8');
    const buffer = Buffer.alloc(64 * 1024);
    let pending = '';
    let lineNumber = 0;
    try {
        const snapshotBytes = fs.fstatSync(fd).size;
        let position = 0;
        while (position < snapshotBytes) {
            const bytes = fs.readSync(fd, buffer, 0, Math.min(buffer.length, snapshotBytes - position), position);
            if (bytes === 0)
                throw new Error('日报原始文件在读取期间被截短');
            position += bytes;
            pending += decoder.write(buffer.subarray(0, bytes));
            let newline;
            while ((newline = pending.indexOf('\n')) >= 0) {
                const line = pending.slice(0, newline).replace(/\r$/, '');
                pending = pending.slice(newline + 1);
                lineNumber += 1;
                if (line)
                    consume(parseReportRecord(line, lineNumber));
            }
            if (Buffer.byteLength(pending, 'utf8') > MAX_LINE_BYTES)
                throw new Error('日报原始记录行超过读取保护值');
        }
        pending += decoder.end();
        if (pending.trim())
            consume(parseReportRecord(pending, lineNumber + 1));
    }
    finally {
        fs.closeSync(fd);
    }
}
// 校验源码已知的旧记录与第二版记录，损坏内容不能被静默跳过。
function parseReportRecord(line, lineNumber) {
    let value;
    try {
        value = JSON.parse(line);
    }
    catch {
        throw new Error(`日报原始记录第${lineNumber}行无法解析`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`日报原始记录第${lineNumber}行结构无效`);
    const record = value;
    if (typeof record.messageId !== 'string' || typeof record.timestamp !== 'number' || !Number.isSafeInteger(record.timestamp) || record.timestamp <= 0 ||
        typeof record.text !== 'string' || typeof record.userId !== 'string' || typeof record.userName !== 'string' || !Array.isArray(record.media)) {
        throw new Error(`日报原始记录第${lineNumber}行必要字段无效`);
    }
    if (record.recordVersion !== undefined && (record.recordVersion !== 2 || typeof record.bodyComplete !== 'boolean' || typeof record.realMessageId !== 'boolean')) {
        throw new Error(`日报原始记录第${lineNumber}行版本或完整性无效`);
    }
    return record;
}
// 校验丢失范围的明确格式，损坏证据不能在维护或读取时静默丢弃。
function parseIntegrityRanges(value) {
    if (!Array.isArray(value))
        throw new Error('日报原始收录异常标记损坏');
    return value.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            throw new Error('日报原始收录异常范围无效');
        const range = item;
        if (!Number.isSafeInteger(range.firstTimestamp) || range.firstTimestamp <= 0 || !Number.isSafeInteger(range.lastTimestamp)
            || range.lastTimestamp < range.firstTimestamp || !Number.isSafeInteger(range.count) || range.count < 1)
            throw new Error('日报原始收录异常范围无效');
        return range;
    });
}
// 按时间和稳定来源顺序比较候选，用最小堆只保留最近入选记录。
function compareRecords(a, b) {
    return a.record.timestamp - b.record.timestamp || a.order - b.order;
}
// 更新有界最小堆；堆根始终是当前入选记录中最早的一条。
function retainLatest(heap, candidate, limit) {
    if (heap.length < limit) {
        heap.push(candidate);
        let index = heap.length - 1;
        while (index > 0) {
            const parent = Math.floor((index - 1) / 2);
            if (compareRecords(heap[parent], heap[index]) <= 0)
                break;
            [heap[parent], heap[index]] = [heap[index], heap[parent]];
            index = parent;
        }
        return;
    }
    if (compareRecords(candidate, heap[0]) <= 0)
        return;
    heap[0] = candidate;
    let index = 0;
    while (true) {
        const left = index * 2 + 1;
        if (left >= heap.length)
            break;
        const right = left + 1;
        const smallest = right < heap.length && compareRecords(heap[right], heap[left]) < 0 ? right : left;
        if (compareRecords(heap[index], heap[smallest]) <= 0)
            break;
        [heap[index], heap[smallest]] = [heap[smallest], heap[index]];
        index = smallest;
    }
}
// 完整统计固定窗口，同时只保留最新入选正文，真实消息 ID 重写只计一次。
function readReportRecords(channelKey, period, options = {}) {
    const maxMessages = options.maxMessages ?? 4000;
    if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 10000)
        throw new Error('日报分析消息上限无效');
    const expected = JSON.stringify({ reportPolicyVersion: period.reportPolicyVersion, reportDate: period.reportDate, periodStartMs: period.periodStartMs, periodEndMs: period.periodEndMs, cutoffMs: period.cutoffMs });
    if (expected !== JSON.stringify((0, report_period_1.createReportPeriod)(period.cutoffMs)))
        throw new Error('日报原始读取窗口无效');
    const seen = new Set();
    const heap = [];
    let windowMessageCount = 0;
    let order = 0;
    for (const date of (0, report_period_1.getReportIndexDates)(period)) {
        const file = getReportIndexFile(date, channelKey);
        const marker = `${file}.integrity.json`;
        if (fs.existsSync(marker)) {
            const ranges = parseIntegrityRanges(JSON.parse(fs.readFileSync(marker, 'utf8')));
            for (const value of ranges) {
                if (value.firstTimestamp <= period.cutoffMs && value.lastTimestamp >= period.periodStartMs)
                    throw new Error('日报原始索引与丢失记录均超限，本窗口收录不完整');
            }
        }
        for (const inputFile of [file, `${file}.losses.jsonl`]) {
            scanReportIndex(inputFile, record => {
                const sourceOrder = order++;
                if (!(0, report_period_1.isTimestampInReportPeriod)(record.timestamp, period))
                    return;
                // 旧版 msg-时间戳是已核实的生成标识，不能当作真实消息 ID 合并。
                const realId = record.recordVersion === 2 ? record.realMessageId : Boolean(record.messageId && !/^msg-\d+$/.test(record.messageId));
                if (realId && seen.has(record.messageId))
                    return;
                if (realId)
                    seen.add(record.messageId);
                windowMessageCount += 1;
                options.onRecord?.(record);
                retainLatest(heap, { record, order: sourceOrder }, maxMessages);
            });
        }
    }
    const records = heap.sort(compareRecords).map(({ record }, index) => ({ ...record, analysisId: index + 1 }));
    const sourceCompleteness = records.some(record => record.bodyComplete === false) ? 'incomplete'
        : records.some(record => record.recordVersion !== 2) ? 'legacy_unknown' : 'complete';
    return { records, windowMessageCount, selectedMessageCount: records.length, excludedByLimitCount: windowMessageCount - records.length, sourceCompleteness };
}
// --- 主进程维护与来源保护 ---
let cleanupCursor = '';
let cleanupRunning = false;
// 活动任务窗口必须全部可信；旧任务仅使用已保存创建时刻补齐。
function readProtectedReportPeriods() {
    return listActiveDailyReportTasks().map(task => {
        if (!task.channelKey)
            throw new Error('日报维护活动任务群号缺失，已停止清理');
        return { channelKey: sanitizeId(task.channelKey), period: (0, report_period_1.resolveReportPeriod)(task.payload, task.createdAt) };
    });
}
// 收集真实日期目录下的索引及旁路实体，不接受链接或越界文件名。
function listReportMaintenanceFiles() {
    if (!fs.existsSync(exports.REPORT_INDEX_ROOT))
        return [];
    const groups = new Set();
    for (const entry of fs.readdirSync(exports.REPORT_INDEX_ROOT, { withFileTypes: true })) {
        if (entry.isSymbolicLink())
            throw new Error('日报原始记录目录存在链接，已停止清理');
        if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name))
            continue;
        const date = new Date(`${entry.name}T00:00:00Z`);
        if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== entry.name)
            throw new Error('日报原始记录目录日期无效');
        const dir = path.join(exports.REPORT_INDEX_ROOT, entry.name);
        for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
            if (file.isSymbolicLink())
                throw new Error('日报原始记录文件存在链接，已停止清理');
            if (!file.isFile())
                continue;
            const base = file.name.endsWith('.jsonl.losses.jsonl') ? file.name.slice(0, -'.losses.jsonl'.length)
                : file.name.endsWith('.jsonl.integrity.json') ? file.name.slice(0, -'.integrity.json'.length) : file.name;
            if (!base.endsWith('.jsonl'))
                continue;
            const key = base.slice(0, -'.jsonl'.length);
            if (!key || sanitizeId(key) !== key)
                throw new Error('日报原始记录文件名无效');
            groups.add(path.join(dir, base));
        }
    }
    return Array.from(groups).sort();
}
// 同步验证并准备整组临时文件，替换期间没有await，主进程追加不能被旧快照覆盖。
function compactReportRecordGroup(file, protectedPeriods, now) {
    const channelKey = path.basename(file, '.jsonl');
    const periods = protectedPeriods.filter(item => item.channelKey === channelKey).map(item => item.period);
    const preserve = (timestamp) => (0, report_period_1.getReportRecordExpiryMs)(timestamp) > now || periods.some(period => (0, report_period_1.isTimestampInReportPeriod)(timestamp, period));
    const replacements = [];
    let removed = 0;
    let retained = 0;
    const marker = `${file}.integrity.json`;
    let ranges = null;
    let keptRanges = [];
    try {
        if (fs.existsSync(marker)) {
            if (fileSize(marker) > 1024 * 1024)
                throw new Error('日报原始收录异常标记超过维护保护值');
            ranges = parseIntegrityRanges(JSON.parse(fs.readFileSync(marker, 'utf8')));
            // 聚合范围不能反推每条缺失时间；只在整段到期且无交集时删除。
            keptRanges = ranges.filter(range => (0, report_period_1.getReportRecordExpiryMs)(range.lastTimestamp) > now || periods.some(period => range.firstTimestamp <= period.cutoffMs && range.lastTimestamp >= period.periodStartMs && range.firstTimestamp < period.periodEndMs));
        }
        for (const input of [file, `${file}.losses.jsonl`]) {
            if (!fs.existsSync(input))
                continue;
            const temp = `${input}.cleanup-${process.pid}-${(0, crypto_1.randomUUID)()}.tmp`;
            const replacement = { file: input, temp, retained: 0, changed: false };
            replacements.push(replacement);
            const fd = fs.openSync(temp, 'wx');
            try {
                scanReportIndex(input, record => {
                    if (preserve(record.timestamp)) {
                        fs.writeSync(fd, `${JSON.stringify(record)}\n`, undefined, 'utf8');
                        replacement.retained++;
                        retained++;
                    }
                    else {
                        replacement.changed = true;
                        removed++;
                    }
                });
            }
            finally {
                fs.closeSync(fd);
            }
        }
        for (const replacement of replacements) {
            if (replacement.changed) {
                if (replacement.retained)
                    fs.renameSync(replacement.temp, replacement.file);
                else
                    fs.unlinkSync(replacement.file);
            }
            if (fs.existsSync(replacement.temp))
                fs.unlinkSync(replacement.temp);
        }
        if (ranges && keptRanges.length !== ranges.length) {
            if (keptRanges.length)
                writeJsonAtomic(marker, keptRanges);
            else
                fs.unlinkSync(marker);
        }
        return { removed, retained, changed: replacements.some(item => item.changed) || Boolean(ranges && keptRanges.length !== ranges.length) };
    }
    finally {
        for (const replacement of replacements)
            if (fs.existsSync(replacement.temp))
                fs.unlinkSync(replacement.temp);
    }
}
// 原始范围改变后丢弃同自然日同群的派生统计，仍有来源时按现有统计职责重新计数。
function resetDerivedPrecomputeFiles(file) {
    // 延迟加载避免 precompute-index 的追加入口与原始记录模块形成初始化环。
    const status = require('./precompute-status');
    const index = require('./precompute-index');
    const date = path.basename(path.dirname(file));
    const channelKey = path.basename(file, '.jsonl');
    const targets = [
        path.join(status.SLOTS_ROOT, date, channelKey),
        index.getPrecomputeCoverageFile(date, channelKey),
        status.getDailyFinalInputFile(date, channelKey),
    ];
    for (const target of targets) {
        const relative = path.relative(path.resolve(status.PRECOMPUTE_ROOT), path.resolve(target));
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
            throw new Error('日报派生维护目标超出预计算目录');
        fs.rmSync(target, { recursive: true, force: true });
    }
    if (fileSize(file) > 0)
        index.updatePrecomputeCoverage(date, channelKey);
}
// 有界轮转维护过期来源；每组前重新读取全部活动窗口，组间让出主进程事件循环。
async function cleanupReportRecords(options = {}) {
    if (cleanupRunning)
        return { scanned: 0, removed: 0, retained: 0, changed: 0, skipped: true };
    const now = options.now ?? Date.now();
    const maxFiles = options.maxFiles ?? 32;
    if (!Number.isSafeInteger(now) || now <= 0 || !Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 128)
        throw new Error('日报维护时间或文件批次上限无效');
    cleanupRunning = true;
    const result = { scanned: 0, removed: 0, retained: 0, changed: 0, skipped: false };
    try {
        readProtectedReportPeriods();
        const files = listReportMaintenanceFiles();
        const afterCursor = files.filter(file => file > cleanupCursor);
        const ordered = [...afterCursor, ...files.filter(file => file <= cleanupCursor)].slice(0, maxFiles);
        for (const file of ordered) {
            const compacted = compactReportRecordGroup(file, readProtectedReportPeriods(), now);
            result.scanned++;
            result.removed += compacted.removed;
            result.retained += compacted.retained;
            if (compacted.changed) {
                resetDerivedPrecomputeFiles(file);
                result.changed++;
            }
            cleanupCursor = file;
            await new Promise(resolve => setImmediate(resolve));
        }
        return result;
    }
    finally {
        cleanupRunning = false;
    }
}
