"use strict";
/**
 * MODULE: 文件追问取证桥接。
 * 职责: 判断 chat 工具流是否已有文件证据；缺证据时补一次 analyze_file，并格式化终止性失败证据。
 * 边界: 不读取文件历史、不选择 active file、不发送消息、不保存 conversation。
 */
const analyzeFileTool = require('../agent/tools/analyze-file');
function toolCallsIncludeAnalyzeFile(toolCalls = []) {
    return Array.isArray(toolCalls) && toolCalls.some(tc => tc?.function?.name === 'analyze_file');
}
function isTerminalFileEvidence(text = '') {
    const evidence = String(text || '').trim();
    if (!evidence)
        return false;
    if (/---文件内容开始---|\[用户上传文件:/.test(evidence))
        return false;
    return /媒体分析队列|稍后再读取|找到\d+个文件|下载失败|已过期|无法提取内容|文件解析失败|找不到|没有收到|没有可用|文件被跳过|无法确定当前会话/.test(evidence);
}
function isFileEvidence(text = '') {
    const content = String(text || '');
    return /---文件内容开始---|\[用户上传文件:|\[文件解析失败:/.test(content) || isTerminalFileEvidence(content);
}
function getAnalyzeFileToolCallIds(toolCalls = []) {
    if (!Array.isArray(toolCalls) || !toolCalls.length)
        return null;
    const ids = new Set();
    for (const call of toolCalls) {
        if (call?.function?.name === 'analyze_file' && call.id)
            ids.add(String(call.id));
    }
    return ids;
}
function isAnalyzeFileResult(item, analyzeFileCallIds) {
    if (!analyzeFileCallIds)
        return true;
    const resultCallId = String(item?.tool_call_id || '').trim();
    return !!resultCallId && analyzeFileCallIds.has(resultCallId);
}
function formatTerminalFileEvidence(evidence = '') {
    const text = String(evidence || '').trim();
    if (!text)
        return '';
    const matchedCount = text.match(/^找到(\d+)个文件[:：]/);
    if (matchedCount) {
        const names = Array.from(text.matchAll(/-\s*([^\n\r[\(]+?)(?:\s*\[|\s*\(|\r?\n|$)/g))
            .map(match => String(match[1] || '').trim())
            .filter(Boolean)
            .slice(0, 5);
        const suffix = names.length ? `：${names.join('、')}` : '';
        return `我找到 ${matchedCount[1]} 个可能相关的文件${suffix}。你再说一下要看哪一个文件名，我就按那个继续。`;
    }
    return text
        .replace(/\s*messageId:\s*\S+/g, '')
        .replace(/请根据用户意图选择正确的文件，传入 messageId 再次调用。?/g, '请再说一下要看哪一个文件。')
        .slice(0, 1000);
}
function toolResultsIncludeFileEvidence(results = [], toolCalls = []) {
    const analyzeFileCallIds = getAnalyzeFileToolCallIds(toolCalls);
    return Array.isArray(results) && results.some(item => {
        if (!isAnalyzeFileResult(item, analyzeFileCallIds))
            return false;
        const content = String(item?.content || '');
        return isFileEvidence(content);
    });
}
function selectFileEvidenceResult(results = [], toolCalls = []) {
    if (!Array.isArray(results))
        return '';
    const analyzeFileCallIds = getAnalyzeFileToolCallIds(toolCalls);
    const item = results.find(result => {
        if (!isAnalyzeFileResult(result, analyzeFileCallIds))
            return false;
        const content = String(result?.content || '');
        return isFileEvidence(content);
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
    if (isTerminalFileEvidence(evidence)) {
        return formatTerminalFileEvidence(evidence);
    }
    return '';
}
module.exports = {
    toolCallsIncludeAnalyzeFile,
    toolResultsIncludeFileEvidence,
    selectFileEvidenceResult,
    resolveUnguardedFileFollowup,
    buildFileEvidenceReply,
    isTerminalFileEvidence,
    formatTerminalFileEvidence,
};
