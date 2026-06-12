"use strict";
/* ==========================================================================
 * MODULE: file-quick-read
 * 职责: 处理"读文件/看文件/分析文件"等显式快捷读取意图，返回可发送摘要文本。
 * 边界: 不发送消息、不注册 middleware、不调用 chat/Agent；只读取文件元数据并写入 S6 队列。
 * 状态: 无模块级状态。
 * ========================================================================== */
const { getRecentFiles } = require('../media/file/file-store');
const { summarizeFileContentForChat } = require('../media/file/file-safety');
const { queueFileAnalysisRequest, formatFileQueuedReply } = require('../media/backpressure/media-requests');
const FILE_QUICK_READ_RE = /^(读文件|看文件|分析文件|打开文件|文件内容)$/;
function isFileQuickReadIntent(text = '') {
    return FILE_QUICK_READ_RE.test(String(text || '').trim());
}
async function resolveFileQuickReadReply(channelKey, preferredMessageId = '') {
    const recentFiles = await getRecentFiles(channelKey, 10);
    const explicitTarget = String(preferredMessageId || '').trim();
    const preferred = explicitTarget
        ? recentFiles.find(file => String(file.messageId || '').trim() === explicitTarget && !file.skipped)
        : null;
    const target = preferred
        || recentFiles.find(file => !file.skipped && !file.analyzed)
        || recentFiles.find(file => !file.skipped && file.analyzed);
    if (!target)
        return '没有找到最近可分析的文件。';
    const fileName = target.fileName || '';
    if (target.analyzed && target.analysis) {
        return summarizeFileContentForChat(target.analysis, fileName);
    }
    const messageId = String(target.messageId || '').trim();
    const url = target.url || '';
    const fileId = target.fileId || null;
    if (!messageId)
        return '文件记录不完整，请重新发一次文件。';
    const { admission } = queueFileAnalysisRequest({
        channelKey,
        messageId,
        url,
        fileId,
        fileName,
        fileSize: target.fileSize || 0,
        ext: target.ext || '',
        userId: target.userId || '',
        source: 'file-quick-read',
    });
    return formatFileQueuedReply(admission);
}
module.exports = {
    isFileQuickReadIntent,
    resolveFileQuickReadReply,
};
