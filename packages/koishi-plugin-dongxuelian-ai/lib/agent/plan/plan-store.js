"use strict";
/**
 * MODULE: Agent 计划持久化。
 * 职责: 在 data/agent-plans 中读写计划文件与 active 索引。
 * 边界: 不执行计划、不调用模型、不发送消息。
 * 状态: 无长期内存状态，所有计划落盘。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { DATA_DIR } = require('../../core/constants');
const { readJsonFile, writeJsonFile } = require('../../core/utils');
const PLAN_DIR = path.join(DATA_DIR, 'agent-plans');
const ACTIVE_FILE = path.join(PLAN_DIR, 'active.json');
const MAX_PLAN_FILE_BYTES = parsePlanStorePositiveInt(process.env.DONGXUELIAN_AGENT_PLAN_MAX_BYTES, 512 * 1024, 16 * 1024, 2 * 1024 * 1024);
const MAX_PLAN_FILES = parsePlanStorePositiveInt(process.env.DONGXUELIAN_AGENT_PLAN_MAX_FILES, 300, 20, 2000);
function parsePlanStorePositiveInt(value, fallback, min, max) {
    const parsed = parseInt(String(value), 10);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.max(min, Math.min(max, parsed));
}
function safePlanId(id = '') {
    return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}
function buildPlanId(now = Date.now()) {
    const date = new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
    return `plan_${date}_${now.toString(36)}`;
}
function getPlanFile(id) {
    const safeId = safePlanId(id);
    if (!safeId)
        throw new Error('计划 ID 无效');
    return path.join(PLAN_DIR, safeId + '.json');
}
async function ensurePlanDir() {
    await fsp.mkdir(PLAN_DIR, { recursive: true });
}
function isPlanTaskState(value) {
    return ['todo', 'in_progress', 'done', 'abandoned', 'failed'].includes(String(value));
}
function isPlanState(value) {
    return ['todo', 'executing', 'done', 'abandoned', 'failed'].includes(String(value));
}
function toRawPlanTask(task) {
    return task && typeof task === 'object' ? task : { desc: task };
}
function toRawPlan(plan) {
    return plan && typeof plan === 'object' ? plan : {};
}
function normalizeTask(task, index) {
    const raw = toRawPlanTask(task);
    const id = safePlanId(raw.id || `t${index + 1}`);
    const state = isPlanTaskState(raw.state) ? raw.state : 'todo';
    return {
        id,
        desc: String(raw.desc || raw.description || '').trim().slice(0, 500) || `任务 ${index + 1}`,
        state,
        outcome: raw.outcome === undefined || raw.outcome === null ? null : String(raw.outcome).slice(0, 2000),
        toolCallCount: Math.max(0, parseInt(String(raw.toolCallCount), 10) || 0),
        updatedAt: Number(raw.updatedAt || Date.now()),
    };
}
function normalizePlan(plan = {}) {
    const raw = toRawPlan(plan);
    const now = Date.now();
    const id = safePlanId(raw.id || buildPlanId(now));
    const state = isPlanState(raw.state) ? raw.state : 'executing';
    const rawTasks = Array.isArray(raw.tasks) ? raw.tasks : [];
    return {
        id,
        title: String(raw.title || 'Agent 计划').trim().slice(0, 200) || 'Agent 计划',
        state,
        channel: String(raw.channel || 'unknown').slice(0, 40),
        channelKey: String(raw.channelKey || 'unknown').slice(0, 120),
        userId: String(raw.userId || 'unknown').slice(0, 120),
        userName: String(raw.userName || '').slice(0, 120),
        tasks: rawTasks.map(normalizeTask).slice(0, 50),
        summary: raw.summary === undefined || raw.summary === null ? '' : String(raw.summary).slice(0, 4000),
        createdAt: Number(raw.createdAt || now),
        updatedAt: Number(raw.updatedAt || now),
    };
}
async function readPlanJson(file, fallback) {
    return readJsonFile(file, fallback, { maxBytes: MAX_PLAN_FILE_BYTES });
}
async function writePlanJson(file, data) {
    await ensurePlanDir();
    await writeJsonFile(file, data);
}
async function savePlan(plan) {
    const raw = toRawPlan(plan);
    const normalized = normalizePlan({ ...raw, updatedAt: Date.now() });
    await writePlanJson(getPlanFile(normalized.id), normalized);
    await updateActiveIndex(normalized);
    return normalized;
}
async function loadPlan(id) {
    const safeId = safePlanId(id);
    if (!safeId)
        return null;
    const plan = await readPlanJson(getPlanFile(safeId), null);
    return plan ? normalizePlan(plan) : null;
}
async function listPlans(limit = 50) {
    await ensurePlanDir();
    let files = [];
    try {
        files = await fsp.readdir(PLAN_DIR);
    }
    catch {
        /* non-critical: no plan directory means no persisted plans */
        return [];
    }
    const plans = [];
    for (const name of files.slice(0, MAX_PLAN_FILES)) {
        if (!/^plan_.*\.json$/.test(name))
            continue;
        const plan = await readPlanJson(path.join(PLAN_DIR, name), null);
        if (plan)
            plans.push(normalizePlan(plan));
    }
    return plans.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, Math.max(1, Math.min(200, parseInt(String(limit), 10) || 50)));
}
async function readActiveIndex() {
    const data = await readPlanJson(ACTIVE_FILE, { plans: [] });
    return { plans: Array.isArray(data.plans) ? data.plans.map(safePlanId).filter(Boolean) : [] };
}
async function updateActiveIndex(plan) {
    const index = await readActiveIndex();
    const set = new Set(index.plans);
    if (['executing', 'todo'].includes(plan.state))
        set.add(plan.id);
    else
        set.delete(plan.id);
    await writePlanJson(ACTIVE_FILE, { plans: Array.from(set).slice(-100), updatedAt: Date.now() });
}
async function listActivePlans() {
    const index = await readActiveIndex();
    const result = [];
    for (const id of index.plans) {
        const plan = await loadPlan(id);
        if (plan && ['executing', 'todo'].includes(plan.state))
            result.push(plan);
    }
    return result.sort((a, b) => b.updatedAt - a.updatedAt);
}
function getPlanStorageInfo() {
    return {
        dir: PLAN_DIR,
        activeFile: ACTIVE_FILE,
        exists: fs.existsSync(PLAN_DIR),
    };
}
module.exports = {
    PLAN_DIR,
    ACTIVE_FILE,
    buildPlanId,
    safePlanId,
    normalizePlan,
    savePlan,
    loadPlan,
    listPlans,
    listActivePlans,
    getPlanStorageInfo,
};
