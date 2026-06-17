"use strict";
/**
 * MODULE: 资源子系统文件工具。
 * 职责: 提供原子 JSON 写入、JSONL 事件追加和安全目录扫描。
 * 边界: 不包含任何业务准入、锁或队列决策。
 */
const fs = require('fs');
const path = require('path');
const RECENT_JSONL_TAIL_BYTES = Math.max(64 * 1024, Math.min(4 * 1024 * 1024, Number(process.env.RESOURCE_RECENT_JSONL_TAIL_BYTES || 512 * 1024)));
// 返回当前 ISO 时间字符串，统一资源系统事件时间格式。
function nowIso() {
    return new Date().toISOString();
}
// 将任意标识压成可用于文件名的稳定短字符串。
function sanitizeId(value, fallback = 'unknown') {
    const text = String(value || fallback).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 160);
    return text || fallback;
}
// 确保目录存在；路径父级冲突时交给 fs 抛出明确错误。
function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}
// 原子写 JSON：先写临时文件，再 rename 到目标文件。
function writeJsonAtomic(file, data) {
    ensureDir(path.dirname(file));
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(temp, file);
}
// 尝试读取 JSON；缺失、过大或解析失败时返回 fallback。
function readJsonFile(file, fallback = null, maxBytes = 2 * 1024 * 1024) {
    try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > maxBytes)
            return fallback;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch {
        return fallback;
    }
}
// 追加 JSONL 事件，自动补 createdAt 字段。
function appendJsonlEvent(file, event) {
    ensureDir(path.dirname(file));
    const payload = { createdAt: nowIso(), ...event };
    fs.appendFileSync(file, `${JSON.stringify(payload)}\n`, 'utf8');
}
// 读取目录内 JSON 文件，递归模式用于队列状态汇总。
function listJsonFiles(dir, options = {}) {
    const result = [];
    const maxFiles = Math.max(1, Math.min(20000, Number(options.maxFiles || 20000)));
    const walk = (current) => {
        if (result.length >= maxFiles)
            return;
        let entries = [];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        }
        catch {
            return;
        }
        entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        for (const entry of entries) {
            if (result.length >= maxFiles)
                return;
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (options.recursive)
                    walk(full);
                continue;
            }
            if (entry.isFile() && entry.name.endsWith('.json'))
                result.push(full);
        }
    };
    walk(dir);
    return result;
}
// 安全删除文件或目录；返回值表示删除后目标不存在。
function removePath(target) {
    try {
        fs.rmSync(target, { recursive: true, force: true });
    }
    catch {
        return false;
    }
    return !fs.existsSync(target);
}
// 原子移动文件，目标目录不存在时自动创建。
function renameFileAtomic(src, dst) {
    try {
        ensureDir(path.dirname(dst));
        fs.renameSync(src, dst);
        return true;
    }
    catch (error) {
        const code = String(error?.code || '');
        if (code === 'ENOENT' || code === 'EEXIST' || code === 'EPERM')
            return false;
        throw error;
    }
}
// 只读取 JSONL 文件尾部，避免 Dashboard 状态页同步读完整大日志。
function readJsonlTailLines(file) {
    try {
        const stat = fs.statSync(file);
        if (!stat.isFile())
            return [];
        const size = stat.size;
        const start = Math.max(0, size - RECENT_JSONL_TAIL_BYTES);
        const length = size - start;
        const fd = fs.openSync(file, 'r');
        try {
            const buffer = Buffer.alloc(length);
            fs.readSync(fd, buffer, 0, length, start);
            const lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean);
            return start > 0 ? lines.slice(1) : lines;
        }
        finally {
            fs.closeSync(fd);
        }
    }
    catch {
        return [];
    }
}
// 读取最近 JSONL 事件；用于 Dashboard 展示低成本事件尾部。
function readRecentJsonlEvents(dir, prefix, limit = 80) {
    const max = Math.max(1, Math.min(500, Number(limit || 80)));
    let files = [];
    try {
        files = fs.readdirSync(dir)
            .filter(name => name.startsWith(prefix) && name.endsWith('.jsonl'))
            .sort()
            .slice(-5)
            .map(name => path.join(dir, name));
    }
    catch {
        return [];
    }
    const lines = [];
    for (const file of files) {
        try {
            lines.push(...readJsonlTailLines(file));
        }
        catch {
            /* 跳过读取失败的事件文件，Dashboard 仍显示其他来源。 */
        }
    }
    return lines.slice(-max).map(line => {
        try {
            return JSON.parse(line);
        }
        catch {
            return { event: 'invalid_event_line', raw: line.slice(0, 500) };
        }
    });
}
// 判断进程是否仍存在；跨进程 stale 锁回收会使用这个低成本探测。
function isProcessAlive(pid) {
    const value = Number(pid);
    if (!Number.isFinite(value) || value <= 0)
        return false;
    try {
        process.kill(value, 0);
        return true;
    }
    catch (error) {
        return String(error?.code || '') === 'EPERM';
    }
}
module.exports = {
    nowIso,
    sanitizeId,
    ensureDir,
    writeJsonAtomic,
    readJsonFile,
    appendJsonlEvent,
    listJsonFiles,
    removePath,
    renameFileAtomic,
    readRecentJsonlEvents,
    isProcessAlive,
};
