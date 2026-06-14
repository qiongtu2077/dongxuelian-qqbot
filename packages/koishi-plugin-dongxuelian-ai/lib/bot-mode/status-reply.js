"use strict";
/**
 * MODULE: S5 低成本状态回复。
 * 职责: 生成固定资源状态文本，避免状态命令调用 AI 或工具。
 * 边界: 不修改任何资源状态，不执行管理操作。
 */
const { readResourceSnapshot } = require('../resource-scheduler/resource-snapshot');
const { getResourceGateStatus } = require('../resource-gate/gate');
const { getTaskQueueSummary } = require('../resource-workers/task-store');
const { getMediaBackpressureStatus } = require('../media/backpressure/media-queue');
// 格式化内存展示。
function formatMemory(available, total) {
    if (typeof available !== 'number')
        return 'unknown';
    return typeof total === 'number' ? `${available}/${total}MB` : `${available}MB`;
}
// 生成固定资源状态文本，不调用模型。
function buildResourceStatusReply() {
    const snapshot = readResourceSnapshot();
    const gate = getResourceGateStatus();
    const queue = getTaskQueueSummary();
    const media = getMediaBackpressureStatus();
    const running = gate.meta
        ? `${gate.meta.kind}/${gate.meta.step || 'running'} (${gate.meta.taskId})`
        : '无';
    return [
        `模式：${snapshot.botMode}`,
        `服务器模式：${snapshot.serverMode || 'large'}`,
        `模式来源：${snapshot.serverModeSource || 'default'}`,
        `资源档位：${snapshot.resourceState}`,
        `可用内存：${formatMemory(snapshot.memAvailableMb, snapshot.memTotalMb)}`,
        `tool_active：${snapshot.toolActive ? '是' : '否'}`,
        `render_active：${snapshot.renderActive ? '是' : '否'}`,
        `background_allowed：${snapshot.backgroundAllowed ? '是' : '否'}`,
        `当前运行：${running}`,
        `任务队列：pending=${queue.pending || 0}, running=${queue.running || 0}, failed=${queue.failed || 0}`,
        `媒体背压：图片=${media.imagePending || 0}, 文件=${media.filePending || 0}, 语音=${media.voicePending || 0}, dropped=${media.droppedCount || 0}`,
    ].join('\n');
}
module.exports = {
    buildResourceStatusReply,
};
