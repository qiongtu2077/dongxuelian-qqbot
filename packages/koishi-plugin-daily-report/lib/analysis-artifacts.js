"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTaskArtifactStore = createTaskArtifactStore;
/**
 * MODULE: 日报任务内可信产物与受控失败材料。
 * 职责: 整单元校验成功后原子保存，失败材料独立保存并有界保留。
 * 边界: 不请求模型、不投递、不复活任务；首版产物不能跨任务复用。
 */
const crypto_1 = require("crypto");
const report_storage_1 = require("./report-storage");
const { loadManagementModule } = require('koishi-plugin-dongxuelian-ai/lib/public/management-runtime');
const { redactSensitiveText } = loadManagementModule('core.redactor');
// 身份只由程序计算，原任务标识不会形成任意文件路径。
function identity(value) {
    return (0, crypto_1.createHash)('sha256').update(JSON.stringify(value)).digest('hex');
}
// 失败材料允许有明确截断标记；凭据脱敏不改变已经验证的成功产物。
function controlledFailureAttempt(attempt) {
    const limit = 48 * 1024;
    return { ...attempt, system: redactSensitiveText(attempt.system).slice(0, limit), input: redactSensitiveText(attempt.input).slice(0, limit),
        response: redactSensitiveText(attempt.response).slice(0, limit), error: redactSensitiveText(attempt.error),
        diagnosticTextTruncated: [attempt.system, attempt.input, attempt.response].some(text => text.length > limit) };
}
// 创建一个固定任务的产物写入器；校验前及保存后均检查原截止与取消状态。
function createTaskArtifactStore(options) {
    const now = options.now || Date.now;
    const storage = new report_storage_1.PagedReportStore(options);
    // 共享写入次序：先检查身份和容量，原子保存成功后才让调用方推进完成账本。
    const save = (unit, attempts, result, success) => {
        if (success)
            options.assertActive();
        const requestIdentity = identity({ unit, requests: attempts.map(attempt => ({ system: attempt.system, input: attempt.input, maxTokens: attempt.maxTokens })), contractVersion: 1 });
        const value = { version: 1, scope: 'task', taskId: options.taskId, channelKey: options.channelKey, deadlineMs: options.deadlineMs,
            createdAtMs: now(), requestIdentity, success, actualModelSources: attempts.map(attempt => attempt.execution || null), crossTaskReusable: false,
            unit: { id: unit.id, stage: unit.stage, sourceIds: unit.sourceIds, timestamps: unit.timestamps },
            attempts: success ? attempts : attempts.map(controlledFailureAttempt), ...(success ? { result } : {}) };
        storage.writeTaskArtifact(requestIdentity, success, value);
    };
    return {
        onUnitCompleted: (unit, attempts, result) => save(unit, attempts, result, true),
        onUnitFailed: (unit, attempts) => save(unit, attempts, null, false),
    };
}
