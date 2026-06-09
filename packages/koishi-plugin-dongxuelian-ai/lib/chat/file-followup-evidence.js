"use strict";
/**
 * MODULE: 文件追问取证桥接。
 * 职责: 判断 chat 工具流是否已有文件证据；缺证据时补一次 analyze_file，并把证据整理成自然回复。
 * 边界: 不读取文件历史、不选择 active file、不发送消息、不保存 conversation。
 */
const analyzeFileTool = require('../agent/tools/analyze-file');
const { summarizeFileContentForChat } = require('../media/file/file-safety');
function toolCallsIncludeAnalyzeFile(toolCalls = []) {
    return Array.isArray(toolCalls) && toolCalls.some(tc => tc?.function?.name === 'analyze_file');
}
function toolResultsIncludeFileEvidence(results = []) {
    return Array.isArray(results) && results.some(item => {
        const content = String(item?.content || '');
        return /---文件内容开始---|\[用户上传文件:|\[文件解析失败:|下载失败|无法提取内容|找到\d+个文件/.test(content);
    });
}
function selectFileEvidenceResult(results = []) {
    if (!Array.isArray(results))
        return '';
    const item = results.find(result => {
        const content = String(result?.content || '');
        return /---文件内容开始---|\[用户上传文件:|\[文件解析失败:|下载失败|无法提取内容|找到\d+个文件/.test(content);
    });
    return String(item?.content || '');
}
async function resolveUnguardedFileFollowup(state = {}, context = {}) {
    if (!state.shouldVerify)
        return null;
    if (state.usedAnalyzeFile || state.hasFileEvidence)
        return null;
    const targetFile = state.targetFile;
    const messageId = targetFile && targetFile.messageId ? String(targetFile.messageId) : '';
    const toolContext = messageId
        ? { ...context, activeFileMessageId: messageId, activeFileName: targetFile?.fileName || '' }
        : context;
    return analyzeFileTool.execute(messageId ? { messageId } : {}, toolContext);
}
function buildFileEvidenceReply(fileEvidence = '', targetFile = null) {
    const evidence = String(fileEvidence || '').trim();
    if (!evidence)
        return '';
    if (/下载失败|已过期|无法提取内容|文件解析失败|找不到|没有收到|没有可用/.test(evidence)) {
        return evidence.slice(0, 1000);
    }
    const fileName = targetFile && targetFile.fileName ? targetFile.fileName : '';
    return summarizeFileContentForChat(evidence, fileName);
}
module.exports = {
    toolCallsIncludeAnalyzeFile,
    toolResultsIncludeFileEvidence,
    selectFileEvidenceResult,
    resolveUnguardedFileFollowup,
    buildFileEvidenceReply,
};
