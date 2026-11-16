"use strict";
/**
 * MODULE: 人格管理。
 * 职责: 加载/保存/查询群组和个人人格配置。
 * 边界: 只操作人格配置文件和缓存，不调 AI API，不改 conversation。
 */
const { PERSONA_GROUPS_FILE, PERSONA_USERS_FILE, SKILLS_PERSONAS_DIR, SKILLS_CORE_DIR, SKILLS_MODES_DIR } = require('../core/constants');
const { readJsonFileSync, writeJsonFileSync } = require('../core/utils');
const { isDebugLogEnabled } = require('../core/logging-config');
const { parseFrontmatterDocument } = require('../core/frontmatter');
const path = require('path');
const { ensureRuntimeSkillSeeds } = require('./skills/skill-seeds');
const { isGroupAbusiveEnabled } = require('../core/participation-policy');
let personaGroupsCache = {};
let personaUsersCache = {};
const MAX_PERSONA_CONFIG_BYTES = parsePersonaPositiveInt(process.env.DONGXUELIAN_PERSONA_CONFIG_MAX_BYTES, 256 * 1024, 4 * 1024, 1024 * 1024);
const MAX_PERSONA_SKILL_BYTES = parsePersonaPositiveInt(process.env.DONGXUELIAN_PERSONA_SKILL_MAX_BYTES, 256 * 1024, 8 * 1024, 2 * 1024 * 1024);
// --- 文件大小限制与配置绑定 ---
// 解析有上下界的人格文件大小配置。
function parsePersonaPositiveInt(value, fallback, min, max) {
    const parsed = parseInt(String(value), 10);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.max(min, Math.min(max, parsed));
}
// 只读取大小合规的可选技能文件。
function readTextIfSmall(file, maxBytes) {
    try {
        const fs = require('fs');
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > maxBytes)
            return '';
        return fs.readFileSync(file, 'utf8').trim();
    }
    catch { /* non-critical: optional persona/skill file may be absent or unreadable */
        return '';
    }
}
// 从磁盘加载群人格绑定。
function loadPersonaGroups() {
    personaGroupsCache = readJsonFileSync(PERSONA_GROUPS_FILE, {}, { maxBytes: MAX_PERSONA_CONFIG_BYTES });
}
// 查询群的原始人格绑定，不应用临时覆盖。
function getGroupPersona(channelKey) { const e = personaGroupsCache[String(channelKey)]; return e && e.persona ? e : null; }
// 保存指定群的人格绑定。
function setGroupPersona(channelKey, personaName) {
    const key = String(channelKey);
    if (!personaGroupsCache[key])
        personaGroupsCache[key] = {};
    if (personaName !== undefined)
        personaGroupsCache[key].persona = personaName;
    writeJsonFileSync(PERSONA_GROUPS_FILE, personaGroupsCache);
}
// 删除指定群的人格绑定。
function resetGroupPersona(channelKey) { delete personaGroupsCache[String(channelKey)]; writeJsonFileSync(PERSONA_GROUPS_FILE, personaGroupsCache); }
// 从磁盘加载个人人格绑定。
function loadPersonaUsers() {
    personaUsersCache = readJsonFileSync(PERSONA_USERS_FILE, {}, { maxBytes: MAX_PERSONA_CONFIG_BYTES });
}
// 查询用户的原始人格绑定。
function getUserPersona(userId) { return personaUsersCache[String(userId)] || null; }
// 保存指定用户的人格绑定。
function setUserPersona(userId, personaName) { personaUsersCache[String(userId)] = personaName; writeJsonFileSync(PERSONA_USERS_FILE, personaUsersCache); }
// 删除指定用户的人格绑定。
function resetUserPersona(userId) { delete personaUsersCache[String(userId)]; writeJsonFileSync(PERSONA_USERS_FILE, personaUsersCache); }
// --- 运行人格优先级 ---
// 群强制嘴臭优先于个人、群和默认人格；只覆盖解析结果，不修改原有绑定。
function resolvePersona(channelKey, userId) {
    if (isGroupAbusiveEnabled(channelKey))
        return { source: 'group-abusive', name: '嘴臭莲莲' };
    const userPersona = getUserPersona(userId);
    if (userPersona)
        return { source: 'user', name: userPersona };
    const groupEntry = getGroupPersona(channelKey);
    if (groupEntry)
        return { source: 'group', name: groupEntry.persona };
    return { source: 'default', name: null };
}
// --- 技能元数据与正文加载 ---
// 解析人格 frontmatter，保留布尔型元数据。
function parsePersonaFrontmatter(content) {
    return parseFrontmatterDocument(content, {
        normalizeValue(value) {
            const text = String(value ?? '').trim();
            return text === 'true' ? true : text === 'false' ? false : text;
        },
    }).meta;
}
// 列出可用人格；用户列表只展示可切换的自定义人格。
function getAvailablePersonals({ userFacing = false } = {}) {
    ensureRuntimeSkillSeeds();
    const personas = [];
    // 收集单个技能目录中具有名称的文档。
    function scanDir(dir, type) {
        try {
            const entries = require('fs').readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isFile() || !/^SKILL(\.[^.]+)?\.md$/i.test(entry.name))
                    continue;
                const content = readTextIfSmall(path.join(dir, entry.name), MAX_PERSONA_SKILL_BYTES);
                if (!content)
                    continue;
                const meta = parsePersonaFrontmatter(content);
                if (meta.name)
                    personas.push({ name: meta.name, description: meta.description || '', file: entry.name, type, dir });
            }
        }
        catch { /* non-critical: optional persona directory may be absent or unreadable */
        }
    }
    scanDir(SKILLS_PERSONAS_DIR, 'persona');
    if (!userFacing) {
        scanDir(SKILLS_CORE_DIR, 'core');
        scanDir(SKILLS_MODES_DIR, 'mode');
    }
    return personas;
}
// 按名称读取人格；强制嘴臭固定使用独立模式文件，防止同名自定义人格抢占。
function loadPersonalSkill(personaName) {
    ensureRuntimeSkillSeeds();
    if (personaName === '嘴臭莲莲') {
        const content = readTextIfSmall(path.join(SKILLS_MODES_DIR, 'SKILL.persona-forced-abusive.md'), MAX_PERSONA_SKILL_BYTES);
        if (!content)
            throw new Error('强制嘴臭人格文件缺失或无法读取');
        return content;
    }
    const dirs = [SKILLS_PERSONAS_DIR, SKILLS_CORE_DIR, SKILLS_MODES_DIR];
    for (const dir of dirs) {
        try {
            const entries = require('fs').readdirSync(dir);
            for (const entry of entries) {
                if (!/^SKILL(\.[^.]+)?\.md$/i.test(entry))
                    continue;
                const content = readTextIfSmall(path.join(dir, entry), MAX_PERSONA_SKILL_BYTES);
                const meta = parsePersonaFrontmatter(content);
                if (meta.name === personaName) {
                    if (isDebugLogEnabled('persona'))
                        console.warn(`[dongxuelian-ai] persona skill loaded: ${entry} name=${meta.name}`);
                    return content;
                }
            }
        }
        catch { /* non-critical: skip unreadable persona directory and continue fallback search */
        }
    }
    if (isDebugLogEnabled('persona'))
        console.warn(`[dongxuelian-ai] persona skill not found: ${personaName}`);
    return null;
}
module.exports = {
    personaGroupsCache, personaUsersCache,
    atomicWriteJson: writeJsonFileSync,
    loadPersonaGroups, getGroupPersona, setGroupPersona, resetGroupPersona,
    loadPersonaUsers, getUserPersona, setUserPersona, resetUserPersona,
    resolvePersona,
    parsePersonaFrontmatter,
    getAvailablePersonals, loadPersonalSkill,
};
