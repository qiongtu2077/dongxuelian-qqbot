"use strict";
/**
 * MODULE: 后台文件分析。
 * 职责: 异步下载文件 → 按类型解析提取文本 → 生成摘要 → 写回 file-store。
 * 边界: 全程静默，不发消息，不阻塞 chat/agent。
 * 状态: 内存并发队列。
 */
const fs = require('fs/promises');
const path = require('path');
const https = require('https');
const http = require('http');
const { getFileEntry, markFileAnalyzed, setLocalPath, FILE_CACHE_DIR } = require('./file-store');
const { getExtension, sanitizeFileName, TEXT_EXTENSIONS, wrapFileContent } = require('./file-safety');
const { safeChannelKey, validatePublicHttpUrl, resolveAndValidateHostname } = require('../../core/utils');
const MAX_CONCURRENT = 2;
const DOWNLOAD_TIMEOUT_MS = 30000;
const MAX_TEXT_CHARS = 3000;
const MAX_REDIRECTS = 5;
let activeCount = 0;
const queue = [];
const inFlight = new Map();
function getFileAnalyzerErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function taskKey(channelKey, messageId) {
    return `${String(channelKey || '')}::${String(messageId || '')}`;
}
async function enqueueFileAnalysis(channelKey, messageId) {
    if (!channelKey || !messageId)
        return;
    try {
        const entry = await getFileEntry(channelKey, messageId);
        if (!entry || entry.analyzed || entry.skipped)
            return;
        const key = taskKey(channelKey, messageId);
        if (inFlight.has(key) || queue.some(item => taskKey(item.channelKey, item.messageId) === key))
            return;
        if (queue.length >= 100)
            return;
        queue.push({ channelKey, messageId });
        drainQueue();
    }
    catch (error) {
        console.warn(`[file-analyzer] enqueue failed: ${getFileAnalyzerErrorMessage(error)}`);
    }
}
function drainQueue() {
    while (activeCount < MAX_CONCURRENT && queue.length > 0) {
        const task = queue.shift();
        if (!task)
            continue;
        activeCount++;
        const key = taskKey(task.channelKey, task.messageId);
        const promise = runAnalysis(task);
        inFlight.set(key, promise);
        promise.finally(() => {
            if (inFlight.get(key) === promise)
                inFlight.delete(key);
            activeCount--;
            drainQueue();
        });
    }
}
async function downloadFile(url, destPath, redirectCount = 0) {
    if (redirectCount > MAX_REDIRECTS)
        throw new Error('redirect 超过上限');
    const parsed = validatePublicHttpUrl(url);
    await resolveAndValidateHostname(parsed);
    return new Promise((resolve, reject) => {
        const mod = parsed.protocol === 'https:' ? https : http;
        const timer = setTimeout(() => reject(new Error('download timeout')), DOWNLOAD_TIMEOUT_MS);
        const req = mod.get(parsed, { timeout: DOWNLOAD_TIMEOUT_MS, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            const statusCode = res.statusCode || 0;
            if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
                clearTimeout(timer);
                try {
                    const location = Array.isArray(res.headers.location) ? res.headers.location[0] : res.headers.location;
                    const nextUrl = new URL(String(location || ''), parsed).toString();
                    resolve(downloadFile(nextUrl, destPath, redirectCount + 1));
                }
                catch (error) {
                    reject(error);
                }
                return;
            }
            if (statusCode !== 200) {
                clearTimeout(timer);
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }
            const chunks = [];
            let totalSize = 0;
            res.on('data', (chunk) => {
                totalSize += chunk.length;
                if (totalSize > 10 * 1024 * 1024) {
                    res.destroy();
                    clearTimeout(timer);
                    reject(new Error('file too large'));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', async () => {
                clearTimeout(timer);
                try {
                    const buffer = Buffer.concat(chunks);
                    await fs.mkdir(path.dirname(destPath), { recursive: true });
                    await fs.writeFile(destPath, buffer);
                    resolve(destPath);
                }
                catch (e) {
                    reject(e);
                }
            });
            res.on('error', (e) => { clearTimeout(timer); reject(e); });
        });
        req.on('error', (e) => { clearTimeout(timer); reject(e); });
        req.on('timeout', () => { req.destroy(); clearTimeout(timer); reject(new Error('timeout')); });
    });
}
async function parseText(filePath) {
    const content = await fs.readFile(filePath, 'utf8');
    return content.slice(0, MAX_TEXT_CHARS);
}
async function parsePdf(filePath) {
    const pdfParse = require('pdf-parse');
    const buffer = await fs.readFile(filePath);
    const result = await pdfParse(buffer);
    return (result.text || '').slice(0, MAX_TEXT_CHARS);
}
async function parseDocx(filePath) {
    const mammoth = require('mammoth');
    const buffer = await fs.readFile(filePath);
    const result = await mammoth.extractRawText({ buffer });
    return (result.value || '').slice(0, MAX_TEXT_CHARS);
}
async function parseXlsx(filePath) {
    const XLSX = require('xlsx');
    const buffer = await fs.readFile(filePath);
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName)
        return '[空表格]';
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet, { FS: '\t' });
    const lines = csv.split('\n').slice(0, 50);
    return lines.join('\n').slice(0, MAX_TEXT_CHARS);
}
async function parsePpt(filePath) {
    // pptx 本质是 zip，mammoth 不支持；简单提取需要额外库
    // 暂时只记录文件名和大小，不深度解析
    const stat = await fs.stat(filePath);
    return `[PPT文件, 大小: ${(stat.size / 1024).toFixed(1)}KB, 暂不支持内容提取]`;
}
async function parseFile(filePath, ext) {
    if (TEXT_EXTENSIONS.has(ext))
        return parseText(filePath);
    switch (ext) {
        case 'pdf': return parsePdf(filePath);
        case 'docx': return parseDocx(filePath);
        case 'xls':
        case 'xlsx': return parseXlsx(filePath);
        case 'ppt':
        case 'pptx': return parsePpt(filePath);
        default: return null;
    }
}
async function downloadWithFallback(url, fileId, destPath, messageId = '') {
    if (url) {
        try {
            await downloadFile(url, destPath);
            return destPath;
        }
        catch { /* non-critical: direct URL download failure falls back to OneBot get_file */
        }
    }
    const candidates = [];
    for (const value of [fileId, messageId]) {
        const id = String(value || '').trim();
        if (id && !candidates.includes(id))
            candidates.push(id);
    }
    for (const candidate of candidates) {
        try {
            const { callGetFile } = require('../../core/api');
            const data = await callGetFile(candidate);
            if (data && data.file) {
                try {
                    await fs.access(data.file);
                    return data.file;
                }
                catch { /* non-critical: inaccessible OneBot file path falls back to URL */
                }
            }
            if (data && data.url) {
                await downloadFile(data.url, destPath);
                return destPath;
            }
        }
        catch { /* non-critical: try next get_file candidate before reporting download failure */
        }
    }
    return null;
}
async function runAnalysis({ channelKey, messageId }) {
    try {
        const entry = await getFileEntry(channelKey, messageId);
        if (!entry || entry.analyzed || entry.skipped)
            return null;
        const ext = entry.ext || getExtension(entry.fileName);
        const safeName = sanitizeFileName(entry.fileName);
        const localDir = path.join(FILE_CACHE_DIR, safeChannelKey(String(channelKey || '')));
        const localPath = path.join(localDir, `${String(messageId).replace(/[^a-zA-Z0-9_-]/g, '_')}.${ext}`);
        let filePath = entry.localPath || null;
        if (filePath) {
            try {
                await fs.access(filePath);
            }
            catch {
                filePath = null;
            }
        }
        if (!filePath) {
            filePath = await downloadWithFallback(entry.url || '', entry.fileId || '', localPath, messageId);
            if (filePath)
                await setLocalPath(channelKey, messageId, filePath);
        }
        if (!filePath) {
            await markFileAnalyzed(channelKey, messageId, `[文件: ${safeName}, 下载失败或已过期]`);
            return null;
        }
        const content = await parseFile(filePath, ext);
        if (!content) {
            await markFileAnalyzed(channelKey, messageId, `[文件: ${safeName}, 无法提取内容]`);
            return null;
        }
        const summary = wrapFileContent(safeName, content, MAX_TEXT_CHARS);
        await markFileAnalyzed(channelKey, messageId, summary);
        return summary;
    }
    catch (e) {
        console.warn('[file-analyzer] analysis failed:', getFileAnalyzerErrorMessage(e));
        try {
            const entry = await getFileEntry(channelKey, messageId);
            if (entry && !entry.analyzed) {
                await markFileAnalyzed(channelKey, messageId, `[文件解析失败: ${getFileAnalyzerErrorMessage(e) || 'unknown'}]`);
            }
        }
        catch { /* non-critical: analysis failure marker is best-effort after primary failure */
        }
        return null;
    }
}
async function analyzeFileNow(channelKey, messageId) {
    if (!channelKey || !messageId)
        return null;
    const entry = await getFileEntry(channelKey, messageId);
    if (!entry)
        return null;
    if (entry.analyzed && entry.analysis)
        return entry.analysis;
    const key = taskKey(channelKey, messageId);
    const existingPromise = inFlight.get(key);
    if (existingPromise)
        return existingPromise;
    const promise = runAnalysis({ channelKey, messageId });
    inFlight.set(key, promise);
    try {
        return await promise;
    }
    finally {
        if (inFlight.get(key) === promise)
            inFlight.delete(key);
    }
}
module.exports = {
    enqueueFileAnalysis,
    analyzeFileNow,
    downloadFile,
};
