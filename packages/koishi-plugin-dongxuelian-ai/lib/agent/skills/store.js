"use strict";
/**
 * MODULE: Skill 文件存储。
 * 职责: 路径安全检查、原子写入、目录操作。
 * 边界: 不执行扫描、不管理 manifest。
 * 状态: 无。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { DATA_DIR } = require('../../core/constants');
const { writeJsonFile, readJsonFile } = require('../../core/utils');
const SKILL_POOL_DIR = path.join(DATA_DIR, 'skill-pool');
const WORKSPACE_DIR = path.join(DATA_DIR, 'ai-skills', 'workspace');
function isPathSafe(targetPath, baseDir) {
    const resolved = path.resolve(targetPath);
    const base = path.resolve(baseDir);
    return resolved.startsWith(base + path.sep) || resolved === base;
}
function validateSkillName(name) {
    if (!name || typeof name !== 'string')
        return false;
    if (name.length > 100)
        return false;
    if (/[\/\\:*?"<>|]/.test(name))
        return false;
    if (name.startsWith('.') || name.includes('..'))
        return false;
    return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}
async function ensureDir(dir) {
    await fsp.mkdir(dir, { recursive: true });
}
async function atomicWriteJson(filePath, data) {
    const dir = path.dirname(filePath);
    await ensureDir(dir);
    await writeJsonFile(filePath, data);
}
async function readJsonSafe(filePath, fallback = null) {
    return readJsonFile(filePath, fallback, { maxBytes: 512 * 1024 });
}
async function copyDir(src, dest) {
    await ensureDir(dest);
    const entries = await fsp.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            await copyDir(srcPath, destPath);
        }
        else if (entry.isFile()) {
            await fsp.copyFile(srcPath, destPath);
        }
    }
}
async function removeDir(dir) {
    try {
        await fsp.rm(dir, { recursive: true, force: true });
    }
    catch {
        /* non-critical: directory removal is best-effort for cleanup paths */
    }
}
module.exports = {
    SKILL_POOL_DIR,
    WORKSPACE_DIR,
    isPathSafe,
    validateSkillName,
    ensureDir,
    atomicWriteJson,
    readJsonSafe,
    copyDir,
    removeDir,
};
