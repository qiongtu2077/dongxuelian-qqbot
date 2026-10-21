"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GithubPreviewSettings = void 0;
exports.normalizeGithubGroup = normalizeGithubGroup;
/**
 * MODULE: GitHub 查询群配置。
 * 职责: 严格读取和原子串行更新独立群白名单。
 * 边界: 不发送消息、不调用模型；实例拥有群快照、配置代次和删除订阅。
 */
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require('../core/constants');
const { writeJsonFile } = require('../core/utils');
// Keep group identifiers as canonical decimal strings, never numeric identifiers.
function normalizeGithubGroup(value) { return /^[1-9]\d{4,19}$/.test(value) ? value : null; }
class GithubPreviewSettings {
    // Read a strict, bounded configuration; any malformed input keeps every group off.
    constructor(directory = DATA_DIR, save = writeJsonFile, warn = console.warn) {
        this.save = save;
        this.warn = warn;
        this.groups = new Set();
        this.versions = new Map();
        this.generation = 0;
        this.updates = Promise.resolve();
        this.listeners = new Set();
        this.file = path.join(directory, 'github-preview-groups.json');
        try {
            if (fs.statSync(this.file).size > 65536)
                throw new Error('白名单文件超过大小限制');
            const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (!Array.isArray(raw) || raw.length > 2000 || raw.some(item => typeof item !== 'string' || !normalizeGithubGroup(item)))
                throw new Error('白名单必须是合法群号字符串数组');
            this.groups = new Set(raw);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                warn('GitHub 白名单读取失败，保持关闭：' + error.message);
        }
    }
    // Return a snapshot without exposing the mutable configuration set.
    list() { return [...this.groups].sort(); }
    // Membership is independent of all other feature whitelists.
    enabled(group) { return this.groups.has(group); }
    // Each group's generation prevents delete/re-add races from sending old tasks.
    version(group) { return this.versions.get(group) || 0; }
    // Subscribe only to durable group removals, for queued and running cancellation.
    onRemoved(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    // Serialize mutations and publish memory only after a successful atomic write.
    async update(group, enabled) {
        if (!normalizeGithubGroup(group))
            throw new Error('群号格式不正确');
        const operation = this.updates.catch(() => { }).then(async () => {
            if (this.groups.has(group) === enabled)
                return false;
            const next = new Set(this.groups);
            if (enabled)
                next.add(group);
            else
                next.delete(group);
            if (next.size > 2000 || Buffer.byteLength(JSON.stringify([...next])) > 65536)
                throw new Error('白名单已达到容量限制');
            await this.save(this.file, [...next].sort());
            this.groups = next;
            if (enabled)
                this.versions.set(group, ++this.generation);
            else
                this.versions.delete(group);
            if (!enabled)
                for (const listener of this.listeners) {
                    try {
                        listener(group);
                    }
                    catch (error) {
                        this.warn('GitHub 取消任务失败：' + error.message);
                    }
                }
            return true;
        });
        this.updates = operation;
        return operation;
    }
}
exports.GithubPreviewSettings = GithubPreviewSettings;
