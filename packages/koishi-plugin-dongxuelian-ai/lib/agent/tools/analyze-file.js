"use strict";
/**
 * Agent 工具: analyze_file — 读取并分析用户发送的文件。
 * 只在用户明确追问文件内容时由 Agent 调用，不会自动下载。
 */
const { getFileEntry, getRecentFiles } = require('../../media/file/file-store');
const { queueFileAnalysisRequest, formatFileQueuedReply } = require('../../media/backpressure/media-requests');
// 将未缓存的文件分析请求交给 S6/media-worker，不在 Agent 当前进程下载或解析。
function queueAnalyzeFile(channelKey, messageId, entry, userId = '') {
    const { admission } = queueFileAnalysisRequest({
        channelKey,
        messageId,
        url: String(entry?.url || ''),
        fileId: entry?.fileId ? String(entry.fileId) : null,
        fileName: String(entry?.fileName || ''),
        fileSize: Number(entry?.fileSize) || 0,
        ext: String(entry?.ext || ''),
        userId: userId || String(entry?.userId || ''),
        source: 'agent-tool-analyze-file',
    });
    return formatFileQueuedReply(admission);
}
module.exports = {
    definition: {
        name: 'analyze_file',
        description: '读取并分析用户发送的文件内容。只在对话明确围绕某个文件时调用。判断标准：用户提到了文件名、用指代词指向文件、或多人正在讨论文件内容。如果不确定，不要调用，也不要询问用户是否需要分析。分析后自然地在回复中引用内容，不要说"我帮你分析了文件"之类的话。不要因为自己上一条回复提到了文件就继续调用。',
        parameters: {
            type: 'object',
            properties: {
                messageId: { type: 'string', description: '文件消息 ID（从对话上下文中的 fileId:xxx 获取，或从文件列表中选择）' },
                keyword: { type: 'string', description: '用户提到的关键词，用于从文件列表中模糊匹配（如"配置"、"报告"）' },
            },
            required: [],
        },
    },
    async execute(params = {}, context = {}) {
        const channelKey = context.channelKey || '';
        const messageId = String(params.messageId || context.activeFileMessageId || '').trim();
        if (messageId && channelKey) {
            const entry = await getFileEntry(channelKey, messageId);
            if (!entry)
                return '找不到这个文件记录。';
            if (entry.skipped)
                return `这个文件被跳过了：${entry.skipReason || '不支持的类型'}（${entry.fileName}）`;
            if (entry.analyzed && entry.analysis)
                return entry.analysis;
            return queueAnalyzeFile(channelKey, messageId, entry, context.userId || '');
        }
        if (channelKey) {
            const recent = await getRecentFiles(channelKey, 15);
            if (!recent.length)
                return '当前会话没有收到过文件。';
            const keyword = String(params.keyword || '').trim().toLowerCase();
            let matched = recent;
            if (keyword) {
                matched = recent.filter(f => f.fileName.toLowerCase().includes(keyword) || f.ext.includes(keyword));
                if (!matched.length)
                    matched = recent;
            }
            if (matched.length === 1 && !matched[0].skipped) {
                const only = matched[0];
                if (only.analyzed && only.analysis)
                    return only.analysis;
                return queueAnalyzeFile(channelKey, only.messageId, only, context.userId || '');
            }
            const list = matched.map(f => {
                const time = new Date(f.ts).toLocaleString('zh-CN', { hour12: false });
                const status = f.analyzed ? '已分析' : f.skipped ? `已跳过(${f.skipReason})` : '可分析';
                return `- ${f.fileName} [${status}] (${time}) messageId: ${f.messageId}`;
            }).join('\n');
            return `找到${matched.length}个文件：\n${list}\n\n请根据用户意图选择正确的文件，传入 messageId 再次调用。如果不确定，询问用户想看哪个。`;
        }
        return '无法确定当前会话，请在对话中使用。';
    },
    dangerous: false,
    defaultChannels: ['dashboard', 'qq'],
};
