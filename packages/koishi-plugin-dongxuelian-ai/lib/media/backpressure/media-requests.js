"use strict";
/**
 * MODULE: S6 媒体分析请求辅助。
 * 职责: 将显式图片/文件分析请求写入 S6 队列并记录 S1 准入事件。
 * 边界: 不下载、不解析、不调用视觉或文件分析模型。
 */
const { admitTask } = require('../../resource-scheduler/admission');
const { enqueueMediaTask } = require('./media-queue');
// 将文件分析请求写入 S6 队列，并返回 S1 准入状态。
function queueFileAnalysisRequest(input) {
    const channelKey = String(input.channelKey || '');
    const messageId = String(input.messageId || '');
    const userId = String(input.userId || '');
    const source = String(input.source || 'media-request');
    const queued = enqueueMediaTask({
        kind: 'media_file_analysis',
        channelKey,
        messageId,
        url: String(input.url || ''),
        fileId: input.fileId || null,
        payload: {
            entry: source,
            fileName: String(input.fileName || ''),
            fileSize: Number(input.fileSize) || 0,
            ext: String(input.ext || ''),
            userId,
        },
    });
    const admission = admitTask({
        kind: 'media_file_analysis',
        source,
        channelKey,
        userId,
        exclusive: false,
    });
    return { admission, queued };
}
// 生成低成本文件排队提示，不调用 AI。
function formatFileQueuedReply(admission) {
    const reason = admission?.decision === 'run_now' ? 'media-worker 空闲时会处理' : String(admission?.reason || admission?.decision || '已排队');
    return `这个文件已加入媒体分析队列，当前资源状态为 ${admission?.resourceState || 'unknown'}，原因：${reason}。稍后再读取即可。`;
}
module.exports = {
    queueFileAnalysisRequest,
    formatFileQueuedReply,
};
