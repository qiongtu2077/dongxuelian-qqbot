"use strict";
/**
 * MODULE: S2 任务路径。
 * 职责: 统一生成 resource-workers 的任务、结果、worker 和事件路径。
 * 边界: 不读写文件，不决定任务状态。
 */
const path = require('path');
const { DATA_DIR } = require('../core/constants');
const { sanitizeId } = require('../resource-common/files');
const WORKERS_ROOT = path.join(DATA_DIR, 'resource-workers');
const TASKS_ROOT = path.join(WORKERS_ROOT, 'tasks');
const RESULTS_ROOT = path.join(WORKERS_ROOT, 'results');
const WORKER_STATE_DIR = path.join(WORKERS_ROOT, 'workers');
const SUPERVISOR_DIR = path.join(WORKERS_ROOT, 'supervisor');
// 返回任务状态目录。
function getTaskStatusDir(status) {
    return path.join(TASKS_ROOT, sanitizeId(status));
}
// 返回 pending 任务类型目录。
function getPendingKindDir(kind) {
    return path.join(getTaskStatusDir('pending'), sanitizeId(kind));
}
// 返回指定任务文件路径。
function getTaskFile(status, kind, taskId) {
    if (status === 'pending')
        return path.join(getPendingKindDir(kind), `${sanitizeId(taskId)}.json`);
    return path.join(getTaskStatusDir(status), `${sanitizeId(taskId)}.json`);
}
// 返回任务结果目录。
function getTaskResultDir(taskId) {
    return path.join(RESULTS_ROOT, sanitizeId(taskId));
}
// 返回 worker 心跳状态文件。
function getWorkerStateFile(workerName) {
    return path.join(WORKER_STATE_DIR, `${sanitizeId(workerName)}.json`);
}
// 返回当天 S2 事件文件。
function getWorkerEventFile(date = new Date()) {
    const stamp = date.toISOString().slice(0, 10);
    return path.join(WORKERS_ROOT, `events-${stamp}.jsonl`);
}
module.exports = {
    WORKERS_ROOT,
    TASKS_ROOT,
    RESULTS_ROOT,
    WORKER_STATE_DIR,
    SUPERVISOR_DIR,
    getTaskStatusDir,
    getPendingKindDir,
    getTaskFile,
    getTaskResultDir,
    getWorkerStateFile,
    getWorkerEventFile,
};
